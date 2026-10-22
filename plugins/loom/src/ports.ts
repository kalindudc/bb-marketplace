// Loom's view of bb. bb-port.ts adapts bb.sdk to this; tests fake it.
import type { NewThreadRequest } from "@get-bb/plugin-sdk";
import type { FILE_STATUSES, HostInput, HostMethod, HostOutput } from "./host-contract";

export type FileStatus = (typeof FILE_STATUSES)[number];

export class SectionNameConflictError extends Error {
  constructor(readonly sectionName: string) {
    super(`A sidebar section named "${sectionName}" already exists.`);
    this.name = "SectionNameConflictError";
  }
}

/** bb refused to start a thread with a 4xx other than 408, 409 or 429, so the same request fails again. The message is bb's. */
export class SpawnRefusedError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "SpawnRefusedError";
  }
}

export interface BbPort {
  /** The host of the thread's environment, else the server's primary host. */
  threadHostId(threadId: string): Promise<string | null>;
  /** Reuses `sectionId` when bb still lists it, else creates the section. Throws SectionNameConflictError when the name is taken. */
  ensureSection(sectionId: string | null, name: string): Promise<string>;
  renameSection(sectionId: string, name: string): Promise<void>;
  /** Deleting unassigns the section's threads; a section that is already gone is ignored. */
  deleteSection(sectionId: string): Promise<void>;
  moveThread(threadId: string, sectionId: string | null): Promise<void>;
  setMetadata(threadId: string, set: Record<string, string | number | boolean | null>): Promise<void>;
  log(level: "info" | "warn" | "error", message: string): void;

  /** The path of the project's default source on that host, or null when the project has none there. */
  projectCheckout(bbProjectId: string, hostId: string): Promise<string | null>;
  spawnThread(args: SpawnArgs): Promise<{ threadId: string; environmentId: string | null }>;
  /** A plain message, or a short summary the human sees plus detail only the agent reads. */
  send(threadId: string, message: string | { summary: string; detail: string }): Promise<void>;
  /** Waits for the interrupt; read getThread before treating the stop as confirmed. */
  stop(threadId: string): Promise<void>;
  archive(threadId: string): Promise<void>;
  /** Null when bb no longer knows the thread. */
  getThread(threadId: string): Promise<ThreadInfo | null>;
  getEnvironment(environmentId: string): Promise<EnvironmentInfo | null>;
  /** The id of the thread this plugin spawned with that token in its metadata, if there is one. */
  findSpawnedThread(spawnToken: string): Promise<string | null>;
  /** Cumulative tokens the thread has used, or null when its provider reports none. */
  threadTokens(threadId: string): Promise<number | null>;
  /** The newest system/error event of the thread. */
  latestSystemError(threadId: string): Promise<{ code: string | null; message: string } | null>;
  retryTurn(threadId: string, turnRequestId: string, sendAt: number): Promise<void>;
  /** "personal" is bb's "Don't work in a project"; null when bb does not know the project. */
  projectKind(bbProjectId: string): Promise<"standard" | "personal" | null>;
  /** Starts a thread from the page's composer request, `kickoff` appended as agent-only text; returns its id. */
  spawnPlanner(args: { request: NewThreadRequest; title: string; kickoff: string }): Promise<string>;
  /** The ids of the agent providers bb has, such as claude-code, codex and pi. */
  providerIds(): Promise<string[]>;
  /** The ids among `threadIds` with a pending interaction (a question or an approval); unknown threads are left out. */
  waitingOnUser(threadIds: readonly string[]): Promise<string[]>;
  /** The thread's final output, as GET /threads/:id/output assembles it; null before it has one. */
  threadOutput(threadId: string): Promise<string | null>;
  /** A worker's worktree now, uncommitted and untracked files included, against its merge base with `base`, as bb's own diff reads it. */
  environmentFiles(environmentId: string, base: string): Promise<EnvironmentFiles>;
  /** One file's patch in that same comparison. */
  environmentPatch(environmentId: string, base: string, path: string): Promise<EnvironmentPatch>;
}

export interface EnvironmentFile {
  path: string;
  previousPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  untracked: boolean;
}

export type EnvironmentFiles = { outcome: "ok"; files: EnvironmentFile[]; truncated: boolean } | { outcome: "unavailable"; message: string };
export type EnvironmentPatch = { outcome: "ok"; patch: string; truncated: boolean } | { outcome: "unavailable"; message: string };

export interface SpawnArgs {
  bbProjectId: string;
  hostId: string;
  baseBranch: string;
  title: string;
  prompt: string;
  sectionId: string | null;
  metadata: Record<string, string>;
  providerId?: string;
  model?: string;
  reasoningLevel?: string;
  permissionMode?: "accept-edits" | "auto" | "full";
  /** Text only the agent reads, after the prompt. */
  detail?: string;
}

export interface ThreadInfo {
  id: string;
  status: string;
  archivedAt: number | null;
  deletedAt: number | null;
  environmentId: string | null;
}

export interface EnvironmentInfo {
  path: string | null;
  branchName: string | null;
  hostId: string;
  /** bb's environment status: creating, provisioning, ready, error or destroyed. */
  status?: string;
}

/** Calls the host entry on the machine that owns a project's checkout. */
export interface HostPort {
  call<M extends HostMethod>(hostId: string, method: M, input: HostInput<M>): Promise<HostOutput<M>>;
}
