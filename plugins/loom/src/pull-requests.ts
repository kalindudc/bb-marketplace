// The pull request stage on the pr strategy. After approval the worker writes the pull request (loom_pr), or Loom's
// template stands in. While it is open, Loom follows its checks and reviews through the forge and sends what needs a fix
// back to the worker as a fix round, which goes through the checks and a review again before Loom pushes one more
// commit. Merging stays the human's.
import { checkWaitOf, durationsKey, holdOf, median, queuedSince, USUAL_RUNS, type CheckWait, type Skipped } from "./check-wait";
import { delivers, workerOf } from "./checks";
import { repoCheckout, type RepoCheckout } from "./checkouts";
import type { PostRow, ProjectRow, ThreadRow, TicketRow } from "./db/store";
import { hostCallTransient, nextMergeWait, transientOf, type MergeWait } from "./forge-waits";
import { PR_BODY_MAX, REPLY_MARK, type HostOutput } from "./host-contract";
import { formatDuration, plural } from "./format";
import { LoomError } from "./projects";
import { andList, clip, dependsOnLines, feedbackList, LOOM_BEGIN, LOOM_END, loomBlock, prAskText, prBody, prFeedbackText, prNudgeText, replaceLoomBlock, withoutLoomBlocks, workerPrBody, type FeedbackCheck, type FeedbackItem } from "./prompts";
import { canEdit, canReply, prSettings, repoSettings } from "./repos";
import { rolloutOf, rolloutSection } from "./rollout";
import type { ForgeSpec, Spec } from "./spec";
import { LOOM_ACTOR } from "./states";
import { isWaking, releasedWorker } from "./release";
import { NOT_PARKED, toLite, workerSlots, type Parked } from "./scheduler";
import { deliverHandBacks, handBack } from "./slots";
import { takeForRound, type ForeignTip } from "./tips";
import { applyMove, released, resumeEnding, signatureOf, specOf, type EngineCtx } from "./workers";

/** How long the worker has to hand in loom_pr before Loom's template stands in; paused time does not count. */
export const PR_TEXT_MINUTES = 30;
const PR_TEXT_MS = PR_TEXT_MINUTES * 60_000;
/** Failed checks wait for the pending checks that hold them, or at most this long after the push: some status checks stay pending until a person approves. Loom's checksSettleMinutes setting changes it. */
export const CHECKS_SETTLE_MINUTES = 30;
export const CHECKS_SETTLE_MS = CHECKS_SETTLE_MINUTES * 60_000;

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface PrAsk {
  head: string;
  at: number;
  fix: boolean;
  nudged: boolean;
}

/** What opens the pull request or names the fix commit: the worker's text, or Loom's template (`by: "loom"`). */
export interface PrText {
  head: string;
  by: "worker" | "loom";
  title: string | null;
  body: string | null;
  commit: string;
}

export interface PrStatus {
  at: number;
  head: string;
  passed: number;
  failed: number;
  pending: number;
  /** When Loom first saw each check that is still queued on this head, by check key. */
  queued?: Record<string, number>;
}

type Feedback = Extract<HostOutput<"prFeedback">, { outcome: "ok" }>;

const parse = <T>(json: string | null): T | null => (json === null ? null : (JSON.parse(json) as T));
export const askOf = (ticket: TicketRow) => parse<PrAsk>(ticket.pr_ask_json);
export const statusOf = (ticket: TicketRow) => parse<PrStatus>(ticket.pr_status_json);

/** A ticket whose pull request branch Loom pushed before: its next push is a fix round, one more commit on that branch. */
export const inFixRound = (ticket: TicketRow) => ticket.pr_branch !== null && ticket.pushed_sha !== null;

/** The text the next push uses, when it is ready: the worker's for this head, or the template when the spec says so. */
export function prTextFor(spec: Spec, ticket: TicketRow): PrText | null {
  if (prSettings(spec).describe === "loom") return templateText(ticket, null);
  const text = parse<PrText>(ticket.pr_text_json);
  return text !== null && text.head === ticket.head_sha ? text : null;
}

/** On the pr strategy, an approved ticket merges only once its pull request's text is ready. */
export const prTextReady = (spec: Spec, ticket: TicketRow) => spec.merge.strategy !== "pr" || prTextFor(spec, ticket) !== null;

function templateText(ticket: TicketRow, body: string | null): PrText {
  const commit = inFixRound(ticket) ? `${ticket.key}: address the pull request's feedback (fix round ${ticket.pr_rounds})` : `${ticket.key}: ${ticket.title}`;
  return { head: ticket.head_sha!, by: "loom", title: null, body, commit };
}

/** Loom's title and description for a pull request whose text the worker did not write. */
export function templatePr(ctx: EngineCtx, ticket: TicketRow, dependsOn: string[] = [], rollout: readonly string[] = []): { title: string; body: string } {
  const approvals = ctx.store.reviews(ticket.id, ticket.review_round).filter((review) => review.verdict === "approved");
  return { title: `${ticket.key}: ${ticket.title}`, body: prBody({ ticket, approvals, dependsOn, rollout }) };
}

/** The Rollout section of the description Loom opens `ticket`'s pull request with, from what is live now. */
export function prRollout(ctx: EngineCtx, spec: Spec, ticket: TicketRow): string[] {
  return rolloutSection(spec, ctx.store.tickets(ticket.project_id), ticket, ctx.store.rolloutMarks(ticket.project_id), ctx.now());
}

function post(ctx: EngineCtx, ticket: TicketRow, a: { body: string; data: object; author?: "worker" | "loom"; threadId?: string | null }): void {
  ctx.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: a.author ?? "loom", author_thread_id: a.threadId ?? null, kind: "merge", body: a.body, data_json: JSON.stringify(a.data) });
}

/** Loom's template stands in for the worker's text, with the reason posted on the ticket. */
function useTemplate(ctx: EngineCtx, ticket: TicketRow, reason: string): void {
  const { store } = ctx;
  store.tx(() => {
    const current = store.ticket(ticket.id);
    if (current?.state !== "approved" || current.head_sha !== ticket.head_sha) return;
    const text = templateText(current, null);
    store.updateTicket(current.id, { pr_text_json: JSON.stringify(text) });
    const fix = inFixRound(current);
    post(ctx, current, {
      body: `Loom wrote the ${fix ? "fix round's commit message" : "pull request"} from its template: ${reason}.`,
      data: { outcome: "pr_text", by: "loom", fix, round: current.pr_rounds, title: fix ? null : templatePr(ctx, current).title, body: null, commit: text.commit, reason },
    });
  });
  store.changed(ticket.project_id);
  ctx.kick();
}

/**
 * The tick's step before the merge queue: ask each approved ticket's worker for its pull request, once per head, or let
 * the template stand in. Writing it is a turn, so the ask waits for a worker slot and holds one until the text is in.
 */
