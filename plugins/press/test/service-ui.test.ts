import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { threadStatusSchema } from "../src/contract";
import { emptyLedger, ledgerPath, parseLedger } from "../src/ledger";
import { PressService } from "../src/service";
import { boundaryEntry } from "../src/ui/model";
import { MIGRATIONS, PressStore } from "../src/store";

const threadId = "thr_test";
const now = Date.parse("2026-11-22T01:00:00.000Z");
const finishedAt = now - 60_000;
const at = new Date(finishedAt - 10).toISOString();
const root = "/workspace";
const path = ledgerPath(root);
const summaryPath = ".bb/press/summaries/press-example.md";

let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); });
afterEach(() => { db.close(); });

function setup() {
  for (const statement of MIGRATIONS) db.exec(statement);
  const store = new PressStore(db);
  const ledger = emptyLedger(threadId, at);
  ledger.history.push({
    id: "press-example", at, point: "manual", tokensBefore: 209_544, tokensAfter: 3_227, model: "provider/model",
    ms: 78_600, keptTurns: null, summaryHash: "", summaryPath,
  });
  const files = new Map([[path, JSON.stringify(ledger)], [`${root}/${summaryPath}`, "# Pressed context"]]);
  const read = vi.fn(async ({ path }: { path: string }) => {
    const content = files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return { content };
  });
  const thread = { id: threadId, environmentId: "env_test", providerId: "pi", status: "idle", updatedAt: now };
  const rows: object[] = [{ kind: "system", operationKind: "compaction", status: "completed", startedAt: finishedAt - 1000,
    completedAt: finishedAt, sourceSeqEnd: 42 }];
  const timeline = vi.fn(async () => ({ rows }));
  const compactionEvents: Array<{ seq: number; createdAt: number }> = [];
  const listEvents = vi.fn(async () => compactionEvents);
  const context = { available: true };
  const invalidate = vi.fn();
  const compact = vi.fn(async () => undefined);
  const usage = { modelContextWindow: 1_000_000, usedTokens: 3_227 };
  const bb = {
    sdk: {
      threads: { list: async () => [thread], get: async () => thread,
        context: async () => ({ usage: context.available ? usage : null }), timeline, compact, events: { list: listEvents } },
      environments: { get: async () => ({ path: root, hostId: "host_test" }) },
      files: {
        read, mkdir: async () => undefined,
        write: async ({ path, content }: { path: string; content: string }) => { files.set(path, content); },
      },
    },
    server: { experimental_dataDir: "/press-test-no-user-policy" },
    rpc: { experimental_invalidate: invalidate },
    log: { info: vi.fn(), warn: vi.fn() },
  } as unknown as BbPluginApi;
  return { service: new PressService(bb, store, () => now), store, files, rows, timeline, invalidate, read, compact, usage, compactionEvents, listEvents, context, thread };
}

