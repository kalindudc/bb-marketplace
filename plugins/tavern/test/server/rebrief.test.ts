// @vitest-environment node
import { fixtureActivity, patchThreadFixture, runtimeFixture } from "./member-fixture";
import { memberPlace } from "../../src/shared/member-place";
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { MEMBER_STATES } from "../../src/shared/schema";
import { registerTools } from "../../src/server/tools";
import { TavernRuntime } from "../../src/server/runtime";
import { makeThreadResponse } from "./host";
import { setup } from "./runtime-fixture";

const instruction = "Check the revised acceptance criteria";
function party() {
  const f = setup();
  f.k.bind("child", "smith", "vale", "project", {
    keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Task",
    displayName: "Pip", brief: { outcome: "Task", doneWhen: "Evidence", mode: "make-it-work", outOfScope: "Production", context: [], questions: [], timeboxMinutes: null },
  });
  f.runtime.spawnBriefDelivered("child");
  registerTools(f.bb, f.runtime);
  return { ...f, tell: () => f.harness.behavior.invokeAgentTool("tavern_tell", { memberThreadId: "child", text: instruction }, { threadId: "lead" }) };
}
function reported(f: ReturnType<typeof party>) {
  return f.k.report("child", { status: "done", outcome: "Original task complete", evidence: [{ kind: "command", ref: "npm test", detail: "Original checks passed", exitCode: 0 }], artifacts: [], confidence: { intent: 100, safe: 100 }, voice: null });
}
function told(f: ReturnType<typeof party>) {
  return f.k.store.events("lead", 0, 200).filter(event => event.type === "member.told");
}
/** Brief sends target the member thread; Keeper ticks go to the lead thread, so count only the member's. */
const briefSends = (send: { mock: { calls: { 0: { threadId: string } }[] } }) =>
  send.mock.calls.filter(call => call[0].threadId === "child");
function pending(f: ReturnType<typeof party>, attempts = 0) {
  patchThreadFixture(f.k.store, "child", { pendingBrief: { id: "brief_old", text: instruction, attempts, nextAttemptAt: f.time(), attemptedAt: attempts ? f.time() : null, hostAfterSeq: null, error: null } });
}

