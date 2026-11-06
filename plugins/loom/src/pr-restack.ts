// Bringing a pull request's branch up to date: restack it on its dependencies' new commits or its base, carry the
// merge to a worker on another machine, take commits someone else pushed to it, and run the checks on the result.
import { type CheckRun } from "./checks";
import { workerOf, type EngineCtx } from "./ctx";
import type { RepoCheckout } from "./checkouts";
import type { ProjectRow, ThreadRow, TicketRow } from "./db/store";
import { plural } from "./format";
import { Unavailable, waitableOf } from "./forge-waits";
import { andList, branchName, mergeSubject, restackConflictText, restackFailedText, restackMarkersText, restackRefusedText, unfinishedMergeText, withRestoredNote } from "./prompts";
import type { HostOutput as HostOutputOf } from "./host-contract";
import type { EnvironmentInfo } from "./ports";
import { freshBaseOf, gitNetwork, type RepoSettings } from "./repos";
import type { Spec } from "./spec";
import { EMPTY_STACK, restackWithBase, stackBranch, stackOf, stacking, type Restack } from "./stack";
import { TIP_WHAT, isForeign, readTip, tipOutgrowsStack, tipRef, type Tip, withMarkers } from "./tips";
import { LOOM_ACTOR } from "./states";
import { readSub, type MergeStep, type PrText, type Stack, writeSub } from "./sub-state";
import { restoredSinceSubmit } from "./release";
import { carryTo, homeBranch, isRemote, reviewedRef } from "./transport";
import { baseOf, resolveEnvironment } from "./workers";
import { tryMoveTicket } from "./moves";
import { errText, sendBack, unavailableOf } from "./merge-common";
import { afterMergePost } from "./merge-integration";
import { loomPost } from "./posts";

/** A restack that brought the branch up to date: the ticket as it is now, what it took, and whether it merged something and ran the checks on it, false when the head had it all already. */
/** `sources`: what the merge took, by branch or remote ref, for a commit subject. */
type Restacked = { ticket: TicketRow; what: string; sources: string[]; checked: boolean };

/**
 * Brings a stacked ticket's branch up to date before Loom pushes it: builds the commit it must take, merges that into the
 * ticket's head on the project's checkout, keeps the merge as a MergeStep, and only then puts it in the worker's worktree
 * and runs the ticket's checks on it, with no new review, so a merge whose answer got lost is finished on the next run. A
 * worker on another machine gets the merge as linear commits (restackOnMachine). Returns the ticket as it is now and what
 * it took; "skipped" when its dependencies conflict with each other, so it is pushed as it is; null when the ticket went
 * back to its worker, or to the queue when the worker is gone.
 */
