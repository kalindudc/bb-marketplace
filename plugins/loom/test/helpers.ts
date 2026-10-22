import Database from "better-sqlite3";
import { vi, type MockInstance } from "vitest";
import { stringify } from "smol-toml";
import type { NewThreadRequest } from "@get-bb/plugin-sdk";
import { createFakePluginHost, type FakeSdkOverrides } from "@get-bb/plugin-sdk/testing";
import { createBbPort } from "../src/bb-port";
import { MIGRATIONS } from "../src/db/schema";
import { Store, type ProjectRow, type ThreadRow, type TicketRow } from "../src/db/store";
import type { HostInput, HostMethod, HostOutput } from "../src/host-contract";
import { settleChecks, submit } from "../src/checks";
import { Engine } from "../src/engine";
import { approve, settleReviews, spawnReviewers } from "../src/review";
import { Projects } from "../src/projects";
import { specOf, spawnWorker, type EngineCtx } from "../src/workers";
import { SectionNameConflictError, type BbPort, type BbProjectInfo, type EnvironmentInfo, type HostPort, type SpawnArgs, type ThreadInfo } from "../src/ports";

export function makeDb(): Database.Database {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  return db;
}

export class Clock {
  t = 1_800_000_000_000;
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export interface PortCall {
  method: string;
  args: unknown[];
}

export class FakePort implements BbPort {
  calls: PortCall[] = [];
  sections = new Map<string, string>();
  hostId: string | null = "host_local";
  takenNames = new Set<string>();
  private nextSection = 1;

  callsTo(method: string): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  private record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
  }

  async threadHostId(threadId: string) {
    this.record("threadHostId", threadId);
    return this.hostId;
  }
  async ensureSection(sectionId: string | null, name: string) {
    this.record("ensureSection", sectionId, name);
    if (sectionId !== null && this.sections.has(sectionId)) return sectionId;
    if (this.takenNames.has(name) || [...this.sections.values()].includes(name)) throw new SectionNameConflictError(name);
    const id = `sec_${this.nextSection++}`;
    this.sections.set(id, name);
    return id;
  }
  async renameSection(sectionId: string, name: string) {
    this.record("renameSection", sectionId, name);
    this.sections.set(sectionId, name);
  }
  async deleteSection(sectionId: string) {
    this.record("deleteSection", sectionId);
    this.sections.delete(sectionId);
  }
  async moveThread(threadId: string, sectionId: string | null) {
    this.record("moveThread", threadId, sectionId);
  }
  async setMetadata(threadId: string, set: Record<string, string | number | boolean | null>) {
    this.record("setMetadata", threadId, set);
  }
  log(level: "info" | "warn" | "error", message: string) {
    this.record("log", level, message);
  }

  // ---- the engine's side of bb: threads, environments and messages
  checkout: string | null = "/repo";
  threads = new Map<string, ThreadInfo>();
  environments = new Map<string, EnvironmentInfo>();
  tokens = new Map<string, number | null>();
  systemErrors = new Map<string, { code: string | null; message: string }>();
  spawnedTokens = new Map<string, string>();
  /** Return an error to make the spawn throw it. */
  spawnError: ((args: SpawnArgs) => Error | null) | null = null;
  /** False makes spawn return no environment yet, like a thread still provisioning. */
  provisionEnvironment = true;
  /** False makes stop leave the thread in `stopping`. */
  stopConfirms = true;
  afterSpawn: ((threadId: string, args: SpawnArgs) => void) | null = null;
  private nextThread = 1;