export async function askForPrTexts(ctx: EngineCtx, project: ProjectRow, spec: Spec, parked: Parked = NOT_PARKED): Promise<void> {
  if (spec.merge.strategy !== "pr" || prSettings(spec).describe === "loom") return;
  const { store } = ctx;
  for (const seen of store.tickets(project.id, ["approved"])) {
    const ticket = store.ticket(seen.id)!;
    if (ticket.state !== "approved" || prTextFor(spec, ticket) !== null || !delivers(ctx, project.id)) continue;
    const worker = workerOf(store, ticket);
    if (worker.standing !== "active" || worker.row.thread_id === null) {
      if (worker.standing === "gone") useTemplate(ctx, ticket, "its worker is gone");
      continue;
    }
    const ask = askOf(ticket);
    if (ask !== null && ask.head === ticket.head_sha) {
      if (ctx.now() - ask.at >= PR_TEXT_MS) useTemplate(ctx, ticket, `the worker did not hand it in within ${PR_TEXT_MINUTES} minutes`);
      continue;
    }
    if (workerSlots(spec.agents.max_workers, store.tickets(project.id).map(toLite), parked.workers) === 0) continue;
    const fix = inFixRound(ticket);
    store.tx(() => {
      store.updateTicket(ticket.id, { pr_ask_json: JSON.stringify({ head: ticket.head_sha!, at: ctx.now(), fix, nudged: false } satisfies PrAsk) });
      store.updateThread(worker.row.id, { idle_count: 0 });
    });
    store.changed(project.id);
    try {
      await ctx.bb.send(worker.row.thread_id, prAskText({ key: ticket.key, fix, round: ticket.pr_rounds, url: ticket.pr_url, limitMinutes: PR_TEXT_MINUTES, proposed: proposedFields(ticket), changes: fix && textPending(ctx, ticket) }));
    } catch (error) {
      ctx.bb.log("warn", `Could not ask ${worker.row.thread_id} for ${ticket.key}'s pull request: ${errText(error)}`);
      useTemplate(ctx, ticket, "Loom could not message the worker");
    }
  }
}

/** The worker of a ticket Loom asked for its pull request went idle without loom_pr: a nudge, then the template. False when this is not that case. */
export async function onPrWriterIdle(ctx: EngineCtx, seen: ThreadRow): Promise<boolean> {
  const { store } = ctx;
  const row = store.thread(seen.id);
  const ticket = row?.ticket_id == null ? null : store.ticket(row.ticket_id);
  if (row === null || ticket === null || ticket.state !== "approved" || ticket.worker_thread_id !== row.thread_id || row.thread_id === null) return false;
  const project = store.project(ticket.project_id)!;
  if (project.state !== "running" || prTextFor(specOf(store, project), ticket) !== null) return true;
  const ask = askOf(ticket);
  if (ask === null || ask.head !== ticket.head_sha) return true;
  if (ask.nudged) {
    useTemplate(ctx, ticket, "the worker ended its turn twice without loom_pr");
    return true;
  }
  store.updateTicket(ticket.id, { pr_ask_json: JSON.stringify({ ...ask, nudged: true } satisfies PrAsk) });
  const proposed = proposedFields(ticket);
  await ctx.bb.send(row.thread_id, prNudgeText(ticket.key, ask.fix || (proposed.title && proposed.body))).catch((error) => ctx.bb.log("warn", `Could not nudge ${row.thread_id}: ${errText(error)}`));
  return true;
}

/** On resume, an ask that is still open gets a fresh clock; a worker that pause --now stopped is asked again. */
export async function resumePrAsks(ctx: EngineCtx, projectId: number): Promise<void> {
  const { store } = ctx;
  for (const ticket of store.tickets(projectId, ["approved"])) {
    const ask = askOf(ticket);
    if (ask === null || ask.head !== ticket.head_sha || ticket.worker_thread_id === null) continue;
    const thread = await ctx.bb.getThread(ticket.worker_thread_id).catch(() => null);
    const running = thread !== null && ["active", "starting", "pending"].includes(thread.status);
    store.updateTicket(ticket.id, { pr_ask_json: running ? JSON.stringify({ ...ask, at: ctx.now() } satisfies PrAsk) : null });
  }
}

/**
 * loom_pr: the worker of an approved ticket hands in its pull request's text, or a fix round's commit message. A title or
 * a body it gives wins over the one it proposed with loom_submit; a new pull request opens with the proposal's for the
 * fields it leaves out.
 */
export function handInPrText(ctx: EngineCtx, threadId: string, a: { title?: string; body?: string; commit_message: string }): string {
  const { store } = ctx;
  const row = store.threadByThreadId(threadId);
  if (row === null || row.role !== "worker") throw new LoomError("loom_forbidden", "loom_pr is for a Loom worker thread.");
  const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
  const ask = ticket === null ? null : askOf(ticket);
  if (row.state !== "active" || ticket === null || ticket.state !== "approved" || ticket.worker_thread_id !== threadId || ask === null || ask.head !== ticket.head_sha) {
    throw new LoomError("loom_invalid_state", "Loom has not asked you for a pull request: it asks once the reviewers approve your ticket.");
  }
  const spec = specOf(store, store.project(ticket.project_id)!);
  if (prTextFor(spec, ticket) !== null) throw new LoomError("loom_invalid_state", `${ticket.key}'s pull request text is already in, so Loom is pushing it now. End your turn.`);
  const commit = a.commit_message.trim();
  const given = (value: string | undefined) => (value === undefined || value.trim() === "" ? null : value.trim());
  const proposal = proposalOf(ticket);
  const title = ask.fix ? given(a.title) : (given(a.title) ?? proposal?.title ?? null);
  const written = a.body === undefined ? null : given(withoutLoomBlocks(a.body));
  const body = ask.fix ? written : (written ?? proposal?.body ?? null);
  if (commit === "") throw new LoomError("loom_invalid_input", "commit_message is empty. Write a subject line, a blank line, then a short body.");
  if (!ask.fix && (title === null || body === null)) {
    const proposed = proposal === null ? "" : ` You proposed only ${proposal.title === null ? "a body" : "a title"} with loom_submit, so give the ${proposal.title === null ? "title" : "body"} here.`;
    throw new LoomError("loom_invalid_input", `This opens the pull request, so it needs a title and a body as well as the commit_message.${proposed}`);
  }
  const text: PrText = { head: ticket.head_sha!, by: "worker", title, body, commit };
  const retitled = ask.fix && (title !== null || body !== null);
  store.tx(() => {
    store.updateTicket(ticket.id, { pr_text_json: JSON.stringify(text) });
    post(ctx, ticket, {
      author: "worker",
      threadId,
      body: ask.fix ? `The worker wrote the commit message for fix round ${ticket.pr_rounds}${retitled ? `, and a new ${title !== null && body !== null ? "title and description" : title !== null ? "title" : "description"}` : ""}.` : `The worker wrote the pull request: ${title}`,
      data: { outcome: "pr_text", by: "worker", fix: ask.fix, round: ticket.pr_rounds, title: text.title, body: text.body, commit },
    });
  });
  store.changed(ticket.project_id);
  ctx.kick();
  const sets = ask.fix && (retitled || textPending(ctx, ticket)) ? ", then sets the pull request's new title and description" : "";
  return ask.fix
    ? `Loom pushes the fix as one more commit with your message now${sets}, so end your turn. It keeps following the pull request and messages you about anything else to fix.`
    : `Loom opens the pull request now with ${given(a.title) === null && written === null ? "the title and description the reviewers approved" : "your text"}, so end your turn. It follows its checks and reviews and messages you about anything to fix.`;
}

