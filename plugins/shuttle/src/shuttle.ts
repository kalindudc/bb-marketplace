// Shuttle's operations, shared by the RPC handlers, the agent tools and the CLI.
import { adapterFor, type Adapter } from "./adapters";
import { runProcess, sleep, type Runner } from "./adapters/exec";
import { configChanges, configFromToml, configToToml, ConfigError, parseConfig, serverSchema, type Config, type ServerConfig, type WatchMode } from "./config";
import type {
  AgentMode, AgentTarget, Area, BoardDetail, BoardSummary, ConversationItem, EventView, InboxRule, InboxRuleKind, InboxView, InsightsView, LinkRole, MergeMethod, MergeOptions, Outcome, Overview, LinkCard, PostFinding, PrChange, PrDetails,
  PrView, ReviewDraft, ReviewInput, ServerStatus, SyncHistory, SyncRun, SyncStep, SyncStepName, TestResult, ThreadOption, Verdict,
} from "./contract";
import { askAgent, runAutoAgent, setAgent, setAgentMode, type AgentChange } from "./agents";
import { board as readBoard, boardAdd, boardCreate, boardRemove, boards as listBoards, boardUpdate } from "./boards";
import { cancelAutoMerge, comment, Conversations, merge, mergeOptions, recordOutcomes, reply, resolve } from "./conversation";
import { draftView, saveDraft, setDraftState, submitReview, type DraftInput } from "./drafts";
import { addRule, dismiss, inbox as readInbox, markSeen, removeRule, snooze } from "./inbox";
import { insights, INSIGHTS_SINCE, snapshotCounts } from "./insights";
import { feedbackSignature, phaseOf } from "./next";
import { errText, ShuttleError, type Ctx } from "./ctx";
import type { EventRow, ServerRow, Store, SyncRunRow } from "./db/store";
import { THREAD_SCAN, type BbPort, type ProjectInfo } from "./ports";
import { fetchPr, linkPr, lookup, rememberThread, requirePr, setWatch, shortKey, unlinkPr } from "./prs";
import { parseKey } from "./keys";
import { matchProject } from "./projects";
import { archiveDoneReviewThreads, unarchiveForDraft } from "./review-threads";
import { startReview } from "./reviews";
import { searchPrs } from "./search";
import type { Settings } from "./settings";
import { primaryStep } from "./failures";
import { RECHECK_MS, runAutoReviews, syncServer } from "./sync";
import { allViews, inArea, inboxOf, toView } from "./views";
import { editOptions, editPr } from "./edit";
import { LinkCards } from "./link-cards";
import { deliver, pollWatches } from "./watch";

const PROJECTS_TTL_MS = 5 * 60_000;
/** The link and agent dialogs list the most recent threads; a search reaches the rest. */
const THREAD_OPTIONS = 200;
const DAY_MS = 86_400_000;
/** How far back the Sync tab's marks go. */
const HISTORY_WINDOW_MS = 3 * 3_600_000;
const FULL_SYNC_AT = "full_sync_at";

const stepsOf = (run: SyncRunRow) => JSON.parse(run.steps) as SyncStep[];
const toRun = (run: SyncRunRow): SyncRun => ({ id: run.id, at: run.at, durationMs: run.duration_ms, state: run.state, steps: stepsOf(run) });
const kindsOf = (run: SyncRunRow | null) => (run === null ? [] : stepsOf(run).flatMap((step) => (step.failure ? [step.failure.kind] : [])));

