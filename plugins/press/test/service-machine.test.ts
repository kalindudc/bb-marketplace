import { describe, expect, it, vi } from "vitest";
import { threadStatusSchema } from "../src/contract";
import { DECISION_TTL_MS, PENDING_TTL_MS } from "../src/service";
import { commandRow, compactedEvent, compactionRow, flush, harness, threadId, userRow } from "./service-fake";

const MINUTE = 60_000;

describe("Press compaction state machine", () => {
  it("auto mode requests a compaction when a turn ends past the hard window", async () => {
    const h = harness({ usedTokens: 850_000 });
    h.emit("thread.idle", { thread: { ...h.thread }, lastAssistantText: null });
    await vi.waitFor(() => expect(h.compact).toHaveBeenCalledWith({ threadId }));
    await flush();
    const [pending] = h.store.pendingCompactions(threadId);
    expect(pending).toMatchObject({ point: "window", reason: "window.hard", tokensBefore: 850_000 });
    expect(h.store.decisions({ threadId, limit: 5 })).toEqual([expect.objectContaining({ decision: "compact", origin: "idle", point: "window" })]);
    const status = threadStatusSchema.parse(await h.service.buildThreadStatus(threadId));
    expect(status.compacting).toMatchObject({ point: "window" });
    expect(status.history[0]).toMatchObject({ outcome: "pending", reason: "window.hard" });
    expect(status.lastCompaction).toBeNull();
  });

  it("re-reads the thread before compacting and refuses a thread that is no longer idle", async () => {
    const h = harness({ usedTokens: 850_000 });
    h.current.status = "starting";
    const result = await h.service.evaluate(threadId, { origin: "idle", thread: { ...h.thread } });
    expect(result.acted).toBe(false);
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.store.pendingCompactions(threadId)).toEqual([]);
    expect(h.store.decisions({ threadId, limit: 1 })[0]).toMatchObject({ outcome: "cancelled" });
    expect(h.store.threadState(threadId).lastCompactionFailed).toBe(false);
  });

  it("records a refused request as a failed attempt and does not retry it on the next sweeps", async () => {
    const h = harness({ usedTokens: 850_000 });
    h.compact.mockRejectedValue(new Error("Provider does not support manual compaction"));
    await h.service.sweep();
    expect(h.compact).toHaveBeenCalledTimes(1);
    const state = h.store.threadState(threadId);
    expect(state).toMatchObject({ lastCompactionFailed: true, lastCompactionAt: h.clock.now() });
    expect(h.store.compactionsOf(threadId, 5)[0]).toMatchObject({ outcome: "failed", error: "Provider does not support manual compaction" });

    for (let index = 0; index < 3; index += 1) {
      h.clock.advance(MINUTE);
      await h.service.sweep();
    }
    expect(h.compact).toHaveBeenCalledTimes(1);
    const decisions = h.store.decisions({ threadId, limit: 10 });
    expect(decisions.map((row) => [row.decision, row.reason])).toEqual([["veto", "cooldownSeconds"], ["compact", "window.hard"]]);
    const status = threadStatusSchema.parse(await h.service.buildThreadStatus(threadId));
    expect(status.blockers.map((blocker) => blocker.veto)).toEqual(expect.arrayContaining(["cooldownSeconds", "previousCompactionFailed"]));
    expect(status.lastCompaction).toBeNull();
    expect(status.history[0]).toMatchObject({ outcome: "failed" });
  });

  it("fails a pending request when the thread fails", async () => {
    const h = harness({ usedTokens: 850_000 });
    await h.service.evaluate(threadId, { origin: "idle" });
    expect(h.store.pendingCompactions(threadId)).toHaveLength(1);
    h.emit("thread.failed", { thread: { ...h.thread, status: "error" }, error: "provider crashed" });
    await vi.waitFor(() => expect(h.store.pendingCompactions(threadId)).toHaveLength(0));
    expect(h.store.compactionsOf(threadId, 1)[0]).toMatchObject({ outcome: "failed", error: "provider crashed" });
    expect(h.store.threadState(threadId).lastCompactionFailed).toBe(true);
    expect(h.store.decisions({ threadId, limit: 1 })[0]).toMatchObject({ outcome: "failed" });
  });

  it("settles a request that landed instead of failing it when the thread fails afterwards", async () => {
    const h = harness({ usedTokens: 850_000 });
    await h.service.evaluate(threadId, { origin: "idle" });
    h.compactions.push(compactedEvent(7, h.clock.now() + 1_000));
    h.emit("thread.failed", { thread: { ...h.thread, status: "error" }, error: "later failure" });
    await vi.waitFor(() => expect(h.store.pendingCompactions(threadId)).toHaveLength(0));
    expect(h.store.compactionsOf(threadId, 1)[0]).toMatchObject({ outcome: "ok", landedAt: h.clock.now() + 1_000 });
  });

  it("gives up a request that has not landed after 30 minutes", async () => {
    const h = harness({ usedTokens: 850_000 });
    await h.service.evaluate(threadId, { origin: "idle" });
    h.clock.advance(PENDING_TTL_MS - MINUTE);
    await h.service.sweep();
    expect(h.store.pendingCompactions(threadId)).toHaveLength(1);
    h.clock.advance(2 * MINUTE);
    await h.service.sweep();
    expect(h.store.pendingCompactions(threadId)).toHaveLength(0);
    expect(h.store.compactionsOf(threadId, 1)[0]).toMatchObject({ outcome: "cancelled", error: "pending compaction timed out" });
    expect(h.store.threadState(threadId).lastCompactionFailed).toBe(true);
    expect(h.compact).toHaveBeenCalledTimes(1);
  });

  it("records a native landing, which clears the failure flag and the turn counter", async () => {
    const h = harness({ usedTokens: 300_000 });
    h.store.bumpTurns(threadId);
    h.store.recordAttempt(threadId, h.clock.now() - 5 * MINUTE, true);
    const landedAt = h.clock.now() - MINUTE;
    h.rows.push(compactionRow(landedAt - 2_000, landedAt));
    h.compactions.push(compactedEvent(42, landedAt + 5));
    await h.service.evaluate(threadId, { origin: "idle" });
    const [row] = h.store.compactionsOf(threadId, 5);
    expect(row).toMatchObject({ method: "native", point: "native", outcome: "ok", requestedAt: landedAt - 2_000 });
    expect(h.store.compactionsOf(threadId, 5)).toHaveLength(1);
    expect(h.store.threadState(threadId)).toMatchObject({ turnsSince: 0, lastCompactionFailed: false });
    const status = threadStatusSchema.parse(await h.service.buildThreadStatus(threadId));
    expect(status.lastCompaction).toMatchObject({ point: "native", outcome: "ok", ms: 2_005 });
    expect(status.blockers.map((blocker) => blocker.veto)).not.toContain("previousCompactionFailed");
  });

  it("the tool records a hint without compacting; the turn's end compacts on it", async () => {
    const h = harness({ usedTokens: 600_000 });
    h.thread.status = "active";
    h.store.bumpTurns(threadId);
    h.store.bumpTurns(threadId);
    const reply = await h.service.compactionPoint(threadId);
    expect(reply).toMatch(/when this turn ends/);
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.store.pendingHints(threadId)).toHaveLength(1);
    expect(h.store.decisions({ threadId, limit: 5 })).toEqual([]);

    h.thread.status = "idle";
    h.emit("thread.idle", { thread: { ...h.thread }, lastAssistantText: null });
    await vi.waitFor(() => expect(h.compact).toHaveBeenCalledTimes(1));
    await flush();
    expect(h.store.pendingCompactions(threadId)[0]).toMatchObject({ point: "agent", reason: "agentHint" });
    expect(h.store.pendingHints(threadId)).toHaveLength(0);
  });

  it("keeps a hint that only the midTurn veto blocked", async () => {
    const h = harness({ usedTokens: 600_000 });
    h.thread.status = "active";
    h.store.bumpTurns(threadId);
    h.store.bumpTurns(threadId);
    h.store.recordHint({ threadId, at: h.clock.now(), reason: "bb press point" });
    const result = await h.service.evaluate(threadId, { origin: "cli" });
    expect(result.decision).toMatchObject({ decision: "veto", point: "agent", reason: "midTurn" });
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.store.pendingHints(threadId)).toHaveLength(1);
  });

  it("consumes a hint a different veto blocked", async () => {
    const h = harness({ usedTokens: 600_000 });
    h.store.recordHint({ threadId, at: h.clock.now(), reason: "bb press point" });
    const result = await h.service.evaluate(threadId, { origin: "idle" });
    expect(result.decision).toMatchObject({ decision: "veto", point: "agent", reason: "minTurnsBetween" });
    expect(h.store.pendingHints(threadId)).toHaveLength(0);
  });

  it("writes one decision row while a thread keeps saying the same thing, and prunes old rows", async () => {
    const h = harness({ usedTokens: 850_000, settings: { mode: "advisor" } });
    h.store.recordDecision({
      at: h.clock.now() - DECISION_TTL_MS - 1, threadId: "thr_old", mode: "auto", origin: "sweep",
      decision: { decision: "veto", point: "phase", reason: "midTurn", percent: 1, tokens: 1, window: 100, estMs: 0, estCostUsd: 0 },
    });
    for (let index = 0; index < 3; index += 1) {
      await h.service.sweep();
      h.clock.advance(MINUTE);
    }
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.store.decisions({ limit: 10 })).toEqual([expect.objectContaining({ threadId, decision: "compact", point: "window", mode: "advisor" })]);
    expect(h.log.info.mock.calls.filter(([line]) => String(line).startsWith("proposes"))).toHaveLength(1);
  });

  it("does not read the timeline again while the thread has not changed", async () => {
    const h = harness({ usedTokens: 850_000, settings: { mode: "advisor" } });
    await h.service.sweep();
    await h.service.sweep();
    await h.service.sweep();
    expect(h.timeline).toHaveBeenCalledTimes(1);
    h.thread.updatedAt += 1_000;
    await h.service.sweep();
    expect(h.timeline).toHaveBeenCalledTimes(2);
  });

  it("gates the sweep with the workspace policy layer", async () => {
    const h = harness({ usedTokens: 200_000, settings: { mode: "advisor" } });
    await h.service.sweep();
    expect(h.store.decisions({ threadId, limit: 5 })).toEqual([]);
    h.files.set("/workspace/.bb/press/policy.json", JSON.stringify({
      points: [{ id: "early", enabled: true, when: "idleSeconds", value: 0, minPercent: 10 }],
    }));
    h.clock.advance(5 * MINUTE);
    await h.service.sweep();
    expect(h.store.decisions({ threadId, limit: 5 })[0]).toMatchObject({ point: "early" });
  });

  it("anchors a landed request on its first message, then stops reading the timeline", async () => {
    const h = harness({ usedTokens: 850_000 });
    await h.service.evaluate(threadId, { origin: "idle" });
    const [pending] = h.store.pendingCompactions(threadId);
    const landedAt = h.clock.now() + 30_000;
    h.clock.set(landedAt + 1_000);
    h.rows.push(compactionRow(landedAt - 20_000, landedAt));
    h.usage.usedTokens = 40_000;
    await h.service.syncThread(threadId, {});
    expect(h.store.compaction(pending.id)).toMatchObject({ outcome: "ok", landedAt, tokensAfter: 40_000, boundaryAt: null });

    h.rows.push(userRow(landedAt + 5_000, "after"));
    h.thread.updatedAt = landedAt + 5_000;
    await h.service.syncThread(threadId, {});
    expect(h.store.compaction(pending.id)).toMatchObject({ boundaryAt: landedAt + 5_000, boundaryMessageId: "after" });
    const reads = h.timeline.mock.calls.length;
    h.thread.updatedAt += 1_000;
    await h.service.syncThread(threadId, {});
    expect(h.timeline).toHaveBeenCalledTimes(reads);
    const status = threadStatusSchema.parse(await h.service.buildThreadStatus(threadId));
    expect(status.history[status.boundaries["message:after"]]).toMatchObject({ id: pending.id });
  });
});