  /** Checkout paths by bb project id, then host id. A project missing here has `checkout` on every host. */
  checkouts = new Map<string, Record<string, string>>();
  async projectCheckout(bbProjectId: string, hostId: string) {
    this.record("projectCheckout", bbProjectId, hostId);
    const byHost = this.checkouts.get(bbProjectId);
    return byHost === undefined ? this.checkout : (byHost[hostId] ?? null);
  }
  /** The projects bb lists; an Error makes the listing fail. The default is the project every test proposes from, with a checkout on both test hosts. */
  bbProjects: BbProjectInfo[] | Error = [
    {
      id: "proj_1",
      name: "shop",
      kind: "standard",
      gitRemoteUrl: "git@github.com:acme/shop.git",
      sources: [
        { hostId: "host_local", path: "/repo", isDefault: true },
        { hostId: "host_1", path: "/repo", isDefault: true },
      ],
    },
  ];
  async listProjects() {
    this.record("listProjects");
    if (this.bbProjects instanceof Error) throw this.bbProjects;
    return this.bbProjects.map((project) => ({ ...project, sources: project.sources.map((source) => ({ ...source })) }));
  }
  /** Adds a standard bb project to the list with a checkout at each `paths` host, and the same checkouts for projectCheckout. */
  addBbProject(id: string, paths: Record<string, string>, over: Partial<BbProjectInfo> = {}) {
    if (this.bbProjects instanceof Error) this.bbProjects = [];
    const sources = Object.entries(paths).map(([hostId, path]) => ({ hostId, path, isDefault: true }));
    this.bbProjects.push({ id, name: id.replace(/^proj_/, ""), kind: "standard", gitRemoteUrl: `git@github.com:acme/${id}.git`, sources, ...over });
    this.checkouts.set(id, { ...paths });
  }
  async spawnThread(args: SpawnArgs) {
    this.record("spawnThread", args);
    const error = this.spawnError?.(args) ?? null;
    if (error !== null) throw error;
    const n = this.nextThread++;
    const threadId = `thr_w${n}`;
    let environmentId: string | null = null;
    if (this.provisionEnvironment) {
      environmentId = `env_${n}`;
      this.environments.set(environmentId, { path: `/wt/${environmentId}`, branchName: `wt-${threadId}`, hostId: args.hostId });
    }
    this.threads.set(threadId, { id: threadId, status: "active", archivedAt: null, deletedAt: null, environmentId });
    if (args.metadata.spawnToken !== undefined) this.spawnedTokens.set(args.metadata.spawnToken, threadId);
    this.afterSpawn?.(threadId, args);
    return { threadId, environmentId };
  }
  sendError: Error | null = null;
  async send(threadId: string, message: string | { summary: string; detail: string }) {
    this.record("send", threadId, message);
    if (this.sendError !== null) throw this.sendError;
  }
  /** What was sent to one thread, as text. */
  sent(threadId: string): string[] {
    return this.callsTo("send")
      .filter(([id]) => id === threadId)
      .map(([, message]) => {
        const sent = message as string | { summary: string; detail: string };
        return typeof sent === "string" ? sent : `${sent.summary}\n${sent.detail}`;
      });
  }
  async stop(threadId: string) {
    this.record("stop", threadId);
    const thread = this.threads.get(threadId);
    if (thread !== undefined) thread.status = this.stopConfirms ? "idle" : "stopping";
  }
  async archive(threadId: string) {
    this.record("archive", threadId);
    const thread = this.threads.get(threadId);
    if (thread !== undefined) thread.archivedAt = 1;
  }
  async getThread(threadId: string) {
    this.record("getThread", threadId);
    const thread = this.threads.get(threadId);
    return thread === undefined ? null : { ...thread };
  }
  async getEnvironment(environmentId: string) {
    this.record("getEnvironment", environmentId);
    const environment = this.environments.get(environmentId);
    return environment === undefined ? null : { ...environment };
  }
  async findSpawnedThread(spawnToken: string) {
    this.record("findSpawnedThread", spawnToken);
    return this.spawnedTokens.get(spawnToken) ?? null;
  }
  async threadTokens(threadId: string) {
    this.record("threadTokens", threadId);
    return this.tokens.get(threadId) ?? null;
  }
  async latestSystemError(threadId: string) {
    this.record("latestSystemError", threadId);
    return this.systemErrors.get(threadId) ?? null;
  }
  async retryTurn(threadId: string, turnRequestId: string, sendAt: number) {
    this.record("retryTurn", threadId, turnRequestId, sendAt);
  }
  /** A missing id reads as "standard". */
  projectKinds = new Map<string, "standard" | "personal">();
  async projectKind(bbProjectId: string): Promise<"standard" | "personal" | null> {
    this.record("projectKind", bbProjectId);
    return this.projectKinds.get(bbProjectId) ?? "standard";
  }
  async spawnPlanner(args: { request: NewThreadRequest; title: string; kickoff: string }) {
    this.record("spawnPlanner", args);
    const threadId = `thr_p${this.nextThread++}`;
    this.addThread(threadId, "active");
    return threadId;
  }
  /** The provider ids bb has; an Error makes the listing fail. */
  providers: string[] | Error = ["claude", "codex", "claude-code", "pi"];
  async providerIds() {
    this.record("providerIds");
    if (this.providers instanceof Error) throw this.providers;
    return [...this.providers];
  }
  /** Threads with a pending interaction. */
  waiting = new Set<string>();
  async waitingOnUser(threadIds: readonly string[]) {
    this.record("waitingOnUser", [...threadIds]);
    return threadIds.filter((id) => this.waiting.has(id));
  }
  /** Registers a thread bb knows about, such as the planner's. */
  addThread(id: string, status = "idle", environmentId: string | null = null) {
    this.threads.set(id, { id, status, archivedAt: null, deletedAt: null, environmentId });
  }
}

