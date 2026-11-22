import { constraintsFromText, hash } from "./ledger.ts";
import type { AnyBlock, AnyMessage, Ledger, LedgerCommand, LedgerFile } from "./types.ts";

const FILE_TOOLS = new Set(["read", "write", "edit", "multiedit", "notebookedit", "create"]);
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit", "create"]);
const SHELL_TOOLS = new Set(["bash", "shell", "powershell", "run", "exec", "terminal"]);

const FAIL_LINE = /^\s*(?:✕|✗|×|FAIL(?:ED)?|not ok)\s+(.{3,160})$/;
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
  const failingTests: string[] = [];
  const openQuestions: string[] = [];
  const constraints: Ledger["constraints"] = [];
  const callIndex = new Map<string, { name: string; args?: Record<string, unknown> }>();
  const pendingShell = new Map<string, string>();
  let goal: string | null = null;
  let branch: string | null = null;
  let head: string | null = null;
  let userIndex = 0;

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    if (message.role === "user") {
      userIndex += 1;
      const text = textOf(message.content).trim();
      if (!text) continue;
      if (!goal) goal = text.split("\n")[0]!.slice(0, 300);
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
      collectFromOutput(output, failingTests, (b) => (branch = b), (h) => (head = h));
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
      const exit = exitMatch ? Number(exitMatch[1]) : message.isError ? 1 : null;
      if (call?.name && SHELL_TOOLS.has(call.name)) {
        const cmd = argString(call.args, "command", "cmd", "script");
        if (cmd) {
          pushCommand(commands, cmd, exit, now, message.isError ? "error" : undefined);
          if (typeof message.toolCallId === "string") pendingShell.delete(message.toolCallId);
        }
      }
      collectFromOutput(output, failingTests, (b) => (branch = b), (h) => (head = h));
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
      failingTests: failingTests.slice(0, 40),
      openQuestions: openQuestions.slice(-40),
      nextSteps: [],
    },
    resume: null,
    history: [],
  };
}

function collectFromOutput(
  output: string,
  failingTests: string[],
  setBranch: (branch: string) => void,
  setHead: (head: string) => void,
): void {
  if (!output) return;
  const branch = ON_BRANCH.exec(output);
  if (branch?.[1]) setBranch(branch[1]);
  const head = HEAD_LINE.exec(output);
  if (head?.[1]) setHead(head[1]);
  for (const line of output.split("\n")) {
    const match = FAIL_LINE.exec(line);
    if (!match?.[1]) continue;
    const name = match[1].trim();
    if (name.length < 3) continue;
    if (!failingTests.includes(name)) failingTests.push(name);
    if (failingTests.length >= 40) return;
  }
}

/** Stable identity for a summary, so the governor can tell two compactions apart. */
export function summaryHash(summary: string): string {
  return `sha256:${hash(summary)}`;
}
