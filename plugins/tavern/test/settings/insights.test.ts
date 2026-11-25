import { putMemberFixture } from "../server/member-fixture";
import Sqlite from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InsightCharacters } from "../../src/server/insights/aggregate";
import { InsightsReader } from "../../src/server/insights/index";
import { SettingsStore } from "../../src/server/settings/store";
import { MIGRATIONS } from "../../src/server/migrations";
import { insightsSchema, insightSeriesSchema, type InsightsView } from "../../src/shared/insights";
import type { Database } from "../../src/server/ports";
import { createJournalStore } from "../../src/server/journal/store";
import { makeHost } from "../journal/host";
const databases: Sqlite.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
const DAY = 86400000, HOUR = 3600000;
function fixture() {
  const db = new Sqlite(":memory:"); databases.push(db); db.exec(MIGRATIONS.join(";\n"));
  const now = 1_800_000_000_000;
  const store = new SettingsStore(db as unknown as Database, () => now);
  const characters: { id: string; classIds: string[] }[] = [], serviceRecords: InsightCharacters["serviceRecords"] = [];
  const readCharacters = vi.fn(() => ({ characters, serviceRecords }));
  const reader = new InsightsReader(db as unknown as Database, store, () => now, undefined, readCharacters);
  const put = (kind: string, id: string, data: object) => db.prepare("INSERT INTO tavern_records(kind,id,data) VALUES(?,?,?)").run(kind, id, JSON.stringify(data));
  const quest = (id: string, endedAt = now, archivedAt: number | null = null, duration = 4 * HOUR) => put("quests", id, {
    id, keeperThreadId: "keeper", title: id, short: id, phase: "done", planVersion: 1, greenlitVersion: 1,
    createdAt: endedAt - duration, updatedAt: endedAt, endedAt, archivedAt,
  });
  let id = 0;
  const event = (type: string, at: number, data: object = {}, questId: string | null = null) => db.prepare("INSERT INTO tavern_events(at,keeper_thread_id,board_quest_id,actor,type,text,data) VALUES(?,?,?,?,?,?,?)")
    .run(at, "keeper", questId, '{"kind":"tavern"}', type, `${type} ${++id}`, JSON.stringify(data));
  return { db, now, store, reader, put, quest, event, characters, serviceRecords, readCharacters };
}
function scalar(view: InsightsView, section: "reliability" | "party" | "attention", id: string) {
  const row = view[section].series.find(series => series.id === id)!;
  return "value" in row ? row.value : null;
}

