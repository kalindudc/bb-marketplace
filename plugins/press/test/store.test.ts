import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { COMPOSER_ATTACH_MAX_MS, LANDING_MATCH_MS, MIGRATIONS, PressStore } from "../src/store";
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
      percent: 60,
      tokens: 600_000,
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

/** The first 16 hex digits of each statement's sha256, as 0.1.0 shipped them. */
const SHIPPED = [
  "175f3f478c5c09e4", "cdf2a45cd00795d2", "982d64f2d2546600", "859380018d639e9a", "ca22b8b433c52411", "ca05d14ff89dfaf7",
  "783576cf50c73ca4", "419914872d8a453d", "c87ce875324d1367",
];

const request = (store: PressStore, requestedAt: number, extra: { decisionId?: string | null; tokensBefore?: number | null } = {}) =>
  store.insertCompaction({
    threadId: "thr_a", decisionId: extra.decisionId ?? null, requestedAt, point: "phase", reason: "tests.green",
    mode: "auto", provider: "pi", tokensBefore: extra.tokensBefore ?? 400_000,
  });

describe("PressStore migrations", () => {
  it("never changes a shipped statement", () => {
    const hashes = MIGRATIONS.slice(0, SHIPPED.length).map((statement) => createHash("sha256").update(statement).digest("hex").slice(0, 16));
    expect(hashes).toEqual(SHIPPED);
  });

  it("upgrades a 0.1.0 database, keeping its rows and settling a request 0.1.0 left pending", () => {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS.slice(0, SHIPPED.length)) db.exec(statement);
    const columns = () => (db.prepare("PRAGMA table_info(compactions)").all() as { name: string }[]).map((column) => column.name);
    expect(columns()).not.toContain("reason");
    // Rows as 0.1.0 wrote them: a native landing, and a `send` request with an instructions hash still pending.
    db.prepare(
      `INSERT INTO compactions (id, thread_id, requested_at, point, method, status, outcome, landed_at) VALUES ('old', 'thr_a', 1, 'native', 'native', 'settled', 'ok', 2)`,
    ).run();
    db.prepare(
      `INSERT INTO compactions (id, thread_id, decision_id, requested_at, point, mode, provider, method, instructions_hash, tokens_before, status)
       VALUES ('sent', 'thr_a', NULL, 100, 'phase', 'auto', 'pi', 'send', 'abc123', 500000, 'requested')`,
    ).run();
    for (const statement of MIGRATIONS.slice(SHIPPED.length)) db.exec(statement);
    const store = new PressStore(db);
    expect(store.compaction("old")).toMatchObject({ id: "old", method: "native", reason: null, model: null, summaryPath: null, composerId: null, ms: null });
    expect(columns()).toEqual(expect.arrayContaining(["reason", "model", "summary_path", "composer_id", "ms", "boundary_at"]));
    expect(store.pendingCompactions("thr_a")).toEqual([expect.objectContaining({ id: "sent", method: "compact", tokensBefore: 500_000, reason: null })]);
    expect(store.recordLanding("thr_a", { startedAt: 150, finishedAt: 200_000 })).toEqual({ id: "sent", kind: "settled", changed: true });
  });
});