describe("Press UI data plane", () => {
  it("backfills a native compaction without a composer ledger or usage, then anchors it on the next visible message", async () => {
    const { service, files, rows, timeline, compact, compactionEvents, listEvents, context } = setup();
    files.delete(path);
    context.available = false;
    compactionEvents.push({ seq: 42, createdAt: finishedAt });
    await service.sweep();
    expect(listEvents).toHaveBeenCalledWith({ threadId, types: ["thread/compacted"], limit: "1", order: "desc" });
    const first = threadStatusSchema.parse(await service.buildThreadStatus(threadId));
    expect(first.history).toHaveLength(1);
    expect(first.lastCompaction).toMatchObject({ point: "native", outcome: "ok", ms: 1000,
      tokensBefore: null, tokensAfter: null, summaryPath: null, boundaryAt: null });
    rows.push({ id: "first-follow-up", kind: "conversation", role: "user", createdAt: finishedAt + 5 });
    await service.sweep();
    const second = threadStatusSchema.parse(await service.buildThreadStatus(threadId));
    expect(second.history).toHaveLength(1);
    expect(boundaryEntry(second, { id: "first-follow-up", createdAt: finishedAt + 5 })).toEqual(second.lastCompaction);
    await service.sweep();
    expect(timeline).toHaveBeenCalledTimes(2);
    expect(compact).not.toHaveBeenCalled();
  });

  it("does not duplicate native operations that already have a composer summary or a Press request", async () => {
    const { service, store, files } = setup();
    await service.evaluate(threadId, { origin: "events" });
    const composer = await service.buildThreadStatus(threadId);
    expect(composer.history).toHaveLength(1);
    expect(composer.lastCompaction?.summaryPath).toBe(summaryPath);

    const requested = store.insertCompaction({ threadId, decisionId: null, requestedAt: finishedAt - 1001,
      point: "window", mode: "auto", provider: "pi", method: "compact", instructionsHash: null, tokensBefore: 12000 });
    files.delete(path);
    await service.evaluate(threadId, { origin: "events" });
    const managed = await service.buildThreadStatus(threadId);
    expect(managed.history).toHaveLength(1);
    expect(managed.lastCompaction).toMatchObject({ id: requested.id, point: "window", outcome: "ok" });
  });
  it("waits for a post-compaction message, then persists the exact boundary and stops fetching the timeline", async () => {
    const { service, files, rows, timeline, invalidate } = setup();
    expect(threadStatusSchema.parse(await service.buildThreadStatus(threadId)).lastCompaction?.boundaryAt).toBeNull();
    expect(timeline).not.toHaveBeenCalled();
    rows.push({ kind: "conversation", role: "user", createdAt: finishedAt - 5 });
    await service.sweep();
    expect(timeline).toHaveBeenCalledTimes(1);
    expect(parseLedger(files.get(path) ?? null)?.history[0].boundaryAt).toBeUndefined();
    rows.push({ id: "assistant-message", kind: "conversation", role: "assistant", startedAt: finishedAt + 2, createdAt: finishedAt + 5 });
    await service.sweep();
    expect(timeline).toHaveBeenCalledTimes(2);
    expect(parseLedger(files.get(path) ?? null)?.history[0].boundaryAt).toBe(finishedAt + 5);
    expect(invalidate).toHaveBeenCalledWith([`status:${threadId}`]);
    const status = threadStatusSchema.parse(await service.buildThreadStatus(threadId));
    expect(status.lastCompaction).toMatchObject({ boundaryAt: finishedAt + 5, boundaryMessageId: "assistant-message", summaryPath });
    expect(status.history[status.boundaries[finishedAt + 5]]).toEqual(status.lastCompaction);
    expect(status.history[status.boundaries["message:assistant-message"]]).toEqual(status.lastCompaction);
    expect(boundaryEntry(status, { id: "assistant-message", createdAt: finishedAt + 2 })).toEqual(status.lastCompaction);
    expect(boundaryEntry(status, { id: "other-message", createdAt: finishedAt + 5 })).toBeNull();
    await service.sweep();
    expect(timeline).toHaveBeenCalledTimes(2);
  });

  it("reads just the selected summary on the workspace host, preserving the path when the file is absent", async () => {
    const { service, read, files, timeline } = setup();
    expect(await service.summary(threadId, at)).toEqual({ markdown: "# Pressed context", path: summaryPath });
    expect(read).toHaveBeenLastCalledWith({ path: `${root}/${summaryPath}`, hostId: "host_test" });
    files.delete(`${root}/${summaryPath}`);
    expect(await service.summary(threadId, at)).toEqual({ markdown: null, path: summaryPath });
    expect(await service.summary("thr_other", at)).toEqual({ markdown: null, path: null });
    expect(timeline).not.toHaveBeenCalled();
  });

  it("returns effective controls, preserves overrides, and only bypasses scheduling for explicit manual requests", async () => {
    const { service, store, timeline, compact, usage } = setup();
    store.setThreadPolicyOverride(threadId, '{"vetoes":{"cooldownSeconds":12}}');
    expect(await service.setThreadMode(threadId, "observe")).toEqual({ mode: "observe" });
    expect(await service.setThreadPoint(threadId, "idle", false)).toEqual({
      points: { phase: true, agent: true, volume: true, turns: true, idle: false, thrash: true },
    });
    expect(JSON.parse(store.threadPolicyOverride(threadId) ?? "null")).toEqual({
      mode: "observe", pointOverrides: { idle: false }, vetoes: { cooldownSeconds: 12 },
    });
    expect(timeline).not.toHaveBeenCalled();
    usage.usedTokens = 900_000;
    expect((await service.evaluate(threadId, { origin: "cli" })).acted).toBe(false);
    expect(compact).not.toHaveBeenCalled();
    usage.usedTokens = 10;
    store.resetTurns(threadId, now - 1000, true);
    const first = service.compactNow(threadId);
    expect(await service.compactNow(threadId)).toMatchObject({ ok: false, message: expect.stringMatching(/already/i) });
    expect(await first).toEqual({ ok: true, message: "Compaction requested." });
    expect(await service.compactNow(threadId)).toMatchObject({ ok: false, message: expect.stringMatching(/already/i) });
    expect(compact).toHaveBeenCalledTimes(1);
    expect(store.decisions({ threadId, limit: 1 })[0]).toMatchObject({ origin: "manual", point: "manual", mode: "observe" });
  });

  it("refuses busy and disabled providers, and reports provider refusal without retry", async () => {
    const { service, store, thread, compact } = setup();
    thread.status = "active";
    expect(await service.compactNow(threadId)).toMatchObject({ ok: false, message: expect.stringMatching(/idle|busy/i) });
    expect(compact).not.toHaveBeenCalled();
    thread.status = "idle";
    store.setThreadPolicyOverride(threadId, '{"providers":{"pi":{"enabled":false}}}');
    expect(await service.compactNow(threadId)).toMatchObject({ ok: false, message: expect.stringMatching(/disabled/i) });
    expect(compact).not.toHaveBeenCalled();
    store.setThreadPolicyOverride(threadId, null);
    compact.mockRejectedValueOnce(new Error("Provider does not support manual compaction"));
    expect(await service.compactNow(threadId)).toEqual({ ok: false, message: "Provider does not support manual compaction" });
    expect(compact).toHaveBeenCalledTimes(1);
  });
});
