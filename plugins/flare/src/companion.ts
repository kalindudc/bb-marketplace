import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { threadTag } from "./contract";
import { MODEL_ID, PROVIDER_ID, REASONING_LEVEL, renderPrompt } from "./provider";
import type { FlareRow, FlareStore } from "./store";

// Each thread whose Flares tab shows a flare (its own thread and every thread above it) has one companion: a hidden
// child thread on Flare's renderer. A flare reaches it as an agent-only prompt and comes back as an assistant message,
// which bb draws with every installed renderer. The companion reuses the viewer's environment, so nothing is
// provisioned and workspace paths mean the same thing; it tells nobody when its turns end, and Flare deletes it with
// the thread it belongs to.

const PUSH_PLUGIN = "push-notifications";
/** Flares a new companion replays; older ones stay in the tab's cards. */
export const REPLAY_LIMIT = 100;
/** A flare this much older than the newest one drawn means the companion is out of order, so it is rebuilt. */
const REORDER_WINDOW_MS = 2 * 60_000;
/** A new companion's first prompt waits this long at most for Flare to mute it and copy its files, then goes anyway. */
const HOLD_MS = 60_000;
const MAX_READS = 10;
const MAX_COPY_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
/** Where a flare's copied files live in its companion's storage, one folder per flare so no two overwrite. */
export const filesFolder = (flareId: string): string => `flare-files/${flareId}`;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What the companion shows for one flare: its title, then the body unchanged. The divider Flare draws over the message
 * carries its kind, its time and the child thread it came from, as a card's line does.
 */
export function companionMessage(flare: Pick<FlareRow, "title" | "body">): string {
  const lines = [`**${flare.title.replace(/\*/g, "\\*")}**`];
  if (flare.body.trim() !== "") lines.push("", flare.body);
  return lines.join("\n");
}

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
    text = text.replace(new RegExp(`${escapeRegExp(storageRoot.replace(/\/+$/, ""))}/(${PATH})`, "g"), (whole, path: string) => target(path, whole));
  }
  return text;
}

const viewerSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  title: z.string().nullable(),
  titleFallback: z.string().nullable().optional(),
});

/** A flare ready to send: its text pointing at copies, the same text unchanged for when copying fails, and the files. */
type Prepared = { flare: FlareRow; text: string; original: string; files: { path: string; content: string; encoding: "base64" | "utf8" }[] };

const isNotFound = (error: unknown): boolean => {
  const details = error as { status?: unknown; code?: unknown };
  return details?.status === 404 || details?.code === "not_found" || /not found/i.test(message(error));
};

export class Companions {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: FlareStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Brings each viewer's companion up to date: every flare it is missing, in order, one viewer queue at a time. */
  show(viewerIds: readonly string[]): Promise<void> {
    return Promise.all(viewerIds.map((viewerId) => this.enqueue(viewerId, () => this.sync(viewerId)))).then(() => undefined);
  }

  private enqueue(viewerId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(viewerId) ?? Promise.resolve();
    const next = previous.then(work, work).catch((error: unknown) => this.bb.log.warn(`Could not show flares for ${viewerId}: ${message(error)}`));
    this.chains.set(viewerId, next);
    void next.finally(() => {
      if (this.chains.get(viewerId) === next) this.chains.delete(viewerId);
    });
    return next;
  }

  private async sync(viewerId: string): Promise<void> {
    let missing = this.store.unshownFor(viewerId, REPLAY_LIMIT);
    if (missing.length === 0) return;
    let companion = this.store.companionOf(viewerId);
    const lastShown = this.store.lastShownAt(viewerId);
    if (companion !== null && lastShown !== null && missing[0]!.createdAt < lastShown - REORDER_WINDOW_MS) {
      // Flares the companion skipped (sent while the tab showed cards, or while it could not be reached) would land
      // after newer ones; a fresh companion replays them all in order.
      await this.discard(viewerId, companion);
      companion = null;
      missing = this.store.unshownFor(viewerId, REPLAY_LIMIT);
    }
    // A new companion replays the newest REPLAY_LIMIT flares; older ones stay cards, and stop counting as missing, so a
    // long history can never make every sync rebuild again.
    if (companion === null && missing.length > 0) this.store.skipUnshownBefore(viewerId, missing[0]!.createdAt, this.now());
    for (const flare of missing) {
      const prepared = await this.prepare(flare);
      if (companion === null) {
        companion = await this.create(viewerId, prepared);
        if (companion === null) return;
      } else if (!(await this.deliver(viewerId, companion, prepared))) {
        if (!(await this.gone(companion))) return; // A passing failure: the flare is tried again with the next one.
        await this.discard(viewerId, companion);
        // Everything is replayed into the replacement, starting with the next sync.
        companion = null;
        this.enqueue(viewerId, () => this.sync(viewerId));
        return;
      }
      this.store.markShown(flare.id, viewerId, this.now());
      this.bb.rpc.experimental_invalidate([threadTag(viewerId)]);
    }
  }

