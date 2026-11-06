// The human's and the planner's ways back for a blocked ticket: requeue it for a new worker from its branch, or send it
// back as it is, to review or to its open pull request, when Loom can tell its branch has nothing new.
import { repoCheckout, type RepoCheckout } from "./checkouts";
import { specOf, type EngineCtx } from "./ctx";
import type { PostRow, TicketRow } from "./db/store";
import { moveTicket } from "./moves";
import { LoomError } from "./projects";
import { applyPrText, approvedSinceSubmit, textPending, wantedText } from "./pull-requests";
import { prTextFor } from "./pr-text";
import { backToReview } from "./review";
import { stacking, restackOf, upstreamOf } from "./stack";
import type { AuthorKind } from "./states";
import { earlierWork, keptWorker, type EarlierWork } from "./workers";

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Blocked to queued, for the human or the planner. The next worker starts from the ticket's branch and reads the whole
 * thread. With `review`, the ticket goes back as it is instead, with no new worker (reviewAgain).
 */
export async function requeueTicket(ctx: EngineCtx, key: string, a: { note: string; actor: string; author: AuthorKind; threadId?: string; review?: boolean }): Promise<TicketRow> {
  const ticket = ctx.store.ticketByKey(key);
  if (ticket === null) throw new LoomError("loom_not_found", `No ticket ${key}.`, "Run `bb loom tickets <slug>` to see the ticket keys.");
  if (ticket.state !== "blocked") throw new LoomError("loom_invalid_state", `${key} is ${ticket.state}; only a blocked ticket can be requeued.`);
  if (a.review === true) return reviewAgain(ctx, ticket, a);
  const note = a.note.trim();
  ctx.store.tx(() => {
    // A ticket whose pull request stays open comes back as a fix round on it, asked for its own text again.
    const fix = ticket.pushed_sha !== null ? { pr_rounds: ticket.pr_rounds + 1 } : {};
    // A block that let go of the pull request leaves no commit pushed; what Loom last read of that pull request goes with it.
    const gone = ticket.pushed_sha === null ? { pr_meta_json: null } : {};
    moveTicket(ctx.store, ticket.id, { name: "requeue", set: { ...fix, ...gone } }, a.actor, { requeued: true, failures: 0 });
    if (note !== "") {
      ctx.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: a.author, author_thread_id: a.threadId ?? null, kind: "reply", body: note });
    }
  });
  ctx.store.changed(ticket.project_id);
  ctx.kick();
  return ctx.store.ticket(ticket.id)!;
}

/** What review again as is could do with a ticket, from what Loom stored; reviewAgain then checks its branch. */
export interface ReviewAgain {
  /** Back on its pull request: it has one that Loom pushed to. */
  pr: boolean;
  /** Back to review: the newest check post passed, at the ticket's head. */
  review: boolean;
}

export function reviewAgainOf(ticket: TicketRow, posts: readonly PostRow[]): ReviewAgain {
  if (ticket.state !== "blocked") return { pr: false, review: false };
  const check = [...posts].reverse().find((post) => post.kind === "check");
  const last = check === undefined ? null : (JSON.parse(check.data_json) as { passed?: boolean; head?: string });
  return { pr: ticket.pr_branch !== null && ticket.pushed_sha !== null, review: ticket.head_sha !== null && last?.passed === true && last.head === ticket.head_sha };
}

export const short = (sha: string) => sha.slice(0, 12);

/**
 * Review again as is. A ticket whose newest work has nothing its pull request lacks goes back to pr_open, as a fix with
 * no change does, unless the worker proposed a text the pull request lacks: one the reviewers approved is set on the way
 * back, with nothing pushed, and one they have not goes to review. One whose newest work is the commit whose checks
 * passed last goes back to review for it, in a new round. Blocking ended its worker and reviewers; on the pull request strategy the worker's thread comes back as the
 * ticket's released worker (keptWorker), and requested changes go to a new worker from the branch. A stacked ticket
 * whose worker cannot come back is refused while its branch may still have to catch up, as nothing could run it.
 * Anything else is refused too.
 */
