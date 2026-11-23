import { constraintsFromText } from "./ledger.ts";
import type { AnyBlock, AnyMessage, Ledger, LedgerCommand, LedgerFile, LedgerState } from "./types.ts";

const FILE_TOOLS = new Set(["read", "write", "edit", "multiedit", "notebookedit", "create"]);
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit", "create"]);
const SHELL_TOOLS = new Set(["bash", "shell", "powershell", "run", "exec", "terminal"]);

const TEST_LINE = /^\s*(✕|✗|×|FAIL(?:ED)?|not ok|✓|✔|PASS(?:ED)?|ok)\s+(?:\d+\s+-\s+)?(.{3,160})$/;
const PASS_MARKER = /^(?:✓|✔|PASS(?:ED)?|ok)$/;
const EXIT_CODE = /\bexit(?:\s*code)?[:\s]+(-?\d{1,3})\b/i;
const ON_BRANCH = /^On branch (\S+)/m;
const HEAD_LINE = /^HEAD detached at (\w+)/m;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => {
      return Boolean(block) && typeof block === "object" && (block as AnyBlock).type === "text";
    })
    .map((block) => block.text)
    .join("\n");
}

function blocksOf(message: AnyMessage): AnyBlock[] {
  return Array.isArray(message.content) ? (message.content as AnyBlock[]) : [];
}

function argString(args: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function pushFile(list: LedgerFile[], path: string, at: string): void {
  if (!path || path.length > 400) return;
  const existing = list.findIndex((row) => row.path === path);
  if (existing >= 0) list.splice(existing, 1);
  list.push({ path, at });
}

function pushCommand(list: LedgerCommand[], cmd: string, exit: number | null, at: string, note?: string): void {
  const trimmed = cmd.trim();
  if (!trimmed || trimmed.length > 2000) return;
  const existing = list.findIndex((row) => row.cmd === trimmed && row.exit === exit);
  if (existing >= 0) list.splice(existing, 1);
  list.push({ cmd: trimmed, exit, at, ...(note ? { note } : {}) });
}

export interface ExtractOptions {
  now?: string;
  threadId?: string | null;
  previousFailures?: LedgerState["testFailures"];
}

export function userGoal(content: unknown): string | null {
  const text = textOf(content).trim();
  return text ? text.split("\n", 1)[0]!.slice(0, 300) : null;
}

/**
 * Deterministic extraction of what a summary must not lose. No model, no I/O.
 * Everything here is recoverable evidence: paths, commands, exit codes, failing
 * tests, verbatim user constraints.
 */
export function extract(messages: AnyMessage[], options: ExtractOptions = {}): Ledger {
  const now = options.now ?? new Date().toISOString();
  const filesRead: LedgerFile[] = [];
  const filesWritten: LedgerFile[] = [];
  const commands: LedgerCommand[] = [];
  let testFailures = [...(options.previousFailures ?? [])];
  const openQuestions: string[] = [];
  const constraints: Ledger["constraints"] = [];
  const callIndex = new Map<string, { name: string; args?: Record<string, unknown> }>();
  const pendingShell = new Map<string, string>();
  let goal: string | null = null;
  let branch: string | null = null;
  let head: string | null = null;
  let userIndex = 0;

  const collectFromOutput = (output: string, command: string | null, succeeded: boolean) => {
    if (command && succeeded) testFailures = testFailures.filter((row) => row.command !== command);
    const branchName = ON_BRANCH.exec(output)?.[1];
    if (branchName) branch = branchName.slice(0, 300);
    const headName = HEAD_LINE.exec(output)?.[1];
    if (headName) head = headName.slice(0, 300);
    for (const line of output.split("\n")) {
      const match = TEST_LINE.exec(line);
      if (!match) continue;
      const name = match[2]!.trim();
      if (PASS_MARKER.test(match[1]!)) {
        testFailures = testFailures.filter((row) => row.name !== name);
      } else if (!succeeded && !testFailures.some((row) => row.name === name && row.command === command)) {
        testFailures.push({ name, command });
        if (testFailures.length > 40) testFailures.shift();
      }
    }
  };

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    if (message.role === "user") {
      userIndex += 1;
      const text = textOf(message.content).trim();
      if (!text) continue;
      goal ??= userGoal(text);
      constraints.push(...constraintsFromText(text, `user#${userIndex}`, now));
      for (const line of text.split(/\n+/)) {
        const question = line.trim();
        if (question.endsWith("?") && question.length >= 12 && question.length <= 300) {
          if (!openQuestions.includes(question)) openQuestions.push(question);
        }
      }
      continue;
    }

    if (message.role === "bashExecution") {
      const cmd = typeof message.command === "string" ? message.command : "";
      const exit = typeof message.exitCode === "number" ? message.exitCode : null;
      pushCommand(commands, cmd, exit, now);
      const output = typeof message.output === "string" ? message.output : "";
      collectFromOutput(output, cmd.trim() || null, exit === 0 && message.cancelled !== true);
      continue;
    }

    if (message.role === "assistant") {
      for (const block of blocksOf(message)) {
        if (block.type !== "toolCall") continue;
        const name = String(block.name ?? "").toLowerCase();
        const args = (block.arguments ?? undefined) as Record<string, unknown> | undefined;
        if (typeof block.id === "string") callIndex.set(block.id, { name, args });
        if (SHELL_TOOLS.has(name)) {
          const cmd = argString(args, "command", "cmd", "script");
          if (cmd && typeof block.id === "string") pendingShell.set(block.id, cmd);
        } else if (FILE_TOOLS.has(name)) {
          const path = argString(args, "path", "file_path", "filePath", "filename");
          if (path) pushFile(WRITE_TOOLS.has(name) ? filesWritten : filesRead, path, now);
        }
      }
      continue;
    }

    if (message.role === "toolResult") {
      const call = typeof message.toolCallId === "string" ? callIndex.get(message.toolCallId) : undefined;
      const output = textOf(message.content);
      const exitMatch = EXIT_CODE.exec(output);
      const cmd = call && SHELL_TOOLS.has(call.name) ? argString(call.args, "command", "cmd", "script") : undefined;
      const exit = exitMatch ? Number(exitMatch[1]) : message.isError ? 1 : cmd && message.isError === false ? 0 : null;
      if (cmd) {
        pushCommand(commands, cmd, exit, now, message.isError ? "error" : undefined);
        if (typeof message.toolCallId === "string") pendingShell.delete(message.toolCallId);
      }
      collectFromOutput(output, cmd ?? null, exit === 0 && message.isError !== true);
    }
  }

  // A call that never produced a result (aborted turn) still happened.
  for (const cmd of pendingShell.values()) pushCommand(commands, cmd, null, now);

  return {
    schemaVersion: 1,
    threadId: options.threadId ?? null,
    updatedAt: now,
    compactions: 0,
    constraints,
    state: {
      goal,
      branch,
      head,
      filesRead: filesRead.slice(-200),
      filesWritten: filesWritten.slice(-200),
      commands: commands.slice(-120),
      failingTests: [...new Set(testFailures.map((row) => row.name))],
      testFailures,
      openQuestions: openQuestions.slice(-40),
      nextSteps: [],
    },
    resume: null,
    history: [],
  };
}
