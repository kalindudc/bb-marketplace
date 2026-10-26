// One sync of a server: who the user is there, every list it supports, and a refresh of the
// linked and watched PRs no list covered. Each step is recorded with why it failed, for the Sync tab.
// Then the auto reviews the new requests call for.
import { AdapterError } from "./adapters/adapter";
import { LIST_OPERATIONS, type ListOperation, type ServerConfig } from "./config";
import type { Reason, SyncFailure, SyncState, SyncStep, SyncStepName } from "./contract";
import { errText, type Ctx } from "./ctx";
import type { PrRow, ServerRow } from "./db/store";
import { describeFailure, primaryStep, RETRYABLE, STEP_LABELS } from "./failures";
import { linkFor } from "./keys";
import type { PrSummary } from "./model";
import { startReview } from "./reviews";
import { shortKey } from "./prs";

const DAY = 86_400_000;
const REFRESH_CAP = 30;
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
          if (!this.signal?.aborted) continue;
          return undefined;
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
  const found = await steps.run("whoami", () => adapter.whoami(signal), (name) => `Signed in as ${name}`);
  const login = found ?? before?.login ?? null;
  if (found === undefined && steps.stop === null) {
    steps.stop = "Not run: Shuttle could not tell who you are";
    // A server that cannot say who you are because it is down cannot answer for watched PRs either.
    const kind = steps.steps[0]?.failure?.kind;
    if (kind !== undefined && DOWN.has(kind)) steps.backOff = "down";
  }
  const seen = new Set<number>();
  let listed = 0;
  for (const operation of LIST_OPERATIONS) {
    if (signal?.aborted) break;
    if (!supported.has(operation)) continue;
    const lists = await steps.run(
      operation,
      async () =>
        operation === "authored"
          ? [
              await adapter.list(operation, { state: "open" }, signal),
              await adapter.list(operation, { state: "closed", since: new Date(ctx.now() - ctx.settings().doneDays * DAY).toISOString().slice(0, 10) }, signal),
            ]
          : [await adapter.list(operation, {}, signal)],
      (lists) => {
        const more = lists.every((list) => list.complete) ? "" : ", more than Shuttle reads";
        return operation === "authored" ? `${lists[0]!.rows.length} open, ${lists[1]!.rows.length} merged or closed${more}` : `${plural(lists[0]!.rows.length, "PR")}${more}`;
      },
    );
    if (lists === undefined) continue;
    const rows: PrSummary[] = lists.flatMap((list) => list.rows);
    const complete = lists.every((list) => list.complete);
    const reasonRows = ctx.store.tx(() =>
      rows.map((summary) => {
        const pr = ctx.store.upsertPr(server.id, summary, summary.url ?? linkFor(server, summary.repo, summary.number), operation === "authored");
        seen.add(pr.id);
        return { prId: pr.id, teams: summary.teams };
      }),
    );
    // Closed PRs keep `authored` so Done can list them; the other reasons only describe open PRs.
    ctx.store.replaceReasons(server.id, REASON_OF[operation], reasonRows, complete);
    listed += rows.length;
  }
  if (!signal?.aborted) await refreshTracked(ctx, server, seen, steps, signal);
  // A sync cut short by a stop says nothing about the server; the next one does.
  if (signal?.aborted) return { server: server.id, state: "stopped", ok: false, listed, errors: ["stopped"], passed: [], backOff: null };
  const now = ctx.now();
  const state = stateOf(steps.steps);
  saveRun(ctx, server, before, { state, steps: steps.steps, login, started, now });
  ctx.port.publish();
  const errors = steps.steps.flatMap((step) => (step.failure ? [`${step.operation}: ${step.failure.message}`] : []));
  const passed = steps.steps.filter((step) => step.status === "ok").map((step) => step.operation);
  return { server: server.id, state, ok: state === "ok", listed, errors, passed, backOff: steps.backOff };
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

/** Linked, watched and tracked open PRs that no list covered this round, such as someone else's PR you track. */
async function refreshTracked(ctx: Ctx, server: ServerConfig, seen: Set<number>, steps: Steps, signal?: AbortSignal): Promise<void> {
  const tracked = ctx.store
    .allPrs()
    .filter((pr) => pr.server === server.id && !seen.has(pr.id) && (pr.state === "open" || pr.state === "draft"))
    .filter((pr) => pr.tracked === 1 || ctx.store.watch(pr.id) !== null || ctx.store.linksOf(pr.id).length > 0)
    .sort((a, b) => a.fetched_at - b.fetched_at)
    .slice(0, REFRESH_CAP);
  if (tracked.length === 0) return;
  if (steps.stop !== null) return steps.skip("refresh");
  const adapter = ctx.adapter(server.id);
  const started = ctx.now();
  const failed: Array<{ key: string; failure: SyncFailure }> = [];
  let read = 0;
  // Each PR is read once: one that fails waits for the next sync rather than a retry.
  for (const pr of tracked) {
    if (signal?.aborted) return;
    try {
      const summary = await adapter.view(pr.repo, pr.number, signal);
      if (summary.repo.toLowerCase() !== pr.repo.toLowerCase() || summary.number !== pr.number) throw new Error(`answered for ${summary.repo}#${summary.number}`);
      ctx.store.upsertPr(server.id, { ...summary, repo: pr.repo }, summary.url ?? pr.url, false);
      read++;
      steps.passed();
    } catch (error) {
      if (signal?.aborted) return;
      const failure = steps.failureOf(error);
      failed.push({ key: shortKey(ctx, pr), failure });
      if (failure.kind === "rate_limit" || steps.down(failure)) break;
    }
  }
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

export function globMatch(glob: string, value: string): boolean {
  const re = new RegExp(`^${glob.trim().replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".")}$`, "iu");
  return re.test(value);
}

const TRIGGER_REASON = { requested: "requested", team: "team", mentioned: "mentioned" } as const;

/**
 * PRs that newly asked for the user's review since the server's baseline and have no review for this head.
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
    try {
      await startReview(ctx, { key: pr.key }, "auto");
      started++;
    } catch (error) {
      ctx.store.setKv(`auto_failed:${pr.id}:${pr.head ?? ""}`, String(ctx.now()));
      ctx.store.addEvent("auto_failed", `Auto review of ${shortKey(ctx, pr)} could not start: ${errText(error)}`, pr.id);
    }
  }
  return started;
}
