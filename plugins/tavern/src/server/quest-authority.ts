import { draftTargetsSchema } from "../shared/communication";
import { ALWAYS_ASK_KINDS, DELEGATABLE_KINDS, preapprovalInputSchema, type DelegationKind, type PreapprovalInput, type Preapproval, type ActTarget } from "../shared/quest-authority";
import { doneWhenCommands } from "./check-commands";
import type { Plan, Ask } from "../shared/schema";
import { verifiedWaypoint } from "../shared/waypoint";
import type { Keeper } from "./keeper/service";
import { QUEST_LANES, authorize, commitUserAct, type UserActReceipt } from "./authority";
import { readUndoLanes } from "./undo-record";
import { keeperOwnsBlock } from "./ask-effects";
import type { UndoKind } from "../shared/undo-lane";
export type StandingAnswer = { questId: string; grant: Preapproval; optionId: string; placement: boolean };
export class QuestAuthority {
  readonly revokingDraftDelegations = new Set<string>();
  readonly rebaseMatches = new Map<string, { verifiedCommit: string; commit: string }>();
  constructor(readonly keeper: Keeper) {}
  private explicit(receipt: UserActReceipt | undefined) {
    if (!receipt || !(/^(terminal|client \(unattested\)|(?:page|banner|phone|chat) \(client, unattested\))$/.test(receipt.surface)) || !["delegateQuest", "preapproveQuest", "revokeQuestAuthority", "answerAsk"].includes(receipt.act)) throw new Error("Quest authority requires an explicit client action");
  }
  private active(record: { endedAt: number | null; revokedAt: number | null; endsAt?: number | null }) {
    return record.endedAt === null && record.revokedAt === null && (record.endsAt == null || record.endsAt > this.keeper.now());
  }
  delegate(questId: string, kind: DelegationKind, receipt: UserActReceipt, targets?: string[]) {
    this.explicit(receipt);
    if (!DELEGATABLE_KINDS.some(candidate => candidate === kind)) throw new Error("This kind cannot be delegated");
    if (kind === "drafts-as-you") targets = draftTargetsSchema.parse(targets);
    else if (targets !== undefined) throw new Error("Only drafting takes a list of targets");
    const k = this.keeper, q = k.quest(questId); k.liveQuest(q.keeperThreadId, q.id);
    if (readUndoLanes(k.store, q.keeperThreadId).some(lane => lane.kind === kind)) throw new Error("Reset this kind in the Ledger first.");
    return commitUserAct(k.store, k.now, receipt, () => {
      const existing = q.delegations?.find(g => g.kind === kind && this.active(g) && JSON.stringify(g.targets) === JSON.stringify(targets)); if (existing) return existing;
      if ((q.delegations?.length ?? 0) >= 100) throw new Error("This quest has reached its authority record limit");
      const grant = { id: k.store.id("delegation"), kind, at: k.now(), surface: receipt.surface, endedAt: null, revokedAt: null, ...(targets ? { targets } : {}) };
      k.store.put("quests", q.id, { ...q, delegations: [...(q.delegations ?? []), grant] });
      for (const ask of k.store.query("asks", "boardQuestId", q.id, 500).filter(a => a.state === "open" && a.kind === kind && !a.unsure && (kind !== "drafts-as-you" || !!a.sendTarget && targets?.includes(a.sendTarget)))) k.store.put("asks", ask.id, { ...ask, lane: "keeper" });
      k.store.event(k.now(), q.keeperThreadId, q.id, "delegation.granted", `${kind}: let ${k.name(k.require(q.keeperThreadId, "keeper"))} decide for this quest`, grant, { kind: "user" });
      k.changed(q.keeperThreadId, q.id); return grant;
    });
  }
  preapprove(questId: string, input: PreapprovalInput, receipt: UserActReceipt) {
    this.explicit(receipt); input = preapprovalInputSchema.parse(input);
    const k = this.keeper, q = k.quest(questId); k.liveQuest(q.keeperThreadId, q.id);
    if (input.endsAt !== null && input.endsAt <= k.now()) throw new Error("Pre-approval must end in the future");
    if ((q.preapprovals?.length ?? 0) >= 100) throw new Error("This quest has reached its authority record limit");
    return commitUserAct(k.store, k.now, receipt, () => {
      const grant: Preapproval = { ...input, id: k.store.id("preapproval"), at: k.now(), surface: receipt.surface, endedAt: null, revokedAt: null, retriesUsed: 0 };
      k.store.put("quests", q.id, { ...q, preapprovals: [...(q.preapprovals ?? []).map(g => this.active(g) ? { ...g, revokedAt: k.now() } : g), grant] });
      k.store.event(k.now(), q.keeperThreadId, q.id, "preapproval.recorded", "Standing answers recorded for this quest only", grant, { kind: "user" });
      k.changed(q.keeperThreadId, q.id); return grant;
    });
  }
  revoke(questId: string, id: string, receipt: UserActReceipt) {
    this.explicit(receipt); const k = this.keeper, q = k.quest(questId);
    const grant = [...(q.delegations ?? []), ...(q.preapprovals ?? [])].find(g => g.id === id);
    if (!grant) throw new Error("Unknown quest authority record");
    commitUserAct(k.store, k.now, receipt, () => {
      k.store.put("quests", q.id, { ...q, delegations: q.delegations?.map(g => g.id === id ? { ...g, revokedAt: k.now() } : g), preapprovals: q.preapprovals?.map(g => g.id === id ? { ...g, revokedAt: k.now() } : g) });
      for (const ask of k.store.query("asks", "boardQuestId", q.id, 500).filter(a => a.state === "open" && a.lane === "keeper")) k.store.put("asks", ask.id, { ...ask, lane: this.baseLane(ask) });
      k.store.event(k.now(), q.keeperThreadId, q.id, "authority.revoked", "Quest authority revoked immediately", { id, surface: receipt.surface }, { kind: "user" });
    });
    k.changed(q.keeperThreadId, q.id);
  }
  baseLane(ask: Pick<Ask, "kind" | "boardQuestId" | "effect" | "sendTarget"> & { unsure?: boolean }): "user" | "keeper" {
    if (ask.effect && keeperOwnsBlock(ask.effect)) return "keeper";
    if (ask.kind === "cluster-write" || ask.kind === "sends-as-you" || ask.unsure || !ask.boardQuestId) return "user";
    const q = this.keeper.store.get("quests", ask.boardQuestId);
    if (!q || ["done", "stopping", "stopped"].includes(q.phase)) return "user";
    if (ask.effect?.type === "grant-shell-act" && ask.effect.target.act === "publish") return "keeper";
    if (ask.kind === "decision" && ask.effect?.type === "pull-request-draft" && ["edit", "close"].includes(ask.effect.operation))
      return this.keeper.settings(q.id).keepers.alwaysAsk.includes("sends-as-you") ? "user" : "keeper";
    if (!QUEST_LANES[ask.kind as keyof typeof QUEST_LANES]?.delegatable) return "user";
    const { delegation, keeperAuthority } = this.keeperDecisionSource(ask);
    return delegation || keeperAuthority ? "keeper" : "user";
  }
  keeperDecisionSource(ask: Pick<Ask, "kind" | "boardQuestId" | "sendTarget">) {
    if (!ask.boardQuestId || ask.kind === "sends-as-you") return {};
    const delegation = this.keeper.quest(ask.boardQuestId).delegations?.find(g => g.kind === ask.kind && this.active(g) &&
      (g.kind !== "drafts-as-you" || !this.revokingDraftDelegations.has(g.id) && !!ask.sendTarget && g.targets?.includes(ask.sendTarget)));
    if (delegation) return { delegation };
    const kind = ALWAYS_ASK_KINDS.find(kind => kind === ask.kind);
    return kind && !this.keeper.settings(ask.boardQuestId).keepers.alwaysAsk.includes(kind)
      ? { keeperAuthority: "keepers.alwaysAsk" as const } : {};
  }
  applyAskPolicy(prior: readonly (typeof ALWAYS_ASK_KINDS[number])[], next: readonly (typeof ALWAYS_ASK_KINDS[number])[]) {
    const k = this.keeper;
    if (ALWAYS_ASK_KINDS.every(kind => prior.includes(kind) === next.includes(kind))) return;
    k.store.atomic(() => {
      for (const ask of k.store.openAsks()) {
        const kind = ALWAYS_ASK_KINDS.find(kind => kind === ask.kind);
        if (!kind || kind === "sends-as-you" || prior.includes(kind) === next.includes(kind)) continue;
        const lane = this.lane(ask);
        if (lane === (ask.lane ?? "user")) continue;
        const options = ask.options.filter(option => option.id !== "delegate");
        if (lane === "user" && ask.boardQuestId) options.push(this.delegationOption(ask.keeperThreadId));
        k.store.put("asks", ask.id, { ...ask, options, lane });
        k.store.event(k.now(), ask.keeperThreadId, ask.boardQuestId, "ask.lane-changed", "Always ask changed the decision lane", { askId: ask.id, from: ask.lane ?? "user", to: lane }, { kind: "tavern" });
      }
    });
  }
  delegationOption(keeperThreadId: string) {
    const k = this.keeper;
    return { id: "delegate", label: `Let ${k.name(k.require(keeperThreadId, "keeper"))} decide these for the rest of this quest`,
      detail: "Records a revocable grant for this kind on this quest only. This act still needs a decision.", recommended: false };
  }
  lane(ask: Parameters<QuestAuthority["baseLane"]>[0]): "user" | "keeper" {
    if (this.baseLane(ask) === "user") return "user";
    if (!ask.boardQuestId || ask.effect && keeperOwnsBlock(ask.effect)) return "keeper";
    const k = this.keeper, keeperId = k.quest(ask.boardQuestId!).keeperThreadId;
    return readUndoLanes(k.store, keeperId).some(shift => shift.kind === ask.kind) ? "user" : "keeper";
  }
  resetUndoLane(threadId: string, kind: UndoKind, receipt: UserActReceipt) {
    const k = this.keeper;
    k.require(threadId, "keeper");
    if (receipt?.act !== "resetUndoLane") throw new Error("Reset needs an explicit user action");
    authorize("resetUndoLane", { level: "user-explicit", receipt: receipt.surface });
    if (!readUndoLanes(k.store, threadId).some(shift => shift.kind === kind)) return { ok: true as const };
    k.store.event(k.now(), threadId, null, "lane.reset", "You reset the Keeper's undo record for this kind.", { kind, surface: receipt.surface }, { kind: "user" });
    return { ok: true as const };
  }
  private routinePlan(plan: Plan) {
    const check = (command: string) => /^(?:(?:npm|pnpm|yarn|bun)(?: run)? (?:test|check|lint|typecheck|verify)(?::[\w-]+)?|node --(?:test|check)|(?:npx )?tsc --noEmit)$/.test(command.trim());
    const relative = (path: string | undefined) => !!path && !/^(?:[\\/]|[a-z]:)/i.test(path) && !path.split(/[\\/]/).includes("..");
    return doneWhenCommands([plan.doneWhen, ...plan.waypoints.map(w => w.doneWhen)]).every(check) && plan.waypoints.every(w => w.actor === "agent" && !!w.acts?.length && w.acts.every(act => {
      if (act.kind === "check") return !!act.command && check(act.command);
      if (act.kind === "read" || act.kind === "workspace-write") return !act.command && relative(act.path);
      return false;
    }));
  }
  match(ask: Ask): StandingAnswer | null {
    if (!ask.boardQuestId || ask.state !== "open") return null;
    const k = this.keeper, q = k.quest(ask.boardQuestId);
    if (["held", "stopping", "stopped", "done"].includes(q.phase)) return null;
    const grant = q.preapprovals?.find(g => this.active(g)); if (!grant) return null;
    let optionId: string | null = null;
    if (ask.kind === "greenlight" && ask.effect?.type === "greenlight" && !ask.effect.requiresExplicit && grant.greenlight) {
      const plan = k.store.get("plans", `${q.id}:${ask.effect.planVersion}`), envelope = grant.greenlight;
      if (plan && !plan.party.some(slot => slot.leadEnvelope) && !k.store.leadLinksBy("childQuestId", q.id).length && plan.version === q.planVersion && plan.reversible && !(plan.alwaysAskKinds?.length ?? 0) && !plan.questions.length && this.routinePlan(plan) && plan.party.length <= envelope.maxMembers && plan.party.every(s => envelope.classes.includes(s.classId))) optionId = "approve";
    } else if (ask.kind === "blocker" && ask.effect?.type === "placement-blocker" && grant.placement) optionId = grant.retriesUsed === 0 ? "retry" : "stop";
    else if (ask.kind === "conclude" && ask.effect?.type === "conclude" && !ask.effect.draft.lead && grant.conclude && !ask.effect.draft.skipped?.length && !ask.effect.draft.pullRequests?.length && !k.store.openPullRequests(q.id).length) {
      const summary = k.summary(q.id);
      if (summary.plan && summary.waypoints.length && summary.waypoints.every(verifiedWaypoint)) optionId = "conclude";
    }
    return optionId ? { questId: q.id, grant, optionId, placement: ask.effect?.type === "placement-blocker" } : null;
  }
  consume(answer: StandingAnswer) {
    const k = this.keeper, q = k.quest(answer.questId), grant = q.preapprovals?.find(g => g.id === answer.grant.id);
    if (!grant || !this.active(grant)) throw new Error("Pre-approval was revoked or ended");
    if (answer.placement && answer.optionId === "retry") {
      if (grant.retriesUsed) throw new Error("The pre-approved placement retry was already used");
      k.store.put("quests", q.id, { ...q, preapprovals: q.preapprovals!.map(g => g.id === grant.id ? { ...g, retriesUsed: 1 } : g) });
    }
  }
  static sameTarget(target: ActTarget & { patchId?: string; cleanRebase?: boolean }, verdict: ActTarget & { patchId?: string }) {
    if (target.command) return target.command === verdict.command && target.commit === verdict.commit;
    return !!target.commit && (target.commit === verdict.commit || !!target.patchId && target.patchId === verdict.patchId && target.cleanRebase === true);
  }
  assertVerdict(ask: Ask) {
    if (ask.kind !== "merge" && ask.kind !== "production") return;
    const k = this.keeper;
    const replay = this.rebaseMatches.get(ask.id);
    this.rebaseMatches.delete(ask.id);
    const verdict = k.store.get("actVerdicts", ask.id);
    const warden = verdict && k.member(verdict.wardenThreadId);
    const entry = verdict && k.journal.linkedEntries(ask.boardQuestId!).find(e => e.id === verdict.entryId && e.threadId === warden?.checkerMakerThreadId);
    if (!entry || entry.status !== "verified" || entry.review?.actor.kind !== "agent" || entry.review.actor.threadId !== warden?.threadId) throw new Error("The Warden verdict is no longer current");
    if (!ask.target || !verdict || warden?.classId !== "warden" || warden.boardQuestId !== ask.boardQuestId || !warden.checkerMakerThreadId || warden.checkerMakerThreadId === warden.threadId || !(QuestAuthority.sameTarget(ask.target, verdict.target) || ask.kind === "merge" && !!ask.target.commit && !!verdict.target.commit && replay?.verifiedCommit === verdict.target.commit && replay.commit === ask.target.commit)) throw new Error("A delegated merge or production change needs a Warden verdict on the exact commit or command");
  }
  recordVerdict(threadId: string, askId: string, entryId: string, target: ActTarget) {
    const k = this.keeper, warden = k.require(threadId, "member"), ask = k.store.get("asks", askId);
    if (warden.classId !== "warden" || !ask || ask.boardQuestId !== warden.boardQuestId || !warden.checkerMakerThreadId || warden.checkerMakerThreadId === threadId) throw new Error("Only the assigned independent Warden can record this verdict");
    const entry = k.journal.linkedEntries(ask.boardQuestId!).find(e => e.id === entryId && e.threadId === warden.checkerMakerThreadId && e.link?.waypointId === warden.checkerWaypointId && e.status === "verified" && e.review?.actor.kind === "agent" && e.review.actor.threadId === threadId);
    if (!entry || !entry.review?.evidence.some(e => e.ref === target.commit || e.ref === target.command)) throw new Error("The verified journal evidence must name the exact commit or command");
    k.store.put("actVerdicts", ask.id, { wardenThreadId: threadId, entryId, target, at: k.now() });
    k.store.event(k.now(), ask.keeperThreadId, ask.boardQuestId, "act.verified", "Warden verified the exact act", { askId, target, entryId }, { kind: "agent", threadId });
  }
  view(questId: string) {
    const k = this.keeper, q = k.quest(questId);
    const shifted = new Set(q.delegations?.some(g => this.active(g)) ? readUndoLanes(k.store, q.keeperThreadId).map(row => row.kind) : []);
    const keeper = k.member(q.keeperThreadId);
    if (!keeper) throw new Error("The quest's Keeper record is missing.");
    const proposal = q.phase === "greenlight" && !q.spendBudget?.reached && q.spendProposal?.planVersion === q.planVersion ? q.spendProposal.cents : undefined;
    return { keeperName: k.name(keeper), rows: [...DELEGATABLE_KINDS.map(kind => ({ kind, lane: shifted.has(kind) ? "user" as const : this.baseLane({ kind, boardQuestId: q.id }) })), { kind: "cluster-write", lane: QUEST_LANES["cluster-write"].lane }, { kind: "sends-as-you", lane: "user" as const }, ...["greenlight", "conclude"].map(kind => ({ kind, lane: q.preapprovals?.some(g => this.active(g) && (kind === "greenlight" ? g.greenlight : g.conclude)) ? "tavern" as const : "user" as const })), ...Object.entries(QUEST_LANES).filter(([, row]) => row.lane === "keeper").map(([kind, row]) => ({ kind, lane: row.lane }))], delegations: q.delegations ?? [], preapprovals: q.preapprovals ?? [], review: { used: k.store.query("members", "boardQuestId", q.id, 500).filter(m => m.classId === "warden").length, total: k.settings(q.id).attention.reviewBudget }, spendBudget: q.spendBudget?.cents ?? null, ...(proposal !== undefined && proposal !== q.spendBudget?.cents ? { spendProposal: proposal } : {}) };
  }
}
