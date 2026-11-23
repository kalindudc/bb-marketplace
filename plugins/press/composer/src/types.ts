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
  testFailures: Array<{ name: string; command: string | null }>;
  openQuestions: string[];
  nextSteps: string[];
}

export interface LedgerResume {
  state: string;
  next: string;
  verify: string;
}

export interface ComposerRow {
  id: string;
  at: string;
  finishedAt: number | null;
  point: string;
  tokensBefore: number;
  tokensAfter: number | null;
  model: string | null;
  ms: number | null;
  /** Relative to the workspace so the governor can route reads to its host. */
  summaryPath: string | null;
  outcome: "ok" | "failed" | "cancelled";
}

export interface PublishedComposer {
  model: string | null;
  maxSummaryTokens: number;
  ledger: boolean;
  resumeContract: boolean;
  updatedAt: string;
}

export interface LedgerIo {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  /** Atomically replace the destination, including when it already exists. */
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export interface Ledger {
  schemaVersion: 1;
  threadId: string | null;
  updatedAt: string;
  compactions: number;
  constraints: LedgerConstraint[];
  state: LedgerState;
  resume: LedgerResume | null;
  history: ComposerRow[];
}
