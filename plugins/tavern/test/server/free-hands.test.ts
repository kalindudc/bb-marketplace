// @vitest-environment node
import { fixtureActivity, patchThreadFixture } from "./member-fixture";
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { seedQuest, waypointEntry } from "./support";
import { readStatus, statusInput } from "../../src/server/status";

export async function restingFixture(classId = "ranger") {
  const f = setup();
  const q = await seedQuest(f.k, "lead", "Quest A", "A");
  const m = f.k.bind("resting", classId, classId === "warden" ? "vex" : "fern", "project", {
    keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Find the source", displayName: "Fern",
    brief: { outcome: "Find the source", mode: "make-it-work", outOfScope: "", doneWhen: "Evidence", context: [], questions: [], timeboxMinutes: null },
  });
  fixtureActivity(f.k, m.threadId, "done");
  return { ...f, q, m };
}
it("lists a resting Ranger across quests before hiring, with its last work and reuse scope", async () => {
  const f = await restingFixture();
  await seedQuest(f.k, "lead", "Quest B", "B");
  const text = f.k.restatement("lead");
  expect(text).toContain("Free hands:");
  expect(text).toContain("Find the source");
  expect(text).toContain("may be re-briefed for: a follow-up on A");
  expect(JSON.stringify(readStatus(f.runtime, "lead", statusInput.parse({})))).toContain("freeHands");
});
it("never lists released members as free hands", async () => {
  const f = await restingFixture();
  patchThreadFixture(f.k.store, f.m.threadId, { released: { reason: "Finished", decisionId: "d1" } });
  expect(f.k.restatement("lead").split("Free hands:")[1]?.split("\n\n")[0]).toBe("\nNone");
});
it("lists a Warden as re-briefable only for the waypoint it rejected", async () => {
  const f = await restingFixture("warden");
  const entry = waypointEntry("maker", f.q.id);
  entry.status = "rejected";
  entry.review = { actor: { kind: "agent", threadId: f.m.threadId }, at: f.time(), evidence: [], reason: "Fix", previousNote: null, memberEvidenceAt: null };
  f.port.linkedEntries = () => [entry];
  f.k.store.put("members", f.m.threadId, { ...f.k.member(f.m.threadId)!, checkerWaypointId: "w1", checkerMakerThreadId: "maker" });
  expect(f.k.restatement("lead")).toContain("may be re-briefed for: re-checking w1 after the maker's fix");
});
it("omits Wardens without a rejected waypoint and never prints a null reuse scope", async () => {
  const f = await restingFixture("warden");
  expect(f.k.restatement("lead")).not.toContain("may be re-briefed for: none");
  expect((readStatus(f.runtime, "lead", statusInput.parse({})) as { freeHands: unknown[] }).freeHands).toEqual([]);
});
it("omits resting members whose quest has ended", async () => {
  const f = await restingFixture();
  f.k.store.db.prepare("UPDATE tavern_records SET data=json_set(data,'$.phase','done','$.endedAt',?) WHERE kind='quests' AND id=?").run(f.time(), f.q.id);
  expect((readStatus(f.runtime, "lead", statusInput.parse({})) as { freeHands: unknown[] }).freeHands).toEqual([]);
});
it("refuses a hire while an eligible Ranger rests on the same quest", async () => {
  const f = await restingFixture();
  const quest = f.q;
  const spawn = vi.spyOn(f.bb.sdk.threads, "spawn");
  const hire = () => f.runtime.hire("lead", "project", { classId: "ranger", title: "Follow up", boardQuestId: quest.id,
    brief: { outcome: "Answer the follow-up", mode: "make-it-work", outOfScope: "", doneWhen: "Evidence", context: [], questions: ["1. Where?"], timeboxMinutes: 3 } });
  await expect(hire()).rejects.toThrow(/Fern \(resting\).*tavern_tell.*tavern_release/);
  expect(spawn).not.toHaveBeenCalled();
  patchThreadFixture(f.k.store, f.m.threadId, { released: { reason: "Finished", decisionId: "release-finished" } });
  await expect(hire()).resolves.toMatchObject({ boardQuestId: quest.id });
});
