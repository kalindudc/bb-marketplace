import type { Actor, Member } from "../shared/schema";
import { ENGAGEMENTS, type Disposition, type Engagement } from "../shared/member-engagement";
import type { KeeperStore, PendingBrief } from "./keeper/store";
import { PlacementStore } from "./placement/store";

export type EngagementReceipt = { kind: string; id: string; evidence?: Record<string, unknown> };
export type Archive = { disposition: Disposition; resumeTo: Exclude<Engagement, "releasing" | "stopping" | "archiving" | "archived"> };
export type MemberOperation = {
  id: string; reason: string; receipt: EngagementReceipt;
  error?: string | null; attempts?: number; nextAttemptAt?: number; askId?: string | null;
  stopConfirmed?: boolean; skipStopIfQuiet?: boolean; placementRequired?: boolean; modelFailure?: boolean;
};
export type MemberEngagementData = {
  delivery?: PendingBrief | null;
  rest?: { since: number; reminded?: boolean; keep?: { until: number; why: string; decisionId: string } | null } | null;
  operation?: MemberOperation | null;
  release?: { reason: string; decisionId?: string; at?: number } | null;
  archive?: Archive | null;
  archiveAfter?: { receipt: EngagementReceipt; reason: string; archive: Archive } | null;
  host?: { archivedAt: number | null; deletedAt: number | null } | null;
};

const available = ["briefing", "active", "resting"] as const;
const terminal = ["released", "stopped"] as const;
const archiveSources = [...available, ...terminal];
const rows = <F extends Engagement | null, T extends Engagement, C extends string>(from: readonly F[], to: readonly T[], cause: C, by: readonly Actor["kind"][], receipt: string, event: string) =>
  from.flatMap(f => to.map(t => ({ from: f, to: t, cause, by, receipt, event })));
export const MEMBER_TRANSITIONS = [
  ...rows([null], ["briefing"], "bind-hire", ["agent"], "hire", "member.bound"),
  ...rows([null], ["active"], "bind-solo", ["user"], "class-start", "member.bound"),
  ...rows(["briefing"], ["active"], "brief-accepted", ["tavern"], "brief-acceptance", "member.briefed"),
  ...rows(["resting"], ["briefing"], "rebrief", ["agent"], "brief", "member.rebrief-requested"),
  ...rows(["briefing"], ["resting"], "rebrief-cancelled", ["tavern"], "brief-cancelled", "member.brief-cancelled"),
  ...rows(["active"], ["resting"], "done-report", ["agent"], "report", "report.filed"),
  ...rows(available, ["releasing"], "release-requested", ["agent"], "decision", "member.release-requested"),
  ...rows(available, ["releasing"], "release-answered", ["user"], "ask-answer", "member.release-requested"),
  ...rows(available, ["releasing"], "greenlight-undone", ["user"], "undo", "member.release-requested"),
  ...rows(available, ["releasing"], "model-failure", ["tavern"], "host-failure", "member.release-requested"),
  ...rows(["releasing"], ["released"], "release-confirmed", ["tavern"], "host-stop", "member.released"),
  ...rows([...available, "releasing"], ["stopping"], "quest-stop", ["user"], "quest-stop", "member.stop-requested"),
  ...rows([...available, "releasing"], ["stopping"], "hire-cancelled", ["tavern"], "cancelled-hire", "member.stop-requested"),
  ...rows(["stopping"], ["stopped"], "stop-confirmed", ["tavern"], "host-stop", "member.stopped"),
  ...rows(archiveSources, ["archiving"], "archive-requested", ["tavern", "user"], "archive-authority", "member.archive-requested"),
  ...rows(["archiving"], ["archived"], "archive-confirmed", ["tavern"], "host-archive", "thread.archived"),
  ...rows(archiveSources, ["archived"], "host-archived", ["tavern", "user", "agent"], "host-archive", "thread.archived"),
  ...rows(archiveSources, ["archived"], "host-deleted", ["tavern", "user", "agent"], "host-delete", "thread.deleted"),
  ...rows(["archived"], archiveSources, "unarchived", ["tavern", "user", "agent"], "host-unarchive", "thread.unarchived"),
  ...rows([null], ENGAGEMENTS, "legacy-import", ["tavern"], "migration", "member.engagement-imported"),
];

