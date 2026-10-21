import type { HiddenMessage, SystemMessageKind } from "./hidden";
import type { TimelineRow } from "./types";

export type EntryCategory = "message" | "thinking" | "tool" | "hidden";
export type EntryStatus = "pending" | "completed" | "error" | "interrupted";
export type EntryTint = "agent" | "tool" | "command" | "file" | "error";

export interface LogEntry {
  id: string;
  row: TimelineRow | HiddenMessage;
  depth: 0 | 1;
  category: EntryCategory;
  icon: string;
  title: string;
  body: string;
  bodyFormat: "markdown" | "text" | "diff";
  status: EntryStatus | null;
  isError: boolean;
  tint: EntryTint | null;
  durationMs: number | null;
  startedAt: number;
  turnId: string | null;
  messageSeq: number | null;
  divider: { label: string; linkThreadId: string | null } | null;
  searchText: string;
  copyText: string;
}

export interface TurnStats {
  workCount: number;
  errorCount: number;
  durationMs: number | null;
  running: boolean;
}

type WorkRow = Extract<TimelineRow, { kind: "work" }>;
type UserRow = Extract<TimelineRow, { kind: "conversation"; role: "user" }>;
type BodyFormat = LogEntry["bodyFormat"];
interface Description {
  title: string;
  body: string;
  icon: string;
  bodyFormat?: BodyFormat;
  copyText?: string;
  searchExtra?: string;
}

const entryCache = new WeakMap<TimelineRow, Map<string, LogEntry>>();
const hiddenEntryCache = new WeakMap<HiddenMessage, LogEntry>();

const SYSTEM_MESSAGE_LABELS: Record<SystemMessageKind, string> = {
  "child-completed": "Child finished",
  "child-failed": "Child failed",
  "child-interrupted": "Child interrupted",
  "child-needs-attention": "Child needs attention",
  "child-outcome-batch": "Child reports",
  "tool-result-delivered": "Tool result",
  "ownership-assigned": "Ownership changed",
  "ownership-removed": "Ownership changed",
  unlabeled: "System",
};

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? "";
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "";
}