export async function restack(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, need: Restack, checkout: RepoCheckout, text: PrText): Promise<Restacked | "skipped" | null> {
  const { store } = ctx;
  const { hostId, path: repo, settings } = checkout;
  const takesBase = need.withBase || need.baseTip !== undefined;
  const what = andList([...Object.keys(need.deps).map((key) => `${key}'s pull request`), ...(takesBase ? [`${settings.remote}/${settings.base}`] : [])]);
  const sources = [...Object.keys(need.deps).map((key) => { const dep = store.ticketByKey(key); return dep === null ? key : branchName(dep); }), ...(takesBase ? [`${settings.remote}/${settings.base}`] : [])];
  const worker = workerOf(store, ticket);
  if (worker.standing !== "active") {
    await sendBack(ctx, ticket.id, { post: { kind: "merge", body: `${ticket.key} must take ${what} before Loom pushes it, and its worker is gone, so a new worker takes it.`, data: { outcome: "restack_waits" } }, text: { summary: "", detail: "" }, countFailure: false, reason: "the worker is gone" });
    return null;
  }
  const environment = await resolveEnvironment(ctx, worker.row);
  if (environment?.path == null) return worktreeGone(ctx, ticket, worker.row, what);
  const branch = stackBranch(project.slug, ticket.key);
  const built = await ctx.host.call(hostId, "stackBase", {
    repo,
    branch,
    commits: need.baseTip === undefined ? need.commits : [...need.commits, need.baseTip],
    ...(need.withBase && need.baseTip === undefined ? { base: { remote: settings.remote, branch: settings.base } } : {}),
    message: mergeSubject(sources, branch),
    ...gitNetwork(settings),
  });
  if (built.outcome === "unavailable") throw unavailableOf(built);
  const known = stackOf(ticket) ?? EMPTY_STACK;
  if (built.outcome === "conflict") {
    store.tx(() => {
      store.updateTicket(ticket.id, writeSub("stack_json", { ...known, conflict: { on: need.deps, files: built.files } }));
      loomPost(ctx.store, ticket, { kind: "merge", body: `Loom cannot bring ${ticket.key} up to date: ${what} conflict with each other in ${built.files.join(", ")}. It stays as it is until one of them changes.`, data: { outcome: "restack_conflict", files: built.files } });
    });
    store.changed(project.id);
    return "skipped";
  }
  const { conflict: _gone, ...rest } = known;
  const stack: Stack = { ...rest, deps: need.deps, base: built.sha, synced: takesBase ? ctx.now() : known.synced };
  if (isRemote(project, environment)) return restackOnMachine(ctx, { project, spec, ticket, what, sources, checkout, text, environment: { ...environment, path: environment.path }, built: built.sha, stack });

  const merged = await ctx.host.call(hostId, "mergeOnto", { repo, head: ticket.head_sha!, ref: built.sha, message: mergeSubject(sources, branchName(ticket)), refs: [] });
  if (merged.outcome === "conflict") {
    await sendBack(ctx, ticket.id, {
      post: { kind: "merge", body: `Merging ${what} into ${ticket.key}'s branch conflicted in: ${merged.files.join(", ")}.`, data: { outcome: "conflict", files: merged.files, restack: true } },
      text: withRestoredNote(restackConflictText(ticket.key, what, branch, merged.files), restoredSinceSubmit(store.posts(ticket.id))),
      countFailure: false,
      reason: "bringing the branch up to date conflicted",
    });
    return null;
  }
  if (merged.already) {
    store.updateTicket(ticket.id, writeSub("stack_json", stack));
    return { ticket: store.ticket(ticket.id)!, what, sources, checked: false };
  }
  const step: MergeStep = { kind: "restack", from: ticket.head_sha!, sha: merged.sha, tree: null, remote: false, what, sources, checkBase: built.sha, stack, refs: [], data: { deps: need.deps, base: built.tip ?? need.baseTip ?? null } };
  const finished = await startStep(ctx, project, spec, ticket, step, checkout, text);
  return finished === null ? null : { ticket: finished, what, sources, checked: true };
}

/**
 * restack for a worker on another machine, where a merge commit must never go: merges on the project's checkout with
 * merge-tree, carries the result into the worker's worktree as linear commits, replacing the reviewed work there, which
 * the checkout keeps, and runs the checks there, as a MergeStep. A conflict is carried in with its markers and goes back
 * to the worker; so does a worktree that holds other work than the reviewed one, which Loom leaves alone.
 */
async function restackOnMachine(
  ctx: EngineCtx,
  a: { project: ProjectRow; spec: Spec; ticket: TicketRow; what: string; sources: string[]; checkout: RepoCheckout; text: PrText; environment: EnvironmentInfo & { path: string }; built: string; stack: Stack },
): Promise<Restacked | null> {
  const { store } = ctx;
  const { project, spec, ticket, what, environment, stack } = a;
  const refs = [`refs/heads/${homeBranch(project.slug, ticket.key)}`, reviewedRef(project.slug, ticket.key)];
  const merged = await ctx.host.call(a.checkout.hostId, "mergeOnto", { repo: a.checkout.path, head: ticket.head_sha!, ref: a.built, message: mergeSubject(a.sources, branchName(ticket)), refs });
  if (merged.outcome === "merged" && merged.already) {
    store.updateTicket(ticket.id, writeSub("stack_json", stack));
    return { ticket: store.ticket(ticket.id)!, what, sources: a.sources, checked: false };
  }
  if (merged.outcome === "conflict") {
    const carried: Stack = { ...stack, markers: merged.files };
    if (!(await carryOrRefuse(ctx, project, spec, { ...ticket, ...writeSub("stack_json", carried) }, merged.sha, environment, what))) return null;
    store.updateTicket(ticket.id, writeSub("stack_json", carried));
    await sendBack(ctx, ticket.id, {
      post: { kind: "merge", body: `Merging ${what} into ${ticket.key}'s branch conflicted in: ${merged.files.join(", ")}. Loom put the result, with conflict markers, in the worker's worktree.`, data: { outcome: "conflict", files: merged.files, restack: true } },
      text: restackMarkersText(ticket.key, what, merged.files),
      countFailure: false,
      reason: "bringing the branch up to date conflicted",
    });
    return null;
  }
  const step: MergeStep = { kind: "restack", from: ticket.head_sha!, sha: merged.sha, tree: merged.tree, remote: true, what, sources: a.sources, checkBase: freshBaseOf(spec, ticket.repo), stack, refs: [], data: { deps: stack.deps, base: a.built } };
  const finished = await startStep(ctx, project, spec, ticket, step, a.checkout, a.text);
  return finished === null ? null : { ticket: finished, what, sources: a.sources, checked: true };
}