// ---------------------------------------------------------------- the pull request's text

/** PrProposal: the title and description the worker proposed with loom_submit, which the reviewers judge with the work. */
export interface PrProposal {
  /** The commit the submit that last changed it passed its checks with; null while its checks run. */
  head: string | null;
  title: string | null;
  body: string | null;
  at: number;
}

/** A title and the worker's part of a description; a null body is Loom's template. */
export interface PrWant {
  title: string;
  body: string | null;
}

/** PrApplied: the text Loom last set on the ticket's pull request, and an edit of it still to make. */
export interface PrApplied extends PrWant {
  /** Loom could not set it through the forge, so it posted it on the ticket for the human to set. */
  byHand?: boolean;
  /** The Rollout requirements that were live when Loom last wrote the description's Rollout section. */
  live: string[];
  at: number;
  /** The text an edit that failed in a way worth waiting out still has to set. */
  want?: PrWant;
  /** When that edit, or a refresh of the Rollout section that failed the same way, is tried again. */
  wait?: MergeWait;
  /** Why Loom could not refresh the Rollout section, each reason said once on the ticket. */
  said?: string[];
}

export const proposalOf = (ticket: TicketRow) => parse<PrProposal>(ticket.pr_proposal_json);
export const appliedOf = (ticket: TicketRow) => parse<PrApplied>(ticket.pr_applied_json);

const proposedFields = (ticket: TicketRow) => {
  const proposal = proposalOf(ticket);
  return { title: proposal?.title != null, body: proposal?.body != null };
};

