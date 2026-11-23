import { askSchema, type Ask } from "../shared/schema";
import { actTargetDigest, claimObservedMerge, issueActGrant, revokeActGrant } from "../scope/act-grants";
import type { Keeper } from "./keeper/service";

export const MERGE_APPROVAL_MS = 10 * 60_000;
export const mergeIdentity = (ask: Pick<Ask, "target">) => {
  const target = ask.target?.merge;
  return target && JSON.stringify([target.repository, target.sourceBranch, target.pullRequest, target.targetBranch]);
};

function* mergeApprovals(k: Keeper, threadId: string, now: number) {
  const rows = k.store.db.prepare(`SELECT data FROM tavern_records WHERE kind='asks'
    AND json_extract(data,'$.keeperThreadId')=? AND json_extract(data,'$.kind')='merge' AND json_type(data,'$.target.merge')='object'
    AND (json_extract(data,'$.mergeApproval.expiresAt') > ? OR json_extract(data,'$.createdAt') > ?)
    ORDER BY rowid DESC`).all(threadId, now, now - MERGE_APPROVAL_MS) as { data: string }[];
  const newest = new Set<string>();
  for (const { data } of rows) {
    const ask = askSchema.parse(JSON.parse(data));
    const key = mergeIdentity(ask)!;
    const superseded = newest.has(key);
    newest.add(key);
    if (!ask.mergeApproval || ask.mergeUse) continue;
    const { expiresAt, delegationId } = ask.mergeApproval;
    const quest = ask.boardQuestId && k.store.get("quests", ask.boardQuestId);
    let current = !superseded && ask.state === "answered" && ask.answer?.optionId === "approve" && ask.answer.at <= now && expiresAt > k.now() &&
      (!ask.boardQuestId || !!quest && quest.keeperThreadId === threadId && !quest.archivedAt && !quest.deletedAt && !["done", "held", "stopping", "stopped"].includes(quest.phase));
    let staleVerdict = false;
    if (current && ask.answer?.by === "keeper") {
      const lane = k.authority.keeperDecisionSource(ask);
      current = !ask.unsure && k.authority.lane(ask) === "keeper" && (delegationId ? lane.delegation?.id === delegationId : lane.keeperAuthority === "keepers.alwaysAsk");
      if (current) {
        try { k.authority.assertVerdict(ask); }
        catch { current = false; staleVerdict = true; }
      }
    }
    yield { ask, current, staleVerdict, expiresAt };
  }
}

export function refreshMergeApprovals(k: Keeper, threadId: string, file: string, armed: boolean) {
  for (const { ask, current, staleVerdict, expiresAt } of mergeApprovals(k, threadId, k.now())) {
    if (!current) { revokeActGrant(file, ask.id, staleVerdict); continue; }
    if (!armed || !ask.target?.command || !ask.answer) continue;
    issueActGrant(file, { threadId, act: "merge", target: ask.target.command, targetDigest: actTargetDigest(ask.target.command), mergeTarget: ask.target,
      scope: "once", askId: ask.id, issuedAt: ask.answer.at, expiresAt, usedAt: null });
  }
}

export function useObservedMerge(k: Keeper, threadId: string, file: string, command: string, eventId: string, at: number, succeeded: boolean) {
  for (const { ask, current } of mergeApprovals(k, threadId, at)) {
    if (current && ask.target?.command === command && claimObservedMerge(file, ask.id))
      return recordMergeUse(k, threadId, ask.id, eventId, succeeded);
  }
  return false;
}

export function recordMergeUse(k: Keeper, threadId: string, askId: string, eventId: string, succeeded: boolean) {
  const result = k.store.atomic(() => {
    const ask = k.store.get("asks", askId);
    if (!ask || ask.keeperThreadId !== threadId || !ask.mergeApproval || !ask.target?.merge || !ask.target.commit) return false;
    if (ask.mergeUse) return ask.mergeUse.eventId === eventId;
    const at = k.now();
    k.store.put("asks", ask.id, { ...ask, mergeUse: { at, eventId, succeeded } });
    const target = ask.target.merge;
    k.store.event(at, threadId, ask.boardQuestId, "merge.used",
      `${succeeded ? "Used" : "Spent"} approval ${askId} for ${target.repository} (${target.targetBranch}) at ${ask.target.commit}${succeeded ? "." : "; the outcome is unconfirmed."}`,
      { askId, revision: ask.target.commit, act: ask.target.command, target, eventId, succeeded });
    return true;
  });
  return result;
}