/**
 * Carries a merge into the worktree of a worker on another machine, as the head it replaces there. A worktree that holds
 * other work, or a merge of the worker's own that is not finished, goes back to the worker untouched, and false is
 * returned; a failure worth waiting out throws, for the merge to run again.
 */
async function carryOrRefuse(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, sha: string, environment: EnvironmentInfo & { path: string }, what: string): Promise<boolean> {
  try {
    await carryTo(ctx, project, spec, ticket, sha, environment, { ...(ticket.worker_thread_id === null ? {} : { owner: ticket.worker_thread_id }), ...(ticket.head_tree === null ? {} : { replaces: ticket.head_tree }) });
    return true;
  } catch (error) {
    if (waitableOf(error) !== null) throw error;
    ctx.store.updateTicket(ticket.id, { merge_step_json: null });
    await sendBack(ctx, ticket.id, {
      post: { kind: "merge", body: `${ticket.key} must take ${what} before Loom pushes it, and Loom could not put it in the worker's worktree: ${errText(error)}`, data: { outcome: "restack_waits" } },
      text: restackRefusedText(ticket.key, what, errText(error)),
      countFailure: false,
      reason: "the worker's worktree holds work Loom has not seen",
    });
    return false;
  }
}

export function stepOf(ticket: TicketRow): MergeStep | null {
  const step = readSub(ticket, "merge_step_json");
  return step !== null && step.from === ticket.head_sha ? step : null;
}

async function startStep(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, step: MergeStep, checkout: RepoCheckout, text: PrText): Promise<TicketRow | null> {
  ctx.store.updateTicket(ticket.id, writeSub("merge_step_json", step));
  return finishStep(ctx, project, spec, ctx.store.ticket(ticket.id)!, step, checkout, text);
}

/**
 * Puts a step's merge in the worker's worktree, when it is not there yet, points its refs at it and runs the ticket's
 * checks on it, with no new review. Their passing makes it the ticket's head, and for a tip makes the tip the commit Loom
 * accounts for; a failed check, or a worktree that holds other work or a merge of the worker's own that is not finished,
 * ends the step and goes back to the worker. A failure worth waiting out throws and keeps the step. Returns the ticket as
 * it is now; null when it went back to its worker, or to the queue when the worker is gone.
 */
