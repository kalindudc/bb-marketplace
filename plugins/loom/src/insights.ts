// The Insights tab: how a project went, when its work happened, the story of each ticket and the numbers, for the whole
// project or one stretch of it. Pure functions over a project's rows, so a rewound page runs the same code as the live one.
// Insights only reads: nothing here moves a ticket or changes what Loom schedules.
import type { EventRow, PostRow, ReviewRow, ThreadRow, TicketRow } from "./db/store";
import { feedText } from "./feed-text";
import { formatDuration, plural } from "./format";
import { percentile } from "./metrics";
import { projectTimeline, type ProjectRows, type TicketBar } from "./replay";
import type { Finding } from "./review";
import { ROLES, type AuthorKind, type PostKind, type ProjectState, type Role, type TicketState } from "./states";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Events this close together, about one ticket, come from one action: a verdict and the move it causes, say. */
const SAME_ACTION_MS = 2_000;
const IN_FLIGHT: readonly TicketState[] = ["working", "checking", "review", "approved", "merging"];
const TOP_TICKETS = 5;

/** A sentence in parts, so the page can set code, quotes, times in the reader's own clock and links in their own style. */
export type Part = string | { code: string } | { quote: string } | { at: number; date?: boolean } | { link: InsightsFilter; text: string };
export type Phrase = Part[];
export type InsightsFilter = "story" | "problems" | "you" | "all";
export type InsightsWindow = "all" | "run" | "day" | { from: number; to: number };
/** What a line is: your action, a problem, a fix round, a ticket shipping or reaching a pull request, a step, or detail. */
export type LineTone = "you" | "bad" | "back" | "done" | "pr" | "step" | "made" | "milestone" | "detail";

export interface EventLine {
  id: number;
  at: number;
  key: string | null;
  tone: LineTone;
  text: Phrase;
  problem: boolean;
  you: boolean;
}

export interface Chip {
  text: string;
  tone: "" | "warn" | "bad" | "you";
}

export type StoryItem =
  | {
      type: "chapter";
      key: string;
      title: string;
      /** Its first and last event in this group. */
      first: number;
      at: number;
      tone: "ok" | "fixed" | "going" | "blocked" | "pr" | "quiet";
      head: string;
      says: Phrase[];
      parts: Array<{ from: number; to: number; state: TicketState }>;
      ms: number;
      chips: Chip[];
      /** Ids of its lines in the group's `lines`, oldest first. */
      steps: number[];
      trouble: boolean;
    }
  | { type: "created"; at: number; by: Phrase; tickets: Array<{ key: string; title: string }> }
  | { type: "note"; at: number; tone: "you" | "bad" | "milestone"; text: Phrase };

export interface StoryGroup {
  state: ProjectState;
  title: string;
  from: number;
  to: number;
  /** The newest group of a running or paused project. */
  current: boolean;
  why: Phrase | null;
  shipped: number;
  troubled: number;
  items: StoryItem[];
  /** Every event in the group as one line, oldest first; an action that wrote several events reads as one. */
  lines: EventLine[];
}

export interface CurrentItem {
  kind: "blocked" | "held" | "pr";
  key: string;
  title: string;
  state: TicketState;
  since: number;
  reason: string | null;
  reviewRound: number;
  prUrl: string | null;
  prRounds: number;
}

export interface ActivityMark {
  at: number;
  kind: "done" | "pr" | "back" | "bad" | "you" | "milestone";
  key: string | null;
  text: string;
}

export interface InsightsNumbers {
  /** On the pull request strategy Loom's part of a ticket ends when its pull request opens; people merge it. */
  goal: "shipped" | "pr";
  reached: number;
  cycle: Array<{ key: string; ms: number }>;
  cycleP50: number | null;
  cycleP85: number | null;
  leadP50: number | null;
  leadP85: number | null;
  /** Milliseconds in each state over the tickets that reached the goal, from creation (as queued) to the goal. */
  time: Partial<Record<TicketState, number>>;
  maxWorkers: number;
  prWait: { p50: number | null; max: number | null; n: number };
  firstTry: Array<{ key: string; clean: boolean; rounds: number }>;
  findings: { total: number; blocking: number };
  checks: { runs: number; failed: number; outside: number; commands: Array<{ command: string; runs: number; failed: number; p50Ms: number | null }> };
  prFeedback: number;
  /** Tokens are one running total per thread, so they always cover the whole project. */
  tokens: { total: number; byRole: Record<Role, number>; perReached: number | null; unreported: number; byTicket: Array<{ key: string; tokens: number }>; budget: number | null };
  you: EventLine[];
  interventions: number;
  wrong: { sentBack: number; byReview: number; byChecks: number; byMerge: number; byPr: number; blocked: number; mergesFailed: number; retries: number; outside: number; failedAttempts: number | null; timeouts: number | null };
  runningMs: number;
  runs: number;
}

export interface ProjectInsights {
  state: ProjectState;
  strategy: "integration" | "pr";
  start: number;
  end: number;
  now: number;
  /** The stretch shown, or null for the whole project. */
  window: InsightsWindow;
  range: { from: number; to: number } | null;
  presets: { run: boolean; day: boolean };
  headline: string;
  lines: Phrase[];
  figures: Array<{ label: string; value: string; note: string }>;
  activity: { start: number; end: number; times: number[]; marks: ActivityMark[]; flight: Array<[at: number, count: number]>; spans: Array<{ from: number; to: number; state: ProjectState }> };
  current: CurrentItem[];
  groups: StoryGroup[];
  numbers: InsightsNumbers;
}

interface Post {
  kind: PostKind;
  author: AuthorKind;
  line: string;
  data: Record<string, unknown>;
}

interface Ev {
  row: EventRow;
  id: number;
  at: number;
  kind: string;
  actor: string;
  key: string | null;
  d: Record<string, unknown>;
  post: Post | null;
  tone: LineTone;
  dup: boolean;
}

interface Run {
  command: string;
  exitCode: number;
  timedOut: boolean;
  durationMs?: number;
}

const str = (value: unknown) => (typeof value === "string" ? value : null);
const num = (value: unknown) => (typeof value === "number" ? value : null);
const runsOf = (post: Post | null): Run[] => (Array.isArray(post?.data.runs) ? (post!.data.runs as Run[]) : []);
const failedRun = (run: Run) => run.exitCode !== 0 || run.timedOut === true;
const countOf = (value: unknown) => (Array.isArray(value) ? value.length : 0);
const dur = (ms: number) => formatDuration(ms);
const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const word = (n: number) => (n <= 10 ? WORDS[n]! : String(n));
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
const listText = (items: readonly string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const big = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** Whitespace folded and cut to `max` characters at a word. */
export function clipText(text: string | null | undefined, max = 140): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The text of a phrase, for search and for hover titles. */
export function phraseText(phrase: Phrase): string {
  return phrase.map((part) => (typeof part === "string" ? part : "code" in part ? part.code : "quote" in part ? `“${part.quote}”` : "link" in part ? part.text : new Date(part.at).toISOString().slice(11, 16))).join("");
}

const prName = (url: string | null) => {
  const match = url === null ? null : /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url);
  return match === null ? (url ?? "") : `${match[1]}#${match[2]}`;
};
const sentBack = (from: unknown, to: unknown) => (to === "working" && (from === "review" || from === "checking" || from === "merging" || from === "pr_open")) || (to === "queued" && (from === "merging" || from === "pr_open"));
const firstLine = (body: string) => body.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";

