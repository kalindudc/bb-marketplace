// The pr strategy's merge: open the ticket's pull request, or push a fix round, a restack or a refresh to the one open,
// retarget it to the branch it builds on now and ask its reviewers again.
import type { ProjectRow, TicketRow } from "./db/store";
import { Unavailable } from "./forge-waits";
import { followDraft } from "./drafts";
import { andList, clip, dependsOnLines, mergeSubject, prDivergedText, workerPrBody } from "./prompts";
import { appliedOf, applyPrText, openedText, prRollout, proposalOf, reviewersToAsk, templatePr, wantedText } from "./pull-requests";
import { inFixRound, prTextFor } from "./pr-text";
import type { HostOutput as HostOutputOf } from "./host-contract";
import { readMeta } from "./pr-meta";
import { gitNetwork, type RepoSettings } from "./repos";
import { refreshedMeta, refreshedText, type Refresh } from "./fresh";
import type { Spec } from "./spec";
import { prBaseOf, restackOf, restackWithBase, stacking } from "./stack";
import { TIP_WHAT } from "./tips";
import { readSub, writeSub } from "./sub-state";
import { workBaseOf } from "./transport";
import { type EngineCtx } from "./ctx";
import { checkoutIn, complete, endFinishedThreads, errText, openForge, sendBack, toPrOpen, type MergePost, unavailableOf } from "./merge-common";
import { TIP_TAKES, finishStep, restack, stepOf, takeAtPush } from "./pr-restack";
import { blockMergedElsewhere, closedPullRequest } from "./pr-closed";
import { afterOpen, afterPush } from "./pr-hooks";
import { fixRoundState } from "./pr-poll";