export interface ShuttleDeps {
  store: Store;
  port: BbPort;
  now: () => number;
  settings: () => Settings;
  runner?: Runner;
  /** Aborts when the plugin stops: syncs started by the UI or the CLI end with it. */
  lifetime?: AbortSignal;
  /** Waits before a retry; tests pass one that only moves their clock. */
  pause?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Settles with `work`, or as soon as `signal` aborts; the abort listener goes either way. */
function settleOrAbort(work: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
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
  private readonly lifetime?: AbortSignal;
  private readonly adapters = new Map<string, { json: string; adapter: Adapter }>();
  private projectCache: { at: number; projects: ProjectInfo[] } | null = null;
  private syncing: Promise<void> | null = null;
  /** The servers the running sync covers; null for all of them. */
  private syncingScope: readonly string[] | null = null;
  private deliveries: Promise<unknown> = Promise.resolve();
  private readonly conversations = new Conversations(this);
  private readonly linkCards = new LinkCards(this, this.conversations);

  constructor(deps: ShuttleDeps) {
    this.store = deps.store;
    this.port = deps.port;
    this.now = deps.now;
    this.settings = deps.settings;
    this.runner = deps.runner;
    this.run = deps.runner ?? runProcess;
    this.pause = deps.pause ?? ((ms, signal) => sleep(ms, signal ?? new AbortController().signal));
    this.lifetime = deps.lifetime;
    // Insights only trust Shuttle's own sightings from here on; rows copied over at the upgrade predate them.
    if (!this.store.kv(INSIGHTS_SINCE)) this.store.setKv(INSIGHTS_SINCE, String(this.now()));
  }

  readonly run: Runner;
  readonly pause: (ms: number, signal?: AbortSignal) => Promise<void>;

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
    const counts = {
      inbox: inboxOf(views).length,
      mine: views.filter((v) => inArea(v, "mine", this)).length,
      done: views.filter((v) => inArea(v, "done", this)).length,
      reviews: views.filter((v) => inArea(v, "reviews", this)).length,
    };
    const servers = this.config().servers.map((server) => this.serverStatus(server));
    const syncedAt = servers.reduce<number | null>((max, s) => (s.lastSyncAt !== null && (max === null || s.lastSyncAt > max) ? s.lastSyncAt : max), null);
    return { servers, counts, syncedAt, syncing: this.syncing !== null, paused: this.settings().pauseAutomations, autoAgent: this.settings().autoAgent };
  }

  private serverStatus(server: ServerConfig): ServerStatus {
    const row = this.store.server(server.id);
    let operations: string[];
    try {
      operations = this.adapter(server.id).operations();
    } catch {
      operations = [];
    }
    const unhealthy = row !== null && row.state !== null && row.state !== "ok";
    const last = unhealthy ? this.store.lastSyncRun(server.id) : null;
    const step = last ? primaryStep(stepsOf(last)) : undefined;
    const failure = step?.failure ? { ...step.failure, operation: step.operation } : null;
    const kinds = kindsOf(last);
    const recheck = this.recheckAt(row, kinds);
    const full = this.lastFullSync();
    const nextFull = full === null ? this.now() : full + this.settings().syncMinutes * 60_000;
    const lastFailed = this.store.failedSyncRuns(server.id, this.now() - DAY_MS, 1)[0] ?? null;
    return {
      id: server.id,
      name: server.name,
      kind: server.kind,
      enabled: server.enabled,
      ok: row?.ok === null || row?.ok === undefined ? null : row.ok === 1,
      state: row?.state ?? null,
      login: row?.login ?? null,
      error: row?.error ?? null,
      lastOkAt: row?.last_ok_at ?? null,
      lastSyncAt: row?.last_sync_at ?? null,
      durationMs: row?.duration_ms ?? null,
      operations,
      failures: row?.failures ?? 0,
      failingSince: row?.failing_since ?? null,
      failure,
      failedSteps: unhealthy && row.failed_steps ? (JSON.parse(row.failed_steps) as SyncStepName[]) : [],
      stepOkAt: row?.steps_ok_at ? (JSON.parse(row.steps_ok_at) as Partial<Record<SyncStepName, number>>) : {},
      // One failed sync is often gone by the next; a sign-in is not, so it shows at once.
      alert: unhealthy && ((row?.failures ?? 0) >= 2 || kinds.includes("auth")),
      nextSyncAt: server.enabled ? Math.min(recheck ?? Infinity, nextFull) : null,
      lastFailedAt: lastFailed?.at ?? null,
    };
  }

