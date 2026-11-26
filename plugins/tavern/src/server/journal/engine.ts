import { z } from "zod";
import { actorSchema, evidenceSchema, journalEntrySchema, waypointLinkSchema, type Actor, type EntryStatus, type JournalEntry, type JournalProgress } from "../../shared/schema";
import type { JournalDeps } from "../ports";
import { DEFAULT_SETTINGS } from "../../shared/settings";
import { IntakeLimits, limitMessage, type LimitValues } from "../../shared/limits";
import { changeSummary, clip } from "./text";

export const ACTIONS = ["add", "split", "add_step", "list", "toggle", "update", "delete", "clear", "reorder", "reparent", "undo", "redo", "rules", "skill", "start", "done", "block", "reopen", "verify", "reject", "skip", "note", "link", "get", "settle", "wait"] as const;
const shortId = z.string().regex(/^[0-9a-z]{2,8}$/);
export const actionSchema = z.object({
  action: z.enum(ACTIONS), id: shortId.optional(), ids: z.array(shortId).min(1).optional(),
  descriptions: z.array(z.string().trim().min(1)).min(1).optional(),
  description: z.string().trim().min(1).optional(),
  targetId: shortId.nullable().optional(), parentId: shortId.nullable().optional(), all: z.boolean().optional(),
  evidence: z.array(evidenceSchema).optional(), reason: z.string().trim().min(1).optional(),
  note: z.string().nullable().optional(), owner: z.string().max(100).nullable().optional(),
  after: z.array(shortId).optional(), links: z.array(evidenceSchema).optional(),
  link: waypointLinkSchema.nullable().optional(), filter: z.enum(["open", "mine", "blocked"]).optional(),
  threadId: z.string().min(1).max(100).optional(),
  mode: z.enum(["append", "replace"]).optional(),
});
export type JournalAction = z.infer<typeof actionSchema>;
export const closed = (entry: Pick<JournalEntry, "status">) => entry.status === "done" || entry.status === "verified";
/** Another agent's work this thread waits on. A member's linked waypoint is owned by its own thread, so it stays the agent's own work. */
export { delegated } from "../../shared/journal-tracker";
import { delegated } from "../../shared/journal-tracker";
export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export function ordered(entries: JournalEntry[]): JournalEntry[] {
  const sorted = [...entries].sort((a, b) => a.order - b.order);
  return sorted.filter(e => e.parentId === null).flatMap(e => [e, ...sorted.filter(s => s.parentId === e.id)]);
}
export function validateEntries(value: unknown): JournalEntry[] {
  const entries = z.array(journalEntrySchema).parse(value);
  const ids = new Set(entries.map(e => e.id));
  if (ids.size !== entries.length) throw new Error("Duplicate entry ids in the saved journal; nothing was changed.");
  // One step at a time for the agent's own work (the pi-quests rule). Entries with an owner are someone else's work, so any number run at once.
  if (entries.filter(e => e.status === "doing" && !delegated(e)).length > 1) throw new Error("Only one of your own entries can be doing at a time. Give each delegated entry an owner to run them side by side.");
  const visited = new Set<string>();
  const visit = (id: string, path: Set<string>) => {
    if (path.has(id)) throw new Error("Dependencies cannot form a cycle.");
    if (visited.has(id)) return;
    const dependency = entries.find(e => e.id === id);
    if (!dependency) throw new Error("A dependency was not found in this journal.");
    for (const next of dependency.after) visit(next, new Set([...path, id]));
    visited.add(id);
  };
  for (const entry of entries) {
    if (entry.parentId !== null) {
      if (entry.parentId === entry.id) throw new Error("An entry cannot be its own parent.");
      const parent = entries.find(e => e.id === entry.parentId);
      if (!parent || parent.parentId !== null) throw new Error("Only top-level entries can have steps.");
      if (closed(parent) && !closed(entry)) throw new Error("A parent cannot be done while its steps are open.");
    }
    if (entry.after.some(id => !ids.has(id))) throw new Error("A dependency was not found in this journal.");
    visit(entry.id, new Set());
  }
  return ordered(entries);
}
export function progress(entries: JournalEntry[]): JournalProgress {
  const all = ordered(entries);
  const ready = (e: JournalEntry) => !closed(e) && e.status !== "blocked" && e.after.every(id => closed(all.find(d => d.id === id)!));
  const pick = (pool: JournalEntry[]) => pool.find(e => e.status === "doing") ?? pool.find(e => ready(e) && !all.some(child => child.parentId === e.id && !closed(child))) ?? pool.find(ready) ?? pool.find(e => !closed(e));
  // The agent's own next step comes first; owned entries are other agents' work it waits on.
  const current = pick(all.filter(e => !delegated(e))) ?? pick(all);
  return { done: all.filter(closed).length, total: all.length, blocked: all.filter(e => e.status === "blocked").length,
    current: current ? { id: current.id, description: current.description, status: current.status } : null };
}
export type ShowOptions = { name?: (owner: string) => string; now?: number };
const plainName = (owner: string) => owner;
/** "3 min ago", "2 h ago", "4 days ago": how long since a report, at a glance. */
export function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}
/** One appended note line: local time, then the text. */
export function noteLine(at: number, text: string): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} ${text}`;
}
function appendNote(existing: string | null, line: string, values: LimitValues, notices?: Set<string>): string {
  const limit = new IntakeLimits(values, notices);
  const latest = limit.journalNote(z.string()).parse(line);
  const combined = existing ? `${existing}\n${latest}` : latest;
  let start = 0;
  while (combined.length - start > values.journal.noteKeepChars) {
    const newline = combined.indexOf("\n", start);
    if (newline < 0) break;
    start = newline + 1;
  }
  if (start) notices?.add(`Older journal note lines omitted. ${limitMessage("limits.journal.noteKeepChars", values.journal.noteKeepChars)}`);
  return combined.slice(start);
}
/**
 * A follow-up brief reached a member: finished entries linked to its named waypoints reopen.
 * Done and verified entries reopen, and a Warden's verdict is cleared because it proves only the brief it checked.
 * Rejected entries stay rejected with their reason. In every case the member's evidence moves into the note, labelled with its brief,
 * so a done report needs fresh evidence. Unfinished entries are left alone.
 */
export function rebriefEntries(original: JournalEntry[], { boardQuestId, version, waypointIds, at, name, limits = DEFAULT_SETTINGS.limits }: {
  boardQuestId: string; version: number; waypointIds: readonly string[]; at: number; name: (threadId: string) => string; limits?: LimitValues;
}) {
  const entries = copy(original);
  const targets = new Set(waypointIds);
  const was = version - 1;
  const ids: string[] = [], verified: JournalEntry[] = [], lines: string[] = [];
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  let doingOwn = entries.some(e => e.status === "doing" && !delegated(e));
  for (const e of entries) {
    if (e.link?.boardQuestId !== boardQuestId || !targets.has(e.link.waypointId) || !(closed(e) || e.status === "rejected")) continue;
    const parts: string[] = [];
    if (e.evidence.length) parts.push(`v${was} evidence kept for reference: ${e.evidence.map(x => x.detail ? `${x.ref} (${x.detail})` : x.ref).join(", ")}.`);
    const review = e.status === "verified" && !e.review?.kind ? e.review : null;
    if (review) parts.push(`Verified for brief v${was} by ${review.actor.kind === "agent" ? name(review.actor.threadId) : "a Warden"} (Warden).`);
    if (!parts.length) continue;
    const head = `[${e.id}] ${JSON.stringify(e.description)}`;
    if (e.status === "rejected") lines.push(`moved ${head}'s v${was} evidence to its note: brief v${version} arrived.`);
    else lines.push(review
      ? `reopened ${head}: brief v${version} arrived after it was verified. Its v${was} verdict and evidence are in the note; it needs fresh evidence and a new check.`
      : `reopened ${head}: brief v${version} arrived after it was done. Its v${was} evidence is in the note; attach fresh evidence before marking it done.`);
    if (review) { verified.push(copy(e)); e.review = null; }
    if (e.review?.kind) e.review = null;
    // An answer to a rejection given under the earlier brief no longer counts.
    if (e.review) e.review.memberEvidenceAt = null;
    const kept = [...(e.rebrief?.evidence ?? []), ...e.evidence];
    e.rebrief = { version, evidence: kept.filter((v, i) => kept.findIndex(x => JSON.stringify(x) === JSON.stringify(v)) === i) };
    if (e.status !== "rejected") {
      const own = !delegated(e);
      e.status = own && doingOwn ? "todo" : "doing";
      doingOwn ||= own;
      e.doneAt = null; e.doneBy = null; e.report = null; e.rewrites = 0;
    }
    e.evidence = [];
    e.note = appendNote(e.note, noteLine(at, `Brief v${version} arrived; ${parts.join(" ")}`), limits);
    e.updatedAt = at; e.updatedBy = { kind: "tavern" };
    ids.push(e.id);
  }
  for (const id of ids) {
    const e = byId.get(id)!;
    const parent = e.parentId ? byId.get(e.parentId) : undefined;
    if (!parent || !closed(parent)) continue;
    if (parent.link) {
      e.parentId = null;
      lines.push(`Moved [${e.id}] out of the completed [${parent.id}] checklist so its separate waypoint stays closed.`);
    } else {
      parent.status = "todo"; parent.doneAt = null; parent.doneBy = null; parent.updatedAt = at; parent.updatedBy = { kind: "tavern" };
    }
  }
  return { entries, ids, verified, text: lines.join("\n") };
}
/** Delegated entries whose owner went idle, settled, or lost its thread, oldest first, with what to do next. */
export function awaitingSummary(entries: JournalEntry[], { name = plainName, now = Date.now() }: ShowOptions = {}): string {
  const waiting = ordered(entries).filter(e => !closed(e) && e.report).sort((a, b) => a.report!.at - b.report!.at);
  if (!waiting.length) return "";
  const line = (e: JournalEntry) => {
    const r = e.report!, who = e.owner ? name(e.owner) : "The owner", when = ago(r.at, now), head = `[${e.id}] ${clip(e.description, 80)}`;
    const quote = r.summary ? `: ${JSON.stringify(clip(r.summary, 160))}` : "";
    if (r.kind === "settled") return `${head}: ${who} reported settled ${when}${quote}. Close it with evidence, or reopen it.`;
    if (r.kind === "idle") return `${head}: ${who} went idle ${when}${quote}. Check its output, then close it, reopen it, or wait on it.`;
    return `${head}: ${who}'s thread was ${r.kind} ${when}. Reassign it, close it or delete it.`;
  };
  return ["Awaiting your check:", ...waiting.map(line)].join("\n");
}
export function planLine(entries: JournalEntry[], { name = plainName }: ShowOptions = {}): string {
  const p = progress(entries);
  if (!p.total) return "The journal is empty.";
  const current = entries.find(e => e.id === p.current?.id);
  const waiting = ordered(entries).filter(e => delegated(e) && e.status === "doing");
  const waitLine = waiting.length ? ` Waiting on: ${waiting.slice(0, 6).map(e => `[${e.id}] ${clip(name(e.owner!), 40)}`).join(", ")}${waiting.length > 6 ? ` and ${waiting.length - 6} more` : ""}.` : "";
  const own = current && !delegated(current);
  const next = !p.current ? " Journal closed." : own || !waiting.length
    ? ` Next: [${p.current.id}] ${clip(p.current.description, 80)} (${p.current.status}${own ? "" : `, ${clip(name(current!.owner!), 40)}`})${current?.parentId ? ` (a step of [${current.parentId}])` : ""}.` : "";
  return `${p.done} of ${p.total} done.${next}${waitLine}`;
}
export function openSummary(entries: JournalEntry[], limit = 5, { name = plainName }: ShowOptions = {}): string {
  const all = ordered(entries).filter(e => !closed(e));
  // A delegated entry keeps its full description: the part an owner's status lives in is the part an 80-character clip cuts.
  const lines = all.slice(0, limit).map(e => `[${e.id}] ${delegated(e) ? e.description : clip(e.description, 80)} (${e.status}${delegated(e) ? `; ${clip(name(e.owner!), 40)}` : ""}${e.parentId ? `; step of [${e.parentId}]` : ""})`);
  if (all.length > limit) lines.push(`and ${all.length - limit} more open entries`);
  return lines.join("\n");
}
export const BOARD_MIRROR_REFUSAL = "This entry mirrors its board quest phase and cannot be ticked or edited as a chore. Use tavern_wrap to finish the board quest, or stop it through Tavern.";
export function requireMutable(entry: JournalEntry): void {
  if (entry.boardQuestId) throw new Error(BOARD_MIRROR_REFUSAL);
}
export function wardenReview(entry: JournalEntry, threadId: string, role: ReturnType<JournalDeps["roleOf"]>) {
  if (!entry.link || threadId === entry.threadId || role?.classId !== "warden" || role.role !== "member" || role.boardQuestId !== entry.link.boardQuestId)
    return { problem: "Only an active Warden on this board quest can check another maker's linked entry." };
  if (!role.checkerEntryReview) return { problem: "Warden review authorization is unavailable for this entry." };
  return role.checkerEntryReview(entry);
}
export function requireWarden(entry: JournalEntry, actor: Actor, roleOf: JournalDeps["roleOf"]): string | null | undefined {
  const threadId = actor.kind === "agent" ? actor.threadId : "";
  const review = wardenReview(entry, threadId, threadId ? roleOf(threadId) : null);
  if (review.problem) throw new Error(review.problem);
  return review.note;
}
export function canManageLinks(actor: Actor, roleOf: JournalDeps["roleOf"]): boolean {
  return actor.kind === "tavern" || (actor.kind === "agent" && roleOf(actor.threadId)?.classId === "keeper");
}
export function requireReopen(entry: JournalEntry, actor: Actor, roleOf: JournalDeps["roleOf"]): void {
  if (entry.status === "verified" && !canManageLinks(actor, roleOf)) requireWarden(entry, actor, roleOf);
}
export interface EngineContext {
  threadId: string; actor: Actor; now: number; allocate(): string; roleOf: JournalDeps["roleOf"];
  limits?: LimitValues;
  /** A board mirror whose quest phase is over (done or stopped), from the Keeper store: clear may remove it whatever its status. */
  finishedMirror?(entry: JournalEntry): boolean;
}
export function applyAction(original: JournalEntry[], input: JournalAction, ctx: EngineContext) {
  const values = ctx.limits ?? DEFAULT_SETTINGS.limits;
  const notices = new Set<string>(), limit = new IntakeLimits(values, notices);
  const evidence = z.array(evidenceSchema.extend({ detail: limit.prose(evidenceSchema.shape.detail.unwrap()).default("") }));
  const note = limit.journalNote(z.string());
  const description = limit.prose(actionSchema.shape.description.unwrap());
  const action = actionSchema.extend({ reason: limit.prose(actionSchema.shape.reason.unwrap()).optional(),
    description: description.optional(), descriptions: z.array(description).min(1).optional(),
    evidence: evidence.optional(), links: evidence.optional(), note: note.nullable().optional(),
  }).parse(input);
  const combineEvidence = (saved: JournalEntry["evidence"], incoming: JournalEntry["evidence"]) =>
    [...new Map([...saved, ...incoming].map(item => [JSON.stringify(item), item])).values()];
  const actor = actorSchema.parse(ctx.actor);
  let entries = copy(original);
  const find = (id: string | undefined) => {
    if (!id) throw new Error("An entry id is required. Use the short id in brackets, not its position.");
    const entry = entries.find(e => e.id === id);
    if (!entry) throw new Error(`Entry [${id}] was not found. Use list to see current ids.`);
    return entry;
  };
  const ids = [...new Set(action.ids ?? (action.id ? [action.id] : []))];
  const selected = () => { if (!ids.length) throw new Error("Provide id or ids."); return ids.map(find); };
  const touch = (e: JournalEntry) => { e.updatedAt = ctx.now; e.updatedBy = actor; };
  const setStatus = (e: JournalEntry, status: EntryStatus): void => {
    requireMutable(e);
    if (e.status === status) return;
    requireReopen(e, actor, ctx.roleOf);
    if (closed(e) && !closed({ status }) && e.parentId) {
      const parent = find(e.parentId);
      if (closed(parent)) setStatus(parent, "todo");
    }
    const wasClosed = closed(e);
    e.status = status;
    e.report = null; e.rewrites = 0;
    if (!closed(e)) {
      e.doneAt = null; e.doneBy = null;
      if (e.review?.kind) e.review = null;
    }
    else if (!wasClosed) { e.doneAt = ctx.now; e.doneBy = actor; }
    touch(e);
  };
  const add = (description: string, parentId: string | null) => {
    const entry = journalEntrySchema.parse({ threadId: ctx.threadId, id: ctx.allocate(), parentId, description, status: "todo",
      owner: action.owner ?? null, note: null, evidence: [], link: null, order: entries.length, createdAt: ctx.now, updatedAt: ctx.now, createdBy: actor, updatedBy: actor });
    entries.push(entry); return entry.id;
  };
  if (action.action !== "clear" && action.action !== "add") for (const id of ids) requireMutable(find(id));
  let resultIds: string[] = ids;
  switch (action.action) {
    case "add": case "split": case "add_step": {
      const descriptions = action.descriptions ?? (action.action === "add" && action.description ? [action.description] : []);
      if (!descriptions.length) throw new Error("Provide one or more descriptions.");
      let parentId: string | null = null;
      if (action.action !== "add") {
        const parent = find(action.id);
        if (parent.parentId !== null) throw new Error("A step cannot have steps. Split its top-level parent instead.");
        if (closed(parent)) throw new Error("Reopen the parent before adding steps.");
        parentId = parent.id;
      }
      if (entries.length + descriptions.length > values.journal.entriesMax)
        throw new Error(`Clear completed journal work first. ${limitMessage("limits.journal.entriesMax", values.journal.entriesMax)}`);
      resultIds = descriptions.map(d => add(d, parentId));
      break;
    }
    case "toggle": case "done": case "reopen": case "start": case "block": case "verify": case "reject": {
      const targets = selected();
      if (action.action === "start" && targets.length > 1 && (!action.owner?.trim() || action.owner === ctx.threadId)) {
        throw new Error("Start one entry per call. To run several at once, give each an owner, the thread id of whoever does it.");
      }
      if (action.owner !== undefined && action.action !== "start") throw new Error("owner only goes with add, split, add_step, start or update.");
      for (const e of targets) {
        if (action.action === "start" && action.owner !== undefined && e.owner !== action.owner) { e.owner = action.owner; touch(e); }
        if (action.action === "verify" || action.action === "reject") {
          requireWarden(e, actor, ctx.roleOf);
          if (e.status !== "done") throw new Error("Only reported done entries awaiting review can receive a Warden verdict.");
          if (!e.evidence.length) throw new Error("The maker's submission needs evidence before it can be checked.");
        }
        if ((action.action === "block" || action.action === "reject") && !action.reason) throw new Error("A reason is required.");
        const status: EntryStatus = action.action === "toggle" ? closed(e) ? "todo" : "done" :
          action.action === "done" ? "done" : action.action === "reject" ? "rejected" : action.action === "reopen" ? "todo" :
          action.action === "start" ? "doing" : action.action === "block" ? "blocked" : "verified";
        if (status === "doing" && e.after.some(id => !closed(find(id)))) throw new Error("Finish this entry's dependencies before starting it.");
        if (action.evidence !== undefined && action.action !== "verify" && action.action !== "reject") {
          const evidence = combineEvidence(e.evidence, action.evidence);
          if (JSON.stringify(e.evidence) !== JSON.stringify(evidence)) {
            if (e.link && e.status === "verified") requireReopen(e, actor, ctx.roleOf);
            if (e.review?.kind === "keeper") e.review = null;
            e.evidence = evidence; touch(e);
          }
          if (!e.review?.kind && e.review?.reason && action.evidence.length) { e.review.memberEvidenceAt = ctx.now; touch(e); }
        }
        if (status === "done" && !e.review?.kind && e.review?.reason && e.review.memberEvidenceAt === null) throw new Error("This entry was rejected. Submit evidence from work checked after that rejection before reporting done again.");
        if (status === "done" && e.link && !e.evidence.length) throw new Error("A linked entry needs at least one evidence item before it is reported done.");
        const earlier = e.rebrief?.evidence.map(x => JSON.stringify(x)) ?? [];
        if (status === "done" && e.rebrief && e.evidence.length && e.evidence.every(x => earlier.includes(JSON.stringify(x))))
          throw new Error(`Attach evidence from work checked against brief v${e.rebrief.version}; these items are from ${e.rebrief.version === 2 ? "v1" : "earlier briefs"}.`);
        if (status === "verified" && !action.evidence?.length) throw new Error("Verification needs the Warden's own evidence.");
        if (status === "doing" && !delegated(e)) for (const other of entries) if (other.id !== e.id && other.status === "doing" && !delegated(other)) setStatus(other, "todo");
        if (action.action === "verify" || action.action === "reject") {
          e.review = { actor, at: ctx.now, evidence: action.evidence ?? [], reason: action.reason ?? null, previousNote: e.note, memberEvidenceAt: null }; touch(e);
        }
        if (action.reason !== undefined && !e.note?.includes(action.reason)) {
          e.note = action.action === "reject" && e.note ? note.parse(`Rejected: ${action.reason}\nPrevious note: ${e.note}`)
            : e.note ? appendNote(e.note, noteLine(ctx.now, `${action.action === "block" ? "Blocked" : "Reason"}: ${action.reason}`), values, notices) : note.parse(action.reason);
          touch(e);
        }
        if (!(e.status === "verified" && status === "done")) setStatus(e, status);
        if (e.report && action.action !== "verify" && action.action !== "reject") { e.report = null; touch(e); }
      }
      break;
    }
    case "settle": case "wait": {
      for (const e of selected()) {
        if (action.action === "wait") { if (e.report) { e.report = null; touch(e); } continue; }
        if (closed(e)) throw new Error(`[${e.id}] is already closed; reopen it before settling it again.`);
        if (action.evidence?.length) {
          e.evidence = combineEvidence(e.evidence, action.evidence);
        }
        e.report = { kind: "settled", at: ctx.now, threadId: e.owner, summary: action.reason ? clip(action.reason, 300) : null, by: actor };
        touch(e);
      }
      break;
    }
    case "update": {
      const e = find(action.id);
      if (action.description === undefined && action.owner === undefined && action.after === undefined && action.links === undefined) throw new Error("Provide description, owner, after or links to update.");
      if (action.description !== undefined && action.description !== e.description) { e.description = action.description; e.rewrites = (e.rewrites ?? 0) + 1; }
      if (action.owner !== undefined) e.owner = action.owner;
      if (action.after !== undefined) e.after = [...new Set(action.after)];
      if (action.links !== undefined) e.links = action.links;
      if (e.status === "verified") setStatus(e, "todo");
      if (e.review?.kind) e.review = null;
      touch(e); break;
    }
    case "note": {
      const e = find(action.id);
      if (action.note === undefined) throw new Error("Provide note (or null to clear it).");
      // Notes are a running log: each call adds a timed line. mode "replace" rewrites the whole note, as the UI's editor does.
      e.note = action.note === null || action.mode === "replace" ? action.note : appendNote(e.note, noteLine(ctx.now, action.note), values, notices);
      touch(e); break;
    }
    case "link": {
      const e = find(action.id);
      if (action.link === undefined) throw new Error("Provide link, or null to unlink.");
      if (!canManageLinks(actor, ctx.roleOf)) {
        if (e.link || !action.link) throw new Error("Only a Keeper or Tavern can change an existing waypoint link.");
        if (actor.kind !== "agent" || actor.threadId !== e.threadId || (e.owner !== null && e.owner !== actor.threadId) ||
            !ctx.roleOf(actor.threadId)?.canLinkWaypoint?.(action.link))
          throw new Error("Link your own entry to a waypoint in your active quest assignment.");
      }
      e.link = action.link;
      if (e.review?.kind) e.review = null;
      if (closed(e) && (e.status === "verified" || (e.link && !e.evidence.length))) setStatus(e, "todo");
      touch(e); break;
    }
    case "delete": {
      const targets = selected();
      for (const parent of targets) if (entries.some(e => e.parentId === parent.id && !closed(e) && !ids.includes(e.id))) throw new Error("This parent has open steps. Include all open steps in ids, or finish them first.");
      const removed = new Set(entries.filter(e => ids.includes(e.id) || (e.parentId !== null && ids.includes(e.parentId))).map(e => e.id));
      for (const e of entries) if (removed.has(e.id)) requireMutable(e);
      if (!canManageLinks(actor, ctx.roleOf) && entries.some(e => removed.has(e.id) && e.link)) throw new Error("Only the Keeper or Tavern can delete linked waypoints, in any status.");
      entries = entries.filter(e => !removed.has(e.id));
      for (const e of entries) {
        const after = e.after.filter(id => !removed.has(id));
        if (after.length !== e.after.length) { e.after = after; touch(e); }
      }
      resultIds = [...removed]; break;
    }
    case "clear": {
      // A stopped quest's mirror is blocked, not done, yet it is finished business: clear removes it without counting it done.
      const finished = (e: JournalEntry) => !!e.boardQuestId && (ctx.finishedMirror?.(e) ?? false);
      const protectedIds = new Set(entries.filter(e => (e.boardQuestId && !closed(e) && !finished(e)) || (e.link && !canManageLinks(actor, ctx.roleOf))).flatMap(e => [e.id, ...(e.parentId ? [e.parentId] : [])]));
      resultIds = entries.filter(e => !protectedIds.has(e.id) && (action.all || closed(e) || finished(e))).map(e => e.id);
      entries = entries.filter(e => !resultIds.includes(e.id));
      for (const e of entries) {
        const after = e.after.filter(id => !resultIds.includes(id));
        if (after.length !== e.after.length) { e.after = after; touch(e); }
      }
      break;
    }
    case "reorder": {
      const e = find(action.id), target = action.targetId == null ? null : find(action.targetId);
      if (target && e.parentId !== target.parentId) throw new Error("Reorder among siblings. Use reparent to change levels.");
      if (target?.id === e.id) break;
      const siblings = entries.filter(x => x.parentId === e.parentId).sort((a, b) => a.order - b.order).filter(x => x.id !== e.id);
      siblings.splice(target ? siblings.indexOf(target) : siblings.length, 0, e);
      siblings.forEach((x, i) => { x.order = i; touch(x); }); break;
    }
    case "reparent": {
      const e = find(action.id), parent = action.parentId == null ? null : find(action.parentId);
      if (parent && (parent.id === e.id || parent.parentId !== null || closed(parent))) throw new Error("Choose an open top-level parent.");
      if (parent && entries.some(x => x.parentId === e.id)) throw new Error("An entry with steps cannot become a step.");
      if (parent) requireMutable(parent);
      e.parentId = parent?.id ?? null; e.order = Math.max(-1, ...entries.filter(x => x.parentId === e.parentId).map(x => x.order)) + 1; touch(e); break;
    }
    default: throw new Error(`Action ${action.action} is handled by the store, not the mutation engine.`);
  }
  entries = validateEntries(entries);
  const changedIds = new Set(resultIds);
  for (const e of [...original, ...entries]) if (JSON.stringify(original.find(x => x.id === e.id)) !== JSON.stringify(entries.find(x => x.id === e.id))) changedIds.add(e.id);
  const changed = JSON.stringify(ordered(original)) !== JSON.stringify(entries);
  const detail = action.reason !== undefined ? ` Reason: ${JSON.stringify(action.reason)}.` : action.action === "note" ? ` Note: ${JSON.stringify(action.note)}.` : action.action === "link" ? ` Link: ${JSON.stringify(action.link)}.` : "";
  const reworded = action.action === "update" ? entries.find(e => e.id === action.id && (e.rewrites ?? 0) >= 3) : undefined;
  const hint = reworded ? ` Hint: [${reworded.id}] has been reworded ${reworded.rewrites} times without a status change. Put progress in a note, close it, or split it.` : "";
  const text = clip(`${changeSummary(action.action, [...changedIds], original, entries)}${detail}`, 1000) + hint;
  return { entries, entryIds: [...changedIds], createdIds: resultIds, changed, text, notices: [...notices] };
}