export async function openPullRequest(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow): Promise<void> {
  const { store } = ctx;
  const checkout = await checkoutIn(ctx, project, spec, ticket.repo);
  const { hostId, path: repo, settings } = checkout;
  const branch = ticket.pr_branch ?? ticket.branch;
  if (branch === null) throw new Unavailable(`${ticket.key} has no branch recorded, so a pull request cannot be opened. Requeue it.`);
  const { remote, base } = settings;
  const fix = inFixRound(ticket);
  // A ticket the queue took from pr_open only catches up with what it is stacked on or with its base, or opens a new pull
  // request for one Loom let go of; no worker wrote anything for it.
  const taken = fix ? catchUpOf(ctx, ticket) : null;
  const catchUp = taken !== null;
  const refresh = taken?.refresh ?? null;
  const text = prTextFor(spec, ticket) ?? { head: ticket.head_sha!, by: "loom" as const, title: null, body: null, commit: ticket.title };

  // While the worker fixed it, the human may have merged or closed the pull request, perhaps into the branch it is stacked on.
  if (fix && ticket.pr_url !== null && settings.forge.kind !== "none") {
    const state = await fixRoundState(ctx, checkout, ticket.pr_url);
    if (state.outcome === "unavailable") throw unavailableOf(state);
    store.updateTicket(ticket.id, writeSub("pr_meta_json", readMeta(ticket, { at: ctx.now(), ...state.meta, state: state.state })));
    if (state.state === "MERGED" && state.meta.base !== null && state.meta.base !== base) {
      await blockMergedElsewhere(ctx, ticket, settings, state.meta.base);
      return;
    }
    if (state.state === "MERGED") {
      const body = catchUp ? `The pull request merged before Loom brought it up to date, so ${ticket.key} is done.` : `The pull request merged before Loom pushed fix round ${ticket.pr_rounds}, so the fix stays on ${ticket.branch ?? branch}.`;
      complete(ctx, ticket.id, { kind: "merge", body, data: { outcome: "pr_merged", url: ticket.pr_url, unpushed: true } });
      await endFinishedThreads(ctx, project.id);
      return;
    }
    if (state.state === "CLOSED") {
      if (await closedPullRequest(ctx, project, store.ticket(ticket.id)!, state.meta.base)) await openPullRequest(ctx, project, spec, store.ticket(ticket.id)!);
      return;
    }
  }

  let current = ticket;
  let caughtUp: string | null = null;
  // What those merges took, by branch or remote ref, for the subject of the commit Loom pushes.
  const sources: string[] = [];
  // Whether a merge Loom made for this push ran the ticket's checks.
  let checked = false;
  // A merge an earlier run put in the worker's worktree is finished first, so nothing builds on the head it replaces.
  const step = stepOf(ticket);
  if (step !== null) {
    const finished = await finishStep(ctx, project, spec, ticket, step, checkout, text);
    if (finished === null) return;
    current = finished;
    caughtUp = step.what;
    sources.push(...(step.sources ?? []));
    checked = true;
  }
  // A refresh takes the base tip it was counted against through the restack a stacked ticket uses; a merge step finished above was its merge.
  const need = refresh !== null && step === null ? restackWithBase(store.tickets(project.id), current, refresh.tip) : stacking(spec) ? restackOf(store.tickets(project.id), current) : null;
  if (need !== null) {
    const result = await restack(ctx, project, spec, current, need, checkout, text);
    if (result === null) return;
    if (result !== "skipped") {
      current = result.ticket;
      caughtUp = caughtUp === null ? result.what : `${caughtUp} and ${result.what}`;
      sources.push(...result.sources);
      checked ||= result.checked;
    }
  }
  if (catchUp && caughtUp === null && current.pr_url !== null && !baseMoved(ctx, settings, current)) {
    toPrOpen(ctx, current.id, refresh === null ? {} : refreshedMeta(store.ticket(current.id)!), null, { url: current.pr_url, restack: true });
    return;
  }

  const build = async (head: TicketRow) => {
    const message = catchUp ? mergeSubject(sources.length > 0 ? sources : [`${remote}/${settings.base}`], branch) : text.commit;
    return ctx.host.call(hostId, "prCommit", { repo, remote, branch, base: await workBaseOf(ctx, project, spec, head, head.head_sha!), head: head.head_sha!, message, ...(head.pushed_sha === null ? {} : { pushed: head.pushed_sha }), ...gitNetwork(settings) });
  };
  let built = await build(current);
  // Someone else pushed to the branch: their commits are merged in first, again if the branch moves meanwhile.
  for (let taken = 0; built.outcome === "diverged" && taken < TIP_TAKES; taken += 1) {
    const took = await takeAtPush(ctx, project, spec, current, checkout, text);
    if (took === null) return;
    if (took.head_sha !== current.head_sha) {
      caughtUp = caughtUp === null ? TIP_WHAT : `${caughtUp} and ${TIP_WHAT}`;
      sources.push(`${remote}/${branch}`);
      checked = true;
    }
    current = took;
    built = await build(current);
  }
  if (built.outcome === "unavailable") throw unavailableOf(built);
  if (built.outcome === "diverged") {
    await sendBack(ctx, current.id, {
      post: { kind: "merge", body: `The pull request's branch ${branch} got commits Loom did not push while Loom merged the earlier ones (its tip is ${built.tip.slice(0, 12)}), so Loom pushed nothing.`, data: { outcome: "diverged", tip: built.tip, branch } },
      text: prDivergedText(current.key),
      countFailure: false,
      reason: "the pull request's branch has commits Loom did not push",
    });
    return;
  }
  const src = built.sha;
  const created = built.created;
  const pushedNow = created || src !== current.pushed_sha;
  // prCommit read the remote branch: when it is the commit an earlier run meant to push, that push landed and lost its answer.
  const intent = readSub(current, "push_json");
  const landed = !created && intent !== null && intent.branch === branch && intent.sha === src;
  if (pushedNow && !landed) {
    store.updateTicket(current.id, writeSub("push_json", { branch, sha: src, at: ctx.now() }));
    const pushed = await ctx.host.call(hostId, "push", { repo, remote, src, branch, ...gitNetwork(settings) });
    if (pushed.outcome === "unavailable") throw unavailableOf(pushed);
  }
  const at = ctx.now();
  const recorded: Partial<TicketRow> = { pr_branch: branch, pushed_sha: src, pushed_at: at, pr_checked_at: at, pr_status_json: null, push_json: null };
  const commits = ` as 1 commit (${src.slice(0, 12)})`;
  const prBase = stacking(spec) ? prBaseOf(store.tickets(project.id), current, base) : base;

  if (settings.forge.kind === "none" || (fix && current.pr_url !== null)) {
    const where = `${remote}/${branch}`;
    const target = current.pr_url ?? where;
    // The title and description the fix round sets once it is pushed, when they change.
    const want = fix ? wantedText(ctx, current, text) : null;
    const post: MergePost | null = !fix
      ? { kind: "merge", body: `Pushed ${branch} to ${remote}${commits}. Open its pull request there${prBase === base ? "" : ` on ${prBase}`}; Loom completes the ticket when ${remote}/${base} contains ${src.slice(0, 12)}.`, data: { outcome: "branch_pushed", pushed: where, sha: src, base: prBase } }
      : catchUp
        ? pushedNow
          ? refresh !== null
            ? { kind: "merge", body: refreshedText(current.key, refresh, `${remote}/${base}`, caughtUp ?? `${remote}/${base}`, src, checked), data: { outcome: "pr_pushed", url: current.pr_url, pushed: where, sha: src, restack: true, refresh } }
            : { kind: "merge", body: `Pushed ${current.key}'s branch, up to date with ${caughtUp ?? "its new base"}, to ${target}${commits}.`, data: { outcome: "pr_pushed", url: current.pr_url, pushed: where, sha: src, restack: true } }
          : null
        : pushedNow
          ? { kind: "merge", body: `Pushed fix round ${current.pr_rounds} to ${target}${commits}.`, data: { outcome: "pr_pushed", url: current.pr_url, pushed: where, sha: src, round: current.pr_rounds } }
          : want !== null
            ? { kind: "merge", body: `Fix round ${current.pr_rounds} changes only the pull request's text, so Loom pushed nothing to ${target}.`, data: { outcome: "pr_unchanged", url: current.pr_url, sha: src, round: current.pr_rounds, text: true } }
            : { kind: "merge", body: `Fix round ${current.pr_rounds} changed nothing the pull request does not already have, so Loom pushed nothing to ${target}.`, data: { outcome: "pr_unchanged", url: current.pr_url, sha: src, round: current.pr_rounds } };
    // The push's after_push runs as soon as Loom knows whether the pull request moves in this pass: once, after the move and
    // on the new base, when it moves, so CI starts once; else at once, on the base the pull request has, also when the move
    // waits or pauses, so no push loses its run. A move that succeeds on a later run then gets its own.
    const has = current.pr_base ?? base;
    const hook = (moved: boolean) =>
      current.pr_url === null ? Promise.resolve() : afterPush(ctx, { hostId, repo, settings, head: branch, base: moved ? prBase : has, sha: src, url: current.pr_url, projectId: project.id, ticketId: current.id, pushed: pushedNow, moved });
    let retargeted: Retargeted | null = null;
    if (current.pr_url !== null && prBase !== has) {
      try {
        retargeted = await retarget(ctx, { hostId, repo, settings, ticket: current, base: prBase });
      } catch (error) {
        await hook(false);
        throw error;
      }
    }
    const moved = retargeted?.moved === true;
    const asked = fix && !catchUp && pushedNow ? await askForReviews(ctx, { hostId, repo, settings, ticket: current }) : null;
    const data = settings.forge.kind === "none" ? { pushed: where } : catchUp ? { url: current.pr_url, restack: true } : { url: current.pr_url, fixRound: current.pr_rounds };
    const posts = [post, retargeted?.post ?? null, asked].filter((each): each is MergePost => each !== null);
    toPrOpen(ctx, current.id, { ...recorded, ...(moved ? { pr_base: prBase } : {}), ...(refresh === null ? {} : refreshedMeta(store.ticket(current.id)!)) }, posts, data);
    // Recorded in the same synchronous stretch as the move to pr_open, before any command runs.
    await hook(moved);
    if (want !== null) await applyPrText(ctx, spec, store.ticket(current.id)!, checkout, want);
    return;
  }

  const dependsOn = dependsOnLines(spec, store.tickets(project.id), current);
  const rollout = prRollout(ctx, spec, current);
  // loom_pr's title and body win over the ones the reviewers saw proposed; either missing leaves Loom's template. A
  // replacement for a closed stacked pull request falls back, field by field, on the text it kept (keptText).
  const proposal = proposalOf(current);
  const kept = fix ? appliedOf(current) : null;
  const title = text.title ?? proposal?.title ?? kept?.title ?? null;
  const body = text.body ?? proposal?.body ?? kept?.body ?? null;
  const template = templatePr(current, dependsOn, rollout);
  const own = kept !== null || (title !== null && body !== null);
  const pr = own ? { title: title ?? template.title, body: body === null ? template.body : workerPrBody(current.key, body, dependsOn, rollout) } : template;
  const opened = await ctx.host.call(hostId, "prCreate", { repo, remote, base: prBase, head: branch, title: clip(pr.title, 256), body: clip(pr.body, 60_000), draft: spec.merge.draft || current.keep_draft === 1, forge: openForge(settings.forge) });
  if (opened.outcome === "unavailable") throw unavailableOf(opened);
  const on = prBase === base ? "" : ` on ${prBase}`;
  const applied = openedText(ctx, spec, current, clip(pr.title, 256), own ? body : null);
  toPrOpen(ctx, current.id, { ...recorded, pr_url: opened.url, pr_base: prBase, pr_meta_json: null, ...writeSub("pr_applied_json", applied), pr_proposal_json: null }, { kind: "merge", body: `Opened pull request ${opened.url}${on}${commits}.`, data: { outcome: "pr_opened", url: opened.url, sha: src, base: prBase } }, { url: opened.url, opened: true });
  await afterOpen(ctx, { hostId, repo, settings, head: branch, base: prBase, url: opened.url, projectId: project.id, ticketId: current.id });
  // An after_open command may mark it ready itself, so with one, the first read that still finds a draft does it.
  if (spec.merge.draft && (settings.forge.after_open ?? []).length === 0) await followDraft(ctx, project, current.id, true, prBase);
}

