// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Member } from "../../src/shared/schema";
import { setup } from "./runtime-fixture";
import { seedQuest } from "./support";

const placements = [
  ["working", "road"],
  ["idle", "table"],
  ["waiting", "table"],
  ["done", "rest"],
  ["failed", "table"],
  ["stopped", "rest"],
] as const satisfies readonly (readonly [Member["state"], Member["place"]])[];
const brief = { outcome: "Make labels", mode: "make-it-work" as const, outOfScope: "Production", doneWhen: "Tests pass", context: [], questions: [], timeboxMinutes: null };
const report = { status: "done" as const, outcome: "Labels ready", evidence: [], artifacts: [], confidence: null, voice: null };

async function member() {
  const f = setup();
  const q = await seedQuest(f.k, "lead", "Make labels", "Labels");
  const child = f.k.bind("child", "smith", null, "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Make labels", brief });
  return { ...f, q, child };
}

describe("Stored member placement", () => {
  it.each(["keeper", "solo", "member"] as const)("binds a new %s idle at the table", async role => {
    const f = await member();
    const bound = role === "member" ? f.child : f.k.bind("new-thread", role === "keeper" ? "keeper" : "smith", null, "project");
    expect(bound).toMatchObject({ role, state: "idle", place: "table" });
    expect(f.k.member(bound.threadId)).toMatchObject({ state: "idle", place: "table" });
  });

  it.each(placements)("stores %s activity at %s", async (state, place) => {
    const f = await member();
    if (state === "idle") f.k.activity("child", "working");
    f.k.activity("child", state);
    expect(f.k.member("child")).toMatchObject({ state, place });
  });

  it.each([
    ["done", "done", "rest"],
    ["blocked", "waiting", "table"],
    ["needs-decision", "waiting", "table"],
  ] as const)("stores a %s report as %s at %s", async (status, state, place) => {
    const f = await member();
    f.k.activity("child", "working");
    const stored = f.k.report("child", { ...report, status });
    expect(stored.deliveredAt).toBeNull();
    expect(f.k.member("child")).toMatchObject({ state, place });
  });

  it.each(placements)("keeps late-report state %s at %s", async (state, place) => {
    const f = await member();
    f.k.store.put("members", "child", { ...f.child, state, place });
    f.k.store.patch("lead", { archivedAt: f.time() });
    const stored = f.k.report("child", { ...report, status: "blocked" });
    expect(stored.deliveredAt).toBe(f.time());
    expect(f.k.member("child")).toMatchObject({ state, place });
  });

  it.each(["idle", "waiting", "stopped"] as const)("leaves a finished member resting after %s activity", async state => {
    const f = await member();
    f.k.activity("child", "done");
    f.k.activity("child", state);
    expect(f.k.member("child")).toMatchObject({ state: "done", place: "rest" });
  });
});