export async function reviewAgain(ctx: EngineCtx, ticket: TicketRow, a: { note: string; actor: string; author: AuthorKind; threadId?: string }): Promise<TicketRow> {
  const { store } = ctx;
  const { key } = ticket;
  const can = reviewAgainOf(ticket, store.posts(ticket.id));
  const refuse = (why: string) => new LoomError("loom_invalid_state", `${why}, so it cannot go back as it is. A plain requeue starts a new worker from its branch instead.`, `Run \`bb loom requeue ${key}\` without --review, with a note for the next worker.`);
  if (!can.pr && !can.review) throw refuse(ticket.head_sha === null ? `${key} has no commit that passed its checks` : `The last checks on ${key} did not pass on the commit it was submitted at`);

  const project = store.project(ticket.project_id)!;
  const spec = specOf(store, project);
  let tip: EarlierWork | null;
  let pushedTree: string | null = null;
  let headTree: string | null = null;
  let checkout: RepoCheckout;
  try {
    tip = await earlierWork(ctx, project, spec, ticket);
    checkout = await repoCheckout(ctx, project, spec, ticket.repo);
    const treeOf = async (sha: string) => {
      const found = await ctx.host.call(checkout.hostId, "refTip", { repo: checkout.path, ref: sha });
      return found.outcome === "ok" ? found.tree : null;
    };
    if (tip !== null && can.pr) pushedTree = await treeOf(ticket.pushed_sha!);
    if (tip !== null && can.review) headTree = ticket.head_tree ?? (await treeOf(ticket.head_sha!));
  } catch (error) {
    if (error instanceof LoomError) throw error;
    throw new LoomError("loom_unavailable", `Loom could not read ${key}'s branch on the project's checkout: ${errText(error)}`);
  }
  if (tip === null) throw refuse(`Loom finds no branch of ${key} on the project's checkout`);
  const pending = can.pr && textPending(ctx, ticket);
  const approvedText = pending && approvedSinceSubmit(store, ticket.id);
  const unchanged = can.pr && tip.tree === pushedTree;
  const to = unchanged && (!pending || approvedText) ? "pr_open" : can.review && tip.tree === headTree ? "review" : null;
  if (to === null) {
    if (unchanged) throw refuse(`${key}'s proposed pull request text has not been reviewed, and it has no commit that passed its checks to review it with`);
    throw refuse(can.review ? `${key}'s branch has changes since ${short(ticket.head_sha!)}, the commit whose checks passed last` : `${key}'s branch has changes its pull request does not have, and they have not passed Loom's checks`);
  }
  const want = to === "pr_open" && approvedText ? wantedText(ctx, ticket, prTextFor(spec, ticket) ?? { head: ticket.head_sha!, by: "loom", title: null, body: null, commit: "" }) : null;

  const kept = spec.merge.strategy === "pr" ? keptWorker(store, ticket) : null;
  if (kept === "ending") throw new LoomError("loom_invalid_state", `${key}'s worker thread is still stopping; try again in a moment.`);
  const tickets = store.tickets(ticket.project_id);
  if (kept === null && stacking(spec) && (upstreamOf(tickets, ticket).open.length > 0 || restackOf(tickets, { ...ticket, state: to }) !== null)) {
    throw refuse(`${key} is stacked on a pull request it may still have to catch up with, and its worker's thread cannot come back to do it`);
  }

  const note = a.note.trim();
  const keep = kept === null ? {} : { worker_thread_id: kept.thread_id };
  store.tx(() => {
    const current = store.ticket(ticket.id)!;
    if (current.state !== "blocked" || current.head_sha !== ticket.head_sha || current.pushed_sha !== ticket.pushed_sha) throw new LoomError("loom_invalid_state", `${key} changed while Loom read its branch; try again.`);
    if (kept !== null) {
      const row = store.thread(kept.id)!;
      if (row.state !== "ended" || row.end_reason !== kept.end_reason) throw new LoomError("loom_invalid_state", `${key}'s worker thread changed while Loom read its branch; try again.`);
      store.updateThread(row.id, { end_reason: "released", released_at: row.released_at ?? ctx.now() });
    }
    if (to === "review") {
      const text = `Back in review as it is: new reviewers judge ${short(current.head_sha!)}, the commit whose checks passed last, in round ${current.review_round + 1}. A worker starts only if they ask for changes.`;
      backToReview(ctx, current, text, { actor: a.actor, reason: "sent back to review as it is", requeued: true, set: { ...keep, ...(current.pushed_sha === null ? { pr_meta_json: null } : {}) } });
    } else {
      // An old streak of failed reads would make the first new one block the ticket, so the next read starts afresh, at once.
      moveTicket(store, current.id, { name: "pr_again", set: keep }, a.actor, { requeued: true, failures: 0, reason: "sent back to its pull request as it is" });
      const back = kept === null ? "" : " When the pull request needs a fix, or its branch must catch up, Loom brings back the worker's thread, or starts a new worker from the branch when it cannot.";
      const text = want === null ? "" : " It sets the title and description the reviewers approved.";
      const body = `Back on its pull request as it is: ${key}'s branch has nothing ${current.pr_url ?? "the pull request"} lacks, so Loom pushed nothing and follows the pull request again.${text}${back}`;
      store.addPost({ project_id: current.project_id, ticket_id: current.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "merge", body, data_json: JSON.stringify({ outcome: "pr_unchanged", url: current.pr_url, sha: current.pushed_sha, round: current.pr_rounds, again: true }) });
    }
    if (note !== "") store.addPost({ project_id: current.project_id, ticket_id: current.id, parent_id: null, author_kind: a.author, author_thread_id: a.threadId ?? null, kind: "reply", body: note });
  });
  store.changed(ticket.project_id);
  if (want !== null) await applyPrText(ctx, spec, store.ticket(ticket.id)!, checkout, want);
  ctx.kick();
  return store.ticket(ticket.id)!;
}
