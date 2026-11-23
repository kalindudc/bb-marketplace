import type { Blocker, CompactionSummary, DecisionSummary, ThreadStatusDto } from "../contract";
import { HARD_WINDOW_VETOES } from "../decide";
import {
  agoText, clockText, numberText, plural, pointName, pointWord, PROVIDER_OFF_TEXT, reasonText, shortTokens, timeText, VETO_WORDS, vetoWord,
} from "./model";

export type Tone = "none" | "attn" | "bad";
export type GlyphName = "check" | "pause" | "press" | "alert" | "slash" | "dot" | "ring" | "dash" | "chev" | "cross";
export type StateKey = "unknown" | "off" | "held" | "compacting" | "landed" | "failed" | "backstop" | "blocked" | "range" | "safe";

export interface PanelState {
  key: StateKey;
  word: string;
  glyph: GlyphName;
  tone: Tone;
}

/** What the panel remembers from the poll before a compaction finished; the status itself has no "just landed". */
export interface Landing {
  outcome: "ok" | "failed";
  row: CompactionSummary;
  fromPercent: number | null;
  wasHeld: boolean;
}

const HOLDS_FORCE_AT: ReadonlySet<Blocker["veto"]> = HARD_WINDOW_VETOES;

const tokensAt = (d: ThreadStatusDto, percent: number) => Math.round((d.window ?? 0) * percent / 100);
const remaining = (seconds: number | null, elapsed: number) => seconds === null ? null : Math.max(0, seconds - elapsed);

/** A compaction that finished between two polls: a new or settled row at the top of the history. */
export function detectLanding(previous: ThreadStatusDto | undefined, next: ThreadStatusDto): Landing | null {
  if (!previous || previous.threadId !== next.threadId || next.compacting || next.held) return null;
  const row = next.history[0];
  if (!row || row.outcome === "pending") return null;
  const before = previous.history.find((entry) => entry.id === row.id);
  if (before && before.outcome !== "pending") return null;
  if (!before && !previous.compacting && !previous.held && previous.history.length > 0
    && Date.parse(row.at) <= Date.parse(previous.history[0]!.at)) return null;
  return { outcome: row.outcome === "ok" ? "ok" : "failed", row, fromPercent: previous.percent, wasHeld: previous.held !== null };
}

const turnRunning = (d: ThreadStatusDto) => d.running || d.blockers.some((b) => b.veto === "midTurn");

interface ForceAtHold {
  /** A turn is running: Press never compacts a running thread. */
  turn: boolean;
  /** The other veto force at waits out (the cooldown), with the seconds left on it now. */
  wait: Blocker | null;
  left: number | null;
}

/** What still holds force at back. A cooldown that ran out since the status was read no longer counts. */
function forceAtHold(d: ThreadStatusDto, elapsed: number): ForceAtHold {
  const turn = turnRunning(d);
  const wait = d.blockers.find((b) => b.veto !== "midTurn" && HOLDS_FORCE_AT.has(b.veto)) ?? null;
  const left = remaining(wait?.remainingSeconds ?? null, elapsed);
  return left === 0 ? { turn, wait: null, left: null } : { turn, wait, left };
}

const anyPointOn = (d: ThreadStatusDto) => Object.values(d.points).some(Boolean);
/** The vetoes that block a point now. A running turn is left out: Press decides again when it ends. */
const pointBlockers = (d: ThreadStatusDto) => d.blockers.filter((b) => b.veto !== "midTurn");
/**
 * Where the points open: the lowest minimum of the enabled points. With every point off the server
 * serves force at there, so the range keeps starting at compact at and says force at is all that is left.
 */