function toneOf(ev: Ev): LineTone {
  const { d, post } = ev;
  switch (ev.kind) {
    case "human.action":
      return "you";
    case "ticket.state":
      if (d.to === "blocked") return "bad";
      if (sentBack(d.from, d.to)) return "back";
      if (d.to === "done") return "done";
      if (d.to === "pr_open" && d.from === "merging") return "pr";
      return "step";
    case "review.verdict":
      return d.verdict === "changes_requested" ? "back" : "step";
    case "turn.retry":
    case "record.failed":
    case "hook.failed":
      return "bad";
    case "ticket.created":
      return "made";
    case "post.added":
      if (post === null) return "detail";
      if ((post.kind === "check" && post.data.passed === false) || post.kind === "block" || (post.kind === "merge" && post.data.outcome === "merged_elsewhere")) return "bad";
      if (post.kind === "merge" && post.data.outcome === "pr_feedback") return "back";
      return "detail";
    case "spec.review.ended":
      return d.state === "approved" || d.state === "changes_requested" || d.state === "superseded" ? "milestone" : "bad";
    default:
      return "milestone";
  }
}

/** One action often writes several events; the story and the event list keep the most telling one. */
function markDuplicates(evs: Ev[]): void {
  const near = (ev: Ev, test: (other: Ev) => boolean) => evs.some((other) => other !== ev && other.key === ev.key && Math.abs(other.at - ev.at) < SAME_ACTION_MS && test(other));
  const check = (passed: boolean) => (other: Ev) => other.post?.kind === "check" && other.post.data.passed === passed;
  for (const ev of evs) {
    const { d, post } = ev;
    if (ev.kind === "ticket.state") {
      if (d.from === "review" && d.to === "working") ev.dup = near(ev, (other) => other.kind === "review.verdict" && other.d.verdict === "changes_requested");
      else if (d.from === "review" && d.to === "approved") ev.dup = near(ev, (other) => other.kind === "review.verdict" && other.d.verdict === "approved");
      else if (d.from === "checking" && d.to === "working") ev.dup = near(ev, check(false));
      else if (d.from === "checking" && d.to === "review") ev.dup = near(ev, check(true));
      else if (d.from === "working" && d.to === "checking") ev.dup = near(ev, (other) => other.post?.kind === "submit");
      else if (d.from === "merging" && d.to === "done") ev.dup = near(ev, (other) => other.post?.kind === "merge" && other.post.data.outcome === "merged");
    } else if (post?.kind === "claim") ev.dup = near(ev, (other) => other.kind === "ticket.state" && other.d.to === "working");
    // A review post repeats its verdict event, which names the findings.
    else if (post?.kind === "review") ev.dup = true;
    else if (post?.kind === "reply" && post.author === "human") ev.dup = evs.some((other) => other.kind === "human.action" && other.d.action === "post" && other.d.key === ev.key && Math.abs(other.at - ev.at) < SAME_ACTION_MS);
    else if (ev.kind === "project.landed") ev.dup = evs.some((other) => other.kind === "human.action" && other.d.action === "land" && Math.abs(other.at - ev.at) < SAME_ACTION_MS);
    else if (ev.kind === "project.state") ev.dup = evs.some((other) => other.kind === "human.action" && Math.abs(other.at - ev.at) < SAME_ACTION_MS && (other.d.action === "pause" || other.d.action === "resume" || other.d.action === "start" || other.d.action === "approve"));
  }
}

interface Ctx {
  evs: Ev[];
  keys: Map<number, string>;
  reviews: ReviewRow[];
  tickets: Map<string, TicketRow>;
  bars: Map<string, TicketBar>;
  now: number;
  live: boolean;
  pr: boolean;
}

const findingsOf = (ctx: Ctx, key: string | null, round: unknown): Finding[] =>
  ctx.reviews.filter((review) => review.verdict !== "pending" && review.round === round && ctx.tickets.get(key ?? "")?.id === review.ticket_id).flatMap((review) => JSON.parse(review.findings_json) as Finding[]);

function checkLine(post: Post): Phrase {
  const runs = runsOf(post);
  const ms = runs.reduce((sum, run) => sum + (run.durationMs ?? 0), 0);
  if (post.data.passed === true) {
    const outside = countOf(post.data.outside);
    return [`Checks passed: ${plural(runs.length, "command")} in ${dur(ms)}${outside > 0 ? `, ${plural(outside, "file")} outside its scope` : ""}.`];
  }
  const failed = runs.filter(failedRun);
  if (failed.length === 0) return [clipText(post.line, 200)];
  const phrase: Phrase = ["Checks failed: "];
  failed.forEach((run, index) => {
    if (index > 0) phrase.push(", ");
    phrase.push({ code: clipText(run.command, 80) }, run.timedOut ? " timed out" : ` exited ${run.exitCode}`);
  });
  phrase.push(".");
  return phrase;
}

