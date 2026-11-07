// One sync of a server: who the user is there, your open PRs, every other list it supports, and a
// refresh of the linked and watched PRs no list covered. Each list shows as soon as it lands. Each step
// is recorded with why it failed, for the Sync tab. Then the auto reviews the new requests call for.
import { AdapterError, type ListResult } from "./adapters/adapter";
import { LIST_OPERATIONS, type ListOperation, type ServerConfig } from "./config";
import { SYNC_STEPS, type Reason, type SyncFailure, type SyncState, type SyncStep, type SyncStepName } from "./contract";
import { errText, type Ctx } from "./ctx";
import type { PrRow, ServerRow } from "./db/store";
import { describeFailure, primaryStep, RETRYABLE, STEP_LABELS } from "./failures";
import { linkFor } from "./keys";
import type { PrSummary } from "./model";
import { SpawnUnavailableError } from "./ports";
import { startReview } from "./reviews";
import { myReviewOf, shortKey } from "./prs";

const DAY = 86_400_000;
/** How long an auto review waits for bb to have a machine or environment for it before it counts as failed. */
const AUTO_WAIT_MS = 3_600_000;
const REFRESH_CAP = 30;
/** Linked and tracked PRs read at once. */
const REFRESH_AT_ONCE = 3;
/** Lists of one server read at once, after the open PRs of yours that go first on their own. */
const LISTS_AT_ONCE = 2;
/** A closed read since the last one starts this much earlier, for a PR the server's search indexed late. */
export const CLOSED_MARGIN_MS = 5 * 60_000;
/** How often the closed list is read over the whole Done window, which also lets go of PRs that left it. */
export const CLOSED_FULL_MS = 3_600_000;
/** One more try after this pause, for a failure that usually passes by itself. */
export const RETRY_PAUSE_MS = 3_000;
/** Tries again per server per sync, so a server in trouble is asked only a little more. */
export const RETRY_BUDGET = 2;
/** After a first failed sync, the next one comes this soon, so a banner or its end does not wait a whole interval. */
export const RECHECK_MS = 60_000;

const REASON_OF: Record<ListOperation, Reason> = { authored: "authored", review_requested: "requested", team_requested: "team", mentioned: "mentioned", reviewed: "reviewed" };
/** The step whose list gives a PR each reason; a PR with none is only refreshed. */
export const STEP_OF_REASON: Record<Reason, SyncStepName> = { authored: "authored", requested: "review_requested", team: "team_requested", mentioned: "mentioned", reviewed: "reviewed" };
/** Failures that say the server itself is down, rather than one request going wrong. */
const DOWN = new Set<SyncFailure["kind"]>(["unavailable", "network", "timeout"]);

export interface SyncResult {
  server: string;
  state: SyncState | "stopped";
  ok: boolean;
  listed: number;
  errors: string[];
  /** Steps that passed, so auto reviews only trust the lists this sync read. */
  passed: SyncStepName[];
  /** The server rate-limited Shuttle or looks down: nothing else asks it again this sync. */
  backOff: "rate_limit" | "down" | null;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const more = (list: ListResult) => (list.complete ? "" : ", more than Shuttle reads");
const isLive = (pr: PrRow) => pr.state === "open" || pr.state === "draft";

/** Runs `fn` over `items` in order, at most `limit` at a time. */
async function atOnce<T>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** When the closed list was last read in full, when over the whole Done window, and how many days that window was. */
interface ClosedRead {
  at: number;
  fullAt: number;
  doneDays?: number;
}
const closedReadKey = (server: string) => `closed_read:${server}`;

/** When the merged and closed PRs you reviewed were last read, and the widest history window read in full. */
interface ReviewedRead {
  at: number;
  days: number;
}
const reviewedReadKey = (server: string) => `reviewed_closed_read:${server}`;

/**
 * Runs a sync's steps and records each. A failure that usually passes gets one more try after a
 * pause, within a small budget per sync; a rate limit, or a server down for two steps in a row,
 * leaves the remaining steps for the next sync.
 */
class Steps {
  readonly steps: SyncStep[] = [];
  /** Why the remaining steps do not run. */
  stop: string | null = null;
  backOff: SyncResult["backOff"] = null;
  private retries = RETRY_BUDGET;
  private downInARow = 0;