describe("PressStore", () => {
  let store: PressStore;
  beforeEach(() => {
    store = freshStore();
  });

  it("writes one decision row per trigger and none for a skip", () => {
    const row = store.recordDecision({ at: 5, threadId: "thr_a", decision: decision(), mode: "auto", origin: "sweep" });
    expect(row.decision).toBe("compact");
    expect(row.point).toBe("phase");
    expect(store.decisions({ limit: 10 })).toHaveLength(1);
    expect(decision({ recentSignals: [] }).decision).toBe("skip");
  });

  it("lists decisions newest first, filtered by thread", () => {
    store.recordDecision({ at: 1, threadId: "thr_a", decision: decision(), mode: "auto", origin: "sweep" });
    store.recordDecision({ at: 2, threadId: "thr_b", decision: decision(), mode: "advisor", origin: "idle" });
    store.recordDecision({ at: 3, threadId: "thr_a", decision: decision(), mode: "auto", origin: "sweep" });
    expect(store.decisions({ limit: 10 }).map((row) => row.at)).toEqual([3, 2, 1]);
    expect(store.decisions({ threadId: "thr_a", limit: 10 })).toHaveLength(2);
    expect(store.decisions({ threadId: "thr_a", limit: 1 })).toHaveLength(1);
  });

  it("notes a decision only when its decision, point or reason changed for that thread", () => {
    const first = store.noteDecision({ at: 1, threadId: "thr_a", decision: decision(), mode: "advisor", origin: "sweep" });
    expect(first.inserted).toBe(true);
    expect(store.noteDecision({ at: 2, threadId: "thr_a", decision: decision(), mode: "advisor", origin: "sweep" })).toEqual({ row: first.row, inserted: false });
    expect(store.noteDecision({ at: 3, threadId: "thr_b", decision: decision(), mode: "advisor", origin: "sweep" }).inserted).toBe(true);
    const vetoed = decision({ lastCompaction: { at: 999_000, failed: false } });
    expect(vetoed).toMatchObject({ decision: "veto", reason: "cooldownSeconds" });
    expect(store.noteDecision({ at: 4, threadId: "thr_a", decision: vetoed, mode: "advisor", origin: "sweep" }).inserted).toBe(true);
    expect(store.noteDecision({ at: 5, threadId: "thr_a", decision: decision(), mode: "advisor", origin: "sweep" }).inserted).toBe(true);
    expect(store.decisions({ threadId: "thr_a", limit: 10 })).toHaveLength(3);
  });

  it("prunes decisions older than the cut-off", () => {
    store.recordDecision({ at: 1, threadId: "thr_a", decision: decision(), mode: "auto", origin: "sweep" });
    store.recordDecision({ at: 100, threadId: "thr_a", decision: decision(), mode: "auto", origin: "sweep" });
    expect(store.pruneDecisions(50)).toBe(1);
    expect(store.decisions({ limit: 10 }).map((row) => row.at)).toEqual([100]);
  });

  it("settles a pending request to the first landing after it, with its decision and the thread state", () => {
    const d = store.recordDecision({ at: 1, threadId: "thr_a", decision: decision(), mode: "auto", origin: "sweep" });
    const cmp = request(store, 5, { decisionId: d.id });
    store.bumpTurns("thr_a");
    store.recordHint({ threadId: "thr_a", at: 3, reason: "hint" });
    expect(store.pendingCompactions("thr_a")).toHaveLength(1);

    expect(store.recordLanding("thr_a", { startedAt: 10, finishedAt: 60 })).toEqual({ id: cmp.id, kind: "settled", changed: true });
    expect(store.pendingCompactions("thr_a")).toHaveLength(0);
    expect(store.compaction(cmp.id)).toMatchObject({ status: "settled", outcome: "ok", landedAt: 60, reason: "tests.green" });
    expect(store.decisions({ threadId: "thr_a", limit: 1 })[0]).toMatchObject({ outcome: "ok", outcomeAt: 60 });
    expect(store.threadState("thr_a")).toMatchObject({ turnsSince: 0, lastCompactionAt: 60, lastCompactionFailed: false });
    expect(store.pendingHints("thr_a")).toHaveLength(0);
  });

  it("records the same landing once, whether bb reports it by event or timeline row", () => {
    const cmp = request(store, 5);
    store.recordLanding("thr_a", { startedAt: 60, finishedAt: 60 });
    expect(store.recordLanding("thr_a", { startedAt: 20, finishedAt: 59 })).toEqual({ id: cmp.id, kind: "known", changed: false });
    expect(store.compactionsOf("thr_a", 10)).toHaveLength(1);
    const later = 60 + LANDING_MATCH_MS + 1;
    expect(store.recordLanding("thr_a", { startedAt: later, finishedAt: later }).kind).toBe("native");
    expect(store.compactionsOf("thr_a", 10)).toHaveLength(2);
  });

  it("settles a request made between two landings 30 s apart to the second, not to the first", () => {
    const first = store.recordLanding("thr_a", { startedAt: 90_000, finishedAt: 100_000 });
    const cmp = request(store, 110_000);
    expect(store.recordLanding("thr_a", { startedAt: 130_000, finishedAt: 130_000 })).toEqual({ id: cmp.id, kind: "settled", changed: true });
    expect(store.pendingCompactions("thr_a")).toEqual([]);
    // The second landing's timeline row and the first landing's event are the same landings again.
    expect(store.recordLanding("thr_a", { startedAt: 115_000, finishedAt: 129_000 })).toMatchObject({ id: cmp.id, kind: "known" });
    expect(store.recordLanding("thr_a", { startedAt: 100_200, finishedAt: 100_200 })).toMatchObject({ id: first.id, kind: "known" });
    expect(store.compactionsOf("thr_a", 10)).toHaveLength(2);
  });

  it("records a second landing nobody requested 30 s after the first as its own row", () => {
    const first = store.recordLanding("thr_a", { startedAt: 90_000, finishedAt: 100_000 });
    const second = store.recordLanding("thr_a", { startedAt: 120_000, finishedAt: 130_000 });
    expect(second).toMatchObject({ kind: "native", changed: true });
    expect(second.id).not.toBe(first.id);
    expect(store.recordLanding("thr_a", { startedAt: 130_050, finishedAt: 130_050 })).toMatchObject({ id: second.id, kind: "known" });
  });

  it("tells when a compact decision last used each signal", () => {
    store.recordDecision({ at: 10, threadId: "thr_a", decision: decision(), mode: "advisor", origin: "sweep" });
    store.recordDecision({ at: 20, threadId: "thr_a", decision: decision(), mode: "advisor", origin: "sweep" });
    store.recordDecision({ at: 30, threadId: "thr_a", decision: decision({ lastCompaction: { at: 999_000, failed: false } }), mode: "advisor", origin: "sweep" });
    store.recordDecision({ at: 40, threadId: "thr_b", decision: decision(), mode: "advisor", origin: "sweep" });
    expect(store.lastCompactDecisions("thr_a")).toEqual(new Map([["tests.green", 20]]));
    expect(store.lastCompactDecisions("thr_none")).toEqual(new Map());
  });

  it("records a landing nobody requested as a native row, and moves its start earlier when the timeline knows it", () => {
    const native = store.recordLanding("thr_a", { startedAt: 500, finishedAt: 500 });
    expect(native.kind).toBe("native");
    expect(store.recordLanding("thr_a", { startedAt: 300, finishedAt: 499 })).toEqual({ id: native.id, kind: "known", changed: true });
    expect(store.compaction(native.id)).toMatchObject({ method: "native", point: "native", requestedAt: 300, landedAt: 500, outcome: "ok" });
  });

  it("does not settle a request made after the landing", () => {
    const cmp = request(store, 1_000);
    expect(store.recordLanding("thr_a", { startedAt: 400, finishedAt: 500 }).kind).toBe("native");
    expect(store.compaction(cmp.id)?.status).toBe("requested");
  });

  it("a native landing clears the failure flag and restarts the turn counter", () => {
    const cmp = request(store, 5);
    store.bumpTurns("thr_a");
    store.bumpTurns("thr_a");
    expect(store.failCompaction(cmp.id, "failed", 10, "provider refused")).toBe(true);
    expect(store.threadState("thr_a")).toMatchObject({ turnsSince: 2, lastCompactionAt: 10, lastCompactionFailed: true });
    store.recordLanding("thr_a", { startedAt: 100, finishedAt: 120 });
    expect(store.threadState("thr_a")).toMatchObject({ turnsSince: 0, lastCompactionAt: 120, lastCompactionFailed: false });
  });

  it("an attempt older than the recorded one does not overwrite it", () => {
    store.recordAttempt("thr_a", 200, true);
    store.recordAttempt("thr_a", 100, false);
    expect(store.threadState("thr_a")).toMatchObject({ lastCompactionAt: 200, lastCompactionFailed: true });
  });

  it("fails a pending request once and never resurrects it", () => {
    const d = store.recordDecision({ at: 1, threadId: "thr_a", decision: decision(), mode: "auto", origin: "sweep" });
    const cmp = request(store, 5, { decisionId: d.id });
    expect(store.failCompaction(cmp.id, "cancelled", 6, "timed out")).toBe(true);
    expect(store.failCompaction(cmp.id, "failed", 7, "again")).toBe(false);
    expect(store.compaction(cmp.id)).toMatchObject({ status: "settled", outcome: "cancelled", error: "timed out" });
    expect(store.decisions({ threadId: "thr_a", limit: 1 })[0]).toMatchObject({ outcome: "cancelled", outcomeError: "timed out" });
    // The request is settled, so a later landing is a separate native row.
    expect(store.recordLanding("thr_a", { startedAt: 8, finishedAt: 9 }).kind).toBe("native");
  });

  it("cancels an unsent request without counting it as an attempt", () => {
    const cmp = request(store, 5);
    store.cancelUnsent(cmp.id, 5, "skip: provider disabled by policy");
    expect(store.compaction(cmp.id)).toMatchObject({ outcome: "cancelled" });
    expect(store.threadState("thr_a").lastCompactionAt).toBeNull();
  });

  it("anchors a boundary on any landed row, once", () => {
    const cmp = request(store, 5);
    store.recordLanding("thr_a", { startedAt: 10, finishedAt: 60 });
    const native = store.recordLanding("thr_a", { startedAt: 200_000, finishedAt: 200_000 });
    expect(store.unanchoredCompactions("thr_a", 0).map((row) => row.id)).toEqual([native.id, cmp.id]);
    expect(store.setBoundary(cmp.id, { createdAt: 70, id: "msg_1" })).toBe(true);
    expect(store.setBoundary(cmp.id, { createdAt: 80, id: "msg_2" })).toBe(false);
    expect(store.compaction(cmp.id)).toMatchObject({ boundaryAt: 70, boundaryMessageId: "msg_1" });
    expect(store.unanchoredCompactions("thr_a", 0).map((row) => row.id)).toEqual([native.id]);
    expect(store.unanchoredCompactions("thr_a", 200_001)).toEqual([]);
  });

  it("attaches a composer report to the landing it precedes, once", () => {
    const first = store.recordLanding("thr_a", { startedAt: 1_000, finishedAt: 1_000 });
    const second = store.recordLanding("thr_a", { startedAt: 500_000, finishedAt: 500_000 });
    const report = { id: "press-1", at: 400_000, tokensBefore: 600_000, tokensAfter: 30_000, model: "p/m", ms: 70_000, summaryPath: "/w/s.md" };
    expect(store.attachComposer("thr_a", report)).toBe(second.id);
    expect(store.attachComposer("thr_a", report)).toBeNull();
    expect(store.compaction(second.id)).toMatchObject({
      composerId: "press-1", model: "p/m", summaryPath: "/w/s.md", tokensAfter: 30_000, ms: 70_000, tokensBefore: 600_000,
    });
    expect(store.compaction(first.id)?.composerId).toBeNull();
    expect(store.awaitingComposer("thr_a", 0).map((row) => row.id)).toEqual([first.id]);
  });

  it("does not attach a report to a landing too long after it, or to one before it", () => {
    store.recordLanding("thr_a", { startedAt: 1_000, finishedAt: 1_000 });
    const late = 100_000 + COMPOSER_ATTACH_MAX_MS + 1;
    store.recordLanding("thr_a", { startedAt: late, finishedAt: late });
    expect(store.attachComposer("thr_a", { id: "press-x", at: 100_000, tokensBefore: 1, tokensAfter: 1, model: null, ms: null, summaryPath: null })).toBeNull();
  });

  it("fills tokensAfter from usage only when nothing reported it and it is lower", () => {
    const cmp = request(store, 5, { tokensBefore: 400_000 });
    store.recordLanding("thr_a", { startedAt: 10, finishedAt: 60 });
    expect(store.fillTokensAfter(cmp.id, 500_000)).toBe(false);
    expect(store.fillTokensAfter(cmp.id, 20_000)).toBe(true);
    expect(store.fillTokensAfter(cmp.id, 10_000)).toBe(false);
    expect(store.compaction(cmp.id)?.tokensAfter).toBe(20_000);
    expect(store.lastLandedAt("thr_a")).toBe(60);
  });

  it("counts turns since compaction", () => {
    store.bumpTurns("thr_a");
    store.bumpTurns("thr_a");
    expect(store.threadState("thr_a").turnsSince).toBe(2);
    store.recordAttempt("thr_a", 100, false);
    expect(store.threadState("thr_a")).toEqual({ threadId: "thr_a", turnsSince: 0, lastCompactionAt: 100, lastCompactionFailed: false });
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
    expect(store.pruneHints(500)).toBe(2);
    expect(store.pendingHints("thr_a").map((row) => row.reason)).toEqual(["fresh"]);
  });
});

describe("PressStore tokensAfter", () => {
  it("lists recent landings still missing tokensAfter, whether or not the composer reported", () => {
    const store = freshStore();
    const first = store.recordLanding("thr_a", { startedAt: 1_000, finishedAt: 1_000 });
    const second = store.recordLanding("thr_a", { startedAt: 500_000, finishedAt: 500_000 });
    store.attachComposer("thr_a", { id: "press-1", at: 499_000, tokensBefore: 600_000, tokensAfter: null, model: "p/m", ms: 1, summaryPath: null });
    expect(store.missingTokensAfter("thr_a", 0).map((row) => row.id)).toEqual([first.id, second.id]);
    expect(store.fillTokensAfter(second.id, 20_000)).toBe(true);
    expect(store.missingTokensAfter("thr_a", 0).map((row) => row.id)).toEqual([first.id]);
    expect(store.missingTokensAfter("thr_a", 2_000)).toEqual([]);
  });
});
