// What Shuttle needs from bb, behind an interface so tests can fake it.
import type { JsonValue } from "@get-bb/plugin-sdk";
import { ShuttleError } from "./ctx";
import type { Workspace } from "./workspaces";

/**
 * bb cannot start the thread now, though it may soon: its machine provider has no room or is not ready, its environment
 * provider says it is unavailable, or bb marked the error retryable. The message is bb's.
 */
export class SpawnUnavailableError extends ShuttleError {
  override readonly name = "SpawnUnavailableError";
}

/** At most how many unarchived threads Shuttle reads when it looks for one, such as for the link dialog or a PR's opener. */
export const THREAD_SCAN = 5000;

export interface SpawnArgs {
  projectId: string;
  title: string;
  prompt: string;
  workspace: Workspace;
  providerId?: string;
  model?: string;
  reasoningLevel?: string;
  sectionId?: string;
  metadata: { [key: string]: JsonValue };
}

export interface ThreadInfo {
  id: string;
  title: string;
  archived: boolean;
  projectId: string | null;
  status: string;
  /** It asked the user something and waits for the answer. */
  waiting: boolean;
  /** The branch of its environment, when it has one. */
  branch: string | null;
  updatedAt: number | null;
  queuedMessageCount?: number;
  /** bb hides it from thread lists unless asked, as with a thread another plugin keeps for itself. */
  hidden?: boolean;
  /** The agent it runs on, such as pi; a send cannot change it. */
  providerId?: string | null;
  /** Its workspace was removed after an archive and its provider can build it again. */
  canRestoreEnvironment?: boolean;
  /** bb removed, or is removing, the machine its workspace was on, so neither can come back. */
  machineRemoved?: boolean;
  /** bb set up a workspace for it; false for a thread whose workspace setup failed, left out when unknown. */
  hasWorkspace?: boolean;
}

/** A bb environment provider, as Shuttle's settings and the server test read it. */
export interface EnvironmentProviderInfo {
  id: string;
  displayName: string;
  description: string | null;
  /** The JSON Schema of its inputs; null when it takes none. */
  inputs: unknown;
  /** Set on an environment that makes a new machine for each thread: the machine provider it makes it with. */
  machineProviderId: string | null;
}

/** A bb machine provider, which can give a thread a new machine of its own. */
export interface MachineProviderInfo {
  id: string;
  displayName: string;
  description: string | null;
  /** The JSON Schema of its inputs; null when it takes none. */
  inputs: unknown;
}

/** A message's own model and thinking level, for this turn and the ones after it. */
export interface SendOptions {
  mode?: "queue-if-active";
  model?: string;
  reasoningLevel?: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  gitRemoteUrl: string | null;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
}

/** Burn, the plugin that reads what every thread used, is not installed or not running. The message is bb's. */
export class UsageUnavailableError extends ShuttleError {
  override readonly name = "UsageUnavailableError";
}

/** Tokens by kind; their sum is the thread's tokens. Reasoning is part of output. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** What one thread used over its life, as Burn reads it from the thread's harness. */
export interface ThreadUsage {
  startedAt: number;
  updatedAt: number;
  calls: number;
  tokens: TokenCounts;
  /** Dollars, at Burn's prices. */
  cost: number;
  /** Some of the cost is Burn's list-price estimate rather than what the harness recorded. */
  estimated: boolean;
  /** The model that cost the most, for turns that name none. */
  model: string | null;
  /** The thread's latest turns, oldest first: Burn lists only the last 50. */
  turns: Array<{ n: number; at: number; calls: number; cost: number; tokens: TokenCounts; model: string | null }>;
}

export interface UsageRead {
  /** Null when Burn has no figures for the thread. */
  usage: ThreadUsage | null;
  /** Every thread under it that Burn has figures for, such as a review's critics, however deep. */
  descendants: string[];
}

export interface BbPort {
  spawnThread(args: SpawnArgs): Promise<string>;
  send(threadId: string, text: string, options?: SendOptions): Promise<void>;
  /** Archives the thread with its child threads; the ids bb archived, the thread's own included. */
  archive(threadId: string): Promise<string[]>;
  /** Brings back only the thread itself: its child threads stay archived. */
  unarchive(threadId: string): Promise<void>;
  /** Asks the thread's environment provider to build its removed workspace again. */
  restoreEnvironment(threadId: string): Promise<void>;
  /** The id of the sidebar section with this name, created when there is none. */
  ensureSection(name: string): Promise<string>;
  getThread(threadId: string): Promise<ThreadInfo | null>;
  threadOutput(threadId: string): Promise<string | null>;
  /** Unarchived threads; bb's order is not by recency, so callers sort. */
  listThreads(limit: number): Promise<ThreadInfo[]>;
  /** These threads, archived or not, at most 200 ids; unknown and deleted ids are left out. */
  threadsById(threadIds: readonly string[]): Promise<ThreadInfo[]>;
  /** The thread's unarchived child threads, such as the critics a review starts. */
  /** The unarchived threads right under it; `hidden` adds the ones bb leaves out of lists, such as another plugin's. */
  childThreads(threadId: string, options?: { hidden?: boolean }): Promise<ThreadInfo[]>;
  listProjects(): Promise<ProjectInfo[]>;
  listSkills(projectId: string): Promise<SkillInfo[]>;
  /** Every environment provider bb has, on any machine; bb tells availability only for a project on a machine, so this has none. */
  environmentProviders(): Promise<EnvironmentProviderInfo[]>;
  machineProviders(): Promise<MachineProviderInfo[]>;
  /** Changes Shuttle's own bb settings. */
  setSettings(patch: { autoAgent?: boolean; inboxRequests?: boolean }): Promise<void>;
  publish(tags?: string[]): void;
  /** Runs `fn` just before each publish reaches the page, such as to rebuild what its reads will ask for. */
  beforePublish?(fn: () => void): void;
  log(level: "info" | "warn" | "error", text: string): void;
  /** Sends the user a notification through bb's push-notifications plugin; without it, only logs. */
  notify(title: string, body: string): Promise<void>;
  /** What the thread used, from the Burn plugin; throws UsageUnavailableError without Burn. */
  threadUsage(threadId: string): Promise<UsageRead>;
}