  /**
   * After a server's first failed sync, one more sync a minute later. Never sooner when any step of it was
   * rate-limited, and a refused sign-in waits for the user.
   */
  private recheckAt(row: ServerRow | null, kinds: readonly string[]): number | null {
    if (row === null || row.failures !== 1 || row.state === "ok" || row.last_sync_at === null) return null;
    if (kinds.length === 0 || kinds.includes("rate_limit") || kinds.includes("auth")) return null;
    return row.last_sync_at + RECHECK_MS;
  }

  /** When every server last synced together; a recheck of one server does not move it. */
  private lastFullSync(): number | null {
    const saved = Number(this.store.kv(FULL_SYNC_AT));
    if (saved > 0) return saved;
    // Before the first full sync that records it: the server that synced longest ago, so a sync of one
    // server never puts off the others; a server that never synced makes a full sync due now.
    const times = this.config().servers.filter((s) => s.enabled).map((s) => this.store.server(s.id)?.last_sync_at ?? null);
    if (times.length === 0 || times.includes(null)) return null;
    return Math.min(...(times as number[]));
  }

  /** Each server's syncs of the last three hours, its last failed sync step by step, and its failures of the week. */
  syncHistory(): SyncHistory {
    const now = this.now();
    return {
      windowMs: HISTORY_WINDOW_MS,
      servers: this.config().servers.map((server) => {
        const runs = this.store.syncRuns(server.id, now - HISTORY_WINDOW_MS);
        const failed = this.store.failedSyncRuns(server.id, now - 7 * DAY_MS, 30);
        const passing = runs.filter((run) => run.state === "ok");
        return {
          id: server.id,
          runs: runs.map((run) => ({ at: run.at, state: run.state, durationMs: run.duration_ms })),
          lastFailure: failed[0] ? toRun(failed[0]) : null,
          failures: failed.map((run) => {
            const step = primaryStep(stepsOf(run));
            return { at: run.at, state: run.state, operation: step?.operation ?? "whoami", summary: step?.failure?.summary ?? "The sync failed", output: step?.failure?.output ?? null };
          }),
          averageMs: passing.length > 0 ? Math.round(passing.reduce((sum, run) => sum + run.duration_ms, 0) / passing.length) : null,
        };
      }),
    };
  }

  list(area: Area): PrView[] {
    return allViews(this).filter((v) => inArea(v, area, this));
  }

  search(query: string): { prs: PrView[]; total: number } {
    return searchPrs(this, query);
  }

  boards(input: { query?: string; archived?: "exclude" | "include" | "only"; key?: string } = {}): { boards: BoardSummary[] } {
    return listBoards(this, input);
  }

  board(id: string): BoardDetail {
    return readBoard(this, id);
  }

  boardCreate(input: { name: string; description?: string; prs?: string[] }, actorThreadId?: string): Promise<BoardDetail> {
    return boardCreate(this, input, actorThreadId);
  }

  boardUpdate(input: { id: string; name?: string; description?: string; archived?: boolean }, actorThreadId?: string): { board: BoardSummary } {
    return boardUpdate(this, input, actorThreadId);
  }

  boardAdd(input: { id: string; prs: string[] }, actorThreadId?: string): Promise<{ board: BoardSummary; added: string[]; alreadyPresent: string[] }> {
    return boardAdd(this, input, actorThreadId);
  }

  boardRemove(input: { id: string; prs: string[] }, actorThreadId?: string): { board: BoardSummary; removed: string[] } {
    return boardRemove(this, input, actorThreadId);
  }

  inbox(): InboxView {
    return readInbox(this);
  }

  insights(range: InsightsView["range"]): InsightsView {
    return insights(this, range);
  }

  view(key: string): PrView {
    return toView(this, requirePr(this, key));
  }