export interface FakeWorktree {
  branch: string | null;
  head: string;
  dirty: boolean;
  changed: string[];
}

/** The host entry with scripted results. Worktrees keep a head, a dirty flag and a changed list that tests edit. */
export class FakeHost implements HostPort {
  calls: Array<{ hostId: string; method: HostMethod; input: unknown }> = [];
  branches = new Set<string>();
  worktrees = new Map<string, FakeWorktree>();
  /** Results for exec, used in order; an Error is thrown, and a missing entry is a pass. */
  execResults: Array<Partial<HostOutput<"exec">> | Error> = [];
  /** A persistent error for one method. */
  errors: Partial<Record<HostMethod, Error | null>> = {};
  onExec: ((input: HostInput<"exec">, worktree: FakeWorktree) => void) | null = null;
  /** Results for any method, used in order before the defaults; an Error is thrown. */
  scripted: Partial<Record<HostMethod, unknown[]>> = {};
  /** The merges made in each worktree, oldest first: what `merge` reports as already merged, and what `resetHard` undoes. */
  merges = new Map<string, Array<{ ref: string; before: string; sha: string }>>();
  prStates = new Map<string, "OPEN" | "MERGED" | "CLOSED">();
  /** The tip fetchBranch reports for the remote's base branch. Every integration branch starts at base000, so base000 means it has not moved. */
  remoteBase = "base000";
  private commits = 0;
  private merged = 0;
  private prs = 0;

  callsTo<M extends HostMethod>(method: M): Array<HostInput<M>> {
    return this.calls.filter((call) => call.method === method).map((call) => call.input as HostInput<M>);
  }

  worktree(path: string): FakeWorktree {
    let state = this.worktrees.get(path);
    if (state === undefined) {
      state = { branch: "wt", head: "c0", dirty: false, changed: [] };
      this.worktrees.set(path, state);
    }
    return state;
  }

  async call<M extends HostMethod>(hostId: string, method: M, input: HostInput<M>): Promise<HostOutput<M>> {
    this.calls.push({ hostId, method, input });
    const error = this.errors[method];
    if (error) throw error;
    if ((this.scripted[method]?.length ?? 0) > 0) {
      const next = this.scripted[method]!.shift();
      if (next instanceof Error) throw next;
      return next as HostOutput<M>;
    }
    return (await this.handle(method, input)) as HostOutput<M>;
  }