/** One sentence for an event. A ticket's key is the line's own field, so its sentence leaves it out. */
function lineOf(ev: Ev, ctx: Ctx): Phrase {
  const { d, post } = ev;
  const quote = (text: string, max = 160): Part => ({ quote: clipText(text, max) });
  if (ev.kind === "post.added" && post !== null) {
    const who = post.author === "reviewer" ? "The reviewer" : post.author === "planner" ? "The planner" : post.author === "human" ? "You" : post.author === "loom" ? "Loom" : "The worker";
    switch (post.kind) {
      case "claim":
        return [`A worker picked it up${post.line === "" ? "" : `: ${clipText(post.line, 80).replace(/\.$/, "")}`}.`];
      case "note":
        return [`${who} noted `, quote(post.line)];
      case "submit":
        return ["The worker handed it in: ", quote(post.line)];
      case "check":
        return checkLine(post);
      case "review":
        return ["Review: ", quote(post.line)];
      case "block":
        return [`${who} stopped: `, quote(post.line, 220)];
      case "reply":
        return [`${who} replied `, quote(post.line)];
      case "brief":
        return ["The planner wrote its brief."];
      case "merge": {
        const outcome = str(post.data.outcome);
        const sha = str(post.data.sha);
        if (outcome === "merged") return [`Merged into `, { code: str(post.data.branch) ?? "the branch" }, ...(sha === null ? [] : [" at ", { code: sha.slice(0, 7) }]), "."];
        if (outcome === "pr_feedback") return ["The pull request got feedback, so a fix round started: ", quote(post.line)];
        return [clipText(post.line, 200)];
      }
      default:
        return [clipText(post.line, 200)];
    }
  }
  if (ev.kind === "ticket.state") {
    const { from, to } = d;
    const attempt = num(d.attempt);
    const round = num(d.round);
    const reason = str(d.reason);
    if (from === "queued" && to === "working") return [`A worker started${attempt === null ? "" : ` (attempt ${attempt})`}.`];
    if (from === "working" && to === "checking") return ["Handed in; Loom is running its checks."];
    if (from === "checking" && to === "review") return [round === null ? "Checks passed; review started." : `Checks passed; review round ${round} started.`];
    if (from === "checking" && to === "working") return ["Checks failed, so it went back to the worker."];
    if (from === "review" && to === "working") return ["A reviewer asked for changes, so it went back to the worker."];
    if (to === "approved") return [`Approved${round === null ? "" : ` in round ${round}`}.`];
    if (to === "merging") return [from === "pr_open" ? "Catching up with the work it builds on." : "Merging."];
    if (from === "merging" && to === "done") return ["Merged: done."];
    if (from === "pr_open" && to === "done") return ["Its pull request merged: done."];
    if (to === "pr_open") return [from === "checking" ? "The fix changed nothing, so the pull request stays as it is." : from === "merging" ? "Pull request open." : "Back on its pull request."];
    if (from === "pr_open" && to === "working") return ["Feedback on the pull request sent it back to the worker."];
    if (from === "pr_open" && to === "queued") return ["Feedback on the pull request queued a fix round for a new worker."];
    if (from === "merging" && to === "queued") return [`The merge failed, so it went back to the queue${reason === null ? "." : `: ${clipText(reason, 140)}`}`];
    if (from === "merging" && to === "working") return [`The merge sent it back to the worker${reason === null ? "." : `: ${clipText(reason, 140)}`}`];
    if (to === "blocked") return reason === null ? ["Blocked."] : ["Blocked: ", quote(reason, 220)];
    if (from === "blocked" && to === "queued") return ["Requeued."];
    if (from === "blocked" && to === "review") return ["Back in review as it was, for the same commit."];
    if (to === "cancelled") return ["Cancelled."];
  }
  if (ev.kind === "review.verdict") {
    const findings = findingsOf(ctx, ev.key, d.round);
    if (d.verdict === "approved") return [`A reviewer approved it in round ${d.round}${findings.length > 0 ? ` with ${plural(findings.length, "note")}` : ""}.`];
    const blocking = findings.filter((finding) => finding.severity === "blocking");
    const first = blocking[0] ?? findings[0];
    const count = findings.length === 0 ? "" : ` (${plural(findings.length, "finding")}${blocking.length > 0 ? `, ${blocking.length} blocking` : ""})`;
    return first === undefined ? [`A reviewer asked for changes in round ${d.round}${count}.`] : [`A reviewer asked for changes in round ${d.round}${count}: `, quote(first.title, 120)];
  }
  if (ev.kind === "human.action") {
    const action = d.action;
    const target = str(d.key);
    if (action === "approve") return [d.skipReview === true ? "You approved the spec without a passed spec review." : "You approved the spec."];
    if (action === "start") return ["You started the project."];
    if (action === "pause") return [d.now === true ? "You paused the project at once (pause now)." : "You paused the project."];
    if (action === "resume") return ["You resumed the project."];
    if (action === "land") {
      const landed = ctx.evs.find((other) => other.kind === "project.landed" && Math.abs(other.at - ev.at) < SAME_ACTION_MS);
      if (landed?.d.direct === true) return ["You landed the work: pushed to ", { code: str(landed.d.pushed) ?? "its base" }, " at ", { code: String(landed.d.sha ?? "").slice(0, 7) }, "."];
      if (landed !== undefined) return [`You landed the integration branch: ${str(landed.d.url) ?? ""}.`];
      return [d.direct === true ? "You landed the work straight to its base." : "You landed the integration branch."];
    }
    if (action === "post") {
      const reply = ctx.evs.find((other) => other.post?.kind === "reply" && other.post.author === "human" && other.key === target && Math.abs(other.at - ev.at) < SAME_ACTION_MS);
      return reply === undefined ? [`You replied on ${target}.`] : [`You replied on ${target}: `, quote(reply.post!.line, 120)];
    }
    if (action === "requeue" || action === "block" || action === "cancel") return [`You ran ${action}${target === null ? "" : ` on ${target}`}.`];
    if (action === "report") return ["You sent the project's record to the done hook."];
    if (action === "archive") return ["You archived the project."];
  }
  if (ev.kind === "ticket.created") return ["Created."];
  if (ev.kind === "ticket.edited") return [`Edited: ${Array.isArray(d.fields) ? d.fields.join(", ") : "its fields"}.`];
  if (ev.kind === "planner.asked") {
    const steps = Array.isArray(d.steps) ? (d.steps as Array<{ text?: unknown }>).map((step) => String(step.text ?? "")) : [];
    return steps.length === 0 ? ["The planner cleared its asks."] : ["The planner asked you to: ", { quote: clipText(steps.join(" "), 220) }];
  }
  return [feedText(ev.row, ctx.keys, { you: true })];
}

function lineFor(ev: Ev, ctx: Ctx): EventLine {
  return { id: ev.id, at: ev.at, key: ev.key, tone: ev.tone, text: lineOf(ev, ctx), problem: ev.tone === "bad" || ev.tone === "back", you: ev.kind === "human.action" };
}

// ---- the story: a group per stretch of the project's state, a chapter per ticket in each

interface Span {
  from: number;
  to: number;
  state: ProjectState;
}

interface Stretch extends Span {
  /** The project.state event that began it; the stretch holds the events from it up to the next stretch's. */
  firstId: number;
}

/**
 * The project's stretches by its project.state events, in event order: one transaction can write a ticket and the move
 * that starts a run in the same millisecond, so times alone cannot split them. Draft and ready read as one stretch of
 * planning, and two stretches in the same state as one.
 */
function stretchesOf(evs: readonly Ev[], start: number, end: number): Stretch[] {
  const raw: Stretch[] = [{ from: start, to: end, state: "draft", firstId: -Infinity }];
  for (const ev of evs) {
    if (ev.kind !== "project.state") continue;
    raw.at(-1)!.to = ev.at;
    raw.push({ from: ev.at, to: end, state: ev.d.to as ProjectState, firstId: ev.id });
  }
  const planning = (state: ProjectState) => state === "draft" || state === "ready";
  const out: Stretch[] = [];
  for (const stretch of raw) {
    const before = out.at(-1);
    if (before !== undefined && (before.state === stretch.state || (planning(before.state) && planning(stretch.state)))) before.to = stretch.to;
    else out.push({ ...stretch });
  }
  return out;
}

function stateAt(ctx: Ctx, key: string, at: number): TicketState {
  let state: TicketState = "queued";
  for (const ev of ctx.evs) {
    if (ev.at > at) break;
    if (ev.key === key && ev.kind === "ticket.state") state = ev.d.to as TicketState;
  }
  return state;
}

const STATE_WORD: Record<TicketState, string> = { queued: "Waiting", working: "Being built", checking: "Running checks", review: "In review", approved: "Approved", merging: "Merging", pr_open: "Pull request open", blocked: "Blocked", done: "Shipped", cancelled: "Cancelled" };

