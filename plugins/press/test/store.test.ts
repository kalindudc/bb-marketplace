import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, PressStore } from "../src/store";
import { DEFAULT_POLICY } from "../src/policy";
import { decide, type DecideInput } from "../src/decide";

function freshStore(): PressStore {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  for (const statement of MIGRATIONS) db.exec(statement);
  return new PressStore(db);
}

const decision = (input: Partial<DecideInput> = {}) =>
  decide({
    policy: DEFAULT_POLICY,
    snapshot: {
      percent: 40,
      tokens: 400_000,
      window: 1_000_000,
      midTurn: false,
      idleSeconds: 0,
      turnsSinceCompaction: 10,
      toolResultBytes: 0,
      sameFileReadMax: 0,
      sameCommandFailedMax: 0,
      subagentReportBytes: 0,
    },
    now: 1_000_000,
    lastCompaction: null,
    recentSignals: ["tests.green"],
    ...input,
  });

describe("PressStore", () => {
  let store: PressStore;
  beforeEach(() => {
    store = freshStore();
  });

  it("migrations are append-only and idempotent", () => {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain("decisions");
    expect(tables).toContain("compactions");
    expect(tables).toContain("thread_state");
  });

  it("writes one decision row per trigger and none for a skip", () => {
    const row = store.recordDecision({ at: 5, threadId: "thr_a", decision: decision(), mode: "auto", origin: "sweep" });
    expect(row.decision).toBe("compact");
    expect(row.point).toBe("phase");
    expect(store.decisions({ limit: 10 })).toHaveLength(1);

    const skipped = decision({ recentSignals: [] });
    expect(skipped.decision).toBe("skip");
  });

  it("lists decisions newest first, filtered by thread", () => {
    store.recordDecision({ at: 1, threadId: "thr_a", decision: decision(), mode: "auto", origin: "sweep" });
    store.recordDecision({ at: 2, threadId: "thr_b", decision: decision(), mode: "advisor", origin: "idle" });
    store.recordDecision({ at: 3, threadId: "thr_a", decision: decision(), mode: "auto", origin: "sweep" });

    const all = store.decisions({ limit: 10 });
    expect(all.map((row) => row.at)).toEqual([3, 2, 1]);
    const a = store.decisions({ threadId: "thr_a", limit: 10 });
    expect(a).toHaveLength(2);
    expect(store.decisions({ threadId: "thr_a", limit: 1 })).toHaveLength(1);
  });

  it("fills a decision's outcome when the compaction lands or fails", () => {
    const row = store.recordDecision({ at: 1, threadId: "thr_a", decision: decision(), mode: "auto", origin: "sweep" });
    expect(row.outcome).toBeNull();

    store.setDecisionOutcome(row.id, "failed", 99, "provider refused");
    const updated = store.decisionOf(row.id);
    expect(updated).not.toBeNull();
    expect((updated as { outcome: string | null; outcomeError: string | null }).outcome).toBe("failed");
    expect((updated as { outcomeError: string | null }).outcomeError).toBe("provider refused");
  });

  it("tracks a compaction from request to landing", () => {
    const d = store.recordDecision({ at: 1, threadId: "thr_a", decision: decision(), mode: "auto", origin: "sweep" });
    const cmp = store.insertCompaction({
      threadId: "thr_a",
      decisionId: d.id,
      requestedAt: 5,
      point: "phase",
      mode: "auto",
      provider: "pi",
      method: "send",
      instructionsHash: "abc",
      tokensBefore: 400_000,
    });
    expect(store.pendingCompactions("thr_a")).toHaveLength(1);

    store.settleCompaction(cmp.id, "ok", 60, null, 96_000);
    expect(store.pendingCompactions("thr_a")).toHaveLength(0);
    const settled = store.compaction(cmp.id);
    expect(settled).not.toBeNull();
    expect((settled as { status: string }).status).toBe("settled");
    expect((settled as { tokensAfter: number | null }).tokensAfter).toBe(96_000);
    expect(store.lastCompaction("thr_a")?.id).toBe(cmp.id);
  });

  it("settling twice does not resurrect a pending row", () => {
    const cmp = store.insertCompaction({ threadId: "thr_a", decisionId: null, requestedAt: 5, point: null, mode: "auto", provider: "pi", method: "compact", instructionsHash: null, tokensBefore: null });
    store.settleCompaction(cmp.id, "failed", 6, "boom", null);
    store.settleCompaction(cmp.id, "ok", 7, null, 1);
    const row = store.compaction(cmp.id);
    expect((row as { outcome: string }).outcome).toBe("failed");
  });

  it("counts turns since compaction and resets on landing", () => {
    store.bumpTurns("thr_a");
    store.bumpTurns("thr_a");
    expect(store.threadState("thr_a").turnsSince).toBe(2);

    store.resetTurns("thr_a", 100, false);
    const state = store.threadState("thr_a");
    expect(state.turnsSince).toBe(0);
    expect(state.lastCompactionAt).toBe(100);
    expect(state.lastCompactionFailed).toBe(false);

    store.resetTurns("thr_a", 200, true);
    expect(store.threadState("thr_a").lastCompactionFailed).toBe(true);
  });

  it("keeps a per-thread policy override as raw JSON", () => {
    expect(store.threadPolicyOverride("thr_a")).toBeNull();
    store.setThreadPolicyOverride("thr_a", '{ "mode": "auto" }');
    expect(store.threadPolicyOverride("thr_a")).toBe('{ "mode": "auto" }');
    store.setThreadPolicyOverride("thr_a", null);
    expect(store.threadPolicyOverride("thr_a")).toBeNull();
  });

  it("thread state for an unknown thread starts at zero", () => {
    expect(store.threadState("thr_never")).toEqual({ threadId: "thr_never", turnsSince: 0, lastCompactionAt: null, lastCompactionFailed: false });
  });

  it("records a hint, hands it out once, and clears it", () => {
    const hint = store.recordHint({ threadId: "thr_a", at: 5, reason: "tests green" });
    expect(hint.consumed).toBe(false);
    expect(store.pendingHints("thr_a")).toHaveLength(1);

    store.consumeHints([hint.id]);
    expect(store.pendingHints("thr_a")).toHaveLength(0);

    store.recordHint({ threadId: "thr_a", at: 6, reason: "one" });
    store.recordHint({ threadId: "thr_a", at: 7, reason: "two" });
    store.recordHint({ threadId: "thr_b", at: 8, reason: "other thread" });
    expect(store.pendingHints("thr_a").map((row) => row.reason)).toEqual(["one", "two"]);
  });

  it("prunes consumed and stale hints", () => {
    store.recordHint({ threadId: "thr_a", at: 1_000, reason: "fresh" });
    const stale = store.recordHint({ threadId: "thr_a", at: 0, reason: "stale" });
    store.consumeHints([stale.id]);
    store.recordHint({ threadId: "thr_b", at: 0, reason: "stale unconsumed" });

    const pruned = store.pruneHints(500);
    expect(pruned).toBe(2);
    expect(store.pendingHints("thr_a").map((row) => row.reason)).toEqual(["fresh"]);
  });
});