/** loom_submit's pr: the proposal it leaves on the ticket. The fields it gives replace the earlier proposal's, whole; the others stay. */
export function proposeText(spec: Spec, ticket: TicketRow, pr: { title?: string; body?: string }, now: number): PrProposal {
  if (spec.merge.strategy !== "pr") throw new LoomError("loom_invalid_input", "This project merges tickets into an integration branch and opens no pull request for each, so leave pr out.");
  if (prSettings(spec).describe === "loom") throw new LoomError("loom_invalid_input", 'This project\'s pull requests use Loom\'s template (merge.describe = "loom"), so leave pr out.');
  const title = pr.title?.trim();
  const body = pr.body === undefined ? undefined : withoutLoomBlocks(pr.body);
  if (title === undefined && body === undefined) throw new LoomError("loom_invalid_input", "pr is empty. Give the pull request's title, its description, or both.");
  if (title === "" || body === "") throw new LoomError("loom_invalid_input", `A field of pr is blank${body === "" && pr.body!.trim() !== "" ? ` once Loom's own sections (${LOOM_BEGIN} … ${LOOM_END}) are taken out, which Loom writes itself` : ""}. Leave out the one you do not change; the earlier proposal keeps it.`);
  const earlier = proposalOf(ticket);
  return { head: null, title: title ?? earlier?.title ?? null, body: body ?? earlier?.body ?? null, at: now };
}

const templateTitle = (ticket: TicketRow) => `${ticket.key}: ${ticket.title}`;

/**
 * The text Loom last set on the ticket's pull request; for one opened before Loom kept it, the text its posts say it
 * opened with: the worker's, else Loom's template.
 */
export function knownText(ctx: EngineCtx, ticket: TicketRow): PrWant {
  const applied = appliedOf(ticket);
  if (applied !== null) return { title: applied.title, body: applied.body };
  const posts = ctx.store.posts(ticket.id);
  for (let index = posts.length - 1; index >= 0; index -= 1) {
    const data = JSON.parse(posts[index]!.data_json) as { outcome?: string; fix?: boolean; title?: string | null; body?: string | null };
    if (posts[index]!.kind === "merge" && data.outcome === "pr_text" && data.fix !== true) return { title: data.title ?? templateTitle(ticket), body: data.body ?? null };
  }
  return { title: templateTitle(ticket), body: null };
}

const sameText = (a: PrWant, b: PrWant) => a.title === b.title && a.body === b.body;

/** Whether each field the proposal gives is the one `want` has. */
const coveredBy = (proposal: PrProposal | null, want: PrWant) => proposal === null || ((proposal.title === null || proposal.title === want.title) && (proposal.body === null || proposal.body === want.body));

/** The text the ticket's pull request is to end up with: an approved edit still waiting to be set, else the text Loom last set. */
export function targetText(ctx: EngineCtx, ticket: TicketRow): PrWant {
  return appliedOf(ticket)?.want ?? knownText(ctx, ticket);
}

/** Whether the worker proposed text that the ticket's pushed pull request is not to end up with yet: a newer one than any edit still waiting. */
export function textPending(ctx: EngineCtx, ticket: TicketRow): boolean {
  const proposal = proposalOf(ticket);
  if (proposal === null || !inFixRound(ticket)) return false;
  return !coveredBy(proposal, targetText(ctx, ticket));
}

/** Whether the reviewers approved the ticket since its newest submit: what that submit proposed has passed review. */
export function approvedSinceSubmit(store: EngineCtx["store"], ticketId: number): boolean {
  const moves = store.ticketEvents(ticketId, ["ticket.state"]).map((event) => JSON.parse(event.data_json) as { to?: string; submit?: boolean });
  const submitted = moves.map((move) => move.submit === true).lastIndexOf(true);
  return moves.slice(submitted + 1).some((move) => move.to === "approved");
}

/**
 * The text a push to an open pull request sets: loom_pr's fields, else the proposal's, else the text it is to end up with
 * (targetText). Null when that is the text it has and no edit waits; with one waiting, the newer text replaces it even
 * when it is the text the pull request has (applyPrText).
 */
export function wantedText(ctx: EngineCtx, ticket: TicketRow, text: PrText): PrWant | null {
  const target = targetText(ctx, ticket);
  const proposal = proposalOf(ticket);
  const want = { title: text.title ?? proposal?.title ?? target.title, body: text.body ?? proposal?.body ?? target.body };
  return sameText(want, knownText(ctx, ticket)) && appliedOf(ticket)?.want === undefined ? null : want;
}

/** The Rollout requirements of the ticket that are live now, sorted; null when its description has no Rollout section. */
function liveTargets(ctx: EngineCtx, spec: Spec, ticket: TicketRow): string[] | null {
  if (prRollout(ctx, spec, ticket).length === 0) return null;
  const step = rolloutOf(spec, ctx.store.tickets(ticket.project_id), ctx.store.rolloutMarks(ticket.project_id), ctx.now())
    ?.stages.flatMap((stage) => stage.steps)
    .find((each) => each.key === ticket.key);
  return (step?.requires ?? []).filter((need) => need.live && !need.cancelled && !need.unknown).map((need) => need.target).sort();
}

/** For a pull request opened before Loom kept its text: which of `live` were live already when it opened. */
function liveWhenOpened(ctx: EngineCtx, ticket: TicketRow, live: readonly string[]): string[] {
  const posts = ctx.store.posts(ticket.id);
  let at = ticket.pushed_at ?? 0;
  for (let index = posts.length - 1; index >= 0; index -= 1) {
    const data = JSON.parse(posts[index]!.data_json) as { outcome?: string; url?: string };
    if (posts[index]!.kind === "merge" && data.outcome === "pr_opened" && data.url === ticket.pr_url) {
      at = posts[index]!.at;
      break;
    }
  }
  return live.filter((target) => (ctx.store.rolloutMark(ticket.project_id, target)?.live_at ?? Number.POSITIVE_INFINITY) <= at);
}

/** What Loom records when it opens the ticket's pull request with `title` and the worker's `body`, or its template for null. */
export function openedText(ctx: EngineCtx, spec: Spec, ticket: TicketRow, title: string, body: string | null): string {
  return JSON.stringify({ title, body, live: liveTargets(ctx, spec, ticket) ?? [], at: ctx.now() } satisfies PrApplied);
}

/** The whole description for the worker's `body`, or Loom's template for null, with Loom's own sections as they are now. */
export function fullBody(ctx: EngineCtx, spec: Spec, ticket: TicketRow, body: string | null): string {
  const dependsOn = dependsOnLines(spec, ctx.store.tickets(ticket.project_id), ticket);
  const rollout = prRollout(ctx, spec, ticket);
  return body === null ? templatePr(ctx, ticket, dependsOn, rollout).body : workerPrBody(ticket.key, body, dependsOn, rollout);
}

function recordOf(ctx: EngineCtx, spec: Spec, ticket: TicketRow): PrApplied {
  const applied = appliedOf(ticket);
  if (applied !== null) return applied;
  return { ...knownText(ctx, ticket), live: liveWhenOpened(ctx, ticket, liveTargets(ctx, spec, ticket) ?? []), at: ctx.now() };
}

// `consumed`: the proposal is in `record` now, as set, waiting or posted, so it can never undo a later text.
function saveApplied(ctx: EngineCtx, ticket: TicketRow, record: PrApplied, consumed = false): void {
  ctx.store.updateTicket(ticket.id, { pr_applied_json: JSON.stringify(record), ...(consumed ? { pr_proposal_json: null } : {}) });
  ctx.store.changed(ticket.project_id);
}

const textLines = (want: PrWant) => [`Title: ${want.title}`, "", "Description:", want.body ?? "(Loom's template from the ticket)"].join("\n");

async function edit(ctx: EngineCtx, checkout: RepoCheckout, url: string, title: string, body: string): Promise<HostOutput<"prEdit">> {
  const { forge } = checkout.settings;
  try {
    return await ctx.host.call(checkout.hostId, "prEdit", { repo: checkout.path, url, title: clip(title, 256), body, forge: forge.kind === "command" ? { kind: "command", edit: forge.edit! } : { kind: "gh" } });
  } catch (error) {
    return { outcome: "unavailable", message: errText(error), ...hostCallTransient(error) };
  }
}

/** A failed edit worth waiting out: the record waits, and the first failure of a streak is posted. */
function waitOutEdit(ctx: EngineCtx, ticket: TicketRow, record: PrApplied, failure: { message: string; transient?: "server" | "rate_limit" | "network"; retryAfterMs?: number }, what: string, patch: Partial<PrApplied> = {}, consume = false): void {
  const now = ctx.now();
  const wait = nextMergeWait(record.wait ?? null, { now, message: failure.message, ...transientOf(failure)! });
  saveApplied(ctx, ticket, { ...record, ...patch, wait }, consume);
  if (record.wait === undefined) post(ctx, ticket, { body: `Loom could not ${what} with what looks like a temporary error: ${failure.message}. It tries again when it next reads the pull request, from ${formatDuration(wait.until - now)} from now; the ticket carries on.`, data: { outcome: "pr_edit_waits", url: ticket.pr_url, failures: wait.failures, until: wait.until } });
}

/**
 * Sets `want` on the ticket's open pull request through the forge's edit on the project's machine, with Loom's own
 * sections rebuilt after the worker's part. A forge that cannot edit gets the text posted on the ticket for the human
 * instead. A failure worth waiting out keeps `want` for a later read of the pull request to try again (syncPrText); any
 * other is posted, and the pull request keeps its text. Nothing here blocks the ticket or pauses the project. `want`
 * replaces an edit still waiting, as the newer approved text; when it is the text the pull request has, that edit is
 * dropped and nothing is sent. With `consume`, the worker's proposal is consumed whatever happens: `want` holds it now.
 */
export async function applyPrText(ctx: EngineCtx, spec: Spec, ticket: TicketRow, checkout: RepoCheckout, want: PrWant, consume = true): Promise<void> {
  const record = recordOf(ctx, spec, ticket);
  const { forge } = checkout.settings;
  const round = ticket.pr_rounds;
  const at = ctx.now();
  if (record.want !== undefined && !sameText(record.want, want) && sameText(want, record)) {
    post(ctx, ticket, { body: `Dropped the edit of ${ticket.pr_url ?? "the pull request"} that waited to be tried again: the newest approved title and description are the ones the pull request has.`, data: { outcome: "pr_edit_superseded", url: ticket.pr_url, round } });
    saveApplied(ctx, ticket, { ...record, want: undefined, wait: undefined, at }, consume);
    return;
  }
  const settled: PrApplied = { ...record, title: want.title, body: want.body, byHand: true, want: undefined, wait: undefined, at };
  const byHand = (why: string, outcome: string) => {
    post(ctx, ticket, { body: `${why}, so set this title and description on ${ticket.pr_url ?? "its pull request"} by hand:\n\n${textLines(want)}`, data: { outcome, url: ticket.pr_url, round, title: want.title, body: want.body } });
    saveApplied(ctx, ticket, settled, consume);
  };
  if (ticket.pr_url === null || !canEdit(forge)) return byHand("Loom cannot change a pull request's text through this forge", "pr_text_by_hand");
  const body = fullBody(ctx, spec, ticket, want.body);
  if (body.length > PR_BODY_MAX) return byHand(`Loom did not set the title and description of ${ticket.pr_url}: with its own sections the description would be ${body.length} characters, over the ${PR_BODY_MAX} a pull request takes, and Loom never cuts one short. The pull request keeps its text`, "pr_edit_failed");
  const answer = await edit(ctx, checkout, ticket.pr_url, want.title, body);
  if (answer.outcome === "ok") {
    post(ctx, ticket, { body: `Set the title and description of ${ticket.pr_url} to the ones the reviewers approved.`, data: { outcome: "pr_edited", url: ticket.pr_url, round, title: want.title, body: want.body } });
    saveApplied(ctx, ticket, { ...settled, byHand: undefined, live: liveTargets(ctx, spec, ticket) ?? record.live }, consume);
  } else if (answer.transient !== undefined) {
    waitOutEdit(ctx, ticket, record, answer, "set the pull request's title and description", { want }, consume);
  } else {
    byHand(`Loom could not set the title and description of ${ticket.pr_url}: ${answer.message}. The pull request keeps its text`, "pr_edit_failed");
  }
}

/**
 * After a read of the ticket's open pull request, with its title and description as the read gave them (null when it
 * gave none): tries again an edit whose wait ended, and when a Rollout requirement went live, or stopped being live, since
 * Loom last wrote the description, puts the Rollout section as it is now between Loom's markers, keeping the rest as it
 * is. Without the description, with no markers in it, or through a forge that cannot edit, Loom says so once on the
 * ticket instead; the Rollout tab stays the source of truth. Only while the project runs.
 */
export async function syncPrText(ctx: EngineCtx, project: ProjectRow, ticketId: number, current: { title: string | null; body: string | null } | null): Promise<void> {
  const ticket = ctx.store.ticket(ticketId);
  if (ctx.store.project(project.id)?.state !== "running" || ticket === null || ticket.pr_url === null || (ticket.state !== "pr_open" && ticket.state !== "working")) return;
  const spec = specOf(ctx.store, project);
  if (repoSettings(spec, ticket.repo).forge.kind === "none") return;
  try {
    const applied = appliedOf(ticket);
    if (applied?.wait !== undefined && ctx.now() < applied.wait.until) return;
    if (applied?.want !== undefined) {
      // A fix round's push sets it with the rest of its text. A newer proposal than the waiting edit is kept for that push.
      if (ticket.state === "pr_open") await applyPrText(ctx, spec, ticket, await repoCheckout(ctx, project, spec, ticket.repo), applied.want, coveredBy(proposalOf(ticket), applied.want));
      return;
    }
    const live = liveTargets(ctx, spec, ticket);
    if (live === null) return;
    const record = recordOf(ctx, spec, ticket);
    if (live.length === record.live.length && live.every((target, index) => target === record.live[index])) return;
    await refreshRollout(ctx, spec, ticket, await repoCheckout(ctx, project, spec, ticket.repo), record, live, current);
  } catch (error) {
    ctx.bb.log("warn", `Keeping the text of ${ticket.key}'s pull request up to date stopped: ${errText(error)}`);
  }
}

async function refreshRollout(ctx: EngineCtx, spec: Spec, ticket: TicketRow, checkout: RepoCheckout, record: PrApplied, live: string[], current: { title: string | null; body: string | null } | null): Promise<void> {
  const url = ticket.pr_url!;
  const went = live.filter((target) => !record.live.includes(target));
  const left = record.live.filter((target) => !live.includes(target));
  const what = went.length > 0 ? `${andList(went)} ${went.length === 1 ? "is" : "are"} live now` : `${andList(left)} ${left.length === 1 ? "is" : "are"} not live any more`;
  const said = record.said ?? [];
  const cannot = (reason: string, why: string) => {
    if (!said.includes(reason)) post(ctx, ticket, { body: `The Rollout section of ${url} is out of date: ${what}, but ${why}. The project's Rollout tab has the order as it is now.`, data: { outcome: "rollout_not_refreshed", url, reason, live } });
    saveApplied(ctx, ticket, { ...record, live, wait: undefined, said: said.includes(reason) ? said : [...said, reason] });
  };
  if (!canEdit(checkout.settings.forge)) return cannot("forge", "Loom cannot change a pull request's description through this forge");
  if (current?.body == null) return cannot("body", "the forge's read of the pull request gives no description for Loom to change");
  const block = loomBlock(ticket.key, dependsOnLines(spec, ctx.store.tickets(ticket.project_id), ticket), prRollout(ctx, spec, ticket));
  const replaced = replaceLoomBlock(current.body, block);
  if ("problem" in replaced && replaced.problem === "none") return cannot("markers", `its description has no Loom markers (${LOOM_BEGIN} and ${LOOM_END}) around the part Loom may replace`);
  if ("problem" in replaced) return cannot("blocks", `its description has Loom's markers more than once, so Loom cannot tell which part is its own`);
  const next = replaced.body;
  if (next === current.body) return saveApplied(ctx, ticket, { ...record, live, wait: undefined });
  // A read-modify-write never cuts the description short: that would delete what people wrote outside Loom's markers.
  if (next.length > PR_BODY_MAX) return cannot("size", `with the Rollout section as it is now the description would be ${next.length} characters, over the ${PR_BODY_MAX} a pull request takes, and Loom never cuts one short`);
  const answer = await edit(ctx, checkout, url, current.title ?? record.title, next);
  if (answer.outcome === "ok") {
    post(ctx, ticket, { body: `Refreshed the Rollout section of ${url}: ${what}.`, data: { outcome: "rollout_refreshed", url, live } });
    saveApplied(ctx, ticket, { ...record, live, wait: undefined });
  } else if (answer.transient !== undefined) {
    waitOutEdit(ctx, ticket, record, answer, `refresh the Rollout section of ${url}`);
  } else {
    post(ctx, ticket, { body: `Loom could not refresh the Rollout section of ${url}: ${answer.message}. The pull request keeps its description; the project's Rollout tab has the order as it is now.`, data: { outcome: "rollout_not_refreshed", url, reason: "edit", live } });
    saveApplied(ctx, ticket, { ...record, live, wait: undefined });
  }
}

// ---------------------------------------------------------------- replies to the pull request's feedback

/** How many replies a worker may post through Loom in one fix round. */
export const REPLIES_PER_ROUND = 30;
const REPLY_EVENT = "ticket.pr_reply";

const PUSHED = ["pr_opened", "pr_pushed", "pr_unchanged", "branch_pushed"];

/** The feedback item Loom sent the worker under `key` in a fix round since its last push; null for none. */
function sentItem(posts: readonly PostRow[], key: string): FeedbackItem | null {
  for (let index = posts.length - 1; index >= 0; index -= 1) {
    const data = JSON.parse(posts[index]!.data_json) as { outcome?: string; items?: FeedbackItem[] };
    if (posts[index]!.kind !== "merge") continue;
    if (PUSHED.includes(data.outcome ?? "")) return null;
    const item = data.outcome === "pr_feedback" ? data.items?.find((each) => each.key === key && each.kind !== "reply") : undefined;
    if (item !== undefined) return item;
  }
  return null;
}

const ITEM_NAMES = { review: "review", thread: "review thread", comment: "comment", reply: "reply" } as const;

/**
 * loom_pr_reply: the worker of a ticket in a fix round answers one item of the feedback Loom sent it, by the item's key,
 * through the forge on the project's machine, so a worker on a machine of its own needs no forge access. The text ends
 * with the comment signature and Loom's reply mark, which makes a later read count the reply as the worker's own, never as
 * new feedback. Every call is posted on the ticket, and a fix round takes at most REPLIES_PER_ROUND of them.
 */
export async function replyToItem(ctx: EngineCtx, threadId: string, a: { item: string; text: string; resolve?: boolean }): Promise<string> {
  const { store } = ctx;
  const row = store.threadByThreadId(threadId);
  if (row === null || row.role !== "worker") throw new LoomError("loom_forbidden", "loom_pr_reply is for a Loom worker thread.");
  const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
  const live = row.state === "active" && ticket !== null && ticket.worker_thread_id === threadId && ["working", "checking", "review", "approved"].includes(ticket.state);
  const posts = live ? store.posts(ticket.id) : [];
  if (!live || ticket.pr_url === null || openFeedback(posts) === null) {
    throw new LoomError("loom_invalid_state", "loom_pr_reply answers the feedback of a fix round on your ticket's open pull request, and no fix round is open now.");
  }
  const project = store.project(ticket.project_id)!;
  const spec = specOf(store, project);
  const { forge } = repoSettings(spec, ticket.repo);
  if (!canReply(forge)) throw new LoomError("loom_invalid_state", "Loom cannot reply on this pull request through its forge. Say what you would answer in your loom_submit summary instead; the human reads it on the ticket.");
  const item = sentItem(posts, a.item);
  if (item === null) throw new LoomError("loom_not_found", `No item \`${a.item}\` in the feedback Loom sent you since its last push. Name an item by its key exactly as the fix round's message lists it.`);
  const text = a.text.trim();
  if (text === "") throw new LoomError("loom_invalid_input", "text is empty. Write the reply.");
  // Each call takes its place in the round's count before anything waits, so calls made at once cannot pass the cap together.
  const round = ticket.pr_rounds;
  store.tx(() => {
    const taken = store.ticketEvents(ticket.id, [REPLY_EVENT]).filter((event) => (JSON.parse(event.data_json) as { round?: number }).round === round).length;
    if (taken >= REPLIES_PER_ROUND) throw new LoomError("loom_invalid_state", `You posted ${REPLIES_PER_ROUND} replies in this fix round, the most Loom sends in one. Say the rest in your loom_submit summary.`);
    store.event(ticket.project_id, ticket.id, REPLY_EVENT, threadId, { round, item: a.item });
  });
  const kind = item.kind as "review" | "thread" | "comment";
  const resolve = a.resolve === true && kind === "thread";
  const signature = signatureOf(ctx).trim();
  const signed = `${text}${signature === "" ? "" : `\n\n${signature}`}\n${REPLY_MARK}`;
  // A review or a comment has no thread on GitHub, so the reply is a comment that quotes what it answers.
  const first = item.body.trim().split("\n")[0] ?? "";
  const quoted = forge.kind === "gh" && kind !== "thread" ? `> ${clip(first, 200)}\n\nIn reply to ${item.url ?? `${item.author}'s ${ITEM_NAMES[kind]}`}\n\n${signed}` : signed;
  const checkout = await repoCheckout(ctx, project, spec, ticket.repo);
  let answer: HostOutput<"prReply">;
  try {
    answer = await ctx.host.call(checkout.hostId, "prReply", { repo: checkout.path, url: ticket.pr_url, key: a.item, kind, body: quoted, resolve, forge: forge.kind === "command" ? { kind: "command", reply: forge.reply! } : { kind: "gh" } });
  } catch (error) {
    answer = { outcome: "unavailable", message: errText(error), ...hostCallTransient(error) };
  }
  const what = `the ${ITEM_NAMES[kind]}${item.path === null ? "" : ` on ${item.path}${item.line === null ? "" : `:${item.line}`}`} by ${item.author}`;
  const posted = answer.outcome === "ok" ? answer : null;
  const resolved = posted?.resolved === true;
  const body = posted !== null ? `The worker replied to ${what}${resolved ? " and resolved it" : ""}:\n\n${clip(text, 2000)}` : `The worker's reply to ${what} did not go out: ${answer.message}`;
  post(ctx, ticket, { author: "worker", threadId, body, data: { outcome: "pr_reply", round, item: a.item, kind, ok: posted !== null, url: posted?.url ?? null, resolved } });
  store.changed(ticket.project_id);
  if (answer.outcome === "unavailable") {
    throw new LoomError("loom_unavailable", `The forge did not take the reply: ${answer.message}`, answer.transient === undefined ? undefined : "That looks temporary; try again in a minute.");
  }
  const unresolved = a.resolve === true && !answer.resolved ? ` It is not resolved: ${answer.message ?? (kind === "thread" ? "the forge did not say why" : `a ${ITEM_NAMES[kind]} has no thread to resolve`)}.` : "";
  return `Replied to ${what}${answer.url === null ? "" : ` (${answer.url})`}${resolved ? " and resolved the thread" : ""}.${unresolved}`;
}

// ---------------------------------------------------------------- following the open pull request

/** The checks counted on the ticket page, from the forge's latest answer, with when Loom first saw each queued one; and how long the passed ones took. */
export function recordStatus(ctx: EngineCtx, ticket: TicketRow, feedback: Feedback): PrStatus {
  const now = ctx.now();
  const count = (state: string) => feedback.checks.filter((check) => check.state === state).length;
  const queued = queuedSince(feedback.checks, statusOf(ticket), { head: feedback.head, pushedSha: ticket.pushed_sha, pushedAt: ticket.pushed_at, now });
  const status: PrStatus = { at: now, head: feedback.head, passed: count("passed"), failed: count("failed"), pending: count("pending"), queued };
  ctx.store.updateTicket(ticket.id, { pr_status_json: JSON.stringify(status) });
  const runs = feedback.checks.flatMap((check) =>
    check.state === "passed" && check.startedAt != null && check.completedAt != null && check.completedAt > check.startedAt ? [{ name: check.name, key: check.key, durationMs: check.completedAt - check.startedAt, at: check.completedAt }] : [],
  );
  ctx.store.addCheckDurations(durationsKey(ticket.pr_url, ticket.project_id, ticket.repo), runs);
  return status;
}

/** The spec's check wait for this project, else Loom's settings. */
export const checkWait = (ctx: EngineCtx, spec: Spec): CheckWait =>
  checkWaitOf(spec, { settleMs: ctx.checksSettleMs?.() ?? CHECKS_SETTLE_MS, queuedMinutes: ctx.checksQueuedMinutes?.(), nearDonePercent: ctx.checksNearDonePercent?.() });

interface Sorted {
  checks: Array<FeedbackCheck & { key: string }>;
  items: Array<FeedbackItem & { key: string }>;
  /** Not counted: bots' top-level comments, and anything from the pull request's author, whom a worker's replies come from, or with Loom's reply mark. */
  ignored: { bots: number; own: number; keys: string[] };
  /** Pending checks the round does not wait for, when it sends failed ones. */
  skipped: Skipped[];
}

/** What newFeedback needs besides the forge's answer: when Loom first saw each queued check, the checks' usual durations and the wait. */
export interface CheckContext {
  queued: Record<string, number>;
  usual: ReadonlyMap<string, number>;
  wait: CheckWait;
}

/** The feedback not yet sent to a worker that asks for a fix. Failed checks wait until no pending check holds them (holdOf), or the settle time after the push. */
export function newFeedback(ticket: TicketRow, feedback: Feedback, now: number, context: CheckContext): Sorted {
  const seen = new Set(JSON.parse(ticket.pr_seen_json) as string[]);
  const failed = feedback.checks.filter((check) => check.state === "failed" && !seen.has(check.key));
  const hold = failed.length === 0 ? { settled: false, skipped: [] } : holdOf(feedback.checks, { ...context, now, pushedAt: ticket.pushed_at });
  const checks = hold.settled ? failed.map((check) => ({ key: check.key, name: check.name, url: check.url })) : [];
  const sorted: Sorted = { checks, items: [], ignored: { bots: 0, own: 0, keys: [] }, skipped: hold.settled ? hold.skipped : [] };
  for (const item of feedback.items) {
    if (seen.has(item.key)) continue;
    // A reply the worker posted through Loom ends with its mark, whichever account the forge posted it from.
    if ((feedback.author !== "" && item.author === feedback.author) || item.body.trimEnd().endsWith(REPLY_MARK)) {
      sorted.ignored.own += 1;
      sorted.ignored.keys.push(item.key);
    } else if (item.kind === "comment" && item.bot) {
      sorted.ignored.bots += 1;
      sorted.ignored.keys.push(item.key);
    } else if (item.kind !== "review" || item.state === "changes_requested" || (item.state === "commented" && item.body.trim() !== "")) {
      sorted.items.push({ key: item.key, kind: item.kind, author: item.author, bot: item.bot, body: item.body, url: item.url, state: item.state, path: item.path, line: item.line });
    } else {
      sorted.ignored.keys.push(item.key);
    }
  }
  return sorted;
}

/**
 * Sends what the forge's latest answer asks for to the worker as a fix round, and marks everything it read as seen. On a
 * repo whose CI Loom ignores (ci = false), a failed check is counted on the ticket but never sent.
 */
export async function followFeedback(ctx: EngineCtx, project: ProjectRow, ticket: TicketRow, read: Feedback): Promise<void> {
  const { store } = ctx;
  const spec = specOf(store, project);
  const settings = repoSettings(spec, ticket.repo);
  // The checks ignore_checks names are dropped before anything counts them: the ticket page, the board, the merge order and the fix round.
  let feedback: Feedback = { ...read, checks: keptChecks(settings.forge, read.checks).kept };
  const status = recordStatus(ctx, ticket, feedback);
  if (project.state !== "running") return;
  if (!settings.ci) feedback = { ...feedback, checks: [] };
  const pending = feedback.checks.filter((check) => check.state === "pending").map((check) => check.name);
  const durations = store.checkDurations(durationsKey(ticket.pr_url, ticket.project_id, ticket.repo), pending, USUAL_RUNS);
  const usual = new Map([...durations].map(([name, runs]) => [name, median(runs)!]));
  const found = newFeedback(ticket, feedback, ctx.now(), { queued: status.queued ?? {}, usual, wait: checkWait(ctx, spec) });
  if (found.checks.length === 0 && found.items.length === 0) {
    if (found.ignored.keys.length > 0) markSeen(ctx, ticket, found.ignored.keys);
    return;
  }
  // Someone else pushed to the pull request's branch: Loom merges their commits into work it keeps, so the fix builds on them.
  const foreign = ticket.pushed_sha !== null && feedback.head !== ticket.pushed_sha ? await takeForRound(ctx, project, ticket) : null;
  await startFixRound(ctx, ticket, {
    checks: found.checks,
    items: found.items,
    seen: [...found.checks, ...found.items].map((entry) => entry.key).concat(found.ignored.keys),
    ignored: found.ignored,
    skipped: found.skipped,
    foreign,
    human: false,
  });
}

/** The checks a forge's ignore_checks keeps, and the ones it drops by name. */
export function keptChecks<T extends { name: string }>(forge: ForgeSpec, checks: readonly T[]): { kept: T[]; ignored: T[] } {
  const patterns = forge.ignore_checks ?? [];
  const kept: T[] = [];
  const ignored: T[] = [];
  for (const check of checks) (patterns.some((pattern) => globMatch(pattern, check.name)) ? ignored : kept).push(check);
  return { kept, ignored };
}

/**
 * Whether `text` matches the glob `pattern`, whole and case-sensitively: `*` is any run of characters, `?` one, and the
 * rest is literal. Two pointers, going back only to the last `*`, so the time is at most the product of the lengths.
 */
export function globMatch(pattern: string, text: string): boolean {
  const glob = [...pattern];
  const chars = [...text];
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < chars.length) {
    if (p < glob.length && glob[p] !== "*" && (glob[p] === "?" || glob[p] === chars[t])) {
      p += 1;
      t += 1;
    } else if (p < glob.length && glob[p] === "*") {
      star = p;
      p += 1;
      resume = t;
    } else if (star >= 0) {
      p = star + 1;
      resume += 1;
      t = resume;
    } else {
      return false;
    }
  }
  while (p < glob.length && glob[p] === "*") p += 1;
  return p === glob.length;
}

