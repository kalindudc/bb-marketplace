import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readFileSync } from "node:fs";
import { tags, type JournalEdit } from "../../shared/contract";
import { JOURNAL_NOTE_PREFIX } from "../../shared/text";
import { actorSchema, journalChangeSchema, journalEntrySchema, type Actor, type JournalChange, type JournalEntry, type Journal, type WaypointLink } from "../../shared/schema";
import type { Database, JournalDeps } from "../ports";
import { DEFAULT_SETTINGS } from "../../shared/settings";
import { LIMITS } from "../limits";
import { actionSchema, ago, applyAction, awaitingSummary, closed, delegated, ordered, openSummary, rebriefEntries, type ShowOptions, planLine, progress, requireWarden, wardenCanReview, requireReopen, canManageLinks, BOARD_MIRROR_REFUSAL, copy, validateEntries, type JournalAction } from "./engine";
import { normalizeLegacy } from "./legacy";
import { boardMirrors, mirrorHistory } from "./board-mirrors";
import { changeSummary, clip, formatUserChanges, MAX_NOTE_TEXT } from "./text";
import { REPORT_GRACE_MS } from "../../shared/journal-tracker";
import { trackerMarkdown } from "./export";

/** Cut a name at a word boundary, never mid-word. */
const wordCut = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit).replace(/\s+\S*$/, "") || text.slice(0, limit)}…`;

export function readJournalSkill(moduleUrl = import.meta.url): string {
  // bb bundles this module into dist/server.js without rewriting import.meta.url.
  const fromSource = new URL("./", moduleUrl).pathname.endsWith("/src/server/journal/");
  return readFileSync(new URL(`${fromSource ? "../../../" : "../"}skills/journal/SKILL.md`, moduleUrl), "utf8");
}
export type Times = { agentChangedAt: number | null; notedAt: number | null };
/** At most one reminder per thread in this time, however many messages arrive. */
export const REMIND_EVERY_MS = DEFAULT_SETTINGS.journal.remindEveryMinutes * 60_000;
/** Shared with the panel's currency line, so the reminder and the panel name a waiting report at the same moment. */
export { REPORT_GRACE_MS };
/** The agent's own actions that change what the journal says about the work; rewording, notes and reordering don't. */
export const STATE_ACTIONS = ["add", "split", "add_step", "start", "done", "block", "reopen", "verify", "reject", "toggle", "delete", "clear", "settle", "wait", "undo", "redo"];
export type ReminderState = { stateChangedAt: number | null; notedAt: number | null; reportAt: number | null; now: number };
/**
 * A reminder is due when the journal has open entries and either no status changed since the previous message (once per such
 * stretch), or a delegate's report has waited unchecked past the grace period. Never twice within REMIND_EVERY_MS.
 */
export function reminderDue(t: ReminderState, entries: JournalEntry[], previousRequestAt: number | null, remindMs = REMIND_EVERY_MS, graceMs = REPORT_GRACE_MS): boolean {
  if (!entries.some(e => !closed(e))) return false;
  if (t.notedAt !== null && t.now - t.notedAt < remindMs) return false;
  const byRequest = t.stateChangedAt !== null && previousRequestAt !== null && t.stateChangedAt < previousRequestAt && (t.notedAt === null || t.notedAt < t.stateChangedAt);
  const byReport = t.reportAt !== null && t.now - t.reportAt >= graceMs && (t.notedAt === null || t.notedAt < t.reportAt);
  return byRequest || byReport;
}
const FINISHED = /\b(live since|settled|shipped|merged|landed|approved|green|\(done\)|done:)/i;
/** What the reminder names: unchecked reports, entries reworded instead of moved, and entries whose text says they are finished. */
export function staleLines(entries: JournalEntry[], show: ShowOptions): string[] {
  const open = ordered(entries).filter(e => !closed(e));
  const lines: string[] = [];
  for (const e of open) {
    const made = show.now !== undefined ? `, open ${ago(e.createdAt, show.now).replace(/ ago$/, "")}` : "";
    if ((e.rewrites ?? 0) >= 3) lines.push(`[${e.id}] reworded ${e.rewrites} times without a status change${made}.`);
    // A blocked entry's reason already says why it is open, so only unblocked descriptions are read for completion words.
    const finished = !e.report && e.status !== "blocked" && e.description.match(FINISHED)?.[0];
    if (finished) lines.push(`[${e.id}] reads as finished (${JSON.stringify(finished)}) and is still open${made}.`);
  }
  return lines.slice(0, 8);
}
type JournalRow = { thread_id: string; next_id: number; hydrated: number; agent_changed_at: number | null; noted_at: number | null; last_tool_at: number | null; empty_hint_seq: number | null };
export const QUIET_AFTER_MS = DEFAULT_SETTINGS.journal.journalQuietMinutes * 60_000;
type HistoryRow = { id: number; before_data: string; after_data: string; action: string; actor: string; state: "undo" | "redo" };
export function createJournalStore(bb: BbPluginApi, db: Database, deps: JournalDeps) {
  const listeners = new Set<(threadId: string, ids: string[], boardIds: readonly string[]) => string[] | void>();
  const hydration = new Map<string, Promise<void>>();
  const errors = new Map<string, { text: string; retryAt: number }>();
  const checked = new Map<string, number>();
  const readOnly = new Map<string, JournalEntry[]>();
  const deleted = new Set<string>();
  const prepared = new Set<string>();
  const mirrors = new Map<string, Promise<void>>();
  const noteLocks = new Map<string, Promise<unknown>>();
  async function withThreadLock<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const result = (noteLocks.get(threadId) ?? Promise.resolve()).catch(() => {}).then(task);
    noteLocks.set(threadId, result);
    try { return await result; } finally { if (noteLocks.get(threadId) === result) noteLocks.delete(threadId); }
  }
  let disposed = false;
  let ownedElsewhere = false;
  let ownershipKnown = false;
  let ownership: Promise<void> | null = null;
  let ownershipAt = 0;
  const warn = (text: string, error: unknown) => bb.log.warn(`${text}: ${error instanceof Error ? error.message : String(error)}`);
  const journalRow = (threadId: string) => db.prepare("SELECT * FROM questlog_logs WHERE thread_id = ?").get(threadId) as JournalRow | undefined;
  const localEntries = (threadId: string) => validateEntries(db.prepare("SELECT data FROM questlog_entries WHERE thread_id = ?").all(threadId).map(row => JSON.parse((row as { data: string }).data)));
  const pending = (threadId: string): JournalChange[] => db.prepare("SELECT * FROM questlog_changes WHERE thread_id = ? AND seen = 0 ORDER BY id").all(threadId).map(changeOf);
  function changeOf(row: unknown): JournalChange {
    const r = row as { id: number; thread_id: string; at: number; actor: string; action: string; entry_ids: string; text: string; seen: number };
    return journalChangeSchema.parse({ id: r.id, threadId: r.thread_id, at: r.at, actor: JSON.parse(r.actor), action: r.action, entryIds: JSON.parse(r.entry_ids), text: r.text, seen: !!r.seen });
  }
  function record(threadId: string, actor: Actor, action: string, ids: string[], text: string, seen: boolean) {
    const change = db.prepare("INSERT INTO questlog_changes(thread_id, at, actor, action, entry_ids, text, seen) VALUES (?, ?, ?, ?, ?, ?, ?)").run(threadId, Date.now(), JSON.stringify(actor), action, JSON.stringify(ids), clip(text, 1000), Number(seen));
    db.prepare("DELETE FROM questlog_changes WHERE thread_id = ? AND seen = 1 AND id NOT IN (SELECT id FROM questlog_changes WHERE thread_id = ? ORDER BY id DESC LIMIT 500)").run(threadId, threadId);
    return Number(change.lastInsertRowid);
  }
  /** Owner thread names learned from bb thread titles, for owners Tavern doesn't know as members. */
  const titles = new Map<string, string>();
  const knownName = (threadId: string) => deps.nameOf?.(threadId) || titles.get(threadId);
  const ownerLabel = (owner: string) => !/^thr_/.test(owner) ? owner : knownName(owner) ?? `thread ${owner}`;
  const describeChanges = (changes: JournalChange[]) => formatUserChanges(changes, knownName);
  const show = { name: ownerLabel };
  async function learnOwner(owner: string) {
    if (!/^thr_/.test(owner) || deps.nameOf?.(owner) || titles.has(owner)) return;
    try {
      const thread = await bb.sdk.threads.get({ threadId: owner }) as { title?: string | null };
      // bb titles read "Steve · You are the title bar designer": the name is the part before the dot.
      const name = thread.title?.split(" · ")[0]?.trim();
      if (name) titles.set(owner, wordCut(name, 40));
    } catch { /* an unknown or deleted thread keeps its id as its name */ }
  }
  async function exportMarkdown(threadId: string): Promise<string> {
    const entries = journalRow(threadId) ? localEntries(threadId) : [];
    await Promise.all([...new Set(entries.filter(delegated).map(e => e.owner!))].map(learnOwner));
    let title = deps.nameOf?.(threadId) ?? null;
    if (!title) try { title = ((await bb.sdk.threads.get({ threadId })) as { title?: string | null }).title ?? null; } catch { /* the id stands in */ }
    return trackerMarkdown(entries, { title: title || threadId, name: ownerLabel, now: Date.now() });
  }
  /** Board mirrors whose quest is over, from the Keeper store's phases; never inferred from the mirror's text. */
  const finishedMirror = (threadId: string) => {
    const over = new Set((deps.boardQuestsOf?.(threadId) ?? []).filter(q => q.phase === "done" || q.phase === "stopped").map(q => q.id));
    return (e: JournalEntry) => !!e.boardQuestId && over.has(e.boardQuestId);
  };
  /** The agent's own last state change, from the change log; rewording no longer resets staleness. */
  const stateChangedAt = (threadId: string) => (db.prepare(`SELECT MAX(at) AS at FROM questlog_changes WHERE thread_id = ? AND action IN (${STATE_ACTIONS.map(() => "?").join(",")}) AND json_extract(actor, '$.kind') = 'agent' AND json_extract(actor, '$.threadId') = ?`).get(threadId, ...STATE_ACTIONS, threadId) as { at: number | null }).at;
  const ownedRows = (owner: string) => db.prepare("SELECT thread_id, data FROM questlog_entries WHERE json_extract(data, '$.owner') = ?").all(owner) as { thread_id: string; data: string }[];
  /** Marks every open delegated entry this thread owns. A fact about the owner, not an edit: no undo step and no change note. */
  async function markOwner(owner: string, kind: "idle" | "archived" | "deleted", summary: string | null) {
    const touched = new Set<string>();
    for (const row of ownedRows(owner)) {
      const entry = JSON.parse(row.data) as JournalEntry;
      // A settled mark is the stronger fact; the owner idling again afterwards doesn't replace it.
      if (closed(entry) || !delegated(entry) || entry.link || (kind === "idle" && entry.report?.kind === "settled")) continue;
      touched.add(row.thread_id);
    }
    await Promise.all([...touched].map(threadId => withThreadLock(threadId, async () => {
      const entries = localEntries(threadId).map(e => e.owner === owner && !closed(e) && delegated(e) && !e.link && !(kind === "idle" && e.report?.kind === "settled")
        ? { ...e, report: { kind, at: Date.now(), threadId: owner, summary, by: { kind: "tavern" as const } } } : e);
      saveEntries(threadId, entries);
      deps.invalidate([tags.journal(threadId), tags.thread(threadId)]);
    })));
  }
  function saveEntries(threadId: string, entries: JournalEntry[]) {
    db.prepare("DELETE FROM questlog_entries WHERE thread_id = ?").run(threadId);
    const put = db.prepare("INSERT INTO questlog_entries(thread_id, id, board_quest_id, data) VALUES (?, ?, ?, ?)");
    for (const entry of validateEntries(entries)) {
      if (entry.threadId !== threadId) throw new Error("Saved entry belongs to a different thread.");
      put.run(threadId, entry.id, entry.link?.boardQuestId ?? null, JSON.stringify(entry));
      db.prepare("INSERT OR IGNORE INTO questlog_reserved(thread_id, id) VALUES (?, ?)").run(threadId, entry.id);
    }
  }
  function initialize(threadId: string) {
    if (disposed || deleted.has(threadId)) throw new Error("The journal is no longer available.");
    db.prepare("INSERT OR IGNORE INTO questlog_logs(thread_id) VALUES (?)").run(threadId);
  }
  function allocate(threadId: string): string {
    if (!prepared.has(threadId)) throw new Error("The legacy import is still pending. Await prepare(threadId) before allocating journal entries.");
    let n = journalRow(threadId)!.next_id;
    // The installed migration starts at 576; keep its counter monotonic while issuing legacy-compatible hex ids.
    while (n - 576 < 16 ** 8) {
      const id = (n++ - 576).toString(16).padStart(2, "0");
      if (db.prepare("SELECT 1 FROM questlog_reserved WHERE thread_id = ? AND id = ?").get(threadId, id)) continue;
      db.prepare("UPDATE questlog_logs SET next_id = ? WHERE thread_id = ?").run(n, threadId);
      db.prepare("INSERT INTO questlog_reserved(thread_id, id) VALUES (?, ?)").run(threadId, id);
      return id;
    }
    throw new Error("This journal has exhausted its never-reused ids.");
  }
  async function refreshOwnership(force = false) {
    if (ownership) return ownership;
    if (!force && ownershipKnown && Date.now() - ownershipAt < LIMITS.journalOwnershipCacheMs) return;
    ownership = (async () => {
      const { plugins } = await bb.sdk.plugins.list({});
      // Conservatively avoid a second writer even if Tavern happened to register first.
      ownedElsewhere = plugins.some(p => p.id === "pi-quests" && p.enabled);
      ownershipKnown = true;
      ownershipAt = Date.now();
    })();
    try { await ownership; } finally { ownership = null; }
  }
  function notify(threadId: string, ids: string[], entries = localEntries(threadId)) {
    const changed = new Set(ids);
    const boardIds = [...new Set(entries.flatMap(e => e.link && changed.has(e.id) ? [e.link.boardQuestId] : []))];
    const signal = new Set([tags.journal(threadId), tags.thread(threadId), ...boardIds.map(tags.boardQuest)]);
    // Listeners add what else the change makes stale; one signal covers all of it, so a page refetches the room once per change.
    for (const listener of listeners) {
      try { for (const tag of listener(threadId, ids, boardIds) ?? []) signal.add(tag); } catch (error) { warn("Journal change listener failed", error); }
    }
    deps.invalidate([...signal]);
    mirror(threadId);
    armQuiet(threadId);
  }
  function mirror(threadId: string) {
    if (!ownershipKnown || ownedElsewhere || disposed || !journalRow(threadId)?.hydrated) return;
    const next = (mirrors.get(threadId) ?? Promise.resolve()).catch(error => warn("Previous journal progress mirror failed", error)).then(async () => {
      if (ownedElsewhere || disposed) return;
      const p = progress(localEntries(threadId));
      if (!p.total && !db.prepare("SELECT 1 FROM questlog_mirrors WHERE thread_id = ?").get(threadId)) return;
      await bb.sdk.threads.updatePluginMetadata({ threadId, pluginId: "quests", set: { progress: { done: p.done, total: p.total, current: p.current?.description ?? null } } });
      if (!disposed && !deleted.has(threadId)) db.prepare("INSERT OR IGNORE INTO questlog_mirrors(thread_id) VALUES (?)").run(threadId);
    });
    mirrors.set(threadId, next);
    void next.catch(error => warn(`Could not mirror journal progress for ${threadId}`, error));
  }
  function reportReadError(threadId: string, error: unknown) {
    const text = clip(error instanceof Error ? error.message : String(error), 500);
    const previous = errors.get(threadId);
    if (!previous || previous.retryAt <= Date.now() || previous.text !== text) warn("Journal unavailable for " + threadId, error);
    errors.set(threadId, { text, retryAt: Date.now() + LIMITS.journalRetryMs });
  }
  function copiedFork(raw: string, threadId: string): JournalEntry[] {
    return validateEntries(JSON.parse(raw)).map(e => ({ ...e, threadId, owner: e.owner ? threadId : null, link: null, boardQuestId: null, status: e.status === "verified" ? "done" : e.status, review: null }));
  }
  async function ready(threadId: string, force = true): Promise<void> {
    if (deps.isRetired?.(threadId)) return;
    initialize(threadId);
    const existing = hydration.get(threadId);
    if (existing) return existing;
    if (!force && Date.now() - (checked.get(threadId) ?? 0) < LIMITS.journalOwnershipCacheMs) return;
    prepared.delete(threadId); checked.delete(threadId);
    const task = (async () => {
      await refreshOwnership(force);
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId, pluginId: "quests" });
      if (disposed || deleted.has(threadId) || deps.isRetired?.(threadId)) return;
      const wasHydrated = !!journalRow(threadId)!.hydrated;
      let imported: ReturnType<typeof normalizeLegacy> | null = null;
      let legacyProblem = false;
      try { imported = metadata.log === undefined ? null : normalizeLegacy(threadId, metadata); }
      catch (error) {
        if (!wasHydrated) throw error;
        legacyProblem = true; reportReadError(threadId, error);
      }
      if (ownedElsewhere) {
        const entries = imported?.entries ?? [];
        if (JSON.stringify(readOnly.get(threadId)) !== JSON.stringify(entries)) deps.invalidate([tags.journal(threadId), tags.thread(threadId)]);
        readOnly.set(threadId, entries);
        db.transaction(() => { for (const id of imported?.reserved ?? []) db.prepare("INSERT OR IGNORE INTO questlog_reserved(thread_id,id) VALUES(?,?)").run(threadId, id); })();
        prepared.add(threadId); checked.set(threadId, Date.now());
        if (!legacyProblem) errors.delete(threadId);
        return;
      }
      readOnly.delete(threadId);
      let forkEntries: JournalEntry[] = [], inheritedHistory: HistoryRow[] = [], reserved: string[] = [];
      let times: Times = imported?.times ?? { agentChangedAt: null, notedAt: null };
      if (!imported && !wasHydrated) {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.originKind === "fork" && thread.originPluginId !== "side-chat" && thread.sourceThreadId !== null) {
          await ready(thread.sourceThreadId);
          forkEntries = copiedFork(JSON.stringify(localEntries(thread.sourceThreadId)), threadId);
          reserved = (db.prepare("SELECT id FROM questlog_reserved WHERE thread_id = ?").all(thread.sourceThreadId) as { id: string }[]).map(r => r.id);
          times = { agentChangedAt: journalRow(thread.sourceThreadId)!.agent_changed_at, notedAt: null };
          inheritedHistory = db.prepare("SELECT * FROM questlog_history WHERE thread_id = ? ORDER BY id").all(thread.sourceThreadId) as HistoryRow[];
        }
      }
      if (disposed || deleted.has(threadId)) return;
      const baseline = db.prepare("SELECT fingerprint,snapshot FROM questlog_imports WHERE thread_id = ?").get(threadId) as { fingerprint: string; snapshot: string } | undefined;
      const needsImport = imported && baseline?.fingerprint !== imported.fingerprint;
      let changed = !wasHydrated;
      db.transaction(() => {
        const local = localEntries(threadId);
        let entries = local;
        if (imported && needsImport) {
          const previous = baseline ? validateEntries(JSON.parse(baseline.snapshot)) : [];
          const untouched = (entry: JournalEntry) => {
            const prior = previous.find(e => e.id === entry.id);
            return prior ? JSON.stringify(prior) === JSON.stringify(entry) : entry.updatedBy.kind === "import" && entry.createdBy.kind === "import";
          };
          const conflicts = new Set<string>();
          const merge = (current: JournalEntry[]) => {
            const combined = current.filter(e => !(untouched(e) && previous.some(p => p.id === e.id) && !imported.entries.some(n => n.id === e.id) && !current.some(other => other.parentId === e.id || other.after.includes(e.id))));
            for (const fresh of imported.entries) {
              const at = combined.findIndex(e => e.id === fresh.id);
              if (at >= 0) {
                if (untouched(combined[at]!)) combined[at] = copy(fresh);
                else if (!previous.some(e => e.id === fresh.id)) {
                  conflicts.add(fresh.id);
                  db.prepare("INSERT OR REPLACE INTO questlog_archive(thread_id,id,data,reason) VALUES(?,?,?,?)").run(threadId, fresh.id, JSON.stringify(fresh), "Legacy id conflicts with a Tavern edit");
                }
              }
              else if (!previous.some(e => e.id === fresh.id) && (!wasHydrated || !db.prepare("SELECT 1 FROM questlog_reserved WHERE thread_id = ? AND id = ?").get(threadId, fresh.id))) combined.push(copy(fresh));
            }
            for (const child of [...combined]) if (child.parentId && !combined.some(e => e.id === child.parentId)) {
              const parent = current.find(e => e.id === child.parentId);
              if (parent) combined.push(parent);
            }
            for (const parent of combined) if (closed(parent) && combined.some(e => e.parentId === parent.id && !closed(e))) parent.status = "todo";
            while (combined.length > 200) {
              const candidate = [...combined].filter(e => e.updatedBy.kind === "import").sort((a, b) => Number(closed(b)) - Number(closed(a)) || a.createdAt - b.createdAt).find(e => !combined.some(child => child.parentId === e.id || child.after.includes(e.id)));
              if (!candidate) throw new Error("The merged legacy log exceeds 200 active entries; the saved journal was left unchanged.");
              db.prepare("INSERT OR REPLACE INTO questlog_archive(thread_id,id,data,reason) VALUES(?,?,?,?)").run(threadId, candidate.id, JSON.stringify(candidate), "Import overflow");
              combined.splice(combined.indexOf(candidate), 1);
            }
            return validateEntries(combined);
          };
          entries = merge(local);
          const histories = db.prepare("SELECT * FROM questlog_history WHERE thread_id = ?").all(threadId) as HistoryRow[];
          for (const h of histories) db.prepare("UPDATE questlog_history SET before_data = ?, after_data = ? WHERE id = ?").run(JSON.stringify(merge(validateEntries(JSON.parse(h.before_data)))), JSON.stringify(merge(validateEntries(JSON.parse(h.after_data)))), h.id);
          for (const archive of imported.archived) db.prepare("INSERT OR REPLACE INTO questlog_archive(thread_id,id,data,reason) VALUES(?,?,?,?)").run(threadId, archive.id, archive.data, archive.reason);
          db.prepare("INSERT OR REPLACE INTO questlog_imports(thread_id,fingerprint,snapshot) VALUES(?,?,?)").run(threadId, imported.fingerprint, JSON.stringify(imported.entries));
          reserved = imported.reserved;
          if (!baseline && !wasHydrated) for (const note of imported.notes) record(threadId, { kind: "import", from: "pi-quests" }, "note", [], note, false);
          record(threadId, { kind: "import", from: "pi-quests" }, "import", entries.filter(e => !local.some(l => JSON.stringify(l) === JSON.stringify(e))).map(e => e.id), imported.summary + (conflicts.size ? " Preserved " + conflicts.size + " conflicting legacy ids in the import archive." : ""), true);
          changed = true;
        } else if (!wasHydrated && forkEntries.length) {
          entries = validateEntries([...forkEntries, ...local]);
          if (!local.length) for (const h of inheritedHistory) db.prepare("INSERT INTO questlog_history(thread_id,before_data,after_data,action,actor,state) VALUES(?,?,?,?,?,?)").run(threadId, JSON.stringify(copiedFork(h.before_data, threadId)), JSON.stringify(copiedFork(h.after_data, threadId)), h.action, h.actor, h.state);
        }
        if (changed) saveEntries(threadId, entries);
        for (const id of reserved) db.prepare("INSERT OR IGNORE INTO questlog_reserved(thread_id, id) VALUES (?, ?)").run(threadId, id);
        if (metadata.progress !== undefined) db.prepare("INSERT OR IGNORE INTO questlog_mirrors(thread_id) VALUES (?)").run(threadId);
        db.prepare("UPDATE questlog_logs SET hydrated = 1, agent_changed_at = COALESCE(agent_changed_at, ?), noted_at = COALESCE(noted_at, ?) WHERE thread_id = ?").run(times.agentChangedAt, times.notedAt, threadId);
      })();
      if (!legacyProblem) errors.delete(threadId);
      prepared.add(threadId); checked.set(threadId, Date.now());
      syncBoardQuests(threadId);
      if (changed) notify(threadId, localEntries(threadId).map(e => e.id));
    })();
    hydration.set(threadId, task);
    try { await task; } catch (error) { reportReadError(threadId, error); throw error; }
    finally { if (hydration.get(threadId) === task) hydration.delete(threadId); }
  }
  async function prepare(threadId: string): Promise<void> {
    await ready(threadId, false);
    syncBoardQuests(threadId);
    if (!prepared.has(threadId)) throw new Error("Journal preparation did not finish; retry before allocating entries.");
  }
  function scheduleRead(threadId: string) {
    if (!disposed && !deleted.has(threadId) && (errors.get(threadId)?.retryAt ?? 0) <= Date.now()) void ready(threadId, false).catch(() => {});
  }
  function syncBoardQuests(threadId: string): void {
    if (!deps.boardQuestsOf || !journalRow(threadId) || disposed || deleted.has(threadId) || deps.isRetired?.(threadId)) return;
    const before = localEntries(threadId);
    const after = boardMirrors(before, deps.boardQuestsOf(threadId), Date.now());
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const ids = after.filter(e => JSON.stringify(e) !== JSON.stringify(before.find(b => b.id === e.id))).map(e => e.id);
    db.transaction(() => {
      saveEntries(threadId, after);
      const histories = db.prepare("SELECT * FROM questlog_history WHERE thread_id = ?").all(threadId) as HistoryRow[];
      // Checklist undo must not roll back a board phase.
      for (const h of histories) db.prepare("UPDATE questlog_history SET before_data = ?, after_data = ? WHERE id = ?").run(JSON.stringify(mirrorHistory(validateEntries(JSON.parse(h.before_data)), after)), JSON.stringify(mirrorHistory(validateEntries(JSON.parse(h.after_data)), after)), h.id);
      record(threadId, {kind:"tavern"}, "board-phase", ids, `refreshed board quest phases: ${ids.map(id => `[${id}]`).join(", ")}. These entries mirror the board; use tavern_wrap to finish them.`, true);
    })();
    notify(threadId, ids, [...before, ...after]);
  }
  const isKeeper = (threadId: string) => deps.roleOf(threadId)?.role === "keeper";
  const minimal = (threadId: string): Journal => ({ threadId, entries: [], changes: [], progress: progress([]), canUndo: false, canRedo: false, toolOwnedElsewhere: ownedElsewhere, ...(errors.has(threadId) ? {problem: errors.get(threadId)!.text} : {}) });
  const journalPacing = () => ({ remindEveryMinutes: deps.settings?.().remindEveryMinutes ?? DEFAULT_SETTINGS.journal.remindEveryMinutes, reportGraceMinutes: deps.settings?.().reportGraceMinutes ?? DEFAULT_SETTINGS.journal.reportGraceMinutes });
  const quietMs = () => deps.settings ? deps.settings().journalQuietMinutes * 60_000 : QUIET_AFTER_MS;
  /** When the thread's own doing work last moved: a tool, a journal change or a doing entry's edit. Null with nothing doing. */
  function activeAt(threadId: string, entries: JournalEntry[]): number | null {
    // Quiet is about the thread's own work; an owned doing entry is another agent's, which this thread only waits on.
    const doing = entries.filter(e => e.status === "doing" && !delegated(e));
    if (!doing.length) return null;
    const lastChange = db.prepare("SELECT MAX(at) AS at FROM questlog_changes WHERE thread_id = ?").get(threadId) as { at: number | null };
    return Math.max(journalRow(threadId)?.last_tool_at ?? 0, lastChange.at ?? 0, ...doing.map(e => e.updatedAt));
  }
  const quietSince = (threadId: string, entries: JournalEntry[]) => { const at = activeAt(threadId, entries); return at !== null && Date.now() - at >= quietMs() ? at : null; };
  /**
   * Going quiet changes what people see without any event, so one timer per working thread invalidates once at the threshold.
   * Tool activity only re-arms it: an active thread's tools never refetch the room (Beena's finding).
   */
  const quietTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function armQuiet(threadId: string, entries?: JournalEntry[]) {
    const old = quietTimers.get(threadId);
    if (old) { clearTimeout(old); quietTimers.delete(threadId); }
    if (disposed || deleted.has(threadId) || !journalRow(threadId)) return;
    let at: number | null;
    try { at = activeAt(threadId, entries ?? localEntries(threadId)); } catch { return; }
    const wait = at === null ? -1 : at + quietMs() - Date.now();
    if (wait < 0) return;
    const timer = setTimeout(() => {
      quietTimers.delete(threadId);
      if (disposed || deleted.has(threadId) || !journalRow(threadId)) return;
      try { if (quietSince(threadId, localEntries(threadId)) !== null) deps.invalidate([tags.journal(threadId)]); } catch { /* a read error shows on the next fetch */ }
    }, wait);
    (timer as { unref?: () => void }).unref?.();
    quietTimers.set(threadId, timer);
  }
  function safeProgress(threadId: string) {
    if (deps.isRetired?.(threadId)) return progress([]);
    try {
      initialize(threadId); scheduleRead(threadId); syncBoardQuests(threadId);
      const entries = ownedElsewhere && readOnly.has(threadId) ? readOnly.get(threadId)! : localEntries(threadId);
      const lastEvidenceAt = entries.reduce((at, entry) => entry.evidence.length ? Math.max(at, entry.updatedAt) : at, 0);
      return { ...progress(entries), quietSince: quietSince(threadId, entries), ...(lastEvidenceAt ? { lastEvidenceAt } : {}) };
    } catch (error) { reportReadError(threadId, error); return progress([]); }
  }
  function get(threadId: string): Journal {
    if (deps.isRetired?.(threadId)) return minimal(threadId);
    try {
      initialize(threadId); scheduleRead(threadId); syncBoardQuests(threadId);
      const entries = ownedElsewhere && readOnly.has(threadId) ? readOnly.get(threadId)! : localEntries(threadId);
      const can = (state: string) => !!db.prepare("SELECT 1 FROM questlog_history WHERE thread_id = ? AND state = ? LIMIT 1").get(threadId, state);
      return { threadId, entries, changes: db.prepare("SELECT * FROM (SELECT * FROM questlog_changes WHERE thread_id = ? ORDER BY id DESC LIMIT 200) ORDER BY id").all(threadId).map(changeOf), progress: safeProgress(threadId), canUndo: can("undo"), canRedo: can("redo"), reportGraceMinutes: journalPacing().reportGraceMinutes, toolOwnedElsewhere: ownedElsewhere, ...(errors.has(threadId) ? {problem: errors.get(threadId)!.text} : {}) };
    } catch (error) { reportReadError(threadId, error); return minimal(threadId); }
  }
  const trusted = (actor: Actor) => canManageLinks(actor, deps.roleOf);
  function mutate(threadId: string, input: JournalAction, actor: Actor): { message: string } {
    if (actor.kind === "agent") deps.assertWritable?.(actor.threadId);
    deps.assertWritable?.(threadId);
    initialize(threadId);
    if (!trusted(actor) && !ownershipKnown) throw new Error("Journal metadata ownership is being checked. Retry after the view refreshes.");
    if (!trusted(actor) && ownedElsewhere) throw new Error("pi-quests is enabled. Disable it before editing Tavern's journal so there is only one checklist writer.");
    const action = actionSchema.parse(input);
    syncBoardQuests(threadId);
    const result = db.transaction(() => {
      const before = localEntries(threadId);
      let after: JournalEntry[], ids: string[], text: string;
      let reviewHistory: { before: JournalEntry[]; after: JournalEntry[] } | null = null;
      if (action.action === "undo" || action.action === "redo") {
        const direction = action.action;
        const row = db.prepare(`SELECT * FROM questlog_history WHERE thread_id = ? AND state = ? ORDER BY id ${direction === "undo" ? "DESC" : "ASC"} LIMIT 1`).get(threadId, direction) as HistoryRow | undefined;
        if (!row) throw new Error(`Nothing to ${direction}.`);
        // A follow-up brief reopened this work; undoing that would bring back a done that the new brief never saw.
        if (row.action === "rebrief" && actor.kind !== "tavern") throw new Error(`Brief v${row.after_data.match(/Brief v(\d+) arrived/)?.[1] ?? "?"} reopened this entry; mark it done with fresh evidence instead.`);
        if (row.action === "verify" || row.action === "reject") reviewHistory = { before: validateEntries(JSON.parse(row.before_data)), after: validateEntries(JSON.parse(row.after_data)) };
        after = boardMirrors(validateEntries(JSON.parse(direction === "undo" ? row.before_data : row.after_data)), deps.boardQuestsOf?.(threadId) ?? [], Date.now());
        ids = [...new Set([...before, ...after].map(e => e.id))].filter(id => JSON.stringify(before.find(e => e.id === id)) !== JSON.stringify(after.find(e => e.id === id)));
        for (const id of ids) {
          const prior = before.find(e => e.id === id), restored = after.find(e => e.id === id);
          if (prior?.boardQuestId || restored?.boardQuestId) {
            // Moving an ordinary sibling may move a mirror, but must not change its content or phase.
            const priorMirror = prior && {...prior,order:0,updatedAt:0,updatedBy:null};
            const restoredMirror = restored && {...restored,order:0,updatedAt:0,updatedBy:null};
            const quest = deps.boardQuestsOf?.(threadId).find(q => q.id === (prior?.boardQuestId ?? restored?.boardQuestId));
            const terminalCleanup = row.action === "clear" && (!prior || !restored) && quest && (quest.phase === "done" || quest.phase === "stopped");
            if (!terminalCleanup && JSON.stringify(priorMirror) !== JSON.stringify(restoredMirror)) throw new Error(BOARD_MIRROR_REFUSAL);
          }
          const originalBefore = reviewHistory?.before.find(e => e.id === id), originalAfter = reviewHistory?.after.find(e => e.id === id);
          const reviewChanged = originalBefore && originalAfter && JSON.stringify(originalBefore.review) !== JSON.stringify(originalAfter.review);
          if (reviewChanged && actor.kind !== "tavern") requireWarden(originalAfter, actor, deps.roleOf);
          if (prior?.review?.reason && prior.review.memberEvidenceAt === null && restored?.status === "done" && !(reviewChanged && direction === "undo")) throw new Error("Submit evidence checked after rejection before restoring reported done work.");
          if (prior?.status === "verified") requireReopen(prior, actor, deps.roleOf);
          if (restored?.status === "verified") requireWarden(restored, actor, deps.roleOf);
          if (JSON.stringify(prior?.link ?? null) !== JSON.stringify(restored?.link ?? null) && !canManageLinks(actor, deps.roleOf)) throw new Error("Only the Keeper or Tavern can change linked waypoints through history.");
        }
        text = changeSummary(direction, ids, before, after);
        db.prepare("UPDATE questlog_history SET state = ? WHERE id = ?").run(direction === "undo" ? "redo" : "undo", row.id);
      } else {
        const result = applyAction(before, action, { threadId, actor, now: Date.now(), allocate: () => allocate(threadId), roleOf: deps.roleOf, finishedMirror: finishedMirror(threadId) });
        if (!result.changed) return { message: `No change. ${planLine(before, show)}`, changed: false, ids: [] as string[], affected: before };
        after = result.entries; ids = result.entryIds; text = result.text;
        db.prepare("DELETE FROM questlog_history WHERE thread_id = ? AND state = 'redo'").run(threadId);
        db.prepare("INSERT INTO questlog_history(thread_id, before_data, after_data, action, actor, state) VALUES (?, ?, ?, ?, ?, 'undo')").run(threadId, JSON.stringify(before), JSON.stringify(after), action.action, JSON.stringify(actor));
        db.prepare("DELETE FROM questlog_history WHERE thread_id = ? AND id NOT IN (SELECT id FROM questlog_history WHERE thread_id = ? ORDER BY id DESC LIMIT 50)").run(threadId, threadId);
      }
      saveEntries(threadId, after);
      const seen = actor.kind !== "user" && !(actor.kind === "agent" && actor.threadId !== threadId);
      const sequence = record(threadId, actor, action.action, ids, text, seen);
      if (action.action === "verify" || action.action === "reject") {
        const priorEntries = new Map(before.map(entry => [entry.id, entry]));
        const changedIds = new Set(ids);
        const reviews = after.flatMap(entry => {
          const prior = priorEntries.get(entry.id);
          return changedIds.has(entry.id) && prior && JSON.stringify(prior.review) !== JSON.stringify(entry.review)
            ? [{ before: copy(prior), after: copy(entry), sequence }] : [];
        });
        if (reviews.length) deps.verdictSubmitted?.(actor, reviews.map(review => review.after));
        for (const review of reviews) deps.reviewed?.(review);
      }
      if (reviewHistory) for (const entry of reviewHistory.after) {
        const prior = reviewHistory.before.find(e => e.id === entry.id);
        if (prior && JSON.stringify(prior.review) !== JSON.stringify(entry.review)) deps.reviewed?.({ before: copy(prior), after: copy(entry), sequence, undone: action.action === "undo" });
      }
      if (actor.kind === "agent" && actor.threadId === threadId) db.prepare("UPDATE questlog_logs SET agent_changed_at = ? WHERE thread_id = ?").run(Date.now(), threadId);
      const noProof = after.filter(e => ids.includes(e.id) && e.status === "done" && !e.boardQuestId && !e.evidence.length);
      const details = action.action === "add" || action.action === "split" || action.action === "add_step" ? `\nNew ids: ${ids.join(", ")}\nOpen:\n${openSummary(after, 5, show)}` : "";
      const waiting = awaitingSummary(after, show);
      return { message: `You ${text}\n${planLine(after, show)}${waiting ? `\n${waiting}` : ""}${details}${noProof.length ? `\n${noProof.map(e => `[${e.id}] done without evidence; attach a command/result, file or short statement when available.`).join("\n")}` : ""}`, changed: true, ids, affected: [...before, ...after] };
    })();
    if (result.changed) notify(threadId, result.ids, result.affected);
    return { message: result.message };
  }
  function edit(threadId: string, edit: JournalEdit, actor: Actor): { message: string } {
    deps.assertWritable?.(threadId);
    get(threadId);
    if (!trusted(actor) && !journalRow(threadId)!.hydrated) throw new Error("The old journal is being imported. Retry this edit after the view refreshes.");
    if (edit.op === "status" && (edit.status === "verified" || edit.status === "rejected")) throw new Error("Only the assigned Warden can verify or reject through the journal tool.");
    switch (edit.op) {
      case "add": return mutate(threadId, { action: edit.parentId ? "split" : "add", id: edit.parentId ?? undefined, descriptions: edit.descriptions }, actor);
      case "status": return mutate(threadId, { action: edit.status === "todo" ? "reopen" : edit.status === "doing" ? "start" : edit.status === "blocked" ? "block" : edit.status === "rejected" ? "reject" : edit.status === "verified" ? "verify" : "done", ids: edit.entryIds, reason: edit.reason ?? (edit.status === "blocked" || edit.status === "rejected" ? localEntries(threadId).find(e => e.id === edit.entryIds[0])?.note ?? undefined : undefined), evidence: edit.evidence }, actor);
      case "update": return mutate(threadId, { action: "update", id: edit.entryId, description: edit.description }, actor);
      // The UI edits the whole note, so it replaces; agents append through the tool.
      case "note": return mutate(threadId, { action: "note", id: edit.entryId, note: edit.note, mode: "replace" }, actor);
      case "delete": return mutate(threadId, { action: "delete", ids: edit.entryIds }, actor);
      case "reorder": return mutate(threadId, { action: "reorder", id: edit.entryId, targetId: edit.beforeId }, actor);
      case "reparent": return mutate(threadId, { action: "reparent", id: edit.entryId, parentId: edit.parentId }, actor);
      case "clear": return mutate(threadId, { action: "clear", all: edit.all }, actor);
      case "wait": return mutate(threadId, { action: "wait", ids: edit.entryIds }, actor);
      case "undo": case "redo": return mutate(threadId, { action: edit.op }, actor);
    }
  }
  function acknowledge(threadId: string, changes: JournalChange[]) {
    const mark = db.prepare("UPDATE questlog_changes SET seen = 1 WHERE thread_id = ? AND id = ?");
    db.transaction(() => { for (const change of changes) mark.run(threadId, change.id); })();
    if (changes.length) deps.invalidate([tags.journal(threadId)]);
  }
  async function executeTool(callerThreadId: string, input: JournalAction, assertVerdict?: () => string | void) {
    let unseen: JournalChange[] = [];
    const targetThreadId = input.threadId ?? callerThreadId;
    try {
      const action = actionSchema.parse(input);
      const threadId = action.threadId ?? callerThreadId;
      deps.assertWritable?.(callerThreadId);
      await ready(threadId, false);
      deps.assertWritable?.(callerThreadId);
      syncBoardQuests(threadId);
      const actor: Actor = { kind: "agent", threadId: callerThreadId };
      const entries = localEntries(threadId);
      if (threadId !== callerThreadId) {
        if (!["verify", "reject", "reopen", "list", "get"].includes(action.action)) throw new Error("Only Warden read and verdict actions can target another thread.");
        const role = deps.roleOf(callerThreadId);
        const selected = new Set(action.ids ?? (action.id ? [action.id] : []));
        const targets = selected.size ? entries.filter(e => selected.has(e.id)) : entries.filter(e => wardenCanReview(e, role));
        if (!targets.length) throw new Error("No linked entries found in the target thread.");
        for (const entry of targets) {
          if (action.action === "reopen" && entry.link && canManageLinks(actor, deps.roleOf)) continue;
          requireWarden(entry, actor, deps.roleOf);
        }
      }
      unseen = callerThreadId === threadId ? pending(threadId) : [];
      let text: string;
      if (action.action === "list") {
        const role = deps.roleOf(callerThreadId);
        const filtered = entries.filter(e => (threadId === callerThreadId || wardenCanReview(e, role)) && (action.filter === "open" ? !closed(e) : action.filter === "blocked" ? e.status === "blocked" : action.filter === "mine" ? e.owner === callerThreadId || (e.link && e.threadId === callerThreadId) || (e.createdBy.kind === "agent" && e.createdBy.threadId === callerThreadId) : true));
        text = filtered.length ? filtered.map(e => `[${e.id}] ${e.description} (${e.status})${e.parentId ? `; step of [${e.parentId}]` : ""}${e.note ? ` — ${e.note}` : ""}`).join("\n") : "No matching journal entries.";
      } else if (action.action === "get") {
        const entry = entries.find(e => e.id === action.id);
        if (!entry) throw new Error("Entry not found; provide id and use list to see current ids.");
        text = JSON.stringify(entry, null, 2);
      } else if (action.action === "rules" || action.action === "skill") text = readJournalSkill();
      else {
        const verdictNote = action.action === "verify" || action.action === "reject" ? assertVerdict?.() : undefined;
        text = mutate(threadId, action, actor).message;
        if (threadId !== callerThreadId) {
          const ids = action.ids ?? (action.id ? [action.id] : []);
          text = localEntries(threadId).filter(e => ids.includes(e.id)).map(e => `[${e.id}] ${JSON.stringify(e.description)} ${e.status}${e.note ? `; ${JSON.stringify(e.note)}` : ""}`).join("\n");
        }
        if (verdictNote) text += `\n${verdictNote}`;
      }
      acknowledge(threadId, unseen);
      return { text: clip(`${describeChanges(unseen)}${text}`, 28000), isError: false };
    } catch (error) {
      acknowledge(targetThreadId, unseen);
      return { text: `${describeChanges(unseen)}Error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
  }
  async function runTool(callerThreadId: string, input: JournalAction) {
    let assertVerdict: (() => string | void) | void;
    if (input.action === "verify" || input.action === "reject") {
      try {
        const action = actionSchema.parse(input), threadId = action.threadId ?? callerThreadId;
        await ready(threadId, false);
        assertVerdict = await deps.beforeVerdict?.(callerThreadId, threadId, action.ids ?? (action.id ? [action.id] : []));
      } catch (error) { return { text: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true }; }
    }
    return withThreadLock(input.threadId ?? callerThreadId, () => executeTool(callerThreadId, input, assertVerdict ?? undefined));
  }
  /**
   * A follow-up brief reached this member (runtime.finishInitialBrief): its finished entries linked to the quest reopen, as one Tavern
   * history step that the member's or the user's undo can't reverse. A verified entry's receipt is marked superseded first, in the same
   * transaction. It never throws, so accepting the brief can't fail on the journal; a failure is logged.
   */
  function rebriefed(threadId: string, boardQuestId: string, version: number) {
    const actor = { kind: "tavern" as const };
    try {
      if (!journalRow(threadId) || deleted.has(threadId)) return;
      let changed: { ids: string[]; entries: JournalEntry[] } | null = null;
      db.transaction(() => {
        const before = localEntries(threadId), at = Date.now();
        const r = rebriefEntries(before, { boardQuestId, version, at, name: ownerLabel });
        if (!r.ids.length) return;
        for (const entry of r.verified) deps.superseded?.({ entry, version, at });
        saveEntries(threadId, r.entries);
        db.prepare("DELETE FROM questlog_history WHERE thread_id = ? AND state = 'redo'").run(threadId);
        db.prepare("INSERT INTO questlog_history(thread_id,before_data,after_data,action,actor,state) VALUES(?,?,?,?,?,'undo')").run(threadId, JSON.stringify(before), JSON.stringify(r.entries), "rebrief", JSON.stringify(actor));
        db.prepare("DELETE FROM questlog_history WHERE thread_id = ? AND id NOT IN (SELECT id FROM questlog_history WHERE thread_id = ? ORDER BY id DESC LIMIT 50)").run(threadId, threadId);
        // Unseen, so the member's next journal result tells it what changed and why.
        record(threadId, actor, "rebrief", r.ids, r.text, false);
        changed = { ids: r.ids, entries: r.entries };
      })();
      if (changed) notify(threadId, (changed as { ids: string[] }).ids, (changed as { entries: JournalEntry[] }).entries);
    } catch (error) { warn(`Reopening ${threadId}'s journal after brief v${version} failed`, error); }
  }
  function linkWaypoint(threadId: string, link: WaypointLink, description: string, owner: string, actor: Actor): string {
    get(threadId);
    initialize(threadId);
    actorSchema.parse(actor);
    const validatedLink = actionSchema.parse({ action: "link", link }).link;
    if (!validatedLink) throw new Error("A waypoint link is required.");
    if (actor.kind === "agent" && deps.roleOf(actor.threadId)?.classId !== "keeper") throw new Error("Only a Keeper can assign waypoint entries.");
    const existing = localEntries(threadId).find(e => e.link?.boardQuestId === link.boardQuestId && e.link.waypointId === link.waypointId);
    if (existing) {
      if (existing.description !== description || existing.owner !== owner) mutate(threadId, { action: "update", id: existing.id, description, owner }, actor);
      return existing.id;
    }
    // One assignment, including its link, must be one history action rather than three undos.
    let id = "";
    db.transaction(() => {
      const before = localEntries(threadId);
      const r = applyAction(before, { action: "add", descriptions: [description], owner }, { threadId, actor, now: Date.now(), allocate: () => allocate(threadId), roleOf: deps.roleOf });
      id = r.createdIds[0]!;
      const entry = r.entries.find(e => e.id === id)!; entry.link = validatedLink;
      saveEntries(threadId, r.entries);
      db.prepare("DELETE FROM questlog_history WHERE thread_id = ? AND state = 'redo'").run(threadId);
      db.prepare("INSERT INTO questlog_history(thread_id,before_data,after_data,action,actor,state) VALUES(?,?,?,?,?,'undo')").run(threadId, JSON.stringify(before), JSON.stringify(r.entries), "linkWaypoint", JSON.stringify(actor));
      db.prepare("DELETE FROM questlog_history WHERE thread_id = ? AND id NOT IN (SELECT id FROM questlog_history WHERE thread_id = ? ORDER BY id DESC LIMIT 50)").run(threadId, threadId);
      record(threadId, actor, "link", [id], `assigned [${id}] ${JSON.stringify(description)} to waypoint ${link.waypointId}.`, actor.kind !== "user");
    })();
    notify(threadId, [id]); return id;
  }
  const store = {
    get, edit, runTool, ready, prepare, linkWaypoint, syncBoardQuests, isKeeper,
    journalPacing,
    reminders: () => deps.settings ? deps.settings().journalReminders : DEFAULT_SETTINGS.journal.journalReminders,
    deleteThread(threadId: string) {
      const rows = db.prepare("SELECT id,board_quest_id FROM questlog_entries WHERE thread_id = ?").all(threadId) as { id: string; board_quest_id: string | null }[];
      let entries: JournalEntry[] = [];
      try { entries = localEntries(threadId); } catch (error) { warn("Deleting corrupt journal for " + threadId, error); }
      prepared.delete(threadId);
      deleted.add(threadId); checked.delete(threadId); errors.delete(threadId); readOnly.delete(threadId);
      armQuiet(threadId);
      db.transaction(() => {
        for (const table of ["questlog_entries", "questlog_reserved", "questlog_changes", "questlog_history", "questlog_imports", "questlog_archive", "questlog_mirrors", "questlog_logs"]) db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(threadId);
      })();
      notify(threadId, rows.map(e => e.id), entries);
      const boards = [...new Set(rows.flatMap(r => r.board_quest_id ? [tags.boardQuest(r.board_quest_id)] : []))];
      // bb refuses an empty tag list, and a journal with no linked entries (most threads) has no board quests to refresh.
      if (boards.length) deps.invalidate(boards);
    },
    tracksWork: (threadId: string) => !!journalRow(threadId) && localEntries(threadId).some(e => e.status === "doing"),
    /** Read from SQLite only, never from bb: cheap enough to ask on every turn of every thread. */
    hasOpenEntries: (threadId: string) => { try { return !!journalRow(threadId) && localEntries(threadId).some(e => !closed(e)); } catch { return false; } },
    touchWork(threadId: string, at: number) {
      if (!Number.isSafeInteger(at) || at < 0) throw new Error("Tool activity needs a valid event timestamp.");
      if (!journalRow(threadId) || (journalRow(threadId)!.last_tool_at ?? 0) >= at) return;
      const entries = localEntries(threadId);
      const wasQuiet = quietSince(threadId, entries) !== null;
      db.prepare("UPDATE questlog_logs SET last_tool_at = ? WHERE thread_id = ?").run(at, threadId);
      // Only waking a quiet thread changes what anyone sees; an active thread's tools write the time and refetch nothing.
      if (wasQuiet) deps.invalidate([tags.journal(threadId)]);
      armQuiet(threadId, entries);
    },
    progress: safeProgress,
    linkedEntries: (boardQuestId: string): JournalEntry[] => (db.prepare("SELECT data FROM questlog_entries WHERE board_quest_id = ?").all(boardQuestId) as { data: string }[]).map(r => journalEntrySchema.parse(JSON.parse(r.data))),
    openSummary: (threadId: string, limit: number) => openSummary(get(threadId).entries, limit, show),
    ownerLabel, learnOwner, markOwner, exportMarkdown, rebriefed,
    awaiting: (threadId: string) => awaitingSummary(get(threadId).entries, show),
    isOwner: (owner: string) => ownedRows(owner).some(row => { const e = JSON.parse(row.data) as JournalEntry; return !closed(e) && delegated(e); }),
    pending: (threadId: string) => pending(threadId),
    describeChanges,
    emptyHintSeq: (threadId: string) => journalRow(threadId)?.empty_hint_seq ?? null,
    async deliverEmptyHint(threadId: string, throughSeq: number, userSteerSeq: number, send: (text: string) => Promise<void>) {
      return withThreadLock(threadId, async () => {
        if (disposed || deleted.has(threadId) || isKeeper(threadId) || ownedElsewhere || !store.reminders()) return;
        const row = journalRow(threadId);
        if (!row || (row.empty_hint_seq !== null && userSteerSeq <= row.empty_hint_seq)) return;
        if (localEntries(threadId).length || pending(threadId).length) return;
        await send(`${JOURNAL_NOTE_PREFIX} The journal is empty. If you have more work to do, add one entry per deliverable and start the one you are working on.`);
        if (!disposed) db.prepare("UPDATE questlog_logs SET empty_hint_seq = ? WHERE thread_id = ?").run(throughSeq, threadId);
      });
    },
    async deliverNote(threadId: string, previousRequestAt: number | null, send: (text: string) => Promise<void>, skipped: (reason: string) => void = () => {}) {
      return withThreadLock(threadId, async () => {
        if (isKeeper(threadId)) { skipped("a Keeper thread gets no journal steers"); return false; }
        await ready(threadId, false);
        if (isKeeper(threadId)) { skipped("a Keeper thread gets no journal steers"); return false; }
        if (ownedElsewhere) { skipped("another plugin keeps this thread's checklist"); return false; }
        const row = journalRow(threadId)!;
        // A finished board mirror is no work of the agent's: it never makes the journal stale, named or awaiting.
        const over = finishedMirror(threadId);
        const entries = localEntries(threadId).filter(e => !over(e)), changes = pending(threadId), now = Date.now();
        const reports = entries.filter(e => !closed(e) && e.report).map(e => e.report!.at);
        const state: ReminderState = { stateChangedAt: stateChangedAt(threadId) ?? row.agent_changed_at, notedAt: row.noted_at, reportAt: reports.length ? Math.max(...reports) : null, now };
        const { remindEveryMinutes, reportGraceMinutes } = store.journalPacing();
        const stale = store.reminders() && reminderDue(state, entries, previousRequestAt, remindEveryMinutes * 60_000, reportGraceMinutes * 60_000);
        if (!stale && !changes.length) { skipped(store.reminders() ? `no reminder is due (statuses changed since the previous message, or one went out in the last ${remindEveryMinutes} minutes), and no user edits are waiting` : "reminders are off in Tavern's settings, and no user edits are waiting"); return false; }
        const named = stale ? [awaitingSummary(entries, { ...show, now }), ...staleLines(entries, { ...show, now })].filter(Boolean).join("\n") : "";
        const text = clip(`${JOURNAL_NOTE_PREFIX} ${planLine(entries, show)}\n${clip(openSummary(entries, 5, show), 750)}\n${describeChanges(changes)}${named ? `${named}\n` : ""}${stale ? "You have not updated the journal's statuses since the previous message. If this request changes the plan, or a delegate reported, start, close, block, reopen, settle or wait on its entry; if not, carry on." : ""}`, MAX_NOTE_TEXT);
        await send(text);
        if (disposed) return true;
        acknowledge(threadId, changes);
        if (stale) db.prepare("UPDATE questlog_logs SET noted_at = ? WHERE thread_id = ?").run(now, threadId);
        return true;
      });
    },
    flush: async (threadId: string) => { await hydration.get(threadId); await mirrors.get(threadId); },
    onChange(listener: (threadId: string, ids: string[], boardIds: readonly string[]) => string[] | void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  void refreshOwnership().catch(error => warn("Journal ownership lookup failed", error));
  bb.onDispose(async () => { disposed = true; listeners.clear(); for (const t of quietTimers.values()) clearTimeout(t); quietTimers.clear(); await Promise.allSettled([...hydration.values(), ...mirrors.values(), ...noteLocks.values()]); });
  return store;
}
export type JournalStore = ReturnType<typeof createJournalStore>;
