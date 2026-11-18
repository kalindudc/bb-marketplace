import { assertTavernRunning, stopAllReason } from "../stop-all";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Keeper } from "../keeper/service";
import { taleDeliverySchema } from "../tale";
import { MODEL_ID, PROVIDER_ID, REASONING_LEVEL, NOT_AN_AGENT, renderPrompt } from "./provider";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const notFound = (error: unknown) => /not found/i.test(message(error)) || (error as { status?: number })?.status === 404 || (error as { code?: string })?.code === "not_found";
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
type Delivery = z.infer<typeof taleDeliverySchema>;
type Row = { id: string; delivery: Delivery };
const PATH = "[A-Za-z0-9._~@+=-][A-Za-z0-9._~@+=/-]*";
const STORAGE_TOKEN = new RegExp(`\\$\\{?BB_THREAD_STORAGE\\}?/(${PATH})`, "g");
const clean = (path: string): string | null => {
  const trimmed = path.replace(/[.,;:]+$/, "");
  return trimmed === "" || trimmed.split("/").some((part) => part === ".." || part === "" || part === ".") ? null : trimmed;
};

/**
 * Thread-storage files the body names, as `$BB_THREAD_STORAGE/<path>` or as an absolute path under the sender's
 * storage. A view resolves such a path against its own message's thread, which for a companion is the companion.
 */
export function storageReferences(body: string, storageRoot: string | null): string[] {
  const found = new Set<string>();
  const add = (path: string) => {
    const relative = clean(path);
    if (relative !== null) found.add(relative);
  };
  for (const match of body.matchAll(STORAGE_TOKEN)) add(match[1]!);
  if (storageRoot !== null && storageRoot !== "") {
    for (const match of body.matchAll(new RegExp(`${escapeRegExp(storageRoot.replace(/\/+$/, ""))}/(${PATH})`, "g"))) add(match[1]!);
  }
  return [...found];
}

/** The body with each copied file's reference pointed at its copy in the companion's storage. */
export function rewriteReferences(body: string, storageRoot: string | null, copied: ReadonlySet<string>, folder: string): string {
  // The captured path may carry a sentence's closing punctuation, which stays after the rewritten path.
  const target = (path: string, whole: string) => {
    const relative = clean(path);
    return relative !== null && copied.has(relative) ? `$BB_THREAD_STORAGE/${folder}/${relative}${path.slice(relative.length)}` : whole;
  };
  let text = body.replace(STORAGE_TOKEN, (whole, path: string) => target(path, whole));
  if (storageRoot !== null && storageRoot !== "") {
    text = text.replace(new RegExp(`(?:file://)?${escapeRegExp(storageRoot.replace(/\/+$/, ""))}/(${PATH})`, "g"), (whole, path: string) => target(path, whole));
  }
  return text;
}