const pointsOpenAt = (d: ThreadStatusDto) => anyPointOn(d) ? d.pointsFromPercent : d.thresholds.softPercent;
const inPointRange = (d: ThreadStatusDto) => d.percent !== null && d.percent >= pointsOpenAt(d);
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function deriveState(d: ThreadStatusDto, landing: Landing | null): PanelState {
  const { hardPercent: hard } = d.thresholds;
  if (!d.providerEnabled && d.held === null && d.compacting === null) return { key: "off", word: "Off", glyph: "dash", tone: "none" };
  if (d.percent === null) return { key: "unknown", word: "No usage yet", glyph: "dash", tone: "none" };
  if (d.held) return { key: "held", word: "Holding", glyph: "pause", tone: "attn" };
  if (d.compacting) return { key: "compacting", word: "Compacting", glyph: "press", tone: "attn" };
  if (landing?.outcome === "failed") return { key: "failed", word: "Failed", glyph: "cross", tone: "bad" };
  if (landing) {
    if (d.percent >= hard) return { key: "landed", word: "Backstop due", glyph: "alert", tone: "bad" };
    return inPointRange(d)
      ? { key: "landed", word: "In compact range", glyph: "ring", tone: "none" }
      : { key: "landed", word: "Safe", glyph: "check", tone: "none" };
  }
  if (d.percent >= hard) return { key: "backstop", word: "Backstop due", glyph: "alert", tone: "bad" };
  if (!inPointRange(d)) return { key: "safe", word: "Safe", glyph: "check", tone: "none" };
  if (!turnRunning(d) && anyPointOn(d) && pointBlockers(d).length > 0) return { key: "blocked", word: "Blocked", glyph: "slash", tone: "attn" };
  return { key: "range", word: "In compact range", glyph: "ring", tone: "none" };
}

/** The newest decision, when it is a veto that still holds and came after the last compaction. */
function currentVeto(d: ThreadStatusDto, current: readonly Blocker[]): DecisionSummary | null {
  const top = d.decisions[0];
  if (top?.decision !== "veto" || !current.some((b) => b.veto === top.reason)) return null;
  const newest = d.history[0];
  return newest === undefined || Date.parse(top.at) >= Date.parse(newest.at) ? top : null;
}

export interface NextStep {
  tone: Tone;
  glyph: GlyphName;
  title: string;
  sub: string | null;
  /** Elapsed time counts from here (holding or compacting). */
  since: string | null;
  /** What the elapsed bar measures against, and the word for it. */
  expectedMs: number | null;
  expectedWord: "about" | "usually" | null;
  /** Seconds left on a countdown in the title, measured when the status was read. */
  countdown: number | null;
}

function expected(d: ThreadStatusDto): Pick<NextStep, "expectedMs" | "expectedWord"> {
  if (d.estimateMs !== null && d.estimateMs > 0) return { expectedMs: d.estimateMs, expectedWord: "about" };
  if (d.totals.averageMs !== null && d.totals.averageMs > 0) return { expectedMs: d.totals.averageMs, expectedWord: "usually" };
  return { expectedMs: null, expectedWord: null };
}

const expectedText = ({ expectedMs, expectedWord }: Pick<NextStep, "expectedMs" | "expectedWord">) =>
  expectedMs === null ? "first compaction" : `${expectedWord} ${clockText(expectedMs / 1000)}`;

function modeNote(d: ThreadStatusDto): string {
  return d.mode === "observe" ? " · observe records only" : d.mode === "advisor" ? " · advisor proposes, you compact" : "";
}

