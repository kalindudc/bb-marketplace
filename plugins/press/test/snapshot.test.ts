import { describe, expect, it } from "vitest";
import { deriveSnapshot, scanTimeline } from "../src/snapshot";

const row = (type: string, fields: Record<string, unknown>, createdAt = 1): Record<string, unknown> => ({
  type,
  createdAt,
  ...fields,
});

describe("scanTimeline", () => {
  it("sums original command output bytes however they were truncated", () => {
    const rows = [
      row("commandExecution", { command: "npm test", status: "completed", exitCode: 0, truncation: { aggregatedOutput: { originalLength: 900 } } }),
      row("commandExecution", { command: "cat big.log", status: "completed", exitCode: 0, truncation: { result: { originalLength: 5_100 } } }),
      row("commandExecution", { command: "tail x", status: "completed", exitCode: 0, truncation: { resultText: { originalLength: 700 } } }),
      row("commandExecution", { command: "no truncation", status: "completed", exitCode: 0 }),
    ];
    expect(scanTimeline(rows).toolResultBytes).toBe(6_700);
  });

  it("counts the same failing command per command string", () => {
    const rows = [
      row("commandExecution", { command: "npm test", status: "failed", exitCode: 1 }),
      row("commandExecution", { command: "npm test", status: "completed", exitCode: 1 }),
      row("commandExecution", { command: "npm test", status: "failed", exitCode: 2 }),
      row("commandExecution", { command: "go build ./...", status: "failed", exitCode: 1 }),
    ];
    expect(scanTimeline(rows).sameCommandFailedMax).toBe(3);
  });

  it("derives tests.green and pr.opened from successful commands only", () => {
    const rows = [
      row("commandExecution", { command: "npm test", status: "completed", exitCode: 0 }),
      row("commandExecution", { command: "npm test", status: "failed", exitCode: 1 }),
      row("commandExecution", { command: "gh pr create --fill", status: "completed", exitCode: 0 }),
    ];
    const signals = scanTimeline(rows).phaseSignals;
    expect(signals).toContain("tests.green");
    expect(signals).toContain("pr.opened");
    expect(signals.filter((signal) => signal === "tests.green")).toHaveLength(1);
  });

  it("derives plan.approved from a completed planSteps row", () => {
    expect(scanTimeline([row("planSteps", { status: "completed", steps: [] })]).phaseSignals).toContain("plan.approved");
    expect(scanTimeline([row("planSteps", { status: "pending", steps: [] })]).phaseSignals).not.toContain("plan.approved");
  });

  it("remembers the last contextCompaction row", () => {
    const rows = [row("contextCompaction", {}, 10), row("contextCompaction", {}, 30), row("commandExecution", { command: "ls", status: "completed" }, 99)];
    expect(scanTimeline(rows).lastCompactionEventAt).toBe(30);
  });

  it("counts re-reads of the same path from fileRead and toolCall rows", () => {
    const rows = [
      row("fileRead", { path: "src/a.ts" }),
      row("toolCall", { tool: "read", arguments: { path: "src/a.ts" } }),
      row("toolCall", { tool: "read_file", arguments: { file: "src/b.ts" } }),
      row("toolCall", { tool: "bash", arguments: { command: "ls" } }),
      { type: "text", text: "not a tool call" },
    ];
    expect(scanTimeline(rows).sameFileReadMax).toBe(2);
  });

  it("sums subagent report bytes from report-shaped tool calls", () => {
    const rows = [
      row("toolCall", { tool: "report", truncation: { resultText: { originalLength: 20_000 } } }),
      row("toolCall", { tool: "TaskReport", truncation: { resultText: { originalLength: 20_001 } } }),
    ];
    expect(scanTimeline(rows).subagentReportBytes).toBe(40_001);
  });

  it("is unbothered by garbage rows", () => {
    expect(scanTimeline([null, 3, "x", {}, { type: "unknown" }])).toMatchObject({
      toolResultBytes: 0,
      sameFileReadMax: 0,
      sameCommandFailedMax: 0,
      subagentReportBytes: 0,
    });
  });
});

describe("deriveSnapshot", () => {
  const thread = { status: "idle" as const, updatedAt: 1_000_000 - 300_000 };

  it("derives percent, tokens, window and idle seconds", () => {
    const snapshot = deriveSnapshot({
      usage: { estimated: true, modelContextWindow: 1_000_000, usedTokens: 400_000 },
      thread,
      now: 1_000_000,
      turnsSinceCompaction: 7,
      rows: [],
    });
    expect(snapshot.percent).toBe(40);
    expect(snapshot.tokens).toBe(400_000);
    expect(snapshot.window).toBe(1_000_000);
    expect(snapshot.idleSeconds).toBe(300);
    expect(snapshot.turnsSinceCompaction).toBe(7);
    expect(snapshot.midTurn).toBe(false);
  });

  it("midTurn only while active, and no idle seconds otherwise", () => {
    const active = deriveSnapshot({ usage: null, thread: { status: "active", updatedAt: 1 }, now: 2, turnsSinceCompaction: 0, rows: [] });
    expect(active.midTurn).toBe(true);
    expect(active.idleSeconds).toBe(0);
    expect(active.percent).toBeNull();
  });

  it("carries the timeline scan into the snapshot", () => {
    const snapshot = deriveSnapshot({
      usage: { estimated: false, modelContextWindow: 100, usedTokens: 50 },
      thread,
      now: 1_000_000,
      turnsSinceCompaction: 1,
      rows: [
        row("commandExecution", { command: "npm test", status: "failed", exitCode: 1 }),
        row("toolCall", { tool: "read", arguments: { path: "x" } }),
      ],
    });
    expect(snapshot.sameCommandFailedMax).toBe(1);
    expect(snapshot.sameFileReadMax).toBe(1);
    expect(snapshot.toolResultBytes).toBe(0);
  });
});