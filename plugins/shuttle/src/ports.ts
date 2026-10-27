// What Shuttle needs from bb, behind an interface so tests can fake it.
import type { JsonValue } from "@get-bb/plugin-sdk";
import type { Workspace } from "./workspaces";

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
  /** The agent it runs on, such as pi; a send cannot change it. */
  providerId?: string | null;
  /** Its workspace was removed after an archive and its provider can build it again. */
  canRestoreEnvironment?: boolean;
}

/** A message's own model and thinking level, for this turn and the ones after it. */
export interface SendOptions {
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
  /** Unarchived threads; bb's order is not by recency, so callers sort. */
  listThreads(limit: number): Promise<ThreadInfo[]>;
  /** These threads, archived or not, at most 200 ids; unknown and deleted ids are left out. */
  threadsById(threadIds: readonly string[]): Promise<ThreadInfo[]>;
  listProjects(): Promise<ProjectInfo[]>;
  listSkills(projectId: string): Promise<SkillInfo[]>;
  /** Changes Shuttle's own bb settings. */
  setSettings(patch: { autoAgent?: boolean; inboxRequests?: boolean }): Promise<void>;
  publish(): void;
  log(level: "info" | "warn" | "error", text: string): void;
}
