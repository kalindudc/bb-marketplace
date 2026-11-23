import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import { completedCompactions, deriveSnapshot, failedCompactions, pickBoundary, scanTimeline, threadRunning, type ThreadStatusView } from "../src/snapshot";

type TimelineRow = Exclude<Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["timeline"]>>, { delta: unknown }>["rows"][number];
type WorkRow<K> = Extract<TimelineRow, { kind: "work"; workKind: K }>;
type TurnRow = Extract<TimelineRow, { kind: "turn" }>;
type UserRow = Extract<TimelineRow, { kind: "conversation"; role: "user" }>;
type AssistantRow = Extract<TimelineRow, { kind: "conversation"; role: "assistant" }>;
type OperationRow = Exclude<Extract<TimelineRow, { kind: "system"; systemKind: "operation" }>, { operationKind: "parent-change" }>;

function baseRow(at: number) {
  return { id: `row-${at}`, threadId: "thr_press", turnId: "turn-1", sourceSeqStart: at, sourceSeqEnd: at, createdAt: at, startedAt: at };
}

function workRow(at: number) {
  return { ...baseRow(at), kind: "work" as const, status: "completed" as const, callId: `call-${at}`, completedAt: at + 1 };
}

function command(at: number, fields: Partial<WorkRow<"command">> = {}): WorkRow<"command"> {
  return {
    ...workRow(at), workKind: "command", command: "npm test", exitCode: 0, output: "", source: null,
    cwd: null, description: null, approvalStatus: null, activityIntents: [], ...fields,
  };
}

function fileRead(at: number): WorkRow<"file-read"> {
  return { ...workRow(at), workKind: "file-read", path: "src/a.ts", cmd: null };
}

function tool(at: number, fields: Partial<WorkRow<"tool">> = {}): WorkRow<"tool"> {
  return { ...workRow(at), workKind: "tool", toolName: "read", toolArgs: { path: "src/a.ts" }, output: "", approvalStatus: null, ...fields };
}

function plan(at: number, fields: Partial<WorkRow<"plan-steps">> = {}): WorkRow<"plan-steps"> {
  return { ...workRow(at), workKind: "plan-steps", explanation: null, steps: [{ step: "Run tests", status: "completed" }], ...fields };
}

function delegation(at: number, fields: Partial<WorkRow<"delegation">> = {}): WorkRow<"delegation"> {
  return {
    ...workRow(at), workKind: "delegation", toolName: "spawn", childRef: "thr_child", background: false,
    subagentType: "minion", description: null, output: "", childRows: null, ...fields,
  };
}

function operation(startedAt: number, completedAt: number | null, fields: Partial<OperationRow> = {}): OperationRow {
  return {
    ...baseRow(startedAt), kind: "system", systemKind: "operation", operationKind: "compaction", title: "Compaction",
    detail: null, status: "completed", completedAt, ...fields,
  };
}

function turn(children: TimelineRow[] | null): TurnRow {
  return { ...baseRow(1), kind: "turn", turnId: "turn-1", status: "completed", completedAt: 99, summaryCount: 0, children };
}

function user(at: number, initiator: UserRow["initiator"] = "user"): UserRow {
  return {
    ...baseRow(at), kind: "conversation", role: "user", initiator, text: "Run the tests", messageSeq: at,
    attachments: null, mentions: [], senderThreadId: null, systemMessageKind: "unlabeled", systemMessageSubject: null,
    turnRequest: { kind: "message", isGrouped: false, status: "accepted" },
  };
}

function assistant(at: number): AssistantRow {
  return { ...baseRow(at), kind: "conversation", role: "assistant", text: "Done", messageSeq: at, attachments: null, turnRequest: null };
}

const preview = (totalChars: number) => ({ experimental_fullOutputAvailability: "available" as const, totalChars });

const emptyScan = {
  toolResultBytes: 0,
  sameFileReadMax: 0,
  sameCommandFailedMax: 0,
  subagentReportBytes: 0,
  phaseSignals: [],
  lastCompactionEventAt: null,
};

