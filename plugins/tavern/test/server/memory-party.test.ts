// @vitest-environment node
import { rpcHandlers } from "../../src/server/rpc";
import { registerCli } from "../../src/server/cli";
import { isNewsEvent } from "../../src/server/news";
import { seedLegacyQuest, seedQuest } from "./support";
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
  f.k.answerAsk(ask.id, "approve", null, "page", "user");
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
  it("refuses Keeper review overrides and consumes the user's allowance once", async () => {
    const f = await approved();
    vi.spyOn(f.runtime, "review").mockReturnValue({ waiting: 3, budget: 3, items: [] });
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow("Limit: attention.reviewBudget = 3");
    f.k.decide("lead", { boardQuestId: f.q.id, text: "Extra work", why: "Bounded", source: "keeper", reversible: true });
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow("Limit: attention.reviewBudget = 3");
    await rpcHandlers(f.runtime).allowReview({ id: f.q.id }, { experimental_caller: { kind: "client" } } as never);
    await expect(f.runtime.hire("lead", "project", f.input)).resolves.toBeTruthy();
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow("Limit: attention.reviewBudget = 3");
  });
  it.each(["banner", "phone", "page", "chat", "cli"] as const)("asks once and consumes one review allowance from %s", async via => {
    const f = await approved();
    vi.spyOn(f.runtime, "review").mockReturnValue({ waiting: 5, budget: 3, items: [] });
    const wake = vi.spyOn(f.runtime, "wakeKeeper").mockResolvedValue(undefined);
    const tick = vi.spyOn(f.runtime, "tick").mockResolvedValue(undefined);
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(/review budget/);
    const [ask] = f.k.store.openAsks("lead", f.q.id);
    expect(ask).toMatchObject({ question: "Your review queue is full (5 of 3). Allow one more review for this quest?",
      options: [{ id: "allow", label: "Allow" }, { id: "wait", label: "Wait" }] });
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(ask!.id);
    expect(f.k.store.openAsks("lead", f.q.id)).toEqual([ask]);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);

    const handlers = rpcHandlers(f.runtime), client = { experimental_caller: { kind: "client" } } as never;
    registerCli(f.bb, f.runtime);
    const cli = f.harness.inspection.registrations.cli[0]!;
    const answer = () => via === "cli"
      ? cli.run(["ask", ask!.id, "allow"], {})
      : handlers.answerAsk({ askId: ask!.id, optionId: "allow", note: null, via }, client);
    await answer();
    await answer();
    if (via === "cli") expect(tick).toHaveBeenCalledWith("lead");
    else expect(wake).toHaveBeenCalledWith("lead", "user-action");
    expect(f.k.quest(f.q.id).reviewAllowance).toHaveLength(1);
    expect(f.k.store.events().find(e => e.type === "review.allowed")).toMatchObject({
      actor: { kind: "user" }, data: { askId: ask!.id, surface: via === "cli" ? "terminal" : `${via} (client, unattested)` },
    });
    expect(f.k.store.get("asks", ask!.id)?.answer).toMatchObject({ by: "user", via });
    await expect(f.runtime.hire("lead", "project", f.input)).resolves.toBeTruthy();
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(/review budget/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("does not let agents grant a review allowance and leaves hiring held on Wait", async () => {
    const f = await approved();
    vi.spyOn(f.runtime, "review").mockReturnValue({ waiting: 3, budget: 3, items: [] });
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(/review budget/);
    const ask = f.k.store.openAsks("lead", f.q.id)[0]!;
    const handlers = rpcHandlers(f.runtime), input = { askId: ask.id, optionId: "allow", note: null, via: "banner" as const };
    const plugin = { experimental_caller: { kind: "plugin", pluginId: "fixture" } } as never;
    const client = { experimental_caller: { kind: "client" } } as never;
    await expect(async () => handlers.answerAsk(input, plugin)).rejects.toThrow(/explicit client action/);
    await expect(f.runtime.resolveKeeperBlocker("lead", ask.id, "allow")).rejects.toThrow(/cannot resolve/);
    expect(() => f.k.decide("lead", { askId: ask.id, optionId: "allow", boardQuestId: f.q.id, text: "Allow", why: "Retry", source: "keeper", reversible: true })).toThrow(/explicit answer|belongs to the user/);
    await expect(f.runtime.answerAsk(ask.id, "allow", null, "timer", false, undefined, undefined, true)).rejects.toThrow(/explicit answer/);
    registerCli(f.bb, f.runtime);
    expect(await f.harness.inspection.registrations.cli[0]!.run(["ask", ask.id, "allow"], { threadId: "lead" })).toMatchObject({ exitCode: 1, stderr: expect.stringMatching(/Agents cannot answer/) });
    await handlers.answerAsk({ ...input, optionId: "wait" }, client);
    expect(f.k.store.get("asks", ask.id)?.answer?.optionId).toBe("wait");
    expect(f.k.quest(f.q.id).reviewAllowance).toBeUndefined();
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(/review budget/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("withdraws the review ask before a reserved Smith begins spawning", async () => {
    const f = await approved();
    const review = vi.spyOn(f.runtime, "review").mockReturnValue({ waiting: 3, budget: 3, items: [] });
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(/review budget/);
    const [ask] = f.k.store.openAsks("lead", f.q.id);
    review.mockReturnValue({ waiting: 2, budget: 3, items: [] });
    const spawn = f.bb.sdk.threads.spawn.bind(f.bb.sdk.threads);
    vi.spyOn(f.bb.sdk.threads, "spawn").mockImplementation(input => {
      expect(f.k.store.all("hires")).toHaveLength(1);
      expect(f.k.store.get("asks", ask!.id)).toMatchObject({ state: "withdrawn", withdrawnCause: "no-longer-needed", answer: null });
      return spawn(input);
    });
    await f.runtime.hire("lead", "project", f.input);
    expect(f.k.store.events().find(e => e.type === "ask.withdrawn")).toMatchObject({ actor: { kind: "tavern" }, data: { askId: ask!.id, cause: "no-longer-needed" } });
    expect(f.k.quest(f.q.id).reviewAllowance).toBeUndefined();
    review.mockReturnValue({ waiting: 3, budget: 3, items: [] });
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(/review budget/);
    const current = f.k.store.openAsks("lead", f.q.id);
    expect(current).toHaveLength(1);
    expect(current[0]!.id).not.toBe(ask!.id);
  });
  it("withdraws the ask when the quest page grants exactly one allowance", async () => {
    const f = await approved();
    vi.spyOn(f.runtime, "review").mockReturnValue({ waiting: 3, budget: 3, items: [] });
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(/review budget/);
    const [ask] = f.k.store.openAsks("lead", f.q.id);
    const handlers = rpcHandlers(f.runtime), client = { experimental_caller: { kind: "client" } } as never;
    await handlers.allowReview({ id: f.q.id }, client);
    expect(f.k.store.get("asks", ask!.id)).toMatchObject({ state: "withdrawn", withdrawnCause: "no-longer-needed", answer: null });
    await expect(handlers.answerAsk({ askId: ask!.id, optionId: "allow", note: null, via: "phone" }, client)).rejects.toThrow(/no longer open/);
    expect(f.k.quest(f.q.id).reviewAllowance).toHaveLength(1);
    expect(f.k.store.events().filter(e => e.type === "review.allowed")).toHaveLength(1);
  });
  it.each([false, true])("wakes the held Keeper once when review room returns (chose Wait: %s)", async choseWait => {
    const f = await approved();
    const review = vi.spyOn(f.runtime, "review").mockReturnValue({ waiting: 3, budget: 3, items: [] });
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(/review budget/);
    const [ask] = f.k.store.openAsks("lead", f.q.id);
    const wake = vi.spyOn(f.runtime, "wakeKeeper").mockResolvedValue(undefined);
    if (choseWait) await rpcHandlers(f.runtime).answerAsk({ askId: ask!.id, optionId: "wait", note: null, via: "page" }, { experimental_caller: { kind: "client" } } as never);
    wake.mockClear();
    await f.runtime.sweep();
    expect(wake).not.toHaveBeenCalled();
    review.mockReturnValue({ waiting: 2, budget: 3, items: [] });
    await f.runtime.sweep();
    await f.runtime.sweep();
    expect(wake.mock.calls).toEqual([["lead", "review-budget.available"]]);
    const facts = f.k.store.events().filter(e => e.type === "review-budget.available");
    expect(facts).toMatchObject([{ boardQuestId: f.q.id, text: expect.stringContaining("The review queue has room"), data: { askId: ask!.id, boardQuestId: f.q.id } }]);
    expect(isNewsEvent(facts[0]!, "lead")).toBe(true);
    expect(f.k.store.get("asks", ask!.id)).toMatchObject(choseWait ? { state: "answered", answer: { optionId: "wait" } } :
      { state: "withdrawn", withdrawnCause: "no-longer-needed", answer: null });
    expect(f.k.quest(f.q.id).reviewAllowance).toBeUndefined();
  });
  it("refreshes the numbers without opening a second review ask", async () => {
    const f = await approved();
    const review = vi.spyOn(f.runtime, "review").mockReturnValue({ waiting: 3, budget: 3, items: [] });
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(/review budget/);
    const [ask] = f.k.store.openAsks("lead", f.q.id);
    review.mockReturnValue({ waiting: 5, budget: 4, items: [] });
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(ask!.id);
    expect(f.k.store.openAsks("lead", f.q.id)).toMatchObject([{ id: ask!.id, question: "Your review queue is full (5 of 4). Allow one more review for this quest?" }]);
  });
  it("does not use another quest's allowance and restores an allowance after a definite spawn refusal", async () => {
    const f = await approved();
    vi.spyOn(f.runtime, "review").mockReturnValue({ waiting: 3, budget: 3, items: [] });
    const other = seedLegacyQuest(f.k, "lead", "Other", "Other");
    const handlers = rpcHandlers(f.runtime), client = { experimental_caller: { kind: "client" } } as never;
    await handlers.allowReview({ id: other.id }, client);
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(/review/);
    await handlers.allowReview({ id: f.q.id }, client);
    const spawn = f.bb.sdk.threads.spawn;
    f.bb.sdk.threads.spawn = vi.fn().mockRejectedValueOnce(new Error("HTTP 400 refused")).mockImplementation(spawn);
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow("HTTP 400 refused");
    await expect(f.runtime.hire("lead", "project", f.input)).resolves.toBeTruthy();
  });
});
