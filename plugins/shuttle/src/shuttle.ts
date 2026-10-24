// Shuttle's operations, shared by the RPC handlers, the agent tools and the CLI.
import { adapterFor, type Adapter } from "./adapters";
import type { Runner } from "./adapters/exec";
import { configChanges, configFromToml, configToToml, ConfigError, parseConfig, serverSchema, type Config, type ServerConfig, type WatchMode } from "./config";
import { SECTIONS, type EventView, type LinkRole, type Overview, type PrView, type ReviewInput, type Section, type TestResult, type ThreadOption } from "./contract";
import { errText, ShuttleError, type Ctx } from "./ctx";
import type { EventRow, Store } from "./db/store";
import type { BbPort, ProjectInfo } from "./ports";
import { fetchPr, linkPr, lookup, rememberThread, requirePr, setWatch, unlinkPr } from "./prs";
import { parseKey } from "./keys";
import { matchProject } from "./projects";
import { startOwnerThread, startReview } from "./reviews";
import type { Settings } from "./settings";
import { runAutoReviews, syncServer } from "./sync";
import { allViews, inSection, toView } from "./views";
import { deliver, pollWatches } from "./watch";

const PROJECTS_TTL_MS = 5 * 60_000;

export interface ShuttleDeps {
  store: Store;
  port: BbPort;
  now: () => number;
  settings: () => Settings;
  runner?: Runner;
}

export function toEventView(row: EventRow): EventView {
  return { id: row.id, at: row.at, kind: row.kind, text: row.text, key: row.key, threadId: row.thread_id };
}

export class Shuttle implements Ctx {
  readonly store: Store;
  readonly port: BbPort;
  readonly now: () => number;
  readonly settings: () => Settings;
  private readonly runner?: Runner;
  private readonly adapters = new Map<string, { json: string; adapter: Adapter }>();
  private projectCache: { at: number; projects: ProjectInfo[] } | null = null;
  private syncing: Promise<void> | null = null;
  private deliveries: Promise<unknown> = Promise.resolve();

  constructor(deps: ShuttleDeps) {
    this.store = deps.store;
    this.port = deps.port;
    this.now = deps.now;
    this.settings = deps.settings;
    this.runner = deps.runner;
  }

  config(): Config {
    return this.store.config();
  }

  server(id: string): ServerConfig | null {
    return this.config().servers.find((s) => s.id === id) ?? null;
  }

  adapter(serverId: string): Adapter {
    const server = this.server(serverId);
    if (!server) throw new ShuttleError(`no server called ${serverId}`);
    const json = JSON.stringify(server);
    const cached = this.adapters.get(serverId);
    if (cached?.json === json) return cached.adapter;
    const adapter = adapterFor(server, this.runner);
    this.adapters.set(serverId, { json, adapter });
    return adapter;
  }

  async projects(): Promise<ProjectInfo[]> {
    if (this.projectCache && this.now() - this.projectCache.at < PROJECTS_TTL_MS) return this.projectCache.projects;
    const projects = await this.port.listProjects();
    this.projectCache = { at: this.now(), projects };
    return projects;
  }

  saveConfig(raw: unknown): Config {
    const config = parseConfig(raw);
    this.store.saveConfig(config);
    this.store.addEvent("config", "Settings saved.");
    this.port.publish();
    return config;
  }

  exportToml(): string {
    return configToToml(this.config());
  }

  importToml(toml: string, apply: boolean): { changes: string[]; config: Config | null } {
    const next = configFromToml(toml);
    const changes = configChanges(this.config(), next);
    if (!apply) return { changes, config: null };
    return { changes, config: this.saveConfig(next) };
  }

  overview(): Overview {
    const views = allViews(this);
    const counts = Object.fromEntries(SECTIONS.map((s) => [s, views.filter((v) => inSection(v, s, this)).length])) as Record<Section, number>;
    const servers = this.config().servers.map((server) => {
      const row = this.store.server(server.id);
      let operations: string[];
      try {
        operations = this.adapter(server.id).operations();
      } catch {
        operations = [];
      }
      return {
        id: server.id,
        name: server.name,
        kind: server.kind,
        enabled: server.enabled,
        ok: row?.ok === null || row?.ok === undefined ? null : row.ok === 1,
        login: row?.login ?? null,
        error: row?.error ?? null,
        lastOkAt: row?.last_ok_at ?? null,
        lastSyncAt: row?.last_sync_at ?? null,
        durationMs: row?.duration_ms ?? null,
        operations,
      };
    });
    const syncedAt = servers.reduce<number | null>((max, s) => (s.lastSyncAt !== null && (max === null || s.lastSyncAt > max) ? s.lastSyncAt : max), null);
    return { servers, counts, syncedAt, syncing: this.syncing !== null, paused: this.settings().pauseAutomations };
  }