export function nextStep(d: ThreadStatusDto, state: PanelState, landing: Landing | null, now: number, elapsed: number): NextStep {
  const { hardPercent: hard, softPercent: soft } = d.thresholds;
  const quiet = { since: null, expectedMs: null, expectedWord: null, countdown: null } as const;
  switch (state.key) {
    case "off":
      return { tone: "none", glyph: "dash", title: PROVIDER_OFF_TEXT, sub: "Set in Press policy · Press never compacts or holds this thread", ...quiet };
    case "held": {
      const timing = expected(d);
      const count = d.held!.count;
      return { tone: "attn", glyph: "pause", title: count > 1 ? `Holding ${count} messages` : "Holding your next message",
        sub: `Compacting first, sends when it lands · ${expectedText(timing)}`, since: d.held!.since, ...timing, countdown: null };
    }
    case "compacting": {
      const timing = expected(d);
      const { since, point } = d.compacting!;
      return { tone: "attn", glyph: "press", title: point === null ? "Compacting" : `Compacting · ${pointWord(point, hard)}`,
        sub: `Started ${timeText(since)} · ${expectedText(timing)}`, since, ...timing, countdown: null };
    }
    case "landed": {
      const { row, fromPercent, wasHeld } = landing!;
      const freed = row.tokensBefore !== null && row.tokensAfter !== null ? row.tokensBefore - row.tokensAfter : null;
      const title = ["Compacted", freed === null ? null : `freed ${numberText(freed)}`].filter(Boolean).join(" · ")
        + (row.ms === null ? "" : ` in ${clockText(row.ms / 1000)}`);
      const sub = [fromPercent === null ? null : `${Math.round(fromPercent)}% to ${Math.round(d.percent ?? 0)}%`,
        wasHeld ? "held message released" : null].filter(Boolean).join(" · ");
      return { tone: "none", glyph: "check", title, sub: sub || null, ...quiet };
    }
    case "failed": {
      const { row, wasHeld } = landing!;
      return { tone: "bad", glyph: "cross", title: row.outcome === "cancelled" ? "Compaction cancelled" : "Compaction failed",
        sub: [row.error ?? "No reason was reported", wasHeld ? "held message released" : null].filter(Boolean).join(" · "), ...quiet };
    }
    case "backstop": {
      const { turn, wait, left } = forceAtHold(d, elapsed);
      const verb = d.mode === "observe" ? "Would compact" : d.mode === "advisor" ? "Proposes compacting" : "Compacts";
      if (turn && wait) {
        // The countdown sits in the sub, so the title (which the live region reads) stays still.
        const word = vetoWord(wait.veto);
        return { tone: "bad", glyph: "alert", title: `${verb} after this turn and the ${word}`,
          sub: `${sentence(word)}${left === null ? "" : ` ${clockText(left)} left`}${modeNote(d)}`, ...quiet };
      }
      if (turn) {
        if (d.mode === "observe") return { tone: "bad", glyph: "alert", title: "Would compact when this turn ends", sub: "Observe records only, nothing compacts", ...quiet };
        if (d.mode === "advisor") return { tone: "bad", glyph: "alert", title: "Proposes compacting when this turn ends", sub: "Advisor waits for you to compact", ...quiet };
        return { tone: "bad", glyph: "alert", title: "Compacts when this turn ends", sub: "Then holds your next message until it lands", ...quiet };
      }
      if (wait && left !== null) {
        return { tone: "bad", glyph: "alert", title: `${verb} in ${clockText(left)}`, sub: `Force at waits out the ${vetoWord(wait.veto)}${modeNote(d)}`,
          since: null, expectedMs: null, expectedWord: null, countdown: left };
      }
      if (d.mode === "observe") return { tone: "bad", glyph: "alert", title: "Would compact now", sub: "Observe records only, nothing compacts", ...quiet };
      if (d.mode === "advisor") return { tone: "bad", glyph: "alert", title: "Proposes compacting now", sub: "Advisor waits for you to compact", ...quiet };
      return { tone: "bad", glyph: "alert", title: "Compacts before the next turn", sub: "Holds your next message until it lands", ...quiet };
    }
    case "blocked": {
      const current = pointBlockers(d);
      const cited = currentVeto(d, current);
      const blocker = current.find((b) => b.veto === cited?.reason) ?? current[0]!;
      const sub = [vetoDetail(blocker, d, elapsed), `force at ${hard}% still applies`].filter(Boolean).join(" · ");
      return { tone: "attn", glyph: "slash", title: `${cited ? pointName(cited.point) : "Points"} vetoed by ${vetoWord(blocker.veto)}`,
        sub: `${sentence(sub)}${modeNote(d)}`, ...quiet };
    }
    case "range": {
      const title = !anyPointOn(d) ? "All points off · force at only"
        : d.nextPoint ? `Next point: ${pointWord(d.nextPoint, hard)}` : "Compacts when a point fires";
      return { tone: "none", glyph: "ring", title, sub: `${numberText(Math.max(0, tokensAt(d, hard) - (d.tokens ?? 0)))} tokens to force at${modeNote(d)}`, ...quiet };
    }
    case "safe": {
      const last = d.lastCompaction ? `Last compaction ${agoText(d.lastCompaction.at, now)}` : "Never compacted";
      const opens = pointsOpenAt(d);
      const until = opens === soft ? "until compact at" : "until points open";
      return { tone: "none", glyph: "check", title: `${numberText(Math.max(0, tokensAt(d, opens) - (d.tokens ?? 0)))} tokens ${until}`,
        sub: `${last} · ${plural(d.turnsSince, "turn")}${modeNote(d)}`, ...quiet };
    }
    default:
      return { tone: "none", glyph: "dash", title: "Waiting for the first usage report", sub: null, ...quiet };
  }
}

