// Loom merging a ticket's pull request itself, on a repo whose forge opts in with auto_merge. A merge is asked for only
// while Loom's own Ready to merge verdict holds (the Merge order tab's), the project runs and no freeze window is on. Each
// ask is an event recorded before the forge is called, so a comment or a command that hands the pull request to a merge
// service never goes out twice for one attempt; later reads of the pull request settle it: merged completes the ticket as
// before, and a rejection the worker can address becomes a fix round, or blocks the ticket once the attempts are used up.
import { acceptFinalReview, finalReviewOf, finalState, followFinalReview, maintainRuns, needsUpkeep, resetFinalReview, sweepScratch, ticketsWithOutstandingRuns } from "./final-review";
import type { EventRow, ProjectRow, Store, TicketRow } from "./db/store";
import { hostCallTransient } from "./forge-waits";
import type { HostOutput } from "./host-contract";
import { mergeOrderOf, type MergeEntry } from "./merge-order";
import { andList, clip, type FeedbackItem } from "./prompts";
import { blockOpenPr, globMatch, mergeFixRound } from "./pull-requests";
import { repoSettings, repeatableMerge, autoMergeOf, type AutoMergeSettings } from "./repos";
import { rolloutOf } from "./rollout";
import { repoCheckout } from "./checkouts";
import type { Spec } from "./spec";
import { HUMAN_ACTOR, LOOM_ACTOR } from "./states";
import { draftStateOf } from "./drafts";
import { LoomError } from "./projects";
import { specOf, type EngineCtx } from "./workers";

export const MERGE_ATTEMPT = "ticket.merge_attempt";
export const MERGE_OUTCOME = "ticket.merge_outcome";
export const MERGE_HELD = "ticket.merge_held";
export const TICKET_AUTO_MERGE = "ticket.auto_merge";
export const PROJECT_AUTO_MERGE = "project.auto_merge";
/** The human confirmed the merge of one pushed commit of a ticket's pull request, on a repo whose auto_merge.mode is manual. */
export const MERGE_CONFIRMED = "ticket.merge_confirmed";
/** The planner asked the human to confirm the merge of one pushed commit; it authorizes nothing. */
export const MERGE_REQUESTED = "ticket.merge_requested";
/** An attempt's call came back without settling it (the forge took it, or its outcome is unknown), or a restart left it with no answer and Loom said so. */
export const MERGE_ANSWERED = "ticket.merge_answered";
/** How long a merge gh said it made, or a queue entry GitHub no longer shows, may go unseen in a read before Loom asks again. */
export const UNCONFIRMED_MS = 15 * 60_000;
/** How far the forge's clock may run behind the project's machine when Loom compares a comment's or a removal's time with its attempt's. */
export const CLOCK_SLACK_MS = 60_000;

const DAY_MS = 86_400_000;

/** The attempts whose forge call this process is waiting on: an open attempt outside it, with no answer recorded, lost its call to a restart. */
const calling = new WeakMap<Store, Set<number>>();
const callingOf = (store: Store) => calling.get(store) ?? calling.set(store, new Set()).get(store)!;
const answered = (store: Store, ticketId: number, attemptId: number) => store.ticketEvents(ticketId, [MERGE_ANSWERED]).some((event) => parse(event).attempt === attemptId);
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface MergeAttempt {
  id: number;
  at: number;
  url: string;
  sha: string;
  method: AutoMergeSettings["method"];
  n: number;
  /** Each item's stable id (or key, for a forge that gives none) when Loom asked, so only a comment that came after can reject this attempt. */
  known: string[];
  /** When the merge queue last removed the pull request before this attempt, so that removal never settles it. */
  removedBefore: number | null;
}

type Outcome = "rejected" | "refused" | "failed" | "stopped" | "unconfirmed" | "superseded" | "cleared";

/** What a read of the open pull request gives auto-merge besides what the poll stored: its items and its merge queue state. */
export interface MergeRead {
  /** The pull request's head commit as the forge reports it; null when the read has no feedback. */
  head?: string | null;
  /** The pull request's author and its title and description now, for the final review. */
  author?: string | null;
  text?: { title: string | null; body: string | null } | null;
  items: ReadonlyArray<{ key: string; stableId?: string | null; createdAt?: number | null; kind: string; author: string; bot?: boolean; body: string; url: string | null; state?: string | null }> | null;
  queue?: Extract<HostOutput<"prBatch">, { outcome: "ok" }>["pulls"][number]["queue"];
}

export interface AttemptState {
  /** Attempts that count toward max_attempts since the ticket was last requeued or turned on again. */
  used: number;
  /** The newest attempt with no outcome yet. */
  open: MergeAttempt | null;
  /** Whether `open` was made since the budget was last reset, so it is one of `used`; one from before keeps its identity but not its number. */
  openCounted: boolean;
  /** The newest outcome, and whether a failure worth retrying started a streak that was already posted. */
  last: { outcome: Outcome; message: string | null } | null;
  /** The human turned auto-merge off for this ticket. */
  off: boolean;
}

const parse = (event: EventRow) => JSON.parse(event.data_json) as Record<string, unknown>;