function chapterOf(ctx: Ctx, key: string, events: Ev[], group: { to: number; current: boolean; state: ProjectState }): StoryItem {
  const ticket = ctx.tickets.get(key)!;
  const first = events[0]!.at;
  const last = events.at(-1)!.at;
  const end = stateAt(ctx, key, last);
  const moves = events.filter((ev) => ev.kind === "ticket.state");
  const verdicts = events.filter((ev) => ev.kind === "review.verdict");
  const changes = verdicts.filter((ev) => ev.d.verdict === "changes_requested");
  const approved = verdicts.filter((ev) => ev.d.verdict === "approved");
  const failedChecks = events.filter((ev) => ev.post?.kind === "check" && ev.post.data.passed === false);
  const feedback = events.filter((ev) => ev.post?.kind === "merge" && ev.post.data.outcome === "pr_feedback");
  const blocks = moves.filter((ev) => ev.d.to === "blocked");
  const mergeBack = moves.filter((ev) => ev.d.from === "merging" && (ev.d.to === "working" || ev.d.to === "queued"));
  const yours = events.filter((ev) => ev.kind === "human.action");
  const merged = events.find((ev) => ev.post?.kind === "merge" && ev.post.data.outcome === "merged");
  const started = moves.some((ev) => ev.d.from === "queued" && ev.d.to === "working");
  const created = events.some((ev) => ev.kind === "ticket.created");
  const shippedHere = moves.some((ev) => ev.d.to === "done");
  const bar = ctx.bars.get(key);
  const fixes = changes.length + failedChecks.length + feedback.length + mergeBack.length;
  // A ticket sent back in an earlier stretch still shipped after fixes.
  const fixedBefore = ctx.evs.filter(
    (ev) =>
      ev.key === key &&
      ev.at < first &&
      ((ev.kind === "review.verdict" && ev.d.verdict === "changes_requested") || (ev.post?.kind === "check" && ev.post.data.passed === false) || (ev.post?.kind === "merge" && ev.post.data.outcome === "pr_feedback") || (ev.kind === "ticket.state" && ev.d.from === "merging" && (ev.d.to === "working" || ev.d.to === "queued"))),
  ).length;
  const flying = IN_FLIGHT.includes(end);

  let tone: Extract<StoryItem, { type: "chapter" }>["tone"] = "going";
  let head = group.current ? `${STATE_WORD[end]} now` : `Still ${STATE_WORD[end].toLowerCase()} when this ${group.state === "running" ? "run" : "stretch"} ended`;
  if (end === "done") {
    tone = fixes + fixedBefore > 0 ? "fixed" : "ok";
    head = !shippedHere ? "Done" : fixes + fixedBefore > 0 ? "Shipped after fixes" : "Shipped on the first try";
  } else if (end === "blocked") {
    tone = "blocked";
    head = "Blocked";
  } else if (end === "pr_open") {
    tone = "pr";
    head = "Pull request open";
  } else if (end === "cancelled") {
    tone = "quiet";
    head = "Cancelled";
  } else if (end === "queued") {
    tone = "quiet";
    head = created && !started ? "Created" : "Waiting";
  }

  const says: Phrase[] = [];
  if (changes.length > 0) {
    const finding = findingsOf(ctx, key, changes[0]!.d.round)[0];
    const lead = changes.length === 1 ? `A reviewer asked for changes in round ${changes[0]!.d.round}` : `Reviewers asked for changes in ${changes.length} rounds`;
    says.push(finding === undefined ? [`${lead}.`] : [`${lead}: `, { quote: clipText(finding.title, 110) }, "."]);
  }
  if (failedChecks.length > 0) {
    const commands = [...new Set(failedChecks.flatMap((ev) => runsOf(ev.post).filter(failedRun).map((run) => run.command)))];
    says.push(commands.length === 0 ? [`Checks failed ${times(failedChecks.length)}.`] : [`Checks failed ${times(failedChecks.length)} (`, { code: clipText(commands[0], 60) }, commands.length > 1 ? ` and ${commands.length - 1} more).` : ")."]);
  }
  if (mergeBack.length > 0) says.push([`The merge sent it back ${times(mergeBack.length)}.`]);
  if (fixedBefore > 0 && end === "done" && shippedHere) says.push([`It was sent back ${times(fixedBefore)} before this stretch.`]);
  if (feedback.length > 0) says.push([`${cap(plural(feedback.length, "fix round"))} from pull request feedback.`]);
  if (end === "blocked") {
    const why = str(blocks.at(-1)?.d.reason) ?? ticket.blocked_reason ?? events.filter((ev) => ev.post?.kind === "block").at(-1)?.post?.line ?? null;
    says.push(why === null ? ["It waits for you."] : [{ quote: clipText(why, 200) }]);
  } else if (blocks.length > 0) says.push([`Blocked ${times(blocks.length)}, then requeued.`]);
  if (end === "done" && shippedHere) {
    const doneAt = moves.filter((ev) => ev.d.to === "done").at(-1)!.at;
    const round = approved.at(-1)?.d.round;
    says.push([`${round === undefined ? "Merged" : `Approved in round ${round}, merged`} at `, { at: merged?.at ?? doneAt }, "."]);
  }
  if (end === "pr_open" && ticket.pr_url !== null) says.push(["Its pull request is ", { code: prName(ticket.pr_url) }, "."]);
  // A time, not a length, so the sentence stays true between events.
  if (flying && group.current && ctx.live) says.push([`${STATE_WORD[end]} since `, { at: last }, "."]);
  if ((flying || end === "pr_open") && !group.current) says.push(["It carried on in the next stretch."]);
  if (says.length === 0 && end === "done") says.push(["Checks passed and a reviewer approved it in round 1."]);
  if (!started && !created && bar !== undefined && bar.from < first && end !== "done") says.push(["Started ", { at: bar.from, date: true }, "."]);

  const from = bar === undefined ? first : Math.max(bar.from, first);
  const to = flying || end === "blocked" || end === "pr_open" ? Math.max(last, Math.min(group.to, ctx.now)) : last;
  const parts = (bar?.parts ?? []).map((part) => ({ ...part, from: Math.max(part.from, from), to: Math.min(part.to, to) })).filter((part) => part.to > part.from);
  const chips: Chip[] = [];
  const rounds = Math.max(0, ...verdicts.map((ev) => num(ev.d.round) ?? 0));
  if (rounds > 1 || changes.length > 0) chips.push({ text: plural(rounds, "review round"), tone: changes.length > 0 ? "warn" : "" });
  if (failedChecks.length > 0) chips.push({ text: plural(failedChecks.length, "failed check"), tone: "bad" });
  if (feedback.length > 0) chips.push({ text: plural(feedback.length, "PR fix round"), tone: "warn" });
  if (yours.length > 0) chips.push({ text: yours.length === 1 ? "you stepped in" : `you stepped in ${yours.length} times`, tone: "you" });
  if (ticket.repo !== null) chips.push({ text: ticket.repo, tone: "" });
  const steps = events.filter((ev) => !ev.dup && !(ev.kind === "ticket.state" && ev.d.to === "merging" && ev.d.from !== "pr_open")).map((ev) => ev.id);
  return {
    type: "chapter",
    key,
    title: ticket.title,
    first,
    at: last,
    tone,
    head,
    says,
    parts,
    ms: parts.length > 0 ? parts.at(-1)!.to - parts[0]!.from : last - first,
    chips,
    steps,
    trouble: fixes + blocks.length > 0,
  };
}

