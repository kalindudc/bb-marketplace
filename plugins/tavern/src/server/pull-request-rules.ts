import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { gitOidSchema } from "../shared/placement";
import { pullRequestDraftOperationSchema, pullRequestHead, pullRequestReviewerSchema, type PullRequest } from "../shared/pull-request";
import type { Decision } from "../shared/schema";
import { windowStopKinds } from "../shared/away";
import { normalizeRemote } from "../scope/remote";
import { checkedPullRequestCommand } from "../scope/pr-policy";
import { authorize, commitUserAct, type UserActReceipt } from "./authority";
import { homePullRequestRebaseMatches } from "./pr-rebase";
import { memberWorktree } from "./member-worktree";
import type { TavernRuntime } from "./runtime";

const id = z.string().min(1).max(120);
const reason = z.string().trim().min(1).max(500);
const body = z.string().trim().min(1).max(8000);
export const pullRequestActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ready"), pullRequestId: id, reason, reviewers: z.array(pullRequestReviewerSchema).max(10).default([]) }).strict(),
  z.object({ action: z.literal("close"), pullRequestId: id, reason }).strict(),
  z.object({ action: z.literal("comment"), pullRequestId: id, body }).strict(),
  z.object({ action: z.literal("draft"), boardQuestId: id.nullish(), operation: pullRequestDraftOperationSchema, url: z.url().regex(/^https?:\/\//).max(300), body, unsure: z.boolean().optional(), command: z.string().trim().min(1).max(12000).optional() }).strict(),
]);

type Observation = { state: PullRequest["state"]; headCommit?: string };
type Verdict = NonNullable<PullRequest["verdict"]>;

function journalVerdicts(runtime: TavernRuntime, pr: PullRequest): Verdict[] {
  if (!pr.boardQuestId) return [];
  const { keeper: k } = runtime;
  return k.journal.linkedEntries(pr.boardQuestId).flatMap(entry => {
    if (entry.threadId !== pr.memberThreadId || entry.status !== "verified" || entry.review?.actor.kind !== "agent") return [];
    const warden = k.member(entry.review.actor.threadId);
    if (warden?.classId !== "warden" || warden.threadId === pr.memberThreadId || warden.boardQuestId !== pr.boardQuestId ||
        warden.checkerMakerThreadId !== pr.memberThreadId || entry.link?.waypointId !== warden.checkerWaypointId) return [];
    return entry.review.evidence.filter(item => gitOidSchema.safeParse(item.ref).success).map(({ ref }) =>
      ({ entryId: entry.id, wardenThreadId: warden.threadId, at: entry.review!.at, commit: ref }));
  });
}

export function observePullRequest(pr: PullRequest, live: Observation): PullRequest {
  const next = { ...pr, state: live.state,
    ...(live.headCommit && live.headCommit !== pullRequestHead(pr) ? { pushedHead: live.headCommit, verifiedCommit: null } : {}) };
  if (live.state !== "ready") delete next.readyDecisionId;
  return next;
}

function currentVerdict(runtime: TavernRuntime, pr: PullRequest, head: string) {
  const candidates = journalVerdicts(runtime, pr);
  return candidates.find(v => v.commit === head) ??
    (pr.verifiedCommit === head ? candidates.find(v => isDeepStrictEqual(v, pr.verdict)) : undefined);
}

async function rebasedVerdict(runtime: TavernRuntime, pr: PullRequest, head: string) {
  const candidates = journalVerdicts(runtime, pr);
  const verdict = candidates.find(v => isDeepStrictEqual(v, pr.verdict)) ??
    candidates.find(v => v.commit === pr.memberHead) ?? candidates.sort((a, b) => b.at - a.at)[0];
  if (!verdict) return;
  try {
    const maker = await memberWorktree(runtime.bb, pr.memberThreadId);
    if (!maker) return;
    const project = await runtime.bb.sdk.projects.get({ projectId: pr.projectId });
    const url = new URL(pr.url), repo = url.pathname.match(/^\/([\w.-]+\/[\w.-]+)\/pull\/[1-9][0-9]*\/?$/)?.[1];
    if (!project.gitRemoteUrl || !repo || normalizeRemote(`${url.origin}/${repo}`).toLowerCase() !== normalizeRemote(project.gitRemoteUrl).toLowerCase()) return;
    const home = { remoteUrl: project.gitRemoteUrl, base: pr.base, dataDir: join(dirname(runtime.keeper.store.db.name), "pr-proofs") };
    if (await homePullRequestRebaseMatches(maker.root, home, verdict.commit, head) && journalVerdicts(runtime, pr).some(v => isDeepStrictEqual(v, verdict))) return verdict;
  } catch (error) {
    runtime.bb.log.warn(`Tavern could not check the pull request rebase for ${pr.id}: ${String(error)}`);
  }
}

export async function refreshPullRequest(runtime: TavernRuntime, pr: PullRequest, duringAction = false) {
  if (!duringAction && pendingByRuntime.get(runtime)?.has(pr.id)) throw new Error("A forge action is in progress for this pull request.");
  const k = runtime.keeper, live = await runtime.placements().forge.inspect(pr);
  let next = live ? observePullRequest(pr, live) : pr;
  if (live?.headCommit && (next.state === "draft" || next.state === "ready")) {
    const verdict = live.headCommit === pullRequestHead(pr) ? currentVerdict(runtime, pr, live.headCommit) : undefined;
    next = { ...next, verifiedCommit: verdict ? live.headCommit : null };
    if (verdict) next.verdict = verdict;
    else delete next.verdict;
  }
  return k.store.atomic(() => {
    const current = k.store.get("pullRequests", pr.id);
    if ((!duringAction && pendingByRuntime.get(runtime)?.has(pr.id)) || !isDeepStrictEqual(current, pr))
      throw new Error("The pull request record changed while reading the forge; read it again.");
    if (!isDeepStrictEqual(next, pr)) k.store.changePullRequest(next, k.now());
    return { pr: next, observedHead: live?.headCommit };
  });
}

const pendingByRuntime = new WeakMap<TavernRuntime, Set<string>>();
async function withPullRequest<T>(runtime: TavernRuntime, id: string, action: () => Promise<T>) {
  let pending = pendingByRuntime.get(runtime);
  if (!pending) pendingByRuntime.set(runtime, pending = new Set());
  if (pending.has(id)) throw new Error("A forge action is already in progress for this pull request.");
  pending.add(id);
  try { return await action(); }
  finally { pending.delete(id); }
}

function ownedPullRequest(runtime: TavernRuntime, threadId: string, id: string) {
  const k = runtime.keeper;
  k.require(threadId, "keeper");
  const pr = k.store.get("pullRequests", id);
  if (!pr?.boardQuestId || pr.keeperThreadId !== threadId || pr.owner === "user" || (pr.owner !== threadId && pr.owner !== pr.memberThreadId))
    throw new Error("A Keeper can act only on a quest-owned pull request.");
  k.owned(threadId, pr.boardQuestId);
  return pr;
}

export async function managePullRequest(runtime: TavernRuntime, threadId: string, input: z.output<typeof pullRequestActionSchema>) {
  const k = runtime.keeper;
  k.require(threadId, "keeper");
  if (input.action === "draft") {
    const verb = { comment: "Comment on", review: "Review", approve: "Approve", close: "Close", edit: "Edit" }[input.operation];
    const lane = k.authority.lane({ kind: "sends-as-you", boardQuestId: input.boardQuestId ?? null, unsure: input.unsure });
    const digest = lane === "keeper" ? checkedPullRequestCommand(input.command ?? "", input.url, input.operation) : null;
    if (digest && !runtime.scopes?.refreshPullRequestPolicy(threadId)) throw new Error("Tavern needs a bound scope before it can grant one use of this command.");
    const ask = k.ask(threadId, { boardQuestId: input.boardQuestId, kind: "sends-as-you", unsure: input.unsure,
      effect: { type: "pull-request-draft", operation: input.operation }, draft: { to: input.url, body: input.body },
      question: `${verb} this pull request?`, why: "This pull request is not known to belong to the quest.",
      meanwhile: "Tavern does not post or change the pull request for you.", holds: [],
      options: [{ id: "approve", label: "Use this draft", detail: "Record your choice. Post or apply the draft yourself on the forge.", recommended: true },
        { id: "deny", label: "Leave it alone", detail: "Do not post or change anything.", recommended: false }],
    });
    if (digest) {
      const decision = k.decide(threadId, { boardQuestId: ask.boardQuestId, askId: ask.id, optionId: "approve", kind: "sends-as-you",
        text: `${verb} ${input.url}`, why: "The sends-as-you lane is the Keeper’s for this quest.", source: "keeper", reversible: true }, undefined,
        { pullRequestGrant: { digest } });
      if (!runtime.scopes!.refreshPullRequestPolicy(threadId)) throw new Error("The decision was recorded, but the scope is no longer bound. No command was run.");
      return { decisionId: decision.id, command: input.command, use: "Run this exact command once. Undo revokes an unused exception; it does not remove a post." };
    }
    return `Write on its own line:\n::tavern-ask{id="${ask.id}"}`;
  }
  return withPullRequest(runtime, input.pullRequestId, async () => {
    const requireOwner = () => {
      const pr = ownedPullRequest(runtime, threadId, input.pullRequestId), questId = pr.boardQuestId!;
      k.guard(threadId, questId);
      k.assertQuestNotHeld(questId);
      runtime.away.assertWork(questId, threadId);
      const window = runtime.away.store.snapshot().window;
      if (window?.returnedAt === null && windowStopKinds(window).includes("other-writes")) throw new Error("This pull request action waits for your return from Closing time.");
      if (input.action === "ready") k.liveQuest(threadId, questId);
      return pr;
    };
    const original = requireOwner();
    const refreshed = await refreshPullRequest(runtime, original, true);
    let { pr } = refreshed;
    const { observedHead } = refreshed;
    if (!isDeepStrictEqual(pr, requireOwner())) throw new Error("The pull request changed; read it again.");
    if (pr.state !== "ready" && pr.state !== "draft") throw new Error("This pull request is no longer open.");
    if (input.action === "ready") {
      if (!observedHead) throw new Error("This forge cannot confirm the pull request head. Mark it ready yourself on the forge.");
      const verdict = currentVerdict(runtime, pr, observedHead) ?? await rebasedVerdict(runtime, pr, observedHead);
      if (!verdict || !journalVerdicts(runtime, pr).some(v => isDeepStrictEqual(v, verdict))) throw new Error("A Warden must verify the exact head before this pull request can be ready.");
      if (!isDeepStrictEqual(pr, requireOwner())) throw new Error("The pull request record changed while checking the verdict.");
      if (pr.verifiedCommit !== observedHead || !isDeepStrictEqual(pr.verdict, verdict))
        pr = k.store.changePullRequest({ ...pr, verifiedCommit: observedHead, verdict }, k.now());
    }
    if (input.action === "ready" && pr.state === "ready" && !input.reviewers.length) return pr;
    const id = k.store.id("pr-act"), actor = { kind: "agent" as const, threadId };
    const change = { action: input.action, reason: input.action === "comment" ? "Reply on the quest’s pull request" : input.reason, receipt: id, actor };
    authorize(input.action === "ready" ? "readyPullRequest" : input.action === "close" ? "closePullRequest" : "replyPullRequest", { level: "keeper", receipt: id });
    k.store.event(k.now(), threadId, pr.boardQuestId, "pull-request.requested", change.reason, { ...change, pullRequestId: pr.id, head: pullRequestHead(pr) }, actor);
    const forge = runtime.placements().forge;
    try {
      const result = input.action === "close" ? await forge.close(pr) : input.action === "comment" ? await forge.comment(pr, input.body)
        : pr.state === "ready" ? { state: "ready" as const, headCommit: observedHead } : await forge.setReviewState(pr, "ready", []);
      if (input.action === "ready" && (result.state !== "ready" || result.headCommit !== observedHead)) throw new Error("The forge did not confirm readiness on the verified head.");
      if (input.action === "close" && result.state !== "closed" && result.state !== "merged") throw new Error("The forge did not confirm closure.");
      const next = k.store.atomic(() => {
        if (!isDeepStrictEqual(k.store.get("pullRequests", pr.id), pr)) throw new Error("The pull request record changed during the action. Check the forge before retrying.");
        const next = observePullRequest(pr, result);
        if (input.action === "ready" && !pr.readyDecisionId) {
          const decision = k.decide(threadId, { boardQuestId: pr.boardQuestId, text: `Made this pull request ready: ${pr.url}`.slice(0, 400),
            why: input.reason, source: "keeper", reversible: true }, undefined, { pullRequestReady: pr.id });
          next.readyDecisionId = decision.id;
        }
        return k.store.changePullRequest(next, k.now(), undefined, change);
      });
      if (input.action === "ready" && input.reviewers.length) {
        if (!isDeepStrictEqual(next, requireOwner()) || !journalVerdicts(runtime, next).some(v => isDeepStrictEqual(v, next.verdict)))
          throw new Error("The Warden verdict or pull request changed before requesting reviewers.");
        const reviewed = await forge.setReviewState(next, "ready", input.reviewers);
        if (reviewed.state !== "ready" || reviewed.headCommit !== observedHead) throw new Error("The forge did not confirm the reviewer request on the verified head.");
        k.store.event(k.now(), threadId, pr.boardQuestId, "pull-request.reviewers-requested", "Reviewers were requested on the verified head.",
          { receipt: id, pullRequestId: pr.id, head: observedHead, reviewers: input.reviewers, decisionId: next.readyDecisionId }, actor);
      }
      return next;
    } catch (error) {
      k.store.event(k.now(), threadId, pr.boardQuestId, "pull-request.unconfirmed", "The forge action was not confirmed. Check the forge before retrying.", { receipt: id, pullRequestId: pr.id }, actor);
      throw error;
    } finally { k.changed(threadId, pr.boardQuestId); }
  });
}

export async function undoPullRequestReady(runtime: TavernRuntime, decision: Decision, receipt: UserActReceipt | undefined) {
  if (decision.undone) return;
  if (receipt?.act !== "undoDecision") throw new Error("Returning a pull request to draft requires your explicit Undo.");
  authorize("undoDecision", { level: "user-explicit", receipt: receipt.surface });
  const k = runtime.keeper;
  await withPullRequest(runtime, decision.pullRequestReady!, async () => {
    const original = ownedPullRequest(runtime, decision.keeperThreadId, decision.pullRequestReady!);
    if (original.readyDecisionId !== decision.id) throw new Error("This pull request no longer has that ready decision.");
    const { pr, observedHead } = await refreshPullRequest(runtime, original, true);
    if (pr.state !== "ready" || !observedHead) throw new Error("The forge could not confirm an open, ready pull request.");
    const result = await runtime.placements().forge.setReviewState(pr, "draft", []);
    if (result.state !== "draft" || result.headCommit !== observedHead) throw new Error("The forge did not confirm the return to draft.");
    commitUserAct(k.store, k.now, receipt, () => {
      if (!isDeepStrictEqual(k.store.get("pullRequests", pr.id), pr)) throw new Error("The pull request record changed. Check the forge before retrying.");
      k.store.changePullRequest(observePullRequest(pr, result), k.now(), undefined, { actor: { kind: "user" }, action: "draft", reason: "You undid ready for review", receipt: decision.id });
      k.undoDecision(decision.id);
    });
  });
}
