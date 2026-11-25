// @vitest-environment node
import { putQuestFixture } from "./support";
import { seedQuest } from "./support";
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { planInput, waypointEntry } from "./support";
import { registerTools } from "../../src/server/tools";

// Live run 4: a follow-up brief to a Smith that had reported must reopen its linked journal work.
async function hired() {
  const f = setup();
  const q = await seedQuest(f.k,"lead", "Build", "Build");
  const base = planInput(q.id);
  f.k.plan("lead", { ...base, waypoints: [...base.waypoints, { ...base.waypoints[0]!, id: "w2" }], party: [{ classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1", "w2"] }] });
  f.k.answerAsk(f.k.store.openAsks("lead")[0]!.id, "approve", null, "page", "user");
  const rebriefed = vi.spyOn(f.port, "rebriefed");
  registerTools(f.bb, f.runtime);
  await f.harness.behavior.invokeAgentTool("tavern_hire", { classId: "smith", title: "Build", boardQuestId: q.id, waypointId: "w1",
    brief: { outcome: "Build", mode: "make-it-work" as const, outOfScope: "Production", doneWhen: "Evidence", context: [], questions: [], timeboxMinutes: null } }, { threadId: "lead" });
  const member = f.k.store.query("members", "boardQuestId", q.id)[0]!;
  return { ...f, q, member, rebriefed };
}

it("reopens the member's linked work when a follow-up brief is accepted, never on the initial brief", async () => {
  const f = await hired();
  expect(f.k.store.runtime(f.member.threadId).briefVersion).toBe(1);
  expect(f.rebriefed).not.toHaveBeenCalled();
  expect(await f.runtime.tell("lead", f.member.threadId, "Also cover NaN")).toMatchObject({ status: "delivered" });
  expect(f.rebriefed.mock.calls).toEqual([[f.member.threadId, f.q.id, 2, ["w1"]]]);
});

it.each([[undefined], [[] as string[]]])("reopens all linked entries for an unscoped follow-up (%j)", async waypointIds => {
  const f = await hired();
  const get = f.port.get;
  const id = f.member.threadId;
  f.port.get = threadId => ({ ...get(threadId), entries: threadId !== id ? [] : [
    waypointEntry(id, f.q.id, "w1", "a1"), waypointEntry(id, f.q.id, "w2", "a2"),
    waypointEntry(id, "other-quest", "w9", "b1"),
  ] });
  expect(await f.runtime.tell("lead", id, "The API changed; redo the endpoint and its examples.", undefined, undefined, waypointIds)).toMatchObject({ status: "delivered" });
  expect(f.rebriefed.mock.calls).toEqual([[id, f.q.id, 2, ["w1", "w2"]]]);
});

it("reopens nothing while a follow-up brief is only queued or retrying, and reopens once it is accepted", async () => {
  const f = await hired();
  const send = f.bb.sdk.threads.send;
  f.bb.sdk.threads.send = vi.fn().mockRejectedValueOnce(new Error("socket hang up")).mockImplementation(send);
  const text = "Also check the examples.";
  expect(await f.harness.behavior.invokeAgentTool("tavern_tell", { member: f.member.threadId, text, waypointIds: ["w2"] }, { threadId: "lead" })).toContain("retry");
  expect(f.rebriefed).not.toHaveBeenCalled();
  f.advance(61_000);
  await f.runtime.retryInitialBriefs("lead");
  expect(f.rebriefed.mock.calls).toEqual([[f.member.threadId, f.q.id, 2, ["w2"]]]);
});

it("leaves an ended quest's journal alone when a retried brief lands after the quest ended", async () => {
  for (const phase of ["done", "stopped"] as const) {
    const f = await hired();
    const send = f.bb.sdk.threads.send;
    f.bb.sdk.threads.send = vi.fn().mockRejectedValueOnce(new Error("socket hang up")).mockImplementation(send);
    expect(await f.runtime.tell("lead", f.member.threadId, "Also cover NaN")).toMatchObject({ status: "retrying" });
    putQuestFixture(f.k.store, f.q.id, { ...f.k.store.get("quests", f.q.id)!, phase });
    f.advance(61_000);
    await f.runtime.retryInitialBriefs("lead").catch(() => null);
    expect(f.rebriefed, phase).not.toHaveBeenCalled();
    expect(f.k.store.runtime(f.member.threadId).briefVersion, phase).toBe(1);
  }
});
