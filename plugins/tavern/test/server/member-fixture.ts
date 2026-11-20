import type { Keeper } from "../../src/server/keeper/service";
import type { KeeperStore, Runtime, PendingBrief } from "../../src/server/keeper/store";
import { archiveDisposition, memberDetails, memberHost, transitionMember } from "../../src/server/member-engagement";
import type { Engagement } from "../../src/shared/member-engagement";
import type { Member } from "../../src/shared/schema";

type LegacyBits = {
  pendingBrief?: PendingBrief | null; released?: { reason: string; decisionId: string; at?: number };
  releasePending?: string | null; restSince?: number | null; restReminderFor?: number | null;
  kept?: { until: number; why: string; decisionId: string } | null;
  stopAttempts?: number; stopNextAttemptAt?: number; stopAskId?: string | null;
  placementModelFailureRelease?: string | null;
};

type MemberFixture = Omit<Partial<Member>, "state"> & { state?: Member["state"] | "done" | "stopped"; stopPending?: boolean; place?: string };

export function putMemberFixture(store: KeeperStore, id: string, update: MemberFixture) {
  const { state, stopPending, place: _place, ...fields } = update;
  const record = { ...store.get("members", id), ...fields } as Member;
  if (!record.threadId) throw new Error("A fixture member needs a thread id");
  if (state === "done") record.engagement = "resting";
  if (state === "stopped" && record.role !== "keeper") record.engagement = "stopped";
  if (stopPending) record.engagement = "stopping";
  record.state = state === "done" || state === "stopped" ? "idle" : state ?? record.state;
  if (record.role !== "keeper") record.engagement ??= "active";
  store.db.prepare("INSERT INTO tavern_records(kind,id,data) VALUES('members',?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data").run(id, JSON.stringify(record));
  const details = memberDetails(store, id);
  if (record.engagement === "resting") store.patch(id, { memberEngagement: { ...details, rest: details.rest ?? { since: record.lastReportAt ?? record.createdAt } } });
  if (record.engagement === "stopping" && !details.operation) {
    const operation = { id: `fixture:${id}`, reason: "Fixture stop", receipt: { kind: "migration", id: `fixture:${id}` }, attempts: 0 };
    store.patch(id, { memberEngagement: { ...details, operation } });
  }
  return record;
}

export function fixtureActivity(k: Keeper, id: string, state: MemberFixture["state"], at = k.now()) {
  const current = k.member(id);
  if (state === "done" && current?.role === "member" && current.engagement === "active") {
    const notify = k.store.onEvent;
    k.store.onEvent = undefined;
    try {
      k.store.atomic(() => {
        const reportId = k.store.id("report");
        k.store.put("reports", reportId, {
          id: reportId, memberThreadId: id, keeperThreadId: current.keeperThreadId, boardQuestId: current.boardQuestId,
          waypointId: current.waypointId, status: "done", outcome: "Fixture work complete", evidence: [], artifacts: [],
          confidence: null, voice: null, createdAt: at, deliveredAt: null,
        });
        const resting = transitionMember(k.store, current, "resting", "done-report", { kind: "agent", threadId: id },
          { kind: "report", id: reportId }, at, { data: { reportId, status: "done" }, patch: { state: "idle" } });
        k.store.put("members", id, { ...resting, lastActiveAt: at });
      });
    } finally { k.store.onEvent = notify; }
  } else if (state === "done" || state === "stopped") {
    putMemberFixture(k.store, id, { state, ...(state === "done" ? { lastActiveAt: at } : {}) });
    if (state === "done") patchThreadFixture(k.store, id, { restSince: at });
  } else if (state) k.activity(id, state, at);
}