/** The ticket's merge attempts, read from its events in order. */
export function attemptState(store: Store, ticketId: number): AttemptState {
  const state: AttemptState = { used: 0, open: null, openCounted: false, last: null, off: false };
  const reset = () => {
    state.used = 0;
    state.openCounted = false;
  };
  for (const event of store.ticketEvents(ticketId, ["ticket.state", MERGE_ATTEMPT, MERGE_OUTCOME, TICKET_AUTO_MERGE])) {
    const data = parse(event);
    if (event.kind === "ticket.state") {
      if (data.from === "blocked" && (data.to === "queued" || data.requeued === true || data.to === "pr_open")) reset();
    } else if (event.kind === TICKET_AUTO_MERGE) {
      state.off = data.on === false;
      if (data.on === true) reset();
    } else if (event.kind === MERGE_ATTEMPT) {
      state.used += 1;
      state.openCounted = true;
      state.open = {
        id: event.id,
        at: event.at,
        url: String(data.url),
        sha: String(data.sha),
        method: data.method as MergeAttempt["method"],
        n: Number(data.n),
        known: (data.known as string[] | undefined) ?? [],
        removedBefore: typeof data.removedBefore === "number" ? data.removedBefore : null,
      };
    } else {
      const outcome = data.outcome as Outcome;
      // A failure worth retrying and a push that replaced the commit do not use an attempt of the current budget up.
      if ((outcome === "failed" || outcome === "superseded" || outcome === "cleared") && state.open !== null && state.openCounted) state.used = Math.max(0, state.used - 1);
      state.open = null;
      state.openCounted = false;
      state.last = { outcome, message: typeof data.message === "string" ? data.message : null };
    }
  }
  return state;
}

/** Whether the human turned auto-merge off for the whole project. */
export function projectAutoMergeOff(store: Store, projectId: number): boolean {
  const last = store.eventsOfKind(projectId, PROJECT_AUTO_MERGE).at(-1);
  return last !== undefined && parse(last).on === false;
}

const dayStart = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));

/** The [[rollout.window]] that is on now, if any: no merge is asked for inside one. */
export function activeWindow(spec: Spec, now: number): { title: string; to: string } | null {
  const window = (spec.rollout?.window ?? []).find((each) => now >= dayStart(each.from) && now < dayStart(each.to) + DAY_MS);
  return window === undefined ? null : { title: window.title, to: window.to };
}

export type MergeHold = { why: "verdict" | "window" | "live"; text: string };

/**
 * What still holds the ticket's pull request back from a merge Loom asks for, in words; empty when it may merge. Loom's own
 * Ready to merge verdict must hold: nothing it waits on is open, it targets its base, it is not a draft, it does not
 * conflict, its checks (less ignore_checks) pass and the forge says it is approved. With approval = "loom" the forge only
 * must not ask for changes. Then no freeze window may be on and, with require_live, everything its rollout requires is live.
 */
export function mergeHolds(spec: Spec, tickets: readonly TicketRow[], ticket: TicketRow, settings: AutoMergeSettings, marks: Parameters<typeof rolloutOf>[2], now: number): MergeHold[] {
  const entry = mergeOrderOf(spec, tickets)?.entries.find((each) => each.key === ticket.key);
  const holds: MergeHold[] = verdictHolds(entry, settings).map((text) => ({ why: "verdict", text }));
  if (holds.length > 0) return holds;
  const window = activeWindow(spec, now);
  if (window !== null) holds.push({ why: "window", text: `the ${window.title} window is on until ${window.to}` });
  if (settings.requireLive) {
    const step = rolloutOf(spec, tickets, marks, now)?.stages.flatMap((stage) => stage.steps).find((each) => each.key === ticket.key);
    const waiting = (step?.requires ?? []).filter((need) => !need.live && !need.cancelled && !need.unknown).map((need) => need.target);
    if (waiting.length > 0) holds.push({ why: "live", text: `${andList(waiting)} ${waiting.length === 1 ? "is" : "are"} not live yet` });
  }
  return holds;
}

function verdictHolds(entry: MergeEntry | undefined, settings: AutoMergeSettings): string[] {
  if (entry === undefined || entry.prUrl === null || !entry.prOpen) return ["it has no open pull request"];
  if (entry.verdict === "after") return [`it waits for ${andList(entry.waitsOn.map((wait) => wait.key))} to merge first`];
  if (entry.verdict === "moving") return ["the pull request it was stacked on merged, and Loom has not moved it to its base yet"];
  if (entry.verdict === "ready") return [];
  if (entry.verdict !== "first" && entry.verdict !== "checks_pass") return [`the Merge order says ${entry.verdict}`];
  const holds = entry.holds.filter((hold) => !(settings.approval === "loom" && hold === "needs review"));
  // Never a draft: a held pull request stays one on purpose. A forge that does not say is not trusted either.
  if (entry.draft !== false && !holds.includes("draft")) holds.push(entry.draft === null ? "the forge did not say whether it is a draft" : "draft");
  if (settings.approval === "forge" && entry.review !== "APPROVED" && !holds.some((hold) => hold === "needs review" || hold === "changes requested")) holds.push("the forge did not say it is approved");
  return holds;
}

function addPost(ctx: EngineCtx, ticket: TicketRow, body: string, data: object): void {
  ctx.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "merge", body, data_json: JSON.stringify(data) });
  ctx.store.changed(ticket.project_id);
}

function outcome(ctx: EngineCtx, ticket: TicketRow, attempt: MergeAttempt, result: Outcome, message: string | null = null): void {
  ctx.store.event(ticket.project_id, ticket.id, MERGE_OUTCOME, LOOM_ACTOR, { attempt: attempt.id, n: attempt.n, url: attempt.url, sha: attempt.sha, outcome: result, ...(message === null ? {} : { message: clip(message, 2000) }) });
}

const METHOD_TEXT: Record<AutoMergeSettings["method"], string> = {
  squash: "squash-merged it",
  merge: "merged it with a merge commit",
  rebase: "rebase-merged it",
  queue: "added it to the merge queue",
  comment: "posted the merge comment",
  command: "ran the merge command",
};

type Readiness =
  | { kind: "settle"; project: ProjectRow; ticket: TicketRow; settings: AutoMergeSettings; state: AttemptState }
  | { kind: "hold"; ticket: TicketRow; holds: MergeHold[] }
  | { kind: "exhausted"; ticket: TicketRow; state: AttemptState }
  | { kind: "final"; project: ProjectRow; ticket: TicketRow; settings: AutoMergeSettings }
  | { kind: "confirm"; ticket: TicketRow }
  | { kind: "ask"; project: ProjectRow; spec: Spec; ticket: TicketRow; settings: AutoMergeSettings; state: AttemptState };