  detail(key: string): { pr: PrView; events: EventView[]; body: string | null; draft: ReviewDraft | null } {
    const pr = requirePr(this, key);
    const draft = pr.mine ? null : this.store.liveDraft(pr.id);
    return { pr: toView(this, pr), events: this.store.events({ prId: pr.id, limit: 50 }).map(toEventView), body: pr.body, draft: draft ? draftView(this, draft) : null };
  }

  /** A deep link to a PR Shuttle has not stored yet looks it up on its server first. */
  async detailOrLookup(key: string): Promise<{ pr: PrView; events: EventView[]; body: string | null; draft: ReviewDraft | null }> {
    if (!this.store.prByKey(key)) await lookup(this, key);
    return this.detail(key);
  }

  /** Fetches the PRs whose stored copy is older than maxAgeMs; failures keep the stored copy. */
  async refreshStale(keys: readonly string[], maxAgeMs: number, signal?: AbortSignal): Promise<void> {
    for (const key of keys) {
      if (signal?.aborted) return;
      const pr = this.store.prByKey(key);
      const ref = parseKey(key);
      if (!pr || !ref) continue;
      // Lists carry no description or reviewers on every server, so the PR on screen is read by itself:
      // once when it was never read that way, and again every maxAgeMs while it is open.
      const open = pr.state === "open" || pr.state === "draft";
      if (pr.viewed_at !== null && (!open || this.now() - pr.viewed_at < maxAgeMs)) continue;
      await fetchPr(this, ref).catch((error: unknown) => this.port.log("warn", `refresh ${key}: ${errText(error)}`));
    }
  }

  async editPr(key: string, change: PrChange): Promise<PrView> {
    return toView(this, await editPr(this, key, change));
  }