export class TaleCompanions {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly owners = new Map<string, Row>();
  constructor(private readonly bb: BbPluginApi, private readonly k: Keeper) {
    for (const row of this.rows()) if (row.delivery.companionThreadId) this.owners.set(row.delivery.companionThreadId, row);
  }
  private rows(questId?: string): Row[] {
    const rows = questId === undefined
      ? this.k.store.db.prepare("SELECT id,data FROM tavern_records WHERE kind='taleDeliveries' AND json_extract(data,'$.companionThreadId') IS NOT NULL").all()
      : this.k.store.db.prepare("SELECT id,data FROM tavern_records WHERE kind='taleDeliveries' AND (id=? OR json_extract(data,'$.questId')=?)").all(questId, questId);
    return (rows as { id: string; data: string }[]).map(row => ({ id: row.id, delivery: taleDeliverySchema.parse(JSON.parse(row.data)) }));
  }
  private save(row: Row) {
    this.k.store.put("taleDeliveries", row.id, row.delivery);
    this.k.changed(row.delivery.threadId, row.delivery.questId ?? row.id);
  }
  private enqueue(id: string, work: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(id) ?? Promise.resolve()).then(work, work).catch(error => this.bb.log.warn(`Tavern renderer ${id}: ${message(error)}`));
    this.chains.set(id, next);
    void next.finally(() => { if (this.chains.get(id) === next) this.chains.delete(id); });
    return next;
  }
  ensure(questId: string): Promise<void> { return this.enqueue(questId, () => this.sync(questId)); }
  private async sync(questId: string) {
    if (stopAllReason(this.k.store)) return;
    const quest = this.k.store.get("quests", questId);
    if (!quest || quest.deletedAt != null || quest.phase !== "done") return;
    const rows = this.rows(questId).sort((a, b) => (b.delivery.tellingId ?? 0) - (a.delivery.tellingId ?? 0));
    const row = rows[0];
    if (!row) return;
    const telling = this.k.store.db.prepare("SELECT id FROM tavern_events WHERE board_quest_id=? AND type IN ('quest.wrapped','quest.retold') ORDER BY id DESC LIMIT 1").get(questId) as { id: number } | undefined;
    const current = row.delivery.tellingId === undefined || row.delivery.tellingId === telling?.id;
    for (const old of rows) if (old !== row || !current) await this.discard(old);
    if (!current) return;
    let replacement = false;
    if (row.delivery.companionThreadId) {
      const id = row.delivery.companionThreadId;
      this.owners.set(id, row);
      try {
        const thread = await this.bb.sdk.threads.get({ threadId: id });
        if (thread.deletedAt != null) { this.failed(id); replacement = true; }
        else {
          if (thread.archivedAt != null) {
            this.archived(id);
            try { await this.bb.sdk.threads.unarchive({ threadId: id }); this.unarchived(id); }
            catch (error) { replacement = true; this.bb.log.warn(`Tavern renderer unarchive ${id}: ${message(error)}`); }
          }
          if (!replacement) {
            if (thread.status === "error") this.failed(id);
            else if (!row.delivery.companionReady && !row.delivery.companionFailed && thread.status === "idle") {
              const result = await this.bb.sdk.threads.output({ threadId: id });
              this.idle(id, result.output);
            }
            return;
          }
        }
      } catch (error) {
        this.bb.log.warn(`Tavern renderer unavailable: ${message(error)}`);
        if (!notFound(error)) return;
        this.failed(id);
        replacement = true;
      }
      if (row.delivery.companionReplacementAttempted) { this.failed(id); return; }
      await this.discard(row);
      row.delivery = { ...row.delivery, companionReplacementAttempted: true };
      this.save(row);
    }
    if (row.delivery.companionReplacementAttempted && !replacement) return;
    const keeper = await this.bb.sdk.threads.get({ threadId: quest.keeperThreadId });
    if (!keeper.environmentId || keeper.deletedAt != null) return;
    const text = row.delivery.text.split(/\r?\n/).filter(line => line.trim() !== `::tavern-tale{quest="${questId}"}`).join("\n");
    const source = await this.location(keeper.id);
    const files: { path: string; content: string; contentEncoding: "base64" | "utf8" }[] = [];
    let total = 0;
    if (source) for (const path of storageReferences(text, source.storageRootPath).slice(0, 10)) {
      try {
        const file = await this.bb.sdk.files.read({ hostId: source.hostId, rootPath: source.storageRootPath, path: `${source.storageRootPath}/${path}` });
        if (file.sizeBytes > 10 * 1024 * 1024 || total + file.sizeBytes > 25 * 1024 * 1024) continue;
        total += file.sizeBytes;
        files.push({ path, content: file.content, contentEncoding: file.contentEncoding });
      } catch (error) { this.bb.log.warn(`Tavern renderer file ${path}: ${message(error)}`); }
    }
    assertTavernRunning(this.k.store);
    const companion = await this.bb.sdk.threads.spawn({
      projectId: keeper.projectId, environment: { type: "reuse", environmentId: keeper.environmentId },
      providerId: PROVIDER_ID, model: MODEL_ID, reasoningLevel: REASONING_LEVEL,
      title: `Tale: ${quest.title}`.slice(0, 120), visibility: "hidden", parentThreadId: keeper.id,
      parentNotifications: "off", lifecycleOwnerThreadId: keeper.id, pluginMetadata: { taleQuestId: questId },
      input: [{ type: "text", text: renderPrompt(questId, text), mentions: [], visibility: "agent-only" }],
      sendAt: this.k.now() + 60000,
    });
    row.delivery = { ...row.delivery, companionThreadId: companion.id, companionReady: false, companionFailed: false, companionArchived: false };
    this.owners.set(companion.id, row);
    this.save(row);
    if (this.k.store.runtime(keeper.id).deletedAt != null || this.k.store.get("quests", questId)?.deletedAt != null) {
      await this.discard(row);
      return;
    }
    try {
      await this.bb.sdk.plugins.callRpc({ pluginId: "push-notifications", method: "threadNotifications.set", input: { threadId: companion.id, level: "muted" }, outputSchema: z.unknown() as unknown as Parameters<BbPluginApi["sdk"]["plugins"]["callRpc"]>[0]["outputSchema"] });
    } catch (error) { this.bb.log.debug(`Tavern renderer notification preference unavailable: ${message(error)}`); }
    const target = files.length ? await this.location(companion.id) : null;
    const copied = new Set<string>();
    if (target) for (const file of files) {
      try {
        const path = `${target.storageRootPath}/tale-files/${file.path}`;
        await this.bb.sdk.files.mkdir({ hostId: target.hostId, path: path.slice(0, path.lastIndexOf("/")), recursive: true });
        await this.bb.sdk.files.write({ hostId: target.hostId, rootPath: target.storageRootPath, path, content: file.content, contentEncoding: file.contentEncoding, createParents: true });
        copied.add(file.path);
      } catch (error) { this.bb.log.warn(`Tavern renderer copy ${file.path}: ${message(error)}`); }
    }
    const rewritten = rewriteReferences(text, source?.storageRootPath ?? null, copied, "tale-files");
    try {
      for (const queued of await this.bb.sdk.threads.queuedMessages.list({ threadId: companion.id })) {
        await this.bb.sdk.threads.queuedMessages.update({ threadId: companion.id, queuedMessageId: queued.id, expectedUpdatedAt: queued.updatedAt,
          input: [{ type: "text", text: renderPrompt(questId, rewritten), mentions: [], visibility: "agent-only" }] });
        await this.bb.sdk.threads.queuedMessages.send({ threadId: companion.id, queuedMessageId: queued.id, mode: "auto" });
      }
    } catch (error) { this.failed(companion.id); this.bb.log.warn(`Tavern renderer release: ${message(error)}`); }
  }
  private async location(threadId: string) {
    try { return await this.bb.sdk.threads.storageLocation({ threadId }); }
    catch (error) { this.bb.log.warn(`Tavern renderer storage ${threadId}: ${message(error)}`); return null; }
  }
  idle(threadId: string, text?: string | null) {
    const row = this.owners.get(threadId);
    if (!row || !text?.trim() || text === NOT_AN_AGENT || row.delivery.companionFailed || row.delivery.companionReady) return;
    row.delivery = { ...row.delivery, companionReady: true };
    this.save(row);
  }
  archived(threadId: string) {
    const row = this.owners.get(threadId);
    if (!row || row.delivery.companionArchived) return;
    row.delivery = { ...row.delivery, companionArchived: true };
    this.save(row);
  }
  unarchived(threadId: string) {
    const row = this.owners.get(threadId);
    if (!row || row.delivery.companionArchived === false && row.delivery.companionFailed === false) return;
    row.delivery = { ...row.delivery, companionArchived: false, companionFailed: false };
    this.save(row);
  }
  failed(threadId: string) {
    const row = this.owners.get(threadId);
    if (!row || row.delivery.companionFailed && !row.delivery.companionReady) return;
    row.delivery = { ...row.delivery, companionReady: false, companionFailed: true };
    this.save(row);
  }
  private async discard(row: Row) {
    const id = row.delivery.companionThreadId;
    if (!id) return;
    try { await this.bb.sdk.threads.delete({ threadId: id, childThreadsConfirmed: false }); }
    catch (error) {
      if (!notFound(error)) throw error;
    }
    this.owners.delete(id);
    const { companionThreadId, companionReady, companionFailed, companionArchived, ...delivery } = row.delivery;
    row.delivery = delivery;
    this.save(row);
  }
  deleteQuest(questId: string): Promise<void> {
    return this.enqueue(questId, async () => { for (const row of this.rows(questId)) await this.discard(row); });
  }
  async deleteKeeper(threadId: string): Promise<void> {
    const quests = new Set(this.rows().filter(row => row.delivery.threadId === threadId).map(row => row.delivery.questId ?? row.id));
    await Promise.all([...quests].map(id => this.deleteQuest(id)));
  }
  async settled(): Promise<void> { while (this.chains.size) await Promise.all([...this.chains.values()]); }
}