export interface GateLine {
  text: string;
  struck?: boolean;
  strong?: boolean;
}

export interface Gate {
  id: "force" | "vetoes" | "points";
  name: string;
  state: "idle" | "live" | "bad" | "block";
  mark: GlyphName;
  lines: GateLine[];
}

/** How far a veto has left to go, when the status says. */
function vetoDetail(b: Blocker, d: ThreadStatusDto, elapsed: number): string | null {
  const left = remaining(b.remainingSeconds, elapsed);
  switch (b.veto) {
    case "cooldownSeconds":
    case "previousCompactionFailed":
      return left === null ? null : `${clockText(left)} left`;
    case "minTurnsBetween":
      return b.remainingTurns === null ? null : `${plural(b.remainingTurns, "turn")} left`;
    case "belowFloor":
      return d.tokens === null ? null : `${numberText(Math.max(0, d.thresholds.floorTokens - d.tokens))} short`;
    case "midTurn":
      return "until this turn ends";
  }
}

export function vetoText(b: Blocker, d: ThreadStatusDto, elapsed: number): string {
  const detail = vetoDetail(b, d, elapsed);
  return detail === null ? VETO_WORDS[b.veto] : `${VETO_WORDS[b.veto]} · ${detail}`;
}

/** Press's own order: the hard window first, then the vetoes, then the points (`decide.ts`). */
export function decisionPath(d: ThreadStatusDto, state: PanelState, elapsed: number): Gate[] {
  const { hardPercent: hard } = d.thresholds;
  const percent = d.percent;
  const over = percent !== null && percent >= hard;
  const busy = state.key === "held" || state.key === "compacting";
  const off = !d.providerEnabled;
  const pct = percent === null ? "" : `${Math.round(percent)}%`;
  const reach: GateLine = over ? { text: `reached · ${pct}` } : { text: `not reached · ${numberText(Math.max(0, tokensAt(d, hard) - (d.tokens ?? 0)))} tokens away` };

  let force: Gate;
  if (percent === null) {
    force = { id: "force", name: `Force at ${hard}%`, state: "idle", mark: "ring", lines: [{ text: "usage not reported" }] };
  } else if (busy && (d.held !== null || d.compacting?.point === "window")) {
    force = { id: "force", name: `Force at ${hard}%`, state: "live", mark: "dot", lines: [{ text: `reached · ${pct}` }, { text: "compacting now" }] };
  } else if (off) {
    force = { id: "force", name: `Force at ${hard}%`, state: "idle", mark: over ? "dot" : "ring", lines: [reach, { text: "off for this provider" }] };
  } else if (over && !busy) {
    const { turn, wait } = forceAtHold(d, elapsed);
    const when = turn && wait ? `waits for the turn and the ${vetoWord(wait.veto)}`
      : turn ? "fires when this turn ends" : wait ? `waits for the ${vetoWord(wait.veto)}` : "fires before the next turn";
    force = { id: "force", name: `Force at ${hard}%`, state: "bad", mark: "dot", lines: [reach, { text: when }] };
  } else {
    force = { id: "force", name: `Force at ${hard}%`, state: "idle", mark: over ? "dot" : "ring", lines: [reach] };
  }

  let vetoes: Gate;
  if (busy) {
    vetoes = { id: "vetoes", name: "Vetoes", state: "idle", mark: "ring",
      lines: [{ text: d.compacting?.point === "manual" ? "skipped, you asked" : "passed" }] };
  } else if (d.blockers.length === 0) {
    vetoes = { id: "vetoes", name: "Vetoes", state: "idle", mark: "ring", lines: [{ text: "none" }] };
  } else if (over && !off) {
    // The force at gate says which veto it waits for; here those stay bold and the rest are struck.
    const lines: GateLine[] = d.blockers.map((b) => HOLDS_FORCE_AT.has(b.veto)
      ? { text: vetoText(b, d, elapsed), strong: true }
      : { text: vetoText(b, d, elapsed), struck: true });
    if (lines.some((line) => line.struck)) lines.push({ text: "overridden by force at", strong: true });
    vetoes = { id: "vetoes", name: "Vetoes", state: "block", mark: "slash", lines };
  } else {
    vetoes = { id: "vetoes", name: "Vetoes", state: "block", mark: "slash", lines: d.blockers.map((b) => ({ text: vetoText(b, d, elapsed) })) };
  }

  const top: DecisionSummary | undefined = d.decisions[0];
  let points: Gate;
  if (d.compacting?.point === "manual") {
    points = { id: "points", name: "Points", state: "live", mark: "dot", lines: [{ text: `skipped, you compacted at ${timeText(d.compacting.since)}` }] };
  } else if (d.compacting && d.compacting.point !== null && d.compacting.point !== "window") {
    points = { id: "points", name: "Points", state: "live", mark: "dot", lines: [{ text: `${pointWord(d.compacting.point, hard)} fired ${timeText(d.compacting.since)}` }] };
  } else if (off) {
    points = { id: "points", name: "Points", state: "idle", mark: "ring", lines: [{ text: "off for this provider" }] };
  } else if (over || busy) {
    points = { id: "points", name: "Points", state: "idle", mark: "ring",
      lines: [{ text: top?.decision === "veto" && top.point !== "window" ? `${pointWord(top.point, hard)} fired ${timeText(top.at)} · vetoed` : "skipped, force at first" }] };
  } else if (!anyPointOn(d)) {
    points = { id: "points", name: "Points", state: "idle", mark: "ring", lines: [{ text: "all off for this thread" }] };
  } else if (d.nextPoint !== null) {
    points = { id: "points", name: "Points", state: "idle", mark: "ring", lines: [{ text: `next: ${pointWord(d.nextPoint, hard)}` }] };
  } else if (percent === null || percent < d.pointsFromPercent) {
    points = { id: "points", name: "Points", state: "idle", mark: "ring", lines: [{ text: `closed until ${d.pointsFromPercent}%` }] };
  } else {
    points = { id: "points", name: "Points", state: "idle", mark: "ring", lines: [{ text: "none fired yet" }] };
  }
  return [force, vetoes, points];
}