  list(section: Section): PrView[] {
    return allViews(this).filter((v) => inSection(v, section, this));
  }

  view(key: string): PrView {
    return toView(this, requirePr(this, key));
  }

  detail(key: string): { pr: PrView; events: EventView[] } {
    const pr = requirePr(this, key);
    return { pr: toView(this, pr), events: this.store.events({ prId: pr.id, limit: 50 }).map(toEventView) };
  }

  /** A deep link to a PR Shuttle has not stored yet looks it up on its server first. */
  async detailOrLookup(key: string): Promise<{ pr: PrView; events: EventView[] }> {
    if (!this.store.prByKey(key)) await lookup(this, key);
    return this.detail(key);
  }

  /** Fetches the PRs whose stored copy is older than maxAgeMs; failures keep the stored copy. */
  async refreshStale(keys: readonly string[], maxAgeMs: number, signal?: AbortSignal): Promise<void> {
    for (const key of keys) {
      if (signal?.aborted) return;
      const pr = this.store.prByKey(key);
      const ref = parseKey(key);
      // Search results carry no diff counts, so a PR seen only in a list is fetched once on view.
      const partial = pr !== null && pr.files === null;
      if (!pr || !ref || (!partial && this.now() - pr.fetched_at < maxAgeMs) || (!partial && pr.state !== "open" && pr.state !== "draft")) continue;
      await fetchPr(this, ref).catch((error: unknown) => this.port.log("warn", `refresh ${key}: ${errText(error)}`));
    }
  }

  activity(limit = 100): EventView[] {
    return this.store.events({ limit }).map(toEventView);
  }

  async lookup(query: string): Promise<PrView> {
    return toView(this, await lookup(this, query, true));
  }

  async link(query: string, threadId: string, role: LinkRole = "owner", watch?: boolean): Promise<PrView> {
    const pr = await lookup(this, query);
    await linkPr(this, pr, threadId, role, watch === undefined ? {} : { watch });
    return toView(this, this.store.prById(pr.id)!);
  }

  async unlink(query: string, threadId: string): Promise<PrView> {
    const pr = await lookup(this, query);
    unlinkPr(this, pr, threadId);
    return toView(this, pr);
  }

  watch(key: string, mode: WatchMode | null): PrView {
    const pr = requirePr(this, key);
    setWatch(this, pr, mode);
    return toView(this, pr);
  }

  dismiss(key: string): PrView {
    const pr = requirePr(this, key);
    this.store.setDismissed(pr.id, this.now());
    this.port.publish();
    return toView(this, pr);
  }

  async review(input: ReviewInput): Promise<string> {
    await lookup(this, input.key);
    return (await startReview(this, input, "manual")).threadId;
  }

  async newThread(key: string, start: "own" | "review", projectId?: string): Promise<string> {
    await lookup(this, key);
    if (start === "review") return (await startReview(this, { key, ...(projectId ? { projectId } : {}) }, "manual")).threadId;
    return startOwnerThread(this, key, projectId);
  }

  threadPrs(threadId: string): { prs: PrView[]; sent: EventView[] } {
    return {
      prs: this.store.prsOfThread(threadId).map((pr) => toView(this, pr)),
      sent: this.store.events({ threadId, kinds: ["forwarded"], limit: 30 }).map(toEventView),
    };
  }

  async sendUnread(threadId: string): Promise<number> {
    await pollWatches(this);
    return this.deliver({ force: true, threadId });
  }

  /** One delivery at a time, so a manual send and a background one never send the same item twice. */
  deliver(options: { force?: boolean; threadId?: string } = {}): Promise<number> {
    const run = this.deliveries.then(() => deliver(this, options));
    this.deliveries = run.catch(() => undefined);
    return run;
  }