export async function finishStep(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, step: MergeStep, checkout: RepoCheckout, text: PrText): Promise<TicketRow | null> {
  const { store } = ctx;
  if (step.checked === true) return store.ticket(ticket.id)!;
  const { what } = step;
  const worker = workerOf(store, ticket);
  const back = async (a: Parameters<typeof sendBack>[2], patch: Partial<TicketRow> = {}) => {
    store.updateTicket(ticket.id, { merge_step_json: null, ...patch });
    await sendBack(ctx, ticket.id, a);
    return null;
  };
  if (worker.standing !== "active") {
    return back({ post: { kind: "merge", body: `${ticket.key} must take ${what} before Loom pushes it, and its worker is gone, so a new worker takes it.`, data: { outcome: "restack_waits" } }, text: { summary: "", detail: "" }, countFailure: false, reason: "the worker is gone" });
  }
  const found = await resolveEnvironment(ctx, worker.row);
  if (found?.path == null) return worktreeGone(ctx, ticket, worker.row, what);
  const environment = { ...found, path: found.path };

  if (step.remote) {
    const carried = step.stack === undefined ? ticket : { ...ticket, ...writeSub("stack_json", step.stack) };
    if (!(await carryOrRefuse(ctx, project, spec, carried, step.sha, environment, what))) return null;
  } else {
    const state = await ctx.host.call(environment.hostId, "worktreeState", { worktree: environment.path, base: step.checkBase });
    if (state.unfinishedMerge === true) {
      return back({
        post: { kind: "merge", body: `${ticket.key} must take ${what} before Loom pushes it, and the worker's worktree has a merge the worker has not finished, so Loom left it as it is.`, data: { outcome: "unfinished" } },
        text: unfinishedMergeText(ticket.key, what),
        countFailure: false,
        reason: "the worker's worktree has a merge it has not finished",
      });
    }
    // The worktree has the merge already, or still the head it was made from; anything else is work Loom has not seen.
    const placed = state.head === step.sha && !state.dirty;
    if (!placed && (state.head !== step.from || state.dirty)) {
      const why = state.dirty ? "it has uncommitted changes" : `its HEAD is ${state.head.slice(0, 12)}, not the approved ${step.from.slice(0, 12)}`;
      return back({ post: { kind: "merge", body: `${ticket.key} must take ${what} before Loom pushes it, and Loom left the worker's worktree as it is: ${why}.`, data: { outcome: "restack_waits" } }, text: restackRefusedText(ticket.key, what, why), countFailure: false, reason: "the worker's worktree holds work Loom has not seen" });
    }
    if (!placed) await ctx.host.call(environment.hostId, "resetHard", { worktree: environment.path, sha: step.sha });
  }
  if (step.refs.length > 0) await ctx.host.call(checkout.hostId, "pointRefs", { repo: checkout.path, sha: step.sha, refs: step.refs });

  const { runs, failure } = await checksOnMerge(ctx, { spec, ticket, settings: checkout.settings, environment, base: step.checkBase, expect: step.remote ? { tree: step.tree! } : { head: step.sha } });
  // The worktree of a worker on another machine builds on the tip now, so the next merge of the branch uses it as its base.
  const accounted = step.tip !== undefined && step.remote ? { pushed_sha: step.tip, pushed_at: ctx.now() } : {};
  const stacked = step.stack === undefined ? {} : writeSub("stack_json", step.stack);
  if (failure !== null) {
    // A worktree bb restored since the worker last ran has none of the files git ignores, so its first failed check counts no failure.
    const restored = !step.remote && restoredSinceSubmit(store.posts(ticket.id));
    const reason = step.kind === "tip" ? "the checks failed after merging the pull request branch's new commits" : "the checks failed after bringing the branch up to date";
    return back({ post: afterMergePost(failure.run, `${ticket.key}'s branch`, failure.changed), text: withRestoredNote(restackFailedText(ticket.key, what, failure.run, failure.changed), restored), countFailure: !restored, reason }, { ...accounted, ...stacked });
  }
  const passed = runs.length === 0 ? "" : `; its checks passed (${plural(runs.length, "command")})`;
  const where = step.remote ? " on the project's machine, and carried it to the worker's" : "";
  const took = step.tip === undefined ? what : `${what} (${step.tip.slice(0, 12)})`;
  store.tx(() => {
    store.updateTicket(ticket.id, {
      head_sha: step.sha,
      head_tree: step.remote ? step.tree : null,
      ...writeSub("merge_step_json", { ...step, from: step.sha, checked: true }),
      ...accounted,
      ...stacked,
      ...(text.by === "worker" ? writeSub("pr_text_json", { ...text, head: step.sha }) : {}),
    });
    loomPost(ctx.store, ticket, { kind: "merge", body: `Merged ${took} into ${ticket.key}'s branch as ${step.sha.slice(0, 12)}${where}${passed}.`, data: { outcome: "restacked", sha: step.sha, ...step.data, runs: runs.map(({ command, exitCode, timedOut, durationMs }) => ({ command, exitCode, timedOut, durationMs })) } });
  });
  store.changed(project.id);
  return store.ticket(ticket.id)!;
}

/**
 * A merge step needs the worker's worktree, and bb shows none for a worker whose thread is still active, as when its
 * sandbox expired. Loom never pauses the project for this and never leaves the ticket in merging, where it would hold the
 * whole queue: the ticket goes back to where the queue took it from (approved, or pr_open for a catch-up), and the worker
 * comes back the way a released one does (advanceWake): bb restores its environment when it can, after which the queue
 * takes the ticket again, and when it cannot, the worker's thread ends (cannotWake) and the next merge hands the ticket to
 * a new worker from its branch. Returns null, as a step that sent the ticket back does.
 */