export interface DecisionRow {
  key: string;
  at: string;
  decision: DecisionSummary["decision"];
  what: string;
  detail: string;
  percent: string;
  /** The row in a sentence, for its tooltip. */
  full: string;
}

export function decisionRows(d: ThreadStatusDto): DecisionRow[] {
  const hard = d.thresholds.hardPercent;
  return d.decisions.map((row, index) => {
    const reason = row.decision === "veto" ? vetoWord(row.reason) : row.reason === "window.hard" ? null : reasonText(row.reason);
    const detail = [pointWord(row.point, hard), reason].filter(Boolean).join(" · ");
    const pct = row.percent === null ? "" : `${Math.round(row.percent)}%`;
    const at = pct ? ` at ${pct}` : "";
    const full = row.decision === "veto"
      ? `${pointName(row.point)} point fired${at}, vetoed by ${vetoWord(row.reason)}`
      : `Compaction requested by the ${pointWord(row.point, hard)} point${at}`;
    return { key: `${row.at}-${index}`, at: row.at, decision: row.decision, what: row.decision === "veto" ? "Veto" : "Compact", detail, percent: pct, full };
  });
}

export function historyOutcome(row: CompactionSummary): string {
  if (row.outcome === "failed") return "failed";
  if (row.outcome === "cancelled") return "cancelled";
  if (row.outcome === "pending") return "running";
  return row.tokensBefore === null && row.tokensAfter === null ? "compacted" : `${shortTokens(row.tokensBefore)} to ${shortTokens(row.tokensAfter)}`;
}