/** Whether the queue took this ticket from pr_open to catch up, and the refresh it was due then: its move to merging says so. */
function catchUpOf(ctx: EngineCtx, ticket: TicketRow): { refresh: Refresh | null } | null {
  const last = ctx.store.ticketEvents(ticket.id, ["ticket.state"]).at(-1);
  const data = last === undefined ? null : (JSON.parse(last.data_json) as { to?: string; restack?: boolean; refresh?: Refresh });
  return data?.to === "merging" && data.restack === true ? { refresh: data.refresh ?? null } : null;
}

// A catch-up that merged nothing may still have to move the pull request to another base, when the dependency it built on merged.
function baseMoved(ctx: EngineCtx, settings: RepoSettings, ticket: TicketRow): boolean {
  if (ticket.pr_url === null) return false;
  return prBaseOf(ctx.store.tickets(ticket.project_id), ticket, settings.base) !== (ticket.pr_base ?? settings.base);
}

/** What a retarget did: its post, and whether the pull request moved; false when the post asks the human to move it. */
type Retargeted = { post: MergePost; moved: boolean };

/**
 * Moves an open pull request to the branch it now builds on: through gh, or a command forge's retarget command. A failure
 * worth waiting out throws, for the merge to run again. Any other failure of the retarget command asks the human to move
 * it, since the push already stands; gh's fails the merge step, which retry.ts settles as it does a failed opening. On a forge Loom cannot move
 * it through, the post asks the human to.
 */