describe("Warden quality", () => {
  it("counts retained journal reopens and verified-to-todo toggles, separates model executions, and keeps waivers out of model counts", async () => {
    const f = fixture();
    const from = f.now - 7 * DAY, at = from + DAY;
    const choice = (id: string, providerId: string, model: string, recordedAt: number) => f.db.prepare("INSERT INTO tavern_runtime(thread_id,data) VALUES(?,?)")
      .run(id, JSON.stringify({ classExecutionChoice: { providerId, model, recordedAt } }));
    choice("checker", "agent-a", "lab/reviewer", from);
    choice("other", "agent-b", "lab/reviewer", from);
    choice("switched", "agent-a", "new-model", at + 1);
    const verdict = (id: string, checker = "checker", verdict = "verified", time = at, extra = {}) =>
      f.put("serviceVerdicts", id, { id, at: time, verdict, questId: "quest", waypointId: "review", entryId: id,
        maker: { threadId: "maker" }, checker: { threadId: checker }, reason: null, checkerEvidence: [], ...extra });
    const host = makeHost(), clock = vi.spyOn(Date, "now");
    const journal = createJournalStore(host.bb, f.db, {
      invalidate: () => {},
      roleOf: thread => thread === "checker" ? { classId: "warden", role: "member", boardQuestId: "quest", waypointId: "w1", checkerEntryReview: () => ({}) }
        : thread === "toggled" ? { classId: "keeper", role: "keeper", boardQuestId: null, waypointId: null } : null,
      reviewed: ({ after }) => {
        if (after.status !== "verified" || !after.review) return;
        verdict(after.threadId, "checker", "verified", after.review.at, { entryId: after.id, waypointId: "w1", maker: { threadId: after.threadId }, checkerEvidence: after.review.evidence });
      },
    });
    const proof = [{ kind: "command" as const, ref: "node check", detail: "Passed", exitCode: 0 }];
    try {
      for (const maker of ["reopened", "toggled", "undone", "new-brief", "earlier-reported", "future-reopen"]) {
        clock.mockReturnValue(at - 1);
        await journal.ready(maker);
        const id = journal.linkWaypoint(maker, { boardQuestId: "quest", waypointId: "w1" }, "Prove it", maker, { kind: "tavern" });
        expect(await journal.runTool(maker, { action: "done", id, evidence: proof })).toMatchObject({ isError: false });
        if (maker === "earlier-reported") {
          expect(await journal.runTool(maker, { action: "reopen", id })).toMatchObject({ isError: false });
          expect(await journal.runTool(maker, { action: "done", id, evidence: proof })).toMatchObject({ isError: false });
        }
        clock.mockReturnValue(at);
        expect(await journal.runTool("checker", { action: "verify", threadId: maker, id, evidence: proof })).toMatchObject({ isError: false });
        clock.mockReturnValue(maker === "future-reopen" ? f.now + 1 : at + 1);
        if (maker === "earlier-reported") continue;
        if (maker === "new-brief") { journal.rebriefed(maker, "quest", 2, ["w1"]); continue; }
        const move = maker === "toggled" ? await journal.runTool(maker, { action: "toggle", id })
          : await journal.runTool("checker", { action: "reopen", threadId: maker, id });
        expect(move.isError, move.text).toBe(false);
        if (maker === "undone") journal.edit(maker, { op: "undo" }, { kind: "agent", threadId: "checker" });
      }
    } finally { clock.mockRestore(); await host.dispose(); }
    verdict("withdrawn", "checker", "verified", at, { withdrawn: true });
    verdict("rejection", "checker", "rejected");
    verdict("same-name", "other", "rejected", from);
    verdict("old-model-unknown", "switched", "verified");
    verdict("past", "checker", "rejected", from - 1);
    verdict("future", "checker", "verified", f.now + 1);
    const wrap = f.db.prepare("INSERT INTO tavern_events(at,keeper_thread_id,board_quest_id,actor,type,text,data) VALUES(?,?,?,?,?,?,?)");
    wrap.run(f.now, "keeper", "quest", '{"kind":"user"}', "quest.wrapped", "Closed early", JSON.stringify({
      cause: "close-early", waivers: [{ state: "rejected" }, { state: "blocked" }],
    }));
    f.event("quest.wrapped", f.now, { cause: "close-early", waivers: [{ state: "rejected" }] }, "not-user");
    const view = await f.reader.view("7d");
    expect(view.wardenQuality).toEqual({
      from, to: f.now, rejectedWaypointsWaived: 1,
      rows: [
        { classId: "warden", providerId: "agent-a", model: "lab/reviewer", verified: 6, reopened: 2, rejected: 1 },
        { classId: "warden", providerId: "agent-b", model: "lab/reviewer", verified: 0, reopened: 0, rejected: 1 },
        { classId: "warden", providerId: null, model: null, verified: 1, reopened: 0, rejected: 0 },
      ],
    });
    expect(insightsSchema.parse(view).wardenQuality).toEqual(view.wardenQuality);
    expect(f.reader.wardenQuality()).toMatchObject({ from: f.now - 30 * DAY, to: f.now });
  });
});