const NOTE_KINDS = new Set(["spec.proposed", "spec.revised", "spec.approved", "spec.review.ended", "spec.review.skipped", "project.created", "record.sent", "record.failed", "triage.sent", "planner.asked", "hook.told", "hook.ran", "hook.failed"]);

function itemsOf(ctx: Ctx, group: { to: number; current: boolean; state: ProjectState }, events: Ev[]): StoryItem[] {
  const items: StoryItem[] = [];
  const byTicket = new Map<string, Ev[]>();
  const made = events.filter((ev) => ev.kind === "ticket.created" && ev.key !== null);
  if (made.length > 0) {
    const approval = ctx.evs.some((ev) => (ev.kind === "spec.approved" || (ev.kind === "human.action" && ev.d.action === "approve")) && Math.abs(ev.at - made[0]!.at) < SAME_ACTION_MS);
    const by = made[0]!.actor === "human" ? (approval ? "from the spec you approved" : "by you") : "by the planner";
    items.push({ type: "created", at: made.at(-1)!.at, by: [by], tickets: made.map((ev) => ({ key: ev.key!, title: ctx.tickets.get(ev.key!)?.title ?? "" })) });
  }
  for (const ev of events) {
    if (ev.key !== null && ctx.tickets.has(ev.key)) {
      if (!byTicket.has(ev.key)) byTicket.set(ev.key, []);
      byTicket.get(ev.key)!.push(ev);
      continue;
    }
    if (ev.dup) continue;
    if (ev.kind === "project.state") {
      if (ev.d.to === "done") items.push({ type: "note", at: ev.at, tone: "milestone", text: ["Every ticket is done or cancelled: the project is done."] });
      continue;
    }
    if (ev.kind === "human.action") {
      // Starts, pauses and resumes are where the groups begin and end.
      if (ev.d.action === "start" || ev.d.action === "pause" || ev.d.action === "resume") continue;
      items.push({ type: "note", at: ev.at, tone: "you", text: lineOf(ev, ctx) });
      continue;
    }
    if (ev.kind === "planner.asked" && countOf(ev.d.steps) === 0) continue;
    if (ev.tone === "bad") items.push({ type: "note", at: ev.at, tone: "bad", text: lineOf(ev, ctx) });
    else if (NOTE_KINDS.has(ev.kind) || ev.kind === "project.landed") items.push({ type: "note", at: ev.at, tone: "milestone", text: lineOf(ev, ctx) });
  }
  for (const [key, own] of byTicket) {
    // A ticket that was only created here, with its brief, is already in the created item.
    if (own.every((ev) => ev.kind === "ticket.created" || ev.kind === "ticket.edited" || ev.post?.kind === "brief")) continue;
    items.push(chapterOf(ctx, key, own, group));
  }
  return items.sort((a, b) => a.at - b.at);
}

function groupTitle(state: ProjectState, run: number | null, current: boolean, runs: number): string {
  if (state === "draft" || state === "ready") return "Planning";
  if (state === "running") return `${current ? "Running now" : "Run"}${runs > 1 && run !== null ? ` ${run}` : ""}`;
  if (state === "paused") return current ? "Paused now" : "Paused";
  if (state === "done") return "Finished";
  return cap(state);
}

function pausedBy(ctx: Ctx, at: number): Phrase | null {
  const move = ctx.evs.find((ev) => ev.kind === "project.state" && ev.d.to === "paused" && Math.abs(ev.at - at) < SAME_ACTION_MS);
  if (move === undefined) return null;
  if (move.actor === "human") return [move.d.reason === "pause --now" ? "you paused it at once" : "you paused it"];
  const reason = str(move.d.reason);
  return [`Loom paused it${reason === null ? "" : `: ${clipText(reason, 100)}`}`];
}

// ---- numbers, for the whole project or one stretch