describe("scanTimeline", () => {
  it("derives phase, volume, and thrash signals from SDK work rows inside a turn", () => {
    const rows = [turn([
      command(2, { output: "truncated", outputPreview: preview(2_000_000) }),
      command(3, { command: "make", exitCode: 1 }),
      command(4, { command: "make", status: "error", exitCode: null }),
      fileRead(5),
      fileRead(6),
      tool(7),
      plan(8),
      command(9, { command: "gh pr create --fill" }),
    ])];
    expect(scanTimeline(rows, null)).toEqual({
      ...emptyScan,
      toolResultBytes: 2_000_000,
      sameCommandFailedMax: 2,
      sameFileReadMax: 3,
      phaseSignals: [{ signal: "tests.green", at: 3 }, { signal: "plan.approved", at: 9 }, { signal: "pr.opened", at: 10 }],
    });
  });

  it("does not consider failed, pending, or interrupted work a phase boundary", () => {
    const result = scanTimeline([
      command(1, { exitCode: 1 }),
      command(2, { command: "gh pr create", status: "error", exitCode: null }),
      command(3, { status: "pending", exitCode: null, completedAt: null }),
      command(4, { command: "gh pr create", status: "interrupted", exitCode: null }),
      plan(5, { status: "pending", completedAt: null, steps: [{ step: "Run tests", status: "pending" }] }),
      plan(6, { status: "error" }),
    ], null);
    expect(result.phaseSignals).toEqual([]);
    expect(result.sameCommandFailedMax).toBe(1);
  });

  it("counts full UTF-8 output and counts both reports and delegation output, but not the child's work", () => {
    const childRows = [command(10, { threadId: "thr_child", output: "never count" }), operation(11, 12, { threadId: "thr_child" })];
    const result = scanTimeline([
      command(2, { command: "pwd", output: "é" }),
      tool(3, { toolName: "task_report", toolArgs: null, output: "short", outputPreview: preview(20_000) }),
      delegation(4, { output: "x".repeat(20_001), childRows }),
      tool(5, { toolName: "read_file", toolArgs: { file: "src/b.ts" }, output: "file" }),
      tool(6, { toolName: "read_file", toolArgs: { path: "", file: "src/b.ts" } }),
      tool(7, { toolName: "read", toolArgs: { path: false, file: 12 } }),
    ], null);
    expect(result).toEqual({ ...emptyScan, toolResultBytes: 40_007, subagentReportBytes: 40_001, sameFileReadMax: 2 });
  });

  it("filters signals by row start, including nested rows, without filtering compaction history", () => {
    const rows = [turn([
      command(5, { output: "before" }),
      command(6, { command: "make", exitCode: 1 }),
      fileRead(8),
      delegation(9, { output: "old report" }),
      plan(10),
      operation(18, 20, { sourceSeqEnd: 99 }),
      command(21, { startedAt: 19, completedAt: 22, output: "started before" }),
      command(22, { command: "gh pr create", startedAt: 20 }),
      command(23, { command: "make", exitCode: 1, output: "new" }),
      fileRead(24),
      command(25, { command: "gh pr create", output: "pr" }),
      operation(26, null, { status: "pending" }),
    ])];
    expect(scanTimeline(rows, 20)).toEqual({
      toolResultBytes: 5,
      sameFileReadMax: 1,
      sameCommandFailedMax: 1,
      subagentReportBytes: 0,
      phaseSignals: [{ signal: "pr.opened", at: 26 }],
      lastCompactionEventAt: 20,
    });
    expect(scanTimeline(rows, 40)).toEqual({ ...emptyScan, lastCompactionEventAt: 20 });
  });

  it("takes phase signals only from the newest turn, while volume still spans every turn since the landing", () => {
    const rows = [
      turn([command(2, { output: "x".repeat(10) }), command(3, { command: "gh pr create" })]),
      { ...turn([command(20, { turnId: "turn-2", command: "ls", output: "abc" })]), id: "turn-2", turnId: "turn-2", startedAt: 19 },
    ];
    expect(scanTimeline(rows, null)).toMatchObject({ phaseSignals: [], toolResultBytes: 13 });
    expect(scanTimeline([...rows, command(30, { turnId: "turn-2" })], null).phaseSignals).toEqual([{ signal: "tests.green", at: 31 }]);
    expect(scanTimeline([command(5, { turnId: null })], null).phaseSignals).toEqual([]);
  });

  it("counts plan.approved only when every step of the plan is completed", () => {
    const result = scanTimeline([
      plan(1, { steps: [{ step: "Read", status: "completed" }, { step: "Build", status: "active" }] }),
      plan(2, { steps: [{ step: "Read", status: "completed" }, { step: "Build" }] }),
      plan(3, { steps: [] }),
    ], null);
    expect(result.phaseSignals).toEqual([]);
    expect(scanTimeline([plan(4, { steps: [{ step: "Read", status: "completed" }, { step: "Build", status: "completed" }] })], null).phaseSignals)
      .toEqual([{ signal: "plan.approved", at: 5 }]);
  });

  it.each([
    "npm test", "npm run test", "pnpm test", "yarn test", "bun test", "npx vitest run", "vitest run src", "pytest tests/",
    "go test ./...", "cargo test", "jest", "cd plugins/press && npx vitest run test/a.test.ts", "CI=1 npm test -- --silent",
  ])("counts the test run %s as tests.green", (line) => {
    expect(scanTimeline([command(1, { command: line })], null).phaseSignals).toEqual([{ signal: "tests.green", at: 2 }]);
  });

  it.each([
    "npm install -D vitest", "pip install pytest", "npm ls jest", "grep -rn vitest package.json", "echo npm test",
    "cat node_modules/jest/package.json", "npx vitest", "npm testing",
  ])("does not count %s as a test run", (line) => {
    expect(scanTimeline([command(1, { command: line })], null).phaseSignals).toEqual([]);
  });

  it("counts only work after the newest compaction in the timeline, even when the store knows none", () => {
    const rows = [
      command(1, { output: "x".repeat(2_000) }),
      command(2, { command: "npm test" }),
      operation(3, 5, { sourceSeqEnd: 5 }),
      command(6, { command: "ls", output: "abc" }),
    ];
    expect(scanTimeline(rows, null)).toEqual({ ...emptyScan, toolResultBytes: 3, lastCompactionEventAt: 5 });
    expect(scanTimeline(rows, 6).toolResultBytes).toBe(0);
  });

  it("ignores non-timeline input, even when an incomplete object looks like a work row", () => {
    expect(scanTimeline([
      null, 3, "x", {}, { type: "contextCompaction", createdAt: 99 }, turn(null),
      { ...baseRow(10), kind: "work", workKind: "command", status: "error" },
      { ...baseRow(11), kind: "work", workKind: "delegation" },
    ], null)).toEqual(emptyScan);
  });
});

