import { memberName } from "../../shared/member-name";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { memo, type ReactNode } from "react";
import type { BoardQuestSummary, Room } from "../../shared/contract";
import type { Ask, CheckerHandoffHold, Member, Phase } from "../../shared/schema";
import { Crest } from "./crest";
import { Glyph, OpensMark, type GlyphName } from "./glyphs";
import { CELLAR, TimeAgo, clockTime, useToday } from "./primitives";
import { memberIdentity, type Registry } from "./registry";
import { ArrivalMark } from "./arrival";
import { memberPlace } from "../../shared/member-place";

// ---- Quest and Keeper state, shared by the page, the rows and the thread surfaces ----

export const isFinished = (phase: string) => phase === "done" || phase === "stopped";

export const PHASE_STEPS: { id: Phase; label: string; plain: string | null }[] = [
  { id: "scout", label: "Rangers out", plain: "scout" }, { id: "greenlight", label: "Form the party", plain: "greenlight" }, { id: "build", label: "Build", plain: null },
  { id: "check", label: "Warden's trial", plain: "check" }, { id: "wrap", label: "Return", plain: "wrap" },
];
/** Stopping and stopped light no segment: the path's strip is struck instead. */
export const phaseIndex = (phase: Phase) => phase === "done" ? 5 : phase === "stopped" || phase === "stopping" ? -1 : PHASE_STEPS.findIndex((p) => p.id === phase);
export const phaseWord = (phase: Phase) => phase === "done" ? "Returned" : phase === "stopped" ? "Stopped" : phase === "stopping" ? "Stopping" : phase.charAt(0).toUpperCase() + phase.slice(1);
/** A stopping quest's state: Tavern has asked every member to stop and retries the ones it hasn't confirmed. Never finished, never archivable. */
export function stoppingWords(quest: Pick<BoardQuestSummary, "stopUnconfirmed">): string {
  const n = quest.stopUnconfirmed ?? 0;
  return n > 0 ? `${n} not confirmed; Tavern retries` : "confirming";
}

/**
 * A quest's checker-handoff hold while it waits on the user's release, as the server defines it: not released, on a quest that still
 * takes work (not done, stopping or stopped). Null otherwise. The Keeper hires or re-tasks no Warden on the quest until it is released.
 */
export const activeHold = (quest: Pick<BoardQuestSummary, "checkerHandoffHold" | "phase">): CheckerHandoffHold | null => {
  const h = quest.checkerHandoffHold;
  return h && h.release === null && quest.phase !== "stopping" && !isFinished(quest.phase) ? h : null;
};
/** The open ask the Keeper raised to have this hold released, if any: it stands for the hold, so the two count once. */
const releaseAskOf = (hold: CheckerHandoffHold | null, asks: readonly Ask[]) => hold ? asks.find((a) => a.state === "open" && a.releaseHoldId === hold.id) ?? null : null;
/** Quests whose hold waits on the user with no open release ask standing for it: each is one more thing that needs the user. */
export function heldQuests<Q extends Pick<BoardQuestSummary, "checkerHandoffHold" | "phase">>(quests: readonly Q[], asks: readonly Ask[]): Q[] {
  return quests.filter((q) => { const h = activeHold(q); return h !== null && !releaseAskOf(h, asks); });
}
export const questNeedYouCount = (quest: BoardQuestSummary, asks: readonly Ask[]) => asks.filter(a => a.state === "open" && a.boardQuestId === quest.id).length + heldQuests([quest], asks).length;

type Release = NonNullable<CheckerHandoffHold["release"]>;
const RELEASE_VIA: Record<Release["via"], string> = { banner: "from the ask banner", page: "from the Tavern page", phone: "from your phone", chat: "in chat", cli: "from the command line" };
/** How a checker-handoff hold was released, in words: the path, and the Keeper's ask when answering it was the release. */
export const releaseWords = (release: Release) => release.askId ? `by answering the Keeper's ask, ${RELEASE_VIA[release.via]}` : RELEASE_VIA[release.via];