export function summarizeArgs(args: Readonly<Record<string, unknown>> | null): string {
  if (args === null) return "";
  const text = JSON.stringify(args) ?? "";
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

export function previewLines(text: string, head: number, tail: number): { text: string; hiddenLines: number } {
  const lines = text.split("\n");
  const hiddenLines = Math.max(0, lines.length - head - tail);
  if (hiddenLines === 0) return { text, hiddenLines };
  return {
    text: [
      ...lines.slice(0, head),
      `… ${hiddenLines} more lines …`,
      ...(tail > 0 ? lines.slice(-tail) : []),
    ].join("\n"),
    hiddenLines,
  };
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1).replace(/\.0$/, "")}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ${Math.floor(ms / 1_000) % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function dividerFor(row: UserRow): NonNullable<LogEntry["divider"]> {
  let label: string;
  if (row.senderThreadId !== null) {
    label = "Message from another thread";
  } else if (row.initiator === "user") {
    label = row.turnRequest.kind === "steer" ? "You · steer" : "You";
  } else if (row.initiator === "system") {
    label = SYSTEM_MESSAGE_LABELS[row.systemMessageKind];
  } else {
    label = "Agent";
  }
  if (row.systemMessageSubject?.kind === "thread") label += ` · ${row.systemMessageSubject.threadName}`;
  if (row.turnRequest.status === "pending") label += " · queued";
  if (row.turnRequest.status === "rejected") label += " · rejected";
  return {
    label,
    linkThreadId: row.senderThreadId ?? (row.systemMessageSubject?.kind === "thread"
      ? row.systemMessageSubject.threadId : null),
  };
}

function hiddenDividerFor(message: HiddenMessage): NonNullable<LogEntry["divider"]> {
  let label = message.suppressedTool !== null ? `Hidden tool result · ${message.suppressedTool}`
    : message.retry ? "Hidden retry" : message.steer ? "Hidden steer" : "Hidden message";
  if (message.senderThreadId !== null) {
    label += " from another thread";
  } else if (message.suppressedTool === null && message.initiator === "system" && message.systemMessageKind !== "unlabeled") {
    label += ` · ${SYSTEM_MESSAGE_LABELS[message.systemMessageKind]}`;
  }
  if (message.subjectThread) label += ` · ${message.subjectThread.threadName}`;
  if (message.rejected) label += " · rejected";
  return { label, linkThreadId: message.senderThreadId ?? message.subjectThread?.threadId ?? null };
}

function hiddenEntryFor(message: HiddenMessage): LogEntry {
  const cached = hiddenEntryCache.get(message);
  if (cached) return cached;
  const divider = message.alongsideVisible ? null : hiddenDividerFor(message);
  const title = divider?.label ?? "Hidden context";
  const body = [message.text, ...message.attachments].filter(Boolean).join("\n\n");
  const entry: LogEntry = {
    id: message.id, row: message, depth: 0, category: "hidden", icon: "EyeOff",
    title, body, bodyFormat: "markdown",
    status: null, isError: false, tint: null, durationMs: null,
    startedAt: message.startedAt,
    turnId: message.turnId,
    messageSeq: null,
    divider,
    searchText: `${title}\n${body}`.toLowerCase(),
    copyText: body || title,
  };
  hiddenEntryCache.set(message, entry);
  return entry;
}

function describeWork(row: WorkRow): Description {
  switch (row.workKind) {
    case "command":
      return {
        title: `$ ${firstLine(row.command)}`, body: row.output, icon: "Terminal",
        copyText: `${row.command}${row.output ? `\n\n${row.output}` : ""}`,
      };
    case "tool": {
      const args = row.toolArgs === null ? "" : pretty(row.toolArgs);
      return {
        title: `${row.toolName}(${summarizeArgs(row.toolArgs)})`, body: row.output, icon: "ToolCase",
        copyText: `${row.toolName}(${args})${row.output ? `\n\n${row.output}` : ""}`,
        searchExtra: args,
      };
    }
    case "file-change": {
      const { kind, path, movePath, diff, diffStats } = row.change;
      const title = `${kind ?? "edit"} ${path}${movePath ? ` → ${movePath}` : ""} +${diffStats.added} −${diffStats.removed}`;
      return { title, body: diff ?? "", bodyFormat: "diff", icon: "EditFile", copyText: diff ?? title };
    }
    case "file-read":
      return { title: `Read ${row.path}`, body: row.cmd ?? "", icon: "FileText" };
    case "search":
      return { title: `Search ${firstLine(row.query)}${row.path ? ` in ${row.path}` : ""}`, body: row.cmd ?? "", icon: "Search" };
    case "web-search":
      return { title: `Web search ${firstLine(row.queries.join(", "))}`, body: "", icon: "Globe" };
    case "web-fetch":
      return { title: `Fetch ${row.url}`, body: row.prompt ?? row.pattern ?? "", icon: "Globe" };
    case "image-view":
      return { title: `View image ${row.path}`, body: "", icon: "File" };
    case "image-generation":
      return { title: `Generate image ${firstLine(row.prompt ?? row.path ?? "")}`, body: row.error ?? row.prompt ?? "", icon: "File" };
    case "plan-steps":
      return {
        title: `Plan steps (${row.steps.length})`,
        body: row.steps.map((step) => `${step.status ?? "pending"}: ${step.step}`).join("\n"),
        icon: "ListTodo",
      };
    case "extension":
      return { title: row.presentation.title ?? row.extensionKind, body: pretty(row.payload), icon: "Puzzle" };
    case "approval":
      return {
        title: `Approval: ${row.target.toolName ?? row.approvalKind}`,
        body: "statusReason" in row ? row.statusReason ?? "" : "",
        icon: "Lock",
        searchExtra: row.lifecycle,
      };
    case "question":
      return {
        title: `Question: ${firstLine(row.questions[0]?.prompt ?? "input")}`,
        body: row.questions.map((question) => question.prompt).join("\n"),
        icon: "CircleQuestion",
      };
    case "form":
      return { title: firstLine(row.title), body: row.payload === null ? "" : pretty(row.payload), icon: "FileText" };
    case "delegation":
      return {
        title: `${row.toolName}: ${firstLine(row.description ?? row.subagentType ?? row.childRef ?? "subagent")}`,
        body: row.output, icon: "UserRoundPlus",
      };
    case "workflow":
      return {
        title: `Workflow: ${firstLine(row.workflowName ?? row.description)}`,
        body: [row.summary, row.error].filter(Boolean).join("\n"), icon: "Workflow",
        searchExtra: row.description,
      };
    default:
      return { title: (row as { workKind: string }).workKind, body: "", icon: "ToolCase" };
  }
}

function failed(row: TimelineRow, status: EntryStatus | null): boolean {
  if (status === "error") return true;
  if (row.kind === "system") return row.systemKind === "error";
  if (row.kind === "conversation") return row.role === "user" &&
    (row.systemMessageKind === "child-failed" || row.systemMessageKind === "child-interrupted");
  if (row.kind !== "work") return false;
  if (row.workKind === "command") return row.exitCode !== null && row.exitCode !== 0;
  if (row.workKind === "approval") return row.lifecycle === "denied";
  if (row.workKind === "workflow") return row.taskStatus === "failed" || row.taskStatus === "killed";
  if (row.workKind === "image-generation") return row.error !== null;
  return false;
}

// Thinking and incoming messages stay neutral; the Errors filter and badge still flag their failures.
function tintFor(row: TimelineRow, category: EntryCategory, isError: boolean, isDivider: boolean): EntryTint | null {
  if (isDivider || category === "thinking") return null;
  if (isError) return "error";
  if (row.kind === "conversation" && row.role === "assistant") return "agent";
  if (row.kind !== "work") return null;
  if (row.workKind === "command") return "command";
  if (row.workKind === "file-change") return "file";
  return "tool";
}

function entryFor(row: TimelineRow, id: string, depth: 0 | 1): LogEntry {
  const key = `${id}\u001f${depth}`;
  const cached = entryCache.get(row)?.get(key);
  if (cached) return cached;

  const divider = row.kind === "conversation" && row.role === "user" ? dividerFor(row) : null;
  const category: EntryCategory = row.kind === "work" ? "tool" :
    row.kind === "system" && row.systemKind === "operation" && row.operationKind === "reasoning"
      ? "thinking" : "message";
  const description: Description = row.kind === "work" ? describeWork(row) :
    row.kind === "conversation" ? {
      title: divider?.label ?? "Agent", body: row.text, bodyFormat: "markdown",
      icon: divider ? "UserRound" : "Bot",
    } : row.kind === "system" ? {
      title: row.title, body: row.detail ?? "", icon: category === "thinking" ? "AiBrain01" : "Info",
    } : { title: "Turn", body: "", icon: "Info" };
  const status: EntryStatus | null = row.kind === "work" || row.kind === "system" ? row.status : null;
  const isError = failed(row, status);
  const tint = tintFor(row, category, isError, divider !== null);
  const icon = row.kind === "work" && "presentation" in row && row.presentation?.icon.glyph
    ? row.presentation.icon.glyph : description.icon;
  const entry: LogEntry = {
    id, row, depth, category, icon: isError && category === "message" && !divider ? "AlertCircle" : icon,
    title: description.title,
    body: description.body,
    bodyFormat: description.bodyFormat ?? "text",
    status,
    isError,
    tint,
    durationMs: "completedAt" in row && typeof row.completedAt === "number"
      ? row.completedAt - row.startedAt : null,
    startedAt: row.startedAt,
    turnId: row.turnId,
    messageSeq: row.kind === "conversation" ? row.messageSeq : null,
    divider,
    searchText: [description.title, description.body, description.searchExtra ?? "", description.copyText ?? ""]
      .join("\n").toLowerCase(),
    copyText: description.copyText ?? (description.body || description.title),
  };
  const entries = entryCache.get(row) ?? new Map<string, LogEntry>();
  entries.set(key, entry);
  entryCache.set(row, entries);
  return entry;
}

/**
 * Flattens timeline rows into log entries. Each hidden message, ordered by seq, goes
 * before the first top-level row bb's timeline sourced after it.
 */
export function toLogEntries(rows: readonly TimelineRow[], hidden: readonly HiddenMessage[] = []): LogEntry[] {
  const entries: LogEntry[] = [];
  let nextHidden = 0;
  const append = (row: TimelineRow, prefix: string | null, depth: 0 | 1): void => {
    if (row.kind === "turn") {
      for (const child of row.children ?? []) append(child, prefix, depth);
      return;
    }
    while (depth === 0 && nextHidden < hidden.length && hidden[nextHidden]!.seq < row.sourceSeqStart) {
      entries.push(hiddenEntryFor(hidden[nextHidden++]!));
    }
    const id = prefix === null ? row.id : `${prefix}/${row.id}`;
    entries.push(entryFor(row, id, depth));
    if (row.kind === "work" && row.workKind === "delegation") {
      for (const child of row.childRows ?? []) append(child, id, 1);
    }
  };
  for (const row of rows) append(row, null, 0);
  while (nextHidden < hidden.length) entries.push(hiddenEntryFor(hidden[nextHidden++]!));
  return entries;
}

export function collectTurnStats(entries: readonly LogEntry[]): ReadonlyMap<string, TurnStats> {
  const turns = new Map<string, {
    dividerId: string;
    stats: TurnStats;
    first: number;
    last: number | null;
  }>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.divider === null) continue;
    let turnId = entry.turnId;
    if (turnId === null) {
      for (let next = index + 1; next < entries.length; next++) {
        const later = entries[next]!;
        if (later.divider !== null) break;
        if (later.turnId !== null) {
          turnId = later.turnId;
          break;
        }
      }
    }
    if (turnId === null || turns.has(turnId)) continue;
    turns.set(turnId, {
      dividerId: entry.id,
      stats: { workCount: 0, errorCount: 0, durationMs: null, running: false },
      first: Infinity,
      last: null,
    });
  }
  for (const entry of entries) {
    const turn = entry.turnId === null ? undefined : turns.get(entry.turnId);
    if (!turn) continue;
    if (entry.category === "tool") turn.stats.workCount++;
    if (entry.isError) turn.stats.errorCount++;
    if (entry.status === "pending") turn.stats.running = true;
    turn.first = Math.min(turn.first, entry.startedAt);
    if ("completedAt" in entry.row && typeof entry.row.completedAt === "number") {
      turn.last = Math.max(turn.last ?? -Infinity, entry.row.completedAt);
    }
  }
  const stats = new Map<string, TurnStats>();
  for (const turn of turns.values()) {
    if (turn.last !== null) turn.stats.durationMs = turn.last - turn.first;
    stats.set(turn.dividerId, turn.stats);
  }
  return stats;
}
