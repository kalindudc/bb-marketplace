import Database from "better-sqlite3";
import type { Runner, RunOptions } from "../src/adapters/exec";
import { DEFAULT_CONFIG, parseConfig, type Config } from "../src/config";
import { MIGRATIONS } from "../src/db/schema";
import { Store } from "../src/db/store";
import type { BbPort, ProjectInfo, SpawnArgs, ThreadInfo } from "../src/ports";
import { DEFAULT_SETTINGS, type Settings } from "../src/settings";
import { Shuttle } from "../src/shuttle";

export function memoryDb(): Database.Database {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  return db;
}

export class FakePort implements BbPort {
  spawned: Array<SpawnArgs & { threadId: string }> = [];
  sent: Array<{ threadId: string; text: string }> = [];
  threads = new Map<string, ThreadInfo>();
  projects: ProjectInfo[] = [{ id: "proj_world", name: "world", gitRemoteUrl: "git@github.com:Shopify/world.git" }];
  failSendTo = new Set<string>();
  sections = new Map<string, string>();
  failSections = false;
  publishes = 0;
  logs: string[] = [];
  private next = 1;

  addThread(id: string, title = `Thread ${id}`, archived = false): void {
    this.threads.set(id, { id, title, archived, projectId: "proj_world", status: "idle", updatedAt: 0 });
  }
  async spawnThread(args: SpawnArgs): Promise<string> {
    const threadId = `thr_spawned${this.next++}`;
    this.spawned.push({ ...args, threadId });
    this.addThread(threadId, args.title);
    return threadId;
  }
  async send(threadId: string, text: string): Promise<void> {
    if (this.failSendTo.has(threadId)) throw new Error("thread is gone");
    this.sent.push({ threadId, text });
  }
  async ensureSection(name: string): Promise<string> {
    if (this.failSections) throw new Error("sections are down");
    if (!this.sections.has(name)) this.sections.set(name, `sec_${this.sections.size + 1}`);
    return this.sections.get(name)!;
  }
  async getThread(threadId: string): Promise<ThreadInfo | null> {
    return this.threads.get(threadId) ?? null;
  }
  async listThreads(): Promise<ThreadInfo[]> {
    return [...this.threads.values()];
  }
  async listProjects(): Promise<ProjectInfo[]> {
    return this.projects;
  }
  async listSkills(): Promise<Array<{ id: string; name: string; description: string }>> {
    return [{ id: "s1", name: "pr-reviewer", description: "Reviews" }];
  }
  publish(): void {
    this.publishes++;
  }
  log(_level: string, text: string): void {
    this.logs.push(text);
  }
}

export type Responder = (operation: string, env: Record<string, string>) => unknown;

/** A runner that answers command-server operations from a function of SHUTTLE_OPERATION and the env. */
export function fakeRunner(respond: Responder): Runner & { calls: Array<{ operation: string; env: Record<string, string> }> } {
  const calls: Array<{ operation: string; env: Record<string, string> }> = [];
  const runner = async (_bin: string, _args: readonly string[], options: RunOptions) => {
    const env = options.env ?? {};
    const operation = env.SHUTTLE_OPERATION ?? "";
    calls.push({ operation, env });
    const value = respond(operation, env);
    if (value instanceof Error) return { code: 1, stdout: "", stderr: value.message, timedOut: false };
    return { code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "", timedOut: false };
  };
  return Object.assign(runner, { calls });
}

export const TEST_SERVER = {
  id: "forge",
  name: "Forge",
  kind: "command",
  pattern: "^https://forge\\.test/(?<repo>[^/]+/[^/]+)/pull/(?<number>\\d+)",
  link: "https://forge.test/{repo}/pull/{number}",
  read: "forge pr view {number} -R {repo}",
  commands: { whoami: "w", authored: "a", review_requested: "r", team_requested: "t", mentioned: "m", view: "v", activity: "x" },
} as const;

export function testConfig(patch: Partial<Config> = {}): Config {
  return parseConfig({ ...DEFAULT_CONFIG, servers: [TEST_SERVER], ...patch });
}

export function pr(number: number, extra: Record<string, unknown> = {}) {
  return { repo: "shop/world", number, title: `PR ${number}`, author: "sam", state: "open", head: `head${number}`, checks: "passed", review: "required", updated_at: "2026-10-23T10:00:00Z", ...extra };
}

export interface Harness {
  shuttle: Shuttle;
  store: Store;
  port: FakePort;
  clock: { now: number };
  settings: Settings;
  lists: Record<string, unknown[]>;
  views: Record<number, unknown>;
  activity: Record<number, unknown>;
  /** Answers for any other operation, such as the edit commands. */
  answers: Record<string, unknown>;
  runner: ReturnType<typeof fakeRunner>;
}

export function harness(config: Config = testConfig()): Harness {
  const clock = { now: Date.parse("2026-10-23T12:00:00Z") };
  const store = new Store(memoryDb(), () => clock.now);
  store.saveConfig(config);
  const port = new FakePort();
  const settings: Settings = { ...DEFAULT_SETTINGS };
  const lists: Record<string, unknown[]> = { authored: [], review_requested: [], team_requested: [], mentioned: [] };
  const views: Record<number, unknown> = {};
  const activity: Record<number, unknown> = {};
  const answers: Record<string, unknown> = {};
  const runner = fakeRunner((operation, env) => {
    if (operation === "whoami") return { login: "me" };
    if (operation === "authored") return (lists.authored as Array<{ state: string }>).filter((row) => (env.SHUTTLE_STATE === "closed" ? row.state === "merged" || row.state === "closed" : row.state === "open" || row.state === "draft"));
    if (operation in lists) return lists[operation];
    if (operation === "view") return views[Number(env.SHUTTLE_NUMBER)] ?? new Error("not found");
    if (operation === "activity") return activity[Number(env.SHUTTLE_NUMBER)] ?? { items: [] };
    if (operation in answers) return answers[operation];
    return new Error(`unexpected ${operation}`);
  });
  const shuttle = new Shuttle({ store, port, now: () => clock.now, settings: () => settings, runner });
  return { shuttle, store, port, clock, settings, lists, views, activity, answers, runner };
}
