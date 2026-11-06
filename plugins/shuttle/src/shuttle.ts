// Shuttle's operations, shared by the RPC handlers, the agent tools and the CLI.
import { adapterFor, type Adapter } from "./adapters";
import { runProcess, sleep, type Runner } from "./adapters/exec";
import { configChanges, configFromToml, configToToml, ConfigError, parseConfig, serverSchema, type Config, type ServerConfig, type WatchMode } from "./config";
import type {
  AutoPostInsights, ReviewHistoryItem,
  AgentMode, AgentTarget, Area, BoardDetail, BoardSummary, ConversationItem, EventView, InboxRule, InboxRuleKind, InboxView, InsightsView, LinkRole, MergeMethod, MergeOptions, MergeView, Outcome, Overview, LinkCard, PostFinding, PrChange, PrDetails,
  PostView, PrView, ReviewDraft, ReviewInput, ServerStatus, SyncHistory, SyncRun, SyncStep, SyncStepName, TestResult, ThreadOption, UsageRange, UsageView, Verdict,
} from "./contract";
import { askAgent, runAutoAgent, setAgent, setAgentMode, type AgentChange } from "./agents";
import { board as readBoard, boardAdd, boardCreate, boardRemove, boards as listBoards, boardUpdate } from "./boards";
import { cancelAutoMerge, comment, Conversations, merge, mergeOptions, recordOutcomes, reply, resolve, type MergeOutcome } from "./conversation";
import { draftView, historyView, saveDraft, setDraftState, submitReview, type DraftInput, type SubmitInput } from "./drafts";
import { AutoPostRefused, autoPostNow, markAutoPost, refusedAtPost, resumeAutoPost, runAutoPosts, stopAutoPost } from "./auto-post";
import { cancelPost, clearPost, failInterruptedPosts, inputOf, postView, queueReview, recentPosts, retryPost } from "./posts";
import { FastLane, type BackOffKind } from "./fast-lane";
import { cancelMerge, clearMerge, failInterruptedMerges, mergeInputOf, mergeView, queueMerge, recentMerges, retryMerge } from "./merges";
import { addRule, dismiss, inbox as readInbox, markSeen, removeRule, snooze } from "./inbox";
import { insights, INSIGHTS_SINCE, snapshotCounts } from "./insights";
import { readUsage, usageView } from "./usage";
import { autoPostRepo, gateDraft, parseGate, rescoreDraft } from "./gate";
import { autoPostInsights } from "./shadow";
import { feedbackSignature, phaseOf } from "./next";
import { errText, ShuttleError, type Ctx } from "./ctx";
import type { EventRow, MergeRow, PostRow, ServerRow, Store, SyncRunRow } from "./db/store";
import { THREAD_SCAN, type BbPort, type ProjectInfo } from "./ports";
import { fetchPr, linkPr, lookup, rememberThread, requirePr, setWatch, shortKey, unlinkPr } from "./prs";
import { parseKey } from "./keys";
import { matchProject } from "./projects";
import { archiveDoneReviewThreads, unarchiveForDraft } from "./review-threads";
import { endQuietReviews, endReview, failReviewsOfThread, resumeReviews, type ThreadFailure } from "./review-runs";
import { startReview } from "./reviews";
import { descriptionMatches, searchIndex, searchPrs } from "./search";
import type { Settings } from "./settings";
import { primaryStep } from "./failures";
import { RECHECK_MS, runAutoReviews, syncServer } from "./sync";
import { allViews, inArea, inboxCandidates, inboxOf, toView } from "./views";
import { editOptions, editPr } from "./edit";
import { LinkCards } from "./link-cards";
import { deliver, pollWatches } from "./watch";
import { checkWorkspace } from "./workspaces";

