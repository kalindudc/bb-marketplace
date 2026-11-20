import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Keeper } from "./keeper/service";
import type { HireIntent } from "./keeper/store";
import { settleStaffing } from "./staffing";
import { LIMITS } from "./limits";
import { isOpenQuest } from "./liveness";
import { isNotFound } from "./host-errors";
import { loopCall } from "./loop-call";
import { LimitPolicy } from "./limit-policy";
import { PlacementStore } from "./placement/store";
import { isQuiescentThread } from "./placement/quiescence";
import { archiveDisposition, memberDetails, patchMemberDetails, transitionMember } from "./member-engagement";

export function rejectedSpawn(error: unknown) {
  if (error && typeof error === "object") {
    for (const key of ["status", "statusCode"] as const) {
      const status =
        key in error ? Number(error[key as keyof typeof error]) : NaN;
      if (status >= 400 && status < 500) return true;
    }
  }
  return /\b(?:HTTP\s+)?4\d\d\b/.test(String(error));
}
export function releaseHire(k: Keeper, token: string, intent: HireIntent) {
  k.store.atomic(() => {
    settleStaffing(k, intent.staffing, token, null);
    if (!intent.memberThreadId) new LimitPolicy(k).release(token, intent.owner.boardQuestId, intent.limitDecisionIds ?? []);
    if (!intent.memberThreadId && intent.guardApprovalAskId) {
      const ask = k.store.get("asks", intent.guardApprovalAskId);
      if (ask?.effect?.type === "detection-hire" && ask.effect.binding.token === token) {
        const { token: _token, ...binding } = ask.effect.binding;
        k.store.put("asks", ask.id, { ...ask, effect: { type: "detection-hire", binding } });
      }
    }
    k.store.remove("hires", token);
  });
}
export function isHireCancelled(k: Keeper, intent: HireIntent) {
  return intent.cancelledAt != null || intent.owner.boardQuestId !== null && !isOpenQuest(k.store.get("quests", intent.owner.boardQuestId));
}
export async function settleCancelledHire(bb: BbPluginApi, k: Keeper, token: string, intent: HireIntent, threadId: string, beforeArchive?: (threadId: string) => Promise<void>) {
  k.store.put("hires", token, { ...intent, cancelledAt: intent.cancelledAt ?? k.now(), memberThreadId: threadId });
  let member = k.member(threadId)!;
  const placed = new PlacementStore(k.store.db).byMember(threadId) !== null || k.store.runtime(threadId).placementExecution != null;
  if (["briefing", "active", "resting", "releasing"].includes(member.engagement ?? "")) {
    const receipt = { kind: "cancelled-hire", id: token };
    member = transitionMember(k.store, member, "stopping", "hire-cancelled", { kind: "tavern" }, receipt, k.now(),
      { details: { operation: { id: token, receipt, reason: "Cancelled hire", placementRequired: placed } } });
  }
  const lookup = async () => {
    try { return await loopCall(bb.sdk.threads.get({ threadId }), `cancelled hire thread ${threadId}`); }
    catch (error) { if (!isNotFound(error)) throw error; return null; }
  };
  if (member.engagement === "stopping") {
    const op = memberDetails(k.store, threadId).operation!;
    let thread = await lookup();
    if (!op.stopConfirmed && thread && thread.archivedAt === null && thread.deletedAt === null) {
      try { await loopCall(bb.sdk.threads.stop({ threadId }), `cancelled hire stop ${threadId}`); }
      catch (error) { if (!isNotFound(error)) throw error; }
      thread = await lookup();
      if (thread && thread.archivedAt === null && thread.deletedAt === null && !(placed ? isQuiescentThread(thread) : ["idle", "error"].includes(thread.status)))
        throw new Error(`Cancelled hire stop not yet confirmed for ${threadId}`);
    }
    patchMemberDetails(k.store, threadId, { operation: { ...op, stopConfirmed: true } });
    if (beforeArchive) await beforeArchive(threadId);
    member = transitionMember(k.store, member, "stopped", "stop-confirmed", { kind: "tavern" }, { kind: "host-stop", id: op.id, evidence: { request: op.receipt } }, k.now());
  }
  if (member.engagement === "stopped") {
    const receipt = { kind: "archive-authority", id: token, evidence: { cause: "cancelled-hire" } };
    member = transitionMember(k.store, member, "archiving", "archive-requested", { kind: "tavern" }, receipt, k.now(),
      { details: { operation: { id: token, receipt, reason: "Archive cancelled hire", placementRequired: placed }, archive: archiveDisposition(member) } });
  }
  if (member.engagement === "archiving") {
    const operation = memberDetails(k.store, threadId).operation!;
    let thread = await lookup();
    const placement = new PlacementStore(k.store.db).byMember(threadId);
    if (placed && placement?.phase !== "released") throw new Error("Cancelled hire preservation is not confirmed");
    if (thread && thread.archivedAt === null && thread.deletedAt === null) {
      const result = await loopCall(bb.sdk.threads.archive({ threadId }), `cancelled hire archive ${threadId}`);
      thread = result.archivedThreadIds?.includes(threadId) ? { ...thread, archivedAt: k.now() } : await lookup();
      if (thread && thread.archivedAt === null && thread.deletedAt === null) throw new Error("Cancelled hire archive is not confirmed");
    }
    const host = { archivedAt: thread?.archivedAt ?? k.now(), deletedAt: thread ? thread.deletedAt : k.now() };
    transitionMember(k.store, member, "archived", "archive-confirmed", { kind: "tavern" }, { kind: "host-archive", id: operation.id, evidence: host }, k.now(),
      { details: { host }, data: { keeperArchiveRequested: true } });
  }
  if (k.member(threadId)?.engagement !== "archived") throw new Error("Cancelled hire is not archived");
  releaseHire(k, token, intent);
  k.store.event(k.now(), intent.owner.keeperThreadId, intent.owner.boardQuestId, "hire.cancelled", "Stopped a hire whose quest ended before it could join", { token, memberThreadId: threadId });
}
export async function recoverHires(
  bb: BbPluginApi,
  k: Keeper,
  keeperId?: string,
  delivered?: (threadId: string) => void,
  beforeArchive?: (threadId: string) => Promise<void>,
) {
  const rows = k.store.db
    .prepare(
      "SELECT id,data FROM tavern_records WHERE kind='hires'" +
        (keeperId ? " AND json_extract(data,'$.owner.keeperThreadId')=?" : "") +
        " ORDER BY rowid LIMIT 200",
    )
    .all(...(keeperId ? [keeperId] : [])) as { id: string; data: string }[];
  for (const row of rows) {
    const intent = JSON.parse(row.data) as HireIntent;
    if (new PlacementStore(k.store.db).byHireToken(row.id)) continue;
    try {
      let found =
        intent.memberThreadId && k.member(intent.memberThreadId)
          ? intent.memberThreadId
          : null;
      if (!found && k.now() - intent.createdAt < LIMITS.hireGraceMs) continue;
      let uncertain = false;
      const seen = new Set<string>();
      if (!found)
        for (const archived of [false, true]) {
          for (let offset = 0; ; offset += 200) {
            if (offset >= 2000)
              throw new Error("Child scan limit reached; reservation retained");
            const children = await loopCall(bb.sdk.threads.list({
              parentThreadId: intent.owner.keeperThreadId,
              originPluginId: bb.pluginId,
              projectId: intent.projectId,
              includeHidden: true,
              archived,
              limit: 200,
              offset,
            }), `hire recovery children ${intent.owner.keeperThreadId}`);
            for (const child of children) {
              if (seen.has(child.id) || child.createdAt < intent.createdAt)
                continue;
              seen.add(child.id);
              const metadata = await loopCall(bb.sdk.threads.getPluginMetadata({
                threadId: child.id,
              }), `hire recovery metadata ${child.id}`);
              const member = k.member(child.id);
              if (
                metadata.hireToken === row.id ||
                (!metadata.hireToken &&
                  metadata.classId === intent.classId &&
                  metadata.characterId === intent.characterId)
              )
                found = child.id;
              else if (!metadata.hireToken && !member && !metadata.classId)
                uncertain = true;
            }
            if (children.length < 200) break;
          }
        }
      if (found) {
        const member = k.bind(
          found,
          intent.classId,
          intent.characterId,
          intent.projectId,
          intent.owner,
          row.id,
        );
        if (intent.classDefinition) k.store.patch(member.threadId, { classDefinition: intent.classDefinition });
        const latest = k.store.get("hires", row.id) ?? intent;
        if (isHireCancelled(k, latest)) {
          await settleCancelledHire(bb, k, row.id, latest, member.threadId, beforeArchive);
          k.changed(intent.owner.keeperThreadId, intent.owner.boardQuestId);
          continue;
        }
        settleStaffing(k, intent.staffing, row.id, member.threadId);
        if (intent.initialInput && intent.scopeResolution && !intent.scopePrepared) {
          k.store.put("hires", row.id, { ...intent, memberThreadId: member.threadId });
          continue;
        }
        if (
          intent.owner.waypointId &&
          intent.owner.boardQuestId &&
          intent.classId !== "warden"
        ) {
          await k.journal.prepare(member.threadId);
          const waypoint = k
            .summary(intent.owner.boardQuestId)
            .plan?.waypoints.find(
              (waypoint) => waypoint.id === intent.owner.waypointId,
            );
          if (waypoint)
            k.journal.linkWaypoint(
              member.threadId,
              {
                boardQuestId: intent.owner.boardQuestId,
                waypointId: waypoint.id,
              },
              waypoint.title,
              member.threadId,
              { kind: "tavern" },
            );
        }
        const current = k.store.get("hires", row.id) ?? intent;
        if (isHireCancelled(k, current)) {
          await settleCancelledHire(bb, k, row.id, current, member.threadId, beforeArchive);
          continue;
        }
        if (intent.initialInput) delivered?.(member.threadId);
        k.store.remove("hires", row.id);
      } else if (!uncertain) {
        releaseHire(k, row.id, intent);
      } else {
        bb.log.warn(
          `Tavern hire ${row.id}: an unidentified child may exist; reservation retained`,
        );
        continue;
      }
      k.store.event(
        k.now(),
        intent.owner.keeperThreadId,
        intent.owner.boardQuestId,
        found ? "hire.recovered" : "hire.expired",
        found
          ? `Recovered hired member ${found}`
          : `Released an expired ${intent.classId} hire reservation after checking its children`,
        { token: row.id, memberThreadId: found },
      );
      k.changed(intent.owner.keeperThreadId, intent.owner.boardQuestId);
    } catch (error) {
      bb.log.warn(`Tavern hire recovery ${row.id}: ${String(error)}`);
    }
  }
}
