// What Shuttle needs from bb, behind an interface so tests can fake it.
import type { JsonValue } from "@get-bb/plugin-sdk";
import type { Workspace } from "./workspaces";

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
  send(threadId: string, text: string): Promise<void>;
  /** The id of the sidebar section with this name, created when there is none. */
  ensureSection(name: string): Promise<string>;
  getThread(threadId: string): Promise<ThreadInfo | null>;
  listThreads(limit: number): Promise<ThreadInfo[]>;
  listProjects(): Promise<ProjectInfo[]>;
  listSkills(projectId: string): Promise<SkillInfo[]>;
  /** Changes Shuttle's own bb settings. */
  setSettings(patch: { autoAgent?: boolean; inboxRequests?: boolean }): Promise<void>;
  publish(): void;
  log(level: "info" | "warn" | "error", text: string): void;
}