describe("boundary signals fire once", () => {
  it("does not fire on a tests.green that finished before the last compaction attempt", async () => {
    const h = harness({ usedTokens: 600_000, settings: { mode: "advisor" } });
    h.rows.push(commandRow(h.clock.now() - 20 * MINUTE, "npm test"));
    h.store.recordAttempt(threadId, h.clock.now() - 15 * MINUTE, true);
    h.store.bumpTurns(threadId);
    h.store.bumpTurns(threadId);
    const result = await h.service.evaluate(threadId, { origin: "idle" });
    expect(result.decision.decision).toBe("skip");
  });

  it("does not fire on a tests.green from an earlier turn when a later turn crosses the soft window", async () => {
    const h = harness({ usedTokens: 400_000, settings: { mode: "advisor" } });
    h.store.bumpTurns(threadId);
    h.store.bumpTurns(threadId);
    h.rows.push(commandRow(h.thread.updatedAt - 5_000, "npm test", { turnId: "turn-1" }));
    expect((await h.service.evaluate(threadId, { origin: "idle" })).decision.decision).toBe("skip");
    h.rows.push(commandRow(h.thread.updatedAt + 1_000, "ls", { turnId: "turn-2" }));
    h.thread.updatedAt += 2_000;
    h.usage.usedTokens = 600_000;
    h.clock.advance(MINUTE);
    expect((await h.service.evaluate(threadId, { origin: "idle" })).decision.decision).toBe("skip");
    expect(threadStatusSchema.parse(await h.service.buildThreadStatus(threadId)).nextPoint).toBeNull();
  });

  it("fires a phase signal for one proposal, and again only on a newer one", async () => {
    const h = harness({ usedTokens: 600_000, settings: { mode: "advisor" } });
    h.store.bumpTurns(threadId);
    h.store.bumpTurns(threadId);
    h.rows.push(commandRow(h.thread.updatedAt - 500, "npm test"));
    expect((await h.service.evaluate(threadId, { origin: "idle" })).decision).toMatchObject({ decision: "compact", reason: "tests.green" });
    h.clock.advance(MINUTE);
    expect((await h.service.evaluate(threadId, { origin: "sweep" })).decision.decision).toBe("skip");
    expect(threadStatusSchema.parse(await h.service.buildThreadStatus(threadId)).nextPoint).toBeNull();
    h.rows.push(commandRow(h.clock.now(), "npx vitest run"));
    h.thread.updatedAt = h.clock.now() + 10;
    h.clock.advance(MINUTE);
    expect((await h.service.evaluate(threadId, { origin: "idle" })).decision).toMatchObject({ decision: "compact", reason: "tests.green" });
  });
});

