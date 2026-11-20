import { isDeepStrictEqual } from "node:util";
import { pullRequestHead, pullRequestVerified, type PullRequest } from "../shared/pull-request";
import type { ClosePullRequest, PullRequestChoices } from "../shared/closing";
import type { TavernRuntime } from "./runtime";
import { observePullRequest, refreshPullRequest } from "./pull-request-rules";
const binding = (pr: PullRequest | ClosePullRequest) => ({ id: pr.id, url: pr.url, head: pr.head, base: pr.base, state: pr.state, forge: pr.forge,
  headCommit: "headCommit" in pr ? pr.headCommit : pullRequestHead(pr), headVerified: "headVerified" in pr ? pr.headVerified : pullRequestVerified(pr) });

const refreshes = new WeakMap<TavernRuntime, Map<string, Promise<unknown>>>();
export async function refreshQuestPullRequests(runtime: TavernRuntime, questId: string) {
  let pending = refreshes.get(runtime);
  if (!pending) refreshes.set(runtime, pending = new Map());
  const active = pending;
  const unchecked = new Set<string>();
  await Promise.all(runtime.keeper.store.openPullRequests(questId).map(async pr => {
    let refresh = active.get(pr.id);
    if (!refresh) {
      refresh = refreshPullRequest(runtime, pr).finally(() => active.delete(pr.id));
      active.set(pr.id, refresh);
    }
    try { await refresh; }
    catch { unchecked.add(pr.id); }
  }));
  return unchecked;
}

export async function previewPullRequests(runtime: TavernRuntime, questId: string) {
  const k = runtime.keeper;
  const unchecked = await refreshQuestPullRequests(runtime, questId);
  return k.store.openPullRequests(questId).map((pr): ClosePullRequest => {
    const owner = k.member(pr.owner);
    const closeUnavailable = runtime.placements().forge.closeUnavailable(pr);
    return { ...binding(pr), state: pr.state as ClosePullRequest["state"], owner: pr.owner, ownerName: pr.owner === "user" ? "You" : owner ? k.name(owner) : pr.owner,
      ...(closeUnavailable ? { closeUnavailable } : {}), ...(unchecked.has(pr.id) ? { stateNote: "The forge state could not be refreshed; this is the last recorded state." } : {}) };
  });
}

export class StaleClosingCard extends Error {}

export function recordPullRequestChoices(runtime: TavernRuntime, questId: string, askId: string, preview: ClosePullRequest[], choices: PullRequestChoices) {
  const k = runtime.keeper;
  const prs = k.store.openPullRequests(questId);
  if (!isDeepStrictEqual(prs.map(binding), preview.map(binding))) throw new StaleClosingCard("The pull requests changed after this card was shown. The Keeper will need to propose closing again.");
  const byId = new Map(choices.map(choice => [choice.id, choice.action]));
  if (byId.size !== choices.length || choices.some(choice => !preview.some(pr => pr.id === choice.id))) throw new Error("Choose once for each pull request shown on this card.");
  const closeIds: string[] = [];
  const applied = prs.map(pr => {
    const action = byId.get(pr.id) ?? "keep";
    const { closeRequest, ...record } = pr;
    if (action === "close") {
      const unavailable = runtime.placements().forge.closeUnavailable(pr);
      if (unavailable) throw new Error(unavailable);
      closeIds.push(pr.id);
    }
    const owner = action === "you" ? "user" : pr.keeperThreadId;
    const next = { ...record, owner, ...(action === "close" ? { closeRequest: { askId } } : {}) };
    if (!isDeepStrictEqual(pr, next)) k.store.changePullRequest(next, k.now(), askId);
    return { id: pr.id, url: pr.url, action, owner };
  });
  return { closeIds, applied };
}

export async function closeAnsweredPullRequests(runtime: TavernRuntime, ids: string[], askId: string) {
  const k = runtime.keeper;
  const errors: string[] = [];
  for (const id of ids) {
    const pr = k.store.get("pullRequests", id);
    if (!pr || pr.closeRequest?.askId !== askId || pr.closeRequest.error) continue;
    try {
      const result = await runtime.placements().forge.close(pr);
      if (result.state !== "closed" && result.state !== "merged") throw new Error("The forge did not confirm that the pull request closed.");
      const current = k.store.get("pullRequests", id);
      if (!current || !isDeepStrictEqual(pr, current)) throw new Error("The pull request record changed during the forge call. Check it on the forge before taking another action.");
      const { closeRequest, ...record } = observePullRequest(current, result);
      k.store.changePullRequest(record, k.now(), askId);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      const current = k.store.get("pullRequests", id);
      if (current?.closeRequest?.askId === askId) k.store.changePullRequest({ ...current, closeRequest: { askId, error: message } }, k.now(), askId);
      errors.push(`Could not confirm closure of ${pr.url}. ${message}`);
    } finally { k.changed(pr.keeperThreadId, pr.boardQuestId); }
  }
  return errors;
}