function markSeen(ctx: EngineCtx, ticket: TicketRow, keys: readonly string[]): void {
  const seen = new Set(JSON.parse(ctx.store.ticket(ticket.id)!.pr_seen_json) as string[]);
  for (const key of keys) seen.add(key);
  ctx.store.updateTicket(ticket.id, { pr_seen_json: JSON.stringify([...seen]) });
}

/** A human's reply on a ticket whose pull request is open starts a fix round, whatever the forge can tell Loom. */
export async function humanFixRound(ctx: EngineCtx, ticket: TicketRow, reply: PostRow): Promise<boolean> {
  if (ticket.state !== "pr_open" || !delivers(ctx, ticket.project_id)) return false;
  const item: FeedbackItem = { kind: "reply", author: "the human", body: reply.body, url: null, state: null, path: null, line: null };
  return startFixRound(ctx, ticket, { checks: [], items: [item], seen: [], ignored: { bots: 0, own: 0 }, skipped: [], foreign: null, human: true, replyId: reply.id });
}

interface Round {
  checks: FeedbackCheck[];
  items: FeedbackItem[];
  seen: string[];
  ignored: { bots: number; own: number };
  skipped: Skipped[];
  foreign: ForeignTip | null;
  human: boolean;
  replyId?: number;
}

/** Fix rounds the pull request's feedback started since the ticket was last requeued; the human's replies and requeues do not count. */
export function forgeRoundsSinceRequeue(store: EngineCtx["store"], ticketId: number): number {
  let count = 0;
  for (const event of store.ticketEvents(ticketId, ["ticket.state"])) {
    const data = JSON.parse(event.data_json) as { from?: string; to?: string; fixRound?: number; human?: boolean; requeued?: boolean };
    if (data.from === "blocked" && (data.to === "queued" || data.requeued === true)) count = 0;
    else if (data.from === "pr_open" && data.fixRound !== undefined && data.human !== true) count += 1;
  }
  return count;
}