describe("landing details", () => {
  it("fills tokensAfter from the first usage reading after the landing that is real and lower", async () => {
    const h = harness({ usedTokens: 850_000 });
    await h.service.evaluate(threadId, { origin: "idle" });
    const [pending] = h.store.pendingCompactions(threadId);
    h.compactions.push(compactedEvent(5, h.clock.now() + 1_000));
    h.clock.advance(2_000);
    await h.service.syncThread(threadId, {});
    expect(h.store.compaction(pending.id)).toMatchObject({ outcome: "ok", tokensAfter: null });
    h.usage.usedTokens = 30_000;
    h.usage.estimated = true;
    h.clock.advance(15_000);
    await h.service.syncThread(threadId, {});
    expect(h.store.compaction(pending.id)?.tokensAfter).toBeNull();
    h.usage.estimated = false;
    h.clock.advance(15_000);
    await h.service.syncThread(threadId, {});
    expect(h.store.compaction(pending.id)?.tokensAfter).toBe(30_000);
  });

  it("settles a pending request on a failed compaction row in the timeline", async () => {
    const h = harness({ usedTokens: 850_000 });
    await h.service.evaluate(threadId, { origin: "idle" });
    const [pending] = h.store.pendingCompactions(threadId);
    h.rows.push(compactionRow(h.clock.now() + 100, h.clock.now() + 900, "error"));
    h.clock.advance(1_000);
    await h.service.syncThread(threadId, {});
    expect(h.store.compaction(pending.id)).toMatchObject({ outcome: "failed", landedAt: h.clock.now() - 100, error: "the compaction failed" });
  });

  it("logs a refused request once", async () => {
    const h = harness({ usedTokens: 850_000 });
    h.compact.mockRejectedValue(new Error("refused"));
    await h.service.evaluate(threadId, { origin: "idle" });
    expect(h.log.warn.mock.calls.filter(([line]) => String(line).includes("refused"))).toHaveLength(1);
  });

  it("estimates a decision with the thread's measured rate, the same as the status", async () => {
    const h = harness({ usedTokens: 850_000, settings: { mode: "advisor" } });
    const cmp = h.store.insertCompaction({
      threadId, decisionId: null, requestedAt: h.clock.now() - 3 * 60 * MINUTE, point: "window", reason: "window.hard", mode: "auto", provider: "pi", tokensBefore: 100_000,
    });
    h.store.recordLanding(threadId, { startedAt: h.clock.now() - 3 * 60 * MINUTE, finishedAt: h.clock.now() - 3 * 60 * MINUTE + 10_000 });
    expect(h.store.compaction(cmp.id)?.outcome).toBe("ok");
    const result = await h.service.evaluate(threadId, { origin: "idle" });
    const status = threadStatusSchema.parse(await h.service.buildThreadStatus(threadId));
    expect(result.decision.estMs).toBe(85_000);
    expect(status.estimateMs).toBe(85_000);
  });
});

