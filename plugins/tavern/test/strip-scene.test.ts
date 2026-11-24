import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { KEEPER_MIGRATIONS } from "../src/server/keeper/migrations";
import { KeeperStore } from "../src/server/keeper/store";
import { committedStripPhase, committedStripReview, stripScene } from "../src/server/strip-scene";
import type { JournalEntry } from "../src/shared/schema";

const member = { classId: "smith", role: "member", state: "idle", engagement: "active" } as const;
const quest = { id: "quest-a", phase: "build", planVersion: 3, greenlitVersion: 3, archivedAt: null } as const;
const assignment = { revision: "brief-a", at: 30 };
const base = { member, quest, assignment, assigned: true };

describe("thread workbench", () => {
  it("puts the active route and only recorded earlier work on the Keeper's road", () => {
    const current = { ...quest, title: "Restore the lanterns" };
    const keeper = { ...member, role: "keeper", classId: "keeper" } as const;
    const route = { kind: "steer", boardQuestId: quest.id, boardQuestIds: [quest.id] } as const;
    const waypoints = [
      { id: "w1", title: "Read the log", kind: "read", state: "done" },
      { id: "w2", title: "Replace the shutters", kind: "make", state: "doing" },
      { id: "w3", title: "Refit the frame", kind: "make", state: "planned" },
    ] as const;
    const input = { member: keeper, quest: current, route, waypoints };
    expect(stripScene(input).road).toMatchObject({ title: current.title, current: "w2", places: [
      { kind: "plan", state: "done" }, { id: "w1", kind: "read", state: "done", waypoint: "Read the log" },
      { id: "w2", kind: "make", state: "active", waypoint: "Replace the shutters" },
    ] });
    expect(stripScene({ ...input, route: { ...route, kind: "aside" } }).road).toBeUndefined();
    expect(stripScene({ ...input, held: true }).road?.places.at(-1)?.state).toBe("held");
  });

  it("omits the optional road title when an errand has no quest", () => {
    const { road } = stripScene({ member, assignment, assigned: true });
    expect(road?.places).toMatchObject([{ id: "work", kind: "make" }]);
    expect(road).not.toHaveProperty("title");
  });

  it("holds a blocked maker at the forge instead of turning its report into a passed stop", () => {
    const result = stripScene({ ...base, waypointId: "w1",
      waypoints: [{ id: "w1", title: "Replace the beam", kind: "make", state: "blocked" }],
      report: { status: "blocked", createdAt: 40 },
    });
    expect(result.moment).toBe("report");
    expect(result.road?.places.at(-1)).toMatchObject({ id: "w1", kind: "make", state: "held" });
    expect(result.road?.places).toHaveLength(2);
  });

  it("keeps a Warden at the gate during its check and seals only a recorded verification", () => {
    const input = { ...base, member: { ...member, classId: "warden" }, waypointId: "w1",
      waypoints: [{ id: "w1", title: "Check the hinges", kind: "make", state: "reported" }] } as const;
    expect(stripScene(input).road?.places.at(-1)).toMatchObject({ kind: "review", state: "active", waypoint: "Check the hinges" });
    const cleared = stripScene({ ...input, verdict: { status: "verified", at: 42 } }).road!;
    expect(cleared.places.map(place => place.kind)).toEqual(["plan", "make", "review", "seal"]);
    expect(cleared.current).toBe("seal");
    expect(stripScene({ ...input, gone: true }).road).toBeUndefined();
  });
  it("does not infer a Keeper's current quest from an aside or ambiguous route", () => {
    const keeper = { classId: "keeper", role: "keeper", state: "working", engagement: "active" } as const;
    const planning = { ...quest, phase: "scout" } as const;
    const route = { kind: "steer", boardQuestId: quest.id, boardQuestIds: [quest.id] } as const;
    expect(stripScene({ member: keeper, quest: planning }).road).toBeUndefined();
    expect(stripScene({ member: keeper, quest: planning, route: { ...route, kind: "aside" } }).road).toBeUndefined();
    expect(stripScene({ member: keeper, quest: planning, route: { ...route, boardQuestIds: [quest.id, "quest-b"] } }).road).toBeUndefined();
    expect(stripScene({ member: keeper, quest: planning, route }).road?.places[0]?.kind).toBe("plan");
  });

  it("recognizes only current committed quest transitions, not the event name or phase alone", () => {
    const keeper = { classId: "keeper", role: "keeper", state: "idle", engagement: "active" } as const;
    const route = { kind: "steer", boardQuestId: quest.id, boardQuestIds: [] } as const;
    const commit = { revision: "phase-34", at: 34, from: "greenlight", to: "build" };
    expect(stripScene({ member: keeper, quest, route }).moment).toBe("none");
    expect(stripScene({ member: keeper, quest: { ...quest, greenlitVersion: 2 }, route, commit }).moment).toBe("none");
    expect(stripScene({ member: keeper, quest, route, commit }).moment).toBe("plan-ready");
    expect(stripScene({ member: keeper, quest: { ...quest, phase: "done" }, route, commit: { ...commit, from: "closing", to: "done" } }).moment).toBe("wrapped");
    expect(stripScene({ member: keeper, quest: { ...quest, phase: "stopped" }, route, commit: { ...commit, from: "stopping", to: "stopped" } }).moment).toBe("none");
  });

  it("reads only a committed phase and the current review by the assigned checker", () => {
    const db = new Database(":memory:");
    try {
      db.exec(KEEPER_MIGRATIONS.join(";\n"));
      const store = new KeeperStore(db as never);
      store.event(20, "keeper-a", "quest-a", "ask.answered", "Fixture reply", { phase: { from: "greenlight", to: "build" }, stripPlanVersion: 3 });
      store.event(21, "keeper-a", "quest-a", "ask.answered", "Unrelated reply");
      expect(committedStripPhase(store, "keeper-a", "quest-a")).toMatchObject({ from: "greenlight", to: "build", version: 3, at: 20 });
      expect(committedStripPhase(store, "keeper-b", "quest-a")).toBeNull();
      const entry = { link: { boardQuestId: "quest-a", waypointId: "waypoint-a" }, status: "verified" } as JournalEntry;
      const details = { waypointId: "waypoint-a", planVersion: 3, verdict: "verified" };
      const actor = { kind: "agent", threadId: "checker-a" } as const;
      store.event(22, "keeper-a", "quest-a", "waypoint.review-round", "Fixture review", details, actor);
      expect(committedStripReview(store, "checker-a", "quest-a", 3, "waypoint-a", [entry])).toEqual({ at: 22, status: "verified" });
      expect(committedStripReview(store, "checker-b", "quest-a", 3, "waypoint-a", [entry])).toBeNull();
      expect(committedStripReview(store, "checker-a", "quest-a", 4, "waypoint-a", [entry])).toBeNull();
      expect(committedStripReview(store, "checker-a", "quest-a", 3, "waypoint-a", [{ ...entry, status: "todo" }])).toBeNull();
      store.event(23, "keeper-a", "quest-a", "waypoint.review-rejected", "Fixture rejection", { ...details, verdict: "rejected" }, actor);
      expect(committedStripReview(store, "checker-a", "quest-a", 3, "waypoint-a", [entry])).toBeNull();
    } finally { db.close(); }
  });

  it("uses accepted assignments, stays still on a report and never seals stale or rejected work", () => {
    const current = stripScene(base);
    expect([current.moment, current.road?.places.at(-1)?.kind]).toEqual(["assignment", "make"]);
    expect(stripScene({ ...base, member: { ...member, classId: "ranger" } }).road?.places.at(-1)?.kind).toBe("read");
    expect(stripScene({ ...base, member: { ...member, classId: "warden" } }).road?.places.at(-1)?.kind).toBe("review");
    const ranger = stripScene({ ...base, member: { ...member, classId: "ranger", engagement: "resting" }, report: { status: "done", createdAt: 36 } });
    expect([ranger.moment, ranger.road?.places.at(-1)?.kind]).toEqual(["report", "report"]);
    expect(stripScene({ ...base, verdict: { status: "verified", at: 29 } }).road?.places.at(-1)?.kind).toBe("make");
    expect(stripScene({ ...base, verdict: { status: "rejected", at: 40 } }).posture).toBe("held");
    expect(stripScene({ ...base, verdict: { status: "verified", at: 40 } }).road?.places.at(-1)?.kind).toBe("seal");
    expect(stripScene({ ...base, gone: true, verdict: { status: "verified", at: 40 } }).road).toBeUndefined();
  });
});
