// A dependency in another repo cannot be stacked on, so its dependents only hear about it: each new commit on its open
// pull request, and its merge, is posted on the dependent ticket, and the dependent's worker is told while it works.
import { delivers, workerOf } from "./checks";
import type { ProjectRow, TicketRow } from "./db/store";
import { upstreamChangedText } from "./prompts";
import { repoCheckout } from "./checkouts";
import type { Spec } from "./spec";
import { stacking, stackOf, type Stack } from "./stack";
import type { EngineCtx } from "./workers";

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function noteUpstreamChanges(ctx: EngineCtx, project: ProjectRow, spec: Spec): Promise<void> {
  if (!stacking(spec)) return;
  const { store } = ctx;
  const tickets = store.tickets(project.id);
  const byKey = new Map(tickets.map((ticket) => [ticket.key, ticket]));
  for (const ticket of tickets) {
    if (ticket.state === "done" || ticket.state === "cancelled") continue;
    const stack = stackOf(ticket);
    if (stack === null || Object.keys(stack.cross).length === 0) continue;
    const cross = { ...stack.cross };
    const changed: TicketRow[] = [];
    const merged: TicketRow[] = [];
    for (const [key, sha] of Object.entries(stack.cross)) {
      const dep = byKey.get(key);
      if (dep === undefined) continue;
      if (dep.state === "done") {
        delete cross[key];
        merged.push(dep);
      } else if (dep.pushed_sha !== null && dep.pushed_sha !== sha) {
        cross[key] = dep.pushed_sha;
        changed.push(dep);
      }
    }
    if (changed.length === 0 && merged.length === 0) continue;
    const post = (body: string, data: object) =>
      store.addPost({ project_id: project.id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "system", body, data_json: JSON.stringify(data) });
    store.tx(() => {
      store.updateTicket(ticket.id, { stack_json: JSON.stringify({ ...stack, cross } satisfies Stack) });
      for (const dep of changed) {
        post(`${dep.key}'s pull request ${dep.pr_url ?? `in the repo "${dep.repo}"`} has a new commit, ${dep.pushed_sha!.slice(0, 12)}. Check that ${ticket.key}'s work still fits it.`, { upstream: dep.key, sha: dep.pushed_sha });
      }
      for (const dep of merged) post(`${dep.key}'s pull request ${dep.pr_url ?? `in the repo "${dep.repo}"`} merged.`, { upstream: dep.key, merged: true });
    });
    store.changed(project.id);

    const worker = workerOf(store, ticket);
    // A worker coming back from a release reads these posts with its fix round.
    if (changed.length === 0 || ticket.state !== "working" || worker.standing !== "active" || worker.row.thread_id === null || worker.row.released_at !== null || !delivers(ctx, project.id)) continue;
    for (const dep of changed) {
      const path = await repoCheckout(ctx, project, spec, dep.repo).then(
        (checkout) => checkout.path,
        () => null,
      );
      await ctx.bb.send(worker.row.thread_id, upstreamChangedText(ticket.key, { key: dep.key, url: dep.pr_url, sha: dep.pushed_sha!, repo: dep.repo }, path)).catch((error) => ctx.bb.log("warn", `Could not message ${worker.row.thread_id}: ${errText(error)}`));
    }
  }
}