describe("the sweep's cost", () => {
  it("does not evaluate an idle thread below the token floor when only the hard window could act", async () => {
    const h = harness({ usedTokens: 120_000, settings: { mode: "advisor" } });
    h.usage.modelContextWindow = 200_000;
    await h.service.sweep();
    expect(h.timeline).not.toHaveBeenCalled();
    expect(h.store.decisions({ threadId, limit: 5 })).toEqual([]);
    h.usage.usedTokens = 170_000;
    await h.service.sweep();
    expect(h.store.decisions({ threadId, limit: 5 })[0]).toMatchObject({ point: "window" });
  });

  it("reads the usage first and the policy files at most every five minutes", async () => {
    const h = harness({ usedTokens: null });
    const policyReads = () => h.read.mock.calls.filter(([args]) => args.path.endsWith("policy.json")).length;
    await h.service.sweep();
    expect(policyReads()).toBe(0);
    h.usage.available = true;
    h.usage.usedTokens = 100_000;
    await h.service.sweep();
    expect(policyReads()).toBe(1);
    h.clock.advance(MINUTE);
    await h.service.sweep();
    expect(policyReads()).toBe(1);
  });

  it("warns about an inverted window once, not on every resolution", async () => {
    const h = harness({ settings: { softPercent: 90, hardPercent: 80 } });
    for (let index = 0; index < 3; index += 1) await h.service.buildThreadStatus(threadId);
    expect(h.log.warn.mock.calls.filter(([line]) => String(line).includes("exceeds"))).toHaveLength(1);
  });

  it("a settings change rewrites only composer configs that changed", async () => {
    const h = harness({ usedTokens: 100_000 });
    await h.service.evaluate(threadId, { origin: "idle" });
    const writes = h.write.mock.calls.length;
    h.settings.softPercent = 40;
    await h.service.republishComposerConfigs();
    expect(h.write).toHaveBeenCalledTimes(writes);
  });
});

describe("the compaction_point tool", () => {
  it("records the agent's note as the hint's reason", async () => {
    const h = harness({ usedTokens: 100_000 });
    await h.service.compactionPoint(threadId, "tests green on the parser");
    expect(h.store.pendingHints(threadId)[0]).toMatchObject({ reason: "tests green on the parser" });
    await h.service.compactionPoint(threadId, "");
    expect(h.store.pendingHints(threadId)[1]).toMatchObject({ reason: "agent hint (tool)" });
  });

  it("previews the turn end with the turn that is ending counted", async () => {
    const h = harness({ usedTokens: 600_000 });
    h.thread.status = "active";
    h.store.bumpTurns(threadId);
    expect(await h.service.compactionPoint(threadId, "")).toMatch(/will compact this thread when this turn ends/);
  });

  it("says a hint a veto blocks at the turn end is dropped", async () => {
    const h = harness({ usedTokens: 600_000 });
    h.thread.status = "active";
    h.store.recordAttempt(threadId, h.clock.now() - 1_000, false);
    const reply = await h.service.compactionPoint(threadId, "");
    expect(reply).toMatch(/cooldownSeconds/);
    expect(reply).toMatch(/dropped/);
    expect(reply).not.toMatch(/stays recorded/);
  });
});