/**
 * pr_open to working with the feedback (or to queued when the worker is gone), or blocked once the fix rounds are used
 * up, in one transaction. The message to the worker is stored with the move as a hand-back, which waits for a worker slot
 * and is sent after it, so a failed send or a restart sends it again (deliverHandBacks). A worker that is ending owns the
 * ticket's move, so the round waits. A worker Loom released comes back for the round once it has a slot: its environment
 * is restored first, and the message waits for it.
 */
async function startFixRound(ctx: EngineCtx, seen: TicketRow, a: Round): Promise<boolean> {
  const { store } = ctx;
  const spec = specOf(store, store.project(seen.project_id)!);
  const max = prSettings(spec).maxFixRounds;
  const result = store.tx((): { kind: "working" } | { kind: "queued" } | { kind: "blocking"; worker: ThreadRow } | { kind: "blocked" } | null => {
    const ticket = store.ticket(seen.id);
    if (ticket?.state !== "pr_open") return null;
    const worker = workerOf(store, ticket);
    if (worker.standing === "ending") return null;
    const round = ticket.pr_rounds + 1;
    const counted = forgeRoundsSinceRequeue(store, ticket.id) + (a.human ? 0 : 1);
    const seenKeys = new Set(JSON.parse(ticket.pr_seen_json) as string[]);
    for (const key of a.seen) seenKeys.add(key);
    if (!a.human && counted > max) {
      const reason = `the pull request's checks and reviews needed more than ${plural(max, "fix round")}`;
      // Claiming the worker here makes its ending, which carries the ticket's move to blocked, replayable by the tick.
      if (worker.standing === "active" && !store.claimThread(worker.row.id, "blocked")) return null;
      store.updateTicket(ticket.id, { pr_seen_json: JSON.stringify([...seenKeys]), blocked_reason: reason });
      post(ctx, ticket, { body: `Pull request feedback over the limit of ${plural(max, "fix round")}:\n\n${feedbackList(a.checks, a.items, a.skipped)}`, data: feedbackData(ticket, round, counted, a, true) });
      store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "block", body: reason, data_json: JSON.stringify({ reason, needs: "" }) });
      if (worker.standing === "active") return { kind: "blocking", worker: store.thread(worker.row.id)! };
      applyMove(ctx, store.ticket(ticket.id)!, { to: "blocked", patch: { ...released, blocked_reason: reason } }, LOOM_ACTOR, { reason });
      return { kind: "blocked" };
    }
    store.updateTicket(ticket.id, { pr_seen_json: JSON.stringify([...seenKeys]), pr_rounds: round, pr_ask_json: null, pr_text_json: null });
    const body = a.human ? `Your reply starts fix round ${round} on the pull request.` : `Pull request feedback for fix round ${round} (${counted} of ${max} the pull request may start):\n\n${feedbackList(a.checks, a.items, a.skipped)}`;
    post(ctx, ticket, { body, data: feedbackData(ticket, round, counted, a, false) });
    const move = { fixRound: round, ...(a.human ? { human: true } : {}) };
    const asleep = releasedWorker(store, ticket);
    const thread = worker.standing === "active" ? worker.row.thread_id : (asleep?.thread_id ?? null);
    if (thread !== null) {
      const text = prFeedbackText({ key: ticket.key, url: ticket.pr_url, round, counted, max, checks: a.checks, items: a.items, skipped: a.skipped, foreign: a.foreign, forge: repoSettings(spec, ticket.repo).forge, signature: signatureOf(ctx), restored: asleep !== null || (worker.standing === "active" && isWaking(worker.row)) });
      handBack(ctx, store.ticket(ticket.id)!, worker.standing === "active" ? worker.row : null, thread, text, move);
      return { kind: "working" };
    }
    applyMove(ctx, store.ticket(ticket.id)!, { to: "queued", patch: released }, LOOM_ACTOR, { ...move, reason: "the worker is gone" });
    return { kind: "queued" };
  });
  if (result === null) return false;
  store.changed(seen.project_id);
  ctx.kick();
  if (result.kind === "blocking") await resumeEnding(ctx, result.worker);
  else if (result.kind === "working") await deliverHandBacks(ctx, seen.project_id);
  return true;
}