describe("Insights aggregation", () => {
  it("uses contract-checked units and fractional ratios, not display percentages", async () => {
    for (const unit of ["USD", "%", "h", "min", "unknown"]) expect(insightSeriesSchema.safeParse({ id: "bad", label: "Bad", unit, value: 1 }).success).toBe(false);
    expect(insightSeriesSchema.safeParse({ id: "bad", label: "Bad", unit: "ratio", value: 100 }).success).toBe(false);
    expect(insightSeriesSchema.safeParse({ id: "bad", label: "Bad", unit: "ratio", points: [{ x: "test", y: -1 }] }).success).toBe(false);
    const f = fixture(); f.put("routes", "a", { createdAt: f.now - 2000, corrected: true }); f.put("routes", "b", { createdAt: f.now - 1000, corrected: false });
    const view = await f.reader.view("7d");
    expect(view.reliability.series.find(row => row.id === "routing-accuracy")).toMatchObject({ unit: "ratio", value: 0.5 });
    expect(() => insightsSchema.parse(view)).not.toThrow();
  });
  it("buckets reports by UTC day and explains reliability without internal field names", async () => {
    const f = fixture(), date = new Date(f.now), today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    f.event("report.filed", today - HOUR); f.event("report.filed", today - 1); f.event("report.filed", today + 1000);
    const view = await f.reader.view("30d");
    expect(view.reliability.series.find(row => row.id === "reports")).toMatchObject({ label: "Reports per day", unit: "count", points: [
      { x: new Date(today - DAY).toISOString().slice(0, 10), y: 2 }, { x: new Date(today).toISOString().slice(0, 10), y: 1 },
    ] });
    expect(view.reliability.caption).toBe("How often Keepers routed your messages right the first time, and how their memory and ticks held up. Counted from recorded events since Tavern started collecting.");
  });
  it("covers archived quests, 7/30/90-day ranges and numeric headline durations", async () => {
    const f = fixture(); f.quest("recent", f.now, f.now); f.quest("month", f.now - 20 * DAY); f.quest("quarter", f.now - 60 * DAY);
    const seven = await f.reader.view("7d");
    expect(seven.headline.find(row => row.id === "quests-returned")!.value).toBe(1);
    expect(seven.headline.find(row => row.id === "goal-to-return")!).toMatchObject({ value: 4 * 3600, unit: "s" });
    expect((await f.reader.view("30d")).headline[0]!.value).toBe(2);
    expect((await f.reader.view("90d")).headline[0]!.value).toBe(3);
    expect(seven.cost).toBeNull();
    expect(() => insightsSchema.parse(JSON.parse(JSON.stringify(seven, (_key, value) => {
      if (value === undefined) throw new Error("undefined output"); return value;
    })))).not.toThrow();
  });
  it("uses recorded verdict order, not current status, for first-pass verification", async () => {
    const f = fixture(); f.quest("q1");
    f.event("waypoint.reviewed", f.now - 3000, { waypointId: "w1", planVersion: 1, verdict: "rejected" }, "q1");
    f.event("waypoint.reviewed", f.now - 2000, { waypointId: "w1", planVersion: 1, verdict: "verified" }, "q1");
    f.event("waypoint.reviewed", f.now - 1000, { waypointId: "w2", planVersion: 1, verdict: "verified" }, "q1");
    const view = await f.reader.view("7d");
    expect(view.headline.find(row => row.id === "first-pass")!).toMatchObject({ value: 0.5, unit: "ratio" });
    expect(scalar(view, "party", "warden-rejections")).toBe(1);
  });
  it("does not turn an old rejection into first-pass success at the range boundary", async () => {
    const f = fixture(); f.quest("q1", f.now, null, 10 * DAY);
    f.event("waypoint.reviewed", f.now - 8 * DAY, { waypointId: "w1", planVersion: 1, verdict: "rejected" }, "q1");
    f.event("waypoint.reviewed", f.now - DAY, { waypointId: "w1", planVersion: 1, verdict: "verified" }, "q1");
    expect((await f.reader.view("7d")).headline.find(row => row.id === "first-pass")!.value).toBe(0);
  });
  it("counts reliability outcomes and memory facts without inventing missing data", async () => {
    const f = fixture();
    f.reader.record("tick.held", { reason: "typing" }, "keeper", null, "one");
    f.reader.record("tick.held", { reason: "typing" }, "keeper", null, "one");
    f.event("tick.sent", f.now - 5000); f.event("tick.deferred", f.now - 4000);
    f.event("facts.clipped", f.now - 3000); f.event("turn.interrupted", f.now - 2000);
    f.event("note.recorded", f.now - 1000, { kind: "fact" });
    const view = await f.reader.view("7d");
    expect(scalar(view, "reliability", "ticks-held")).toBe(1);
    expect(scalar(view, "reliability", "ticks-sent")).toBe(1);
    expect(scalar(view, "reliability", "ticks-deferred")).toBe(1);
    expect(scalar(view, "reliability", "facts-clipped")).toBe(1);
    expect(scalar(view, "reliability", "facts-recorded")).toBe(1);
    expect(view.headline.find(row => row.id === "ask-wait")!.value).toBeNull();
    expect(scalar(view, "reliability", "routing-accuracy")).toBeNull();
  });
  it("calculates phase intervals from transitions and does not double-count outside gates", async () => {
    const f = fixture(); f.quest("q1");
    f.event("quest.opened", f.now - 4 * HOUR, { phase: { from: null, to: "scout" } }, "q1");
    f.event("plan.proposed", f.now - 3 * HOUR, { phase: { from: "scout", to: "greenlight" } }, "q1");
    f.event("ask.answered", f.now - 2 * HOUR, { phase: { from: "greenlight", to: "build" } }, "q1");
    f.event("ask.opened", f.now - HOUR, { phase: { from: "build", to: "closing" } }, "q1");
    f.put("gates", "gate", { boardQuestId: "q1", waypointId: "w1", keeperThreadId: "keeper", planVersion: 1,
      askedWho: "Team", via: "ticket", askedAt: f.now - 2 * HOUR, answer: "Ready", answeredAt: f.now - HOUR });
    const phases = (await f.reader.view("7d")).phases.series;
    const get = (id: string) => { const row = phases.find(row => row.id === id)!; return "value" in row ? row.value : null; };
    expect(get("scout")).toBe(3600); expect(get("greenlight")).toBe(3600);
    expect(get("build")).toBe(0); expect(get("closing")).toBe(3600); expect(get("outside")).toBe(3600);
  });
  it("labels old phase time as not recorded rather than inferring scout or build", async () => {
    const f = fixture(); f.quest("q1");
    f.event("quest.phase", f.now - HOUR, { phase: "build" }, "q1");
    const phases = (await f.reader.view("7d")).phases.series;
    expect(phases.find(row => row.id === "unrecorded")).toMatchObject({ label: "Phases not recorded", value: 4 * 3600 });
    expect(phases.find(row => row.id === "scout")).toMatchObject({ value: 0 });
    expect(phases.find(row => row.id === "build")).toMatchObject({ value: 0 });
  });
  it("shows a Warden with nine independent checks at level two, not a level from member wins", async () => {
    const f = fixture();
    f.characters.push({ id: "vex", classIds: ["warden", "smith"] });
    f.serviceRecords.push({ characterId: "vex", warden: { checks: 20, independentChecks: 9, sameFamilyChecks: 11, caughtDefects: 2, caughtSince: null }, maker: { verifiedWaypoints: 80, quests: 10 } });
    f.put("members", "old", { characterId: "vex", classId: "smith", verifiedWins: 800 });
    for (const range of ["7d", "90d"] as const) expect((await f.reader.view(range)).party.series.find(row => row.id === "character-levels")).toEqual({ id: "character-levels", label: "Character levels", unit: "level", points: [{ x: "vex", y: 2 }] });
  });
  it("uses each character's first class and keeps missing or zero progress null", async () => {
    const f = fixture();
    f.characters.push({ id: "juno", classIds: ["smith", "warden"] }, { id: "wren", classIds: ["keeper"] }, { id: "new", classIds: ["warden"] }, { id: "empty", classIds: [] }, { id: "zero", classIds: ["warden"] });
    f.serviceRecords.push({ characterId: "juno", maker: { verifiedWaypoints: 1, quests: 1 }, warden: { checks: 80, independentChecks: 80, sameFamilyChecks: 0, caughtDefects: 0, caughtSince: null } },
      { characterId: "wren", keeper: { returnedQuests: 100, verifiedReturns: 8, stoppedQuests: 4, verifiedWaypoints: 90 } },
      { characterId: "empty", maker: { verifiedWaypoints: 8, quests: 1 } },
      { characterId: "zero", warden: { checks: 11, independentChecks: 0, sameFamilyChecks: 11, caughtDefects: 0, caughtSince: null } },
      { characterId: "deleted-character", maker: { verifiedWaypoints: 80, quests: 1 } });
    expect((await f.reader.view("30d")).party.series.find(row => row.id === "character-levels")).toMatchObject({ points: [{ x: "juno", y: 1 }, { x: "wren", y: 2 }, { x: "new", y: null }, { x: "empty", y: null }, { x: "zero", y: null }] });
  });
  it("reads character progress only for the user-facing view, never for tuner signals", async () => {
    const f = fixture(); f.reader.signals(); expect(f.readCharacters).not.toHaveBeenCalled();
    await f.reader.view("7d"); expect(f.readCharacters).toHaveBeenCalledTimes(1);
    f.reader.signals(); expect(f.readCharacters).toHaveBeenCalledTimes(1);
  });
  it("uses per-class report intervals and recorded clipping for tuner signals", () => {
    const f = fixture();
    f.put("members", "smith", { classId: "smith", role: "member", threadId: "smith", createdAt: f.now - DAY });
    for (let index = 0; index < 21; index++) f.put("reports", String(index), { memberThreadId: "smith", createdAt: f.now - (21 - index) * 3600000 });
    f.reader.record("restatement.measured", { bytes: 22000, clipped: true });
    f.reader.record("facts.measured", { chars: 18000, clipped: true });
    const signals = f.reader.signals();
    expect(signals.reportIntervals).toHaveLength(20);
    expect(signals.reportIntervals[0]).toEqual({ classId: "smith", seconds: 3600 });
    expect(signals.restatementBytes).toEqual([22000]); expect(signals.factsClipped).toBe(1);
  });
});