  editOptions(key: string) {
    return editOptions(this, key);
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

  /** Sends a new agent the feedback already on the PR, now rather than after the batch window. */
  private async kick(key: string, change: AgentChange): Promise<void> {
    if (!change.backlog || !change.threadId) return;
    const pr = requirePr(this, key);
    await pollWatches(this, undefined, undefined, pr.id);
    await this.deliver({ force: true, threadId: change.threadId });
  }

  async setAgent(key: string, target: AgentTarget, mode?: AgentMode): Promise<{ pr: PrView; threadId: string | null }> {
    if (target.kind !== "new") await lookup(this, key);
    const change = await setAgent(this, key, target, mode);
    await this.kick(key, change).catch((error: unknown) => this.port.log("warn", `send feedback to the new agent of ${key}: ${errText(error)}`));
    return { pr: this.view(key), threadId: change.threadId };
  }

  async setAgentMode(key: string, mode: AgentMode): Promise<PrView> {
    const change = setAgentMode(this, key, mode);
    await this.kick(key, change).catch((error: unknown) => this.port.log("warn", `send feedback to the agent of ${key}: ${errText(error)}`));
    return this.view(key);
  }

  async askAgent(key: string, text: string): Promise<void> {
    await askAgent(this, key, text);
  }

  track(key: string, on: boolean): PrView {
    const pr = requirePr(this, key);
    this.store.setTracked(pr.id, on);
    this.store.addEvent("tracked", on ? `You track ${shortKey(this, pr)}.` : `You stopped tracking ${shortKey(this, pr)}.`, pr.id);
    this.port.publish();
    return toView(this, this.store.prById(pr.id)!);
  }

  snooze(keys: readonly string[], until: number | "update" | null): PrView[] {
    return snooze(this, keys, until);
  }

  dismiss(keys: readonly string[], on: boolean): PrView[] {
    return dismiss(this, keys, on);
  }

  markSeen(keys: readonly string[]): void {
    markSeen(this, keys);
  }

  inboxRuleAdd(input: { kind: InboxRuleKind; server: string; value: string }): { rule: InboxRule; created: boolean } {
    return addRule(this, input);
  }

  inboxRuleRemove(id: number): void {
    removeRule(this, id);
  }

  handle(key: string, on: boolean): PrView {
    const pr = requirePr(this, key);
    const reviewers = pr.reviewers ? (JSON.parse(pr.reviewers) as Parameters<typeof feedbackSignature>[0]) : null;
    this.store.setHandled(pr.id, on ? JSON.stringify(feedbackSignature(reviewers, pr.checks, pr.head)) : null);
    if (on) this.store.addEvent("handled", `You took the feedback on ${shortKey(this, pr)} yourself.`, pr.id);
    this.port.publish();
    return toView(this, this.store.prById(pr.id)!);
  }

  linkCard(url: string): Promise<LinkCard> {
    return this.linkCards.card(url);
  }

  linkStates(urls: readonly string[]) {
    return this.linkCards.states(urls);
  }

  conversation(key: string): Promise<{ items: ConversationItem[]; details: PrDetails | null; error: string | null; fetchedAt: number }> {
    return this.conversations.read(key);
  }

  async comment(key: string, body: string): Promise<PrView> {
    const pr = await comment(this, key, body);
    this.conversations.forget(key);
    return toView(this, pr);
  }

  async reply(key: string, thread: string, body: string): Promise<void> {
    await reply(this, key, thread, body);
    this.conversations.forget(key);
  }

  async resolve(key: string, thread: string, resolved: boolean): Promise<void> {
    await resolve(this, key, thread, resolved);
    this.conversations.forget(key);
  }

  mergeOptions(key: string): Promise<MergeOptions> {
    return mergeOptions(this, key);
  }

  async merge(key: string, input: { method: MergeMethod; head: string; auto: boolean; deleteBranch: boolean; subject?: string }): Promise<{ pr: PrView; merged: boolean }> {
    const out = await merge(this, key, input);
    this.conversations.forget(key);
    return { pr: toView(this, out.pr), merged: out.merged };
  }

  async cancelAutoMerge(key: string): Promise<PrView> {
    return toView(this, await cancelAutoMerge(this, key));
  }

  async submitReview(key: string, input: { verdict: Verdict; body: string; findings: PostFinding[]; draftId?: number; staleOk?: boolean }): Promise<{ pr: PrView; placed: number; inBody: number }> {
    const out = await submitReview(this, key, input);
    this.conversations.forget(key);
    await this.archiveReviewThreads({ prId: out.pr.id });
    return { pr: toView(this, this.store.prById(out.pr.id)!), placed: out.placed, inBody: out.inBody };
  }

  async discardDraft(key: string, draftId: number): Promise<PrView> {
    const pr = setDraftState(this, key, draftId, "discarded");
    // Awaited, so an Undo always finds the thread already archived and brings it back.
    await this.archiveReviewThreads({ prId: pr.id });
    return toView(this, this.store.prById(pr.id)!);
  }

  async restoreDraft(key: string, draftId: number): Promise<PrView> {
    const pr = setDraftState(this, key, draftId, "draft");
    const draft = this.store.draftById(draftId);
    if (draft) await unarchiveForDraft(this, pr, draft.thread_id);
    return toView(this, this.store.prById(pr.id)!);
  }

  /** Review threads of Shuttle's whose review is done go to the archive; never fails the caller. */
  async archiveReviewThreads(filter: { prId?: number; threadId?: string } = {}): Promise<number> {
    return archiveDoneReviewThreads(this, filter).catch((error: unknown) => {
      this.port.log("warn", `archive review threads: ${errText(error)}`);
      return 0;
    });
  }

  async saveDraft(threadId: string, query: string, input: DraftInput): Promise<{ pr: PrView; findings: number }> {
    const { pr, draft } = await saveDraft(this, threadId, query, input);
    return { pr: toView(this, pr), findings: (JSON.parse(draft.findings) as unknown[]).length };
  }

  recordOutcomes(threadId: string, query: string, items: Array<{ ref: string; outcome: Outcome; note?: string; commit?: string }>) {
    return recordOutcomes(this, threadId, query, items);
  }

  async setSettings(patch: { autoAgent?: boolean; inboxRequests?: boolean }): Promise<void> {
    await this.port.setSettings(patch);
  }

  /** Auto agent's pass, and the feedback each new agent should get at once. */
  async autoAgent(signal?: AbortSignal): Promise<void> {
    for (const { key, change } of await runAutoAgent(this, signal)) {
      await this.kick(key, change).catch((error: unknown) => this.port.log("warn", `send feedback to the new agent of ${key}: ${errText(error)}`));
    }
  }

  /** Once a sync is in: the phase of each PR of yours, and the day's request counts. */
  private record(): void {
    for (const pr of this.store.allPrs()) if (pr.mine === 1) this.store.notePhase(pr.id, phaseOf(pr.state, pr.review, pr.checks));
    this.store.saveSnapshot(new Date(this.now()).toISOString().slice(0, 10), snapshotCounts(allViews(this)));
  }

  async review(input: ReviewInput): Promise<{ threadId: string; revived: boolean }> {
    await lookup(this, input.key);
    const { threadId, revived } = await startReview(this, input, "manual");
    return { threadId, revived };
  }

  async newThread(key: string, start: "own" | "review", projectId?: string): Promise<string> {
    await lookup(this, key);
    if (start === "review") return (await startReview(this, { key, newThread: true, ...(projectId ? { projectId } : {}) }, "manual")).threadId;
    return (await this.setAgent(key, { kind: "new", ...(projectId ? { projectId } : {}) })).threadId!;
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
    const threads = await this.port.listThreads(THREAD_SCAN);
    const q = query?.trim().toLowerCase();
    return threads
      .filter((t) => !t.archived && (!q || t.title.toLowerCase().includes(q)))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, THREAD_OPTIONS)
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
    for (const op of ["authored", "review_requested", "team_requested", "mentioned", "reviewed"] as const) {
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
      if (ops.has("edit_options")) await time("edit_options", async () => {
        const options = await adapter.editOptions(target.repo, target.number);
        return `${options.labels.length} labels, ${options.people.length} suggested reviewers`;
      });
      if (ops.has("merge_options")) await time("merge_options", async () => {
        const options = await adapter.mergeOptions(target.repo, target.number);
        return `${options.methods.join(", ")}; ${options.state}`;
      });
    }
    return results;
  }

