// Commits someone else pushed to a ticket's pull request branch. Loom merges them into the ticket's work on the project's
// checkout itself, using the commit it last pushed there as the merge base, since a head rebuilt from another machine's
// worktree shares no history with the branch. A worker on another machine gets the result as linear commits, because
// a machine may keep no merge of a branch other than the base; a worker never has to fetch or merge the branch itself.
import { workerOf } from "./checks";
import { repoCheckout, type RepoCheckout } from "./checkouts";
import type { ProjectRow, TicketRow } from "./db/store";
import type { HostOutput } from "./host-contract";
import { isWaking } from "./release";
import { gitNetwork } from "./repos";
import { EMPTY_STACK, restackOf, stacking, stackOf, type Stack } from "./stack";
import { carryTo, headCameHome, homeBranch, isRemote, reviewedRef } from "./transport";
import { resolveEnvironment, specOf, type EngineCtx } from "./workers";

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The ref on the project's checkout that keeps the pull request branch's tip Loom merges, and that a worker on the checkout's machine can merge itself. */
export const tipRef = (slug: string, key: string) => `refs/loom/${slug}/${key.toLowerCase()}/tip`;

/** What a merge of the pull request branch's new commits says it is about, in posts and messages. */
export const TIP_WHAT = "the new commits on the pull request's branch";

export type Tip = Extract<HostOutput<"fetchTip">, { outcome: "ok" }>;

/** The pull request branch's tip, fetched onto tipRef; null when the branch is not there. Throws when the remote cannot be read. */
export async function readTip(ctx: EngineCtx, project: ProjectRow, checkout: RepoCheckout, ticket: TicketRow): Promise<Tip | null> {
  const branch = ticket.pr_branch ?? ticket.branch;
  if (branch === null) return null;
  const { remote, base } = checkout.settings;
  const read = await ctx.host.call(checkout.hostId, "fetchTip", { repo: checkout.path, remote, branch, base, ref: tipRef(project.slug, ticket.key), ...gitNetwork(checkout.settings) });
  if (read.outcome === "unavailable") throw new Error(read.message);
  return read.outcome === "missing" ? null : read;
}

/** Whether the tip has commits Loom neither pushed nor has in the ticket's head. */
export async function isForeign(ctx: EngineCtx, checkout: RepoCheckout, ticket: TicketRow, tip: Tip): Promise<boolean> {
  if (tip.sha === ticket.pushed_sha || ticket.head_sha === null) return false;
  const head = await ctx.host.call(checkout.hostId, "refTip", { repo: checkout.path, ref: ticket.head_sha, contains: tip.sha });
  return head.outcome !== "ok" || head.contains !== true;
}

/**
 * Whether the tip has base-branch commits that the commit the ticket is stacked on lacks, as after a forge's "update
 * branch" merged the base into it. The stack base must take the base branch first, or those commits would count as the
 * ticket's own changes.
 */
export async function tipOutgrowsStack(ctx: EngineCtx, checkout: RepoCheckout, ticket: TicketRow, tip: Tip): Promise<boolean> {
  const base = stackOf(ticket)?.base ?? null;
  if (base === null || tip.mainBase === null) return false;
  const stacked = await ctx.host.call(checkout.hostId, "refTip", { repo: checkout.path, ref: base, contains: tip.mainBase });
  return stacked.outcome !== "ok" || stacked.contains !== true;
}

/** The stack with the files a merge left conflict markers in, for the conflict check of the worker's next submit. */
export const withMarkers = (ticket: TicketRow, files: readonly string[]): Stack => ({ ...(stackOf(ticket) ?? EMPTY_STACK), markers: [...files] });

/**
 * How a fix round deals with commits someone else pushed to the pull request branch: the worker merges them itself, on
 * the checkout's machine (merge); Loom merged them into the work it keeps on the checkout and put the result in the
 * worker's worktree, or on the home branch its next worker resumes from (took); or Loom merges them when it pushes the
 * fix (later).
 */
export type ForeignTip = { kind: "merge"; remote: string; branch: string } | { kind: "took"; tip: string; sha: string } | { kind: "later" };