async function worktreeGone(ctx: EngineCtx, ticket: TicketRow, row: ThreadRow, what: string): Promise<null> {
  const { store } = ctx;
  const into = store.ticketEvents(ticket.id, ["ticket.state"]).filter((event) => (JSON.parse(event.data_json) as { to?: string }).to === "merging").at(-1);
  const from = (into === undefined ? null : (JSON.parse(into.data_json) as { from?: string }).from) === "pr_open" ? "pr_open" : "approved";
  store.tx(() => {
    const current = store.ticket(ticket.id);
    const worker = store.thread(row.id);
    if (current?.state !== "merging" || worker?.state !== "active" || current.worker_thread_id !== worker.thread_id) return;
    tryMoveTicket(store, current.id, { name: from === "pr_open" ? "restack_left" : "merge_left" }, LOOM_ACTOR, { reason: "the worker's worktree is gone" });
    // Waking: still active, with no environment, which advanceWakes restores or gives up on.
    store.updateThread(worker.id, { released_at: ctx.now(), environment_id: null, clock_at: ctx.now(), idle_count: 0 });
    loomPost(ctx.store, current, {
      kind: "merge",
      body: `${current.key} must take ${what} before Loom pushes it, and bb shows no worktree for its worker any more, as when its environment expired. It leaves the merge queue meanwhile, so the other tickets merge: Loom brings the worker's environment back when bb can restore it, and otherwise a new worker takes ${current.key} from its branch.`,
      data: { outcome: "worktree_gone", back: from },
    });
  });
  store.changed(ticket.project_id);
  ctx.kick();
  return null;
}

/** How often one push merges the pull request branch's new commits before it gives up, when the branch keeps moving meanwhile. */
export const TIP_TAKES = 3;

/**
 * Merges the commits someone else pushed to a ticket's pull request branch into its head before Loom pushes, with the
 * commit Loom last pushed there as the merge base, and runs the ticket's checks on the result in the worker's worktree,
 * with no new review, as a restack does, as a MergeStep. On the checkout's machine the worktree's branch moves to the merge; a worker on
 * another machine gets it as linear commits, and the checkout keeps the merge. A stacked ticket whose branch got base
 * branch commits that the commit it is stacked on lacks takes the base branch first. Returns the ticket as it is now;
 * null when it went back to its worker, or to the queue when the worker is gone.
 */