export function totalsText(d: ThreadStatusDto): string {
  const { count, tokensFreed, averageMs } = d.totals;
  return [plural(count, "compaction"), `${shortTokens(tokensFreed)} freed`, averageMs === null ? null : `${clockText(averageMs / 1000)} average`]
    .filter(Boolean).join(" · ");
}

export interface ChartDrop {
  id: string;
  /** Left edge to right edge, 0 to 100. */
  x: number;
  /** Top of the chart is 100 percent of the window, the bottom 0; values are percent of the window. */
  before: number;
  after: number;
  label: string;
}

export interface DropChart {
  drops: ChartDrop[];
  now: { x: number; percent: number } | null;
  start: string;
  label: string;
}

/** One drop per landed compaction, from tokens before to tokens after, on a time axis ending now. */
export function dropChart(d: ThreadStatusDto, now: number): DropChart | null {
  if (d.window === null || d.window <= 0) return null;
  const window = d.window;
  const rows = d.history
    .filter((row) => row.outcome === "ok" && row.tokensBefore !== null && row.tokensAfter !== null && Number.isFinite(Date.parse(row.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (rows.length === 0) return null;
  const t0 = Date.parse(rows[0]!.at);
  const t1 = Math.max(now, Date.parse(rows.at(-1)!.at));
  const x = (t: number) => t1 === t0 ? 0 : Math.min(100, Math.max(0, (t - t0) / (t1 - t0) * 100));
  const share = (tokens: number) => Math.min(100, Math.max(0, tokens / window * 100));
  const drops = rows.map((row) => ({
    id: row.id, x: x(Date.parse(row.at)), before: share(row.tokensBefore!), after: share(row.tokensAfter!),
    label: `${timeText(row.at)} · ${numberText(row.tokensBefore)} to ${numberText(row.tokensAfter)}`,
  }));
  const nowPoint = d.percent === null ? null : { x: t1 === t0 ? 100 : x(now), percent: Math.min(100, Math.max(0, d.percent)) };
  const label = `${plural(rows.length, "compaction")} from ${timeText(rows[0]!.at)} to ${timeText(rows.at(-1)!.at)}, each a drop from tokens before to tokens after`
    + (d.percent === null ? "" : `; now ${Math.round(d.percent)}%`);
  return { drops, now: nowPoint, start: rows[0]!.at, label };
}

/** Whether anything on screen counts down or up, so the panel ticks once a second only then. */
export function needsClock(d: ThreadStatusDto): boolean {
  return d.held !== null || d.compacting !== null || d.blockers.some((b) => b.remainingSeconds !== null);
}