/**
 * Members on the road across the room: each working member and working errand helper, once. "On the road" always counts members, never
 * quests; the room's status line and the hearth read this one count, and the party picture places members by the same rule.
 */
export function onTheRoad(room: Pick<Room, "keepers">): number {
  const out = new Set<string>();
  for (const k of room.keepers) for (const m of [...k.boardQuests.flatMap((q) => q.members), ...k.errands]) if (memberPlace(m.state) === "road") out.add(m.threadId);
  return out.size;
}

/** What was verified: verified waypoints only, the skipped ones, and every waypoint; null while there is no map. Every "verified" label reads this. */
export function verifiedOf(quest: Pick<BoardQuestSummary, "waypoints">): { verified: number; skipped: number; total: number } | null {
  if (!quest.waypoints.length) return null;
  return { verified: quest.waypoints.filter((w) => w.state === "verified").length, skipped: quest.waypoints.filter((w) => w.state === "skipped").length, total: quest.waypoints.length };
}
/**
 * "1 of 2 verified · 1 skipped". When nothing was verified and everything was skipped: "1 skipped" for one waypoint, "all 3 skipped" for
 * more, so it says they were all of them. A skipped waypoint is never called verified. A no-break space goes before each "·", so a
 * wrapped line never starts with one and no caller has to swap it in.
 */
export function verifiedWords(c: { verified: number; skipped: number; total: number }, noun = "verified"): string {
  if (c.verified === 0 && c.skipped === c.total) return c.skipped === 1 ? "1 skipped" : `all ${c.skipped} skipped`;
  return `${c.verified} of ${c.total}${noun ? ` ${noun}` : ""}${c.skipped ? `\u00a0· ${c.skipped} skipped` : ""}`;
}

/** Critical-path progress: verified or skipped waypoints out of all of them; null while there is no plan. A skipped waypoint is out of the way, so it counts here, never in a "verified" label (`verifiedOf`). */
export function pathProgress(quest: BoardQuestSummary) {
  if (!quest.waypoints.length) return null;
  return { done: quest.waypoints.filter((w) => w.state === "verified" || w.state === "skipped").length, total: quest.waypoints.length };
}