  /** Reads the files a flare names from its sender's storage, so its text can point at their copies. */
  private async prepare(flare: FlareRow): Promise<Prepared> {
    const body = companionMessage(flare);
    const source = await this.storageRoot(flare.threadId);
    const candidates = storageReferences(body, source?.root ?? null).slice(0, MAX_READS);
    const files: Prepared["files"] = [];
    let bytes = 0;
    if (source !== null) {
      for (const path of candidates) {
        try {
          const file = await this.bb.sdk.files.read({ hostId: source.hostId, rootPath: source.root, path: `${source.root}/${path}` });
          if (file.sizeBytes > MAX_COPY_BYTES || bytes + file.sizeBytes > MAX_TOTAL_BYTES) continue;
          files.push({ path, content: file.content, encoding: file.contentEncoding });
          bytes += file.sizeBytes;
        } catch (error) {
          this.bb.log.debug(`Did not copy ${path} for ${flare.id}: ${message(error)}`);
        }
      }
    }
    const copied = new Set(files.map((file) => file.path));
    const text = rewriteReferences(body, source?.root ?? null, copied, filesFolder(flare.id));
    return { flare, text: renderPrompt(flare.id, text), original: renderPrompt(flare.id, body), files };
  }

  private async deliver(viewerId: string, companion: string, prepared: Prepared): Promise<boolean> {
    // A flare whose files could not be copied still goes, as written, so one bad file never holds up the rest.
    const copied = await this.writeFiles(companion, prepared).then(
      () => true,
      (error: unknown) => {
        this.bb.log.info(`Could not copy files for ${prepared.flare.id} into ${companion}: ${message(error)}`);
        return false;
      },
    );
    try {
      await this.bb.sdk.threads.send({
        threadId: companion,
        mode: "queue-if-active",
        input: [{ type: "text", text: copied ? prepared.text : prepared.original, mentions: [], visibility: "agent-only" }],
      });
      return true;
    } catch (error) {
      this.bb.log.info(`Companion ${companion} of ${viewerId} did not take flare ${prepared.flare.id}: ${message(error)}`);
      return false;
    }
  }

  /** Whether a companion is really gone: deleted, archived or unknown. A failure to tell counts as not gone. */
  private async gone(companion: string): Promise<boolean> {
    try {
      const thread = (await this.bb.sdk.threads.get({ threadId: companion })) as { deletedAt?: number | null; archivedAt?: number | null };
      return thread.deletedAt != null || thread.archivedAt != null;
    } catch (error) {
      return isNotFound(error);
    }
  }