export async function takeAtPush(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, checkout: RepoCheckout, text: PrText): Promise<TicketRow | null> {
  const { store } = ctx;
  const { hostId, path: repo, settings } = checkout;
  const what = TIP_WHAT;
  const worker = workerOf(store, ticket);
  if (worker.standing !== "active") {
    await sendBack(ctx, ticket.id, { post: { kind: "merge", body: `${ticket.key} must take ${what} before Loom pushes it, and its worker is gone, so a new worker takes it.`, data: { outcome: "restack_waits" } }, text: { summary: "", detail: "" }, countFailure: false, reason: "the worker is gone" });
    return null;
  }
  const found = await resolveEnvironment(ctx, worker.row);
  if (found?.path == null) return worktreeGone(ctx, ticket, worker.row, what);
  const environment = { ...found, path: found.path };
  let tip: Tip | null;
  try {
    tip = await readTip(ctx, project, checkout, ticket);
  } catch (error) {
    throw new Unavailable(`Reading ${ticket.key}'s pull request branch stopped: ${errText(error)}`, waitableOf(error));
  }
  if (tip === null) throw new Unavailable(`${ticket.key}'s pull request branch is gone from ${settings.remote}, so Loom cannot push to it. Requeue the ticket for a new pull request, or cancel it.`);

  let current = ticket;
  if (stacking(spec) && (await tipOutgrowsStack(ctx, checkout, current, tip))) {
    const result = await restack(ctx, project, spec, current, restackWithBase(store.tickets(project.id), current), checkout, text);
    if (result === null) return null;
    if (result !== "skipped") current = result.ticket;
  }
  if (!(await isForeign(ctx, checkout, current, tip))) return current;

  const mergeTip = (ours: boolean) =>
    ctx.host.call(hostId, "mergeOnto", {
      repo,
      head: current.head_sha!,
      ref: tip.sha,
      // The merge base is the commit Loom accounts for: its last push, or the newest foreign tip the head already has.
      ...(current.pushed_sha === null ? {} : { base: current.pushed_sha }),
      ...(ours ? { ours: true } : {}),
      message: mergeSubject([`${settings.remote}/${branchName(current)}`], branchName(current)),
      refs: [],
    });
  const merged = await mergeTip(await onlyBaseMergedIn(ctx, checkout, current, tip));
  if (merged.outcome === "merged" && merged.already) return current;
  const remote = isRemote(project, environment);
  const home = `refs/heads/${homeBranch(project.slug, current.key)}`;
  // A clean merge needs no worker when it leaves the head's tree, or when the pull request's CI checks it: Loom pushes it
  // from the project's machine and never replays it into a worker's worktree on another machine, whose git may not take it.
  if (merged.outcome === "merged" && remote && (merged.tree === current.head_tree || settings.ci)) return mergedHome(ctx, project, checkout, current, worker.row, tip.sha, merged);

  if (merged.outcome === "conflict" && !remote) {
    await sendBack(ctx, current.id, {
      post: { kind: "merge", body: `Merging ${what} into ${current.key}'s branch conflicted in: ${merged.files.join(", ")}.`, data: { outcome: "conflict", files: merged.files, tip: tip.sha } },
      text: withRestoredNote(restackConflictText(current.key, what, tipRef(project.slug, current.key), merged.files), restoredSinceSubmit(store.posts(current.id))),
      countFailure: false,
      reason: "merging the pull request branch's new commits conflicted",
    });
    return null;
  }
  if (merged.outcome === "conflict") {
    const carried = { ...current, ...writeSub("stack_json", withMarkers(current, merged.files)) };
    if (!(await carryOrRefuse(ctx, project, spec, carried, merged.sha, environment, what))) return null;
    await ctx.host.call(hostId, "pointRefs", { repo, sha: merged.sha, refs: [home] });
    // The worktree builds on the tip now, so the next merge of the branch uses it as its base. Recorded only here, with the
    // markers, once nothing can fail before the ticket goes back to the worker.
    store.updateTicket(current.id, { pushed_sha: tip.sha, pushed_at: ctx.now(), stack_json: carried.stack_json });
    await sendBack(ctx, current.id, {
      post: { kind: "merge", body: `Merging ${what} into ${current.key}'s branch conflicted in: ${merged.files.join(", ")}. Loom put the result, with conflict markers, in the worker's worktree.`, data: { outcome: "conflict", files: merged.files, tip: tip.sha } },
      text: restackMarkersText(current.key, what, merged.files),
      countFailure: false,
      reason: "merging the pull request branch's new commits conflicted",
    });
    return null;
  }
  const step: MergeStep = {
    kind: "tip",
    from: current.head_sha!,
    sha: merged.sha,
    tree: remote ? merged.tree : null,
    remote,
    what,
    sources: [`${settings.remote}/${branchName(current)}`],
    checkBase: remote ? freshBaseOf(spec, current.repo) : baseOf(spec, current),
    tip: tip.sha,
    refs: remote ? [home, reviewedRef(project.slug, current.key)] : [],
    data: { tip: tip.sha },
  };
  return startStep(ctx, project, spec, current, step, checkout, text);
}

/**
 * Whether the tip is proven to be exactly Loom's last push with the base branch merged in, as a forge's "update branch"
 * makes, and the head already has that base: then the tip adds nothing the head lacks, and the merge keeps the head's
 * tree. Proven only when the head does not have the last push itself (a squash Loom built, not a foreign tip the head
 * took, whose newer changes a later tip may revert), it builds on the tip's base, and merging that base into the last
 * push on the project's checkout gives the tip's tree. Anything else, such as a person's commit on top, is merged from
 * the last push as before.
 */
async function onlyBaseMergedIn(ctx: EngineCtx, checkout: RepoCheckout, ticket: TicketRow, tip: Tip): Promise<boolean> {
  const { hostId, path: repo, settings } = checkout;
  const pushed = ticket.pushed_sha;
  if (tip.mainBase === null || pushed === null || ticket.head_sha === null || tip.mainBase === pushed) return false;
  const contains = async (ref: string, sha: string) => {
    const read = await ctx.host.call(hostId, "refTip", { repo, ref, contains: sha });
    return read.outcome === "ok" && read.contains === true;
  };
  if (await contains(ticket.head_sha, pushed)) return false;
  if (!(await contains(ticket.head_sha, tip.mainBase))) return false;
  const update = await ctx.host.call(hostId, "mergeOnto", { repo, head: pushed, ref: tip.mainBase, message: `Merge ${tip.mainBase.slice(0, 12)} into ${pushed.slice(0, 12)}`, refs: [] });
  return update.outcome === "merged" && update.tree === tip.tree;
}