const PROJECTS_TTL_MS = 5 * 60_000;
/** The link and agent dialogs list the most recent threads; a search reaches the rest. */
const THREAD_OPTIONS = 200;
const DAY_MS = 86_400_000;
/** How far back the Sync tab's marks go. */
const HISTORY_WINDOW_MS = 3 * 3_600_000;
const FULL_SYNC_AT = "full_sync_at";
/** How far up from a thread at work Shuttle looks for the review it belongs to: critics, their helpers, and theirs. */
const THREAD_ANCESTORS = 4;

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
  readonly lifetime?: AbortSignal;
  private readonly adapters = new Map<string, { json: string; adapter: Adapter }>();
  private projectCache: { at: number; projects: ProjectInfo[] } | null = null;
  /** Each server's running sync, by server id: its lists, then its auto reviews and watched PRs. */
  private readonly serverSyncs = new Map<string, Promise<boolean>>();
  /** The steps after the servers' syncs, and the one run waiting to follow it. */
  private finishing: Promise<void> | null = null;
  private finishNext: Promise<void> | null = null;
  /** Auto reviews take turns, so servers syncing together keep to the daily limit. */
  private autoReviews: Promise<unknown> = Promise.resolve();
  private deliveries: Promise<unknown> = Promise.resolve();
  /** The full sync a tick started and that is still running; a tick starts no other while it runs. */
  private fullSync: Promise<void> | null = null;
  /** Every sync a tick started and that is still running, full or a recheck. */
  private readonly ticked = new Set<Promise<void>>();
  /**
   * Servers left alone until their next sync finishes: a sync step or a fast-lane read hit a rate limit or a
   * refused sign-in, or the server looks down. The fast lane and the early recheck both go by `backOff`.
   */
  /** Why each server is left alone until its next sync, and since when. */
  private readonly backOffs = new Map<string, { kind: BackOffKind; at: number }>();
  /** When each server's sync started that last came through without a back-off. */
  private readonly cleanSince = new Map<string, number>();
  private readonly fastLane = new FastLane(this, { backOff: (id) => this.backOff(id), holdOff: (id, kind, askedAt) => this.holdOff(id, kind, askedAt) });
  private readonly conversations = new Conversations(this);
  private readonly linkCards = new LinkCards(this, this.conversations);
  /** The worker posting each server's queued reviews, by server id. */
  private readonly posters = new Map<string, Promise<void>>();
  /** The worker carrying out each server's queued merges, by server id. */
  private readonly mergers = new Map<string, Promise<void>>();
  /** Each thread's parent, as bb's events name it, so work deep under a review thread counts as the review at work. */
  private readonly parents = new Map<string, string>();

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
    // A PR that merged or closed is done with its review threads as soon as Shuttle hears, by whichever read: the list
    // that was on screen showed it merged beside a review thread still open until the next sync had finished.
    this.store.onPrClosed((prId) => {
      if (this.lifetime?.aborted) return;
      // After the write that called, which may be inside a transaction.
      const run: Promise<void> = Promise.resolve()
        .then(() => this.archiveReviewThreads({ prId }))
        .then(() => undefined)
        .finally(() => this.closing.delete(run));
      this.closing.add(run);
    });
  }

  /** Archives of the review threads of PRs that just merged or closed, still under way. */
  private readonly closing = new Set<Promise<void>>();
  /** The pass reading what reviews used from Burn, while one runs. */
  private usagePass: Promise<void> | null = null;

  /** Resolves once the review threads of PRs that just merged or closed are archived. */
  async closedSettled(): Promise<void> {
    while (this.closing.size > 0) await Promise.all(this.closing);
  }

  /** Reads what reviews used from Burn, one pass at a time; the tick never waits for it. */
  readUsage(signal?: AbortSignal): Promise<void> {
    this.usagePass ??= readUsage(this, signal)
      .then(() => undefined, (error: unknown) => this.port.log("warn", `review usage: ${errText(error)}`))
      .finally(() => {
        this.usagePass = null;
      });
    return this.usagePass;
  }

  usage(range: UsageRange): UsageView {
    return usageView(this, range);
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
      reviewed: views.filter((v) => inArea(v, "reviewed", this)).length,
    };
    const servers = this.config().servers.map((server) => this.serverStatus(server));
    const syncedAt = servers.reduce<number | null>((max, s) => (s.lastSyncAt !== null && (max === null || s.lastSyncAt > max) ? s.lastSyncAt : max), null);
    return { servers, counts, syncedAt, syncing: this.serverSyncs.size > 0 || this.finishing !== null, paused: this.settings().pauseAutomations, autoAgent: this.settings().autoAgent };
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

  descriptionMatches(query: string): ReturnType<typeof descriptionMatches> {
    return descriptionMatches(this, query);
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

  reviewHistory(key: string): { items: ReviewHistoryItem[] } {
    const pr = requirePr(this, key);
    // Once the PR is merged or closed, a draft never posted is history too, with the notes it left. A draft a newer one of
    // the same review run replaced is an earlier try of that review, so only the newest of each run shows; review threads
    // are reused by later runs, so a run is its review, not its thread.
    const live = pr.state === "open" || pr.state === "draft";
    const rows = this.store.pastDrafts(pr.id);
    const items = rows.filter((row, at) => !(row.discard_reason === "superseded" && row.review_id !== null && rows.slice(0, at).some((newer) => newer.review_id === row.review_id)));
    const posts = new Map(this.store.postedFromDrafts(pr.id).map((post) => [post.draft_id, post]));
    return { items: items.filter((row) => !live || row.state !== "draft").map((row) => historyView(this, row, posts.get(row.id) ?? null)) };
  }

  autoPostInsights(range: AutoPostInsights["range"]): AutoPostInsights {
    return autoPostInsights(this, range);
  }

  /**
   * Judges again the findings of every draft auto post checked in the last `days`, posted and discarded ones too, so
   * the shadow record covers drafts held before the verifier ran on every draft. Never posts.
   */
  async rescoreDrafts(days: number): Promise<{ drafts: number; judged: number; failures: number }> {
    const since = this.now() - days * 86_400_000;
    let drafts = 0;
    let judged = 0;
    let failures = 0;
    for (const row of this.store.gatedDrafts()) {
      const stored = parseGate(row.gate);
      if (stored === null || stored.at < since || row.discard_reason === "superseded") continue;
      let result: Awaited<ReturnType<typeof rescoreDraft>>;
      try {
        result = await rescoreDraft(this, row.id);
      } catch (error) {
        this.port.log("warn", `auto post could not judge draft ${row.id} again: ${errText(error)}`);
        failures++;
        continue;
      }
      if (result === null) continue;
      drafts++;
      judged += result.judged;
      failures += result.failed;
    }
    if (drafts || failures) this.store.addEvent("gate", `Auto post judged the findings of ${drafts} checked draft${drafts === 1 ? "" : "s"} again: ${judged} judged, ${failures} could not be judged and kept what they had. Nothing was posted.`);
    this.port.publish();
    return { drafts, judged, failures };
  }

  /** Runs auto post's checks on a live draft again and waits for them. Never posts. */
  async checkDraft(key: string, draftId: number): Promise<PrView> {
    const pr = requirePr(this, key);
    const draft = this.store.draftById(draftId);
    if (!draft || draft.pr_id !== pr.id) throw new ShuttleError("That draft is not this PR's");
    if (draft.state !== "draft") throw new ShuttleError(`That draft was already ${draft.state}`);
    if (autoPostRepo(this.config(), pr.repo) === null) throw new ShuttleError(`Auto post is off for ${pr.repo}; set it to shadow in Settings › Automations first`);
    await gateDraft(this, draft.id);
    return toView(this, this.store.prById(pr.id)!);
  }

  stopAutoPost(key: string, draftId: number): PrView {
    return toView(this, stopAutoPost(this, key, draftId));
  }

  autoPostNow(key: string, draftId: number): PrView {
    const pr = autoPostNow(this, key, draftId);
    this.drainPosts();
    return toView(this, this.store.prById(pr.id)!);
  }

  markAutoPost(key: string, draftId: number, findingId?: string, undo?: boolean): PrView {
    return toView(this, markAutoPost(this, key, draftId, findingId, undo));
  }

  resumeAutoPost(repo: string, kind: "comment" | "approve"): { cleared: number } {
    return { cleared: resumeAutoPost(this, repo, kind) };
  }

  /** Queues the drafts whose countdown ended, then hands the queue what they queued. */
  runAutoPosts(): number {
    const queued = runAutoPosts(this);
    if (queued > 0) this.drainPosts();
    return queued;
  }

  view(key: string): PrView {
    return toView(this, requirePr(this, key));
  }

  detail(key: string): { pr: PrView; events: EventView[]; body: string | null; draft: ReviewDraft | null; drafts: number } {
    const pr = requirePr(this, key);
    const draft = pr.mine ? null : this.store.liveDraft(pr.id);
    return {
      pr: toView(this, pr), events: this.store.events({ prId: pr.id, limit: 50 }).map(toEventView), body: pr.body,
      draft: draft ? draftView(this, draft) : null, drafts: pr.mine ? 0 : this.store.draftCount(pr.id),
    };
  }

  /** A deep link to a PR Shuttle has not stored yet looks it up on its server first. */
  async detailOrLookup(key: string): Promise<ReturnType<Shuttle["detail"]>> {
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
      // Lists may carry no description or reviewers, so the PR on screen is read by itself:
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

  async merge(key: string, input: { method: MergeMethod; head: string; auto: boolean; deleteBranch: boolean; subject?: string }): Promise<{ pr: PrView; outcome: MergeOutcome }> {
    const out = await merge(this, key, input);
    this.conversations.forget(key);
    return { pr: toView(this, out.pr), outcome: out.outcome };
  }

  async cancelAutoMerge(key: string): Promise<PrView> {
    return toView(this, await cancelAutoMerge(this, key));
  }

  queueMerge(key: string, input: { method: MergeMethod; head: string; auto: boolean; deleteBranch: boolean; subject?: string }): { pr: PrView; merge: MergeView } {
    const row = queueMerge(this, key, input);
    this.drainMerges();
    // Read again: a worker with nothing ahead of it has already started on it.
    return { pr: toView(this, this.store.prById(row.pr_id)!), merge: mergeView(this, this.store.mergeById(row.id)!) };
  }

  merges(): MergeView[] {
    return recentMerges(this);
  }

  cancelMerge(id: number): PrView {
    return toView(this, cancelMerge(this, id));
  }

  retryMerge(id: number): { pr: PrView; merge: MergeView } {
    const row = retryMerge(this, id);
    this.drainMerges();
    return { pr: toView(this, this.store.prById(row.pr_id)!), merge: mergeView(this, this.store.mergeById(row.id)!) };
  }

  clearMerge(id: number): PrView {
    return toView(this, clearMerge(this, id));
  }

  /** At start: merges the last run left under way fail for the user to check, and the queue picks up where it stopped. */
  resumeMerges(): void {
    failInterruptedMerges(this);
    this.drainMerges();
  }

  /** Starts a worker for each server with merges waiting and none running; each carries out its server's merges in order. */
  drainMerges(): void {
    if (this.lifetime?.aborted) return;
    for (const server of this.store.queuedMergeServers()) {
      if (this.mergers.has(server)) continue;
      const run = this.mergeAll(server)
        .catch((error: unknown) => this.port.log("warn", `merge PRs on ${server}: ${errText(error)}`))
        .finally(() => {
          this.mergers.delete(server);
          // A merge queued while this worker was finishing still gets one.
          if (this.store.nextQueuedMerge(server) !== null) this.drainMerges();
        });
      this.mergers.set(server, run);
    }
  }

  /** Resolves once no worker is merging. */
  async mergesSettled(): Promise<void> {
    while (this.mergers.size > 0) await Promise.all(this.mergers.values());
  }

  private async mergeAll(server: string): Promise<void> {
    for (let row = this.store.nextQueuedMerge(server); row !== null && !this.lifetime?.aborted; row = this.store.nextQueuedMerge(server)) {
      await this.mergeOne(row);
    }
  }

  private async mergeOne(row: MergeRow): Promise<void> {
    const pr = this.store.prById(row.pr_id);
    this.store.startMerge(row.id);
    this.port.publish();
    const name = pr === null ? "a PR" : shortKey(this, pr);
    let outcome: MergeOutcome;
    try {
      if (pr === null) throw new ShuttleError("Shuttle no longer has this PR");
      outcome = (await merge(this, pr.key, mergeInputOf(row))).outcome;
    } catch (error) {
      this.store.finishMerge(row.id, { state: "failed", error: errText(error) });
      this.store.addEvent("merge_failed", row.auto === 1 ? `Auto-merge did not turn on for ${name}: ${errText(error)}` : `Your merge of ${name} did not go through: ${errText(error)}`, row.pr_id);
      this.port.publish();
      return;
    }
    // Done: nothing after this may fail it, or Try again would merge it twice.
    this.store.tx(() => {
      this.store.finishMerge(row.id, { state: "done", outcome });
      // The latest merge of the PR is the one that counts.
      this.store.clearFailedMerges(row.pr_id, row.id);
    });
    this.conversations.forget(pr.key);
    this.port.publish();
  }

  async submitReview(key: string, input: { verdict: Verdict; body: string; findings: PostFinding[]; draftId?: number; staleOk?: boolean }): Promise<{ pr: PrView; placed: number; inBody: number }> {
    const out = await submitReview(this, key, input);
    this.conversations.forget(key);
    await this.archiveReviewThreads({ prId: out.pr.id });
    return { pr: toView(this, this.store.prById(out.pr.id)!), placed: out.placed, inBody: out.inBody };
  }

  queueReview(key: string, input: SubmitInput): { pr: PrView; post: PostView } {
    const row = queueReview(this, key, input);
    this.drainPosts();
    return { pr: toView(this, this.store.prById(row.pr_id)!), post: postView(this, row) };
  }

  posts(): PostView[] {
    return recentPosts(this);
  }

  cancelPost(id: number): PrView {
    return toView(this, cancelPost(this, id));
  }

  retryPost(id: number): { pr: PrView; post: PostView } {
    const row = retryPost(this, id);
    this.drainPosts();
    return { pr: toView(this, this.store.prById(row.pr_id)!), post: postView(this, row) };
  }

  clearPost(id: number): PrView {
    return toView(this, clearPost(this, id));
  }

  /** At start: posts the last run left half done fail for the user to check, and the queue picks up where it stopped. */
  resumePosts(): void {
    failInterruptedPosts(this);
    this.drainPosts();
  }

  /** Starts a worker for each server with reviews waiting and none running; each posts its server's reviews in order. */
  drainPosts(): void {
    if (this.lifetime?.aborted) return;
    for (const server of this.store.queuedPostServers()) {
      if (this.posters.has(server)) continue;
      const run = this.postAll(server)
        .catch((error: unknown) => this.port.log("warn", `post reviews on ${server}: ${errText(error)}`))
        .finally(() => {
          this.posters.delete(server);
          // A review queued while this worker was finishing still gets one.
          if (this.store.nextQueuedPost(server) !== null) this.drainPosts();
        });
      this.posters.set(server, run);
    }
  }

  /** Resolves once no worker is posting. */
  async postsSettled(): Promise<void> {
    while (this.posters.size > 0) await Promise.all(this.posters.values());
  }

  private async postAll(server: string): Promise<void> {
    for (let row = this.store.nextQueuedPost(server); row !== null && !this.lifetime?.aborted; row = this.store.nextQueuedPost(server)) {
      await this.postOne(row);
    }
  }

  private async postOne(row: PostRow): Promise<void> {
    const pr = this.store.prById(row.pr_id);
    this.store.startPost(row.id);
    this.port.publish();
    let out: { placed: number; inBody: number };
    try {
      if (pr === null) throw new ShuttleError("Shuttle no longer has this PR");
      out = await submitReview(this, pr.key, inputOf(row));
    } catch (error) {
      // Auto post's own check refused it: nothing was sent, and the draft goes back to the user.
      if (error instanceof AutoPostRefused && pr !== null && row.draft_id !== null) {
        this.store.tx(() => {
          this.store.finishPost(row.id, { state: "cancelled" });
          refusedAtPost(this, pr, row.draft_id!, error.message);
          this.store.retireReplacedDraft(row.draft_id!);
        });
        this.port.publish();
        return;
      }
      this.store.finishPost(row.id, { state: "failed", error: errText(error) });
      this.store.addEvent("post_failed", `Your review of ${pr === null ? "a PR" : shortKey(this, pr)} did not post: ${errText(error)}`, row.pr_id);
      if (row.auto === 1 && pr !== null) void this.port.notify(`Shuttle's review of ${shortKey(this, pr)} did not post`, `${errText(error)}. Try it again or dismiss it from the PR.`);
      this.port.publish();
      return;
    }
    // Posted: nothing after this may fail it, or Try again would post it twice.
    this.store.tx(() => {
      this.store.finishPost(row.id, { state: "posted", placed: out.placed, inBody: out.inBody });
      // The latest review of the PR is the one that counts.
      this.store.clearFailedPosts(row.pr_id, row.id);
    });
    this.conversations.forget(pr.key);
    await this.archiveReviewThreads({ prId: pr.id }).catch((error: unknown) => this.port.log("warn", `archive the review thread of ${pr.key}: ${errText(error)}`));
    this.port.publish();
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

  async saveDraft(threadId: string, query: string, input: DraftInput): Promise<{ pr: PrView; findings: number; notes: boolean }> {
    const { pr, draft } = await saveDraft(this, threadId, query, input);
    return { pr: toView(this, pr), findings: (JSON.parse(draft.findings) as unknown[]).length, notes: draft.notes !== null };
  }

  /** Called by a review thread's shuttle_review_done tool. */
  async endReview(threadId: string, query: string, input: { note: string; failed: boolean }): Promise<PrView> {
    return toView(this, await endReview(this, threadId, query, input));
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

  async workspaceProviders(): Promise<{ environments: Array<{ id: string; displayName: string; description: string | null; machineProviderId: string | null }>; machines: Array<{ id: string; displayName: string; description: string | null }> }> {
    const [environments, machines] = await Promise.all([this.port.environmentProviders(), this.port.machineProviders()]);
    return {
      environments: environments.map(({ id, displayName, description, machineProviderId }) => ({ id, displayName, description, machineProviderId })),
      machines: machines.map(({ id, displayName, description }) => ({ id, displayName, description })),
    };
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
    await time("workspace", () => checkWorkspace(this.port, server.id, server.workspace));
    return results;
  }

  /**
   * Syncs every enabled server, or only those in `only`, runs the auto reviews and checks watched PRs. Servers
   * sync at the same time, each at most once at a time: a request for a server whose sync is under way joins it.
   */
  sync(signal: AbortSignal | undefined = this.lifetime, only?: readonly string[]): Promise<void> {
    if (only !== undefined) for (const id of only) if (!this.server(id)) throw new ShuttleError(`no server called ${id}`);
    const servers = this.config().servers.filter((server) => server.enabled && (only === undefined || only.includes(server.id)));
    const runs = signal?.aborted ? [] : servers.map((server) => this.serverSyncs.get(server.id) ?? this.runServer(server, signal));
    const work = (async () => {
      try {
        const results = await Promise.allSettled(runs);
        const failure = results.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
        if (signal?.aborted) return;
        // A server whose run was stopped did not sync, so the next tick tries the full sync again.
        if (only === undefined && results.every((result) => result.status === "fulfilled" && result.value)) this.store.setKv(FULL_SYNC_AT, String(this.now()));
        await this.finishSync(signal);
      } finally {
        this.port.publish();
      }
    })();
    // The loop's tick must not wait out a server's sync the UI started once the loop itself is asked to stop.
    return signal ? settleOrAbort(work, signal) : work;
  }

  /** Whether that server's sync is running. */
  syncingServer(id: string): boolean {
    return this.serverSyncs.has(id);
  }

  /** One server's lists, then its auto reviews and watched PRs; true when it finished rather than stopped. */
  private runServer(server: ServerConfig, signal?: AbortSignal): Promise<boolean> {
    const run = (async () => {
      const started = this.now();
      const result = await syncServer(this, server, signal);
      if (result.state !== "stopped") {
        if (result.backOff !== null) this.backOffs.set(server.id, { kind: result.backOff, at: this.now() });
        else {
          // Only a back-off from a read asked after this sync started is newer news than the sync; it stays.
          if ((this.backOffs.get(server.id)?.at ?? -Infinity) < started) this.backOffs.delete(server.id);
          this.cleanSince.set(server.id, started);
        }
      }
      // A partial sync still brought the lists that passed; only their requests start auto reviews.
      if ((result.state === "ok" || result.state === "partial") && !signal?.aborted) {
        const turn = this.autoReviews.then(() => runAutoReviews(this, server.id, signal, new Set(result.passed)));
        this.autoReviews = turn.catch(() => {});
        await turn;
      }
      // A server that rate-limited Shuttle or looks down is not asked about each watched PR too.
      if (!signal?.aborted && result.backOff === null) await pollWatches(this, server.id, signal);
      return result.state !== "stopped" && !signal?.aborted;
    })().finally(() => this.serverSyncs.delete(server.id));
    this.serverSyncs.set(server.id, run);
    this.port.publish();
    return run;
  }

  /**
   * The steps after the servers' syncs, which hold none of them up. They never run twice at once: a sync that
   * finishes while they run waits for one more run after it, shared with any other sync that does.
   */
  private finishSync(signal?: AbortSignal): Promise<void> {
    if (this.finishing === null) {
      const run = this.afterSync(signal).finally(() => {
        if (this.finishing === run) this.finishing = null;
      });
      this.finishing = run;
      return run;
    }
    this.finishNext ??= this.finishing
      .catch(() => {})
      .then(() => {
        this.finishNext = null;
        return this.finishSync(signal);
      });
    return this.finishNext;
  }

  private async afterSync(signal?: AbortSignal): Promise<void> {
    await this.refreshThreadTitles();
    await this.autoAgent(signal).catch((error: unknown) => this.port.log("warn", `auto agent: ${errText(error)}`));
    this.record();
    await this.deliver();
    // After the lists: a PR that merged or closed since the last sync is done with its review thread. A PR the lists
    // just saw close is being archived already; this pass then finds it done.
    await this.closedSettled();
    if (!signal?.aborted) await this.archiveReviewThreads();
  }

  /**
   * Why a server is left alone until its next sync, or null: it backed off, or its last sync failed, which the
   * sync's own recheck follows up.
   */
  private backOff(id: string): string | null {
    return this.backOffs.get(id)?.kind ?? (this.store.server(id)?.state === "failed" ? "failed" : null);
  }

  /** A fast-lane read asked before a sync that has since come through clean says nothing new about the server. */
  private holdOff(id: string, kind: BackOffKind, askedAt: number): void {
    if (askedAt < (this.cleanSince.get(id) ?? -Infinity)) return;
    this.backOffs.set(id, { kind, at: askedAt });
  }

  /**
   * The loop's step, which never waits on a sync or a fast-lane read: it starts a full sync when one is due and
   * none is running, rechecks a server whose first sync failed, reads the pending merges of every server not
   * syncing, and delivers the batches whose window passed.
   */
  async tick(signal?: AbortSignal): Promise<void> {
    this.drainPosts();
    if (!signal?.aborted) this.runAutoPosts();
    this.drainMerges();
    await endQuietReviews(this).catch((error: unknown) => this.port.log("warn", `quiet reviews: ${errText(error)}`));
    if (signal?.aborted) return;
    void this.readUsage(signal);
    const last = this.lastFullSync();
    // FULL_SYNC_AT moves only once every server of a full sync finished, so the running one is what says it is under way.
    if (this.fullSync === null && (last === null || this.now() - last >= this.settings().syncMinutes * 60_000)) {
      const full = this.inBackground(this.sync(signal)).finally(() => {
        if (this.fullSync === full) this.fullSync = null;
      });
      this.fullSync = full;
    }
    const due = this.config().servers.filter((server) => {
      if (!server.enabled || this.syncingServer(server.id) || this.backOffs.get(server.id)?.kind === "rate_limit") return false;
      const row = this.store.server(server.id);
      const run = row?.failures === 1 ? this.store.lastSyncRun(server.id) : null;
      const at = this.recheckAt(row, kindsOf(run));
      return at !== null && this.now() >= at;
    });
    if (due.length > 0) this.inBackground(this.sync(signal, due.map((server) => server.id)));
    // A server whose sync just started is read by that sync.
    this.fastLane.start((id) => this.syncingServer(id), signal);
    await this.deliver();
    // Rebuilt here when the clock alone made them old, so opening a list never waits for it.
    this.warmIndexes();
  }

  /** Builds every PR's view and search text now when they are out of date; a no-op otherwise. */
  warmIndexes(): void {
    inboxCandidates(this);
    searchIndex(this);
  }

  /** Keeps a sync the tick started, for syncsSettled, and logs how it failed. */
  private inBackground(work: Promise<void>): Promise<void> {
    const run = work.catch((error: unknown) => this.port.log("warn", `sync: ${errText(error)}`)).finally(() => this.ticked.delete(run));
    this.ticked.add(run);
    return run;
  }

  /** Resolves once the syncs ticks started are over, or were stopped. */
  async syncsSettled(): Promise<void> {
    while (this.ticked.size > 0) await Promise.all(this.ticked);
  }

  /** Resolves once no fast-lane read is running. */
  fastLaneSettled(): Promise<void> {
    return this.fastLane.settled();
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

  /**
   * A turn ended. Its review keeps running, since the thread may wait on child threads such as critics; a draft, the
   * thread's shuttle_review_done, a failure or hours of quiet end it. A review thread whose review was already done,
   * such as one still writing when its draft was posted, is archived now.
   */
  onThreadIdle(threadId: string, parentThreadId: string | null = null): Promise<number> {
    const known = this.store.setThreadStatus(threadId, "idle", false);
    this.touchReviews(threadId, parentThreadId);
    if (known) this.port.publish();
    return this.archiveReviewThreads({ threadId });
  }

  onThreadActive(threadId: string, parentThreadId: string | null = null): void {
    const known = this.store.setThreadStatus(threadId, "active", false);
    this.touchReviews(threadId, parentThreadId);
    if (resumeReviews(this, threadId) > 0 || known) this.port.publish();
  }

  /** The thread, or a thread anywhere under a review thread, was at work just now, so its review is not quiet. */
  private touchReviews(threadId: string, parentThreadId: string | null): void {
    if (parentThreadId !== null) this.parents.set(threadId, parentThreadId);
    let id: string | undefined = threadId;
    for (let depth = 0; id !== undefined && depth <= THREAD_ANCESTORS; depth += 1, id = this.parents.get(id)) this.store.touchReviews(id);
  }

  /** The thread asked the user something; an agent's question puts its PR in the Inbox. */
  onInteractionPending(threadId: string): void {
    if (this.store.setThreadStatus(threadId, null, true)) this.port.publish();
  }

  /** Its running reviews end; one whose workspace could not be set up starts again in a new thread (review-runs.ts). */
  async onThreadFailed(threadId: string, failure: ThreadFailure = { error: null }): Promise<void> {
    this.store.setThreadStatus(threadId, "error", false);
    await failReviewsOfThread(this, threadId, failure);
  }

  async onThreadArchived(threadId: string): Promise<void> {
    if (!this.store.linkedThreadIds().includes(threadId)) return;
    await rememberThread(this, threadId).catch(() => {});
    this.port.publish();
  }

  onThreadDeleted(threadId: string): void {
    this.parents.delete(threadId);
    this.store.forgetThread(threadId);
    this.port.publish();
  }
}
