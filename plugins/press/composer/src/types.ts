/** Loose shapes for the pi messages the composer reads. Kept structural so the
 * pure modules never import pi and stay testable with `node --test`. */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export interface AnyBlock {
  type: string;
  [key: string]: unknown;
}

export interface AnyMessage {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  command?: string;
  exitCode?: number;
  cancelled?: boolean;
  timestamp?: number;
  [key: string]: unknown;
}

export interface LedgerCommand {
  cmd: string;
  exit: number | null;
  at: string;
  note?: string;
}

export interface LedgerFile {
  path: string;
  hash?: string;
  at: string;
}

export interface LedgerConstraint {
  id: string;
  text: string;
  source: string;
  at: string;
}

export interface LedgerState {
  goal: string | null;
  branch: string | null;
  head: string | null;
  filesRead: LedgerFile[];
  filesWritten: LedgerFile[];
  commands: LedgerCommand[];
  failingTests: string[];
  openQuestions: string[];
  nextSteps: string[];
}

export interface LedgerResume {
  state: string;
  next: string;
  verify: string;
}

export interface LedgerHistoryRow {
  id: string;
  at: string;
  point: string;
  tokensBefore: number;
  tokensAfter: number | null;
  model: string | null;
  ms: number | null;
  keptTurns: number | null;
  summaryHash: string;
  /** Where the full summary text is kept, relative to the workspace. */
  summaryPath?: string | null;
  /** One line from the summary, for a list row. */
  preview?: string | null;
  outcome?: "ok" | "failed" | "cancelled";
}

export interface Ledger {
  schemaVersion: 1;
  threadId: string | null;
  updatedAt: string;
  compactions: number;
  constraints: LedgerConstraint[];
  state: LedgerState;
  resume: LedgerResume | null;
  history: LedgerHistoryRow[];
  [key: string]: unknown;
}