  private async handle(method: HostMethod, input: unknown): Promise<unknown> {
    switch (method) {
      case "ensureBranch": {
        const { repo, branch } = input as HostInput<"ensureBranch">;
        const key = `${repo}#${branch}`;
        const created = !this.branches.has(key);
        this.branches.add(key);
        return { sha: "base000", created };
      }
      case "worktreeState": {
        const state = this.worktree((input as HostInput<"worktreeState">).worktree);
        return { branch: state.branch, head: state.head, dirty: state.dirty, changed: [...state.changed] };
      }
      case "commitAll": {
        const state = this.worktree((input as HostInput<"commitAll">).worktree);
        const committed = state.dirty;
        if (committed) {
          state.head = `c${++this.commits}`;
          state.dirty = false;
        }
        return { sha: state.head, committed };
      }
      case "exec": {
        const request = input as HostInput<"exec">;
        this.onExec?.(request, this.worktree(request.cwd));
        const next = this.execResults.shift();
        if (next instanceof Error) throw next;
        return { exitCode: 0, timedOut: false, durationMs: 12, output: "", ...next };
      }
      case "diff":
        return { stat: " src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)", patch: "diff --git a/src/a.ts b/src/a.ts\n+export const a = 1;\n", truncated: false };
      case "ensureWorktree": {
        const { key, branch } = input as HostInput<"ensureWorktree">;
        const path = `/data/worktrees/${key}`;
        if (!this.worktrees.has(path)) this.worktrees.set(path, { branch, head: "base000", dirty: false, changed: [] });
        return { outcome: "ok", path };
      }
      case "merge": {
        const { worktree, ref, before } = input as HostInput<"merge">;
        const state = this.worktree(worktree);
        const list = this.merges.get(worktree) ?? [];
        this.merges.set(worktree, list);
        const earlier = list.find((entry) => entry.ref === ref);
        if (earlier !== undefined || ref === "base000") return { outcome: "merged", sha: state.head, before: before ?? state.head, already: true };
        const entry = { ref, before: state.head, sha: `m${++this.merged}` };
        list.push(entry);
        state.head = entry.sha;
        return { outcome: "merged", sha: entry.sha, before: entry.before, already: false };
      }
      case "resetHard": {
        const { worktree, sha } = input as HostInput<"resetHard">;
        const reset = this.worktree(worktree);
        reset.head = sha;
        reset.dirty = false;
        const list = this.merges.get(worktree) ?? [];
        const index = list.findIndex((entry) => entry.before === sha);
        if (index >= 0) list.splice(index);
        return { sha };
      }
      case "fetchBranch":
        return { outcome: "ok", sha: this.remoteBase };
      case "push":
        return { outcome: "ok" };
      case "prCreate": {
        const url = `https://github.com/acme/shop/pull/${++this.prs}`;
        this.prStates.set(url, "OPEN");
        return { outcome: "ok", url };
      }
      case "prState":
        return { outcome: "ok", state: this.prStates.get((input as HostInput<"prState">).url) ?? "OPEN" };
    }
  }
}

export type Doc = Record<string, any>;

export function baseSpec(): Doc {
  return {
    project: { slug: "csv", name: "CSV export", key: "CSV", goal: "Let people export their orders as a CSV file from the admin page." },
    merge: { strategy: "integration" },
    checks: { commands: ["npm test"] },
    agents: { worker: { provider: "claude", model: "sonnet" }, reviewer: { provider: "codex", model: "gpt" } },
    ticket: [
      { ref: "csv-model", title: "Order rows", body: "Build the row mapper.", acceptance: ["WHEN an order is mapped THE SYSTEM SHALL return one row"], scope: ["src/model/**"] },
      { ref: "csv-export", title: "Export endpoint", body: "Serve the file.", acceptance: ["WHEN the endpoint is called THE SYSTEM SHALL stream a CSV", "WHEN there are no orders THE SYSTEM SHALL return a header row"], scope: ["src/export/**"], depends_on: ["csv-model"] },
    ],
  };
}

export function specToml(edit?: (doc: Doc) => void): string {
  const doc = baseSpec();
  edit?.(doc);
  return stringify(doc);
}

export interface SdkState {
  sections: Array<{ id: string; name: string; createdAt: number; updatedAt: number }>;
  takenNames: Set<string>;
  environmentId: string | null;
  environmentHost: string;
  primaryHostId: string | null;
}