type Cause = (typeof MEMBER_TRANSITIONS)[number]["cause"];
const writes = new WeakSet<object>();
export const consumesMemberWrite = (record: object) => writes.delete(record);
export const memberDetails = (store: KeeperStore, id: string): MemberEngagementData => store.runtime(id).memberEngagement ?? {};
export const patchMemberDetails = (store: KeeperStore, id: string, patch: Partial<MemberEngagementData>) =>
  store.patch(id, { memberEngagement: { ...memberDetails(store, id), ...patch } });

export function outstandingArchivedPlacement(placements: PlacementStore, member: Member) {
  if (member.engagement !== "archived") return null;
  const placement = placements.byMember(member.threadId);
  return placement && placement.phase !== "released" ? placement : null;
}

export const MACHINE_RELEASED = "Its machine was released, so it can't take new work; hire a new member to continue.";
export function isMemberMachineGone(placement: ReturnType<PlacementStore["byMember"]>): boolean {
  return placement !== null && (placement.phase === "released" || placement.preservation.liveOwnerThreadId === null && (
    ["lost", "unknown"].includes(placement.preservation.source) ||
    placement.blocked?.code === "preservation-owner-lost" ||
    placement.preservation.source === "saved" && placement.preservation.artifacts === "unknown"));
}

export function assertMemberMachineForBrief(store: KeeperStore, member: Member): void {
  if (isMemberMachineGone(new PlacementStore(store.db).byMember(member.threadId))) {
    const name = member.displayName ?? member.classId.charAt(0).toUpperCase() + member.classId.slice(1);
    throw new Error(`${name}: ${MACHINE_RELEASED}`);
  }
}

export function archiveDisposition(member: Member, finished = false): Archive {
  if (member.engagement === "released") return { disposition: "released", resumeTo: "released" };
  if (member.engagement === "stopped") return { disposition: "stopped", resumeTo: "stopped" };
  if (member.engagement === "resting" || finished) return { disposition: member.engagement === "resting" ? "finished" : "retired unfinished", resumeTo: "resting" };
  return { disposition: "retired unfinished", resumeTo: member.engagement === "briefing" ? "briefing" : "active" };
}

function hasArchiveAuthority(store: KeeperStore, member: Member, receipt: EngagementReceipt): boolean {
  const cause = receipt.evidence?.cause;
  if (cause === "errand-report") {
    const report = store.get("reports", receipt.id);
    return member.errand && report?.status === "done" && report.memberThreadId === member.threadId &&
      report.boardQuestId === member.boardQuestId && report.keeperThreadId === member.keeperThreadId;
  }
  if (cause === "cancelled-hire") {
    const hire = store.get("hires", receipt.id);
    return hire?.memberThreadId === member.threadId && hire.cancelledAt != null;
  }
  if (cause === "legacy-archive")
    return receipt.id === memberDetails(store, member.threadId).archiveAfter?.receipt.id;
  if (!member.boardQuestId) return false;
  if (cause === "repair") {
    const quest = store.get("quests", member.boardQuestId);
    return quest?.id === receipt.id && (quest.phase === "done" || quest.phase === "stopped");
  }
  if (cause === "conclude" || cause === "close-early") {
    const ask = store.get("asks", receipt.id);
    return ask?.boardQuestId === member.boardQuestId && ask.keeperThreadId === member.keeperThreadId &&
      ask.effect?.type === cause && ask.state === "answered" && ask.answer?.optionId === cause &&
      ["user", "preapproval"].includes(ask.answer.by);
  }
  return (cause === "quest.archived" || cause === "quest.deleted" || cause === "quest.stopped") &&
    String(store.latestQuestEvent(member.boardQuestId, cause)?.id) === receipt.id;
}