describe("failedCompactions", () => {
  it("lists failed compaction operations with their start and finish, including nested ones, and skips bad envelopes", () => {
    const rows = [
      turn([operation(10, 20, { status: "error" }), operation(30, 40)]),
      operation(50, null, { status: "error" }),
      { ...operation(60, 70, { status: "error" }), startedAt: undefined },
    ];
    expect([...failedCompactions(rows)]).toEqual([{ startedAt: 10, failedAt: 20 }, { startedAt: 50, failedAt: 50 }]);
  });
});

describe("chat boundary", () => {
  it("finds the earliest visible message by creation time after completion, including nested turns", () => {
    const rows = [assistant(40), user(20), user(22, "system"), turn([user(17), user(23)])];
    expect(pickBoundary(rows, 20)).toEqual({ createdAt: 23, id: "row-23" });
    expect(pickBoundary(rows, 40)).toBeNull();
  });

  it("uses the operation completion time and excludes the next compaction's span", () => {
    const first = operation(5, 20, { sourceSeqEnd: 12 });
    const failed = operation(35, 40, { status: "error" });
    const pending = operation(41, null, { status: "pending" });
    const reasoning = operation(42, 44, { operationKind: "reasoning" });
    const rows = [turn([first, failed, pending, reasoning])];
    expect([...completedCompactions(rows)]).toEqual([{ sequence: 12, startedAt: 5, finishedAt: 20 }]);
    expect(scanTimeline(rows, null).lastCompactionEventAt).toBe(20);
    expect(pickBoundary([...rows, user(16), { ...assistant(21), startedAt: 19 }], 15)).toEqual({ createdAt: 21, id: "row-21" });
    expect(pickBoundary([...rows, user(35), user(36)], 20)).toBeNull();
  });

  it("keeps a timestamp-only boundary when the message id is missing", () => {
    expect(pickBoundary([
      { ...user(22), role: "other" },
      { ...assistant(23), id: undefined },
    ], 20)).toEqual({ createdAt: 23, id: null });
  });

  it("falls back to creation time on a completed operation with no completion timestamp", () => {
    const rows = [operation(30, null), operation(10, 20)];
    expect([...completedCompactions(rows)]).toEqual([
      { sequence: 30, startedAt: 30, finishedAt: 30 },
      { sequence: 10, startedAt: 10, finishedAt: 20 },
    ]);
    expect(scanTimeline(rows, null).lastCompactionEventAt).toBe(30);
  });
});

describe("deriveSnapshot", () => {
  const thread = { status: "idle" as const, updatedAt: 700_000 };

  it("derives percent, tokens, window, idle seconds, and counters since a landing", () => {
    const snapshot = deriveSnapshot({
      usage: { estimated: true, modelContextWindow: 1_000_000, usedTokens: 400_000 },
      thread,
      now: 1_000_000,
      turnsSinceCompaction: 7,
      rows: [command(1), fileRead(2), fileRead(3)],
      since: 2,
    });
    expect(snapshot).toMatchObject({
      percent: 40, tokens: 400_000, window: 1_000_000, idleSeconds: 300, turnsSinceCompaction: 7,
      midTurn: false, sameFileReadMax: 1, phaseSignals: [],
    });
  });

  it.each<ThreadStatusView["status"]>(["active", "pending", "starting", "stopping"])("treats %s as mid-turn with no idle seconds", (status) => {
    const snapshot = deriveSnapshot({ usage: null, thread: { status, updatedAt: 1 }, now: 5_000, turnsSinceCompaction: 0, rows: [], since: null });
    expect(snapshot).toMatchObject({ midTurn: true, idleSeconds: 0, percent: null });
    expect(threadRunning(status)).toBe(true);
  });

  it.each<ThreadStatusView["status"]>(["idle", "error"])("treats %s as not running: its last turn ended", (status) => {
    const snapshot = deriveSnapshot({ usage: null, thread: { status, updatedAt: 1_000 }, now: 5_000, turnsSinceCompaction: 0, rows: [], since: null });
    expect(snapshot).toMatchObject({ midTurn: false, idleSeconds: 4 });
    expect(threadRunning(status)).toBe(false);
  });
});