export function patchThreadFixture(store: KeeperStore, id: string, update: Partial<Runtime> & LegacyBits) {
  const { pendingBrief, releasePending, released, restSince, restReminderFor, kept, stopAttempts, stopNextAttemptAt, stopAskId, placementModelFailureRelease,
    archivePending, archiveError, archivedAt, deletedAt, cellarArchived, cellarArchiveRequested, ...rest } = update;
  const member = store.get("members", id);
  if (!member || member.role === "keeper") return store.patch(id, update as Partial<Runtime>);
  const details = { ...memberDetails(store, id) };
  let engagement: Engagement = member.engagement ?? "active";
  const op = () => details.operation ?? { id: `fixture:${id}`, reason: "Fixture cleanup", receipt: { kind: "migration", id: `fixture:${id}` } };
  if (pendingBrief !== undefined) {
    details.delivery = pendingBrief;
    if (pendingBrief && engagement === "resting") engagement = "briefing";
  }
  if (restSince !== undefined || restReminderFor !== undefined || kept !== undefined)
    details.rest = { since: restSince ?? details.rest?.since ?? member.createdAt, reminded: restReminderFor === undefined ? details.rest?.reminded : restReminderFor !== null, keep: kept === undefined ? details.rest?.keep : kept };
  if (released) {
    details.release = released;
    if (engagement === "archived" || engagement === "archiving") details.archive = { disposition: "released", resumeTo: "released" };
    else engagement = "released";
  }
  if (releasePending) { engagement = "releasing"; details.operation = { ...op(), reason: releasePending, skipStopIfQuiet: true }; }
  if (placementModelFailureRelease) { engagement = "releasing"; details.operation = { ...op(), reason: placementModelFailureRelease, modelFailure: true }; }
  if (archivePending === true) {
    const archive = archiveDisposition({ ...member, engagement });
    if (engagement === "releasing" || engagement === "stopping")
      details.archiveAfter = { reason: "Fixture archive", receipt: { kind: "archive-authority", id: `fixture-archive:${id}` }, archive };
    else { details.archive = archive; engagement = "archiving"; details.operation = op(); }
  }
  if (archivePending === false && engagement === "archiving") { engagement = details.archive?.resumeTo ?? "active"; details.operation = null; }
  if (archiveError !== undefined || stopAttempts !== undefined || stopNextAttemptAt !== undefined || stopAskId !== undefined)
    details.operation = { ...op(), ...(archiveError === undefined ? {} : { error: archiveError }), ...(stopAttempts === undefined ? {} : { attempts: stopAttempts }),
      ...(stopNextAttemptAt === undefined ? {} : { nextAttemptAt: stopNextAttemptAt }), ...(stopAskId === undefined ? {} : { askId: stopAskId }) };
  if (archivedAt !== undefined || deletedAt !== undefined) {
    const host = memberHost(store, member);
    details.host = { archivedAt: archivedAt === undefined ? host.archivedAt : archivedAt, deletedAt: deletedAt === undefined ? host.deletedAt : deletedAt };
    if (details.host.archivedAt !== null || details.host.deletedAt !== null) {
      details.archive = archiveDisposition({ ...member, engagement });
      engagement = "archived";
    } else if (engagement === "archived") engagement = details.archive?.resumeTo ?? "active";
  }
  const disposition = engagement === "archived" || engagement === "archiving" ? details.archive?.disposition : engagement === "released" || engagement === "stopped" ? engagement : undefined;
  putMemberFixture(store, id, { engagement, disposition });
  return store.patch(id, { ...rest, memberEngagement: details });
}

export function runtimeFixture(store: KeeperStore, id: string) {
  const runtime = store.runtime(id), member = store.get("members", id);
  if (!member || member.role === "keeper") return { ...runtime, ...({} as LegacyBits) };
  const details = memberDetails(store, id);
  return { ...runtime, ...memberHost(store, member),
    pendingBrief: details.delivery, released: details.release ?? undefined, releasePending: member.engagement === "releasing" ? details.operation?.reason ?? null : null,
    archivePending: member.engagement === "archiving" || details.archiveAfter != null, archiveError: details.operation?.error ?? null,
    restSince: details.rest?.since ?? null, restReminderFor: details.rest?.reminded ? details.rest.since : null, kept: details.rest?.keep ?? null,
    stopAttempts: details.operation?.attempts, stopNextAttemptAt: details.operation?.nextAttemptAt, stopAskId: details.operation?.askId,
    placementModelFailureRelease: details.operation?.modelFailure ? details.operation.reason : undefined };
}

export function withMemberFixtures(k: Keeper): Keeper {
  const bind = k.bind.bind(k);
  k.bind = (threadId, classId, characterId, projectId, owner, receipt) => {
    if (receipt || !owner && classId === "keeper" || k.member(threadId)) return bind(threadId, classId, characterId, projectId, owner, receipt);
    const token = `fixture:${threadId}`;
    if (owner) k.store.put("hires", token, { classId, characterId, projectId, createdAt: k.now(), owner, memberThreadId: threadId });
    try {
      const member = bind(threadId, classId, characterId, projectId, owner, token);
      return owner ? transitionMember(k.store, member, "active", "brief-accepted", { kind: "tavern" }, { kind: "brief-acceptance", id: token }, k.now()) : member;
    } finally { if (owner) k.store.remove("hires", token); }
  };
  return k;
}
