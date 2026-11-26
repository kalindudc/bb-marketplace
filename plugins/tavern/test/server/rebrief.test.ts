// @vitest-environment node
import { fixtureActivity, patchThreadFixture, runtimeFixture } from "./member-fixture";
import { memberPlace } from "../../src/shared/member-place";
import { seedLegacyQuest, seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import { MEMBER_STATES } from "../../src/shared/schema";
import { registerTools } from "../../src/server/tools";
import { readStatus, statusInput } from "../../src/server/status";
import { rpcHandlers } from "../../src/server/rpc";
import { TavernRuntime } from "../../src/server/runtime";
import { makeThreadResponse } from "./host";
import { setup } from "./runtime-fixture";

const instruction = "Check the revised acceptance criteria";
function party(f = setup(), boardQuestId: string | null = null) {
  f.k.bind("child", "smith", "vale", "project", {
    keeperThreadId: "lead", boardQuestId, waypointId: null, errand: boardQuestId === null, title: "Task",
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

async function questParty() {
  const f = setup();
  const quest = await seedQuest(f.k, "lead", "Build", "Build");
  f.k.endTurn("lead");
  return party(f, quest.id);
}

describe("re-briefs after routing a user message", () => {
  it.each([
    ["rule", "Include a test summary in every pull request"],
    ["question", "How is work going?"],
    ["aside", "Thanks for the update"],
  ] as const)("delivers a quest brief after the %s route", async (kind, text) => {
    const f = await questParty();
    f.k.receiveUser("lead", text);
    f.k.route("lead", { kind, summary: text, notes: [] });

    await expect(f.tell()).resolves.toContain("Brief delivered to Pip");
    expect(told(f)).toHaveLength(1);
  });

  it.each(["steer", "new-quest"] as const)("still refuses a quest brief when a %s names only another quest", async kind => {
    const f = await questParty();
    const other = seedLegacyQuest(f.k, "lead", "Document", "Document");
    if (kind === "steer") {
      f.k.endTurn("lead");
      f.k.receiveUser("lead", "Document the changes too");
      f.k.route("lead", { kind, boardQuestId: other.id, summary: "Document the changes too", notes: [] });
    }
    f.k.receiveUser("lead", "Thanks");
    f.k.route("lead", { kind: "aside", summary: "Thanks", notes: [] });

    await expect(f.tell()).rejects.toThrow("The current routes do not name this board quest");
    expect(told(f)).toHaveLength(0);
  });

  it("still refuses a quest brief with an unrouted message pending", async () => {
    const f = await questParty();
    f.k.receiveUser("lead", "Thanks");
    f.k.route("lead", { kind: "aside", summary: "Thanks", notes: [] });
    f.k.receiveUser("lead", "Check the new requirement");

    await expect(f.tell()).rejects.toThrow('Route the oldest unrouted user message before changing a board quest: "Check the new requirement"');
    expect(told(f)).toHaveLength(0);
  });
});

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

  it("records a retry of the same brief after five failed sends and accepts a subsequent correction", async () => {
    const f = party();
    const send = vi.spyOn(f.bb.sdk.threads, "send");
    for (let n = 0; n < 5; n++) send.mockRejectedValueOnce(new Error("offline"));
    await f.tell();
    for (let n = 1; n < 5; n++) { f.advance(3_600_000); await f.runtime.retryInitialBriefs("lead"); }
    const old = runtimeFixture(f.k.store, "child").pendingBrief!;
    const [ask] = f.k.store.openAsks("lead");
    expect(old.attempts).toBe(5);
    expect(f.k.member("child")?.engagement).toBe("active");
    await f.runtime.answerAsk(ask!.id, "retry", null, "page", true);
    expect(briefSends(send)).toHaveLength(6);
    expect(JSON.stringify(briefSends(send)[5]![0])).toContain(old.id);
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toBeNull();
    await expect(f.runtime.tell("lead", "child", "Use the corrected criteria")).resolves.toMatchObject({ status: "delivered" });
    expect(f.k.member("child")?.doing).toBe("Use the corrected criteria");
    expect(f.k.store.events("lead", 0, 200)).toContainEqual(expect.objectContaining({ type: "member.brief-retried", data: expect.objectContaining({ briefId: old.id, askId: ask!.id }) }));
  });

  it("keeps checking a healthy queue without resending, then explicitly supersedes the named brief", async () => {
    const f = party();
    const send = vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValueOnce({ delivery: "queued" } as never);
    const oldDoing = f.k.member("child")!.doing;
    await f.tell();
    const old = runtimeFixture(f.k.store, "child").pendingBrief!;
    const row = makeQueueEntry({ id: "old-row", threadId: "child", originPluginId: "tavern", content: send.mock.calls[0]![0].input as never });
    const other = makeQueueEntry({ id: "user-row", threadId: "child", originPluginId: null });
    let rows = [row, other];
    const list = vi.spyOn(f.bb.sdk.threads.queuedMessages, "list").mockImplementation(async () => rows);
    const remove = f.bb.sdk.threads.queuedMessages.delete = vi.fn(async ({ queuedMessageId }: { queuedMessageId: string }) => {
      rows = rows.filter(row => row.id !== queuedMessageId);
      return { ok: true as const };
    });
    for (let n = 0; n < 6; n++) { f.advance(3_600_000); await f.runtime.retryInitialBriefs("lead"); }
    expect(briefSends(send)).toHaveLength(1);
    expect(f.k.member("child")).toMatchObject({ engagement: "active", doing: oldDoing });
    const corrected = (supersedeBriefId?: string) => f.harness.behavior.invokeAgentTool("tavern_tell", {
      memberThreadId: "child", text: "Only check the corrected criterion", ...(supersedeBriefId ? { supersedeBriefId } : {}),
    }, { threadId: "lead" });
    await expect(corrected()).rejects.toThrow(/A different brief is already pending/);
    await expect(corrected("obsolete-id")).rejects.toThrow(`supersedeBriefId: "${old.id}"`);
    expect(f.k.store.openAsks("lead")).toHaveLength(0);
    expect(list).toHaveBeenCalledTimes(6);
    expect(remove).not.toHaveBeenCalled();
    expect(await corrected(old.id)).toContain("Brief delivered to Pip");
    expect(rows).toEqual([other]);
    expect(remove).toHaveBeenCalledExactlyOnceWith({ threadId: "child", queuedMessageId: "old-row" });
    expect(f.k.store.openAsks("lead")).toHaveLength(0);
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toBeNull();
    expect(f.k.store.events("lead", 0, 200)).toContainEqual(expect.objectContaining({ type: "member.brief-superseded", data: expect.objectContaining({ oldBriefId: old.id, evidence: expect.objectContaining({ receipt: "queued", removedQueueIds: ["old-row"] }) }) }));
  });

  it("exposes a queued brief's identity, age and attempts next to the work actually running", async () => {
    const f = party();
    vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValueOnce({ delivery: "queued" } as never);
    const doing = f.k.member("child")!.doing;
    await f.runtime.tell("lead", "child", `${instruction}\nExtra detail`);
    const { id } = runtimeFixture(f.k.store, "child").pendingBrief!;
    f.advance(1000);
    const memberBriefs = [{ memberThreadId: "child", name: "Pip", doing, pendingBrief: { id, state: "queued", ageMs: 1000, attempts: 1, firstLine: instruction, createdAt: f.time() - 1000 } }];
    expect(readStatus(f.runtime, "lead", statusInput.parse({}))).toMatchObject({ memberBriefs });
    expect(rpcHandlers(f.runtime).ledger({ threadId: "lead" })).toMatchObject({ memberBriefs });
    expect(rpcHandlers(f.runtime).ledger({ threadId: "another-keeper" })).toMatchObject({ memberBriefs: [] });
    await expect(f.harness.behavior.invokeAgentTool("tavern_tell", { memberThreadId: "child", text: "Corrected work" }, { threadId: "lead" }))
      .rejects.toThrow(new RegExp(`Pip.*${id}.*queued.*1s.*supersedeBriefId`));
    expect(readStatus(f.runtime, "lead", statusInput.parse({ section: "pending", memberThreadId: "child" }))).toMatchObject({ memberBriefs, memberBriefTotal: 1 });
  });

  it("retries a failed bb queue row after five receipt checks instead of leaving corrected work blocked", async () => {
    const f = party();
    const send = vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValueOnce({ delivery: "queued" } as never);
    await f.tell();
    const old = runtimeFixture(f.k.store, "child").pendingBrief!;
    const row = makeQueueEntry({ id: "failed-row", threadId: "child", originPluginId: "tavern", failureReason: "offline", content: send.mock.calls[0]![0].input as never });
    let rows = [row], cancelReceiptPending = false;
    vi.spyOn(f.bb.sdk.threads.queuedMessages, "list").mockImplementation(async () => {
      if (cancelReceiptPending) { cancelReceiptPending = false; f.runtime.cancelled(row); }
      return rows;
    });
    f.bb.sdk.threads.queuedMessages.delete = async () => {
      rows = [];
      cancelReceiptPending = true;
      return { ok: true };
    };
    for (let n = 0; n < 5; n++) { f.advance(3_600_000); await f.runtime.retryInitialBriefs("lead"); }
    const [ask] = f.k.store.openAsks("lead");
    expect(ask?.effect).toMatchObject({ type: "retry-brief", briefId: old.id });
    await f.runtime.answerAsk(ask!.id, "retry", null, "page", true);
    await expect(f.runtime.tell("lead", "child", "Corrected work")).resolves.toMatchObject({ status: "delivered" });
    expect(rows).toEqual([]);
    expect(briefSends(send)).toHaveLength(3);
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toBeNull();
  });

  it("raises a blocker when bb lost a once-queued row and has no acceptance receipt", async () => {
    const f = party();
    const send = vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValueOnce({ delivery: "queued" } as never);
    await f.tell();
    for (let n = 0; n < 5; n++) { f.advance(3_600_000); await f.runtime.retryInitialBriefs("lead"); }
    expect(briefSends(send)).toHaveLength(1);
    expect(f.k.store.openAsks("lead")).toHaveLength(1);
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toMatchObject({ attempts: 1, receiptChecks: 5 });
  });

  it("keeps the prior assignment while waiting for a queued brief to dispatch", async () => {
    const f = party();
    const config = f.runtime.config();
    vi.spyOn(f.runtime, "config").mockReturnValue({ ...config, keepers: { ...config.keepers, briefRetryAttempts: 2 } });
    const send = vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValueOnce({ delivery: "queued" } as never);
    await f.tell();
    const old = runtimeFixture(f.k.store, "child").pendingBrief!;
    const row = makeQueueEntry({ id: "healthy", threadId: "child", originPluginId: "tavern", content: send.mock.calls[0]![0].input as never });
    vi.spyOn(f.bb.sdk.threads.queuedMessages, "list").mockResolvedValue([row]);
    reported(f);
    expect(f.k.member("child")?.engagement).toBe("briefing");
    expect(runtimeFixture(f.k.store, "child").pendingBrief?.id).toBe(old.id);
    f.advance(3_600_000);
    await f.runtime.retryInitialBriefs("lead");
    expect(f.k.store.openAsks("lead")).toHaveLength(0);
    f.advance(3_600_000);
    await f.runtime.retryInitialBriefs("lead");
    expect(briefSends(send)).toHaveLength(1);
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toMatchObject({ id: old.id, attempts: 1, receiptChecks: 0 });
    expect(f.k.store.openAsks("lead")).toHaveLength(0);
    f.runtime.dispatched(row);
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toBeNull();
    expect(rpcHandlers(f.runtime).ledger({ threadId: "lead" })).toMatchObject({ memberBriefs: [] });
    expect(f.k.member("child")).toMatchObject({ doing: instruction, engagement: "active" });
  });

  it("recovers from a failed receipt lookup without a blocker when the queued row is healthy", async () => {
    const f = party();
    const send = vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValueOnce({ delivery: "queued" } as never);
    await f.tell();
    const row = makeQueueEntry({ id: "healthy", threadId: "child", originPluginId: "tavern", content: send.mock.calls[0]![0].input as never });
    vi.spyOn(f.bb.sdk.threads.queuedMessages, "list").mockResolvedValue([row]);
    vi.spyOn(f.bb.sdk.threads.events, "list").mockRejectedValueOnce(new Error("Receipt lookup unavailable"));
    for (let n = 0; n < 2; n++) { f.advance(3_600_000); await f.runtime.retryInitialBriefs("lead"); }
    expect(briefSends(send)).toHaveLength(1);
    expect(f.k.store.openAsks("lead")).toEqual([]);
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toMatchObject({ state: "queued", receiptChecks: 0 });
  });

  it("raises one blocker when receipt lookups keep failing without resending the brief", async () => {
    const f = party();
    const attempts = f.runtime.config().keepers.briefRetryAttempts;
    const send = vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValueOnce({ delivery: "queued" } as never);
    await f.tell();
    const pending = runtimeFixture(f.k.store, "child").pendingBrief!;
    vi.spyOn(f.bb.sdk.threads.queuedMessages, "list").mockRejectedValue(new Error("Receipt lookup unavailable"));
    for (let n = 0; n < attempts; n++) {
      expect(f.k.store.openAsks("lead")).toHaveLength(0);
      f.advance(3_600_000);
      await f.runtime.retryInitialBriefs("lead");
    }
    expect(f.k.store.openAsks("lead")).toMatchObject([
      { question: expect.stringContaining("brief needs help"), effect: { type: "retry-brief", briefId: pending.id } },
    ]);
    f.advance(3_600_000);
    await f.runtime.retryInitialBriefs("lead");
    expect(f.k.store.openAsks("lead")).toHaveLength(1);
    expect(briefSends(send)).toHaveLength(1);
  });

  it("retries a host-cancelled row, without leaving it in the way of corrected work", async () => {
    const f = party();
    const send = vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValueOnce({ delivery: "queued" } as never);
    await f.tell();
    const old = runtimeFixture(f.k.store, "child").pendingBrief!;
    f.runtime.cancelled(makeQueueEntry({ id: "old-row", threadId: "child", originPluginId: "tavern", content: send.mock.calls[0]![0].input as never }));
    const [ask] = f.k.store.openAsks("lead");
    expect(ask?.effect).toMatchObject({ type: "retry-brief", briefId: old.id });
    await f.runtime.answerAsk(ask!.id, "retry", null, "page", true);
    expect(briefSends(send)).toHaveLength(2);
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toBeNull();
    await expect(f.runtime.tell("lead", "child", "Corrected work")).resolves.toMatchObject({ status: "delivered" });
    expect(f.k.store.events("lead", 0, 200)).toContainEqual(expect.objectContaining({ type: "member.brief-retried", data: expect.objectContaining({ briefId: old.id, askId: ask!.id }) }));
  });

  it("releases an exhausted brief and retires its blocker", async () => {
    const f = party();
    const config = f.runtime.config();
    vi.spyOn(f.runtime, "config").mockReturnValue({ ...config, keepers: { ...config.keepers, briefRetryAttempts: 1 } });
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValueOnce(new Error("offline"));
    await f.tell();
    const old = runtimeFixture(f.k.store, "child").pendingBrief!;
    const [ask] = f.k.store.openAsks("lead");
    f.bb.sdk.threads.stop = async () => ({ ok: true });
    await f.runtime.answerAsk(ask!.id, "release", null, "page", true);
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toBeNull();
    expect(f.k.member("child")).toMatchObject({ engagement: "archived", disposition: "released" });
    expect(f.k.store.events("lead", 0, 200)).toContainEqual(expect.objectContaining({ type: "member.release-requested", data: expect.objectContaining({ cancelledBriefId: old.id }) }));
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