  /** Syncs every enabled server, or only those in `only`, runs the auto reviews and checks watched PRs. One sync at a time. */
  sync(signal: AbortSignal | undefined = this.lifetime, only?: readonly string[]): Promise<void> {
    if (only !== undefined) for (const id of only) if (!this.server(id)) throw new ShuttleError(`no server called ${id}`);
    if (this.syncing) {
      // A request for servers the running sync does not cover runs after it, rather than being answered by it.
      const scope = this.syncingScope;
      const covered = scope === null || (only !== undefined && only.every((id) => scope.includes(id)));
      const after = covered ? this.syncing : this.syncing.then(() => this.sync(signal, only), () => this.sync(signal, only));
      // The loop's tick must not wait out a sync the UI started once the loop itself is asked to stop.
      return signal ? settleOrAbort(after, signal) : after;
    }
    this.syncingScope = only ?? null;
    this.syncing = (async () => {
      this.port.publish();
      try {
        for (const server of this.config().servers) {
          if (!server.enabled || signal?.aborted || (only !== undefined && !only.includes(server.id))) continue;
          const result = await syncServer(this, server, signal);
          // A partial sync still brought the lists that passed; only their requests start auto reviews.
          if ((result.state === "ok" || result.state === "partial") && !signal?.aborted) await runAutoReviews(this, server.id, signal, new Set(result.passed));
          // A server that rate-limited Shuttle or looks down is not asked about each watched PR too.
          if (!signal?.aborted && result.backOff === null) await pollWatches(this, server.id, signal);
        }
        if (signal?.aborted) return;
        if (only === undefined) this.store.setKv(FULL_SYNC_AT, String(this.now()));
        await this.refreshThreadTitles();
        await this.autoAgent(signal).catch((error: unknown) => this.port.log("warn", `auto agent: ${errText(error)}`));
        this.record();
        await this.deliver();
        // After the lists: a PR that merged or closed since the last sync is done with its review thread.
        if (!signal?.aborted) await this.archiveReviewThreads();
      } finally {
        this.syncing = null;
        this.syncingScope = null;
        this.port.publish();
      }
    })();
    return this.syncing;
  }

