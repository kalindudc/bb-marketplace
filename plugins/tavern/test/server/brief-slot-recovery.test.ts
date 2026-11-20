// @vitest-environment node
import { putMemberFixture, runtimeFixture } from "./member-fixture";
import { seedQuest } from "./support";
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { planInput } from "./support";
import { registerTools } from "../../src/server/tools";

it("keeps a failed child's slot occupied while a later rebrief is pending until retried or released", async () => {
  const f = setup();
  const q = await seedQuest(f.k,"lead", "Build", "Build");
  f.k.plan("lead", {
    ...planInput(q.id),
    party: [
      {
        classId: "smith",
        characterId: null,
        model: null,
        purpose: "Build",
        waypointIds: ["w1"],
      },
    ],
  });
  f.k.answerAsk(f.k.store.openAsks("lead")[0]!.id, "approve", null, "page", "user");
  const originalSend = f.bb.sdk.threads.send;
  f.bb.sdk.threads.send = vi
    .fn()
    .mockRejectedValueOnce(new Error("socket hang up"))
    .mockImplementation(originalSend);
  const input = {
    classId: "smith",
    title: "Build",
    boardQuestId: q.id,
    waypointId: "w1",
    brief: {
      outcome: "Build",
      mode: "make-it-work" as const,
      outOfScope: "Production",
      doneWhen: "Evidence",
      context: [],
      questions: [],
      timeboxMinutes: null,
    },
  };
  registerTools(f.bb, f.runtime);
  const result = await f.harness.behavior.invokeAgentTool(
    "tavern_hire",
    input,
    { threadId: "lead" },
  );
  expect(result).not.toContain("brief pending");
  const member = f.k.store.query("members", "boardQuestId", q.id)[0]!;
  expect(await f.runtime.tell("lead", member.threadId, "Continue with the revised checks")).toMatchObject({ briefPending: true, status: "retrying", attempts: 1 });
  putMemberFixture(f.k.store, member.threadId, { ...member, state: "failed" });
  await expect(f.runtime.hire("lead", "project", input)).rejects.toThrow(
    /initial smith brief is still pending|already has a live member/,
  );
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  f.advance(61_000);
  await f.runtime.retryInitialBriefs("lead");
  expect(runtimeFixture(f.k.store, member.threadId).pendingBrief).toBeNull();
  expect(f.k.store.runtime(member.threadId).briefVersion).toBe(2);
});
