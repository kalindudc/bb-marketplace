// @vitest-environment node
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { KeeperStore } from "../../src/server/keeper/store";
import { MIGRATIONS } from "../../src/server/migrations";
import { isLiveMember, liveMemberSql } from "../../src/server/liveness";
import { transitionMember } from "../../src/server/member-engagement";
import { migrateMemberEngagement } from "../../src/server/member-engagement-migration";
import type { Actor, Member } from "../../src/shared/schema";

const now = 100;
const tavern = { kind: "tavern" } as const;
const keeper = { kind: "agent", threadId: "keeper" } as const;
const user = { kind: "user" } as const;
function setup() {
  const db = new Database(":memory:");
  db.exec(MIGRATIONS.join(";\n"));
  const store = new KeeperStore(db);
  const member: Member = { threadId: "member", classId: "smith", characterId: null, role: "member", keeperThreadId: "keeper", boardQuestId: null, waypointId: null, errand: true, title: null, state: "idle", doing: null, createdAt: 1, lastActiveAt: null, lastReportAt: null, strikes: 0, verifiedWins: 0 };
  return { store, member };
}
function event(store: KeeperStore) {
  return store.db.prepare("SELECT type,actor,data FROM tavern_events ORDER BY id DESC LIMIT 1").get() as { type: string; actor: string; data: string };
}

it("fences member engagement writes and records one event with cause and authority", () => {
  const { store, member } = setup();
  try {
    expect(() => store.put("members", member.threadId, { ...member, engagement: "active" })).toThrow(/engagement/);
    const receipt = { kind: "hire", id: "reservation" } as const;
    store.db.prepare("INSERT INTO tavern_records(kind,id,data) VALUES('hires',?,?)").run(receipt.id, JSON.stringify({ classId: member.classId, owner: { keeperThreadId: member.keeperThreadId, boardQuestId: member.boardQuestId } }));
    const next = transitionMember(store, member, "briefing", "bind-hire", keeper, receipt, now);
    expect(next.engagement).toBe("briefing");
    expect(JSON.parse(event(store).data)).toMatchObject({ memberThreadId: member.threadId, engagement: { from: null, to: "briefing" }, cause: "bind-hire", receipt });
    expect(JSON.parse(event(store).actor)).toEqual(keeper);
    expect(() => store.put("members", member.threadId, { ...next, engagement: "stopped" })).toThrow(/engagement/);
    expect(store.events("keeper")).toHaveLength(1);
  } finally { store.db.close(); }
});

it.each([
  ["active", "resting", "done-report", { kind: "agent", threadId: "other" }, "report"],
  ["resting", "briefing", "rebrief", tavern, "brief"],
  ["stopping", "released", "release-confirmed", tavern, "host-stop"],
  ["archiving", "archived", "archive-confirmed", user, "host-archive"],
  ["released", "active", "brief-accepted", tavern, "brief-acceptance"],
  ["active", "stopping", "quest-stop", user, "quest-stop"],
  ["active", "stopping", "hire-cancelled", tavern, "cancelled-hire"],
  ["active", "releasing", "release-answered", user, "ask-answer"],
  ["active", "releasing", "greenlight-undone", user, "undo"],
  ["active", "releasing", "model-failure", tavern, "host-failure"],
  ["active", "archiving", "archive-requested", tavern, "archive-authority"],
  ["active", "archived", "host-archived", tavern, "host-archive"],
  ["active", "archived", "host-deleted", tavern, "host-delete"],
] as const)("refuses unauthorized %s to %s caused by %s", (from, to, cause, actor, kind) => {
  const { store, member } = setup();
  try {
    store.db.prepare("INSERT INTO tavern_records(kind,id,data) VALUES('members',?,?)").run(member.threadId, JSON.stringify({ ...member, engagement: from }));
    const receipt = { kind, id: "receipt", evidence: { cause: "errand-report" } };
    expect(() => transitionMember(store, member, to, cause, actor as Actor, receipt, now,
      { details: { operation: { id: "op", reason: "Cleanup", receipt }, archive: { disposition: "retired unfinished", resumeTo: "active" } } })).toThrow(/engagement/i);
    expect(store.get("members", member.threadId)?.engagement).toBe(from);
    expect(store.events("keeper")).toHaveLength(0);
  } finally { store.db.close(); }
});

it("preserves the fixed archive resume state and does not treat archiving as live", () => {
  const { store, member } = setup();
  try {
    const put = (engagement: string) => store.db.prepare("INSERT INTO tavern_records(kind,id,data) VALUES('members',?,?)").run(member.threadId, JSON.stringify({ ...member, engagement }));
    put("resting");
    store.put("reports", "done-report", { id: "done-report", memberThreadId: member.threadId, keeperThreadId: member.keeperThreadId, boardQuestId: null, waypointId: null, status: "done", outcome: "Done", evidence: [], artifacts: [], confidence: null, voice: null, deliveredAt: null, createdAt: now });
    const receipt = { kind: "archive-authority", id: "done-report", evidence: { cause: "errand-report" } };
    transitionMember(store, member, "archiving", "archive-requested", tavern, receipt, now,
      { details: { operation: { id: "cleanup", reason: "Done errand", receipt }, archive: { disposition: "finished", resumeTo: "resting" } } });
    expect(isLiveMember(store, store.get("members", member.threadId), "occupy")).toBe(false);
    transitionMember(store, member, "archived", "archive-confirmed", tavern, { kind: "host-archive", id: "cleanup" }, now, { details: { host: { archivedAt: now, deletedAt: null } } });
    expect(() => transitionMember(store, member, "active", "unarchived", tavern, { kind: "host-unarchive", id: member.threadId }, now)).toThrow(/engagement/i);
    transitionMember(store, member, "resting", "unarchived", tavern, { kind: "host-unarchive", id: member.threadId }, now);
    expect(store.events("keeper").map(e => e.data.engagement)).toHaveLength(3);
  } finally { store.db.close(); }
});

