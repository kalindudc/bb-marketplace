import type { Scope } from "../scope/schema";
import { usedCommunicationReceipt } from "../scope/communication-holds";
import { sendRulesDigest } from "../scope/communication";
import type { CommunicationHold, SendTools } from "../shared/communication";
import type { Keeper } from "./keeper/service";
import { isLiveKeeper, isLiveMember, isOpenQuest } from "./liveness";

export function communicationPolicy(k: Keeper, threadId: string, rules: SendTools, file?: string, closed = false): Pick<Scope, "sendTools" | "communicationAuthority"> {
  if (!rules.length) return {};
  const member = k.member(threadId);
  if (!member || !rules.some(rule => rule.act === "draft")) return { sendTools: rules };
  const keeperId = member.role === "keeper" ? threadId : member.keeperThreadId;
  const questId = member.boardQuestId;
  const quest = questId ? k.store.get("quests", questId) : null;
  const active = !closed && !!keeperId && (member.role === "keeper" ? isLiveKeeper(k.store, member) : isLiveMember(k.store, member)) &&
    (!questId || isOpenQuest(quest) && quest.phase !== "held" && quest.phase !== "closing");
  const delegationIds = (quest?.delegations ?? []).filter(g => g.kind === "drafts-as-you" && g.revokedAt === null && g.endedAt === null).map(g => g.id);
  const rulesDigest = sendRulesDigest(rules);
  const receipts = active ? (k.store.db.prepare(`SELECT id FROM tavern_records WHERE kind='asks'
    AND json_extract(data,'$.keeperThreadId')=? AND json_extract(data,'$.effect.type')='communication-hold' AND json_extract(data,'$.effect.hold.threadId')=?
    AND json_extract(data,'$.kind')='drafts-as-you' AND json_extract(data,'$.state')='answered'
    AND json_extract(data,'$.answer.optionId')='approve' AND json_extract(data,'$.draftApprovalInvalidated') IS NULL
    ORDER BY rowid DESC`).all(keeperId, threadId) as { id: string }[]).flatMap(({ id }) => {
    const ask = k.store.get("asks", id);
    if (ask?.effect?.type !== "communication-hold" || ask.keeperThreadId !== keeperId || ask.boardQuestId !== questId || !ask.answer) return [];
    const hold = ask.effect.hold, delegationId = ask.answer.draftDelegationId;
    if (!hold.callDigest || hold.rulesDigest !== rulesDigest || file && usedCommunicationReceipt(file, ask.id) ||
        ask.answer.by === "keeper" && (!delegationId || !delegationIds.includes(delegationId)) || !["keeper", "user"].includes(ask.answer.by)) return [];
    return [{ askId: ask.id, callDigest: hold.callDigest, rulesDigest, scopeIssuedAt: hold.scopeIssuedAt, ...(delegationId ? { delegationId } : {}) }];
  }).slice(0, 100) : [];
  return { sendTools: rules, ...(receipts.length ? { communicationAuthority: { questId, active, delegationIds, receipts } } : {}) };
}

export function approvedDrafts(k: Keeper, questId?: string) {
  return k.store.db.prepare(`SELECT id, json_extract(data,'$.effect.hold.threadId') AS threadId FROM tavern_records WHERE kind='asks'
    AND json_extract(data,'$.effect.type')='communication-hold' AND json_extract(data,'$.kind')='drafts-as-you'
    AND json_extract(data,'$.state')='answered' AND json_extract(data,'$.answer.optionId')='approve'
    AND json_extract(data,'$.draftApprovalInvalidated') IS NULL
    ${questId === undefined ? "" : "AND json_extract(data,'$.boardQuestId')=?"}`).all(...(questId === undefined ? [] : [questId])) as { id: string; threadId: string }[];
}
export function invalidateDrafts(k: Keeper, rows: ReturnType<typeof approvedDrafts>) {
  for (const { id } of rows) {
    const ask = k.store.get("asks", id);
    if (ask?.state === "answered" && ask.answer?.optionId === "approve") k.store.put("asks", id, { ...ask, draftApprovalInvalidated: true });
  }
}

export function recordCommunication(k: Keeper, hold: CommunicationHold) {
  const member = k.member(hold.threadId);
  if (!member) return;
  const keeperId = member.role === "keeper" ? member.threadId : member.keeperThreadId;
  if (!keeperId) return;
  try { k.clusterRunner(keeperId, member.boardQuestId, member.threadId); } catch { return; }
  const draft = hold.act === "draft";
  const duplicate = k.store.db.prepare(`SELECT 1 FROM tavern_records WHERE kind='asks'
    AND json_extract(data,'$.keeperThreadId')=? AND json_extract(data,'$.effect.type')='communication-hold' AND json_extract(data,'$.effect.hold.threadId')=?
    AND (json_extract(data,'$.effect.hold.id')=? OR (json_extract(data,'$.state')='open'
      AND json_extract(data,'$.effect.hold.callDigest')=? AND json_extract(data,'$.effect.hold.rulesDigest')=?)) LIMIT 1`)
    .get(keeperId, hold.threadId, hold.id, hold.callDigest, hold.rulesDigest);
  if (duplicate) return;
  const approve = { id: "approve", label: "Allow this draft once", detail: "Allows only this exact call. It does not send a message.", recommended: false };
  const acknowledge = { id: "acknowledge", label: "I have the draft", detail: "Records your answer. Nothing gets sent by the agent.", recommended: false };
  const deny = { id: "deny", label: draft ? "Decline" : "Dismiss", detail: draft ? "Nothing is drafted." : "Nothing is sent.", recommended: false };
  return k.ask(keeperId, {
    boardQuestId: member.boardQuestId, kind: draft ? "drafts-as-you" : "sends-as-you", effect: { type: "communication-hold", hold }, sendTarget: hold.target ?? undefined,
    question: draft ? `Allow ${k.name(member)} to make this draft?` : `A message from ${k.name(member)} is yours to post`,
    why: draft ? "Tavern stopped the draft before it ran." : "Tavern stopped the send. Only you can post this message.",
    options: [...(draft ? (hold.callDigest ? [approve] : []) : [acknowledge]), deny],
    meanwhile: "Other work can continue.", holds: [],
  }, {}, true);
}
