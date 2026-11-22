import assert from "node:assert/strict";
import { test } from "node:test";
import { extract } from "../src/extract.ts";
import type { AnyMessage } from "../src/types.ts";

const NOW = "2026-11-22T00:00:00.000Z";

function user(text: string): AnyMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): AnyMessage {
  return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: 2 };
}

function toolResult(id: string, name: string, text: string, isError = false): AnyMessage {
  return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: 3 };
}

test("captures user constraints verbatim", () => {
  const ledger = extract([user("Please refactor the queue. Never commit unless I ask. Use tabs, not spaces.")], {
    now: NOW,
  });
  const texts = ledger.constraints.map((row) => row.text);
  assert.ok(texts.includes("Never commit unless I ask."), `got ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => text.startsWith("Use tabs")), `got ${JSON.stringify(texts)}`);
  assert.equal(ledger.constraints[0]!.source, "user#1");
});

test("records commands with exit codes from tool results", () => {
  const ledger = extract(
    [
      toolCall("c1", "bash", { command: "npm test" }),
      toolResult("c1", "bash", "Tests: 2 failed\nexit code: 1", true),
    ],
    { now: NOW },
  );
  assert.equal(ledger.state.commands.length, 1);
  assert.equal(ledger.state.commands[0]!.cmd, "npm test");
  assert.equal(ledger.state.commands[0]!.exit, 1);
});

test("records read and written files separately", () => {
  const ledger = extract(
    [
      toolCall("r1", "read", { path: "src/a.ts" }),
      toolCall("w1", "edit", { path: "src/b.ts" }),
      toolCall("w2", "write", { file_path: "src/c.ts" }),
    ],
    { now: NOW },
  );
  assert.deepEqual(
    ledger.state.filesRead.map((row) => row.path),
    ["src/a.ts"],
  );
  assert.deepEqual(
    ledger.state.filesWritten.map((row) => row.path),
    ["src/b.ts", "src/c.ts"],
  );
});

test("collects failing test names", () => {
  const ledger = extract(
    [
      toolCall("c1", "bash", { command: "vitest run" }),
      toolResult("c1", "bash", " ✕ queue > requeue drops payload\n ✕ queue > retries twice\n", true),
    ],
    { now: NOW },
  );
  assert.deepEqual(ledger.state.failingTests, ["queue > requeue drops payload", "queue > retries twice"]);
});

test("reads branch and head from git output", () => {
  const ledger = extract(
    [
      toolCall("c1", "bash", { command: "git status" }),
      toolResult("c1", "bash", "On branch feat/press\nnothing to commit\n"),
    ],
    { now: NOW },
  );
  assert.equal(ledger.state.branch, "feat/press");
});

test("handles bashExecution messages", () => {
  const ledger = extract(
    [{ role: "bashExecution", command: "ls -la", output: "total 0", exitCode: 0, cancelled: false, timestamp: 1 }],
    { now: NOW },
  );
  assert.equal(ledger.state.commands[0]!.cmd, "ls -la");
  assert.equal(ledger.state.commands[0]!.exit, 0);
});

test("keeps the first user line as the goal and user questions as open questions", () => {
  const ledger = extract(
    [user("Build the compaction governor.\nDoes the retry path drop the payload?"), user("Also add tests.")],
    { now: NOW },
  );
  assert.equal(ledger.state.goal, "Build the compaction governor.");
  assert.deepEqual(ledger.state.openQuestions, ["Does the retry path drop the payload?"]);
});

test("ignores unknown roles and content without crashing", () => {
  const ledger = extract(
    [
      { role: "mystery", content: 42 } as unknown as AnyMessage,
      { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } as unknown as AnyMessage,
      { role: "toolResult", content: "plain string output" } as unknown as AnyMessage,
    ],
    { now: NOW },
  );
  assert.equal(ledger.state.commands.length, 0);
  assert.equal(ledger.constraints.length, 0);
});

test("dedupes a repeated command with the same exit code", () => {
  const ledger = extract(
    [
      toolCall("c1", "bash", { command: "npm test" }),
      toolResult("c1", "bash", "exit code: 1", true),
      toolCall("c2", "bash", { command: "npm test" }),
      toolResult("c2", "bash", "exit code: 1", true),
    ],
    { now: NOW },
  );
  assert.equal(ledger.state.commands.length, 1);
});
