// The pull request stage on the pr strategy. After approval the worker writes the pull request (loom_pr), or Loom's
// template stands in. While it is open, Loom follows its checks and reviews through the forge and sends what needs a fix
// back to the worker as a fix round, which goes through the checks and a review again before Loom pushes one more
// commit. Merging stays the human's.
import { delivers, workerOf } from "./checks";
import type { PostRow, ProjectRow, ThreadRow, TicketRow } from "./db/store";
import type { HostOutput } from "./host-contract";
import { plural } from "./format";
import { LoomError } from "./projects";
import { feedbackList, prAskText, prBody, prFeedbackText, prNudgeText, type FeedbackCheck, type FeedbackItem } from "./prompts";
import { prSettings, repoSettings } from "./repos";
import type { Spec } from "./spec";
import { LOOM_ACTOR } from "./states";
import { applyMove, released, resumeEnding, signatureOf, specOf, toWorking, type EngineCtx } from "./workers";

/** How long the worker has to hand in loom_pr before Loom's template stands in; paused time does not count. */
export const PR_TEXT_MINUTES = 30;
const PR_TEXT_MS = PR_TEXT_MINUTES * 60_000;
/** Failed checks wait for the rest to finish, or this long after the push: some status checks stay pending until a person approves. Loom's checksSettleMinutes setting changes it. */
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
export function templatePr(ctx: EngineCtx, ticket: TicketRow, dependsOn: string[] = []): { title: string; body: string } {
  const approvals = ctx.store.reviews(ticket.id, ticket.review_round).filter((review) => review.verdict === "approved");
  return { title: `${ticket.key}: ${ticket.title}`, body: prBody({ ticket, approvals, dependsOn }) };
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

/** The tick's step before the merge queue: ask each approved ticket's worker for its pull request, once per head, or let the template stand in. */
export async function askForPrTexts(ctx: EngineCtx, project: ProjectRow, spec: Spec): Promise<void> {
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
    const fix = inFixRound(ticket);
    store.tx(() => {
      store.updateTicket(ticket.id, { pr_ask_json: JSON.stringify({ head: ticket.head_sha!, at: ctx.now(), fix, nudged: false } satisfies PrAsk) });
      store.updateThread(worker.row.id, { idle_count: 0 });
    });
    store.changed(project.id);
    try {
      await ctx.bb.send(worker.row.thread_id, prAskText({ key: ticket.key, fix, round: ticket.pr_rounds, url: ticket.pr_url, limitMinutes: PR_TEXT_MINUTES }));
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
  await ctx.bb.send(row.thread_id, prNudgeText(ticket.key, ask.fix)).catch((error) => ctx.bb.log("warn", `Could not nudge ${row.thread_id}: ${errText(error)}`));
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

/** loom_pr: the worker of an approved ticket hands in its pull request's text, or a fix round's commit message. */
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
  const title = a.title?.trim() ?? "";
  const body = a.body?.trim() ?? "";
  if (commit === "") throw new LoomError("loom_invalid_input", "commit_message is empty. Write a subject line, a blank line, then a short body.");
  if (!ask.fix && (title === "" || body === "")) throw new LoomError("loom_invalid_input", "This opens the pull request, so it needs a title and a body as well as the commit_message.");
  const text: PrText = { head: ticket.head_sha!, by: "worker", title: ask.fix ? null : title, body: ask.fix ? null : body, commit };
  store.tx(() => {
    store.updateTicket(ticket.id, { pr_text_json: JSON.stringify(text) });
    post(ctx, ticket, {
      author: "worker",
      threadId,
      body: ask.fix ? `The worker wrote the commit message for fix round ${ticket.pr_rounds}.` : `The worker wrote the pull request: ${title}`,
      data: { outcome: "pr_text", by: "worker", fix: ask.fix, round: ticket.pr_rounds, title: text.title, body: text.body, commit },
    });
  });
  store.changed(ticket.project_id);
  ctx.kick();
  return ask.fix
    ? `Loom pushes the fix as one more commit with your message now, so end your turn. It keeps following the pull request and messages you about anything else to fix.`
    : `Loom opens the pull request with your text now, so end your turn. It follows its checks and reviews and messages you about anything to fix.`;
}

// ---------------------------------------------------------------- following the open pull request

/** The checks counted on the ticket page, from the forge's latest answer. */
export function recordStatus(ctx: EngineCtx, ticket: TicketRow, feedback: Feedback): void {
  const count = (state: string) => feedback.checks.filter((check) => check.state === state).length;
  const status: PrStatus = { at: ctx.now(), head: feedback.head, passed: count("passed"), failed: count("failed"), pending: count("pending") };
  ctx.store.updateTicket(ticket.id, { pr_status_json: JSON.stringify(status) });
}

interface Sorted {
  checks: Array<FeedbackCheck & { key: string }>;
  items: Array<FeedbackItem & { key: string }>;
  /** Not counted: bots' top-level comments, and anything from the pull request's author, whom a worker's replies come from. */
  ignored: { bots: number; own: number; keys: string[] };
}

/** The feedback not yet sent to a worker that asks for a fix. Failed checks wait until no check runs, or `settleMs` after the push. */
export function newFeedback(ticket: TicketRow, feedback: Feedback, now: number, settleMs: number = CHECKS_SETTLE_MS): Sorted {
  const seen = new Set(JSON.parse(ticket.pr_seen_json) as string[]);
  const settled = !feedback.checks.some((check) => check.state === "pending") || (ticket.pushed_at !== null && now - ticket.pushed_at >= settleMs);
  const checks = settled ? feedback.checks.filter((check) => check.state === "failed" && !seen.has(check.key)).map((check) => ({ key: check.key, name: check.name, url: check.url })) : [];
  const sorted: Sorted = { checks, items: [], ignored: { bots: 0, own: 0, keys: [] } };
  for (const item of feedback.items) {
    if (seen.has(item.key)) continue;
    if (feedback.author !== "" && item.author === feedback.author) {
      sorted.ignored.own += 1;
      sorted.ignored.keys.push(item.key);
    } else if (item.kind === "comment" && item.bot) {
      sorted.ignored.bots += 1;
      sorted.ignored.keys.push(item.key);
    } else if (item.kind !== "review" || item.state === "changes_requested" || (item.state === "commented" && item.body.trim() !== "")) {
      sorted.items.push({ key: item.key, kind: item.kind, author: item.author, body: item.body, url: item.url, state: item.state, path: item.path, line: item.line });
    } else {
      sorted.ignored.keys.push(item.key);
    }
  }
  return sorted;
}

/** Sends what the forge's latest answer asks for to the worker as a fix round, and marks everything it read as seen. */
export async function followFeedback(ctx: EngineCtx, project: ProjectRow, ticket: TicketRow, feedback: Feedback): Promise<void> {
  const { store } = ctx;
  recordStatus(ctx, ticket, feedback);
  if (project.state !== "running") return;
  const found = newFeedback(ticket, feedback, ctx.now(), ctx.checksSettleMs?.() ?? CHECKS_SETTLE_MS);
  if (found.checks.length === 0 && found.items.length === 0) {
    if (found.ignored.keys.length > 0) markSeen(ctx, ticket, found.ignored.keys);
    return;
  }
  const spec = specOf(store, project);
  const settings = repoSettings(spec, ticket.repo);
  const diverged = ticket.pushed_sha !== null && feedback.head !== ticket.pushed_sha ? { remote: settings.remote, branch: ticket.pr_branch ?? ticket.branch ?? "" } : null;
  await startFixRound(ctx, ticket, { checks: found.checks, items: found.items, seen: [...found.checks, ...found.items].map((entry) => entry.key).concat(found.ignored.keys), ignored: found.ignored, diverged, human: false });
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
  return startFixRound(ctx, ticket, { checks: [], items: [item], seen: [], ignored: { bots: 0, own: 0 }, diverged: null, human: true, replyId: reply.id });
}

interface Round {
  checks: FeedbackCheck[];
  items: FeedbackItem[];
  seen: string[];
  ignored: { bots: number; own: number };
  diverged: { remote: string; branch: string } | null;
  human: boolean;
  replyId?: number;
}

/** Fix rounds the pull request's feedback started since the ticket was last requeued; the human's replies and requeues do not count. */
export function forgeRoundsSinceRequeue(store: EngineCtx["store"], ticketId: number): number {
  let count = 0;
  for (const event of store.ticketEvents(ticketId, ["ticket.state"])) {
    const data = JSON.parse(event.data_json) as { from?: string; to?: string; fixRound?: number; human?: boolean };
    if (data.from === "blocked" && data.to === "queued") count = 0;
    else if (data.from === "pr_open" && data.fixRound !== undefined && data.human !== true) count += 1;
  }
  return count;
}

/** A fix round's message waiting for bb to take it. */
interface PrDelivery {
  thread: string;
  text: { summary: string; detail: string };
}

/**
 * pr_open to working with the feedback (or to queued when the worker is gone), or blocked once the fix rounds are used
 * up, in one transaction. The message to the worker is stored with the move and sent after it, so a failed send or a
 * restart sends it again (deliverFixRounds). A worker that is ending owns the ticket's move, so the round waits.
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
      post(ctx, ticket, { body: `Pull request feedback over the limit of ${plural(max, "fix round")}:\n\n${feedbackList(a.checks, a.items)}`, data: feedbackData(ticket, round, counted, a, true) });
      store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "block", body: reason, data_json: JSON.stringify({ reason, needs: "" }) });
      if (worker.standing === "active") return { kind: "blocking", worker: store.thread(worker.row.id)! };
      applyMove(ctx, store.ticket(ticket.id)!, { to: "blocked", patch: { ...released, blocked_reason: reason } }, LOOM_ACTOR, { reason });
      return { kind: "blocked" };
    }
    store.updateTicket(ticket.id, { pr_seen_json: JSON.stringify([...seenKeys]), pr_rounds: round, pr_ask_json: null, pr_text_json: null });
    const body = a.human ? `Your reply starts fix round ${round} on the pull request.` : `Pull request feedback for fix round ${round} (${counted} of ${max} the pull request may start):\n\n${feedbackList(a.checks, a.items)}`;
    post(ctx, ticket, { body, data: feedbackData(ticket, round, counted, a, false) });
    const move = { fixRound: round, ...(a.human ? { human: true } : {}) };
    if (worker.standing === "active" && worker.row.thread_id !== null) {
      const text = prFeedbackText({ key: ticket.key, url: ticket.pr_url, round, counted, max, checks: a.checks, items: a.items, diverged: a.diverged, signature: signatureOf(ctx) });
      store.updateTicket(ticket.id, { pr_deliver_json: JSON.stringify({ thread: worker.row.thread_id, text } satisfies PrDelivery) });
      toWorking(ctx, store.ticket(ticket.id)!, worker.row, move);
      return { kind: "working" };
    }
    applyMove(ctx, store.ticket(ticket.id)!, { to: "queued", patch: released }, LOOM_ACTOR, { ...move, reason: "the worker is gone" });
    return { kind: "queued" };
  });
  if (result === null) return false;
  store.changed(seen.project_id);
  ctx.kick();
  if (result.kind === "blocking") await resumeEnding(ctx, result.worker);
  else if (result.kind === "working") await deliver(ctx, store.ticket(seen.id)!);
  return true;
}

/** Sends a ticket's stored fix-round message; it stays stored, for the next tick, until bb takes it. */
async function deliver(ctx: EngineCtx, ticket: TicketRow): Promise<void> {
  const pending = parse<PrDelivery>(ticket.pr_deliver_json);
  if (pending === null) return;
  if (ticket.state !== "working" || ticket.worker_thread_id !== pending.thread) {
    ctx.store.updateTicket(ticket.id, { pr_deliver_json: null });
    return;
  }
  if (!delivers(ctx, ticket.project_id)) return;
  try {
    await ctx.bb.send(pending.thread, pending.text);
  } catch (error) {
    ctx.bb.log("warn", `Could not send ${ticket.key}'s fix round to ${pending.thread}; Loom tries again: ${errText(error)}`);
    return;
  }
  if (ctx.store.ticket(ticket.id)?.pr_deliver_json === ticket.pr_deliver_json) ctx.store.updateTicket(ticket.id, { pr_deliver_json: null });
}

/** The tick's retry of fix-round messages bb did not take, after a failed send or a restart. */
export async function deliverFixRounds(ctx: EngineCtx, project: ProjectRow): Promise<void> {
  for (const ticket of ctx.store.tickets(project.id)) if (ticket.pr_deliver_json !== null) await deliver(ctx, ticket);
}

function feedbackData(ticket: TicketRow, round: number, counted: number, a: Round, overLimit: boolean): object {
  return {
    outcome: "pr_feedback",
    round,
    counted: a.human ? null : counted,
    head: ticket.head_sha,
    overLimit,
    human: a.human,
    replyId: a.replyId ?? null,
    url: ticket.pr_url,
    diverged: a.diverged !== null,
    checks: a.checks.map((check) => ({ name: check.name, url: check.url })),
    items: a.items.map((item) => ({ kind: item.kind, author: item.author, body: item.body.slice(0, 2000), url: item.url, state: item.state, path: item.path, line: item.line })),
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

/** Whether a fix round's submit changed nothing: its commit is still the head the open feedback was sent for. */
export function unchangedFix(posts: readonly PostRow[], sha: string): boolean {
  const open = openFeedback(posts);
  return open !== null && (JSON.parse(open.data_json) as { head?: string | null }).head === sha;
}

/** When a closed pull request blocks its ticket, a requeue starts a new one: one commit on a new branch, with fresh rounds. */
export const closedPrReset = { pr_branch: null, pushed_sha: null, pushed_at: null, pr_ask_json: null, pr_text_json: null, pr_seen_json: "[]", pr_rounds: 0, pr_status_json: null, pr_deliver_json: null, pr_base: null } as const;