/**
 * Where the ticket's merge stands now, from the store alone, so it can be judged again in the same synchronous stretch as
 * the attempt it allows: null when Loom does nothing (the project does not run, the ticket is not pr_open on a pushed
 * commit, the repo does not opt in, the human turned it off, or the branch has commits Loom did not push).
 */
function readiness(ctx: EngineCtx, projectId: number, ticketId: number, read: MergeRead): Readiness | null {
  const { store } = ctx;
  const ticket = store.ticket(ticketId);
  const project = store.project(projectId);
  if (ticket === null || project?.state !== "running" || ticket.state !== "pr_open" || ticket.pr_url === null || ticket.pushed_sha === null) return null;
  const spec = specOf(store, project);
  const settings = autoMergeOf(repoSettings(spec, ticket.repo).forge);
  if (settings === null) return null;
  let state = attemptState(store, ticket.id);
  if (state.open !== null) {
    if (state.open.url === ticket.pr_url && state.open.sha === ticket.pushed_sha) return { kind: "settle", project, ticket, settings, state };
    outcome(ctx, ticket, state.open, "superseded");
    state = attemptState(store, ticket.id);
  }
  if (state.off || projectAutoMergeOff(store, project.id)) return null;
  // Commits someone else pushed have had no Loom review; the next fix round takes them in first.
  if (read.head != null && read.head !== ticket.pushed_sha) return null;
  const holds = mergeHolds(spec, store.tickets(project.id), ticket, settings, store.rolloutMarks(project.id), ctx.now());
  if (holds.length > 0) return { kind: "hold", ticket, holds };
  if (state.used >= settings.maxAttempts) return { kind: "exhausted", ticket, state };
  // Last: a final review runs only once nothing else holds the merge, and its pass must be for the head Loom pushed.
  if (finalReviewOf(spec, settings) !== null && finalState(store, ticket.id, ticket.pushed_sha).passed === null) return { kind: "final", project, ticket, settings };
  // In manual mode, the human confirms each pushed commit's merge, after everything else, the final review included, has passed.
  if (settings.mode === "manual" && !mergeConfirmed(store, ticket)) return { kind: "confirm", ticket };
  return { kind: "ask", project, spec, ticket, settings, state };
}

const forHead = (event: EventRow, ticket: TicketRow) => parse(event).url === ticket.pr_url && parse(event).sha === ticket.pushed_sha;

/**
 * Whether the human confirmed the merge of the ticket's pull request at the commit Loom pushed last. Only an event the
 * human's actor wrote counts: no Loom agent's record authorizes a merge, whatever it says.
 */
export function mergeConfirmed(store: Store, ticket: TicketRow): boolean {
  return store.ticketEvents(ticket.id, [MERGE_CONFIRMED]).some((event) => event.actor === HUMAN_ACTOR && forHead(event, ticket));
}

/** The planner's open request that the human confirm the merge of the commit Loom pushed last; null when there is none. */
function mergeRequestOf(store: Store, ticket: TicketRow): { at: number; note: string } | null {
  const event = store.ticketEvents(ticket.id, [MERGE_REQUESTED]).filter((each) => forHead(each, ticket)).at(-1);
  return event === undefined ? null : { at: event.at, note: String(parse(event).note ?? "") };
}

/** The key of the post that says a ready pull request waits for the human's confirmation, once per pushed commit. */
const confirmKey = (ticket: TicketRow) => `${ticket.pushed_sha}:confirm`;

/** What the panel shows of a manual merge, with the pull request and commit a confirmation from it must name. */
export interface MergeConfirmState {
  prUrl: string;
  sha: string;
  /** Nothing else holds back the merge of `sha`, so only the confirmation does, and the panel offers it. */
  ready: boolean;
  /** The one thing the merge still waits for besides the confirmation, in words; null once it is ready. */
  waiting: string | null;
  confirmed: boolean;
  /** The planner asked the human to confirm the merge of `sha`, and the human has not yet. */
  requested: { at: number; note: string } | null;
}

/**
 * What the panel shows of a manual merge: null unless the ticket's repo sets auto_merge with mode manual, its pull request
 * is open on a commit Loom pushed, and auto-merge is on for the project and the ticket.
 */
export function mergeConfirmOf(store: Store, spec: Spec, ticket: TicketRow, now: number): MergeConfirmState | null {
  if (ticket.state !== "pr_open" || ticket.pr_url === null || ticket.pushed_sha === null) return null;
  if (autoMergeOf(repoSettings(spec, ticket.repo).forge)?.mode !== "manual") return null;
  if (attemptState(store, ticket.id).off || projectAutoMergeOff(store, ticket.project_id)) return null;
  const confirmed = mergeConfirmed(store, ticket);
  const waiting = confirmed ? null : manualWait(store, spec, ticket, now);
  return {
    prUrl: ticket.pr_url,
    sha: ticket.pushed_sha,
    ready: !confirmed && waiting === null,
    waiting,
    confirmed,
    requested: confirmed ? null : mergeRequestOf(store, ticket),
  };
}

/**
 * The one thing a manual merge waits for besides the human's confirmation, in words, judged from the store as the merge
 * itself is: the project runs, the pull request is no draft, Loom's Ready to merge verdict and its approval, checks and
 * order hold, no freeze window is on, what require_live names is live, attempts are left, and a final review passed for
 * the pushed commit. Null once only the confirmation holds the merge back.
 */
