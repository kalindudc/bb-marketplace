import { describe, expect, it } from "vitest";
import {
  collectTurnStats, formatDuration, previewLines, summarizeArgs, toLogEntries,
} from "../src/entries";
import type { TimelineRow } from "../src/types";
import {
  assistantRow, commandRow, delegationRow, fileChangeRow, reasoningRow, toolRow, turnRow, userRow,
} from "./fixtures";

describe("toLogEntries", () => {
  it("flattens turns and puts delegation children at depth 1 with scoped ids", () => {
    const child = commandRow("child");
    const rows = [
      userRow("request"),
      turnRow("fold", { children: [reasoningRow("thought"), delegationRow("delegate", { childRows: [child] })] }),
      assistantRow("reply"),
    ];
    const entries = toLogEntries(rows);
    expect(entries.map(({ id, depth }) => [id, depth])).toEqual([
      ["request", 0], ["thought", 0], ["delegate", 0], ["delegate/child", 1], ["reply", 0],
    ]);
    expect(entries.map(({ category }) => category)).toEqual([
      "message", "thinking", "tool", "tool", "message",
    ]);
    expect(entries[0]?.divider).toEqual({ label: "You", linkThreadId: null });
    expect(entries[4]?.title).toBe("Agent");
  });

  it("labels every incoming message kind and links thread subjects", () => {
    const cases = [
      [userRow("you"), "You", null],
      [userRow("steer", { turnRequest: { kind: "steer", isGrouped: false, status: "accepted" } }), "You · steer", null],
      [userRow("queued", { turnRequest: { kind: "message", isGrouped: false, status: "pending" } }), "You · queued", null],
      [userRow("rejected", { turnRequest: { kind: "message", isGrouped: false, status: "rejected" } }), "You · rejected", null],
      [userRow("other", { senderThreadId: "thr_sender" }), "Message from another thread", "thr_sender"],
      [userRow("completed", { initiator: "system", systemMessageKind: "child-completed", systemMessageSubject: { kind: "thread", threadId: "thr_child", threadName: "Review" } }), "Child finished · Review", "thr_child"],
      [userRow("failed", { initiator: "system", systemMessageKind: "child-failed" }), "Child failed", null],
      [userRow("interrupted", { initiator: "system", systemMessageKind: "child-interrupted" }), "Child interrupted", null],
      [userRow("attention", { initiator: "system", systemMessageKind: "child-needs-attention" }), "Child needs attention", null],
      [userRow("reports", { initiator: "system", systemMessageKind: "child-outcome-batch" }), "Child reports", null],
      [userRow("result", { initiator: "system", systemMessageKind: "tool-result-delivered" }), "Tool result", null],
      [userRow("assigned", { initiator: "system", systemMessageKind: "ownership-assigned" }), "Ownership changed", null],
      [userRow("removed", { initiator: "system", systemMessageKind: "ownership-removed" }), "Ownership changed", null],
      [userRow("system", { initiator: "system", systemMessageKind: "unlabeled" }), "System", null],
    ] as const;
    const entries = toLogEntries(cases.map(([row]) => row));
    expect(entries.map(({ divider }) => [divider?.label, divider?.linkThreadId])).toEqual(
      cases.map(([, label, threadId]) => [label, threadId]),
    );
  });

  it("shows commands, tool arguments, file changes, reasoning and searchable paths", () => {
    const entries = toLogEntries([
      reasoningRow("reason", { detail: "Choose a simple path" }),
      commandRow("cmd", { command: "npm test\nnpm run build", output: "PASS\nsummary" }),
      toolRow("tool", { toolName: "read", toolArgs: { path: "src/example.ts", limit: 10 } }),
      fileChangeRow("file", { change: {
        kind: "move", path: "src/old.ts", movePath: "src/new.ts",
        diffStats: { added: 2, removed: 1 }, diff: "+added\n-removed",
      } }),
    ]);
    expect(entries.map(({ title }) => title)).toEqual([
      "Thought for 2s", "$ npm test", 'read({"path":"src/example.ts","limit":10})',
      "move src/old.ts → src/new.ts +2 −1",
    ]);
    expect(entries.map(({ bodyFormat }) => bodyFormat)).toEqual(["text", "text", "text", "diff"]);
    expect(entries[1]?.copyText).toBe("npm test\nnpm run build\n\nPASS\nsummary");
    expect(entries[2]?.copyText).toContain('"path": "src/example.ts"');
    expect(entries[2]?.searchText).toContain("src/example.ts");
    expect(entries[3]?.searchText).toContain("src/new.ts");
  });

  it("recognizes every error condition, not just a status of error", () => {
    const denied: TimelineRow = {
      ...commandRow("approval"), workKind: "approval", approvalKind: "file-edit", lifecycle: "denied",
      interactionId: "interaction", target: { itemId: "file", toolName: "edit" },
    };
    const failedWorkflow: TimelineRow = {
      ...commandRow("workflow"), workKind: "workflow", description: "Check", itemId: "task",
      error: null, model: null, summary: null, taskStatus: "failed", taskType: "agent",
      usage: null, workflow: null, workflowName: null,
    };
    const killedWorkflow: TimelineRow = { ...failedWorkflow, id: "killed", taskStatus: "killed" };
    const failedImage: TimelineRow = {
      ...commandRow("image"), workKind: "image-generation", error: "Generation failed",
      path: null, prompt: "draw a tree", transparentBackground: false,
    };
    const systemError: TimelineRow = { ...reasoningRow("system"), systemKind: "error" };
    const rows = [
      commandRow("exit", { status: "completed", exitCode: 2 }),
      toolRow("status", { status: "error" }), denied, failedWorkflow, killedWorkflow,
      failedImage, systemError,
      userRow("child", { initiator: "system", systemMessageKind: "child-interrupted" }),
      userRow("child-failed", { initiator: "system", systemMessageKind: "child-failed" }),
      commandRow("success", { exitCode: 0 }),
    ];
    expect(toLogEntries(rows).map(({ isError }) => isError)).toEqual([
      true, true, true, true, true, true, true, true, true, false,
    ]);
    expect(toLogEntries([commandRow("exit", { exitCode: 2 })])[0]?.durationMs).toBe(500);
    expect(toLogEntries([fileChangeRow("file")])[0]?.durationMs).toBeNull();
  });

  it("attaches turn totals to only the first divider, including null-id messages and steer-started turns", () => {
    const rows = [
      userRow("request", { turnId: null, startedAt: 900 }),
      commandRow("failed", { startedAt: 1_000, completedAt: 1_600, exitCode: 1 }),
      toolRow("pending", { startedAt: 1_200, completedAt: null, status: "pending" }),
      assistantRow("reply", { startedAt: 1_700 }),
      userRow("mid-turn-steer", { startedAt: 1_800, turnRequest: { kind: "steer", status: "accepted", isGrouped: false } }),
      userRow("new-turn-steer", { turnId: "turn-2", startedAt: 2_000, turnRequest: { kind: "steer", status: "accepted", isGrouped: false } }),
      commandRow("second-work", { turnId: "turn-2", startedAt: 2_100, completedAt: 2_400 }),
    ];
    const entries = toLogEntries(rows);
    const stats = collectTurnStats(entries);
    expect([...stats.keys()]).toEqual(["request", "new-turn-steer"]);
    expect(stats.get("request")).toEqual({
      workCount: 2, errorCount: 1, durationMs: 600, running: true,
    });
    expect(stats.get("new-turn-steer")).toEqual({
      workCount: 1, errorCount: 0, durationMs: 400, running: false,
    });
    expect(entries[0]?.divider?.label).toBe("You");
  });

  it("does not resolve a null-id divider across the next divider", () => {
    const stats = collectTurnStats(toLogEntries([
      userRow("unresolved", { turnId: null }),
      userRow("next", { turnId: "turn-2" }),
      commandRow("work", { turnId: "turn-2" }),
    ]));
    expect([...stats.keys()]).toEqual(["next"]);
  });

  it("reuses the entry objects for unchanged row objects, including delegated rows", () => {
    const child = commandRow("child");
    const delegated = delegationRow("delegate", { childRows: [child] });
    const first = toLogEntries([delegated]);
    const second = toLogEntries([delegated]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(toLogEntries([commandRow("child")])[0]).not.toBe(second[1]);
  });

  it("shows the name of an unknown work kind without throwing", () => {
    const future = { ...commandRow("future"), workKind: "future-feature" } as unknown as TimelineRow;
    expect(toLogEntries([future])[0]).toMatchObject({ title: "future-feature", category: "tool" });
  });
});

describe("entry formatting", () => {
  it("previews the first and last lines around a hidden-line count", () => {
    const text = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
    expect(previewLines(text, 4, 4)).toEqual({
      text: "line 0\nline 1\nline 2\nline 3\n… 4 more lines …\nline 8\nline 9\nline 10\nline 11",
      hiddenLines: 4,
    });
    expect(previewLines(text, 3, 0)).toEqual({
      text: "line 0\nline 1\nline 2\n… 9 more lines …",
      hiddenLines: 9,
    });
    expect(previewLines("one\ntwo", 4, 4)).toEqual({ text: "one\ntwo", hiddenLines: 0 });
  });

  it("formats durations and limits argument summaries to 120 characters", () => {
    expect([850, 4_100, 192_000, 3_900_000].map(formatDuration)).toEqual([
      "850ms", "4.1s", "3m 12s", "1h 5m",
    ]);
    expect(summarizeArgs({ query: "x".repeat(200) })).toHaveLength(120);
    expect(summarizeArgs(null)).toBe("");
  });
});