  constructor(
    private readonly ctx: Ctx,
    private readonly server: ServerConfig,
    private readonly signal?: AbortSignal,
  ) {}

  failureOf(error: unknown): SyncFailure {
    const detail = error instanceof AdapterError ? error.detail : {};
    return describeFailure(this.server, { message: errText(error), ...detail });
  }

  skip(operation: SyncStepName): void {
    this.steps.push({ operation, status: "skipped", ms: 0, attempts: 0, detail: this.stop, failure: null });
  }

  async run<T>(operation: SyncStepName, fn: () => Promise<T>, detail: (value: T) => string): Promise<T | undefined> {
    if (this.stop !== null) return void this.skip(operation);
    const started = this.ctx.now();
    for (let attempts = 1; ; attempts++) {
      try {
        const value = await fn();
        this.passed();
        this.steps.push({ operation, status: "ok", ms: this.ctx.now() - started, attempts, detail: detail(value), failure: null });
        return value;
      } catch (error) {
        if (this.signal?.aborted) return undefined;
        const failure = this.failureOf(error);
        const retried = error instanceof AdapterError && error.detail.retried === true;
        if (attempts === 1 && !retried && RETRYABLE.has(failure.kind) && this.retries > 0) {
          this.retries--;
          await this.ctx.pause(RETRY_PAUSE_MS, this.signal);
          if (this.signal?.aborted) return undefined;
          // A step read at the same time may have hit a rate limit or found the server down during the pause.
          if (this.stop !== null) return void this.skip(operation);
          continue;
        }
        this.failed(operation, failure, this.ctx.now() - started, attempts, null);
        return undefined;
      }
    }
  }

  /** `counted`: the caller already counted this failure toward the server being down, as the refresh does per PR. */
  failed(operation: SyncStepName, failure: SyncFailure, ms: number, attempts: number, detail: string | null, counted = false): void {
    this.steps.push({ operation, status: "failed", ms, attempts, detail, failure });
    if (failure.kind === "rate_limit") {
      this.stop = `Not run: ${failure.summary}`;
      this.backOff = "rate_limit";
    } else if (counted ? this.downInARow >= 2 : this.down(failure)) {
      this.stop = `Not run: ${this.server.name} failed twice in a row, so Shuttle leaves it until the next sync`;
      this.backOff = "down";
    }
  }

  passed(): void {
    this.downInARow = 0;
  }

  /** In the Sync tab's order, whichever finished first. */
  ordered(): SyncStep[] {
    return [...this.steps].sort((a, b) => SYNC_STEPS.indexOf(a.operation) - SYNC_STEPS.indexOf(b.operation));
  }