export function manualWait(store: Store, spec: Spec, ticket: TicketRow, now: number): string | null {
  const project = store.project(ticket.project_id);
  const settings = autoMergeOf(repoSettings(spec, ticket.repo).forge);
  if (project === null || settings === null) return "auto-merge is not set for its repo";
  if (project.state !== "running") return `the project is ${project.state}`;
  const draft = draftStateOf(ticket);
  if (draft === "held") return "it is held as a draft until you release it";
  if (draft === "marking") return "being marked ready for review";
  const holds = mergeHolds(spec, store.tickets(project.id), ticket, settings, store.rolloutMarks(project.id), now);
  if (holds.length > 0) return holds[0]!.text;
  if (attemptState(store, ticket.id).used >= settings.maxAttempts) return "it used every merge attempt auto_merge.max_attempts allows";
  if (finalReviewOf(spec, settings) !== null && finalState(store, ticket.id, ticket.pushed_sha).passed === null) return "its final review has not passed yet";
  return null;
}

/** Says once per pushed commit that the pull request is ready and waits for the human to confirm its merge. */
function noteConfirm(ctx: EngineCtx, ticket: TicketRow): void {
  const key = confirmKey(ticket);
  if (ctx.store.ticketEvents(ticket.id, [MERGE_HELD]).some((event) => parse(event).key === key)) return;
  ctx.store.event(ticket.project_id, ticket.id, MERGE_HELD, LOOM_ACTOR, { key, holds: ["the human has not confirmed the merge"] });
  addPost(
    ctx,
    ticket,
    `${ticket.key}'s pull request is ready to merge at ${ticket.pushed_sha}. auto_merge.mode is manual, so Loom waits for you to confirm the merge of that commit: use Confirm merge on the ticket or its card.`,
    { outcome: "auto_merge_confirm", url: ticket.pr_url, sha: ticket.pushed_sha },
  );
}

/** Why Loom would not merge the ticket's pull request at all, so there is nothing to confirm or ask about; null when it would. */
function noManualMerge(store: Store, project: ProjectRow, ticket: TicketRow): string | null {
  const settings = autoMergeOf(repoSettings(specOf(store, project), ticket.repo).forge);
  if (settings === null) return `${ticket.key}'s repo sets no auto_merge, so Loom never merges its pull request.`;
  if (settings.mode !== "manual") return `${ticket.key}'s repo sets auto_merge.mode = "auto", so Loom merges its pull request by itself once it is ready.`;
  if (ticket.state !== "pr_open" || ticket.pr_url === null || ticket.pushed_sha === null) return `${ticket.key} is ${ticket.state} with no open pull request on a commit Loom pushed, so there is no merge to confirm.`;
  if (attemptState(store, ticket.id).off || projectAutoMergeOff(store, project.id)) return `Auto-merge is off for ${ticket.key}, so Loom would not merge it. Turn it on first with \`bb loom auto-merge ${project.slug} on\`.`;
  return null;
}

/** The pull request and the exact commit a confirmation is for: what the human saw. */
export interface SeenHead {
  prUrl: string;
  sha: string;
}

/**
 * The human's confirmation of a manual merge, from the panel or the CLI only: it lets Loom ask to merge the pull request
 * the human saw at the exact commit they saw, once it is ready. A confirmation for another pull request or commit than
 * the ticket's now is refused, so a stale or replayed one never authorizes a new head. It is always recorded as the
 * human's; a Loom agent has no way to call it (the planner's loom_confirm_merge only asks, through requestMerge).
 */
export function confirmMerge(store: Store, project: ProjectRow, ticket: TicketRow, seen: SeenHead, now: number): string {
  const no = noManualMerge(store, project, ticket);
  if (no !== null) throw new LoomError("loom_invalid_state", no);
  if (seen.prUrl !== ticket.pr_url || seen.sha !== ticket.pushed_sha) {
    const what = seen.prUrl !== ticket.pr_url ? `you confirmed ${seen.prUrl}, and the ticket's pull request is ${ticket.pr_url} now` : `you confirmed ${seen.sha.slice(0, 12)}, and Loom has pushed ${ticket.pushed_sha!.slice(0, 12)} since`;
    throw new LoomError("loom_invalid_state", `${ticket.key}'s pull request moved since you saw it: ${what}. Nothing is confirmed; look at the new commit and confirm it if you want it merged.`);
  }
  const sha = ticket.pushed_sha!.slice(0, 12);
  if (mergeConfirmed(store, ticket)) return `${ticket.key}'s merge at ${sha} is already confirmed.`;
  // The human confirms a pull request that is ready to merge, nothing earlier: what holds it may change what they would decide.
  const waiting = manualWait(store, specOf(store, project), ticket, now);
  if (waiting !== null) throw new LoomError("loom_invalid_state", `${ticket.key}'s pull request is not ready to merge yet: ${waiting}. Confirm it once it is.`);
  store.event(project.id, ticket.id, MERGE_CONFIRMED, HUMAN_ACTOR, { url: ticket.pr_url, sha: ticket.pushed_sha });
  store.changed(project.id);
  return `Confirmed ${ticket.key}'s merge at ${sha}: Loom asks to merge its pull request at its next read.`;
}

/**
 * The planner's loom_confirm_merge: records that it asks the human to confirm the merge of the exact commit Loom pushed
 * last, which the Planner page, the ticket and its card show with a Confirm button. It authorizes nothing by itself.
 */
