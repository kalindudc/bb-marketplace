import { memberIdentityLabel, memberKeeperIds } from "../../shared/identity";
import { engagementSchema, hasEndedEngagement, memberActivityWord } from "../../shared/member-engagement";
import { moveTime } from "../../shared/time";
import { resolutionWords, settled, verifiedWaypoint } from "../../shared/waypoint";
import { attentionView } from "../../shared/attention";
import type { BoardQuestSummary, MapHistory, Room } from "../../shared/contract";
import { checkerHandoffHoldSchema, type Ask, type Member, type Phase, type Report, type TavernEvent } from "../../shared/schema";
import { extractReportHeadline, type ReportHeadlineNames } from "../../shared/report-headline";
import { memberName } from "../../shared/member-name";
import type { AwayStatus } from "../../shared/away";
import { hearthWords } from "../kit/hearth";
export { isFinished, PHASE_STEPS, phaseIndex, phaseWord, pathProgress, questMove, keeperStatus, endedCounts, type MoveTone, type KeeperStatus } from "../kit";
import { heldQuests, isFinished, keeperStatus, phaseWord, pathProgress, releaseWords, type MoveTone } from "../kit";

export type PageRoute = { kind: "room" | "map" | "characters" | "classes" | "closing" | "digest" | "returned" | "archive" | "insights" | "missing" } | { kind: "quest" | "tale" | "character" | "class"; id: string; summaryId?: string } | { kind: "machines"; rule?: string; hire?: string };
export function decodePageRoute(subPath: string): PageRoute {
  let parts: string[];
  try { parts = subPath.split("/").map(decodeURIComponent); } catch { return { kind: "missing" }; }
  if (parts.length === 1) {
    const kind = parts[0] === "" ? "room" : parts[0];
    if (kind === "room" || kind === "map" || kind === "characters" || kind === "classes" || kind === "closing" || kind === "digest" || kind === "returned" || kind === "archive" || kind === "insights") return { kind };
  }
  if (parts[0] === "machines" && parts.length <= 3 && parts.slice(1).every(Boolean)) return { kind: "machines", ...(parts[1] ? { rule: parts[1] } : {}), ...(parts[2] ? { hire: parts[2] } : {}) };
  if (parts.length === 4 && parts[0] === "quest" && parts[1] && parts[2] === "summary" && parts[3]) return { kind: "quest", id: parts[1], summaryId: parts[3] };
  if (parts.length === 2 && parts[1]) {
    const kind = parts[0];
    if (kind === "quest" || kind === "tale" || kind === "character" || kind === "class") return { kind, id: parts[1] };
  }
  return { kind: "missing" };
}
/**
 * Whether a remembered route can be reopened: "wait" until the data that decides it has loaded,
 * "stale" for a route that no longer exists (a quest in the cellar or deleted, a removed sheet or class).
 */
export function restoreVerdict(path: string, room: Room | undefined, registry: { characters: { id: string }[]; classes: { id: string }[] } | undefined): "ok" | "wait" | "stale" {
  const route = decodePageRoute(path);
  if (route.kind === "missing") return "stale";
  if (route.kind === "quest" || route.kind === "tale") { if (!room) return "wait"; const quest = questsIn(room).find((q) => q.id === route.id); return quest && !quest.archivedAt ? "ok" : "stale"; }
  if (route.kind === "character") return registry ? registry.characters.some((c) => c.id === route.id) ? "ok" : "stale" : "wait";
  if (route.kind === "class") return registry ? registry.classes.some((c) => c.id === route.id) ? "ok" : "stale" : "wait";
  return "ok";
}
export function levelFromWins(wins: number): number {
  return 1 + Math.floor(wins / 8);
}
/** Wins into the current level, out of the eight a level takes. */
export const winsToNext = (wins: number) => ({ into: wins % 8, of: 8 });
export const questsIn = (room: Room) => room.keepers.flatMap((k) => k.boardQuests);
export function boardQuestState(keeper: Room["keepers"][number], quest: BoardQuestSummary) {
  if (quest.archivedAt != null || quest.deletedAt != null) return "off-board";
  if (isFinished(quest.phase)) return "finished";
  return keeper.archived ? "needs-keeper" : "active";
}
export const activeQuests = (room: Room) => room.keepers.flatMap(k => k.boardQuests.filter(q => boardQuestState(k, q) === "active"));
export const workingQuests = (room: Room) => activeQuests(room).filter((q) => q.phase !== "stopping");
/** A stop keeps running even if the Keeper is no longer present. */
export const stoppingQuests = (room: Room) => questsIn(room).filter(q => q.phase === "stopping" && q.archivedAt == null && q.deletedAt == null);
export const returnedQuests = (room: Room) => questsIn(room).filter((q) => q.phase === "done").sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt));
export function visibleMembers(room: Room): Member[] {
  return [...new Map([...room.keepers.flatMap((k) => [k.member, ...k.boardQuests.flatMap((q) => q.members), ...k.errands]), ...room.solos].map((m) => [m.threadId, m])).values()];
}
export function waypointMove(waypoint: BoardQuestSummary["waypoints"][number]): string {
  if (settled(waypoint)) return "Done";
  if (waypoint.state === "reported") return "Ready for review";
  if (waypoint.actor === "user") return "Your next moves";
  if (waypoint.actor === "outside") return "Waiting on others";
  if (waypoint.state === "blocked" || waypoint.state === "rejected") return "Blocked";
  return "Working";
}
export const openAskCount = (room: Room) => room.asks.filter((ask) => ask.state === "open").length;




// ---------- Events: what happened, in words for people ----------

export type EventIcon = "steer" | "question" | "aside" | "quest" | "plan" | "ask" | "answer" | "decided" | "undo" | "rule" | "report" | "hire" | "told" | "stale" | "failed" | "anchor" | "stop" | "skip" | "wrap" | "phase" | "tick" | "note";
export type EventLine = { repeats?: number; memberKeeperIds?: string[]; id: number; at: number; icon: EventIcon; tone: "plain" | "steer" | "you" | "bad" | "warn" | "done"; actorLabel?: string; actor: { kind: "you" } | { kind: "member"; member: Member } | { kind: "keeper"; member: Member } | { kind: "tavern" } | { kind: "unknown" }; head: string; detail: string | null; questId: string | null; filter: "steers" | "decided" | "reports" | "asks" | "other"; note?: string; fold?: { key: string; names: string[]; verb: string } };
type EventContext = { members: Map<string, Member>; characterName: (characterId: string) => string | null; memberName: (member: Member) => string; questShort: (id: string) => string | null; decisions: Map<string, string>; waypoints?: (questId: string) => ReadonlyMap<string, string> };