  async threads(query?: string): Promise<ThreadOption[]> {
    const threads = await this.port.listThreads(200);
    const q = query?.trim().toLowerCase();
    return threads
      .filter((t) => !t.archived && (!q || t.title.toLowerCase().includes(q)))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 50)
      .map((t) => ({ id: t.id, title: t.title, projectId: t.projectId, status: t.status, updatedAt: t.updatedAt }));
  }

  async projectOptions(key?: string): Promise<{ projects: Array<{ id: string; name: string }>; suggested: string | null }> {
    const projects = await this.projects();
    const pr = key ? this.store.prByKey(key) : null;
    const suggested = pr ? matchProject(pr.repo, projects, this.settings().defaultProject || null) : this.settings().defaultProject || null;
    return { projects: projects.map((p) => ({ id: p.id, name: p.name })), suggested };
  }

  async skills(projectId?: string): Promise<Array<{ id: string; name: string; description: string }>> {
    const id = projectId || this.settings().defaultProject || (await this.projects())[0]?.id;
    if (!id) return [];
    return this.port.listSkills(id);
  }

  async testServer(input: { id?: string; server?: unknown }): Promise<TestResult[]> {
    let server: ServerConfig;
    if (input.server !== undefined) {
      const parsed = serverSchema.safeParse(input.server);
      if (!parsed.success) throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      server = parsed.data;
    } else {
      const found = input.id ? this.server(input.id) : null;
      if (!found) throw new ShuttleError(`no server called ${input.id}`);
      server = found;
    }
    const adapter = adapterFor(server, this.runner);
    const results: TestResult[] = [];
    const time = async (operation: string, fn: () => Promise<string>) => {
      const start = this.now();
      try {
        results.push({ operation, ok: true, detail: await fn(), ms: this.now() - start });
      } catch (error) {
        results.push({ operation, ok: false, detail: errText(error), ms: this.now() - start });
      }
    };
    const ops = new Set(adapter.operations());
    let sample: { repo: string; number: number; url: string } | null = null;
    if (ops.has("whoami")) await time("whoami", async () => `signed in as ${await adapter.whoami()}`);
    for (const op of ["authored", "review_requested", "team_requested", "mentioned"] as const) {
      if (!ops.has(op)) continue;
      await time(op, async () => {
        const { rows } = await adapter.list(op, op === "authored" ? { state: "open" } : {});
        if (!sample && rows[0]) sample = { repo: rows[0].repo, number: rows[0].number, url: rows[0].url ?? "" };
        return `${rows.length} PR${rows.length === 1 ? "" : "s"}`;
      });
    }
    const target = sample as { repo: string; number: number; url: string } | null;
    if (target) {
      if (ops.has("view")) await time("view", async () => `${(await adapter.view(target.repo, target.number)).title}`);
      if (ops.has("activity")) await time("activity", async () => `${(await adapter.activity(target.repo, target.number)).items.length} items`);
    }
    return results;
  }

  /** Syncs every enabled server, runs the auto reviews and checks watched PRs. One at a time. */
  sync(signal?: AbortSignal): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      this.port.publish();
      try {
        for (const server of this.config().servers) {
          if (!server.enabled || signal?.aborted) continue;
          const result = await syncServer(this, server, signal);
          if (result.ok) await runAutoReviews(this, server.id);
          await pollWatches(this, server.id, signal);
        }
        await this.refreshThreadTitles();
        await this.deliver();
      } finally {
        this.syncing = null;
        this.port.publish();
      }
    })();
    return this.syncing;
  }

  /** The loop's step: a sync when one is due, and the batches whose window passed. */
  async tick(signal?: AbortSignal): Promise<void> {
    const last = this.overview().syncedAt;
    if (last === null || this.now() - last >= this.settings().syncMinutes * 60_000) await this.sync(signal);
    else await this.deliver();
  }

  private async refreshThreadTitles(): Promise<void> {
    for (const threadId of this.store.linkedThreadIds().slice(0, 100)) {
      try {
        const thread = await this.port.getThread(threadId);
        if (thread) this.store.saveThread(thread.id, thread.title, thread.archived);
        else this.store.forgetThread(threadId);
      } catch {
        // A title refresh is cosmetic; the next sync tries again.
      }
    }
  }

  onThreadIdle(threadId: string): void {
    const running = this.store.runningReviewsOfThread(threadId);
    for (const review of running) this.store.finishReview(review.id, "done");
    if (running.length) this.port.publish();
  }

  onThreadFailed(threadId: string): void {
    const running = this.store.runningReviewsOfThread(threadId);
    for (const review of running) {
      this.store.finishReview(review.id, "failed");
      this.store.addEvent("review_failed", `The review thread \u201c${this.store.threadTitle(threadId) ?? threadId}\u201d failed.`, review.pr_id, threadId);
    }
    if (running.length) this.port.publish();
  }

  async onThreadArchived(threadId: string): Promise<void> {
    if (!this.store.linkedThreadIds().includes(threadId)) return;
    await rememberThread(this, threadId).catch(() => {});
    this.port.publish();
  }

  onThreadDeleted(threadId: string): void {
    this.store.forgetThread(threadId);
    this.port.publish();
  }
}