export function requestMerge(store: Store, project: ProjectRow, ticket: TicketRow, threadId: string, ask: { sha: string; note: string }): string {
  const no = noManualMerge(store, project, ticket);
  if (no !== null) throw new LoomError("loom_invalid_state", no);
  if (ask.sha !== ticket.pushed_sha) throw new LoomError("loom_invalid_state", `${ticket.key}'s pull request is at ${ticket.pushed_sha}, not ${ask.sha}. Ask about the commit it is at, and only if the human wants that one merged.`);
  const sha = ask.sha.slice(0, 12);
  if (mergeConfirmed(store, ticket)) return `The human already confirmed ${ticket.key}'s merge at ${sha}.`;
  const asked = `Asked the human to confirm ${ticket.key}'s merge at ${sha}. Loom does not merge it until they confirm, on the Planner page, the ticket or its board card.`;
  if (mergeRequestOf(store, ticket) !== null) return asked;
  store.event(project.id, ticket.id, MERGE_REQUESTED, threadId, { url: ticket.pr_url, sha: ask.sha, note: clip(ask.note, 2000) });
  store.addPost({
    project_id: project.id,
    ticket_id: ticket.id,
    parent_id: null,
    author_kind: "planner",
    author_thread_id: threadId,
    kind: "merge",
    body: `The planner asks you to confirm the merge of ${ticket.key}'s pull request at ${sha}: "${clip(ask.note, 500)}". Loom merges it only once you confirm, with Confirm merge on the Planner page, the ticket or its card.`,
    data_json: JSON.stringify({ outcome: "auto_merge_requested", url: ticket.pr_url, sha: ask.sha }),
  });
  store.changed(project.id);
  return asked;
}

/**
 * After a read of an open pull request: settles a merge in flight from what the read shows, or asks for one when the
 * ticket's pull request may merge. Only while the project runs, auto-merge is on for it and the ticket, and the ticket is
 * still pr_open on the commit Loom pushed.
 */
export async function followAutoMerge(ctx: EngineCtx, project: ProjectRow, ticketId: number, read: MergeRead): Promise<void> {
  await upkeep(ctx, project.id, ticketId, read);
  const ready = readiness(ctx, project.id, ticketId, read);
  if (ready === null) return;
  if (ready.kind === "settle") return settleAttempt(ctx, ready.project, ready.ticket, ready.settings, ready.state, read);
  if (ready.kind === "hold") return noteHold(ctx, ready.ticket, ready.holds);
  if (ready.kind === "confirm") return noteConfirm(ctx, ready.ticket);
  if (ready.kind === "exhausted") {
    const { ticket, state } = ready;
    const last = state.last?.message == null ? "" : ` The last answer was:\n\n${state.last.message}`;
    const reason = `Loom asked to merge the pull request ${state.used} ${state.used === 1 ? "time" : "times"}, the most auto_merge.max_attempts allows, and it has not merged.`;
    await blockOpenPr(ctx, ticket, reason, { body: `${reason}${last}`, data: { outcome: "auto_merge_exhausted", url: ticket.pr_url, attempts: state.used } });
    return;
  }
  if (ready.kind === "final") {
    const still = () => {
      const again = readiness(ctx, project.id, ticketId, read);
      return again?.kind === "final" ? again.ticket : null;
    };
    if (!(await followFinalReview(ctx, ready.project, ready.ticket, ready.settings, read, still))) return;
    // The pass was counted just now: the merge goes in the same pass, after one more judgement of the ticket.
    const now = readiness(ctx, project.id, ticketId, read);
    if (now?.kind === "ask") await askToMerge(ctx, now, read);
    else if (now?.kind === "confirm") noteConfirm(ctx, now.ticket);
    return;
  }
  await askToMerge(ctx, ready, read);
}

/** Why a final review in flight for the ticket may not go on, in words; null while its pull request is ready for one. */
function finalStop(ctx: EngineCtx, projectId: number, ticketId: number, read: MergeRead): string | null {
  const project = ctx.store.project(projectId);
  const ticket = ctx.store.ticket(ticketId);
  if (project === null || ticket === null) return "the ticket is gone";
  if (project.state !== "running") return `the project is ${project.state}`;
  if (ticket.state !== "pr_open") return `the ticket is ${ticket.state}`;
  if (projectAutoMergeOff(ctx.store, projectId) || attemptState(ctx.store, ticketId).off) return "auto-merge is off";
  const ready = readiness(ctx, projectId, ticketId, read);
  if (ready?.kind === "final") return null;
  if (ready?.kind === "hold") return `the pull request is not ready to merge any more (${ready.holds.map((one) => one.text).join("; ")})`;
  return "the pull request is not ready for a final review any more";
}

/** Keeps up one ticket's final reviews: deadlines, a new push, and a stop when it may not go on (see maintainRuns). */
async function upkeep(ctx: EngineCtx, projectId: number, ticketId: number, read: MergeRead): Promise<void> {
  if (!needsUpkeep(ctx.store, ticketId)) return;
  const project = ctx.store.project(projectId);
  const ticket = ctx.store.ticket(ticketId);
  if (project === null || ticket === null) return;
  const spec = specOf(ctx.store, project);
  const final = finalReviewOf(spec, autoMergeOf(repoSettings(spec, ticket.repo).forge));
  await maintainRuns(ctx, ticketId, final === null ? "the spec no longer sets a final review" : finalStop(ctx, projectId, ticketId, read), final?.timeoutMs ?? null);
}

/**
 * The tick's upkeep of the final reviews of every project, in every state, apart from any read of a pull request: a run
 * whose deadline passed, whose project paused or whose ticket blocked, was cancelled or is not ready any more ends, and
 * every run that is over has its thread stopped and archived and its scratch directory removed. It visits only the
 * tickets with a run not closed yet, so finished history costs nothing; then it sweeps orphaned scratch directories.
 * `projectId` is ignored: the upkeep is global.
 */
export async function maintainFinalReviews(ctx: EngineCtx, _projectId?: number): Promise<void> {
  for (const { ticketId, projectId } of ticketsWithOutstandingRuns(ctx.store)) {
    try {
      await upkeep(ctx, projectId, ticketId, { items: null });
    } catch (error) {
      ctx.bb.log("warn", `Keeping up the final reviews of ticket ${ticketId} stopped: ${errText(error)}`);
    }
  }
  const hosts = () => ctx.store.projects().flatMap((project) => {
    if ((project.state !== "running" && project.state !== "paused") || project.host_id === null || project.approved_version === null) return [];
    const spec = specOf(ctx.store, project);
    const repos = spec.repo === undefined || spec.repo.length === 0 ? [null] : spec.repo.map((repo) => repo.name);
    return repos.some((name) => finalReviewOf(spec, autoMergeOf(repoSettings(spec, name).forge)) !== null) ? [project.host_id] : [];
  });
  await sweepScratch(ctx, hosts);
}