/** Agent-facing bookkeeping that says nothing a person needs: raw user text (the route says what it meant), tool chatter and nudges. */
const HIDDEN = new Set(["user.message", "journal.changed", "questlog.changed", "rules.changed", "route.missed.raw"]);
const prefixed = (text: string, prefix: string) => text.startsWith(prefix) ? text.slice(prefix.length) : text;

/** The names a page knows: its registry's characters and classes. */
export type KnownNames = Parameters<typeof memberName>[1];
export function eventContext(room: Room, names: KnownNames, qualify = memberKeeperIds(room.keepers.filter(k => !k.archived).flatMap(k => [...k.errands, ...k.boardQuests.filter(q => !q.archivedAt).flatMap(q => q.members)])).size > 1): EventContext {
  const keepers = new Map(room.keepers.map(k => [k.member.threadId, k.member]));
  return {
    members: new Map(visibleMembers(room).map((m) => [m.threadId, m])),
    characterName: (id) => names.characters.find((c) => c.id === id)?.name ?? null,
    memberName: (m) => memberIdentityLabel(m, names, qualify && m.keeperThreadId ? keepers.get(m.keeperThreadId) : undefined),
    questShort: (id) => questsIn(room).find((q) => q.id === id)?.short ?? null,
    decisions: new Map(room.decidedForYou.map((d) => [d.id, d.text])),
    waypoints: (id) => new Map(questsIn(room).find((q) => q.id === id)?.waypoints.map((w) => [w.id, w.title]) ?? []),
  };
}

const HAS_ID = /(?<![\w-])(?:thr_[\w-]+|quest_[\w-]+|w\d+)(?![\w-])/i;
/** An event's detail with every id named from what the page knows (Ted's shared helper), or null when one has no name, so the head stands alone. Text without ids keeps its full length. */
export function namedDetail(detail: string | null, questId: string | null, ctx: EventContext): string | null {
  if (!detail || !HAS_ID.test(detail)) return detail;
  const threadNames = new Map([...detail.matchAll(/(?<![\w-])thr_[\w-]+(?![\w-])/g)].flatMap(([id]) => {
    const member = ctx.members.get(id);
    return member ? [[id, ctx.memberName(member)] as const] : [];
  }));
  const questNames = new Map([...detail.matchAll(/quest_[\w-]+/g)].flatMap(([id]) => { const short = ctx.questShort(id); return short ? [[id, short] as const] : []; }));
  return extractReportHeadline({ outcome: detail }, { threadNames, questNames, waypointTitles: questId && ctx.waypoints ? ctx.waypoints(questId) : undefined });
}

/** One event as a line a person reads: who, what happened, and a detail with its ids named (or dropped). */
/** Quests in the room whose checker-handoff hold waits on the user: the kit's rule (heldQuests) over the room's quests. */
export const heldForYou = (room: Room) => heldQuests(activeQuests(room), room.asks);
/** What waits on the user in the common room: open asks and checker-handoff holds to release. */
export const needYouCount = (room: Pick<Room, "attention">) => attentionView(room.attention).needYou;
/** bb's Tavern badge label: the nouns follow their own counts, the verb follows the total. */
export function badgeLabel(asks: number, holds: number) {
  const parts = [asks ? `${asks} open Tavern ${asks === 1 ? "ask" : "asks"}` : null, holds ? `${holds} checker ${holds === 1 ? "handoff" : "handoffs"} to release` : null].filter(Boolean).join(" and ");
  const one = asks + holds === 1;
  return holds ? `${parts} ${one ? "needs" : "need"} you` : `${parts} ${one ? "needs" : "need"} your answer`;
}

/** A release path the server can write; anything else in an old event is left unworded rather than guessed. */
const releaseVia = checkerHandoffHoldSchema.shape.release.unwrap().shape.via;

export function describeEvent(e: TavernEvent, ctx: EventContext, trackParties = false): EventLine | null {
  const ids = new Set<string>();
  const naming = trackParties ? { ...ctx, memberName(member: Member) {
    if (member.role === "member" && member.keeperThreadId) ids.add(member.keeperThreadId);
    return ctx.memberName(member);
  } } : ctx;
  const line = describeRaw(e, naming);
  if (!line) return null;
  const actorLabel = line.actor.kind === "member" || line.actor.kind === "keeper" ? naming.memberName(line.actor.member) : undefined;
  const detail = namedDetail(line.detail, e.boardQuestId, naming);
  return { ...line, actorLabel, detail, ...(ids.size ? { memberKeeperIds: [...ids] } : {}) };
}