function numbersOf(ctx: Ctx, rows: ProjectRows, range: { from: number; to: number } | null, spans: Span[], maxWorkers: number, budget: number | null): InsightsNumbers {
  const inside = (at: number) => range === null || (at >= range.from && at <= range.to);
  const evs = ctx.evs.filter((ev) => inside(ev.at));
  // On the pull request strategy a ticket's own work ends when its pull request first opens.
  const goalAt = (bar: TicketBar): number | null => {
    if (ctx.pr) {
      const opened = ctx.evs.find((ev) => ev.key === bar.key && ev.kind === "ticket.state" && ev.d.from === "merging" && ev.d.to === "pr_open");
      if (opened !== undefined) return opened.at;
    }
    return bar.final === "done" ? bar.to : null;
  };
  const reached = [...ctx.bars.values()].flatMap((bar) => {
    const at = goalAt(bar);
    return at !== null && inside(at) ? [{ bar, at, createdAt: ctx.tickets.get(bar.key)?.created_at ?? bar.from }] : [];
  });
  const cycle = reached.map(({ bar, at }) => ({ key: bar.key, ms: at - bar.from })).sort((a, b) => a.ms - b.ms);
  const lead = reached.map(({ at, createdAt }) => at - createdAt);
  const time: Partial<Record<TicketState, number>> = {};
  for (const { bar, at, createdAt } of reached) {
    time.queued = (time.queued ?? 0) + Math.max(0, bar.from - createdAt);
    for (const part of bar.parts) if (part.from < at) time[part.state] = (time[part.state] ?? 0) + (Math.min(part.to, at) - part.from);
  }
  // A pull request that opened before the stretch still waited during it, so each part counts its overlap.
  const overlap = (part: { from: number; to: number }) => Math.max(0, Math.min(part.to, range?.to ?? Infinity) - Math.max(part.from, range?.from ?? -Infinity));
  const prWaits = ctx.pr ? [...ctx.bars.values()].map((bar) => bar.parts.filter((part) => part.state === "pr_open").reduce((sum, part) => sum + overlap(part), 0)).filter((ms) => ms > 0) : [];

  // A ticket passes at the first try when its first round with a verdict asked for no changes and it was approved. A stretch
  // counts the tickets with a verdict in it, judged on every verdict up to its end, so a fix before the stretch still counts.
  const decided = rows.reviews.filter((review) => review.verdict !== "pending" && review.at <= (range?.to ?? Infinity));
  const shown = new Set(decided.filter((review) => inside(review.at)).map((review) => review.ticket_id));
  const byTicket = new Map<number, ReviewRow[]>();
  for (const review of decided) if (shown.has(review.ticket_id)) byTicket.set(review.ticket_id, [...(byTicket.get(review.ticket_id) ?? []), review]);
  const firstTry = [...byTicket].flatMap(([ticketId, reviews]) => {
    const ticket = rows.tickets.find((row) => row.id === ticketId);
    if (ticket === undefined) return [];
    const round = Math.min(...reviews.map((review) => review.round));
    const clean = !reviews.some((review) => review.round === round && review.verdict === "changes_requested");
    return [{ key: ticket.key, clean: clean && ["approved", "merging", "pr_open", "done"].includes(ticket.state), rounds: Math.max(...reviews.map((review) => review.round)) }];
  });
  const findings = rows.reviews.filter((review) => review.verdict !== "pending" && inside(review.at)).flatMap((review) => JSON.parse(review.findings_json) as Finding[]);

  const checkPosts = evs.filter((ev) => ev.post?.kind === "check");
  const runs = checkPosts.flatMap((ev) => runsOf(ev.post));
  const byCommand = new Map<string, Run[]>();
  for (const run of runs) byCommand.set(run.command, [...(byCommand.get(run.command) ?? []), run]);
  const commands = [...byCommand]
    .map(([command, list]) => ({ command, runs: list.length, failed: list.filter(failedRun).length, p50Ms: percentile(list.flatMap((run) => (typeof run.durationMs === "number" ? [run.durationMs] : [])), 50) }))
    .sort((a, b) => b.failed - a.failed || b.runs - a.runs || a.command.localeCompare(b.command));

  const you = evs.filter((ev) => ev.kind === "human.action");
  const moves = evs.filter((ev) => ev.kind === "ticket.state");
  const tokens = Object.fromEntries(ROLES.map((role) => [role, 0])) as Record<Role, number>;
  for (const thread of rows.threads) tokens[thread.role] += thread.tokens ?? 0;
  const total = ROLES.reduce((sum, role) => sum + tokens[role], 0);
  const goalCount = [...ctx.bars.values()].filter((bar) => goalAt(bar) !== null).length;
  let runningMs = 0;
  let runCount = 0;
  for (const span of spans) {
    if (span.state !== "running") continue;
    const from = Math.max(span.from, range?.from ?? -Infinity);
    const to = Math.min(span.to, range?.to ?? Infinity);
    if (to > from || (range === null && span.to >= span.from)) runCount += 1;
    runningMs += Math.max(0, to - from);
  }
  return {
    goal: ctx.pr ? "pr" : "shipped",
    reached: reached.length,
    cycle,
    cycleP50: percentile(cycle.map((entry) => entry.ms), 50),
    cycleP85: percentile(cycle.map((entry) => entry.ms), 85),
    leadP50: percentile(lead, 50),
    leadP85: percentile(lead, 85),
    time,
    maxWorkers,
    prWait: { p50: percentile(prWaits, 50), max: prWaits.length === 0 ? null : Math.max(...prWaits), n: prWaits.length },
    firstTry,
    findings: { total: findings.length, blocking: findings.filter((finding) => finding.severity === "blocking").length },
    checks: { runs: checkPosts.length, failed: checkPosts.filter((ev) => ev.post!.data.passed === false).length, outside: checkPosts.filter((ev) => countOf(ev.post!.data.outside) > 0).length, commands },
    prFeedback: evs.filter((ev) => ev.post?.kind === "merge" && ev.post.data.outcome === "pr_feedback").length,
    tokens: {
      total,
      byRole: tokens,
      perReached: goalCount === 0 ? null : total / goalCount,
      unreported: rows.threads.filter((thread) => thread.tokens === null && (thread.state === "ended" || ctx.now - thread.started_at >= MIN)).length,
      byTicket: tokensByTicket(rows.tickets, rows.threads),
      budget,
    },
    you: you.filter((ev) => !ev.dup).map((ev) => lineFor(ev, ctx)),
    interventions: you.filter((ev) => ev.d.action !== "start" && !(ev.d.action === "approve" && ev.d.pending !== true)).length,
    wrong: {
      sentBack: moves.filter((ev) => sentBack(ev.d.from, ev.d.to)).length,
      byReview: moves.filter((ev) => ev.d.from === "review" && ev.d.to === "working").length,
      byChecks: moves.filter((ev) => ev.d.from === "checking" && ev.d.to === "working").length,
      byMerge: moves.filter((ev) => ev.d.from === "merging" && (ev.d.to === "working" || ev.d.to === "queued")).length,
      byPr: moves.filter((ev) => ev.d.from === "pr_open" && (ev.d.to === "working" || ev.d.to === "queued")).length,
      blocked: moves.filter((ev) => ev.d.to === "blocked").length,
      mergesFailed: moves.filter((ev) => ev.d.from === "merging" && (ev.d.to === "working" || ev.d.to === "queued")).length,
      retries: evs.filter((ev) => ev.kind === "turn.retry").length,
      outside: checkPosts.filter((ev) => countOf(ev.post!.data.outside) > 0).length,
      failedAttempts: range === null ? rows.tickets.reduce((sum, ticket) => sum + ticket.failures, 0) : null,
      timeouts: range === null ? rows.threads.filter((thread) => thread.end_reason === "timeout").length : null,
    },
    runningMs,
    runs: runCount,
  };
}

function tokensByTicket(tickets: TicketRow[], threads: ThreadRow[]): Array<{ key: string; tokens: number }> {
  return tickets
    .map((ticket) => ({ key: ticket.key, tokens: threads.filter((thread) => thread.ticket_id === ticket.id).reduce((sum, thread) => sum + (thread.tokens ?? 0), 0) }))
    .filter((entry) => entry.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key))
    .slice(0, TOP_TICKETS);
}

// ---- the summary at the top

