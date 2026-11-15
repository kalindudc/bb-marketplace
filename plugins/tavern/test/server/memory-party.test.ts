// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { planInput } from "./support";
import { makeThreadResponse } from "./host";

const brief = {
  outcome: "Build",
  mode: "make-it-work" as const,
  outOfScope: "Production",
  doneWhen: "Tests pass",
  context: [],
  questions: [],
  timeboxMinutes: null,
};
async function approved() {
  const f = setup();
  const q = await seedQuest(f.k,"lead", "Build", "Build");
  f.k.plan("lead", {
    ...planInput(q.id),
    party: Array.from({ length: 4 }, () => ({
      classId: "smith",
      characterId: null,
      model: null,
      purpose: "Build a slice",
      waypointIds: ["w1"],
    })),
  });
  const ask = f.k.asks("lead")[0]!;
  f.k.answerAsk(ask.id, "approve", null, "page");
  return {
    ...f,
    q,
    input: {
      classId: "smith",
      title: "Build a slice",
      brief,
      boardQuestId: q.id,
    },
  };
}
describe("Durable member and review memory", () => {
  it("records a final excerpt and one stale strike when a brief ends without a report", async () => {
    const f = setup();
    const member = await f.runtime.hire("lead", "project", {
      classId: "wanderer",
      errand: true,
      title: "An errand",
      brief,
    });
    f.advance(1000);
    const thread = makeThreadResponse({ id: member.threadId, status: "idle" });
    f.runtime.memberEnded(
      thread,
      "Final answer without tavern_report " + "x".repeat(600),
    );
    f.runtime.memberEnded(thread, "duplicate idle notification");
    const events = f.k.store
      .events("lead")
      .filter((e) => e.type === "member.unreported");
    expect(events).toHaveLength(1);
    expect((events[0]!.data as { excerpt: string }).excerpt).toHaveLength(500);
    expect(f.k.member(member.threadId)?.strikes).toBe(1);
    f.advance(61_000);
    await f.runtime.tick("lead");
    expect(
      JSON.stringify(
        f.harness.inspection.sdk.callsTo("threads.send").at(-1)?.args,
      ),
    ).toContain("without tavern_report");
  });
  it("does not strike a reported or deliberately released member", async () => {
    const f = setup();
    const member = await f.runtime.hire("lead", "project", {
      classId: "wanderer",
      errand: true,
      title: "An errand",
      brief,
    });
    f.k.report(member.threadId, {
      status: "needs-decision",
      outcome: "Useful findings",
      evidence: [],
      artifacts: [],
      voice: null,
      confidence: { intent: 90, safe: 80 },
    });
    f.runtime.memberEnded(
      makeThreadResponse({ id: member.threadId, status: "idle" }),
      "See my report",
    );
    expect(
      f.k.store.events("lead").filter((e) => e.type === "member.unreported"),
    ).toHaveLength(0);
    f.advance(1000);
    await f.runtime.tell("lead", member.threadId, "Do another bounded task");
    f.advance(1000);
    f.runtime.memberEnded(
      makeThreadResponse({ id: member.threadId, status: "idle" }),
      "New unreported task",
    );
    expect(
      f.k.store.events("lead").filter((e) => e.type === "member.unreported"),
    ).toHaveLength(1);
  });
  it("accepts an identical report for a new brief without adding an unreported strike", async () => {
    const f = setup();
    const member = await f.runtime.hire("lead", "project", {
      classId: "wanderer",
      errand: true,
      title: "An errand",
      brief,
    });
    const report = {
      status: "needs-decision" as const,
      outcome: "Same result",
      evidence: [],
      artifacts: [],
      voice: null,
      confidence: { intent: 90, safe: 80 },
    };
    f.k.report(member.threadId, report);
    await f.runtime.tell("lead", member.threadId, "Check the same thing again");
    f.k.report(member.threadId, report);
    f.runtime.memberEnded(
      makeThreadResponse({ id: member.threadId, status: "idle" }),
      "Same report",
    );
    expect(
      f.k.store.events("lead").filter((e) => e.type === "member.unreported"),
    ).toHaveLength(0);
    expect(
      f.k.store.query("reports", "memberThreadId", member.threadId),
    ).toHaveLength(2);
  });
  it("refuses new review-bound work with the review count, then consumes an explicit exception once", async () => {
    const f = await approved();
    vi.spyOn(f.runtime, "review").mockReturnValue({
      waiting: 3,
      budget: 3,
      items: [],
    });
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(
      "3 of 3; wait, or record a decision to exceed it",
    );
    f.k.decide("lead", {
      boardQuestId: f.q.id,
      text: "Exceed the review budget for this thin slice",
      why: "The user can undo the extra work",
      source: "keeper",
      reversible: true,
      reviewBudgetOverride: true,
    });
    await expect(
      f.runtime.hire("lead", "project", f.input),
    ).resolves.toBeTruthy();
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(
      "3 of 3; wait, or record a decision to exceed it",
    );
  });
  it("does not accept undone or other-quest decisions, and returns a permit after a definite spawn refusal", async () => {
    const f = await approved();
    vi.spyOn(f.runtime, "review").mockReturnValue({
      waiting: 3,
      budget: 3,
      items: [],
    });
    const other = await seedQuest(f.k,"lead", "Other", "Other");
    f.k.decide("lead", {
      boardQuestId: other.id,
      text: "Other",
      why: "Other",
      source: "keeper",
      reversible: true,
      reviewBudgetOverride: true,
    });
    const undone = f.k.decide("lead", {
      boardQuestId: f.q.id,
      text: "Undone",
      why: "Undone",
      source: "keeper",
      reversible: true,
      reviewBudgetOverride: true,
    });
    f.k.undoDecision(undone.id);
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(
      /review/,
    );
    f.k.decide("lead", {
      boardQuestId: f.q.id,
      text: "A usable exception",
      why: "One attempt",
      source: "keeper",
      reversible: true,
      reviewBudgetOverride: true,
    });
    const spawn = f.bb.sdk.threads.spawn;
    f.bb.sdk.threads.spawn = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 400 refused"))
      .mockImplementation(spawn);
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(
      "HTTP 400 refused",
    );
    await expect(
      f.runtime.hire("lead", "project", f.input),
    ).resolves.toBeTruthy();
  });
});