/**
 * A clean merge of a foreign tip, for a worker on another machine, made the ticket's head on the project's machine and
 * pushed from there: the home and reviewed refs point at it, and the tip is the commit Loom accounts for. The worker's
 * worktree is left as it is; when the merge changed the tree, its thread gets a resume, so loom_resume carries the
 * merge in before its next submit, as work brought home is carried.
 */
async function mergedHome(ctx: EngineCtx, project: ProjectRow, checkout: RepoCheckout, ticket: TicketRow, worker: ThreadRow, tip: string, merged: Extract<HostOutputOf<"mergeOnto">, { outcome: "merged" }>): Promise<TicketRow> {
  const { store } = ctx;
  await ctx.host.call(checkout.hostId, "pointRefs", { repo: checkout.path, sha: merged.sha, refs: [`refs/heads/${homeBranch(project.slug, ticket.key)}`, reviewedRef(project.slug, ticket.key)] });
  const sameTree = merged.tree === ticket.head_tree;
  store.tx(() => {
    store.updateTicket(ticket.id, { head_sha: merged.sha, head_tree: merged.tree, pushed_sha: tip, pushed_at: ctx.now() });
    if (!sameTree) store.updateThread(worker.id, writeSub("resume_json", { sha: merged.sha, tree: merged.tree, ...(ticket.head_tree === null ? {} : { replaces: ticket.head_tree }) }));
    loomPost(ctx.store, ticket, {
      kind: "merge",
      body: sameTree
        ? `Merged ${TIP_WHAT} (tip ${tip.slice(0, 12)}) into ${ticket.key} as ${merged.sha.slice(0, 12)} on the project's machine. They add nothing the approved work lacks, so the tree is unchanged, and Loom pushes it from there without touching the worker's worktree.`
        : `Merged ${TIP_WHAT} (tip ${tip.slice(0, 12)}) into ${ticket.key} as ${merged.sha.slice(0, 12)} on the project's machine, cleanly, and Loom pushes it from there for the pull request's CI to check. The worker's worktree is left as it is; loom_resume puts the merge in it before the worker's next submit.`,
      data: { outcome: "tip_merged_home", tip, sha: merged.sha, sameTree },
    });
  });
  store.changed(project.id);
  return store.ticket(ticket.id)!;
}

/**
 * Runs the ticket's checks in its worker's worktree on a merge Loom put there, with no new review, and returns the first
 * that failed, or passed but changed the worktree; null when all passed. The worktree must still have the merge: HEAD's
 * id on the checkout's machine, its tree on another, which may give a carried commit a new id.
 */
async function checksOnMerge(
  ctx: EngineCtx,
  a: { spec: Spec; ticket: TicketRow; settings: RepoSettings; environment: EnvironmentInfo & { path: string }; base: string; expect: { head: string } | { tree: string } },
): Promise<{ runs: CheckRun[]; failure: { run: CheckRun; changed?: string } | null }> {
  const { environment } = a;
  const commands = [...(JSON.parse(a.ticket.verify_json) as string[]), ...a.settings.checks];
  const runs: CheckRun[] = [];
  for (const command of commands) {
    const result = await ctx.host.call(environment.hostId, "exec", { cwd: environment.path, command, timeoutMs: a.spec.checks.timeout_minutes * 60_000 });
    const run: CheckRun = { command, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, output: result.output };
    runs.push(run);
    if (result.exitCode !== 0 || result.timedOut) return { runs, failure: { run } };
    const after = await ctx.host.call(environment.hostId, "worktreeState", { worktree: environment.path, base: a.base, trackedOnly: true });
    const moved =
      "head" in a.expect
        ? after.head === a.expect.head
          ? []
          : [`moved HEAD from ${a.expect.head.slice(0, 12)} to ${after.head.slice(0, 12)}`]
        : after.tree === a.expect.tree
          ? []
          : [`changed HEAD's tree from ${a.expect.tree.slice(0, 12)} to ${after.tree.slice(0, 12)}`];
    const changes = [...moved, ...(after.dirty ? ["left tracked files modified"] : [])];
    if (changes.length > 0) return { runs, failure: { run, changed: changes.join(" and ") } };
  }
  return { runs, failure: null };
}