async function retarget(ctx: EngineCtx, a: { hostId: string; repo: string; settings: RepoSettings; ticket: TicketRow; base: string }): Promise<Retargeted> {
  const url = a.ticket.pr_url!;
  const { forge } = a.settings;
  const command = forge.kind === "command" ? forge.retarget : undefined;
  if (forge.kind !== "gh" && command === undefined) {
    return { moved: false, post: { kind: "merge", body: `The pull request ${url} now builds on ${a.base}. Loom cannot change its base through this forge, so change it to ${a.base} by hand.`, data: { outcome: "retarget_by_hand", url, base: a.base } } };
  }
  const moved = await ctx.host.call(a.hostId, "prRetarget", { repo: a.repo, url, base: a.base, forge: command === undefined ? { kind: "gh" } : { kind: "command", retarget: command } });
  if (moved.outcome === "ok") return { moved: true, post: { kind: "merge", body: `Moved the pull request ${url} to ${a.base}.`, data: { outcome: "retargeted", url, base: a.base } } };
  if (command === undefined || moved.transient !== undefined) throw unavailableOf(moved, `Moving ${a.ticket.key}'s pull request to ${a.base} stopped: ${moved.message}`);
  return {
    moved: false,
    post: {
      kind: "merge",
      body: `The pull request ${url} now builds on ${a.base}, but the retarget command \`${command}\` did not move it: ${moved.message}\n\nChange its base to ${a.base} by hand.`,
      data: { outcome: "retarget_failed", url, base: a.base },
    },
  };
}

/**
 * After a fix round's push, asks the people whose reviews and review threads the round answered to review the pull
 * request again, and returns the post that says so. Only through gh. A failure is posted and blocks nothing: the fix is pushed.
 */
async function askForReviews(ctx: EngineCtx, a: { hostId: string; repo: string; settings: RepoSettings; ticket: TicketRow }): Promise<MergePost | null> {
  const url = a.ticket.pr_url;
  if (a.settings.forge.kind !== "gh" || url === null) return null;
  const reviewers = reviewersToAsk(ctx.store.posts(a.ticket.id)).slice(0, 20);
  if (reviewers.length === 0) return null;
  // A host from before this call refuses it; that is one more failure to post.
  const asked: HostOutputOf<"prRequestReview"> = await ctx.host
    .call(a.hostId, "prRequestReview", { repo: a.repo, url, reviewers })
    .catch((error: unknown) => ({ outcome: "unavailable" as const, message: errText(error) }));
  const requested = asked.outcome === "ok" ? asked.requested : [];
  const failed = asked.outcome === "ok" ? asked.failed : reviewers.map((login) => ({ login, message: asked.message }));
  const lines =
    asked.outcome === "ok"
      ? [...(requested.length > 0 ? [`Asked ${andList(requested)} to review the pull request again.`] : []), ...failed.map((miss) => `Loom could not ask ${miss.login} to review it again: ${miss.message}`)]
      : [`Loom could not ask ${andList(reviewers)} to review the pull request again: ${asked.message}`];
  const data = { outcome: requested.length > 0 ? "review_requested" : "review_request_failed", url, round: a.ticket.pr_rounds, requested, failed };
  return { kind: "merge", body: lines.join("\n\n"), data };
}