  /** The loop's step: a sync when one is due, and the batches whose window passed. */
  async tick(signal?: AbortSignal): Promise<void> {
    const last = this.lastFullSync();
    if (last === null || this.now() - last >= this.settings().syncMinutes * 60_000) return this.sync(signal);
    const due = this.config().servers.filter((server) => {
      if (!server.enabled) return false;
      const row = this.store.server(server.id);
      const run = row?.failures === 1 ? this.store.lastSyncRun(server.id) : null;
      const at = this.recheckAt(row, kindsOf(run));
      return at !== null && this.now() >= at;
    });
    if (due.length > 0) return this.sync(signal, due.map((server) => server.id));
    await this.deliver();
  }

  /** Titles and states of linked threads: bb's list has whether one waits on the user, a single read does not. */
  private async refreshThreadTitles(): Promise<void> {
    const linked = this.store.linkedThreadIds().slice(0, 100);
    let listed = new Map<string, Awaited<ReturnType<BbPort["threadsById"]>>[number]>();
    try {
      listed = new Map((await this.port.threadsById(linked)).map((t) => [t.id, t]));
    } catch {
      // Each linked thread is read on its own below.
    }
    for (const threadId of linked) {
      try {
        const thread = listed.get(threadId) ?? (await this.port.getThread(threadId));
        if (thread) this.store.saveThread(thread.id, thread.title, thread.archived, { status: thread.status, waiting: thread.waiting });
        else this.store.forgetThread(threadId);
      } catch {
        // A title refresh is cosmetic; the next sync tries again.
      }
    }
  }

  /** A review thread that finishes after its review was done, such as one still writing when its draft was posted, is archived now. */
  onThreadIdle(threadId: string): Promise<number> {
    this.markIdle(threadId);
    return this.archiveReviewThreads({ threadId });
  }

  private markIdle(threadId: string): void {
    const known = this.store.setThreadStatus(threadId, "idle", false);
    const running = this.store.runningReviewsOfThread(threadId);
    for (const review of running) {
      this.store.finishReview(review.id, "done");
      const pr = this.store.prById(review.pr_id);
      const draft = pr ? this.store.liveDraft(pr.id) : null;
      const name = pr ? shortKey(this, pr) : "a PR";
      const findings = draft && draft.created_at >= review.created_at ? (JSON.parse(draft.findings) as unknown[]).length : null;
      const text = findings !== null ? `${review.trigger === "auto" ? "Auto review" : "Review"} of ${name} finished: ${findings} finding${findings === 1 ? "" : "s"} drafted, nothing posted.` : `${review.trigger === "auto" ? "Auto review" : "Review"} of ${name} finished; read it in its thread.`;
      this.store.addEvent("review_done", text, review.pr_id, threadId);
    }
    if (running.length || known) this.port.publish();
  }

  onThreadActive(threadId: string): void {
    if (this.store.setThreadStatus(threadId, "active", false)) this.port.publish();
  }

  /** The thread asked the user something; an agent's question puts its PR in the Inbox. */
  onInteractionPending(threadId: string): void {
    if (this.store.setThreadStatus(threadId, null, true)) this.port.publish();
  }

  onThreadFailed(threadId: string): void {
    this.store.setThreadStatus(threadId, "error", false);
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
