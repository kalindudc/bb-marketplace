import type { Member } from "../shared/schema";
import type { KeeperStore, Runtime } from "./keeper/store";
import { transitionMember, type Archive, type EngagementReceipt, type MemberEngagementData } from "./member-engagement";
import type { Engagement } from "../shared/member-engagement";

export type LegacyMember = Omit<Member, "state"> & { state: Member["state"] | "done" | "stopped"; stopPending?: boolean };
const retiredFields = ["releasePending", "released", "archivePending", "cellarArchiveRequested", "cellarArchived", "archiveError", "archivedAt", "deletedAt", "pendingBrief", "restSince", "restReminderFor", "kept", "stopAttempts", "stopNextAttemptAt", "stopAskId", "placementModelFailureRelease"] as const;

type LegacyRuntime = Runtime & {
  archivedAt?: number | null; deletedAt?: number | null;
  releasePending?: string | null; released?: { reason: string; decisionId: string; at?: number };
  archivePending?: boolean; cellarArchiveRequested?: boolean; cellarArchived?: boolean; archiveError?: string | null;
  pendingBrief?: import("./keeper/store").PendingBrief | null; restSince?: number | null; restReminderFor?: number | null;
  kept?: { until: number; why: string; decisionId: string } | null;
  stopAttempts?: number; stopNextAttemptAt?: number; stopAskId?: string | null; placementModelFailureRelease?: string | null;
};

function derive(store: KeeperStore, member: LegacyMember, r: LegacyRuntime, at: number): { state: Engagement; details: MemberEngagementData } {
  const fail = () => { throw new Error(`Member ${member.threadId} has an invalid legacy engagement record`); };
  if (!["done", "stopped", "working", "idle", "waiting", "failed"].includes(member.state)) fail();
  if (r.released !== undefined && (typeof r.released?.reason !== "string" || typeof r.released.decisionId !== "string")) fail();
  if (r.releasePending != null && (typeof r.releasePending !== "string" || !r.releasePending.trim())) fail();
  if (r.pendingBrief != null && (typeof r.pendingBrief.id !== "string" || typeof r.pendingBrief.text !== "string")) fail();
  for (const flag of [member.stopPending, r.archivePending, r.cellarArchiveRequested, r.cellarArchived]) if (flag != null && typeof flag !== "boolean") fail();
  const gone = r.archivedAt != null || r.deletedAt != null;
  const neverBriefed = r.initialBriefAt == null && r.lastBriefAt == null;
  const hire = store.hireForMember(member.threadId);
  const planned = (r.pendingBrief != null && (member.state === "done" || neverBriefed)) || (hire !== null && neverBriefed);
  const resumeTo = r.released ? "released" : member.state === "done" ? "resting" : member.state === "stopped" ? "stopped" : planned ? "briefing" : "active";
  const archive: Archive = { resumeTo, disposition: resumeTo === "resting" ? "finished" : resumeTo === "released" || resumeTo === "stopped" ? resumeTo : "retired unfinished" };
  const state = r.released && gone ? "archived" : r.released && !r.archivePending ? "released" :
    member.stopPending ? "stopping" : r.releasePending && !r.released ? "releasing" : r.archivePending ? "archiving" : gone ? "archived" : resumeTo === "resting" && planned ? "briefing" : resumeTo;
  const details: MemberEngagementData = {};
  if (member.state === "done") details.rest = { since: r.restSince ?? at, reminded: r.restReminderFor != null && r.restReminderFor === r.restSince, keep: r.kept };
  if (gone) details.host = { archivedAt: r.archivedAt ?? r.deletedAt ?? null, deletedAt: r.deletedAt ?? null };
  if (r.released) {
    const prior = store.db.prepare("SELECT at FROM tavern_events WHERE type='member.released' AND json_extract(data,'$.memberThreadId')=? AND json_extract(data,'$.decisionId')=? ORDER BY id DESC LIMIT 1").get(member.threadId, r.released.decisionId) as { at: number } | undefined;
    details.release = { ...r.released, at: r.released.at ?? prior?.at };
  }
  if (state === "archived" || state === "archiving") details.archive = archive;
  if (r.pendingBrief && (state === "briefing" || state === "active")) details.delivery = r.pendingBrief;
  if (state === "releasing" || state === "stopping" || state === "archiving") {
    const receipt: EngagementReceipt = { kind: "migration", id: `legacy:${member.threadId}:${state}`, evidence: { questId: member.boardQuestId, cancelledHire: hire?.id ?? null } };
    details.operation = { id: receipt.id, receipt, reason: r.releasePending ?? (state === "archiving" ? "Legacy archive request" : "Legacy stop request"), error: member.stopError ?? r.archiveError,
      attempts: r.stopAttempts, nextAttemptAt: r.stopNextAttemptAt, askId: r.stopAskId, skipStopIfQuiet: state === "releasing",
      placementRequired: r.placementExecution != null || r.placementModelFailureRelease != null,
      modelFailure: r.placementModelFailureRelease != null };
    if (r.archivePending && state !== "archiving") details.archiveAfter = { receipt: { kind: "archive-authority", id: receipt.id, evidence: { cause: "legacy-archive" } }, reason: "Legacy archive request", archive };
  }
  return { state, details };
}

export function migrateMemberEngagement(store: KeeperStore, at: number): number {
  return store.atomic(() => {
    let converted = 0;
    const strip = store.db.prepare(`UPDATE tavern_runtime SET data=json_remove(data,${retiredFields.map(() => "?").join(",")}) WHERE thread_id=?`);
    for (const member of store.all("members") as LegacyMember[]) {
      if (member.engagement !== undefined) continue;
      const state = member.state === "done" || member.state === "stopped" ? "idle" : member.state;
      if (member.role === "keeper") {
        if (state !== member.state) store.put("members", member.threadId, { ...member, state });
        continue;
      }
      const next = derive(store, member, store.runtime(member.threadId), at);
      transitionMember(store, member as Member, next.state, "legacy-import", { kind: "tavern" }, { kind: "migration", id: "member-engagement-v1" }, at,
        { details: next.details, patch: { state }, data: { legacyActivity: member.state }, text: "Imported member engagement from the existing record" });
      strip.run(...retiredFields.map(field => `$.${field}`), member.threadId);
      converted++;
    }
    return converted;
  });
}