/** Says once per pushed commit why a pull request that is otherwise ready waits: a freeze window, or a rollout requirement. */
function noteHold(ctx: EngineCtx, ticket: TicketRow, holds: MergeHold[]): void {
  const quiet = holds.filter((hold) => hold.why !== "verdict");
  if (quiet.length !== holds.length || quiet.length === 0) return;
  const key = `${ticket.pushed_sha}:${quiet.map((hold) => hold.why).join(",")}`;
  if (ctx.store.ticketEvents(ticket.id, [MERGE_HELD]).some((event) => parse(event).key === key)) return;
  ctx.store.event(ticket.project_id, ticket.id, MERGE_HELD, LOOM_ACTOR, { key, holds: quiet.map((hold) => hold.text) });
  addPost(ctx, ticket, `${ticket.key}'s pull request is ready to merge, but ${andList(quiet.map((hold) => hold.text))}, so Loom waits before it asks to merge it.`, { outcome: "auto_merge_held", url: ticket.pr_url, holds: quiet.map((hold) => hold.text) });
}

/** An item's identity across edits: the stable id the forge gives, else its key, which a forge may change when it is edited. */
const stableOf = (item: { key: string; stableId?: string | null }) => item.stableId ?? item.key;

/**
 * Looks up the checkout, then judges the ticket again from the store, since the human may have paused the project, turned
 * auto-merge off, blocked or cancelled the ticket, or Loom pushed a new commit while it waited; and records the attempt in
 * the same synchronous stretch, before the forge is called, so a restart or a lost answer never sends it twice.
 */
async function askToMerge(ctx: EngineCtx, seen: Extract<Readiness, { kind: "ask" }>, read: MergeRead): Promise<void> {
  const { store } = ctx;
  const url = seen.ticket.pr_url!;
  const sha = seen.ticket.pushed_sha!;
  const checkout = await repoCheckout(ctx, seen.project, seen.spec, seen.ticket.repo);
  const ready = readiness(ctx, seen.project.id, seen.ticket.id, read);
  if (ready?.kind !== "ask" || ready.ticket.pr_url !== url || ready.ticket.pushed_sha !== sha || ready.settings.method !== seen.settings.method) return;
  const { project, spec, ticket, settings, state } = ready;
  const n = state.used + 1;
  store.event(project.id, ticket.id, MERGE_ATTEMPT, LOOM_ACTOR, { url, sha, method: settings.method, n, known: (read.items ?? []).map(stableOf), removedBefore: read.queue?.removed?.at ?? null });
  const attempt = attemptState(store, ticket.id).open!;
  const { forge, base } = repoSettings(spec, ticket.repo);
  const answer = await dispatch(ctx, checkout, attempt, { url, sha, head: ticket.pr_branch ?? ticket.branch ?? "", base: ticket.pr_base ?? base, n, forge, settings });
  await settleAnswer(ctx, project, ticket.id, settings, attempt, state, answer);
}

type Answer = HostOutput<"prMerge"> | { outcome: "lost"; message: string };

/** Calls the forge for `attempt`, which this process marks as its own until the answer is in. A call that got no answer is "lost" for a comment or a command, which may have gone out. */
async function dispatch(
  ctx: EngineCtx,
  checkout: Awaited<ReturnType<typeof repoCheckout>>,
  attempt: MergeAttempt,
  a: { url: string; sha: string; head: string; base: string; n: number; forge: ReturnType<typeof repoSettings>["forge"]; settings: AutoMergeSettings },
): Promise<Answer> {
  const { forge, settings } = a;
  callingOf(ctx.store).add(attempt.id);
  try {
    return await ctx.host.call(checkout.hostId, "prMerge", {
      repo: checkout.path,
      url: a.url,
      sha: a.sha,
      head: a.head,
      base: a.base,
      attempt: Math.min(a.n, 10),
      forge: forge.kind === "command" ? { kind: "command", merge: forge.merge! } : { kind: "gh", method: settings.method as "squash" | "merge" | "rebase" | "queue" | "comment", ...(settings.comment === null ? {} : { comment: settings.comment }) },
    });
  } catch (error) {
    const transient = hostCallTransient(error);
    if (transient !== null && !repeatableMerge(settings.method)) return { outcome: "lost", message: errText(error) };
    return { outcome: "unavailable", message: errText(error), ...(transient ?? {}) };
  } finally {
    callingOf(ctx.store).delete(attempt.id);
  }
}

/**
 * Acts on the forge's answer to `attempt`, only while it is still the ticket's open attempt: the human may have cleared it
 * with `retry`, or a newer push replaced it, while the call was out. Then the answer is posted for the human and changes
 * nothing, since another attempt, or none, is in force.
 */