function summaryOf(ctx: Ctx, rows: ProjectRows, n: InsightsNumbers, range: { from: number; to: number } | null): { headline: string; lines: Phrase[] } {
  const counts: Partial<Record<TicketState, number>> = {};
  for (const ticket of rows.tickets) counts[ticket.state] = (counts[ticket.state] ?? 0) + 1;
  const all = rows.tickets.length;
  const done = counts.done ?? 0;
  const blocked = counts.blocked ?? 0;
  const prs = counts.pr_open ?? 0;
  const cancelled = counts.cancelled ?? 0;
  const flying = IN_FLIGHT.reduce((sum, state) => sum + (counts[state] ?? 0), 0);
  const state = rows.project.state;
  const finished = ctx.pr ? "merged" : "shipped";
  let headline: string;
  if (all === 0) headline = state === "draft" ? "Planning: no ticket exists until you approve the spec." : "No ticket yet.";
  else if (range !== null) {
    const goal = n.goal === "pr" ? `${plural(n.reached, "ticket")} reached a pull request` : `${plural(n.reached, "ticket")} shipped`;
    headline = `${n.reached === 0 ? (n.goal === "pr" ? "No ticket reached a pull request" : "Nothing shipped") : goal} in this stretch${n.wrong.sentBack > 0 ? `; ${word(n.wrong.sentBack)} ${n.wrong.sentBack === 1 ? "was" : "were"} sent back for a fix` : ""}.`;
  } else if (state === "done" || state === "archived") headline = `${done === all - cancelled ? `All ${all - cancelled} tickets ${finished}` : `${done} of ${all} tickets ${finished}`} in ${dur(n.runningMs)} of running.`;
  else if (blocked > 0) headline = `${state === "paused" ? "Paused" : "Running"}: ${plural(blocked, "ticket")} ${blocked === 1 ? "is" : "are"} blocked and ${blocked === 1 ? "needs" : "need"} you.`;
  else if (state === "running" && done === 0 && prs === 0) headline = `Running for ${dur(n.runningMs)}: ${flying === 0 ? "waiting for a worker" : flying === 1 ? "the first ticket is being worked on" : `${flying} tickets are being worked on`}.`;
  else if (state === "running") headline = `Running: ${done} of ${all} ${finished}${prs > 0 ? `, ${plural(prs, "pull request")} open` : ""}, ${flying} in flight now.`;
  else if (state === "draft" || state === "ready") headline = state === "draft" ? "Planning: the spec waits for your review." : "Ready: start the project to begin.";
  else headline = `Paused: ${done} of ${all} ${finished}${prs > 0 ? `, ${plural(prs, "pull request")} open` : ""}.`;

  const lines: Phrase[] = [];
  const reviewed = n.firstTry.length;
  const clean = n.firstTry.filter((entry) => entry.clean).length;
  if (reviewed > 0) {
    const most = Math.max(...n.firstTry.map((entry) => entry.rounds));
    const again = most > 2 ? `, one of them ${most - 1} times` : "";
    if (clean === reviewed) lines.push([reviewed === 1 ? "The one reviewed ticket passed review on the first try." : "Every reviewed ticket passed review on the first try."]);
    else if (clean === 0) lines.push([{ link: "problems", text: reviewed === 1 ? "The one reviewed ticket" : reviewed === 2 ? "Both reviewed tickets" : `All ${reviewed} reviewed tickets` }, ` went back for a fix after review${again}.`]);
    else lines.push([{ link: "problems", text: `${cap(word(reviewed - clean))} of ${reviewed}` }, ` went back for a fix after review${again}; the other ${clean} passed on the first try.`]);
  }
  if (n.checks.runs > 0) {
    const failing = n.checks.commands.filter((command) => command.failed > 0);
    if (n.checks.failed === 0) lines.push([`Checks passed every time, in ${plural(n.checks.runs, "run")}.`]);
    else if (failing.length === 1) lines.push([`Checks failed ${times(n.checks.failed)} in ${n.checks.runs} runs, ${n.checks.failed === 1 ? "in" : n.checks.failed === 2 ? "both in" : "all in"} `, { code: clipText(failing[0]!.command, 60) }, "."]);
    else lines.push([`Checks failed ${times(n.checks.failed)} in ${n.checks.runs} runs.`]);
  }
  if (n.prFeedback > 0) lines.push([`Pull request feedback started ${plural(n.prFeedback, "fix round")}.`]);
  const toGoal = n.goal === "pr" ? "its pull request" : "shipping";
  if (n.cycleP50 !== null && n.leadP50 !== null && n.leadP50 > 2 * n.cycleP50) {
    const total = Object.values(n.time).reduce((sum, ms) => sum + (ms ?? 0), 0);
    const waited = total > 0 && (n.time.queued ?? 0) / total > 0.4;
    lines.push([`A typical ticket took ${dur(n.cycleP50)} of work, but ${dur(n.leadP50)} from being created to ${toGoal}${waited ? ", because it waited for a free worker first" : ""}.`]);
  } else if (n.cycleP50 !== null) lines.push([`A typical ticket took ${dur(n.cycleP50)} from its first worker to ${toGoal}.`]);
  if (n.prWait.p50 !== null) lines.push([`Then its pull request waited on people for a typical ${dur(n.prWait.p50)}.`]);
  if (n.interventions > 0) {
    const kinds = new Map<string, number>();
    for (const line of n.you) {
      const ev = ctx.evs.find((other) => other.id === line.id)!;
      const action = String(ev.d.action);
      if (action === "start" || (action === "approve" && ev.d.pending !== true)) continue;
      kinds.set(action, (kinds.get(action) ?? 0) + 1);
    }
    const names: Record<string, [string, string]> = {
      pause: ["a pause", "pauses"],
      resume: ["a resume", "resumes"],
      post: ["a reply", "replies"],
      land: ["the land", "lands"],
      approve: ["an approval", "approvals"],
      notes: ["a set of spec notes", "sets of spec notes"],
      requeue: ["a requeue", "requeues"],
      block: ["a block", "blocks"],
      cancel: ["a cancel", "cancels"],
      dismissAsk: ["a dismissed ask", "dismissed asks"],
      message: ["a message to the planner", "messages to the planner"],
      report: ["a report sent to the done hook", "reports sent to the done hook"],
      archive: ["the archive", "archives"],
      plan: ["a new planning conversation", "new planning conversations"],
    };
    const list = [...kinds].map(([action, count]) => {
      const name = names[action] ?? [`one ${action}`, `${action} commands`];
      return count === 1 ? name[0] : `${count} ${name[1]}`;
    });
    lines.push([{ link: "you", text: `You stepped in ${times(n.interventions)}` }, list.length === 0 ? "." : `: ${listText(list)}.`]);
  }
  if (lines.length === 0) lines.push([ctx.evs.length === 0 ? "Nothing has happened yet." : "No ticket has reached review yet, so there is little to measure. The story below shows what the workers are doing."]);
  return { headline, lines };
}

function figuresOf(n: InsightsNumbers, start: number, end: number, range: { from: number; to: number } | null): ProjectInsights["figures"] {
  const clean = n.firstTry.filter((entry) => entry.clean).length;
  const days = Math.max(1, Math.round((end - start) / DAY));
  return [
    { label: "Running time", value: dur(n.runningMs), note: `over ${plural(n.runs, "run")}${range === null && days > 1 ? `, across ${plural(days, "day")}` : ""}` },
    {
      label: "A ticket takes",
      value: n.cycleP50 === null ? "—" : dur(n.cycleP50),
      note: n.cycleP50 === null ? `of work, once one ${n.goal === "pr" ? "reaches a pull request" : "ships"}` : `of work${n.goal === "pr" ? " to its pull request" : ""}, typically; most within ${dur(n.cycleP85!)}`,
    },
    { label: "Right first time", value: n.firstTry.length === 0 ? "—" : pct(clean / n.firstTry.length), note: n.firstTry.length === 0 ? "once a review has a verdict" : `${clean} of ${n.firstTry.length} passed their first review` },
    {
      label: "Tokens",
      value: n.tokens.total === 0 ? "—" : big(n.tokens.total),
      note: n.tokens.total === 0 ? "no thread has reported its usage yet" : n.tokens.perReached === null ? "sampled from the agents' threads" : `about ${big(Math.round(n.tokens.perReached))} per ${n.goal === "pr" ? "pull request" : "shipped ticket"}${range === null ? "" : "; whole project"}`,
    },
  ];
}

// ---- the whole view

/** The stretch a window names: the newest run, the last 24 hours, or the given times, cut to the project's life. */
export function rangeOf(window: InsightsWindow, spans: Array<{ from: number; to: number; state: ProjectState }>, start: number, end: number): { from: number; to: number } | null {
  if (window === "all") return null;
  if (window === "day") return { from: Math.max(start, end - DAY), to: end };
  if (window === "run") {
    const run = [...spans].reverse().find((span) => span.state === "running");
    return run === undefined ? null : { from: run.from, to: Math.max(run.to, run === spans.at(-1) ? end : run.to) };
  }
  const lo = Math.min(window.from, window.to);
  const hi = Math.max(window.from, window.to);
  const from = Math.max(start, lo);
  const to = Math.min(end, hi);
  // Outside the project's life the stretch is still the one asked for, and it holds nothing.
  return to < from ? { from: lo, to: hi } : { from, to };
}