export function sdkStubs(state: SdkState): FakeSdkOverrides {
  let next = 1;
  return {
    threadSections: {
      list: async () => state.sections,
      create: async ({ name }) => {
        if (state.takenNames.has(name)) throw new Error("HTTP 409 section_name_conflict");
        const section = { id: `sec_${next++}`, name, createdAt: 0, updatedAt: 0 };
        state.sections.push(section);
        return section;
      },
      update: async ({ id, name }) => ({ id, name, updatedThreadCount: 0 }),
      delete: async ({ id }) => {
        state.sections = state.sections.filter((section) => section.id !== id);
        return { id, name: "", updatedThreadCount: 0 };
      },
    },
    threads: {
      get: async ({ threadId }) => ({ id: threadId, environmentId: state.environmentId }),
      update: async () => ({}),
      updatePluginMetadata: async () => ({}),
    },
    environments: { get: async ({ environmentId }) => ({ id: environmentId, hostId: state.environmentHost }) },
    system: { config: async () => ({ primaryHostId: state.primaryHostId }) },
  };
}

/**
 * A fake bb host, with the real adapter over stubbed sdk calls unless a port is given; tests register the tools or CLI they exercise.
 * The engine runs over a FakeHost, and its kick is a no-op so nothing runs in the background.
 */
export function makeHost(opts: { port?: BbPort } = {}) {
  const state: SdkState = { sections: [], takenNames: new Set(), environmentId: "env_1", environmentHost: "host_env", primaryHostId: "host_primary" };
  const { bb, harness } = createFakePluginHost({ pluginId: "loom", agentSkillIds: ["loom-plan", "loom"], sdk: sdkStubs(state) });
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new Store(db, Date.now);
  const port = opts.port ?? createBbPort(bb);
  const projects = new Projects({ store, bb: port, now: Date.now });
  const hostPort = new FakeHost();
  const engine = new Engine({ store, bb: port, now: Date.now, host: hostPort, projects });
  vi.spyOn(engine, "kick").mockImplementation(() => undefined);
  return { bb, harness, state, store, projects, engine, hostPort };
}

// ---- the engine's pieces without bb: a store, a fake port, a fake host, and a clock

export interface EngineHarness {
  ctx: EngineCtx;
  clock: Clock;
  store: Store;
  bb: FakePort;
  host: FakeHost;
  projects: Projects;
  kicks: { count: number };
}

export function makeCtx(): EngineHarness {
  const clock = new Clock();
  const store = new Store(makeDb(), clock.now);
  const bb = new FakePort();
  bb.addThread("thr_plan", "idle");
  const host = new FakeHost();
  const projects = new Projects({ store, bb, now: clock.now });
  const kicks = { count: 0 };
  const ctx: EngineCtx = { store, bb, now: clock.now, host, kick: () => void (kicks.count += 1) };
  return { ctx, clock, store, bb, host, projects, kicks };
}