/**
 * At the start of a fix round whose pull request branch has commits Loom did not push: for a ticket whose head came home
 * from another machine, merges them into the head on the checkout and carries the result to the worker's worktree, so
 * the worker fixes on top of them. Then the branch's tip is the commit Loom accounts for (pushed_sha), so the next push
 * builds on it. A ticket whose work is on the checkout's machine leaves the merge to its worker. A merge that conflicts,
 * which only a branch rewritten over Loom's last push can cause, waits for the push, where the conflict goes back to the
 * worker with its markers. Null when the branch has nothing the head lacks after all.
 */
export async function takeForRound(ctx: EngineCtx, project: ProjectRow, seen: TicketRow): Promise<ForeignTip | null> {
  const { store } = ctx;
  const spec = specOf(store, project);
  let checkout: RepoCheckout;
  try {
    checkout = await repoCheckout(ctx, project, spec, seen.repo);
  } catch (error) {
    ctx.bb.log("warn", `Could not read ${seen.key}'s checkout before its fix round: ${errText(error)}`);
    return { kind: "later" };
  }
  const branch = seen.pr_branch ?? seen.branch ?? "";
  const ownMerge: ForeignTip = { kind: "merge", remote: checkout.settings.remote, branch };
  try {
    if (!(await headCameHome(ctx, project, spec, seen))) return ownMerge;
    if (stacking(spec) && restackOf(store.tickets(project.id), seen) !== null) return { kind: "later" };
    const tip = await readTip(ctx, project, checkout, seen);
    if (tip === null || !(await isForeign(ctx, checkout, seen, tip))) return null;
    if (await tipOutgrowsStack(ctx, checkout, seen, tip)) return { kind: "later" };
    const worker = workerOf(store, seen);
    if (worker.standing === "ending") return { kind: "later" };
    const merged = await ctx.host.call(checkout.hostId, "mergeOnto", {
      repo: checkout.path,
      head: seen.head_sha!,
      ref: tip.sha,
      ...(seen.pushed_sha === null ? {} : { base: seen.pushed_sha }),
      message: `Merge ${TIP_WHAT} into ${seen.key} (Loom)`,
      refs: [],
    });
    if (merged.outcome === "merged" && merged.already) return null;
    if (merged.outcome === "conflict") return { kind: "later" };
    let carried = false;
    if (worker.standing === "active" && !isWaking(worker.row)) {
      const environment = await resolveEnvironment(ctx, worker.row);
      if (environment?.path == null) return { kind: "later" };
      if (!isRemote(project, environment)) return ownMerge;
      await carryTo(ctx, project, spec, seen, merged.sha, environment, seen.head_tree === null ? {} : { replaces: seen.head_tree });
      carried = true;
    }
    const now = store.ticket(seen.id);
    if (now?.state !== "pr_open" || now.head_sha !== seen.head_sha || now.pushed_sha !== seen.pushed_sha) return { kind: "later" };
    await ctx.host.call(checkout.hostId, "pointRefs", { repo: checkout.path, sha: merged.sha, refs: [`refs/heads/${homeBranch(project.slug, seen.key)}`, reviewedRef(project.slug, seen.key)] });
    const where = carried ? ", and carried it to the worker's worktree" : ", where the ticket's next worker resumes from it";
    store.tx(() => {
      store.updateTicket(seen.id, { head_sha: merged.sha, head_tree: merged.tree, pushed_sha: tip.sha, pushed_at: ctx.now() });
      store.addPost({
        project_id: seen.project_id,
        ticket_id: seen.id,
        parent_id: null,
        author_kind: "loom",
        author_thread_id: null,
        kind: "merge",
        body: `The pull request's branch has commits Loom did not push (its tip is ${tip.sha.slice(0, 12)}). Loom merged them into ${seen.key}'s work as ${merged.sha.slice(0, 12)} on the project's machine${where}.`,
        data_json: JSON.stringify({ outcome: "tip_merged", tip: tip.sha, sha: merged.sha, carried }),
      });
    });
    store.changed(project.id);
    return { kind: "took", tip: tip.sha, sha: merged.sha };
  } catch (error) {
    ctx.bb.log("warn", `Could not merge the new commits on ${seen.key}'s pull request branch before its fix round; Loom merges them when it pushes the fix: ${errText(error)}`);
    return { kind: "later" };
  }
}
