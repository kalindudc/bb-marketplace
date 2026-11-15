// @vitest-environment node
import { seedQuest } from "./support";
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { planInput } from "./support";
import { registerTools } from "../../src/server/tools";

// Live run 4: a follow-up brief to a Smith that had reported must reopen its linked journal work.
async function hired() {
  const f = setup();
  const q = await seedQuest(f.k,"lead", "Build", "Build");
  f.k.plan("lead", { ...planInput(q.id), party: [{ classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] }] });
  f.k.answerAsk(f.k.store.openAsks("lead")[0]!.id, "approve", null, "page");
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
  expect(f.rebriefed.mock.calls).toEqual([[f.member.threadId, f.q.id, 2]]);
});

it("reopens nothing while a follow-up brief is only queued or retrying, and reopens once it is accepted", async () => {
  const f = await hired();
  const send = f.bb.sdk.threads.send;
  f.bb.sdk.threads.send = vi.fn().mockRejectedValueOnce(new Error("socket hang up")).mockImplementation(send);
  expect(await f.runtime.tell("lead", f.member.threadId, "Also cover NaN")).toMatchObject({ status: "retrying" });
  expect(f.rebriefed).not.toHaveBeenCalled();
  f.advance(61_000);
  await f.runtime.retryInitialBriefs("lead");
  expect(f.rebriefed.mock.calls).toEqual([[f.member.threadId, f.q.id, 2]]);
});

it("leaves an ended quest's journal alone when a retried brief lands after the quest ended", async () => {
  for (const phase of ["done", "stopped"] as const) {
    const f = await hired();
    const send = f.bb.sdk.threads.send;
    f.bb.sdk.threads.send = vi.fn().mockRejectedValueOnce(new Error("socket hang up")).mockImplementation(send);
    expect(await f.runtime.tell("lead", f.member.threadId, "Also cover NaN")).toMatchObject({ status: "retrying" });
    f.k.store.put("quests", f.q.id, { ...f.k.store.get("quests", f.q.id)!, phase });
    f.advance(61_000);
    await f.runtime.retryInitialBriefs("lead").catch(() => null);
    expect(f.rebriefed, phase).not.toHaveBeenCalled();
    expect(f.k.store.runtime(f.member.threadId).briefVersion, phase).toBe(1);
  }
});