export function transitionMember(store: KeeperStore, member: Member, to: Engagement, cause: Cause, actor: Actor, receipt: EngagementReceipt, at: number, options: {
  details?: Partial<MemberEngagementData>; patch?: Partial<Pick<Member, "state" | "stopError" | "lastStopAttemptAt">>; text?: string; data?: Record<string, unknown>;
} = {}): Member {
  return store.atomic(() => {
    const current = store.get("members", member.threadId);
    const from = current?.engagement ?? null, bound = current ?? member;
    const row = MEMBER_TRANSITIONS.find(r => r.from === from && r.to === to && r.cause === cause && r.by.includes(actor.kind) && r.receipt === receipt.kind);
    const refuse = (why: string): never => { throw new Error(`Member engagement refuses ${from ?? "none"} to ${to} for ${cause}: ${why}`); };
    if (!row || bound.role === "keeper" || !receipt.id.trim()) refuse("authority or receipt does not match");
    if (actor.kind === "agent" && ["bind-hire", "rebrief", "release-requested"].includes(cause) && actor.threadId !== bound.keeperThreadId) refuse("not the owning Keeper");
    if (cause === "bind-hire") {
      const hire = store.get("hires", receipt.id);
      if (!hire || hire.owner.keeperThreadId !== bound.keeperThreadId || hire.owner.boardQuestId !== bound.boardQuestId || hire.classId !== bound.classId || hire.memberThreadId && hire.memberThreadId !== bound.threadId) refuse("hire binding does not match");
    }
    if (cause === "bind-solo" && bound.role !== "solo") refuse("not a solo class start");
    if (cause === "done-report") {
      const report = store.get("reports", receipt.id);
      if (actor.kind !== "agent" || actor.threadId !== bound.threadId || report?.memberThreadId !== bound.threadId || report.status !== "done" || report.deliveredAt !== null) refuse("report does not authorize this member to rest");
    }
    const previous = memberDetails(store, bound.threadId);
    const details = { ...previous, ...options.details };
    if (cause === "release-requested") {
      const decision = store.get("decisions", receipt.id);
      if (!decision || decision.keeperThreadId !== bound.keeperThreadId || decision.undone || !decision.reversible) refuse("release decision does not match");
    }
    if (cause === "quest-stop" &&
        (!bound.boardQuestId || String(store.latestQuestEvent(bound.boardQuestId, "quest.stopping")?.id) !== receipt.id))
      refuse("quest stop does not match");
    if (cause === "hire-cancelled") {
      const hire = store.get("hires", receipt.id);
      if (hire?.memberThreadId !== bound.threadId || hire.cancelledAt == null || hire.owner.keeperThreadId !== bound.keeperThreadId ||
          hire.owner.boardQuestId !== bound.boardQuestId) refuse("cancelled hire does not match");
    }
    if (cause === "release-answered") {
      const ask = store.get("asks", receipt.id), effect = ask?.effect;
      const scope = effect?.type === "grant-scope" ? store.get("scopeRequests", receipt.id) : null;
      const retryRelease = effect?.type === "retry-brief" && effect.threadId === bound.threadId && effect.briefId === previous.delivery?.id && ask?.answer?.optionId === "release";
      const deniedScope = effect?.type === "grant-scope" && effect.memberThreadId === bound.threadId && scope?.memberThreadId === bound.threadId && scope.initialBrief && ask?.answer?.optionId === "deny";
      if (ask?.state !== "answered" || ask.answer?.by !== "user" || ask.keeperThreadId !== bound.keeperThreadId ||
          ask.boardQuestId !== bound.boardQuestId || !(retryRelease || deniedScope)) refuse("release answer does not match");
    }
    if (cause === "greenlight-undone") {
      const decision = store.get("decisions", receipt.id), approval = store.get("autoGreenlights", receipt.id);
      if (!decision?.undone || !approval || approval.keeperThreadId !== bound.keeperThreadId ||
          approval.boardQuestId !== bound.boardQuestId || bound.createdAt < decision.createdAt || bound.lastReportAt !== null)
        refuse("undone approval does not match");
    }
    if (cause === "model-failure") {
      const key = receipt.evidence?.modelFailureId, placement = new PlacementStore(store.db).byMember(bound.threadId);
      const failure = typeof key === "string" ? store.get("placementModelFailures", key) : null;
      const execution = store.runtime(bound.threadId).placementExecution ?? (placement ? store.get("hires", placement.hireToken)?.placementExecution : undefined);
      if (!placement || !failure || failure.model !== execution?.model || failure.providerId !== execution?.providerId || !store.runtime(bound.threadId).placementFirstTurnSettled)
        refuse("provider failure does not match the placed member");
    }
    if (cause === "archive-requested" && !hasArchiveAuthority(store, bound, receipt)) refuse("archive authority does not match the member");
    if (cause === "host-archived" || cause === "host-deleted") {
      const observed = cause === "host-deleted" ? details.host?.deletedAt : details.host?.archivedAt;
      if (!Number.isSafeInteger(observed) || receipt.id !== `${bound.threadId}:${observed}`)
        refuse("host observation does not match the thread");
    }
    if (cause === "rebrief" || cause === "brief-accepted") assertMemberMachineForBrief(store, bound);
    if (cause === "rebrief" && details.delivery?.id !== receipt.id) refuse("brief does not match");
    if (cause === "rebrief-cancelled" && (previous.delivery?.id !== receipt.id || !previous.rest)) refuse("no matching resting brief to cancel");
    if (cause === "brief-accepted" && previous.delivery && previous.delivery.id !== receipt.id) refuse("accepted a different brief");
    if (cause === "unarchived" && (receipt.id !== bound.threadId || previous.archive?.resumeTo !== to || previous.host?.deletedAt != null)) refuse("archive resume state or host evidence does not match");
    if (["archiving", "releasing", "stopping"].includes(to) && !details.operation) refuse("operation is missing");
    if ((to === "archiving" || to === "archived") && !details.archive) refuse("archive outcome is missing");
    let machine: Record<string, unknown> | undefined;
    if (["release-confirmed", "stop-confirmed", "archive-confirmed"].includes(cause)) {
      const operation = previous.operation;
      if (!operation || operation.id !== receipt.id) refuse("operation has changed");
      if (cause === "archive-confirmed" && details.host?.archivedAt == null && details.host?.deletedAt == null)
        refuse("bb archive confirmation is missing");
      if (cause === "stop-confirmed" && !operation?.stopConfirmed) refuse("bb stop confirmation is missing");
      const placement = new PlacementStore(store.db).byMember(bound.threadId);
      if (!placement && operation?.placementRequired) refuse("the placement record is unavailable; work cannot be reconciled");
      if (placement) {
        const proof = placement.preservation;
        if (placement.phase !== "released" || placement.desiredState !== "released" || proof.liveOwnerThreadId !== null || !proof.stopConfirmed)
          refuse("the machine has not been released with preservation or reconciled loss");
        machine = { placementId: placement.id, generation: placement.generation, source: proof.source, artifacts: proof.artifacts };
        if (cause === "archive-confirmed" && details.archive?.resumeTo !== "released" && details.archive?.resumeTo !== "stopped") {
          details.archive = { disposition: details.archive!.disposition, resumeTo: "released" };
        }
      }
    }
    if (to === "resting") details.rest ??= { since: at };
    if (to === "active") details.rest = null;
    if (to !== "active" && to !== "briefing") details.delivery = null;
    if (["archived", "released", "stopped"].includes(to)) details.operation = null;
    if (cause === "unarchived") { details.archive = null; details.host = null; }
    const updated: Member = { ...bound, ...options.patch, engagement: to };
    if (to === "archiving" || to === "archived") updated.disposition = details.archive!.disposition;
    else if (to === "released" || to === "stopped") updated.disposition = to;
    else delete updated.disposition;
    delete (updated as Member & { place?: string }).place;
    delete (updated as Member & { stopPending?: boolean }).stopPending;
    if (to !== "stopping") { delete updated.stopError; delete updated.lastStopAttemptAt; }
    writes.add(updated);
    store.put("members", bound.threadId, updated);
    if (cause !== "legacy-import" && (to === "released" || to === "archived")) store.transferPullRequests(bound.threadId, at);
    store.patch(bound.threadId, { memberEngagement: details });
    const event = cause === "archive-confirmed" && details.host?.deletedAt != null ? "thread.deleted" : row!.event;
    store.event(at, bound.keeperThreadId, bound.boardQuestId, event, options.text ?? `${bound.displayName ?? bound.classId}: ${from ?? "new"} to ${to}`, {
      ...options.data, ...(machine ? { machine } : {}), ...(to === "archived" ? { archive: details.archive } : {}), memberThreadId: bound.threadId, engagement: { from, to }, cause, receipt,
    }, actor);
    return updated;
  });
}

export function memberHost(store: KeeperStore, member: Member) {
  if (member.role === "keeper") {
    const { archivedAt, deletedAt } = store.runtime(member.threadId);
    return { archivedAt: archivedAt ?? null, deletedAt: deletedAt ?? null };
  }
  return memberDetails(store, member.threadId).host ?? { archivedAt: null, deletedAt: null };
}