export type MoveTone = "you" | "work" | "wait" | "keeper" | "done" | "bad" | "archived";
/** Whose move a quest waits on. `next` is the whole phrase; where it ends in a waypoint's title, `verb` and `task` split it, so a narrow row cuts the task and never the state. An archived Keeper's thread can move nothing, so its unfinished quests say so instead of naming a next step; `next` is then empty. */
export function questMove(quest: BoardQuestSummary, asks: Ask[], names: { keeper: string; member: (m: Member) => string }, opts: { keeperArchived?: boolean } = {}): { tone: MoveTone; who: string; next: string; verb?: string; task?: string } {
  // An active hold is the user's move too. The Keeper's ask to release it reads as the hold, never as a blocker of its own.
  const hold = activeHold(quest), releaseAsk = releaseAskOf(hold, asks);
  const open = asks.filter((a) => a.state === "open" && a.boardQuestId === quest.id && a !== releaseAsk).sort((a, b) => a.createdAt - b.createdAt);
  if (quest.phase === "done") return { tone: "done", who: "Returned", next: "the tale is told" };
  if (quest.phase === "stopped") return { tone: "bad", who: "Stopped", next: "by you" };
  if (quest.phase === "stopping") return { tone: "bad", who: "Stopping", next: stoppingWords(quest) };
  if (opts.keeperArchived) return { tone: "archived", who: "Keeper's thread archived", next: "" };
  if (open.length || hold) {
    const blocked = open.some((a) => a.kind === "blocker");
    const asked = !open.length ? null : blocked ? "blocked" : open.length === 1 ? open[0]!.kind === "greenlight" ? "form the party" : "1 ask" : `${open.length} asks`;
    return { tone: blocked ? "bad" : "you", who: "You", next: [asked, hold && "1 hold"].filter(Boolean).join(" · ") };
  }
  const failed = quest.members.find((m) => m.state === "failed");
  if (failed) return { tone: "bad", who: names.member(failed), next: "failed" };
  const next = quest.waypoints.find((w) => w.state !== "verified" && w.state !== "skipped");
  if (!quest.plan) {
    const out = quest.members.filter((m) => m.state === "working");
    return out.length ? { tone: "work", who: out.map(names.member).join(", "), next: "scouting" } : { tone: "keeper", who: names.keeper, next: "quest map next" };
  }
  if (!next) return { tone: "keeper", who: names.keeper, next: "wrap it up" };
  // A reported waypoint waits on its check, not its maker: the Warden checking it, or the Keeper, who has to find one.
  if (next.state === "reported") {
    const checker = quest.members.find((m) => m.state === "working" && m.checkerWaypointId === next.id);
    return checker
      ? { tone: "work", who: names.member(checker), next: `checking ${next.title}`, verb: "checking", task: next.title }
      : { tone: "keeper", who: names.keeper, next: `find a checker for ${next.title}`, verb: "find a checker for", task: next.title };
  }
  if (next.actor === "user") return { tone: "you", who: "You", next: next.title, task: next.title };
  if (next.actor === "outside") return { tone: "wait", who: next.owner ?? "Outside", next: next.title, task: next.title };
  if (next.ownerMember) return { tone: next.state === "blocked" ? "bad" : "work", who: names.member(next.ownerMember), next: next.title, task: next.title };
  return { tone: "keeper", who: names.keeper, next: `hire for ${next.title}`, verb: "hire for", task: next.title };
}

export type KeeperStatus = { tone: "busy" | "holding" | "idle" | "quiet" | "archived"; word: "busy" | "holding" | "idle" | "quiet" | "thread archived"; label: string; hint: string };
/** What each Keeper state means, in a sentence; StateMark shows it on hover wherever the state is drawn. */
export const KEEPER_STATE_HINT: Record<KeeperStatus["tone"], string> = {
  idle: "Between turns. It takes your next message, or its party's next report.",
  busy: "Working on a turn now.",
  holding: "Tavern holds its updates while you type to it.",
  quiet: "You've paused its updates. Your messages still reach it.",
  archived: "Its thread is archived; its quests and record are kept.",
};
/**
 * One wording for a Keeper's own state, wherever Tavern shows it. An archived thread outranks every other word; a Keeper is never "working",
 * its members are. The server's "listening" reads as "idle": people didn't know what listening meant.
 */
export function keeperStatus(k: Pick<Room["keepers"][number], "status" | "quietSince" | "archived">): KeeperStatus {
  const of = (tone: KeeperStatus["tone"], word: KeeperStatus["word"], label: string): KeeperStatus => ({ tone, word, label, hint: KEEPER_STATE_HINT[tone] });
  if (k.archived) return of("archived", "thread archived", "Thread archived");
  if (k.quietSince != null) return of("quiet", "quiet", "Quiet");
  if (k.status === "busy") return of("busy", "busy", "Busy");
  if (k.status === "holding") return of("holding", "holding", "Holding while you type");
  return of("idle", "idle", "Idle");
}
/** Ended quests counted by how they ended, never one "returned" count that hides the stopped ones. */
export function endedCounts(quests: readonly Pick<BoardQuestSummary, "phase">[]): { returned: number; stopped: number; words: string; heading: string } {
  const returned = quests.filter((q) => q.phase === "done").length, stopped = quests.filter((q) => q.phase === "stopped").length;
  const words = [returned ? `${returned} returned` : "", stopped ? `${stopped} stopped` : ""].filter(Boolean).join(" · ") || "none";
  return { returned, stopped, words, heading: returned && stopped ? "Returned and stopped" : stopped ? "Stopped" : "Returned" };
}

