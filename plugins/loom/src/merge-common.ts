// What the merge queue's steps share: the merge posts, the moves that end a merge (done, back to the worker, to an open
// pull request), and the errors and checkouts every step uses.
import { workerOf, specOf, type EngineCtx } from "./ctx";
import { repoCheckout, type RepoCheckout } from "./checkouts";
import type { ProjectRow, TicketRow } from "./db/store";
import { plural } from "./format";
import { Unavailable, transientOf, type Transient } from "./forge-waits";
import { andList } from "./prompts";
import type { HostInput } from "./host-contract";
import { LoomError } from "./projects";
import { repoSettings, type RepoSettings } from "./repos";
import type { ForgeSpec, Spec } from "./spec";
import type { Hold } from "./stack";
import { LOOM_ACTOR } from "./states";
import { deliverHandBacks, handBack } from "./slots";
import { endLiveRows, endThread } from "./workers";
import { moveTicket, tryMoveTicket } from "./moves";

export const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** When a held pull request opens, in a sentence. */
export function holdOpens(spec: Spec, ticket: TicketRow, hold: Hold, fresh = ""): string {
  const keys = andList(hold.keys);
  if (hold.why === "merge") return `Its ${fresh}pull request opens once all but one of ${keys} have merged, because a pull request builds on one other branch.`;
  if (hold.why === "push") return `Its ${fresh}pull request opens once ${keys} has a pull request again.`;
  const { remote, base } = repoSettings(spec, ticket.repo);
  return `Its ${fresh}pull request opens on ${keys}'s branch once Loom has merged ${remote}/${base}, which has the dependencies that merged since, into that branch.`;
}

export function addMergePost(ctx: EngineCtx, ticket: TicketRow, post: { body: string; data: object }): void {
  ctx.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "merge", body: post.body, data_json: JSON.stringify(post.data) });
}

/** Ends the worker and reviewer threads of a ticket that is done, or blocked because its pull request closed. Replays what a crash after the ticket's move left undone. */
export async function endFinishedThreads(ctx: EngineCtx, projectId: number): Promise<void> {
  for (const row of ctx.store.threads({ projectId, states: ["active"] })) {
    if (row.role === "planner" || row.ticket_id === null) continue;
    const state = ctx.store.ticket(row.ticket_id)?.state;
    if (state === "done") await endThread(ctx, row, "merged", { commit: false, move: null });
    else if (state === "blocked") await endThread(ctx, row, "blocked", { commit: false, move: null });
  }
}

/** A host's unavailable answer as an Unavailable, keeping whether it is worth waiting out; `message` replaces its own. */
export const unavailableOf = (answer: { message: string } & Partial<Transient>, message = answer.message) => new Unavailable(message, transientOf(answer));

// A repo without a checkout pauses the project with repoCheckout's message, which gives the clone command.
export async function checkoutIn(ctx: EngineCtx, project: ProjectRow, spec: Spec, name: string | null): Promise<RepoCheckout> {
  try {
    return await repoCheckout(ctx, project, spec, name);
  } catch (error) {
    throw error instanceof LoomError ? new Unavailable(error.message) : error;
  }
}

export async function checkoutOf(ctx: EngineCtx, project: ProjectRow): Promise<{ hostId: string; repo: string }> {
  const repo = project.host_id === null ? null : await ctx.bb.projectCheckout(project.bb_project_id, project.host_id);
  if (project.host_id === null || repo === null) throw new Unavailable(`The bb project has no checkout on the machine ${project.host_id ?? "(unknown)"}; add the repository there and resume.`);
  return { hostId: project.host_id, repo };
}

// The integration branch as the human reads it: on a multi-repo project, with the repo it is in.
export const branchIn = (settings: RepoSettings) => (settings.name === null ? settings.branch! : `${settings.branch!} in the repo "${settings.name}"`);

// A message to the worker about its merge, which names the repo on a multi-repo project.
export function inRepo(text: { summary: string; detail: string }, settings: RepoSettings): { summary: string; detail: string } {
  return settings.name === null ? text : { ...text, detail: `${text.detail}\n\nThis was the integration branch of the repo "${settings.name}", which your worktree is a checkout of.` };
}

export type MergePost = { kind: "merge" | "check"; body: string; data: object };

