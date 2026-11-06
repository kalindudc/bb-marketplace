// What a host call may take: the deadline Loom's client gives it, and the part of that deadline its own git work needs.
import { GIT_INDEX_TIMEOUT_MS, GIT_NETWORK_TIMEOUT_MS } from "./git-network";
import { RETARGET_COMMAND_MS, type HostInput, type HostMethod } from "./host-contract";

export const HOST_CALL_MS = 30_000;
const NETWORK_CALL_MS = 150_000;
// prFeedback runs gh or a forge command for up to 2 minutes, so the 30-second default would cut a slow read short and pause the project.
// exportChanges reads every changed file of a large commit, ensureWorktree may check out a large repository, and
// prRetarget, prRequestReview, prEdit and prReply run gh or a forge command.
const NETWORK_METHODS: readonly HostMethod[] = ["prCreate", "prState", "prFeedback", "prBatch", "ensureWorktree", "ghStatus", "exportChanges", "prRetarget", "prRequestReview", "prEdit", "prReply"];
// The calls that list or write trees on the project's checkout (ls-tree, mktree, commit-tree, merge-tree), all of whose steps share the input's indexTimeoutMs, else GIT_INDEX_TIMEOUT_MS.
const GIT_INDEX_METHODS: readonly HostMethod[] = ["importCommit", "stackBase", "mergeOnto"];
/** bb's host call cap is 30 minutes; every call stays under it. */
const CALL_CAP_MS = 1_770_000;
// The calls that run git fetch, ls-remote or push, each step limited to the input's networkTimeoutMs (the repo's
// git_network_timeout_seconds, else GIT_NETWORK_TIMEOUT_MS). prCommit, fetchTip, importCommit, carryStart and landedOn may run
// two of them one after the other, so the call gets two steps' time plus HOST_CALL_MS for its local git.
const GIT_NETWORK_METHODS: readonly HostMethod[] = ["fetchBranch", "push", "prCommit", "stackBase", "fetchTip", "importCommit", "carryStart", "landedOn", "behindBase", "remoteBranch"];

export function callTimeoutMs<M extends HostMethod>(method: M, input: HostInput<M>): number {
  if (method === "exec") return (input as HostInput<"exec">).timeoutMs + HOST_CALL_MS;
  const index = GIT_INDEX_METHODS.includes(method) ? ((input as { indexTimeoutMs?: number }).indexTimeoutMs ?? GIT_INDEX_TIMEOUT_MS) : 0;
  const network = GIT_NETWORK_METHODS.includes(method) ? 2 * ((input as { networkTimeoutMs?: number }).networkTimeoutMs ?? GIT_NETWORK_TIMEOUT_MS) : 0;
  if (index > 0 || network > 0) return Math.min(CALL_CAP_MS, network + index + HOST_CALL_MS);
  if (method === "prRetarget" && (input as HostInput<"prRetarget">).forge?.kind === "command") return RETARGET_COMMAND_MS + HOST_CALL_MS;
  return NETWORK_METHODS.includes(method) ? NETWORK_CALL_MS : HOST_CALL_MS;
}

/**
 * What a call's own index and network steps may take together, before its HOST_CALL_MS of slack for local git: what a call on a
 * checkout needs left of its deadline when it starts. 0 for a call that has no such steps.
 */
export function callWorkMs<M extends HostMethod>(method: M, input: HostInput<M>): number {
  const timeout = callTimeoutMs(method, input);
  return GIT_INDEX_METHODS.includes(method) || GIT_NETWORK_METHODS.includes(method) ? Math.max(0, timeout - HOST_CALL_MS) : 0;
}