function feedbackData(ticket: TicketRow, round: number, counted: number, a: Round, overLimit: boolean): object {
  return {
    outcome: "pr_feedback",
    round,
    counted: a.human ? null : counted,
    head: ticket.head_sha,
    tree: ticket.head_tree,
    overLimit,
    human: a.human,
    replyId: a.replyId ?? null,
    url: ticket.pr_url,
    diverged: a.foreign !== null,
    ...(a.foreign?.kind === "took" ? { tip: a.foreign.tip } : {}),
    checks: a.checks.map((check) => ({ name: check.name, url: check.url })),
    skipped: a.skipped,
    items: a.items.map((item) => ({ ...(item.key === undefined ? {} : { key: item.key }), kind: item.kind, author: item.author, bot: item.bot === true, body: item.body.slice(0, 2000), url: item.url, state: item.state, path: item.path, line: item.line })),
    ignored: a.ignored,
  };
}

/** The feedback a fix round answers: the newest feedback post, unless Loom pushed or found nothing to push since. */
export function openFeedback(posts: readonly PostRow[]): PostRow | null {
  for (let index = posts.length - 1; index >= 0; index -= 1) {
    const candidate = posts[index]!;
    if (candidate.kind !== "merge") continue;
    const outcome = (JSON.parse(candidate.data_json) as { outcome?: string }).outcome;
    if (outcome === "pr_feedback") return candidate;
    if (outcome === "pr_opened" || outcome === "pr_pushed" || outcome === "pr_unchanged" || outcome === "branch_pushed") return null;
  }
  return null;
}