/** merging to done, with the merge post, in one transaction. */
export function complete(ctx: EngineCtx, ticketId: number, post: MergePost): void {
  const { store } = ctx;
  store.tx(() => {
    const ticket = store.ticket(ticketId)!;
    moveTicket(store, ticketId, { name: "merged" }, LOOM_ACTOR, { ...post.data });
    store.addPost({ project_id: ticket.project_id, ticket_id: ticketId, parent_id: null, author_kind: "loom", author_thread_id: null, kind: post.kind, body: post.body, data_json: JSON.stringify(post.data) });
  });
  store.changed(store.ticket(ticketId)!.project_id);
  ctx.kick();
}

/**
 * A merge that did not land goes back to the ticket's worker (or the queue when the worker is gone), in one transaction, so
 * the ticket leaves `merging` before the merge guard is released. The worker gets it as a hand-back, once a worker slot is
 * free. A worker that is ending counts as gone: the only ways it can be ending here leave the ticket alone, because block
 * and cancel are refused while a ticket merges.
 */
export async function sendBack(ctx: EngineCtx, ticketId: number, a: { post: MergePost; text: { summary: string; detail: string }; countFailure: boolean; reason: string }): Promise<void> {
  const { store } = ctx;
  let failures = 0;
  const applied = store.tx(() => {
    const ticket = store.ticket(ticketId);
    if (ticket === null || ticket.state !== "merging") return false;
    store.addPost({ project_id: ticket.project_id, ticket_id: ticketId, parent_id: null, author_kind: "loom", author_thread_id: null, kind: a.post.kind, body: a.post.body, data_json: JSON.stringify(a.post.data) });
    if (a.countFailure) {
      failures = ticket.check_failures + 1;
      store.updateTicket(ticketId, { check_failures: failures });
    }
    const worker = workerOf(store, ticket);
    if (worker.standing === "active" && worker.row.thread_id !== null) handBack(ctx, store.ticket(ticketId)!, worker.row, worker.row.thread_id, a.text, { reason: a.reason });
    else tryMoveTicket(store, ticketId, { name: "worker_gone" }, LOOM_ACTOR, { reason: "the worker is gone" });
    return true;
  });
  if (!applied) return;
  store.changed(store.ticket(ticketId)!.project_id);

  const ticket = store.ticket(ticketId)!;
  const { max_check_failures: limit } = specOf(store, store.project(ticket.project_id)!).budget;
  if (a.countFailure && failures >= limit) {
    const reason = `checks failed ${plural(failures, "time")}`;
    store.tx(() => {
      store.updateTicket(ticketId, { blocked_reason: reason, handback_json: null });
      store.addPost({ project_id: ticket.project_id, ticket_id: ticketId, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "block", body: reason, data_json: JSON.stringify({ reason, needs: "" }) });
    });
    await endLiveRows(ctx, store.ticket(ticketId)!, "blocked");
    return;
  }
  await deliverHandBacks(ctx, ticket.project_id);
}

/** merging to pr_open, with what Loom pushed and its posts, in one transaction; a checked MergeStep is pushed now. */
export function toPrOpen(ctx: EngineCtx, ticketId: number, patch: Partial<TicketRow>, post: MergePost | null | MergePost[], data: object): void {
  const { store } = ctx;
  const posts = post === null ? [] : Array.isArray(post) ? post : [post];
  store.tx(() => {
    const ticket = store.ticket(ticketId)!;
    moveTicket(store, ticketId, { name: "pr_pushed", set: patch }, LOOM_ACTOR, data);
    for (const each of posts) store.addPost({ project_id: ticket.project_id, ticket_id: ticketId, parent_id: null, author_kind: "loom", author_thread_id: null, kind: each.kind, body: each.body, data_json: JSON.stringify(each.data) });
  });
  store.changed(store.ticket(ticketId)!.project_id);
}

export const openForge = (forge: ForgeSpec): HostInput<"prCreate">["forge"] => (forge.kind === "command" ? { kind: "command", open: forge.open! } : { kind: "gh" });
export function addWaitPost(ctx: EngineCtx, ticket: TicketRow, body: string, data: object): void {
  ctx.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "system", body, data_json: JSON.stringify(data) });
}

export const unavailable = (message: string) => new LoomError("loom_unavailable", message);
