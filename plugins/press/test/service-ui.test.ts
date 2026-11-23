import { describe, expect, it } from "vitest";
import { threadStatusSchema } from "../src/contract";
import { composerConfigPath, emptyLedger, ledgerPath } from "../src/ledger";
import { compactedEvent, compactionRow, harness, root, threadId, userRow } from "./service-fake";

const summaryRelative = `.bb/press/threads/${threadId}/summaries/press-1.md`;

/** A composer ledger with one applied compaction that finished at `finishedAt`. */
function composerLedger(finishedAt: number) {
  const ledger = emptyLedger(threadId, new Date(finishedAt).toISOString());
  ledger.history.push({
    id: "press-1", at: new Date(finishedAt - 70_000).toISOString(), finishedAt, point: "manual", tokensBefore: 209_544,
    // pi reports no usage until an assistant answers after the compaction, so the composer never knows this.
    tokensAfter: null, model: "provider/model", ms: 70_000, summaryPath: summaryRelative, outcome: "ok",
  });
  return JSON.stringify(ledger);
}

describe("Press UI data plane", () => {
  it("serves the status contract from the store, usage and policy alone", async () => {
    const h = harness({ usedTokens: 300_000 });
    h.files.set(ledgerPath(root, threadId), composerLedger(h.clock.now()));
    const status = threadStatusSchema.parse(await h.service.buildThreadStatus(threadId));
    expect(status).toMatchObject({
      threadId, percent: 30, tokens: 300_000, window: 1_000_000, running: false, providerEnabled: true, mode: "auto", compacting: null, held: null,
      thresholds: { softPercent: 55, hardPercent: 80, floorTokens: 150_000 }, history: [], lastCompaction: null,
      totals: { count: 0, tokensFreed: 0, averageMs: null }, overrides: { mode: false, points: [] }, turnsSince: 0,
    });
    expect(status.estimateMs).toBeGreaterThan(0);
    expect(h.timeline).not.toHaveBeenCalled();
    expect(h.read.mock.calls.map(([args]) => args.path)).not.toContain(ledgerPath(root, threadId));
    expect(h.bb.sdk.threads.get).toHaveBeenCalledTimes(1);
  });

  it("joins a landing, the composer's report and the boundary into one history row, and serves its summary by id", async () => {
    const h = harness({ usedTokens: 3_227 });
    const landedAt = h.clock.now() - 60_000;
    h.rows.push(compactionRow(landedAt - 70_000, landedAt), userRow(landedAt + 5, "first-follow-up"));
    h.compactions.push(compactedEvent(42, landedAt + 2));
    h.files.set(ledgerPath(root, threadId), composerLedger(landedAt - 100));
    h.files.set(`${root}/${summaryRelative}`, "# Pressed context");
    await h.service.syncThread(threadId, {});

    const status = threadStatusSchema.parse(await h.service.buildThreadStatus(threadId));
    expect(status.history).toHaveLength(1);
    const [row] = status.history;
    expect(row).toMatchObject({
      point: "native", outcome: "ok", model: "provider/model", hasSummary: true, tokensBefore: 209_544, tokensAfter: 3_227,
      ms: 70_000, boundaryAt: landedAt + 5, boundaryMessageId: "first-follow-up",
    });
    expect(status.lastCompaction).toEqual(row);
    expect(status.totals).toEqual({ count: 1, tokensFreed: 209_544 - 3_227, averageMs: 70_000 });
    expect(status.boundaries).toEqual({ [String(landedAt + 5)]: 0, "message:first-follow-up": 0 });

    expect(await h.service.summary(threadId, row.id)).toEqual({ markdown: "# Pressed context" });
    expect(h.read).toHaveBeenLastCalledWith({ path: `${root}/${summaryRelative}`, hostId: "host_test" });
    expect(await h.service.summary("thr_other", row.id)).toEqual({ markdown: null });
    expect(await h.service.summary(threadId, "cmp_missing")).toEqual({ markdown: null });
    h.files.delete(`${root}/${summaryRelative}`);
    expect(await h.service.summary(threadId, row.id)).toEqual({ markdown: null });
  });

  it("serves the lowest percent at which an enabled point may fire", async () => {
    const h = harness();
    expect(threadStatusSchema.parse(await h.service.buildThreadStatus(threadId)).pointsFromPercent).toBe(55);
    h.settings.idlePoint = true;
    expect(threadStatusSchema.parse(await h.service.buildThreadStatus(threadId)).pointsFromPercent).toBe(25);
    Object.assign(h.settings, { idlePoint: false, phasePoint: false, agentPoint: false, volumePoint: false, softPercent: 40 });
    expect(threadStatusSchema.parse(await h.service.buildThreadStatus(threadId)).pointsFromPercent).toBe(40);
  });

  it("reports the newest landed compaction as the last one, not a newer failed attempt", async () => {
    const h = harness({ usedTokens: 300_000 });
    const landed = h.store.recordLanding(threadId, { startedAt: h.clock.now() - 10_000, finishedAt: h.clock.now() - 9_000 });
    const failed = h.store.insertCompaction({
      threadId, decisionId: null, requestedAt: h.clock.now() - 1_000, point: "phase", reason: "tests.green", mode: "auto", provider: "pi", tokensBefore: 300_000,
    });
    h.store.failCompaction(failed.id, "failed", h.clock.now(), "refused");
    const status = threadStatusSchema.parse(await h.service.buildThreadStatus(threadId));
    expect(status.history.map((row) => row.id)).toEqual([failed.id, landed.id]);
    expect(status.history[0]).toMatchObject({ outcome: "failed", error: "refused", hasSummary: false });
    expect(status.lastCompaction?.id).toBe(landed.id);
  });

  it("publishes the composer config per thread, and only when it changes", async () => {
    const h = harness({ usedTokens: 100_000, settings: { composerModel: "provider/fast" } });
    const path = composerConfigPath(root, threadId);
    h.files.set(path, "{}");
    await h.service.evaluate(threadId, { origin: "idle" });
    expect(JSON.parse(h.files.get(path) ?? "null")).toMatchObject({
      model: "provider/fast", maxSummaryTokens: 3000, ledger: true, resumeContract: true, updatedAt: new Date(h.clock.now()).toISOString(),
    });
    expect([...h.files.keys()].filter((key) => key.endsWith(".tmp"))).toEqual([]);
    const writes = h.write.mock.calls.length;
    await h.service.evaluate(threadId, { origin: "idle" });
    expect(h.write).toHaveBeenCalledTimes(writes);
    h.settings.composerModel = "provider/other";
    await h.service.republishComposerConfigs();
    expect(JSON.parse(h.files.get(path) ?? "null")).toMatchObject({ model: "provider/other" });
    expect(h.files.has(ledgerPath(root, threadId))).toBe(false);
  });

  it("returns effective controls and overrides, and resets them", async () => {
    const h = harness({ usedTokens: 100_000 });
    h.store.setThreadPolicyOverride(threadId, '{"vetoes":{"cooldownSeconds":12}}');
    expect(await h.service.setThreadMode(threadId, "observe")).toEqual({ mode: "observe" });
    expect(await h.service.setThreadPoint(threadId, "idle", true)).toEqual({
      points: { phase: true, agent: true, volume: true, turns: false, idle: true, thrash: false },
    });
    expect(JSON.parse(h.store.threadPolicyOverride(threadId) ?? "null")).toEqual({
      mode: "observe", pointOverrides: { idle: true }, vetoes: { cooldownSeconds: 12 },
    });
    expect(threadStatusSchema.parse(await h.service.buildThreadStatus(threadId)).overrides).toEqual({ mode: true, points: ["idle"] });
    expect(await h.service.resetThread(threadId)).toEqual({ ok: true });
    const reset = threadStatusSchema.parse(await h.service.buildThreadStatus(threadId));
    expect(reset.overrides).toEqual({ mode: false, points: [] });
    expect(reset.mode).toBe("auto");
    expect(h.timeline).not.toHaveBeenCalled();
  });

  it("compacts on request even when a veto would block, once at a time", async () => {
    const h = harness({ usedTokens: 10 });
    h.store.recordAttempt(threadId, h.clock.now() - 1_000, true);
    const first = h.service.compactNow(threadId);
    expect(await h.service.compactNow(threadId)).toMatchObject({ ok: false, message: expect.stringMatching(/already/i) });
    expect(await first).toEqual({ ok: true, message: "Compaction requested." });
    expect(await h.service.compactNow(threadId)).toMatchObject({ ok: false, message: expect.stringMatching(/already/i) });
    expect(h.compact).toHaveBeenCalledTimes(1);
    expect(h.store.decisions({ threadId, limit: 1 })[0]).toMatchObject({ origin: "manual", point: "manual", mode: "auto" });
    expect(h.store.pendingCompactions(threadId)[0]).toMatchObject({ point: "manual", reason: "manual" });
  });

  it("refuses busy and disabled providers, and reports a provider refusal as a failed attempt", async () => {
    const h = harness();
    h.thread.status = "active";
    expect(await h.service.compactNow(threadId)).toMatchObject({ ok: false, message: expect.stringMatching(/idle/i) });
    h.thread.status = "idle";
    h.store.setThreadPolicyOverride(threadId, '{"providers":{"pi":{"enabled":false}}}');
    expect(await h.service.compactNow(threadId)).toMatchObject({ ok: false, message: expect.stringMatching(/disabled/i) });
    expect(h.compact).not.toHaveBeenCalled();
    h.store.setThreadPolicyOverride(threadId, null);
    h.compact.mockRejectedValueOnce(new Error("Provider does not support manual compaction"));
    expect(await h.service.compactNow(threadId)).toEqual({ ok: false, message: "Provider does not support manual compaction" });
    expect(h.compact).toHaveBeenCalledTimes(1);
    expect(h.store.threadState(threadId).lastCompactionFailed).toBe(true);
  });
});