async function settleAnswer(ctx: EngineCtx, project: ProjectRow, ticketId: number, settings: AutoMergeSettings, attempt: MergeAttempt, before: AttemptState, answer: Answer): Promise<void> {
  const { store } = ctx;
  const ticket = store.ticket(ticketId)!;
  const now = attemptState(store, ticket.id);
  const { url, sha, n } = attempt;
  const tries = `attempt ${n} of ${settings.maxAttempts}`;
  if (now.open?.id !== attempt.id) {
    const why = now.last?.outcome === "cleared" && now.open === null ? "after it was cleared" : "after a newer push or attempt replaced it";
    const said = answer.outcome === "ok" ? "the forge took it" : answer.outcome === "rejected" ? `the forge turned it away: ${clip(answer.message, 1500)}` : `the call failed: ${clip(answer.message, 1500)}`;
    addPost(ctx, ticket, `The answer to Loom's merge of ${url} (${tries}) came ${why}, so Loom does not act on it: ${said}. It follows the pull request as it is now.`, { outcome: "auto_merge_late", url, n, attempt: attempt.id, answer: answer.outcome });
    return;
  }
  // A comment or a command may have gone out whatever the answer says, short of a definite refusal, so it is never sent again
  // for this attempt: a later read settles it, or the human clears it.
  const unknown = (message: string, why: string) => {
    store.event(ticket.project_id, ticket.id, MERGE_ANSWERED, LOOM_ACTOR, { attempt: attempt.id, unknown: true });
    unknownPost(ctx, project, ticket, settings, attempt, `but ${why}`, message);
  };
  if (answer.outcome === "lost") return unknown(answer.message, "got no answer from the project's machine");
  if (answer.outcome === "ok") {
    const direct = settings.method === "squash" || settings.method === "merge" || settings.method === "rebase";
    store.event(ticket.project_id, ticket.id, MERGE_ANSWERED, LOOM_ACTOR, { attempt: attempt.id });
    addPost(ctx, ticket, `Loom ${METHOD_TEXT[settings.method]} for ${url} (${tries}), because its Ready to merge verdict holds.${direct ? " The next read of the pull request completes the ticket." : " Loom watches the pull request for the merge."}`, { outcome: "auto_merge_asked", url, sha, method: settings.method, n });
    // The next poll reads it at once, to see the merge.
    if (direct) store.updateTicket(ticket.id, { pr_checked_at: null });
    return;
  }
  if (answer.outcome === "rejected") return rejected(ctx, project, ticket, settings, now, answer.message, answer.fix, `the forge refused the merge`);
  if (answer.transient !== undefined) {
    if (!repeatableMerge(settings.method)) return unknown(answer.message, "the forge answered with what looks like a temporary error, ran out of time or was stopped");
    const streak = before.last?.outcome === "failed";
    outcome(ctx, ticket, attempt, "failed", answer.message);
    if (!streak) addPost(ctx, ticket, `Loom asked to merge ${url}, and the forge failed with what looks like a temporary error: ${answer.message}. gh merges a pull request at most once, so Loom asks again at the next read of the pull request; this does not use up an attempt.`, { outcome: "auto_merge_failed", url, n, transient: answer.transient });
    return;
  }
  outcome(ctx, ticket, attempt, "refused", answer.message);
  const reason = `Loom could not merge the pull request: ${answer.message}`;
  await blockOpenPr(ctx, ticket, reason, { body: `Loom asked to merge ${url} (${tries}), and it failed:\n\n${clip(answer.message, 2000)}`, data: { outcome: "auto_merge_refused", url, n } });
}

/** The post for a comment or command attempt whose outcome Loom cannot know, with how the human lets Loom ask again. */
function unknownPost(ctx: EngineCtx, project: ProjectRow, ticket: TicketRow, settings: AutoMergeSettings, attempt: MergeAttempt, why: string, message: string | null): void {
  const what = settings.method === "comment" ? "comment was posted" : "merge command did its work";
  const again = settings.method === "comment" ? "post it" : "run it";
  addPost(
    ctx,
    ticket,
    `Loom asked to merge ${attempt.url} (attempt ${attempt.n} of ${settings.maxAttempts}), ${why}, so it cannot tell whether the ${what}, and does not ${again} again. It keeps reading the pull request; once you have checked, \`bb loom auto-merge ${project.slug} retry --ticket ${ticket.key}\` lets it ask again.${message === null ? "" : `\n\n${clip(message, 1500)}`}`,
    { outcome: "auto_merge_unknown", url: attempt.url, n: attempt.n, attempt: attempt.id, ...(message === null ? {} : { message: clip(message, 2000) }) },
  );
}

/**
 * A merge the forge turned away: a fix round for the worker when it can address it and attempts are left, else a block.
 * Exhaustion is judged against the current budget: an attempt made before a requeue or the human's `on` is not its last.
 */
async function rejected(ctx: EngineCtx, project: ProjectRow, ticket: TicketRow, settings: AutoMergeSettings, state: AttemptState, message: string, fix: boolean, who: string, item?: { key: string; author: string; url: string | null }): Promise<void> {
  const attempt = state.open!;
  outcome(ctx, ticket, attempt, fix ? "rejected" : "refused", message);
  const url = ticket.pr_url!;
  const text = clip(message.trim(), 4000);
  const which = state.openCounted ? `attempt ${state.used} of ${settings.maxAttempts}` : "an attempt from before its attempts were counted afresh";
  const last = state.openCounted && state.used >= settings.maxAttempts;
  if (!fix || last) {
    const reason = fix ? `The merge was turned away on its last allowed attempt (${which}): ${clip(text, 500)}` : `The merge was refused, and the worker cannot fix it: ${clip(text, 500)}`;
    await blockOpenPr(ctx, ticket, reason, { body: `Loom asked to merge ${url} (${which}), and ${who}:\n\n${text}`, data: { outcome: "auto_merge_rejected", url, n: attempt.n, fix, blocked: true } });
    return;
  }
  const { base } = repoSettings(specOf(ctx.store, project), ticket.repo);
  const body = `Loom asked to merge the pull request (${which}), and ${who}:\n\n${text}\n\nFix what it names on your branch, such as merging ${base} in and resolving a conflict, or the test that failed, then submit. Loom asks to merge again once the pull request is ready.`;
  const feedback: FeedbackItem = { ...(item === undefined ? { key: `merge:${attempt.id}` } : { key: item.key }), kind: "comment", author: item?.author ?? "the merge", bot: true, body, url: item?.url ?? url, state: null, path: null, line: null };
  addPost(ctx, ticket, `The merge of ${url} was turned away (${which}), so ${ticket.key} goes back to its worker:\n\n${clip(text, 1500)}`, { outcome: "auto_merge_rejected", url, n: attempt.n, fix: true, blocked: false });
  await mergeFixRound(ctx, ctx.store.ticket(ticket.id)!, feedback, item === undefined ? [] : [item.key]);
}