/** Proposes and approves the base spec (two tickets, CSV-1 and CSV-2), then moves the project to `state`. */
export async function seedProject(h: EngineHarness, edit?: (doc: Doc) => void, state: "ready" | "running" | "paused" = "running"): Promise<ProjectRow> {
  await h.projects.propose({ toml: specToml(edit), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
  await h.projects.approve("csv", "human");
  const project = h.store.projectBySlug("csv")!;
  if (state !== "ready") h.store.setProjectState(project.id, "running", "human");
  if (state === "paused") h.store.setProjectState(project.id, "paused", "human");
  return h.store.projectBySlug("csv")!;
}

/**
 * A running project over three repos, each its own bb project with a checkout on host_1: web (its own checks and a protected path),
 * api (another base and remote, the top-level checks) and docs (its own checks). CSV-1 is in web and CSV-2 in api, with no dependency.
 */
export async function seedRepoProject(h: EngineHarness, edit?: (doc: Doc) => void): Promise<ProjectRow> {
  h.bb.addBbProject("proj_web", { host_1: "/src/web" });
  h.bb.addBbProject("proj_api", { host_1: "/src/api" });
  h.bb.addBbProject("proj_docs", { host_1: "/src/docs" });
  return seedProject(h, (doc) => {
    doc.scope = { protected: ["db/**"] };
    doc.repo = [
      { name: "web", project: "proj_web", checks: ["npm run web-test"], protected: ["web.lock"] },
      { name: "api", project: "proj_api", base: "trunk", remote: "upstream" },
      { name: "docs", project: "proj_docs", checks: ["npm run docs-test"] },
    ];
    doc.ticket[0].repo = "web";
    doc.ticket[1].repo = "api";
    doc.ticket[1].depends_on = [];
    edit?.(doc);
  });
}

export const ticketOf = (h: EngineHarness, key: string): TicketRow => h.store.ticketByKey(key)!;
export const workerRows = (h: EngineHarness, key: string): ThreadRow[] => h.store.threads({ ticketId: ticketOf(h, key).id, role: "worker" });

/** A queued ticket claimed by a running worker whose thread and environment exist in the fake bb. */
export async function startWorker(h: EngineHarness, key = "CSV-1"): Promise<ThreadRow> {
  const project = h.store.projectBySlug("csv")!;
  await spawnWorker(h.ctx, project, specOf(h.store, project), ticketOf(h, key));
  const rows = workerRows(h, key);
  return rows[rows.length - 1]!;
}

/** A started worker whose environment bb attached only after spawn returned: the row has none, the thread does. */
export async function startLateWorker(h: EngineHarness, key = "CSV-1"): Promise<ThreadRow> {
  h.bb.provisionEnvironment = false;
  const row = await startWorker(h, key);
  h.bb.threads.get(row.thread_id!)!.environmentId = "env_late";
  h.bb.environments.set("env_late", { path: "/wt/late", branchName: "late-branch", hostId: "host_1" });
  return row;
}

/** The whole engine over the fakes. kick() is a no-op spy, so a test decides when the loop runs by calling engine.tick(). */
export function makeEngine(): EngineHarness & { engine: Engine; kick: MockInstance<() => void> } {
  const harness = makeCtx();
  const engine = new Engine({ store: harness.store, bb: harness.bb, now: harness.clock.now, host: harness.host, projects: harness.projects });
  const kick = vi.spyOn(engine, "kick").mockImplementation(() => undefined);
  return { ...harness, ctx: engine.ctx, engine, kick };
}

/** Adds a third ticket, CSV-3, whose scope overlaps neither of the base spec's two. */
export const withDocsTicket = (doc: Doc) =>
  doc.ticket.push({ ref: "csv-docs", title: "Docs", body: "Write the docs.", acceptance: ["WHEN the docs are built THE SYSTEM SHALL list the export"], scope: ["docs/**"] });

/** A started worker that changed a file, submitted, and passed the checks: the ticket is in review and the worker is still live. */
export async function reachReview(h: EngineHarness, key = "CSV-1"): Promise<ThreadRow> {
  const row = await startWorker(h, key);
  const worktree = h.host.worktree(`/wt/${row.environment_id}`);
  worktree.dirty = true;
  worktree.changed = ["src/model/a.ts"];
  submit(h.ctx, row.thread_id!, "Done");
  await settleChecks(h.ctx);
  return row;
}

/** Puts a reviewer's worktree on the commit its ticket was reviewed at, as the brief tells it to. */
export function checkOutHead(h: EngineHarness, reviewer: ThreadRow): void {
  const ticket = h.store.ticket(reviewer.ticket_id!)!;
  h.host.worktree(`/wt/${reviewer.environment_id}`).head = ticket.head_sha!;
}

/** A ticket in review that one reviewer approved: it is `approved` and waits for the merge queue; its worker is still live. */
export async function reachApproved(h: EngineHarness, key = "CSV-1"): Promise<ThreadRow> {
  const worker = await reachReview(h, key);
  const project = h.store.projectBySlug("csv")!;
  await spawnReviewers(h.ctx, project, specOf(h.store, project));
  const reviewer = h.store.threads({ ticketId: ticketOf(h, key).id, role: "reviewer" }).at(-1)!;
  checkOutHead(h, reviewer);
  await approve(h.ctx, reviewer.thread_id!, "Looks good");
  await settleReviews(h.ctx);
  return worker;
}