// ---- Marks ----

/** A live member's name: its party-unique display name ("Lark II") first, then the character's name. */
export function characterName(registry: Registry, member: Pick<Member, "characterId"> & { classId?: string; displayName?: string | null }): string {
  return member.classId !== undefined ? memberName({ classId: member.classId, characterId: member.characterId, displayName: member.displayName }, registry)
    : member.displayName || registry.characters.find((c) => c.id === member.characterId)?.name || "A member";
}

/** The crest alone: a member with no character gets its class's plain shape; a dashed square only when the registry doesn't know the class. */
export const CrestOf = memo(function CrestOf({ member, registry, size = 20, level }: { member: Pick<Member, "classId" | "characterId">; registry: Registry; size?: number; level?: number }) {
  const identity = memberIdentity(registry, member);
  return identity ? <Crest {...identity} size={size} level={level} /> : <span className="tv-crest-missing" style={{ width: size, height: size }} role="img" aria-label={`Unknown class ${member.classId}`} />;
});

export type StateTone = MoveTone | "none" | "idle" | "listen" | "listening" | "busy" | "holding" | "quiet" | "archived" | "warn" | "plain" | "fail";
const MARK: Record<string, { glyph: GlyphName; name: string }> = {
  you: { glyph: "ask", name: "you" }, work: { glyph: "st-work", name: "work" }, keeper: { glyph: "st-work", name: "work" }, wait: { glyph: "st-wait", name: "wait" }, plain: { glyph: "st-wait", name: "wait" },
  done: { glyph: "verified", name: "done" }, bad: { glyph: "st-fail", name: "fail" }, fail: { glyph: "st-fail", name: "fail" }, warn: { glyph: "st-stale", name: "stale" }, stale: { glyph: "st-stale", name: "stale" },
  idle: { glyph: "st-idle", name: "idle" }, listen: { glyph: "st-idle", name: "idle" }, listening: { glyph: "st-idle", name: "idle" }, busy: { glyph: "st-busy", name: "busy" }, holding: { glyph: "more", name: "typing" },
  quiet: { glyph: "pause", name: "pause" }, archived: { glyph: "pause", name: "pause" }, none: { glyph: "st-none", name: "none" },
};
/** A state as a mark and a word; the mark's shape carries the state without colour. */
/** A Keeper state's mark explains itself on hover unless the caller passes its own `title`. */
export const StateMark = memo(function StateMark({ tone, children, title }: { tone: StateTone; children?: ReactNode; title?: string }) {
  const mark = MARK[tone] ?? MARK.wait!;
  const hint = title ?? KEEPER_STATE_HINT[(tone === "listen" || tone === "listening" ? "idle" : tone) as KeeperStatus["tone"]];
  return <span className={`tv-st tv-st-${tone}`} title={hint}><Glyph name={mark.glyph} size={13} className={`tv-g tv-g-${mark.name}`} />{children !== undefined && <span>{children}</span>}</span>;
});

/** The small five-segment phase mark used in rows, with the phase word beside it. */
export const PhaseMark = memo(function PhaseMark({ phase, tone, word = true }: { phase: Phase; tone?: MoveTone; word?: boolean }) {
  const at = phaseIndex(phase);
  return <span className="tv-phw"><span className="tv-ph" role="img" aria-label={`Phase: ${phaseWord(phase)}${at >= 0 && at < 5 ? `, ${at + 1} of 5` : ""}`}>{PHASE_STEPS.map((p, i) => <i key={p.id} className={i < at ? "d" : i === at ? `c ${tone === "you" ? "y" : tone === "bad" ? "x" : ""}` : phase === "stopped" || phase === "stopping" ? "s" : ""} />)}</span>{word && <span className="tv-ph-w">{phaseWord(phase)}</span>}</span>;
});

// ---- Rows ----