/**
 * A merge in flight, as this read shows it: rejected, removed by a person, not seen to happen, or still on its way. A
 * comment rejects it only when it is new since the attempt, by its stable id, and was made after it, by its creation time
 * when the forge gives one, so an old failure comment that someone edits never does. A queue removal settles it only when
 * it is newer than the removal Loom saw before the attempt, and never while the pull request is in the queue now.
 */
async function settleAttempt(ctx: EngineCtx, project: ProjectRow, ticket: TicketRow, settings: AutoMergeSettings, state: AttemptState, read: MergeRead): Promise<void> {
  const attempt = state.open!;
  const age = ctx.now() - attempt.at;
  if (settings.method === "comment" || settings.method === "command") {
    const known = new Set(attempt.known);
    const turned = (read.items ?? []).find(
      (item) =>
        item.kind === "comment" &&
        !known.has(stableOf(item)) &&
        (item.createdAt == null || item.createdAt >= attempt.at - CLOCK_SLACK_MS) &&
        settings.rejected.some((pattern) => globMatch(pattern, item.body.trim())),
    );
    if (turned !== undefined) return rejected(ctx, project, ticket, settings, state, turned.body, true, `${turned.author} turned it away`, turned);
    // No call of this process is out for it and no answer was recorded: a restart lost it. Said once per attempt.
    if (!callingOf(ctx.store).has(attempt.id) && !answered(ctx.store, ticket.id, attempt.id)) {
      ctx.store.event(ticket.project_id, ticket.id, MERGE_ANSWERED, LOOM_ACTOR, { attempt: attempt.id, unknown: true, restart: true });
      unknownPost(ctx, project, ticket, settings, attempt, "and Loom restarted before it recorded the answer", null);
    }
    return;
  }
  if (settings.method === "queue") {
    const queue = read.queue;
    if (queue == null || queue.queued) return;
    const removed = queue.removed;
    const newer = removed !== null && removed.at > (attempt.removedBefore ?? Number.NEGATIVE_INFINITY) && removed.at >= attempt.at - CLOCK_SLACK_MS;
    if (newer && removed.reason !== "merged") {
      if (removed.reason === "manual") {
        outcome(ctx, ticket, attempt, "stopped", "removed from the merge queue by a person");
        ctx.store.event(ticket.project_id, ticket.id, TICKET_AUTO_MERGE, LOOM_ACTOR, { on: false, why: "dequeued" });
        addPost(ctx, ticket, `Someone removed ${ticket.pr_url} from the merge queue, so Loom stops merging it by itself. \`bb loom auto-merge ${project.slug} on --ticket ${ticket.key}\` lets it ask again.`, { outcome: "auto_merge_stopped", url: ticket.pr_url, reason: removed.reason });
        return;
      }
      await rejected(ctx, project, ticket, settings, state, `GitHub's merge queue removed the pull request: ${removed.reason.replace(/_/g, " ")}.`, true, "the merge queue turned it away");
      return;
    }
    if (queue.auto || age < UNCONFIRMED_MS) return;
  } else if (age < UNCONFIRMED_MS) return;
  outcome(ctx, ticket, attempt, "unconfirmed");
  addPost(ctx, ticket, `Loom asked to merge ${ticket.pr_url} ${Math.round(age / 60_000)} minutes ago, and the pull request is still open${settings.method === "queue" ? ", neither in the merge queue nor set to merge" : ""}, so Loom asks again once it is ready.`, { outcome: "auto_merge_unconfirmed", url: ticket.pr_url, n: attempt.n });
}

/**
 * `bb loom auto-merge <slug> on|off|retry [--ticket KEY]`: the human turns Loom's merging off or on again, for the project
 * or one ticket, or clears a ticket's attempt in flight so the next ready read asks again. On for a ticket starts its
 * attempts afresh. Returns what changed, in a sentence.
 */
export function setAutoMerge(store: Store, project: ProjectRow, action: "on" | "off" | "retry" | "accept", ticket: TicketRow | null): string {
  if (action === "accept") {
    if (ticket === null) throw new Error("accept needs --ticket: it lets one ticket merge on its final review.");
    return acceptFinalReview(store, ticket);
  }
  if (action === "retry") {
    if (ticket === null) throw new Error("retry needs --ticket: it clears one ticket's merge attempt.");
    const open = attemptState(store, ticket.id).open;
    if (open === null) return resetFinalReview(store, ticket) ? `Loom tries ${ticket.key}'s final review again for its head.` : `${ticket.key} has no merge attempt in flight and no held final review, so there is nothing to clear.`;
    store.event(project.id, ticket.id, MERGE_OUTCOME, HUMAN_ACTOR, { attempt: open.id, n: open.n, url: open.url, sha: open.sha, outcome: "cleared" });
    return `Cleared ${ticket.key}'s merge attempt ${open.n}: Loom asks to merge again once its pull request is ready, and the cleared attempt does not count.`;
  }
  const on = action === "on";
  if (ticket === null) {
    store.event(project.id, null, PROJECT_AUTO_MERGE, HUMAN_ACTOR, { on });
    return on ? `Loom merges ${project.slug}'s ready pull requests again, on the repos whose forge sets auto_merge.` : `Loom no longer merges ${project.slug}'s pull requests by itself; attempts in flight still settle.`;
  }
  store.event(project.id, ticket.id, TICKET_AUTO_MERGE, HUMAN_ACTOR, { on });
  return on ? `Loom merges ${ticket.key}'s pull request again once it is ready, with its attempts counted afresh.` : `Loom no longer merges ${ticket.key}'s pull request by itself.`;
}