export function projectInsights(rows: ProjectRows, a: { now: number; window?: InsightsWindow; strategy: "integration" | "pr"; maxWorkers: number; maxTokens: number | null }): ProjectInsights {
  const timeline = projectTimeline(rows, a.now);
  const tickets = new Map(rows.tickets.map((ticket) => [ticket.key, ticket]));
  const keyOf = new Map(rows.tickets.map((ticket) => [ticket.id, ticket.key]));
  const posts = new Map<number, PostRow>(rows.posts.map((post) => [post.id, post]));
  const evs: Ev[] = [...rows.events]
    .sort((x, y) => x.id - y.id)
    .map((row) => {
      const d = JSON.parse(row.data_json) as Record<string, unknown>;
      const postRow = row.kind === "post.added" && typeof d.post === "number" ? posts.get(d.post) : undefined;
      const post: Post | null = postRow === undefined ? null : { kind: postRow.kind, author: postRow.author_kind, line: firstLine(postRow.body), data: JSON.parse(postRow.data_json) as Record<string, unknown> };
      const key = row.ticket_id === null ? (row.kind === "human.action" ? str(d.key) : null) : (keyOf.get(row.ticket_id) ?? null);
      return { row, id: row.id, at: row.at, kind: row.kind, actor: row.actor, key, d, post, tone: "detail" as LineTone, dup: false };
    });
  for (const ev of evs) ev.tone = toneOf(ev);
  markDuplicates(evs);
  const live = rows.project.state === "running" || rows.project.state === "paused";
  const start = timeline.start;
  const end = Math.max(timeline.end, live ? a.now : timeline.end);
  const ctx: Ctx = { evs, keys: keyOf, reviews: rows.reviews, tickets, bars: new Map(timeline.tickets.map((bar) => [bar.key, bar])), now: a.now, live, pr: a.strategy === "pr" };
  const window = a.window ?? "all";
  const range = rangeOf(window, timeline.project, start, end);
  const inside = (at: number) => range === null || (at >= range.from && at <= range.to);

  const stretches = stretchesOf(evs, start, end);
  const runs = stretches.filter((span) => span.state === "running").length;
  let run = 0;
  const groups: StoryGroup[] = [];
  stretches.forEach((span, index) => {
    if (span.state === "running") run += 1;
    const last = index === stretches.length - 1;
    const current = last && live;
    const next = stretches[index + 1];
    const own = evs.filter((ev) => ev.id >= span.firstId && (next === undefined || ev.id < next.firstId) && inside(ev.at));
    if (own.length === 0 && (range !== null || span.state !== "paused")) return;
    const items = itemsOf(ctx, { to: span.to, current, state: span.state }, own);
    const chapters = items.filter((item): item is Extract<StoryItem, { type: "chapter" }> => item.type === "chapter");
    groups.push({
      state: span.state,
      title: groupTitle(span.state, span.state === "running" ? run : null, current, runs),
      from: span.from,
      to: span.to,
      current,
      why: span.state === "paused" ? pausedBy(ctx, span.from) : null,
      shipped: chapters.filter((chapter) => chapter.head.startsWith("Shipped")).length,
      troubled: chapters.filter((chapter) => chapter.trouble).length,
      items,
      lines: own.filter((ev) => !ev.dup).map((ev) => lineFor(ev, ctx)),
    });
  });

  const n = numbersOf(ctx, rows, range, stretches, a.maxWorkers, a.maxTokens);
  const summary = summaryOf(ctx, rows, n, range);
  const since = (key: string) => [...evs].reverse().find((ev) => ev.key === key && ev.kind === "ticket.state")?.at ?? a.now;
  const current: CurrentItem[] = !live
    ? []
    : rows.tickets.flatMap((ticket): CurrentItem[] => {
        const kind = ticket.state === "blocked" ? "blocked" : ticket.state === "pr_open" ? "pr" : rows.project.state === "paused" && IN_FLIGHT.includes(ticket.state) ? "held" : null;
        if (kind === null) return [];
        return [{ kind, key: ticket.key, title: ticket.title, state: ticket.state, since: since(ticket.key), reason: ticket.blocked_reason, reviewRound: ticket.review_round, prUrl: ticket.pr_url, prRounds: ticket.pr_rounds }];
      });
  const order = { blocked: 0, held: 1, pr: 2 };
  current.sort((x, y) => order[x.kind] - order[y.kind] || x.since - y.since);

  // Tickets in flight, as a step at every move.
  const flying = new Map<string, TicketState>();
  const flight: Array<[number, number]> = [[start, 0]];
  const marks: ActivityMark[] = [];
  for (const ev of evs) {
    if (ev.kind === "ticket.state" && ev.key !== null) {
      flying.set(ev.key, ev.d.to as TicketState);
      const count = [...flying.values()].filter((state) => IN_FLIGHT.includes(state)).length;
      if (flight.at(-1)![0] === ev.at) flight.at(-1)![1] = count;
      else if (flight.at(-1)![1] !== count) flight.push([ev.at, count]);
    }
    const text = phraseText(lineOf(ev, ctx));
    const label = ev.key === null ? text : `${ev.key}: ${text}`;
    if (ev.kind === "ticket.state" && ev.d.to === "done") marks.push({ at: ev.at, kind: "done", key: ev.key, text: label });
    else if (ev.tone === "pr" && ctx.pr) marks.push({ at: ev.at, kind: "pr", key: ev.key, text: label });
    else if (ev.kind === "ticket.state" && ev.tone === "back") marks.push({ at: ev.at, kind: "back", key: ev.key, text: label });
    else if ((ev.kind === "ticket.state" && ev.d.to === "blocked") || ev.kind === "turn.retry") marks.push({ at: ev.at, kind: "bad", key: ev.key, text: label });
    else if (ev.kind === "human.action" && !ev.dup) marks.push({ at: ev.at, kind: "you", key: null, text });
    else if (ev.kind === "spec.approved" || ev.kind === "project.landed" || (ev.kind === "project.state" && ev.d.to === "done")) marks.push({ at: ev.at, kind: "milestone", key: null, text });
  }
  const latestRun = [...timeline.project].reverse().find((span) => span.state === "running");
  return {
    state: rows.project.state,
    strategy: a.strategy,
    start,
    end,
    now: a.now,
    window: range === null ? "all" : window,
    range,
    presets: { run: latestRun !== undefined && runs > 1, day: end - start > 2 * DAY },
    headline: summary.headline,
    lines: summary.lines,
    figures: figuresOf(n, start, end, range),
    activity: { start, end, times: [...new Set(evs.map((ev) => ev.at))], marks, flight, spans: stretches.map(({ from, to, state }) => ({ from, to, state })) },
    current,
    groups,
    numbers: n,
  };
}
