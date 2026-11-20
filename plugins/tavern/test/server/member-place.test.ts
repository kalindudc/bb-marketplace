// @vitest-environment node
import { describe, expect, it } from "vitest";
import { memberPlace } from "../../src/shared/member-place";
import type { Member } from "../../src/shared/schema";
import { setup } from "./runtime-fixture";
import { seedQuest } from "./support";

const positions = [["working", "road"], ["idle", "table"], ["waiting", "table"], ["failed", "table"]] as const satisfies readonly (readonly [Member["state"], ReturnType<typeof memberPlace>])[];
const brief = { outcome: "Make labels", mode: "make-it-work" as const, outOfScope: "Production", doneWhen: "Tests pass", context: [], questions: [], timeboxMinutes: null };
const report = { status: "done" as const, outcome: "Labels ready", evidence: [], artifacts: [], confidence: null, voice: null };

async function member() {
  const f = setup();
  const q = await seedQuest(f.k, "lead", "Make labels", "Labels");
  const child = f.k.bind("child", "smith", null, "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Make labels", brief });
  return { ...f, q, child };
}

describe("Member position is derived", () => {
  it.each(["keeper", "solo", "member"] as const)("binds a new %s idle at the table", async role => {
    const f = await member();
    const bound = role === "member" ? f.child : f.k.bind("new-thread", role === "keeper" ? "keeper" : "smith", null, "project");
    expect(bound).toMatchObject({ role, state: "idle" });
    expect(f.k.member(bound.threadId)).not.toHaveProperty("place");
    expect(memberPlace(bound)).toBe("table");
  });

  it.each(positions)("stores %s activity and draws it at %s", async (state, place) => {
    const f = await member();
    f.k.activity("child", state);
    expect(f.k.member("child")?.state).toBe(state);
    expect(memberPlace(f.k.member("child")!)).toBe(place);
  });

  it.each([["done", "resting", "rest"], ["blocked", "active", "table"], ["needs-decision", "active", "table"]] as const)
    ("files a %s report with %s engagement and draws it at %s", async (status, engagement, place) => {
      const f = await member();
      f.k.activity("child", "working");
      const stored = f.k.report("child", { ...report, status });
      expect(stored.deliveredAt).toBeNull();
      expect(f.k.member("child")).toMatchObject({ engagement, state: status === "done" ? "working" : "waiting" });
      expect(memberPlace(f.k.member("child")!)).toBe(place);
    });

  it.each(positions)("keeps late-report activity %s at %s", async (state, place) => {
    const f = await member();
    f.k.activity("child", state);
    f.k.store.patch("lead", { archivedAt: f.time() });
    const stored = f.k.report("child", { ...report, status: "blocked" });
    expect(stored.deliveredAt).toBe(f.time());
    expect(f.k.member("child")).toMatchObject({ state, engagement: "active" });
    expect(memberPlace(f.k.member("child")!)).toBe(place);
  });

  it.each(["idle", "waiting", "working"] as const)("leaves a finished member resting after observing %s", async state => {
    const f = await member();
    f.k.report("child", report);
    f.k.activity("child", state);
    expect(f.k.member("child")).toMatchObject({ engagement: "resting", state });
    expect(memberPlace(f.k.member("child")!)).toBe("rest");
  });
});