describe("member re-brief delivery through the strict host", () => {
  it("delivers to a reported member's idle thread and starts a new report generation", async () => {
    const f = party(), report = reported(f);
    const send = vi.spyOn(f.bb.sdk.threads, "send");
    expect(await f.tell()).toContain("Brief delivered to Pip");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ threadId: "child", mode: "queue-if-active", input: [expect.objectContaining({ text: expect.stringContaining(instruction) })] }));
    expect(f.k.member("child")).toMatchObject({ state: "working", engagement: "active" });
    expect(memberPlace(f.k.member("child")!)).toBe("road");
    expect(runtimeFixture(f.k.store, "child")).toMatchObject({ pendingBrief: null, briefVersion: 2, reportedBriefVersion: 1 });
    expect(f.k.store.get("reports", report.id)).toEqual(report);
    expect(told(f)).toHaveLength(1);
    expect(told(f)[0]?.data).toMatchObject({ delivery: "delivered", briefPending: false });
    f.runtime.memberEnded(makeThreadResponse({ id: "child", status: "idle" }), "Forgot to report the new work");
    expect(f.k.store.events("lead", 0, 200).some(event => event.type === "member.unreported")).toBe(true);
  });

  it.each(MEMBER_STATES)("delivers to a %s member and activates the new generation", async state => {
    const f = party();
    f.k.activity("child", state);
    expect(await f.tell()).toContain("Brief delivered to Pip");
    expect(runtimeFixture(f.k.store, "child")).toMatchObject({ pendingBrief: null, briefVersion: 2 });
    expect(f.k.member("child")?.state).toBe("working");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it.each(["stopped", "released", "release-pending", "archive-pending"] as const)("refuses a %s member without persisting a retry", async state => {
    const f = party();
    if (state === "stopped") fixtureActivity(f.k, "child", "stopped");
    if (state === "released") patchThreadFixture(f.k.store, "child", { released: { reason: "Old task ended", decisionId: "release-old" } });
    if (state === "release-pending") patchThreadFixture(f.k.store, "child", { releasePending: "Stopping" });
    if (state === "archive-pending") patchThreadFixture(f.k.store, "child", { archivePending: true });
    await expect(f.tell()).rejects.toThrow(/Pip .*can't take new work; hire a replacement or re-plan/);
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toBeFalsy();
    await f.runtime.retryInitialBriefs("lead");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(told(f)).toHaveLength(0);
    expect(f.k.store.openAsks("lead")).toHaveLength(0);
  });

  it.each(["stopped", "released"] as const)("explains a %s board-quest member refusal before unrelated route permissions", async state => {
    const f = party();
    const quest = await seedQuest(f.k,"lead", "Build", "Build");
    f.k.store.put("members", "child", { ...f.k.member("child")!, boardQuestId: quest.id });
    f.k.receiveUser("lead", "What time is it?");
    f.k.route("lead", { kind: "question", summary: "A question", notes: [] });
    if (state === "stopped") fixtureActivity(f.k, "child", "stopped");
    else patchThreadFixture(f.k.store, "child", { released: { reason: "Old release", decisionId: "old" } });
    await expect(f.tell()).rejects.toThrow(`Pip is ${state} and can\u0027t take new work`);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it.each(["stopped", "released"] as const)("clears an old zero-attempt pending brief for a %s member instead of retrying", async state => {
    const f = party();
    pending(f);
    if (state === "stopped") fixtureActivity(f.k, "child", "stopped");
    else patchThreadFixture(f.k.store, "child", { released: { reason: "Old release", decisionId: "old" } });
    await f.runtime.retryInitialBriefs("lead");
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toBeNull();
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(f.k.store.openAsks("lead")).toHaveLength(0);
  });

  it("recovers a reported member's existing zero-attempt pending brief after restart", async () => {
    const f = party();
    reported(f);
    pending(f);
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    await restarted.retryInitialBriefs("lead");
    expect(runtimeFixture(f.k.store, "child")).toMatchObject({ pendingBrief: null, briefVersion: 2 });
    expect(f.k.member("child")?.state).toBe("working");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(told(f).at(-1)?.data).toMatchObject({ delivery: "delivered", briefPending: false });
  });

  it("counts a failed reported-member delivery, retries it and records the eventual delivered outcome", async () => {
    const f = party();
    reported(f);
    const send = vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValueOnce(new Error("temporarily offline"));
    expect(await f.tell()).toContain("attempt 1 of 5");
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toMatchObject({ attempts: 1 });
    expect(f.k.member("child")?.engagement).toBe("briefing");
    expect(told(f).at(-1)?.data).toMatchObject({ delivery: "retrying", briefPending: true, attempts: 1 });
    f.advance(60_001);
    await f.runtime.retryInitialBriefs("lead");
    expect(briefSends(send)).toHaveLength(2);
    expect(runtimeFixture(f.k.store, "child")).toMatchObject({ pendingBrief: null, briefVersion: 2 });
    expect(f.k.member("child")?.state).toBe("working");
    expect(told(f).at(-1)?.data).toMatchObject({ delivery: "delivered", briefPending: false });
  });

  it("calls a core-queued brief queued, not delivered, and activates the member only after dispatch", async () => {
    const f = party();
    reported(f);
    const send = vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValueOnce({ delivery: "queued" } as never);
    expect(await f.tell()).toContain("Brief queued in bb for Pip; delivery is not confirmed");
    expect(runtimeFixture(f.k.store, "child")).toMatchObject({ briefVersion: 1, pendingBrief: { attempts: 1 } });
    expect(f.k.member("child")?.engagement).toBe("briefing");
    const pendingId = runtimeFixture(f.k.store, "child").pendingBrief?.id;
    f.k.report("child", { status: "done", outcome: "A final note from the old work", evidence: [], artifacts: [], confidence: null, voice: null });
    expect(f.k.member("child")?.engagement).toBe("briefing");
    expect(runtimeFixture(f.k.store, "child").pendingBrief?.id).toBe(pendingId);
    f.runtime.dispatched({ threadId: "child", originPluginId: "tavern", content: send.mock.calls[0]![0].input } as never);
    expect(f.k.member("child")?.state).toBe("working");
    expect(runtimeFixture(f.k.store, "child")).toMatchObject({ pendingBrief: null, briefVersion: 2 });
    expect(told(f).map(event => event.data.delivery)).toEqual(["queued", "delivered"]);
    expect(send).toHaveBeenCalledOnce();
  });

  it("opens one blocker at the fifth failed attempt and never claims automatic retry after exhaustion", async () => {
    const f = party();
    reported(f);
    const send = vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(new Error("offline"));
    await f.tell();
    for (let attempt = 1; attempt < 5; attempt++) {
      f.advance(3_600_000);
      await f.runtime.retryInitialBriefs("lead");
    }
    expect(briefSends(send)).toHaveLength(5);
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toMatchObject({ attempts: 5 });
    expect(f.k.store.openAsks("lead").filter(ask => ask.kind === "blocker")).toHaveLength(1);
    expect(await f.tell()).toContain("Automatic retries have stopped");
    f.advance(3_600_000);
    await f.runtime.retryInitialBriefs("lead");
    expect(briefSends(send)).toHaveLength(5);
    expect(told(f).at(-1)?.data).toMatchObject({ delivery: "blocked", briefPending: true, attempts: 5 });
    expect(f.k.store.openAsks("lead").filter(ask => ask.kind === "blocker")).toHaveLength(1);
  });

  it("refuses a member stopped during the pre-send lookup without restoring pending state", async () => {
    const f = party();
    vi.spyOn(f.bb.sdk.threads.events, "list").mockImplementation(async () => {
      fixtureActivity(f.k, "child", "stopped");
      return [];
    });
    await expect(f.tell()).rejects.toThrow("Pip is stopped and can\u0027t take new work");
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toBeNull();
    expect(f.harness.inspection.sdk.callsTo("threads.send").filter(call => (call.args[0] as { threadId: string }).threadId === "child")).toHaveLength(0);
  });

  it("refuses a new brief while Tavern is paused instead of creating an unattempted retry", async () => {
    const f = party();
    const config = f.runtime.config();
    vi.spyOn(f.runtime, "config").mockReturnValue({ ...config, tavern: { ...config.tavern, paused: true } });
    await expect(f.tell()).rejects.toThrow(/Tavern is paused/);
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toBeNull();
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
});
