// A pull request that closed without merging, or merged into a branch other than its base: Loom blocks its ticket, or lets
// go of a stacked one the forge closed when its parent merged so a new one opens.
import type { ProjectRow, TicketRow } from "./db/store";
import { targetText } from "./pull-requests";
import { repoSettings, type RepoSettings } from "./repos";
import { holdOf, prBaseOf, restackOf, stacking } from "./stack";
import { LOOM_ACTOR } from "./states";
import { type PrApplied, writeSub } from "./sub-state";
import { endThread } from "./workers";
import { specOf, type EngineCtx } from "./ctx";
import { tryMoveTicket } from "./moves";
import { addMergePost, checkoutIn, holdOpens, toPrOpen, unavailableOf, type MergePost } from "./merge-common";

/** A pull request closed without merging blocks its ticket and ends its threads; a requeue opens a new one. */
async function blockClosed(ctx: EngineCtx, ticket: TicketRow): Promise<void> {
  await blockPullRequest(ctx, ticket, "the pull request was closed without merging", null);
}

/** What Loom lets go of with a closed stacked pull request: the pull request, and what it read of it. The branch and the commit Loom pushed there stay, for the next one. */
const reopenReset = { pr_url: null, pr_base: null, pr_meta_json: null, pr_status_json: null, pr_seen_json: "[]", pr_ask_json: null, pr_poll_json: null, handback_json: null } as const;

/**
 * The PrApplied a replacement pull request opens with: the text the old one was to end up with (targetText), the approved
 * edit still waiting if there is one. The old pull request's edit and retry state, and its Rollout record, stay behind.
 */
function keptText(ctx: EngineCtx, ticket: TicketRow): PrApplied {
  const text = targetText(ctx, ticket);
  return { title: text.title, body: text.body, live: [], at: ctx.now() };
}

/**
 * A pull request read as closed, by a poll or before a push. One Loom opened on another ticket's branch, which the forge
 * closed because that branch went away, as when the pull request it was stacked on merged and its branch was deleted,
 * does not block: Loom lets go of it, posts why, and the ticket stays open with no pull request, for the merge queue to
 * bring its branch up to date and open a new one on the branch it builds on now (prBaseOf). True when Loom let go of it;
 * the ticket is then where it was, in pr_open or still merging. Any other closed pull request blocks the ticket, since a
 * person closed it. While a ticket that is not done still owns the gone branch, its own read settles first, and this
 * ticket waits in pr_open for its next read. A failed read of the remote throws, as a failed host step does.
 */
export async function closedPullRequest(ctx: EngineCtx, project: ProjectRow, ticket: TicketRow, target: string | null): Promise<boolean> {
  const { store } = ctx;
  const spec = specOf(store, project);
  const settings = repoSettings(spec, ticket.repo);
  const { remote, base } = settings;
  const branch = ticket.pr_base;
  if (!stacking(spec) || branch === null || branch === base || (target !== null && target !== branch)) {
    await blockClosed(ctx, ticket);
    return false;
  }
  const owner = store.tickets(project.id).find((other) => other.id !== ticket.id && other.repo === ticket.repo && other.pr_branch === branch) ?? null;
  if (owner?.state !== "done") {
    const checkout = await checkoutIn(ctx, project, spec, ticket.repo);
    const read = await ctx.host.call(checkout.hostId, "remoteBranch", { repo: checkout.path, remote, branch });
    if (read.outcome === "unavailable") throw unavailableOf(read, `Reading whether ${branch} is still on ${remote} stopped: ${read.message}`);
    if (read.sha !== null) {
      await blockClosed(ctx, ticket);
      return false;
    }
    if (owner !== null && owner.state !== "cancelled") {
      if (ticket.state === "merging") toPrOpen(ctx, ticket.id, {}, null, { url: ticket.pr_url, waits: owner.key });
      return false;
    }
  }
  const why = owner?.state === "done" ? `${owner.key}'s pull request, whose branch ${branch} it built on, merged` : `the branch it built on, ${branch}, left ${remote}`;
  store.tx(() => {
    const current = store.ticket(ticket.id)!;
    store.updateTicket(current.id, { ...reopenReset, ...writeSub("pr_applied_json", keptText(ctx, current)) });
    const after = store.ticket(current.id)!;
    const tickets = store.tickets(project.id);
    const hold = holdOf(tickets, after);
    const next = hold === null ? `Its new pull request opens on ${prBaseOf(tickets, after, base)}${restackOf(tickets, after) === null ? "" : ` once Loom has brought its branch up to date`}.` : holdOpens(spec, after, hold, "new ");
    addMergePost(ctx, current, {
      body: `The pull request ${ticket.pr_url} closed when ${why}. A person did not close it, so Loom let go of it instead of blocking ${current.key}, and keeps its branch. ${next}`,
      data: { outcome: "pr_let_go", url: ticket.pr_url, branch, ticket: owner?.key ?? null },
    });
  });
  store.changed(project.id);
  ctx.kick();
  return true;
}

/**
 * A pull request merged into a branch other than its repo's base, such as the branch of the pull request it was stacked
 * on, did not bring its change to the base. Its ticket blocks as a closed one does, and the reason names the branch and
 * the ticket whose pull request branch it is.
 */
export async function blockMergedElsewhere(ctx: EngineCtx, ticket: TicketRow, settings: RepoSettings, branch: string): Promise<void> {
  const { base } = settings;
  const owner = ctx.store.tickets(ticket.project_id).find((other) => other.id !== ticket.id && other.repo === ticket.repo && other.pr_branch === branch) ?? null;
  const into = owner === null ? `the branch ${branch}` : `${owner.key}'s branch (${branch})`;
  const next = owner !== null && owner.state !== "done" && owner.state !== "cancelled" ? `Merge ${owner.key}'s pull request first, then put this change on ${base} again.` : `Put this change on ${base} again.`;
  const reason = `Its pull request merged into ${into}, not ${base}, so its change is not on ${base}. ${next}`;
  const post: MergePost = {
    kind: "merge",
    body: `The pull request ${ticket.pr_url} merged into ${into}, not ${base}, so Loom did not complete ${ticket.key}.`,
    data: { outcome: "merged_elsewhere", url: ticket.pr_url, branch, base, ticket: owner?.key ?? null },
  };
  await blockPullRequest(ctx, ticket, reason, post);
}

// The move comes first, so nothing slips in before the threads end.
async function blockPullRequest(ctx: EngineCtx, ticket: TicketRow, reason: string, post: MergePost | null): Promise<void> {
  const { store } = ctx;
  store.tx(() => {
    const current = store.ticket(ticket.id)!;
    if (post !== null) store.addPost({ project_id: current.project_id, ticket_id: current.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: post.kind, body: post.body, data_json: JSON.stringify(post.data) });
    store.addPost({ project_id: current.project_id, ticket_id: current.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "block", body: reason, data_json: JSON.stringify({ reason, needs: "" }) });
    tryMoveTicket(store, current.id, { name: "block_pr_closed", set: { blocked_reason: reason } }, LOOM_ACTOR, { reason });
  });
  store.changed(ticket.project_id);
  for (const row of store.threads({ ticketId: ticket.id, states: ["active"] })) await endThread(ctx, row, "blocked", { commit: false, move: null });
}