function describeRaw(e: TavernEvent, ctx: EventContext): EventLine | null {
  if (HIDDEN.has(e.type)) return null;
  const data = e.data as Record<string, unknown>;
  const str = (key: string) => typeof data[key] === "string" ? data[key] as string : null;
  const agent = e.actor.kind === "agent" ? ctx.members.get(e.actor.threadId) ?? null : null;
  const keeper = e.keeperThreadId ? ctx.members.get(e.keeperThreadId) ?? null : null;
  const lead = agent ?? keeper;
  const leadActor = lead ? { kind: lead.role === "keeper" ? "keeper" as const : "member" as const, member: lead } : { kind: "tavern" as const };
  const you = { kind: "you" as const };
  const base = { id: e.id, at: e.at, questId: e.boardQuestId, detail: null as string | null, tone: "plain" as EventLine["tone"], filter: "other" as EventLine["filter"] };
  const named = (characterId: string) => ctx.characterName(characterId) ?? characterId;
  const byCharacter = (text: string) => { const m = text.match(/^([a-z0-9_-]+): ([\s\S]*)$/); return m && ctx.characterName(m[1]!) ? { name: ctx.characterName(m[1]!)!, characterId: m[1]!, rest: m[2]! } : null; };
  const memberByCharacter = (characterId: string) => [...ctx.members.values()].find((m) => m.characterId === characterId && (!e.keeperThreadId || m.keeperThreadId === e.keeperThreadId || m.threadId === e.keeperThreadId) && (!e.boardQuestId || m.boardQuestId === e.boardQuestId)) ?? null;
  if (["member.bound", "member.rebrief-requested", "member.brief-cancelled", "member.briefed", "member.release-requested", "member.released", "member.stop-requested", "member.stopped", "member.archive-requested", "member.engagement-imported"].includes(e.type)) {
    const states = data.engagement as { from?: unknown; to?: unknown } | undefined;
    const to = engagementSchema.safeParse(states?.to);
    if (to.success) {
      const member = ctx.members.get(str("memberThreadId") ?? "");
      const name = member ? ctx.memberName(member) : "A member";
      const words = { briefing: "waiting for a brief", active: "brief accepted", resting: "finished", releasing: "release requested", released: "released", stopping: "stop requested", stopped: "stopped", archiving: "archive requested", archived: "archived" };
      const word = e.type === "member.bound" && to.data === "active" ? "started solo work" : words[to.data];
      const head = e.type === "member.engagement-imported" ? `${name}: ${word} at upgrade` : `${name}: ${word}`;
      return { ...base, icon: "note", actor: e.actor.kind === "user" ? you : e.actor.kind === "agent" ? leadActor : { kind: "tavern" }, head,
        detail: e.type === "member.release-requested" || e.type === "member.released" ? e.text : null };
    }
  }
  switch (e.type) {
    case "thread.archived": case "thread.unarchived": case "thread.deleted": {
      const verb = e.type.slice(7);
      const subject = str("memberThreadId") ? ctx.members.get(str("memberThreadId")!) ?? null : null;
      const name = subject ? ctx.memberName(subject) : "a member";
      // Credit only what the event records: the user, an agent, or the Keeper that asked for the archive; otherwise nobody.
      const actor = e.actor.kind === "user" ? you : agent ? leadActor : data.keeperArchiveRequested === true && keeper ? { kind: "keeper" as const, member: keeper } : { kind: "unknown" as const };
      const known = actor.kind !== "unknown";
      return { ...base, icon: "note", actor, head: known ? `${verb} ${name}’s thread` : `${name}’s thread ${verb}`, note: known ? undefined : `The host did not say who ${verb} it.`, fold: { key: `${e.type}|${actor.kind === "keeper" || actor.kind === "member" ? actor.member.threadId : actor.kind}|${e.boardQuestId ?? ""}`, names: [name], verb } };
    }
    case "route.recorded": {
      const kind = str("kind");
      if (kind === "steer") return { ...base, icon: "steer", tone: "steer", filter: "steers", actor: you, head: "steered", detail: e.text };
      if (kind === "question") return { ...base, icon: "question", actor: you, head: "asked", detail: e.text };
      if (kind === "aside") return { ...base, icon: "aside", actor: you, head: "dropped an aside · quests untouched", detail: e.text };
      if (kind === "new-quest") return { ...base, icon: "quest", actor: you, head: "pinned a new quest", detail: e.text };
      return { ...base, icon: "note", actor: leadActor, head: "read a message", detail: e.text };
    }
    case "route.corrected": return { ...base, icon: "steer", tone: "steer", filter: "steers", actor: you, head: "re-routed a message" };
    case "route.cancelled": return { ...base, icon: "undo", actor: you, head: "cancelled a queued message" };
    case "route.missed": return { ...base, icon: "note", tone: "warn", actor: leadActor, head: "did not route a message", detail: str("text") };
    case "quest.opened": return { ...base, icon: "quest", actor: leadActor, head: "pinned a quest", detail: (e.boardQuestId && ctx.questShort(e.boardQuestId)) ?? prefixed(e.text, "Opened ") };
    case "plan.proposed": { const v = data.version; return { ...base, icon: "plan", tone: str("routeId") ? "steer" : "plain", filter: str("routeId") ? "steers" : "other", actor: leadActor, head: `drew quest map v${typeof v === "number" ? v : "?"}${str("routeId") ? " from your steer" : ""}` }; }
    case "quest.phase": return { ...base, icon: "phase", actor: leadActor, head: `moved the quest to ${prefixed(e.text, "Board quest moved to ")}` };
    case "ask.opened": if (data.lane === "keeper") return { ...base, icon: "ask", filter: "asks", actor: leadActor, head: `is waiting on ${str("keeperName") ?? "the Keeper"}`, detail: e.text }; return { ...base, icon: "ask", tone: "you", filter: "asks", actor: leadActor, head: "asks you", detail: e.text };
    case "ask.answered": case "ask.defaulted": {
      const preapproval = data.preapproval as { at?: unknown; surface?: unknown } | undefined;
      if (typeof preapproval?.at === "number" && typeof preapproval.surface === "string") return { ...base, icon: "answer", tone: "done", filter: "asks", actor: { kind: "tavern" }, head: `Pre-approved by you at ${moveTime(preapproval.at, Date.now())} (${preapproval.surface.replace("client (unattested)", "client, unattested")})`, detail: e.text };
      if (data.answeredBy === "keeper" && data.keeperAuthority === "keepers.alwaysAsk") return { ...base, icon: "answer", tone: "done", filter: "asks", actor: leadActor, head: `${lead ? "" : `${str("keeperName") ?? "The Keeper"} `}decided under your Always ask setting`, detail: e.text };
      if (data.answeredBy === "keeper" && data.delegation) return { ...base, icon: "answer", tone: "done", filter: "asks", actor: leadActor, head: `${lead ? "" : `${str("keeperName") ?? "The Keeper"} `}decided (delegated by you)`, detail: e.text };
      const option = str("optionId");
      if (e.text.startsWith("Party approved")) return { ...base, icon: "answer", tone: "done", filter: "asks", actor: you, head: "formed the party" };
      const question = option ? prefixed(e.text, e.type === "ask.answered" ? "Answered: " : "Default applied to a reversible choice: ").split(` — ${option}`)[0]! : e.text;
      return { ...base, icon: "answer", tone: "done", filter: "asks", actor: e.type === "ask.answered" ? you : { kind: "tavern" }, head: e.type === "ask.answered" ? "answered" : "applied the default", detail: question };
    }
    case "summary.posted": return { ...base, icon: "note", actor: leadActor, head: str("supersedes") ? "corrected a summary" : "posted a summary", detail: e.text };
    case "decision.made": return { ...base, icon: "decided", filter: "decided", actor: leadActor, head: data.delegation ? `${lead ? "" : `${str("keeperName") ?? "The Keeper"} `}decided (delegated by you)` : data.keeperAuthority === "keepers.alwaysAsk" ? "decided under your Always ask setting" : "decided for you", detail: e.text };
    case "decision.undone": { const id = str("decisionId"); return { ...base, icon: "undo", filter: "decided", actor: you, head: "undid a decision", detail: (id && ctx.decisions.get(id)) ?? prefixed(e.text, "Undo this decision and reconcile its effects: ") }; }
    case "rule.added": return { ...base, icon: "rule", actor: leadActor, head: "added a standing rule", detail: e.text };
    case "rule.confirmed": return { ...base, icon: "rule", actor: you, head: e.text.startsWith("Deactivated") ? "turned a rule off" : "turned a rule on", detail: prefixed(prefixed(e.text, "Activated: "), "Deactivated: ") };
    case "report.filed": {
      const who = byCharacter(e.text);
      const status = str("status");
      const member = who ? memberByCharacter(who.characterId) : null;
      return { ...base, icon: status === "blocked" ? "failed" : "report", tone: status === "blocked" ? "bad" : status === "needs-decision" ? "you" : "done", filter: "reports", actor: member ? { kind: "member", member } : { kind: "tavern" }, head: status === "blocked" ? "is blocked" : status === "needs-decision" ? "needs a decision" : "reported", detail: who?.rest ?? e.text };
    }
    case "member.hired": { const m = str("memberThreadId"); const hired = m ? ctx.members.get(m) : undefined; return { ...base, icon: "hire", actor: leadActor, head: `hired ${hired ? ctx.memberName(hired) : e.text.split(" (")[0]}`, detail: e.text.includes(": ") ? e.text.slice(e.text.indexOf(": ") + 2) : null }; }
    case "member.told": { const m = str("memberThreadId"); const told = m ? ctx.members.get(m) : undefined; return { ...base, icon: "told", actor: leadActor, head: `re-briefed ${told ? ctx.memberName(told) : "a member"}` }; }
    case "user.told-member": { const m = e.text.match(/^You told ([a-z0-9_-]+): ([\s\S]*)$/); return { ...base, icon: "told", tone: "steer", filter: "steers", actor: you, head: `told ${m ? named(m[1]!) : "a member"}`, detail: m ? m[2]! : e.text }; }
    case "member.stale": { const who = byCharacter(e.text); const member = who ? memberByCharacter(who.characterId) : null; return { ...base, icon: "stale", tone: "warn", actor: member ? { kind: "member", member } : { kind: "tavern" }, head: "went quiet", detail: who ? who.rest.replace(/^stale /, "") : e.text }; }
    case "member.failed": { const who = e.text.match(/^([a-z0-9_-]+)'s thread failed/); return { ...base, icon: "failed", tone: "bad", actor: { kind: "tavern" }, head: `reports ${who ? named(who[1]!) : "a member"}'s thread failed` }; }
    case "reanchored": return { ...base, icon: "anchor", actor: leadActor, head: "re-anchored", detail: prefixed(e.text, "Re-anchored ") };
    case "reanchor.requested": return { ...base, icon: "anchor", actor: leadActor, head: "queued a re-anchor", detail: prefixed(e.text, "Re-anchor ") };
    case "checker-handoff.held": return { ...base, icon: "note", tone: "you", actor: leadActor, head: "held the checker handoff for your release", detail: null };
    case "checker-handoff.released": { const via = releaseVia.safeParse(data.via); return { ...base, icon: "answer", actor: you, head: "released the checker handoff", detail: via.success ? releaseWords({ at: e.at, via: via.data, askId: str("askId") }) : null }; }
    case "tavern.cellar-stop-receipt": return { ...base, icon: "stop", actor: you, head: "asked Tavern to stop and cellar quests", detail: Array.isArray(data.entries) ? data.entries.flatMap(entry => typeof entry?.title === "string" ? [entry.title] : []).join("; ") : null };
    case "quest.stopped": return { ...base, icon: "stop", tone: "bad", actor: you, head: "stopped the quest", detail: e.text };
    case "quest.stop-failed": return { ...base, icon: "failed", tone: "bad", actor: { kind: "tavern" }, head: "could not stop a thread", detail: e.text };
    case "waypoint.skipped": return { ...base, icon: "skip", actor: leadActor, head: "skipped a waypoint", detail: prefixed(e.text, "Skipped ").replace(/^w\d+: /, "") };
    case "quest.retold": return { ...base, icon: "wrap", tone: "done", actor: leadActor, head: "retold the tale", detail: e.text };
    case "quest.wrapped": return { ...base, icon: "wrap", tone: "done", actor: leadActor, head: e.data.closure === "closed-early" ? "closed early at your request" : "returned with the loot", detail: e.text };
    case "tick.sent": return { ...base, icon: "tick", actor: { kind: "tavern" }, head: "sent a tick" };
    case "tick.held": return { ...base, icon: "tick", actor: { kind: "tavern" }, head: "held a tick while you typed", detail: e.text };
    default: return { ...base, icon: "note", actor: leadActor, head: e.type.replace(/[._-]/g, " "), detail: e.text };
  }
}

export function eventLines(events: TavernEvent[], ctx: EventContext, { collapseRepeats = false, trackParties = false } = {}) {
  const byKey = new Map<string, EventLine>();
  const lines: EventLine[] = [];
  for (const event of [...events].sort((a, b) => b.at - a.at || b.id - a.id)) {
    const line = describeEvent(event, ctx, trackParties);
    if (!line) continue;
    if (collapseRepeats) {
      const key = JSON.stringify([event.boardQuestId, event.keeperThreadId, event.actor, event.type, event.text, event.data]);
      const same = byKey.get(key);
      if (same) {
        same.repeats = (same.repeats ?? 1) + 1;
        continue;
      }
      byKey.set(key, line);
    }
    lines.push(line);
  }
  return foldRuns(lines);
}

const listNames = (names: string[]) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
/**
 * Lines sorted newest first, with each run of the same foldable event from the same moment (within a minute, by the same actor)
 * as one line: "3 member threads archived: Juno, Lark and Rook". Every name stays; the hover note stays.
 */
export function foldRuns(lines: EventLine[]): EventLine[] {
  const out: EventLine[] = [];
  for (const line of lines) {
    const prev = out.at(-1), run = prev?.fold && line.fold && prev.fold.key === line.fold.key && Math.abs(prev.at - line.at) <= 60_000 ? prev : null;
    if (!run) { out.push(line); continue; }
    const names = [...run.fold!.names, ...line.fold!.names];
    const known = run.actor.kind !== "unknown";
    const ids = [...new Set([...(run.memberKeeperIds ?? []), ...(line.memberKeeperIds ?? [])])];
    out[out.length - 1] = { ...run, ...(ids.length ? { memberKeeperIds: ids } : {}), fold: { ...run.fold!, names }, head: known ? `${run.fold!.verb} ${names.length} member threads: ${listNames(names)}` : `${names.length} member threads ${run.fold!.verb}: ${listNames(names)}` };
  }
  return out;
}

// ---------- The map: who connects to whom ----------

export type MapNode = { id: string; label: string; detail: string; layer: number; subPath?: string; threadId?: string; classId?: string; kind: "keeper" | "quest" | "returned" | "more" | "errand" | "member" | "ask" | "gate" | "outside" | "solo"; quiet?: boolean; loading?: boolean; questId?: string; member?: Member; ask?: Ask; quest?: BoardQuestSummary };
export type MapFilter = { hidden: ReadonlySet<string>; returned: boolean; archived?: boolean; history?: MapHistory; cellar?: readonly BoardQuestSummary[]; only?: string | null };
export const NO_MAP_FILTER: MapFilter = { hidden: new Set(), returned: true };
/** Every quest the map can draw, active first, then returned and stopped ones, newest first: the Quests picker's list. */
export function mapQuests(room: Room) {
  return room.keepers.map((keeper) => {
    const done = keeper.boardQuests.filter(q => boardQuestState(keeper, q) === "finished").sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt));
    return { keeper: keeper.member, active: keeper.boardQuests.filter(q => boardQuestState(keeper, q) === "active"), done };
  });
}
/** The map's nodes and roads. Members are named with the shared member name, so one with no character shows its class, never an id. */
export function graphFor(room: Room, registry: Parameters<typeof memberName>[1], filter: MapFilter = NO_MAP_FILTER): { nodes: MapNode[]; edges: [string, string][] } {
  const name = (m: Member) => memberIdentityLabel(m, registry);
  const nodes = new Map<string, MapNode>();
  const edges: [string, string][] = [];
  const add = (node: MapNode, parent?: string) => { nodes.set(node.id, node); if (parent) edges.push([parent, node.id]); };
  const addFinished = (quest: BoardQuestSummary, parent?: string) => {
    const q = `returned:${quest.id}`;
    add({ id: q, kind: "returned", label: quest.short, detail: phaseWord(quest.phase), layer: 1, subPath: quest.phase === "done" ? `tale/${quest.id}` : `quest/${quest.id}`, questId: quest.id, quest, quiet: true }, parent);
    for (const member of quest.members) add({ id: `member:${quest.id}:${member.threadId}`, kind: "member", label: name(member), detail: memberActivityWord(member, true), classId: member.classId, layer: 2, threadId: member.threadId, questId: quest.id, member, quiet: true }, q);
  };
  const visible = (q: Pick<BoardQuestSummary, "id">) => !filter.hidden.has(q.id) && (!filter.only || q.id === filter.only);
  const cellar = new Map<string, BoardQuestSummary[]>();
  if (filter.returned) for (const q of filter.cellar ?? []) {
    if (!isFinished(q.phase) || q.deletedAt != null || !visible(q)) continue;
    const list = cellar.get(q.keeperThreadId) ?? [];
    list.push(q);
    cellar.set(q.keeperThreadId, list);
  }
  const historyByKeeper = new Map(filter.history?.keepers.map(h => [h.threadId, h]));
  for (const keeper of room.keepers) {
    const id = keeper.member.threadId, k = `keeper:${id}`;
    const finished = filter.returned ? keeper.boardQuests.filter(q => boardQuestState(keeper, q) === "finished" && visible(q)) : [];
    const archived = cellar.get(id) ?? [];
    cellar.delete(id);
    const history = keeper.archived && filter.archived ? historyByKeeper.get(id) : undefined;
    if (keeper.archived && !filter.archived && !finished.length && !archived.length) continue;
    add({ id: k, kind: "keeper", label: name(keeper.member), detail: keeperStatus(keeper).word, classId: keeper.member.classId, layer: 0, threadId: id, member: keeper.member, quiet: keeper.archived, loading: keeper.archived && filter.archived && !filter.history });
    for (const quest of keeper.boardQuests.filter(q => boardQuestState(keeper, q) === "active" && visible(q))) {
      const q = `quest:${quest.id}`;
      add({ id: q, kind: "quest", label: quest.title, detail: `${quest.phase} · ${quest.move.text}`, layer: 1, subPath: `quest/${quest.id}`, questId: quest.id, quest }, k);
      for (const member of quest.members) add({ id: `member:${member.threadId}`, kind: "member", label: name(member), detail: memberActivityWord(member, isFinished(quest.phase)), classId: member.classId, layer: 2, threadId: member.threadId, questId: quest.id, member }, q);
      for (const ask of room.asks.filter((a) => a.boardQuestId === quest.id && a.state === "open")) add({ id: `ask:${ask.id}`, kind: "ask", label: ask.question, detail: `Needs you · ${ask.kind}`, layer: 2, subPath: `quest/${quest.id}`, questId: quest.id, ask }, q);
      for (const waypoint of quest.waypoints.filter((w) => w.actor === "outside")) {
        const preceding = waypoint.dependsOn.map((id) => quest.waypoints.find((w) => w.id === id));
        const member = preceding.length === 1 ? preceding[0]?.ownerMember : null;
        const parent = member && quest.members.some((m) => m.threadId === member.threadId) ? `member:${member.threadId}` : `gate:${quest.id}:${waypoint.id}`;
        if (!member || !quest.members.some((m) => m.threadId === member.threadId)) add({ id: parent, kind: "gate", label: waypoint.title, detail: `Outside gate · ${waypoint.state}`, layer: 2, subPath: `quest/${quest.id}`, questId: quest.id }, q);
        add({ id: `outside:${quest.id}:${waypoint.id}`, kind: "outside", label: waypoint.owner ?? "Outside owner not named", detail: `${waypoint.title} · ${waypoint.leadTime ?? "lead time unknown"}`, layer: 3, subPath: `quest/${quest.id}`, questId: quest.id }, parent);
      }
    }
    const past = history?.quests.filter(q => isFinished(q.phase) && visible(q))
      .map(q => ({ ...q, plan: null, waypoints: [], openAsks: 0, move: { who: "nobody" as const, text: "" } })) ?? [];
    const returned = [...new Map([...past, ...finished, ...archived].map(q => [q.id, q])).values()]
      .sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt));
    for (const quest of returned) addFinished(quest, k);
    const known = new Set([...(history?.quests ?? []), ...returned].map(q => q.id));
    const more = (history?.total ?? 0) - known.size;
    if (more > 0 && !filter.only) add({ id: `more:${id}`, kind: "more", label: `+${more} more`, detail: "Quests in the cellar", layer: 1, subPath: "archive", quiet: true }, k);
    if (keeper.archived) continue;
    for (const member of keeper.errands.filter((m) => !hasEndedEngagement(m))) add({ id: `member:${member.threadId}`, kind: "errand", label: name(member), detail: `Side quest (errand) · ${memberActivityWord(member)}`, classId: member.classId, layer: 1, threadId: member.threadId, member }, k);
    for (const ask of room.asks.filter((a) => a.keeperThreadId === keeper.member.threadId && a.boardQuestId === null && a.state === "open")) add({ id: `ask:${ask.id}`, kind: "ask", label: ask.question, detail: `Needs you · ${ask.kind}`, layer: 2, threadId: keeper.member.threadId, ask }, k);
  }
  for (const quests of cellar.values()) for (const quest of quests) addFinished(quest);
  for (const solo of room.solos) add({ id: `solo:${solo.threadId}`, kind: "solo", label: name(solo), detail: `Solo · ${solo.state}`, classId: solo.classId, layer: 0, threadId: solo.threadId, member: solo });
  return { nodes: [...nodes.values()], edges };
}
export function oneHop(nodes: MapNode[], edges: [string, string][], focus: string | null): Set<string> {
  if (focus === null) return new Set(nodes.map((node) => node.id));
  return new Set([focus, ...edges.flatMap(([a, b]) => a === focus ? [b] : b === focus ? [a] : [])]);
}

export type PictureNode = { id: string; col: number; row: number; kind: "keeper" | "quest" | "returned" | "more" | "errand" | "member" | "you" | "blocked" | "gate" | "outside" | "solo"; node?: MapNode; label: string; sub: string; asks?: Ask[]; folded?: number; questId?: string; hot: boolean; quiet?: boolean };
/**
 * The picture: Keepers, their quests and side quests, then the focused quest's party, asks and gates, then who they wait on.
 * Other quests fold their party into a count but keep your asks. Laid out leaf by leaf, so no two edges cross.
 */
export function mapPicture(graph: ReturnType<typeof graphFor>, focusQuestId: string | null) {
  const children = new Map<string, string[]>();
  for (const [a, b] of graph.edges) children.set(a, [...(children.get(a) ?? []), b]);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes: PictureNode[] = [];
  const edges: { from: string; to: string; hot: boolean; dashed: boolean; quiet?: boolean }[] = [];
  let row = 0;
  const place = (p: Omit<PictureNode, "row">, kids: (() => string[])[]): number => {
    const ids = kids.map((k) => k()).flat();
    const rows = ids.map((id) => nodes.find((n) => n.id === id)!.row);
    const at = rows.length ? (rows[0]! + rows[rows.length - 1]!) / 2 : row++;
    nodes.push({ ...p, row: at });
    for (const id of ids) { const to = nodes.find((n) => n.id === id)!; edges.push({ from: p.id, to: id, hot: p.hot && to.hot, dashed: p.kind === "errand" || to.kind === "errand", quiet: p.quiet || to.quiet || to.kind === "returned" }); }
    return at;
  };
  const leafOrSubtree = (id: string, hot: boolean): string[] => {
    const n = byId.get(id)!;
    const kids = (children.get(id) ?? []).filter((c) => byId.get(c)!.kind === "outside");
    const kind = n.kind === "gate" ? "gate" : n.kind === "outside" ? "outside" : "member";
    place({ id, col: n.layer, kind, node: n, label: n.label, sub: n.detail, questId: n.questId, hot, quiet: n.quiet }, kids.map((k) => () => { place({ id: k, col: 3, kind: "outside", node: byId.get(k)!, label: byId.get(k)!.label, sub: byId.get(k)!.detail, questId: n.questId, hot }, []); return [k]; }));
    return [id];
  };
  const asksNode = (parentId: string, asks: Ask[], hot: boolean, questId?: string): string[] => {
    if (!asks.length) return [];
    const blocked = asks.filter((a) => a.kind === "blocker");
    const plain = asks.filter((a) => a.kind !== "blocker");
    const out: string[] = [];
    if (plain.length) { const id = `you:${parentId}`; place({ id, col: 2, kind: "you", label: `You · ${plain.length === 1 ? plain[0]!.kind === "greenlight" ? "seal" : "1 ask" : `${plain.length} asks`}`, sub: plain[0]!.question, asks: plain, questId, hot }, []); out.push(id); }
    if (blocked.length) { const id = `blocked:${parentId}`; place({ id, col: 2, kind: "blocked", label: "You · blocked", sub: blocked[0]!.question, asks: blocked, questId, hot }, []); out.push(id); }
    return out;
  };
  const placeFinished = (r: MapNode) => {
    place({ id: r.id, col: 1, kind: r.kind === "more" ? "more" : "returned", node: r, label: r.label, sub: r.detail, questId: r.questId, hot: false, quiet: true },
      (children.get(r.id) ?? []).map(id => () => leafOrSubtree(id, false)));
    return [r.id];
  };
  for (const keeper of graph.nodes.filter((n) => n.kind === "keeper")) {
    const kids = children.get(keeper.id) ?? [];
    const quests = kids.map((id) => byId.get(id)!).filter((n) => n.kind === "quest");
    const errands = kids.map((id) => byId.get(id)!).filter((n) => n.kind === "errand");
    const wideAsks = kids.map((id) => byId.get(id)!).filter((n) => n.kind === "ask").map((n) => n.ask!);
    const keeperHot = quests.some((q) => q.questId === focusQuestId);
    place({ id: keeper.id, col: 0, kind: "keeper", node: keeper, label: keeper.label, sub: keeper.detail, hot: keeperHot, quiet: keeper.quiet }, [
      ...quests.map((q) => () => {
        const focused = q.questId === focusQuestId;
        const qKids = (children.get(q.id) ?? []).map((id) => byId.get(id)!);
        const asks = qKids.filter((n) => n.kind === "ask").map((n) => n.ask!);
        const party = qKids.filter((n) => n.kind === "member" || n.kind === "gate");
        place({ id: q.id, col: 1, kind: "quest", node: q, label: q.quest!.short, sub: q.detail, questId: q.questId, hot: focused, folded: focused ? 0 : qKids.filter((n) => n.kind === "member").length }, focused
          ? [...party.map((m) => () => leafOrSubtree(m.id, true)), () => asksNode(q.id, asks, true, q.questId)]
          : [() => asksNode(q.id, asks, false, q.questId)]);
        return [q.id];
      }),
      ...errands.map((e) => () => { place({ id: e.id, col: 1, kind: "errand", node: e, label: e.label, sub: e.detail, hot: false }, []); return [e.id]; }),
      ...kids.map(id => byId.get(id)!).filter(n => n.kind === "returned" || n.kind === "more").map(r => () => placeFinished(r)),
      () => asksNode(keeper.id, wideAsks, false),
    ]);
    row += 0.35;
  }
  const linked = new Set(graph.edges.map(([, to]) => to));
  for (const n of graph.nodes) if (n.kind === "returned" && !linked.has(n.id)) placeFinished(n);
  const solos = graph.nodes.filter((n) => n.kind === "solo");
  if (solos.length && row > 0) row += 0.25;
  for (const solo of solos) place({ id: solo.id, col: 0, kind: "solo", node: solo, label: solo.label, sub: solo.detail, hot: false }, []);
  return { nodes, edges, rows: Math.ceil(row) };
}

// A report that leads with its verdict ("VERIFIED w1.", "Entry 02 verified.") repeats what the role line already says.
/** A member's answer in one line: its own headline, else the first clean sentence of its outcome, with every id named; null when an id has no name. */
export function taleHeadline(report: { headline?: string | null; outcome: string }, names?: ReportHeadlineNames): string | null {
  return extractReportHeadline(report, names);
}

export { inlineCode, reportBlocks, type ReportBlock } from "../kit";
/** "Nothing", "None" or blank: the Keeper left nothing for the user. */
export const leftNothing = (left: string | null | undefined) => !left || /^\s*(?:nothing|none)\.?\s*$/i.test(left);
/** The quest map's aside: a ready estimate only while the quest is active, never "≈ ~"; a finished map says it is the map as the quest ended. */
export function mapAside(quest: Pick<BoardQuestSummary, "phase" | "plan">): string {
  if (quest.phase === "held") return "held by you";
  if (quest.phase === "done") return "as it returned";
  if (quest.phase === "stopped") return "as it was when stopped";
  const eta = quest.plan?.eta?.replace(/^\s*(?:~|≈|about|approximately|around|roughly)\s*/i, "").trim();
  if (eta) return `ready ≈ ${eta}`;
  return quest.plan ? "columns are order, not a promised time" : "drawn when the Rangers are back";
}
/** A move line beside its phase mark, without the phase word it would repeat ("Returned" beside "Returned"); null when nothing is left. */
export function moveAfterPhase(phase: Phase, text: string): string | null {
  const word = phaseWord(phase).toLowerCase();
  const t = text.trim();
  if (!t.toLowerCase().startsWith(word)) return t || null;
  const rest = t.slice(word.length).replace(/^[\s·:,.—-]+/, "").trim();
  return rest || null;
}

/** A span in words for status lines: "13 min", "2 h 5 min", "3 days 4 h". */
export function durationWords(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"}${h % 24 ? ` ${h % 24} h` : ""}`;
}

type StoryDetail = { quest: Pick<BoardQuestSummary, "id" | "waypoints"> & { members?: readonly Pick<Member, "threadId" | "checkerWaypointId">[]; stopReason?: string | null }; reports: readonly Report[]; asks: readonly Pick<Ask, "boardQuestId" | "state" | "withdrawnCause">[]; events: readonly Pick<TavernEvent, "type" | "actor" | "data" | "boardQuestId">[]; memberCredits?: readonly { memberThreadId: string; madeWaypointIds: string[]; verifiedWaypointIds: string[] }[] };
export type StoryNames = { name(threadId: string): string | null; headline(report: Report): string | null };

/** Who stopped the quest, from its quest.stopped event: "you", an agent's name, or null when unknown. */
export function stopperOf(events: StoryDetail["events"], questId: string, names: Pick<StoryNames, "name">): string | null {
  const stop = [...events].reverse().find((e) => e.type === "quest.stopping" && (e.boardQuestId === null || e.boardQuestId === questId));
  if (!stop) return null;
  if (stop.actor.kind === "user") return "you";
  if (stop.actor.kind === "agent") return names.name(stop.actor.threadId);
  return null;
}

const LEFT_WORD: Record<string, string> = { planned: "not started", todo: "not started", doing: "in progress", blocked: "blocked", reported: "reported, not verified", rejected: "rejected", skipped: "skipped" };
const sentence = (text: string) => { const t = text.trim().replace(/\s+/g, " "); return /[.!?…]$/.test(t) ? t : `${t}.`; };
const quoted = (title: string) => `“${title}”`;

/**
 * A stopped quest's story, one sentence per line, from the data alone: the reason if one was recorded, what was finished (each
 * verified waypoint, or, when none was, what was made but not verified), what was left with its last report's headline, and how
 * many asks were withdrawn. Who stopped it and when belong to the header, not here.
 */
export function stoppedStory(detail: StoryDetail, names: StoryNames): string[] {
  const { quest, reports } = detail;
  const credits = detail.memberCredits ?? [];
  const lines: string[] = [];
  const stop = [...detail.events].reverse().find((e) => e.type === "quest.stopped" && (e.boardQuestId === null || e.boardQuestId === quest.id));
  const reason = quest.stopReason?.trim() || (typeof stop?.data.reason === "string" ? stop.data.reason.trim() : "");
  if (reason) lines.push(sentence(`The reason given: ${reason}`));
  const maker = (w: StoryDetail["quest"]["waypoints"][number]) => { const id = credits.find((c) => c.madeWaypointIds.includes(w.id))?.memberThreadId ?? w.ownerMember?.threadId; return id ? names.name(id) : null; };
  const verifier = (w: StoryDetail["quest"]["waypoints"][number]) => { const id = credits.find((c) => c.verifiedWaypointIds.includes(w.id))?.memberThreadId ?? w.verifiedBy; return id ? names.name(id) : null; };
  const verified = quest.waypoints.filter(verifiedWaypoint);
  const resolved = quest.waypoints.filter(w => w.state === "accepted" || w.state === "done");
  const madeOnly = verified.length ? [] : quest.waypoints.filter(w => !settled(w) && (w.state === "reported" || (w.state !== "rejected" && credits.some(c => c.madeWaypointIds.includes(w.id)))));
  for (const w of verified) {
    const by = maker(w), check = verifier(w);
    lines.push(by ? `${by} made ${quoted(w.title)}, and ${check ?? "a Warden"} verified it.` : `${quoted(w.title)} was verified${check ? ` by ${check}` : ""}.`);
  }
  for (const w of madeOnly) {
    const by = maker(w);
    const evidence = w.evidenceCount > 0 ? ` (${w.evidenceCount} evidence)` : "";
    lines.push(`${by ?? "A member"} made ${quoted(w.title)}${evidence}, not verified.`);
  }
  for (const w of resolved) lines.push(sentence(`${quoted(w.title)}: ${resolutionWords(w)}`));
  if (!verified.length && !madeOnly.length && !resolved.length) lines.push("Nothing was finished.");
  const told = new Set([...verified, ...madeOnly, ...resolved].map(w => w.id));
  // A checker files reports against the waypoint it checks; they belong to its own check waypoint.
  const checks = new Map((quest.members ?? []).flatMap((m) => m.checkerWaypointId ? [[m.threadId, m.checkerWaypointId] as const] : []));
  const about = (r: Report) => checks.get(r.memberThreadId) ?? r.waypointId;
  for (const w of quest.waypoints) {
    if (told.has(w.id)) continue;
    const last = [...reports].filter((r) => about(r) === w.id).sort((a, b) => b.createdAt - a.createdAt)[0];
    const author = last ? names.name(last.memberThreadId) : null;
    const headline = last ? names.headline(last) : null;
    if (last && author) {
      const own = w.ownerMember?.threadId === last.memberThreadId || credits.some((c) => c.memberThreadId === last.memberThreadId && c.madeWaypointIds.includes(w.id));
      const what = own ? `work on ${quoted(w.title)}` : `check of ${quoted(w.title)}`;
      const state = last.status === "needs-decision" ? " waiting on a decision" : last.status === "blocked" ? " blocked" : "";
      lines.push(headline ? sentence(`${author}’s ${what} was left${state}: ${headline}`) : `${author}’s ${what} was left${state}.`);
    } else if (w.actor === "user") lines.push(`${quoted(w.title)} was still yours.`);
    else if (w.actor === "outside") lines.push(`${quoted(w.title)} was waiting on ${w.owner ?? "someone outside"}.`);
    else lines.push(`${quoted(w.title)} was ${LEFT_WORD[w.state] ?? w.state}.`);
  }
  // The stop's receipt (or each ask's cause) proves an ask was withdrawn by the stop; older records only say "withdrawn".
  const receipt = Array.isArray(stop?.data.withdrawnAskIds) ? stop.data.withdrawnAskIds.length : null;
  const atStop = receipt ?? detail.asks.filter((a) => a.boardQuestId === quest.id && a.withdrawnCause === "quest-stopped").length;
  const unknown = detail.asks.filter((a) => a.boardQuestId === quest.id && a.state === "withdrawn" && !a.withdrawnCause).length;
  if (atStop) lines.push(`${atStop} ask${atStop === 1 ? "" : "s"} withdrawn when it stopped.`);
  else if (unknown) lines.push(`${unknown} ask${unknown === 1 ? "" : "s"} withdrawn.`);
  return lines;
}

/** The room's Closing time state, once the room carries it (Tim's AwayStatus); null until then, so nothing shows. */
export function roomAway(room: Room): AwayStatus | null {
  return (room as Room & { away?: AwayStatus | null }).away ?? null;
}
/**
 * The status line's words for Closing time, null when open: the hearth's own words, so the two can't drift. "Closed until 08:00"
 * before the Back at time, "Closed · " and the hearth's words once the server says it has passed, or "Closed" with no end.
 */
export function closedWords(away: Pick<AwayStatus, "closed" | "until" | "dueBack"> | null, now = Date.now()): string | null {
  if (!away?.closed) return null;
  const { detail } = hearthWords([], { away, now });
  return detail.startsWith("closed") ? `C${detail.slice(1)}` : `Closed · ${detail}`;
}