  private async create(viewerId: string, first: Prepared): Promise<string | null> {
    const viewer = viewerSchema.parse(await this.bb.sdk.threads.get({ threadId: viewerId }));
    // A thread with no environment yet has nowhere for the renderer to run; its Flares tab shows plain cards.
    if (viewer.environmentId === null) return null;
    const name = viewer.title?.trim() || viewer.titleFallback?.trim() || "a thread";
    const spawned = await this.bb.sdk.threads.spawn({
      projectId: viewer.projectId,
      environment: { type: "reuse", environmentId: viewer.environmentId },
      providerId: PROVIDER_ID,
      model: MODEL_ID,
      // The renderer has one level; without it bb would carry over the project's remembered one and refuse.
      reasoningLevel: REASONING_LEVEL,
      title: `Flares: ${name}`.slice(0, 120),
      visibility: "hidden",
      parentThreadId: viewer.id,
      parentNotifications: "off",
      lifecycleOwnerThreadId: viewer.id,
      pluginMetadata: { companionOf: viewer.id },
      input: [{ type: "text", text: first.text, mentions: [], visibility: "agent-only" }],
      // Held until it is muted and its files are in place; it goes on its own if Flare never releases it.
      sendAt: this.now() + HOLD_MS,
    });
    const companion = (spawned as { id?: string }).id;
    if (typeof companion !== "string") throw new Error("bb did not return the companion thread's id");
    this.store.setCompanion(viewerId, companion, this.now());
    await this.quiet(companion);
    const copied = await this.writeFiles(companion, first).then(
      () => true,
      (error: unknown) => {
        this.bb.log.info(`Could not copy files into ${companion}: ${message(error)}`);
        return false;
      },
    );
    // Without its copies, the first flare goes out as written, so its paths are at least the sender's own.
    await this.release(companion, copied || first.files.length === 0 ? null : first.original);
    return companion;
  }

  private async release(companion: string, replacement: string | null): Promise<void> {
    try {
      for (const row of await this.bb.sdk.threads.queuedMessages.list({ threadId: companion })) {
        if (replacement !== null) {
          await this.bb.sdk.threads.queuedMessages.update({
            threadId: companion,
            queuedMessageId: row.id,
            expectedUpdatedAt: row.updatedAt,
            input: [{ type: "text", text: replacement, mentions: [], visibility: "agent-only" }],
          });
        }
        await this.bb.sdk.threads.queuedMessages.send({ threadId: companion, queuedMessageId: row.id, mode: "auto" });
      }
    } catch (error) {
      this.bb.log.info(`Could not release ${companion}'s first flare early; it goes on its own: ${message(error)}`);
    }
  }

  /** Mutes the companion in bb's push notifications when that plugin is on; without it there is nothing to mute. */
  private async quiet(companion: string): Promise<void> {
    try {
      await this.bb.sdk.plugins.callRpc({
        pluginId: PUSH_PLUGIN,
        method: "threadNotifications.set",
        input: { threadId: companion, level: "muted" },
        outputSchema: z.unknown(),
      });
    } catch {
      // No push notifications, or a version without per-thread levels: the companion is a quiet child anyway.
    }
  }

  private async storageRoot(threadId: string): Promise<{ hostId: string; root: string } | null> {
    try {
      const location = await this.bb.sdk.threads.storageLocation({ threadId });
      return { hostId: location.hostId, root: location.storageRootPath.replace(/\/+$/, "") };
    } catch (error) {
      this.bb.log.info(`No thread storage for ${threadId}: ${message(error)}`);
      return null;
    }
  }

  private async writeFiles(companion: string, prepared: Prepared): Promise<void> {
    if (prepared.files.length === 0) return;
    const target = await this.storageRoot(companion);
    if (target === null) return;
    const folder = `${target.root}/${filesFolder(prepared.flare.id)}`;
    for (const file of prepared.files) {
      const path = `${folder}/${file.path}`;
      // A new thread's storage folder may not exist yet, and a write under it cannot create its own parents there.
      await this.bb.sdk.files.mkdir({ hostId: target.hostId, path: path.slice(0, path.lastIndexOf("/")), recursive: true });
      await this.bb.sdk.files.write({ hostId: target.hostId, rootPath: target.root, path, content: file.content, contentEncoding: file.encoding, createParents: true });
    }
  }

  /** Deletes a companion and forgets it; its copied files go with its storage. */
  async discard(viewerId: string, companion: string): Promise<void> {
    this.store.forgetCompanion(viewerId);
    this.bb.rpc.experimental_invalidate([threadTag(viewerId)]);
    try {
      await this.bb.sdk.threads.delete({ threadId: companion, childThreadsConfirmed: true });
    } catch (error) {
      if (!isNotFound(error)) this.bb.log.info(`Could not delete companion ${companion}: ${message(error)}`);
    }
  }

  /** Resolves once every queued sync has finished; for tests and disposal. */
  async settled(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
  }
}