  /** Counts failures that say the server is down; true at the second in a row. */
  down(failure: SyncFailure): boolean {
    this.downInARow = DOWN.has(failure.kind) ? this.downInARow + 1 : 0;
    return this.downInARow >= 2;
  }
}

export async function syncServer(ctx: Ctx, server: ServerConfig, signal?: AbortSignal): Promise<SyncResult> {
  const started = ctx.now();
  const adapter = ctx.adapter(server.id);
  const supported = new Set(adapter.operations());
  const before = ctx.store.server(server.id);
  const steps = new Steps(ctx, server, signal);
  // whoami is optional: a server without it still lists PRs, and only telling your own PRs and comments apart waits on a login.
  const asked = supported.has("whoami");
  const found = asked ? await steps.run("whoami", () => adapter.whoami(signal), (name) => `Signed in as ${name}`) : undefined;
  const login = found ?? before?.login ?? null;
  if (asked && found === undefined && steps.stop === null) {
    steps.stop = "Not run: Shuttle could not tell who you are";
    // A server that cannot say who you are because it is down cannot answer for watched PRs either.
    const kind = steps.steps[0]?.failure?.kind;
    if (kind !== undefined && DOWN.has(kind)) steps.backOff = "down";
  }
  const seen = new Set<number>();
  /** PRs of yours still open here that neither authored list brought: the refresh reads each on its own. */
  const unsure = new Set<number>();
  let listed = 0;
  /** Writes a list's PRs and reasons and shows them at once; a list that is not complete never drops a reason. */
  const land = (reason: Reason, rows: readonly PrSummary[], complete: boolean) => {
    const reasonRows = ctx.store.tx(() =>
      rows.map((summary) => {
        // A list's description makes no full read: the PR's own read still brings what lists lack.
        const pr = ctx.store.upsertPr(server.id, summary, summary.url ?? linkFor(server, summary.repo, summary.number), reason === "authored", false);
        seen.add(pr.id);
        return { prId: pr.id, teams: summary.teams };
      }),
    );
    ctx.store.replaceReasons(server.id, reason, reasonRows, complete);
    listed += rows.length;
    ctx.port.publish();
    return reasonRows;
  };
  // Your open PRs first and on their own: they are what you look for, and no slow list holds them up.
  let open: { rows: Array<{ prId: number; teams: string[] }>; complete: boolean } | undefined;
  if (supported.has("authored") && !signal?.aborted) {
    const list = await steps.run("authored", () => adapter.list("authored", { state: "open" }, signal), (list) => `${list.rows.length} open${more(list)}`);
    if (list !== undefined) open = { rows: land("authored", list.rows, false), complete: list.complete };
  }
  const readClosed = async () => {
    const before = ctx.store.kv(closedReadKey(server.id));
    const last = before === null ? null : (JSON.parse(before) as ClosedRead);
    const asked = ctx.now();
    const doneDays = ctx.settings().doneDays;
    const window = asked - doneDays * DAY;
    // A wider Done window than the last full read's has older PRs that no read since then brought.
    const full = last === null || asked - last.fullAt >= CLOSED_FULL_MS || last.doneDays !== doneDays;
    const from = full ? window : Math.max(window, last.at - CLOSED_MARGIN_MS);
    const since = new Date(from).toISOString();
    const list = await steps.run(
      "authored_closed",
      () => adapter.list("authored", { state: "closed", since: since.slice(0, 10), sinceAt: `${since.slice(0, 19)}+00:00` }, signal),
      (list) => `${list.rows.length} merged or closed${full ? "" : " since the last read"}${more(list)}`,
    );
    if (list === undefined) return;
    const closed = land("authored", list.rows, false);
    // A read cut short may have missed a merge, so the next one starts where this one did.
    if (!list.complete) return;
    ctx.store.setKv(closedReadKey(server.id), JSON.stringify({ at: asked, fullAt: full ? asked : last.fullAt, doneDays } satisfies ClosedRead));
    if (open !== undefined && open.complete) for (const id of settleAuthored(ctx, server.id, [...open.rows, ...closed], full)) unsure.add(id);
  };
  const others = LIST_OPERATIONS.filter((operation) => operation !== "authored" && supported.has(operation)).map((operation) => async () => {
    const list = await steps.run(operation, () => adapter.list(operation, {}, signal), (list) => `${plural(list.rows.length, "PR")}${more(list)}`);
    if (list !== undefined) land(REASON_OF[operation], list.rows, list.complete);
  });
  // Your review history: no list asks you about these PRs, so they land with no reason.
  const readReviewedClosed = async () => {
    const before = ctx.store.kv(reviewedReadKey(server.id));
    const last = before === null ? null : (JSON.parse(before) as ReviewedRead);
    const asked = ctx.now();
    const days = ctx.settings().reviewedDays;
    const window = asked - days * DAY;
    // Nothing leaves the history, so the whole window is read only once, and again when it grows.
    const full = last === null || days > last.days;
    const from = full ? window : Math.max(window, last.at - CLOSED_MARGIN_MS);
    const since = new Date(from).toISOString();
    const list = await steps.run(
      "reviewed_closed",
      () => adapter.list("reviewed", { state: "closed", since: since.slice(0, 10), sinceAt: `${since.slice(0, 19)}+00:00` }, signal),
      (list) => `${plural(list.rows.length, "merged or closed PR")}${full ? ` from the last ${plural(days, "day")}` : " since the last read"}${more(list)}`,
    );
    if (list === undefined) return;
    // A command that predates this read prints your open reviewed PRs again; the reviewed list has those.
    const closed = list.rows.filter((summary) => summary.state === "merged" || summary.state === "closed");
    ctx.store.tx(() => {
      for (const summary of closed) seen.add(ctx.store.upsertPr(server.id, summary, summary.url ?? linkFor(server, summary.repo, summary.number), false, false).id);
    });
    listed += closed.length;
    ctx.port.publish();
    // Reading the whole window again cannot get past the server's cap, so only a later read cut short is read again.
    if (!full && !list.complete) return;
    ctx.store.setKv(reviewedReadKey(server.id), JSON.stringify({ at: asked, days: full ? days : last.days } satisfies ReviewedRead));
  };
  const history = supported.has("reviewed") ? [readReviewedClosed] : [];
  const lists = [...(supported.has("authored") ? [readClosed] : []), ...others, ...history];
  await atOnce(lists, LISTS_AT_ONCE, async (read) => {
    if (!signal?.aborted) await read();
  });
  if (!signal?.aborted) await refreshTracked(ctx, server, seen, steps, signal, { unsure, login });
  // A sync cut short by a stop says nothing about the server; the next one does.
  if (signal?.aborted) return { server: server.id, state: "stopped", ok: false, listed, errors: ["stopped"], passed: [], backOff: null };
  const now = ctx.now();
  const ordered = steps.ordered();
  const state = stateOf(ordered);
  saveRun(ctx, server, before, { state, steps: ordered, login, started, now });
  ctx.port.publish();
  const errors = ordered.flatMap((step) => (step.failure ? [`${step.operation}: ${step.failure.message}`] : []));
  const passed = ordered.filter((step) => step.status === "ok").map((step) => step.operation);
  return { server: server.id, state, ok: state === "ok", listed, errors, passed, backOff: steps.backOff };
}

/**
 * Once both authored lists passed in full: a PR of yours in neither is no longer listed as yours, which only
 * a full read can say. A read since the last one did not see older closed PRs, nor a merge its search had not
 * indexed yet, so it keeps every reason and returns the open PRs of yours it did not see, for a read of each.
 */
function settleAuthored(ctx: Ctx, serverId: string, seen: ReadonlyArray<{ prId: number; teams: string[] }>, full: boolean): number[] {
  const keep = new Map(seen.map((row) => [row.prId, row.teams]));
  const unsure: number[] = [];
  if (!full) {
    for (const row of ctx.store.reasonRows("authored")) {
      if (row.server !== serverId || keep.has(row.pr_id)) continue;
      const pr = ctx.store.prById(row.pr_id);
      if (pr === null) continue;
      keep.set(row.pr_id, JSON.parse(row.teams) as string[]);
      if (isLive(pr)) unsure.push(pr.id);
    }
  }
  ctx.store.replaceReasons(serverId, "authored", [...keep].map(([prId, teams]) => ({ prId, teams })), true);
  return unsure;
}

/** Lets go of `authored` on a PR its own read says someone else wrote. */
function dropAuthored(ctx: Ctx, serverId: string, prId: number): void {
  const rows = ctx.store.reasonRows("authored").filter((row) => row.server === serverId && row.pr_id !== prId);
  ctx.store.replaceReasons(serverId, "authored", rows.map((row) => ({ prId: row.pr_id, teams: JSON.parse(row.teams) as string[] })), true);
}

/** failed: Shuttle could not tell who you are, or no list came; partial: some steps failed and the rest are current. */
export function stateOf(steps: readonly SyncStep[]): SyncState {
  if (steps.every((step) => step.status === "ok")) return "ok";
  const lists = steps.filter((step) => step.operation !== "whoami" && step.operation !== "refresh");
  if (steps[0]?.operation === "whoami" && steps[0].status !== "ok") return "failed";
  if (lists.length > 0 && lists.every((step) => step.status !== "ok")) return "failed";
  return "partial";
}

function saveRun(ctx: Ctx, server: ServerConfig, before: ServerRow | null, run: { state: SyncState; steps: SyncStep[]; login: string | null; started: number; now: number }): void {
  const { state, steps, now } = run;
  const ok = state === "ok";
  const okAt = { ...(before?.steps_ok_at ? (JSON.parse(before.steps_ok_at) as Record<string, number>) : {}) };
  for (const step of steps) if (step.status === "ok") okAt[step.operation] = now;
  const failures = ok ? 0 : (before?.failures ?? 0) + 1;
  const first = primaryStep(steps);
  ctx.store.tx(() => {
    ctx.store.addSyncRun({ server: server.id, at: now, duration_ms: now - run.started, state, steps: JSON.stringify(steps) });
    ctx.store.saveServer({
      id: server.id,
      ok: ok ? 1 : 0,
      state,
      login: run.login,
      error: first?.failure ? `${first.operation}: ${first.failure.summary}`.slice(0, 2000) : null,
      last_ok_at: ok ? now : (before?.last_ok_at ?? null),
      last_sync_at: now,
      duration_ms: now - run.started,
      // The first good sync is the baseline: requests already waiting then never start auto reviews.
      baseline_at: before?.baseline_at ?? (ok ? now : null),
      failures,
      failing_since: ok ? null : (before?.failures ?? 0) > 0 ? (before?.failing_since ?? now) : now,
      steps_ok_at: JSON.stringify(okAt),
      failed_steps: JSON.stringify(steps.filter((step) => step.status !== "ok").map((step) => step.operation)),
    });
  });
  const wasOk = before === null || before.state === null || before.state === "ok";
  if (!ok && wasOk && first?.failure) {
    const asked = STEP_LABELS[first.operation];
    if (state === "failed") ctx.store.addEvent("sync_failed", `${server.name} sync failed: ${first.failure.summary} when Shuttle asked for ${asked}. Its PRs show the last good data.`);
    else ctx.store.addEvent("sync_partial", `${server.name} synced, except ${asked}: ${first.failure.summary}. Those PRs show the last good data.`);
  }
  if (ok && !wasOk) ctx.store.addEvent("sync_ok", `${server.name} syncs again.`);
}

/**
 * Linked, watched, tracked and active-board open PRs that no list covered this round, such as someone else's
 * PR you track, and open PRs of yours that the authored lists no longer brought.
 */
async function refreshTracked(ctx: Ctx, server: ServerConfig, seen: Set<number>, steps: Steps, signal: AbortSignal | undefined, mine: { unsure: ReadonlySet<number>; login: string | null }): Promise<void> {
  const tracked = ctx.store
    .allPrs()
    .filter((pr) => pr.server === server.id && !seen.has(pr.id) && (pr.state === "open" || pr.state === "draft"))
    .filter((pr) => mine.unsure.has(pr.id) || pr.tracked === 1 || ctx.store.watch(pr.id) !== null || ctx.store.linksOf(pr.id).length > 0 || ctx.store.prInActiveBoard(pr.id))
    .sort((a, b) => a.fetched_at - b.fetched_at)
    .slice(0, REFRESH_CAP);
  if (tracked.length === 0) return;
  if (steps.stop !== null) return steps.skip("refresh");
  const adapter = ctx.adapter(server.id);
  const started = ctx.now();
  const failed: Array<{ index: number; key: string; failure: SyncFailure }> = [];
  let read = 0;
  let halted = false;
  // Each PR is read once: one that fails waits for the next sync rather than a retry.
  await atOnce(tracked, REFRESH_AT_ONCE, async (pr, index) => {
    if (halted || signal?.aborted) return;
    try {
      const summary = await adapter.view(pr.repo, pr.number, signal);
      if (summary.repo.toLowerCase() !== pr.repo.toLowerCase() || summary.number !== pr.number) throw new Error(`answered for ${summary.repo}#${summary.number}`);
      ctx.store.upsertPr(server.id, { ...summary, repo: pr.repo }, summary.url ?? pr.url, false);
      if (mine.unsure.has(pr.id) && mine.login !== null && summary.author !== "" && summary.author.toLowerCase() !== mine.login.toLowerCase()) dropAuthored(ctx, server.id, pr.id);
      read++;
      steps.passed();
    } catch (error) {
      if (signal?.aborted) return;
      const failure = steps.failureOf(error);
      failed.push({ index, key: shortKey(ctx, pr), failure });
      if (failure.kind === "rate_limit" || steps.down(failure)) halted = true;
    }
  });
  if (signal?.aborted) return;
  failed.sort((a, b) => a.index - b.index);
  const ms = ctx.now() - started;
  if (failed.length === 0) {
    steps.steps.push({ operation: "refresh", status: "ok", ms, attempts: 1, detail: plural(read, "PR"), failure: null });
    return;
  }
  // A rate limit or a refused sign-in on any PR is what the step reports, so it backs off and skips the recheck.
  const shown = primaryStep(failed)!;
  const names = failed.slice(0, 3).map((f) => f.key).join(", ") + (failed.length > 3 ? ", …" : "");
  steps.failed("refresh", { ...shown.failure, message: `${shown.key}: ${shown.failure.message}` }, ms, 1, `${failed.length} of ${tracked.length} could not be read: ${names}`, true);
}

/** A wait is the refusals of one PR head at consecutive syncs: `since` the first, `last` the latest. */
interface AutoWait {
  since: number;
  last: number;
}

export function globMatch(glob: string, value: string, caseSensitive = false): boolean {
  const re = new RegExp(`^${glob.trim().replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".")}$`, caseSensitive ? "u" : "iu");
  return re.test(value);
}

const TRIGGER_REASON = { requested: "requested", team: "team", mentioned: "mentioned" } as const;

/**
 * Your reviews the server dismissed, on PRs with new commits since, however long ago you reviewed. The first look notes
 * the head of each PR already so and leaves it to you, so an upgrade or turning on auto review does not review a backlog;
 * such a PR comes once its head moves on.
 */
function dismissedWithNewCommits(ctx: Ctx, serverId: string): number[] {
  const key = `auto_dismissed_heads:${serverId}`;
  const stored = ctx.store.kv(key);
  const noted = stored === null ? null : (JSON.parse(stored) as Record<string, string>);
  const out: PrRow[] = [];
  for (const row of ctx.store.reasonRows("reviewed")) {
    const pr = row.server === serverId ? ctx.store.prById(row.pr_id) : null;
    if (!pr || pr.head === null || noted?.[pr.id] === pr.head) continue;
    const mine = myReviewOf(ctx, pr);
    if (mine?.verdict === "dismissed" && mine.head !== null && mine.head !== pr.head) out.push(pr);
  }
  if (noted !== null) return out.map((pr) => pr.id);
  ctx.store.setKv(key, JSON.stringify(Object.fromEntries(out.map((pr) => [pr.id, pr.head]))));
  return [];
}

/**
 * PRs that newly asked for the user's review since the server's baseline and have no review for this head. A review of
 * the user's that the server dismissed asks again, as a request by name does, once the PR has new commits.
 * With `passed`, only requests from lists this sync read: a list that failed may hold a withdrawn request.
 */
export function autoReviewCandidates(ctx: Ctx, serverId: string, passed?: ReadonlySet<SyncStepName>): PrRow[] {
  const config = ctx.config().autoReview;
  const baseline = ctx.store.server(serverId)?.baseline_at;
  if (!baseline) return [];
  const ids = new Set<number>();
  for (const trigger of config.when) {
    if (passed !== undefined && !passed.has(STEP_OF_REASON[TRIGGER_REASON[trigger]])) continue;
    for (const row of ctx.store.reasonRows(TRIGGER_REASON[trigger])) if (row.server === serverId && row.since > baseline) ids.add(row.pr_id);
  }
  if (config.when.includes("requested") && (passed === undefined || passed.has(STEP_OF_REASON.reviewed))) {
    for (const id of dismissedWithNewCommits(ctx, serverId)) ids.add(id);
  }
  const out: PrRow[] = [];
  for (const id of ids) {
    const pr = ctx.store.prById(id);
    if (!pr || pr.mine) continue;
    if (pr.state !== "open" && !(pr.state === "draft" && config.drafts)) continue;
    if (config.repos.length && !config.repos.some((glob) => globMatch(glob, pr.repo))) continue;
    const reviews = ctx.store.reviewsOf(pr.id);
    // A review of an unknown head counts for that unknown head too, so a server without heads is reviewed once.
    if (reviews.some((r) => r.head === pr.head)) continue;
    if (config.rerun === "never" && reviews.some((r) => r.trigger === "auto")) continue;
    if (ctx.store.kv(`auto_failed:${pr.id}:${pr.head ?? ""}`)) continue;
    out.push(pr);
  }
  return out;
}

export async function runAutoReviews(ctx: Ctx, serverId: string, signal?: AbortSignal, passed?: ReadonlySet<SyncStepName>): Promise<number> {
  const config = ctx.config().autoReview;
  if (!config.enabled || ctx.settings().pauseAutomations) return 0;
  let started = 0;
  for (const pr of autoReviewCandidates(ctx, serverId, passed)) {
    if (signal?.aborted) break;
    if (ctx.store.autoReviewsSince(ctx.now() - DAY) >= config.maxPerDay) {
      const day = new Date(ctx.now()).toISOString().slice(0, 10);
      if (ctx.store.kv("auto_capped") !== day) {
        ctx.store.setKv("auto_capped", day);
        ctx.store.addEvent("auto_capped", `Auto review reached its limit of ${config.maxPerDay} a day; the rest wait in Reviews.`);
      }
      break;
    }
    const head = `${pr.id}:${pr.head ?? ""}`;
    try {
      await startReview(ctx, { key: pr.key }, "auto");
      started++;
      ctx.store.deleteKv(`auto_waiting:${head}`);
    } catch (error) {
      if (error instanceof SpawnUnavailableError) {
        const stored = ctx.store.kv(`auto_waiting:${head}`);
        const wait = stored === null ? null : (JSON.parse(stored) as AutoWait);
        // A head not tried for over an hour, or for two syncs when they are further apart, waits afresh: its request may have come back.
        const gap = Math.max(AUTO_WAIT_MS, 2 * ctx.settings().syncMinutes * 60_000);
        if (wait === null || ctx.now() - wait.last > gap) {
          ctx.store.setKv(`auto_waiting:${head}`, JSON.stringify({ since: ctx.now(), last: ctx.now() } satisfies AutoWait));
          ctx.store.addEvent("auto_waiting", `Auto review of ${shortKey(ctx, pr)} waits: ${errText(error)}. Shuttle tries again at each sync for up to an hour.`, pr.id);
          continue;
        }
        if (ctx.now() - wait.since < AUTO_WAIT_MS) {
          ctx.store.setKv(`auto_waiting:${head}`, JSON.stringify({ ...wait, last: ctx.now() } satisfies AutoWait));
          continue;
        }
        ctx.store.deleteKv(`auto_waiting:${head}`);
        ctx.store.setKv(`auto_failed:${head}`, String(ctx.now()));
        ctx.store.addEvent("auto_failed", `Auto review of ${shortKey(ctx, pr)} could not start in an hour of waiting: ${errText(error)}`, pr.id);
        continue;
      }
      ctx.store.setKv(`auto_failed:${head}`, String(ctx.now()));
      ctx.store.addEvent("auto_failed", `Auto review of ${shortKey(ctx, pr)} could not start: ${errText(error)}`, pr.id);
    }
  }
  return started;
}