type Keeper = Room["keepers"][number];
const moveNames = (registry: Registry, keeper: Member) => ({ keeper: characterName(registry, keeper), member: (m: Member) => characterName(registry, m) });

/** One quest, in a notice, the Ledger or a list. The quest's name opens its quest page and the whole row is that target; "Tale ›" and the cellar action sit above it. At most one bordered control (none). */
/** `arrival` gives the row a still "new" mark when the quest changed since the last look (the room's `since`); a your-move row's mark never fades in. */
export function QuestRow({ quest, room, registry, keeper, showKeeper = false, onArchive, pending = false, arrival }: { quest: BoardQuestSummary; room: Pick<Room, "asks">; registry: Registry; keeper: Keeper; showKeeper?: boolean; onArchive?: (quest: BoardQuestSummary) => void; pending?: boolean; arrival?: { since: number | undefined } }) {
  const navigate = useBbNavigate();
  const open = (sub: string) => navigate.toPluginPanel("tavern", { subPath: sub });
  const path = pathProgress(quest), verified = verifiedOf(quest);
  const name = <button type="button" className="qrow-name act" data-quest-name onClick={() => open(`quest/${quest.id}`)} title={`${isFinished(quest.phase) ? "Open the quest record" : "Open the quest page"}: ${quest.title}`}><b data-content>{quest.short}</b></button>;
  if (isFinished(quest.phase)) {
    const returned = quest.phase === "done";
    return <div className={`tavern qrow qrow-done ${returned ? "" : "stopped"}`} data-variant={returned ? "returned" : "stopped"} data-quest={quest.id} data-part="QuestRow">
      <Glyph name={returned ? "verified" : "rejected"} size={13} className="qrow-g" />
      {name}
      {arrival && <ArrivalMark at={quest.endedAt ?? quest.updatedAt} since={arrival.since} surface="page" cueKey={`row:${quest.id}`} still={!returned} />}
      <span className="qrow-f num"><span>{returned ? "returned" : "stopped"}</span>{returned && verified && <span className="qrow-v"> · {verifiedWords(verified)}</span>}</span>
      <TimeAgo at={quest.endedAt ?? quest.updatedAt} />
      {returned && <button type="button" className="lnk-btn act qrow-tale" onClick={() => open(`tale/${quest.id}`)} title={`Open the tale: ${quest.title}`}><span>Tale</span><OpensMark /></button>}
      {onArchive && <button type="button" className="qrow-x act" onClick={() => onArchive(quest)} disabled={pending} aria-label={`${CELLAR.send}: ${quest.short}`} title={`${CELLAR.send}: ${quest.short}`}><Glyph name="archive" size={13} /><span className="qrow-xl">Cellar</span></button>}
    </div>;
  }
  const move = questMove(quest, room.asks, moveNames(registry, keeper.member), { keeperArchived: keeper.archived === true });
  const need = questNeedYouCount(quest, room.asks);
  const yours = move.tone === "you";
  // showKeeper adds mixed-Keeper labels and ask/hold tags; every row keeps questMove’s edge rule.
  return <div className={`tavern qrow qrow-live t-${move.tone}${showKeeper ? " qrow-home" : ""}`} data-variant={yours ? "your-move" : move.tone === "archived" ? "archived" : quest.phase === "stopping" ? "stopping" : "active"} data-quest={quest.id} {...(yours ? { "data-ask": "" } : {})} data-part="QuestRow">
    {name}
    {/* A stopping quest gets no "new" cue: nothing new is happening on it. */}
    {arrival && quest.phase !== "stopping" && <ArrivalMark at={quest.updatedAt} since={arrival.since} surface="page" cueKey={`row:${quest.id}`} still={yours || move.tone === "bad"} />}
    <TimeAgo at={quest.updatedAt} />
    <OpensMark />
    <span className="qrow-l2">{showKeeper && <span className="qrow-k"><CrestOf member={keeper.member} registry={registry} size={12} /><span title={characterName(registry, keeper.member)}>{characterName(registry, keeper.member)}</span></span>}{showKeeper && need > 0 && <span className="tag status-needs-decision">{need} {need === 1 ? "needs" : "need"} you</span>}<span className="qrow-p"><PhaseMark phase={quest.phase} tone={move.tone} /><span className="qrow-path num">{path ? `${path.done} of ${path.total}` : "no map yet"}</span></span>
    <span className="qrow-m"><StateMark tone={move.tone} title={`${move.who}${move.next ? ` · ${move.next}` : ""}`}>
      {/* Whose move and the verb are the state and never cut; only the waypoint's title truncates, with the whole phrase in the tooltip. */}
      <span className="qrow-mv"><b>{move.who}</b>{move.task !== undefined ? ` ·${move.verb ? ` ${move.verb}` : ""}\u00a0` : move.next ? ` · ${move.next}` : ""}</span>{move.task !== undefined && <span className="qrow-mt" data-content>{move.task}</span>}
    </StateMark></span></span>
  </div>;
}