/**
 * Who to ask for a new review once Loom pushes a fix: the people whose reviews and review threads the fix rounds since
 * its last push sent the worker. Bots cannot be asked, and "ghost" is GitHub's name for a deleted account.
 */
export function reviewersToAsk(posts: readonly PostRow[]): string[] {
  type Data = { outcome?: string; items?: Array<{ kind?: string; author?: string; bot?: boolean }> };
  const rounds: Data[] = [];
  for (let index = posts.length - 1; index >= 0; index -= 1) {
    const candidate = posts[index]!;
    if (candidate.kind !== "merge") continue;
    const data = JSON.parse(candidate.data_json) as Data;
    if (data.outcome === "pr_opened" || data.outcome === "pr_pushed" || data.outcome === "pr_unchanged" || data.outcome === "branch_pushed") break;
    if (data.outcome === "pr_feedback") rounds.unshift(data);
  }
  const reviewers = new Set<string>();
  for (const item of rounds.flatMap((round) => round.items ?? [])) {
    if ((item.kind === "review" || item.kind === "thread") && item.bot !== true && item.author !== undefined && item.author !== "ghost") reviewers.add(item.author);
  }
  return [...reviewers];
}

/**
 * Whether a fix round's submit changed nothing: its tree is still the one the open feedback was sent for. A commit
 * carried from another machine comes back with a new id, so the tree decides; a post from before trees were kept has
 * only the head.
 */
export function unchangedFix(posts: readonly PostRow[], head: { sha: string; tree: string }): boolean {
  const open = openFeedback(posts);
  if (open === null) return false;
  const data = JSON.parse(open.data_json) as { head?: string | null; tree?: string | null };
  return data.tree != null ? data.tree === head.tree : data.head === head.sha;
}

/** When a closed pull request blocks its ticket, a requeue starts a new one: one commit on a new branch, with fresh rounds. */
export const closedPrReset = { pr_branch: null, pushed_sha: null, pushed_at: null, pr_ask_json: null, pr_text_json: null, pr_seen_json: "[]", pr_rounds: 0, pr_status_json: null, handback_json: null, pr_base: null, pr_applied_json: null } as const;