it("rolls back both engagement and its details if the event cannot be written", () => {
  const { store, member } = setup();
  try {
    store.db.prepare("INSERT INTO tavern_records(kind,id,data) VALUES('members',?,?)").run(member.threadId, JSON.stringify({ ...member, engagement: "active" }));
    store.db.exec("CREATE TRIGGER refuse_engagement_event BEFORE INSERT ON tavern_events BEGIN SELECT RAISE(ABORT, 'event write refused'); END");
    expect(() => transitionMember(store, member, "archived", "host-archived", tavern, { kind: "host-archive", id: `${member.threadId}:${now}` }, now,
      { details: { host: { archivedAt: now, deletedAt: null }, archive: { disposition: "retired unfinished", resumeTo: "active" } } })).toThrow("event write refused");
    expect(store.get("members", member.threadId)?.engagement).toBe("active");
    expect(store.runtime(member.threadId).memberEngagement).toBeUndefined();
    expect(store.events("keeper")).toHaveLength(0);
  } finally { store.db.close(); }
});

it.each(["work", "brief", "occupy"] as const)("keeps legacy live-copy parity for %s, in TypeScript and SQL", purpose => {
  const { store, member } = setup();
  try {
    const signatures = [
      ["rested", "done", { initialBriefAt: 2, restSince: 3 }, true],
      ["reminded", "done", { initialBriefAt: 2, restSince: 3, restReminderFor: 3 }, true],
      ["archived older finish", "done", { archivedAt: 4, restSince: 3 }, false],
      ["archived finish", "done", { archivedAt: 4, initialBriefAt: 2, restSince: 3 }, false],
      ["cellared finish", "done", { archivedAt: 4, initialBriefAt: 2, restSince: 3, cellarArchived: true, cellarArchiveRequested: true }, false],
      ["archived after stop", "stopped", { archivedAt: 4, initialBriefAt: 2 }, false],
      ["archived after release", "stopped", { archivedAt: 4, initialBriefAt: 2, released: { reason: "Done", decisionId: "d" } }, false],
      ["released", "stopped", { initialBriefAt: 2, released: { reason: "Done", decisionId: "d" } }, false],
    ] as const;
    for (const [id, state, rt] of signatures) {
      store.db.prepare("INSERT INTO tavern_records(kind,id,data) VALUES('members',?,?)").run(id, JSON.stringify({ ...member, threadId: id, state }));
      store.db.prepare("INSERT INTO tavern_runtime(thread_id,data) VALUES(?,?)").run(id, JSON.stringify(rt));
    }
    expect(migrateMemberEngagement(store, now)).toBe(signatures.length);
    const read = store.db.prepare(`SELECT 1 FROM tavern_records m WHERE m.id=? AND m.kind='members' AND ${liveMemberSql(purpose)}`);
    for (const [id, , , briefable] of signatures) {
      const before = purpose === "brief" && briefable;
      expect(isLiveMember(store, store.get("members", id), purpose), id).toBe(before);
      expect(!!read.get(id), id).toBe(before);
    }
  } finally { store.db.close(); }
});

it("migrates old archived release, rest, stop and in-flight shapes once", () => {
  const { store, member } = setup();
  try {
    const rows = [
      ["archived-release", "stopped", { released: { reason: "Replaced", decisionId: "decision" }, archivedAt: 1 }, "archived", "released"],
      ["archived-done", "done", { archivedAt: 1 }, "archived", "resting"],
      ["archived-stop", "stopped", { archivedAt: 1 }, "archived", "stopped"],
      ["rest", "done", { restSince: 5 }, "resting", null],
      ["archiving", "done", { archivePending: true }, "archiving", "resting"],
      ["releasing", "idle", { releasePending: "Replaced" }, "releasing", null],
      ["failed", "failed", {}, "active", null],
    ] as const;
    for (const [id, state, runtime] of rows) {
      store.db.prepare("INSERT INTO tavern_records(kind,id,data) VALUES('members',?,?)").run(id, JSON.stringify({ ...member, threadId: id, state }));
      store.db.prepare("INSERT INTO tavern_runtime(thread_id,data) VALUES(?,?)").run(id, JSON.stringify(runtime));
    }
    expect(migrateMemberEngagement(store, now)).toBe(rows.length);
    for (const [id, , , expected, resumeTo] of rows) {
      expect(store.get("members", id)?.engagement).toBe(expected);
      expect(store.runtime(id).memberEngagement?.archive?.resumeTo ?? null).toBe(resumeTo);
    }
    expect(migrateMemberEngagement(store, now + 1)).toBe(0);
    expect(store.events("keeper")).toHaveLength(rows.length);
  } finally { store.db.close(); }
});