/** "started 11:02", or "started 12 Nov" before today: only when another Keeper has both the same name and the same thread title. Never numerals, never a quest's name. */
export function keeperStartedLabel(keeper: Keeper, keepers: readonly Keeper[], registry: Registry, now: number): string | null {
  const name = characterName(registry, keeper.member), title = keeper.threadTitle ?? null;
  const twin = keepers.some((o) => o !== keeper && o.member.threadId !== keeper.member.threadId && characterName(registry, o.member) === name && (o.threadTitle ?? null) === title);
  const at = keeper.threadCreatedAt;
  if (!twin || at == null) return null;
  const d = new Date(at);
  return `started ${d.toDateString() === new Date(now).toDateString() ? clockTime(at) : `${d.getDate()} ${d.toLocaleDateString("en", { month: "short" })}`}`;
}

/** One Keeper on one line: crest, name and the thread's title open the thread; then its decided count, its state and a note. */
export function KeeperRow({ keeper, room, registry, note }: { keeper: Keeper; room: Pick<Room, "keepers" | "decidedForYou">; registry: Registry; note?: ReactNode }) {
  const navigate = useBbNavigate();
  const name = characterName(registry, keeper.member);
  const title = keeper.threadTitle ?? null;
  const started = keeperStartedLabel(keeper, room.keepers, registry, useToday());
  const decided = room.decidedForYou.filter((d) => d.keeperThreadId === keeper.member.threadId && !d.undone && d.seenAt == null).length;
  const status = keeperStatus(keeper);
  const label = `Open ${name}'s thread${title ? `: ${title}` : ""}${started ? `, ${started}` : ""}`;
  return <div className="tavern krow" data-part="KeeperRow" data-status={status.tone}>
    <button type="button" className="krow-who act" onClick={() => navigate.toThread(keeper.member.threadId)} title={decided > 0 ? `${label} · ${decided} decided for you (reversible calls), not yet seen` : label} aria-label={label}>
      <CrestOf member={keeper.member} registry={registry} size={20} /><b>{name}</b>{(title || started) && <span className="krow-l2">{title && <span className="krow-t" data-content>{title}</span>}{started && <span className="krow-st">· {started}</span>}</span>}
    </button>
    {/* Part of the row, not a control: a click on it opens the thread like the rest, and the row's tooltip carries what it means. */}
    {decided > 0 && <span className="tag krow-dec"><Glyph name="decided" size={12} /><span>{decided} decided</span></span>}
    <span className="krow-s"><StateMark tone={status.tone} title={`${status.label}: ${status.hint}`}><span className="krow-sl">{status.label}</span><span className="krow-sw">{status.word}</span></StateMark></span>
    <span className="krow-n m">{note ?? "no quest"}</span>
    <span className="krow-go" aria-hidden="true"><OpensMark /></span>
  </div>;
}
