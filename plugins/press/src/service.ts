import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BbPluginApi, MessageDispatchHookContext, MessageDispatchHookDecision, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { mergeThreadOverride, POINT_IDS, resolvePressPolicy, type PointId, type Policy, type PolicyLayer, type PressSettings } from "./policy";
import { blockers, decide, estimateCompaction, EST_MS_PER_TOKEN, nextCandidate, type Decision, type DecideInput } from "./decide";
import {
  completedCompactions, deriveSnapshot, failedCompactions, pickBoundary, scanTimeline, threadRunning, type SignalDerivation, type ThreadUsage,
} from "./snapshot";
import type { CompactionRow, PressStore } from "./store";
import { requestCompaction, type CompactResult, type WorkspaceRef } from "./compact";
import { composerConfigPath, composerRows, ledgerPath, readLedger, summaryFilePath, writeComposerConfig, type LedgerIo } from "./ledger";
import { normalizeSettings } from "./settings";
import type { CompactionSummary, DecisionSummary, EffectivePoints, ThreadStatusDto } from "./contract";

type ThreadDto = MessageDispatchHookContext["thread"];
/** The thread fields Press reads; a thread from any SDK call or event payload has them. */
type ThreadInfo = Pick<ThreadDto, "id" | "status" | "updatedAt" | "environmentId" | "providerId"> & { archivedAt?: number | null };
type QueuedEntry = PluginThreadEventPayloads["message.queued"]["entry"];

/** A compaction still pending a landing after this long is given up as cancelled. */
export const PENDING_TTL_MS = 30 * 60_000;
export const SWEEP_INTERVAL_MS = 60_000;
/** Evaluations per sweep cap: the sweep is the low-frequency path, not a burst. */
export const SWEEP_MAX_EVALUATIONS = 20;
/** An unconsumed hint older than this is pruned as stale. */
export const HINT_TTL_MS = 24 * 60 * 60_000;
export const DECISION_TTL_MS = 14 * 24 * 60 * 60_000;
/** Landings older than this are not backfilled, and their boundaries are no longer looked for. */
export const RECENT_MS = 3 * 60 * 60_000;
/** How long after a landing Press looks for the composer's report of it. */
export const COMPOSER_WAIT_MS = 15 * 60_000;
/** The longest Press holds a thread's next turn for its compaction. */
export const HOLD_MAX_MS = 10 * 60_000;
/** A held message is re-attempted this often, so the hold can lapse even if nothing else happens. */
export const HOLD_RETRY_MS = 60_000;
export const HOLD_REASON = "Press is compacting this thread before the next turn";
/** A message that drains as a turn ends waits this long, once, for the timeline signals of that turn. */
export const SIGNALS_WAIT_MS = 3_000;
export const SIGNALS_WAIT_REASON = "Press is checking this thread before the next turn";
/** The dispatch hook answers within this, or proceeds: core fails the user's message on a slow or throwing hook. */
export const DISPATCH_TIMEOUT_MS = 2_000;
export const EVENTS_SYNC_MS = 5_000;
/** Anchoring and composer lookups only, which are not urgent. */
export const EVENTS_SYNC_SLOW_MS = 15_000;
/** A row whose boundary never shows up is not looked for again after this many timeline reads. */
export const MAX_ANCHOR_ATTEMPTS = 40;
/** While a thread runs, its status is refreshed at most this often so the chip's percent stays live. */
export const RUNNING_INVALIDATE_MS = 5_000;
/** The sweep re-resolves an idle thread's policy (a host read of its workspace file) at most this often. */
const SWEEP_POLICY_CACHE_MS = 5 * 60_000;
const WORKSPACE_CACHE_MS = 5 * 60_000;
const HISTORY_LIMIT = 50;
const MAP_LIMIT = 500;

const PROCEED: MessageDispatchHookDecision = { action: "proceed" };

function effectivePoints(policy: Policy): EffectivePoints {
  const enabled = new Set(policy.points.filter((point) => point.enabled).map((point) => point.id));
  return { phase: enabled.has("phase"), agent: enabled.has("agent"), volume: enabled.has("volume"),
    turns: enabled.has("turns"), idle: enabled.has("idle"), thrash: enabled.has("thrash") };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capped<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAP_LIMIT) map.delete(map.keys().next().value as K);
}

export const PROVIDER_OFF = "Compaction is disabled for this provider in Press policy.";

/** Press policy can switch a provider off: Press then never compacts its threads or holds their messages. */
export function providerEnabled(policy: Policy, providerId: string): boolean {
  return policy.providers[providerId]?.enabled !== false;
}

export interface EvaluateOptions {
  origin: string;
  agentHint?: boolean;
  dryRun?: boolean;
  /** `bb press compact --point <id>`: force this point as the candidate; the vetoes still apply. */
  forcePoint?: string;
  /** The thread as an event or list already delivered it, to save a read. */
  thread?: ThreadInfo;
}

export interface EvaluateResult {
  decision: Decision;
  decisionId: string | null;
  mode: string;
  acted: boolean;
  error?: string;
  /** What the next firing point would be, ignoring vetoes. */
  next: { point: string; reason: string | null } | null;
}

interface Hold {
  since: number;
  count: number;
  /** The compaction (or `starting`) it holds for, so a lapsed hold does not hold the same one again. */
  key: string;
}

/**
 * The loop. It records every landing bb reports in one history, evaluates threads when a turn ends,
 * holds a thread's next turn while Press compacts it (and compacts before that turn when a point fires),
 * and sweeps idle threads once a minute for the idle, volume, turns and thrash points. `observe` logs,
 * `advisor` records a proposal without acting, `auto` acts.
 */
export class PressService {
  /** Compactions being started (between the decision and the store's pending row). */
  private readonly starting = new Map<string, { at: number; point: string | null }>();
  private readonly holds = new Map<string, Hold>();
  private readonly lapsedHolds = new Map<string, string>();
  private readonly heldEntries = new Map<string, Set<string>>();
  private readonly syncedAt = new Map<string, number>();
  private readonly syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly runningInvalidatedAt = new Map<string, number>();
  private readonly anchorAttempts = new Map<string, { updatedAt: number; count: number }>();
  private readonly signals = new Map<string, { updatedAt: number; since: number | null; value: SignalDerivation }>();
  private readonly sweepSeen = new Map<string, number>();
  private readonly policies = new Map<string, { at: number; workspace: string | null; policy: Policy }>();
  private readonly workspaces = new Map<string, { at: number; ref: WorkspaceRef | null }>();
  private readonly published = new Map<string, string>();
  /** The last warning per policy source, so a bad file or setting is reported when it changes, not on every resolution. */
  private readonly reported = new Map<string, string>();
  /** The thread's `updatedAt` a drained message last waited on the timeline signals for. */
  private readonly signalWaits = new Map<string, number>();
  /** When a compact decision last used each boundary signal, including proposals the decision log de-duplicated. */
  private readonly signalUse = new Map<string, Map<string, number>>();
  /** Threads with a workspace that Press has seen, so a settings change can republish their composer config. */
  private readonly seenThreads = new Map<string, WorkspaceRef>();

  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: PressStore,
    private readonly now: () => number = Date.now,
    private readonly getSettings: () => Promise<Record<string, unknown>> = async () => ({}),
  ) {}

  register(): void {
    this.bb.events.on("thread.active", ({ thread }) => this.invalidateStatus(thread.id));
    this.bb.events.on("thread.idle", ({ thread }) => {
      this.store.bumpTurns(thread.id);
      void this.evaluate(thread.id, { origin: "idle", thread })
        .catch((error) => this.warn(`evaluate ${thread.id} failed`, error))
        .finally(() => this.invalidateStatus(thread.id));
    });
    this.bb.events.on("thread.failed", ({ thread, error }) => {
      void this.failPending(thread, error ?? "thread failed").catch((error) => this.warn(`settle ${thread.id} failed`, error));
    });
    this.bb.events.on("experimental_thread.events", ({ thread }) => this.onThreadEvents(thread));
    this.bb.events.on("message.queued", ({ entry }) => this.trackQueued(entry));
    this.bb.events.on("message.dispatched", ({ entry }) => this.untrackQueued(entry));
    this.bb.events.on("message.cancelled", ({ entry }) => this.untrackQueued(entry));
    this.bb.experimental_hooks.on("message.dispatch", (context) => this.onDispatch(context));
  }

  async sweepLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await sleep(SWEEP_INTERVAL_MS, signal);
      if (signal.aborted) break;
      await this.sweep().catch((error) => this.warn("sweep failed", error));
    }
  }

  /**
   * The low-frequency path. Threads with a pending compaction settle; recently updated threads pick
   * up landings and boundaries; idle threads past the gate of their own policy are evaluated, reusing
   * the timeline signals while the thread has not changed.
   */
  async sweep(): Promise<void> {
    const now = this.now();
    this.store.pruneHints(now - HINT_TTL_MS);
    this.store.pruneDecisions(now - DECISION_TTL_MS);
    for (const [threadId, hold] of [...this.holds]) {
      if (now - hold.since >= HOLD_MAX_MS) this.lapseHold(threadId, hold);
    }
    const threads = (await this.bb.sdk.threads.list({ limit: 200 })) as unknown as ThreadInfo[];
    const seen = new Map<string, number>();
    let evaluated = 0;
    for (const thread of threads) {
      if (thread.archivedAt != null) continue;
      seen.set(thread.id, thread.updatedAt);
      try {
        if (await this.sweepThread(thread, evaluated < SWEEP_MAX_EVALUATIONS)) evaluated += 1;
      } catch (error) {
        this.warn(`sweep ${thread.id} failed`, error);
      }
    }
    this.sweepSeen.clear();
    for (const [id, updatedAt] of seen) this.sweepSeen.set(id, updatedAt);
  }

  /** Returns whether the thread was evaluated. */
  private async sweepThread(thread: ThreadInfo, mayEvaluate: boolean): Promise<boolean> {
    const now = this.now();
    if (mayEvaluate && !threadRunning(thread.status) && (await this.sweepGate(thread))) {
      await this.evaluate(thread.id, { origin: "sweep", thread });
      return true;
    }
    const changed = this.sweepSeen.get(thread.id) !== thread.updatedAt && thread.updatedAt >= now - RECENT_MS;
    if (changed || this.needsSync(thread.id)) await this.syncThread(thread.id, { thread });
    return false;
  }

  /** Whether an idle thread could act now: past its policy's gate, above the floor or the hard window, on an enabled provider. */
  private async sweepGate(thread: ThreadInfo): Promise<boolean> {
    const usage = await this.loadUsage(thread.id);
    if (usage === null || usage.modelContextWindow <= 0) return false;
    const percent = (usage.usedTokens / usage.modelContextWindow) * 100;
    const policy = await this.cachedPolicy(thread.id, await this.workspaceOf(thread), SWEEP_POLICY_CACHE_MS);
    if (!providerEnabled(policy, thread.providerId) || percent < gatePercent(policy)) return false;
    // Below the floor every point but the hard window is vetoed.
    return !(policy.vetoes.belowFloor && usage.usedTokens < policy.window.floorTokens && percent < policy.window.hardPercent);
  }

  private invalidateStatus(threadId: string): void {
    this.bb.rpc.experimental_invalidate([`status:${threadId}`]);
  }

  private warn(message: string, error: unknown): void {
    this.bb.log.warn(`${message}: ${messageOf(error)}`);
  }

  private recheckHeld(): void {
    void this.bb.experimental_hooks.recheck("message.dispatch").catch((error) => this.warn("dispatch recheck failed", error));
  }

  // --- The one history: landings, failures, boundaries and composer reports -------------------

  /** Whether the thread has something the events path settles: a compaction pending, starting or held. */
  private needsUrgentSync(threadId: string): boolean {
    return this.starting.has(threadId) || this.holds.has(threadId) || this.store.pendingCompactions(threadId).length > 0;
  }

  private needsSync(threadId: string): boolean {
    const now = this.now();
    return (
      this.needsUrgentSync(threadId) ||
      this.store.unanchoredCompactions(threadId, now - RECENT_MS).some((row) => this.anchorable(row)) ||
      this.store.awaitingComposer(threadId, now - COMPOSER_WAIT_MS).length > 0 ||
      this.store.missingTokensAfter(threadId, now - COMPOSER_WAIT_MS).length > 0
    );
  }

  private anchorable(row: CompactionRow): boolean {
    return (this.anchorAttempts.get(row.id)?.count ?? 0) < MAX_ANCHOR_ATTEMPTS;
  }

  private onThreadEvents(thread: ThreadInfo): void {
    try {
      const now = this.now();
      const running = threadRunning(thread.status);
      if (running && now - (this.runningInvalidatedAt.get(thread.id) ?? 0) >= RUNNING_INVALIDATE_MS) {
        capped(this.runningInvalidatedAt, thread.id, now);
        this.invalidateStatus(thread.id);
      }
      // A running thread is also checked, at the slow rate, for a landing nobody requested (pi's own threshold).
      if (!running && !this.needsSync(thread.id)) return;
      const interval = this.needsUrgentSync(thread.id) ? EVENTS_SYNC_MS : EVENTS_SYNC_SLOW_MS;
      const wait = (this.syncedAt.get(thread.id) ?? 0) + interval - now;
      if (wait <= 0) {
        capped(this.syncedAt, thread.id, now);
        void this.syncThread(thread.id, { thread }).catch((error) => this.warn(`sync ${thread.id} failed`, error));
      } else if (!this.syncTimers.has(thread.id)) {
        // Trailing edge: the last burst of events before a quiet thread still gets its sync.
        const timer = setTimeout(() => {
          this.syncTimers.delete(thread.id);
          capped(this.syncedAt, thread.id, this.now());
          void this.syncThread(thread.id, {}).catch((error) => this.warn(`sync ${thread.id} failed`, error));
        }, wait);
        timer.unref?.();
        this.syncTimers.set(thread.id, timer);
      }
    } catch (error) {
      this.warn(`events for ${thread.id} failed`, error);
    }
  }

  /**
   * Bring the thread's history up to date: record landings (bb's newest compaction event, and the
   * timeline's compaction rows when the timeline is read), fail or time out pending requests, anchor
   * every unanchored row on its first message after the landing, and attach the composer's reports.
   * The timeline is read only when a request is pending or a boundary may have appeared.
   */
  async syncThread(threadId: string, options: { thread?: ThreadInfo; rows?: readonly unknown[] }): Promise<void> {
    const now = this.now();
    const cutoff = now - RECENT_MS;
    let changed = false;
    let settled = false;
    const note = (result: { kind: string; changed: boolean }) => {
      if (result.changed) changed = true;
      if (result.kind === "settled") settled = true;
    };

    try {
      const [event] = await this.bb.sdk.threads.events.list({ threadId, types: ["thread/compacted"], limit: "1", order: "desc" });
      if (event !== undefined && event.createdAt >= cutoff) {
        note(this.store.recordLanding(threadId, { startedAt: event.createdAt, finishedAt: event.createdAt }));
      }
    } catch (error) {
      this.warn(`compaction events of ${threadId} failed`, error);
    }

    const thread = options.thread ?? (await this.getThread(threadId).catch(() => null));
    const unanchored = this.store.unanchoredCompactions(threadId, cutoff).filter((row) => this.anchorable(row));
    const anchorDue = unanchored.some((row) => this.anchorAttempts.get(row.id)?.updatedAt !== thread?.updatedAt);
    if (options.rows !== undefined || this.store.pendingCompactions(threadId).length > 0 || anchorDue) {
      const rows = options.rows ?? (await this.loadTimelineRows(threadId));
      for (const operation of completedCompactions(rows)) {
        if (operation.finishedAt >= cutoff) note(this.store.recordLanding(threadId, operation));
      }
      const failures = [...failedCompactions(rows)];
      for (const pending of this.store.pendingCompactions(threadId)) {
        const after = failures.filter((failure) => failure.startedAt >= pending.requestedAt);
        if (after.length === 0) continue;
        const failedAt = Math.max(...after.map((failure) => failure.failedAt));
        if (this.store.failCompaction(pending.id, "failed", failedAt, "the compaction failed")) {
          settled = changed = true;
          this.bb.log.warn(`compaction of ${threadId} failed in the provider`);
        }
      }
      for (const row of this.store.unanchoredCompactions(threadId, cutoff)) {
        if (row.landedAt === null || !this.anchorable(row)) continue;
        const boundary = pickBoundary(rows, row.landedAt);
        if (boundary !== null && this.store.setBoundary(row.id, boundary)) {
          changed = true;
          this.anchorAttempts.delete(row.id);
        } else {
          const attempts = this.anchorAttempts.get(row.id);
          capped(this.anchorAttempts, row.id, { updatedAt: thread?.updatedAt ?? 0, count: (attempts?.count ?? 0) + 1 });
        }
      }
    }

    if (this.expireStalePending(threadId)) settled = changed = true;

    // pi reports no usage to the composer until an assistant answers after a compaction, so the size
    // after it comes from bb's first real reading after the landing, on whichever sync sees one.
    const missing = this.store.missingTokensAfter(threadId, now - COMPOSER_WAIT_MS);
    if (missing.length > 0) {
      const usage = await this.loadUsage(threadId);
      if (usage !== null && !usage.estimated) {
        for (const row of missing) {
          if (this.store.fillTokensAfter(row.id, usage.usedTokens)) changed = true;
        }
      }
    }

    if (thread !== null && this.store.awaitingComposer(threadId, now - COMPOSER_WAIT_MS).length > 0) {
      if (await this.attachComposerReports(threadId, thread)) changed = true;
    }

    if (changed) this.invalidateStatus(threadId);
    if (settled && this.holds.has(threadId) && !this.needsUrgentSyncExceptHold(threadId)) this.recheckHeld();
  }

  /** Give up requests pending longer than `PENDING_TTL_MS`; synchronous, so the dispatch hook can call it. */
  private expireStalePending(threadId: string): boolean {
    const now = this.now();
    let expired = false;
    for (const pending of this.store.pendingCompactions(threadId)) {
      if (now - pending.requestedAt <= PENDING_TTL_MS) continue;
      if (this.store.failCompaction(pending.id, "cancelled", now, "pending compaction timed out")) {
        expired = true;
        this.bb.log.warn(`compaction of ${threadId} did not land within ${PENDING_TTL_MS / 60_000} minutes; given up`);
      }
    }
    if (expired) this.invalidateStatus(threadId);
    return expired;
  }

  private needsUrgentSyncExceptHold(threadId: string): boolean {
    return this.starting.has(threadId) || this.store.pendingCompactions(threadId).length > 0;
  }

  private async attachComposerReports(threadId: string, thread: ThreadInfo): Promise<boolean> {
    const workspace = await this.workspaceOf(thread);
    if (workspace === null) return false;
    let path: string;
    try {
      path = ledgerPath(workspace.path, threadId);
    } catch (error) {
      this.warn(`ledger path for ${threadId}`, error);
      return false;
    }
    const ledger = await readLedger(this.ledgerIo(workspace), path);
    if (ledger === null) return false;
    let changed = false;
    for (const row of composerRows(ledger)) {
      const at = row.finishedAt ?? Date.parse(row.at);
      if (!Number.isFinite(at)) continue;
      const attached = this.store.attachComposer(threadId, {
        id: row.id,
        at,
        tokensBefore: row.tokensBefore,
        tokensAfter: row.tokensAfter,
        model: row.model,
        ms: row.ms,
        summaryPath: summaryFilePath(workspace.path, threadId, row),
      });
      if (attached !== null) changed = true;
    }
    return changed;
  }

  /** The thread errored: a request still pending after a final check for its landing failed with it. */
  async failPending(thread: ThreadInfo, error: string): Promise<void> {
    if (this.store.pendingCompactions(thread.id).length === 0) return;
    await this.syncThread(thread.id, { thread });
    let settled = false;
    for (const pending of this.store.pendingCompactions(thread.id)) {
      if (this.store.failCompaction(pending.id, "failed", this.now(), error)) settled = true;
    }
    if (!settled) return;
    this.bb.log.warn(`compaction of ${thread.id} failed with the thread: ${error}`);
    this.invalidateStatus(thread.id);
    if (this.holds.has(thread.id)) this.recheckHeld();
  }

  // --- Policy, workspace and the composer config ------------------------------------------------

  /** Resolve the policy for one thread: defaults, dataDir policy, workspace policy, settings, override. */
  async policyFor(threadId: string, workspace: WorkspaceRef | null): Promise<Policy> {
    const layers: PolicyLayer[] = [];
    const dataDir = this.bb.server.experimental_dataDir;
    let userPolicy: string | null = null;
    try {
      userPolicy = await readFile(join(dataDir, "press", "policy.json"), "utf8");
    } catch {
      // No user policy; the defaults carry.
    }
    // One reporter serves a skipped layer, a clamped value and a dropped name, so it names none of them.
    // Every status read and sweep resolves the policy, so each source is reported only when its message changes.
    const report = (source: string, issues: readonly string[]) => {
      const message = issues.join("; ");
      if (this.reported.get(source) === message) return;
      capped(this.reported, source, message);
      this.bb.log.warn(`press policy: ${source}: ${message}`);
    };
    const parse = (source: string, text: string): void => {
      try {
        layers.push({ source, value: JSON.parse(text) });
      } catch (error) {
        report(source, [messageOf(error)]);
      }
    };
    if (userPolicy !== null) parse(`${dataDir}/press/policy.json`, userPolicy);
    if (workspace !== null) {
      const policy = await this.readFileFor(workspace, ".bb/press/policy.json");
      if (policy !== null) parse(`workspace ${workspace.path}`, policy);
    }
    let override: PolicyLayer | null = null;
    const stored = this.store.threadPolicyOverride(threadId);
    if (stored !== null) {
      try {
        override = { source: `thread ${threadId} override`, value: JSON.parse(stored) };
      } catch {
        this.bb.log.warn(`press policy: ignoring unreadable per-thread override for ${threadId}`);
      }
    }
    // A bad file or override layer is skipped with a warning; the rest still resolve. The settings
    // layer is trusted: the settings schema already validated every value at write time.
    const settings: PressSettings = normalizeSettings(await this.getSettings(), report);
    const policy = resolvePressPolicy(layers, settings, override, report);
    capped(this.policies, threadId, { at: this.now(), workspace: workspace?.path ?? null, policy });
    return policy;
  }

  /**
   * A resolution for the same workspace no older than `maxAgeMs`, or a fresh one. Every evaluation and
   * status read refreshes it, and every policy change through Press drops it.
   */
  private async cachedPolicy(threadId: string, workspace: WorkspaceRef | null, maxAgeMs: number): Promise<Policy> {
    const cached = this.policies.get(threadId);
    if (cached !== undefined && this.now() - cached.at < maxAgeMs && cached.workspace === (workspace?.path ?? null)) return cached.policy;
    return this.policyFor(threadId, workspace);
  }

  /** A policy file changed (the CLI wrote or removed one): drop every cached resolution and refresh every status. */
  forgetPolicies(): void {
    this.policies.clear();
    this.reported.clear();
    this.bb.rpc.experimental_invalidateAll();
  }

  /** Replace or clear the thread's raw policy override, as `bb press policy set --thread` does. */
  setThreadOverride(threadId: string, json: string | null): void {
    this.store.setThreadPolicyOverride(threadId, json);
    this.policies.delete(threadId);
    this.invalidateStatus(threadId);
  }

  /** Settings changed: drop cached policies and republish the composer config of every known thread whose config changed. */
  async republishComposerConfigs(): Promise<void> {
    this.policies.clear();
    this.reported.clear();
    for (const [threadId, workspace] of [...this.seenThreads]) {
      try {
        await this.publishComposerConfig(threadId, workspace, await this.policyFor(threadId, workspace));
      } catch (error) {
        this.warn(`composer config republish for ${threadId} failed`, error);
      }
    }
  }

  /** Write the thread's composer config (I-4), so the pi half sees the resolved settings; skipped when unchanged. */
  private async publishComposerConfig(threadId: string, workspace: WorkspaceRef, policy: Policy): Promise<void> {
    capped(this.seenThreads, threadId, workspace);
    const config = {
      model: policy.composer.model,
      maxSummaryTokens: policy.composer.maxSummaryTokens,
      ledger: policy.composer.ledger,
      resumeContract: policy.composer.resumeContract,
    };
    const key = JSON.stringify({ root: workspace.path, ...config });
    if (this.published.get(threadId) === key) return;
    await writeComposerConfig(this.ledgerIo(workspace), composerConfigPath(workspace.path, threadId), {
      ...config,
      updatedAt: new Date(this.now()).toISOString(),
    });
    capped(this.published, threadId, key);
  }

  private async readFileFor(workspace: WorkspaceRef, relative: string): Promise<string | null> {
    return this.ledgerIo(workspace).read(`${workspace.path.replace(/[/\\]+$/, "")}/${relative}`);
  }

  private async getThread(threadId: string): Promise<ThreadInfo> {
    return (await this.bb.sdk.threads.get({ threadId })) as unknown as ThreadInfo;
  }

  /**
   * The thread's workspace, from its environment; cached because environments rarely move. The
   * dispatch hook takes a cached answer of any age (`stale`): it runs under core's dispatch lock.
   */
  private async workspaceOf(thread: Pick<ThreadInfo, "environmentId">, options: { stale?: boolean } = {}): Promise<WorkspaceRef | null> {
    const environmentId = thread.environmentId;
    if (environmentId == null) return null;
    const cached = this.workspaces.get(environmentId);
    if (cached !== undefined && (options.stale === true || this.now() - cached.at < WORKSPACE_CACHE_MS)) return cached.ref;
    try {
      const environment = asRecord(await this.bb.sdk.environments.get({ environmentId }));
      const hostId = typeof environment.hostId === "string" ? environment.hostId : null;
      const path = typeof environment.path === "string" ? environment.path : null;
      const ref = path !== null ? { hostId, path } : null;
      capped(this.workspaces, environmentId, { at: this.now(), ref });
      return ref;
    } catch (error) {
      this.warn(`environment ${environmentId} lookup failed`, error);
      return null;
    }
  }

  async workspaceOfThread(threadId: string): Promise<WorkspaceRef | null> {
    try {
      return await this.workspaceOf(await this.getThread(threadId));
    } catch (error) {
      this.warn(`workspace of ${threadId} failed`, error);
      return null;
    }
  }

  /** File operations against the thread's workspace, through `bb.sdk.files` so remote hosts work. */
  ledgerIo(workspace: WorkspaceRef): LedgerIo {
    const files = this.bb.sdk.files;
    const routing = workspace.hostId !== null ? { hostId: workspace.hostId } : {};
    const read = async (path: string): Promise<string | null> => {
      try {
        const result = (await files.read({ path, ...routing })) as unknown as { content: string; contentEncoding?: string };
        if (result.contentEncoding === "base64") return Buffer.from(result.content, "base64").toString("utf8");
        return result.content;
      } catch {
        return null;
      }
    };
    return {
      read,
      write: async (path, content) => {
        await files.write({ path, content, ...routing, createParents: true });
      },
      rename: async (from, to) => {
        // The host refuses to move onto an existing path, but a conditional write replaces a file
        // atomically (temp file and rename on the host), so the staged content is written over it.
        try {
          const content = await read(from);
          if (content === null) throw new Error(`staged file ${from} is missing`);
          const current = await read(to);
          const write = (expectedSha256: string | null) =>
            files.write({ path: to, content, ...routing, createParents: true, expectedSha256 });
          let result = await write(current === null ? null : createHash("sha256").update(current).digest("hex"));
          if (result.outcome === "conflict") result = await write(result.currentSha256);
          if (result.outcome !== "written") throw new Error(`${to} changed while Press replaced it`);
        } finally {
          await files.remove({ path: from, ...routing }).catch(() => undefined);
        }
      },
      mkdir: async (path) => {
        await files.mkdir({ path, ...routing, recursive: true });
      },
    };
  }

  // --- Evaluating and acting --------------------------------------------------------------------

  /** Whether a compaction of the thread is starting or pending; a pending row past its time to live is given up first. */
  private busy(threadId: string): boolean {
    this.expireStalePending(threadId);
    return this.starting.has(threadId) || this.store.pendingCompactions(threadId).length > 0;
  }

  /** Claim the right to start a compaction; false when one is already starting or pending. Synchronous. */
  private reserve(threadId: string, point: string | null): boolean {
    if (this.busy(threadId)) return false;
    this.starting.set(threadId, { at: this.now(), point });
    return true;
  }

  private release(threadId: string): void {
    this.starting.delete(threadId);
    this.invalidateStatus(threadId);
    if (this.holds.has(threadId) && this.store.pendingCompactions(threadId).length === 0) this.recheckHeld();
  }

  /**
   * Request the compaction the caller reserved. The thread is read again first: Press only ever
   * compacts a thread that is not running a turn. A refusal is recorded as a failed attempt, which
   * starts the backoff.
   */
  private async requestReserved(
    threadId: string,
    input: { decisionId: string; policy: Policy; workspace: WorkspaceRef | null; point: string | null; reason: string | null; tokens: number | null },
  ): Promise<CompactResult | { ok: false; error: string; method: "refused" }> {
    const current = await this.getThread(threadId);
    if (threadRunning(current.status)) {
      this.store.setDecisionOutcome(input.decisionId, "cancelled", this.now(), "the thread was no longer idle");
      return { ok: false, error: "Wait until the thread is idle before compacting.", method: "refused" };
    }
    if (input.workspace !== null) {
      await this.publishComposerConfig(threadId, input.workspace, input.policy)
        .catch((error) => this.warn(`composer config publish for ${threadId} failed`, error));
    }
    const now = this.now();
    const result = await requestCompaction(this.bb, this.store, {
      threadId,
      decisionId: input.decisionId,
      providerId: current.providerId,
      policy: input.policy,
      mode: input.policy.mode,
      now,
      tokensBefore: input.tokens,
      point: input.point,
      reason: input.reason,
    });
    if (result.method === "skip") {
      this.store.setDecisionOutcome(input.decisionId, "cancelled", now, result.error);
    } else if (!result.ok) {
      // requestCompaction already logged the refusal with the provider's message.
      this.store.failCompaction(result.compactionId, "failed", this.now(), result.error);
    }
    return result;
  }

  /** The timeline signals, reused while the thread has not changed since they were read. */
  private async signalsFor(threadId: string, thread: ThreadInfo, since: number | null, rows?: readonly unknown[]): Promise<{ value: SignalDerivation; rows?: readonly unknown[] }> {
    const cached = this.signals.get(threadId);
    if (rows === undefined && cached !== undefined && cached.updatedAt === thread.updatedAt && cached.since === since) return { value: cached.value };
    const loaded = rows ?? (await this.loadTimelineRows(threadId));
    const value = scanTimeline(loaded, since);
    capped(this.signals, threadId, { updatedAt: thread.updatedAt, since, value });
    return { value, rows: loaded };
  }

  private cachedSignals(threadId: string, thread: ThreadInfo, since: number | null): SignalDerivation | null {
    const cached = this.signals.get(threadId);
    return cached !== undefined && cached.updatedAt === thread.updatedAt && cached.since === since ? cached.value : null;
  }

  private decideInput(input: {
    policy: Policy;
    thread: Pick<ThreadInfo, "status" | "updatedAt">;
    usage: ThreadUsage | null;
    threadId: string;
    signals: SignalDerivation | null;
    agentHint?: boolean;
    /** Judge the thread as it will be when the running turn ends, with that turn counted. */
    turnEnding?: boolean;
  }): DecideInput {
    const now = this.now();
    const state = this.store.threadState(input.threadId);
    const since = this.store.lastLandedAt(input.threadId);
    const turnsSinceCompaction = state.turnsSince + (input.turnEnding === true ? 1 : 0);
    const base = deriveSnapshot({ usage: input.usage, thread: input.thread, now, turnsSinceCompaction, rows: [], since });
    const snapshot = input.signals !== null ? { ...base, ...input.signals } : base;
    const hinted = input.agentHint === true || this.store.pendingHints(input.threadId).length > 0;
    // A boundary fires once: only work that finished after the last attempt and after the last decision it fired.
    const used = this.signalUseOf(input.threadId);
    const attemptAt = state.lastCompactionAt ?? -Infinity;
    const boundaries = snapshot.phaseSignals
      .filter(({ signal, at }) => at > attemptAt && at > (used.get(signal) ?? -Infinity))
      .map(({ signal }) => signal);
    return {
      policy: input.policy,
      snapshot,
      now,
      lastCompaction: state.lastCompactionAt !== null ? { at: state.lastCompactionAt, failed: state.lastCompactionFailed } : null,
      recentSignals: [...new Set(boundaries), ...(hinted ? ["agentHint"] : [])],
      msPerToken: msPerTokenOf(this.store.compactionsOf(input.threadId, HISTORY_LIMIT)),
    };
  }

  private signalUseOf(threadId: string): Map<string, number> {
    const used = this.store.lastCompactDecisions(threadId);
    for (const [signal, at] of this.signalUse.get(threadId) ?? []) used.set(signal, Math.max(used.get(signal) ?? at, at));
    return used;
  }

  /** A compact decision answered the boundary signal that fired it, even when the decision log did not repeat it. */
  private markSignalUsed(threadId: string, decision: Decision): void {
    if (decision.decision !== "compact" || decision.reason === null) return;
    const used = this.signalUse.get(threadId) ?? new Map<string, number>();
    used.set(decision.reason, this.now());
    capped(this.signalUse, threadId, used);
  }

  /** Evaluate one thread: bring its history up to date, decide, record, and act when the mode says to. */
  async evaluate(threadId: string, options: EvaluateOptions): Promise<EvaluateResult> {
    const thread = options.thread ?? (await this.getThread(threadId));
    const workspace = await this.workspaceOf(thread);
    const policy = await this.policyFor(threadId, workspace);
    const mode = policy.mode;
    if (workspace !== null) {
      await this.publishComposerConfig(threadId, workspace, policy)
        .catch((error) => this.warn(`composer config publish for ${threadId} failed`, error));
    }

    // Read the timeline once, only when the cached signals are stale, and hand it to the sync too.
    const sinceBefore = this.store.lastLandedAt(threadId);
    let rows: readonly unknown[] | undefined;
    if (this.cachedSignals(threadId, thread, sinceBefore) === null) rows = await this.loadTimelineRows(threadId);
    await this.syncThread(threadId, { thread, rows }).catch((error) => this.warn(`sync ${threadId} failed`, error));
    const since = this.store.lastLandedAt(threadId);
    const { value: signals } = await this.signalsFor(threadId, thread, since, rows);

    const usage = await this.loadUsage(threadId);
    let input = this.decideInput({ policy, thread, usage, threadId, signals, agentHint: options.agentHint });
    if (options.forcePoint !== undefined) {
      input = {
        ...input,
        policy: {
          ...policy,
          points: [
            { id: options.forcePoint, enabled: true, when: "agentHint" },
            ...policy.points.filter((point) => point.id !== options.forcePoint),
          ],
        },
        recentSignals: [...input.recentSignals, "agentHint"],
      };
    }

    const decision = decide(input);
    const next = nextCandidate(input);
    if (decision.decision === "skip") return { decision, decisionId: null, mode, acted: false, next };
    if (!providerEnabled(policy, thread.providerId)) return { decision, decisionId: null, mode, acted: false, next, error: PROVIDER_OFF };

    const acting = decision.decision === "compact" && mode === "auto" && options.dryRun !== true;
    // Checked before any row is written, so a thread waiting on its compaction writes nothing.
    if (acting && !this.reserve(threadId, decision.point)) {
      return { decision, decisionId: null, mode, acted: false, next, error: "A compaction is already in progress." };
    }
    try {
      const now = this.now();
      const { row, inserted } = acting
        ? { row: this.store.recordDecision({ at: now, threadId, decision, mode, origin: options.origin }), inserted: true }
        : this.store.noteDecision({ at: now, threadId, decision, mode, origin: options.origin });
      if (options.dryRun !== true) this.markSignalUsed(threadId, decision);
      // A hint is answered by a compaction or a proposal; any veto but midTurn (which ends with the turn) drops it.
      if (options.dryRun !== true && decision.point === "agent" && (decision.decision === "compact" || decision.reason !== "midTurn")) {
        this.store.consumeHints(this.store.pendingHints(threadId).map((hint) => hint.id));
      }
      if (inserted || options.origin === "cli") this.logDecision(threadId, decision, mode, options.dryRun === true);
      if (!acting) {
        this.invalidateStatus(threadId);
        return { decision, decisionId: row.id, mode, acted: false, next };
      }
      const result = await this.requestReserved(threadId, {
        decisionId: row.id, policy, workspace, point: decision.point, reason: decision.reason, tokens: decision.tokens,
      });
      if (result.ok) {
        this.bb.log.info(
          `compaction requested for ${threadId} (point ${decision.point}, ` +
            `${decision.percent !== null ? decision.percent.toFixed(0) : "?"}%, est ${decision.estMs}ms)`,
        );
      }
      return { decision, decisionId: row.id, mode, acted: result.ok, next, ...(result.ok ? {} : { error: result.error ?? undefined }) };
    } finally {
      if (acting) this.release(threadId);
    }
  }

  private logDecision(threadId: string, decision: Decision, mode: string, dryRun: boolean): void {
    const where = `${threadId} at ${decision.percent !== null ? `${decision.percent.toFixed(0)}%` : "?"} (${decision.tokens ?? "?"} tokens)`;
    if (decision.decision === "veto") {
      this.bb.log.info(`veto ${decision.point} on ${where}: ${decision.reason}`);
    } else if (mode !== "auto" || dryRun) {
      const verb = dryRun ? "dry-run" : mode === "observe" ? "observed" : "proposes";
      this.bb.log.info(`${verb}: compact ${threadId} (${decision.point}, ${decision.reason ?? ""}) on ${where}, est ${decision.estMs}ms`);
    }
  }

  private async loadUsage(threadId: string): Promise<ThreadUsage | null> {
    try {
      const response = asRecord(await this.bb.sdk.threads.context({ threadId }));
      const usage = asRecord(response.usage);
      const window = typeof usage.modelContextWindow === "number" ? usage.modelContextWindow : null;
      const tokens = typeof usage.usedTokens === "number" ? usage.usedTokens : null;
      if (window === null || tokens === null) return null;
      return { estimated: usage.estimated === true, modelContextWindow: window, usedTokens: tokens };
    } catch {
      return null;
    }
  }

  private async loadTimelineRows(threadId: string): Promise<unknown[]> {
    try {
      const response = await this.bb.sdk.threads.timeline({ threadId, includeNestedRows: "true" });
      return "rows" in response && Array.isArray(response.rows) ? response.rows : [];
    } catch (error) {
      this.warn(`timeline of ${threadId} failed`, error);
      return [];
    }
  }

  // --- The next-turn hold -------------------------------------------------------------------------

  private trackQueued(entry: QueuedEntry): void {
    if (entry.waitingOn?.kind !== "plugin" || entry.waitingOn.pluginId !== this.bb.pluginId) return;
    const set = this.heldEntries.get(entry.threadId) ?? new Set<string>();
    set.add(entry.id);
    capped(this.heldEntries, entry.threadId, set);
    const hold = this.holds.get(entry.threadId);
    if (hold !== undefined && set.size > hold.count) {
      hold.count = set.size;
      this.invalidateStatus(entry.threadId);
    }
  }

  private untrackQueued(entry: QueuedEntry): void {
    const set = this.heldEntries.get(entry.threadId);
    if (set === undefined || !set.delete(entry.id)) return;
    if (set.size === 0) this.heldEntries.delete(entry.threadId);
    const hold = this.holds.get(entry.threadId);
    if (hold !== undefined) {
      if (set.size === 0) this.holds.delete(entry.threadId);
      else hold.count = set.size;
      this.invalidateStatus(entry.threadId);
    }
  }

  private lapseHold(threadId: string, hold: Hold): void {
    this.holds.delete(threadId);
    capped(this.lapsedHolds, threadId, hold.key);
    this.bb.log.warn(`press: released ${threadId}'s next turn after ${HOLD_MAX_MS / 60_000} minutes without a landing`);
    this.invalidateStatus(threadId);
    this.recheckHeld();
  }

  private wait(threadId: string, key: string, queued: number): MessageDispatchHookDecision {
    const now = this.now();
    const existing = this.holds.get(threadId);
    const count = Math.max(1, queued, this.heldEntries.get(threadId)?.size ?? 0);
    if (existing === undefined || existing.key !== key && existing.key !== "starting") {
      this.holds.set(threadId, { since: existing?.since ?? now, count, key });
      this.invalidateStatus(threadId);
    } else {
      existing.key = key;
      if (count !== existing.count) {
        existing.count = count;
        this.invalidateStatus(threadId);
      }
    }
    return { action: "wait", reason: HOLD_REASON, sendAt: now + HOLD_RETRY_MS };
  }

  /**
   * The `message.dispatch` hook. A turn about to start on a thread Press is compacting waits until
   * the compaction lands, fails or `HOLD_MAX_MS` passes; in auto mode, a turn about to start on a
   * thread where a point fires waits while Press compacts first. It never throws and answers within
   * `DISPATCH_TIMEOUT_MS`, proceeding otherwise, because core fails the user's message on either.
   */
  async onDispatch(context: MessageDispatchHookContext): Promise<MessageDispatchHookDecision> {
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = this.dispatchDecision(context, () => expired).catch((error) => {
        this.warn(`dispatch check for ${context.thread.id} failed`, error);
        return PROCEED;
      });
      const timeout = new Promise<MessageDispatchHookDecision>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          this.bb.log.warn(`press: dispatch check for ${context.thread.id} took over ${DISPATCH_TIMEOUT_MS}ms; proceeding`);
          resolve(PROCEED);
        }, DISPATCH_TIMEOUT_MS);
      });
      return await Promise.race([work, timeout]);
    } catch (error) {
      this.warn("dispatch check failed", error);
      return PROCEED;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async dispatchDecision(context: MessageDispatchHookContext, expired: () => boolean): Promise<MessageDispatchHookDecision> {
    if (context.attempt !== "start-turn") return PROCEED;
    const thread = context.thread;
    if (thread.status === "pending") return PROCEED;
    const threadId = thread.id;
    const queued = context.queuedMessages.length;

    this.expireStalePending(threadId);
    const pending = this.store.pendingCompactions(threadId)[0];
    if (pending !== undefined || this.starting.has(threadId)) {
      const key = pending?.id ?? "starting";
      if (this.lapsedHolds.get(threadId) === key) return PROCEED;
      const hold = this.holds.get(threadId);
      if (hold !== undefined && this.now() - hold.since >= HOLD_MAX_MS) {
        this.lapseHold(threadId, { ...hold, key });
        return PROCEED;
      }
      return this.wait(threadId, key, queued);
    }
    this.lapsedHolds.delete(threadId);
    // The message was held for a compaction that has now landed, failed or never started: it goes.
    // Deciding again could hold it for another compaction, and a cause that keeps vanishing would loop.
    if (this.holds.delete(threadId)) {
      this.invalidateStatus(threadId);
      return PROCEED;
    }
    if (threadRunning(thread.status)) return PROCEED;

    // Core runs this hook under one server-wide lock, so it reads no policy file once the thread's
    // policy is cached: every evaluation and status read refreshes it, and every change drops it.
    const workspace = await this.workspaceOf(thread, { stale: true });
    const policy = await this.cachedPolicy(threadId, workspace, Infinity);
    if (policy.mode !== "auto" || !providerEnabled(policy, thread.providerId)) return PROCEED;
    const usage = await this.loadUsage(threadId);
    const since = this.store.lastLandedAt(threadId);
    const signals = this.cachedSignals(threadId, thread, since);
    if (signals === null && this.waitForSignals(thread, policy, usage, since)) {
      return { action: "wait", reason: SIGNALS_WAIT_REASON, sendAt: this.now() + SIGNALS_WAIT_MS };
    }
    const input = this.decideInput({ policy, thread, usage, threadId, signals });
    const decision = decide(input);
    if (decision.decision !== "compact" || expired()) return PROCEED;
    if (!this.reserve(threadId, decision.point)) return this.wait(threadId, "starting", queued);

    const row = this.store.recordDecision({ at: this.now(), threadId, decision, mode: policy.mode, origin: "dispatch" });
    this.markSignalUsed(threadId, decision);
    if (decision.point === "agent") this.store.consumeHints(this.store.pendingHints(threadId).map((hint) => hint.id));
    this.bb.log.info(`press: holding ${threadId}'s next turn to compact first (point ${decision.point}, ${decision.reason ?? ""})`);
    const answer = this.wait(threadId, "starting", queued);
    void this.requestReserved(threadId, {
      decisionId: row.id, policy, workspace, point: decision.point, reason: decision.reason, tokens: decision.tokens,
    })
      .catch((error) => {
        this.store.setDecisionOutcome(row.id, "failed", this.now(), messageOf(error));
        this.warn(`compaction of ${threadId} before its next turn failed`, error);
      })
      .finally(() => this.release(threadId));
    return answer;
  }

  /**
   * A message drained as the turn ended, before the turn's end read the timeline, so the phase,
   * volume and thrash points cannot see that turn yet. When one of them could fire, read the timeline
   * in the background and ask core to try again in a moment; once per thread change, so it never loops.
   */
  private waitForSignals(thread: ThreadInfo, policy: Policy, usage: ThreadUsage | null, since: number | null): boolean {
    if (usage === null || usage.modelContextWindow <= 0) return false;
    const percent = (usage.usedTokens / usage.modelContextWindow) * 100;
    const gate = timelineGatePercent(policy);
    if (gate === null || percent < gate || percent >= policy.window.hardPercent) return false;
    if (policy.vetoes.belowFloor && usage.usedTokens < policy.window.floorTokens) return false;
    if (this.signalWaits.get(thread.id) === thread.updatedAt) return false;
    capped(this.signalWaits, thread.id, thread.updatedAt);
    void this.signalsFor(thread.id, thread, since)
      .then(() => this.recheckHeld())
      .catch((error) => this.warn(`timeline signals of ${thread.id} failed`, error));
    return true;
  }

  // --- Status and controls --------------------------------------------------------------------------

  /**
   * The one status builder: `bb press status --json` and the `status` RPC both call it, so the UI
   * and the CLI never disagree. It costs a thread read, a context read, the policy resolution (the
   * user policy file, the workspace policy file through the host, the settings; the environment read
   * is cached) and SQLite queries. It never reads the timeline or a ledger, and it writes nothing.
   */
  async buildThreadStatus(threadId: string): Promise<ThreadStatusDto> {
    const now = this.now();
    const thread = await this.getThread(threadId);
    const workspace = await this.workspaceOf(thread);
    const policy = await this.policyFor(threadId, workspace);
    const usage = await this.loadUsage(threadId);
    const state = this.store.threadState(threadId);
    const signals = this.cachedSignals(threadId, thread, this.store.lastLandedAt(threadId));
    const input = this.decideInput({ policy, thread, usage, threadId, signals });
    const { snapshot } = input;
    const next = nextCandidate(input);

    const rows = this.store.compactionsOf(threadId, HISTORY_LIMIT);
    const history = rows.map(toSummary);
    const boundaries: ThreadStatusDto["boundaries"] = {};
    history.forEach(({ boundaryAt, boundaryMessageId }, index) => {
      if (boundaryAt === null) return;
      boundaries[String(boundaryAt)] ??= index;
      if (boundaryMessageId !== null) boundaries[`message:${boundaryMessageId}`] ??= index;
    });
    const landed = history.filter((row) => row.outcome === "ok");
    const timed = landed.filter((row) => row.ms !== null);
    const freed = landed.filter((row) => row.tokensBefore !== null && row.tokensAfter !== null);

    const decisions: DecisionSummary[] = this.store.decisions({ threadId, limit: 5 }).map((row) => ({
      at: new Date(row.at).toISOString(),
      point: row.point,
      decision: row.decision === "skip" ? "veto" : row.decision,
      reason: row.reason,
      percent: row.percent,
    }));

    const pending = this.store.pendingCompactions(threadId)[0];
    const starting = this.starting.get(threadId);
    const hold = this.holds.get(threadId);
    return {
      threadId,
      percent: snapshot.percent,
      tokens: snapshot.tokens,
      window: snapshot.window,
      running: threadRunning(thread.status),
      providerEnabled: providerEnabled(policy, thread.providerId),
      mode: policy.mode,
      thresholds: { softPercent: policy.window.softPercent, hardPercent: policy.window.hardPercent, floorTokens: policy.window.floorTokens },
      pointsFromPercent: pointsFromPercent(policy),
      compacting: pending !== undefined
        ? { since: new Date(pending.requestedAt).toISOString(), point: pending.point }
        : starting !== undefined ? { since: new Date(starting.at).toISOString(), point: starting.point } : null,
      held: hold !== undefined ? { since: new Date(hold.since).toISOString(), reason: HOLD_REASON, count: hold.count } : null,
      blockers: blockers(input),
      points: effectivePoints(policy),
      overrides: this.overridesOf(threadId),
      summaryModel: policy.composer.model,
      nextPoint: next?.point ?? null,
      estimateMs: snapshot.tokens !== null && snapshot.tokens > 0 ? estimateCompaction(snapshot.tokens, input.msPerToken).estMs : null,
      turnsSince: state.turnsSince,
      lastCompaction: landed[0] ?? null,
      history,
      totals: {
        count: landed.length,
        tokensFreed: freed.reduce((sum, row) => sum + Math.max(0, (row.tokensBefore ?? 0) - (row.tokensAfter ?? 0)), 0),
        averageMs: timed.length > 0 ? Math.round(timed.reduce((sum, row) => sum + (row.ms ?? 0), 0) / timed.length) : null,
      },
      boundaries,
      decisions,
    };
  }

  private overridesOf(threadId: string): ThreadStatusDto["overrides"] {
    const stored = this.store.threadPolicyOverride(threadId);
    if (stored === null) return { mode: false, points: [] };
    try {
      const value = asRecord(JSON.parse(stored));
      const points = Object.keys(asRecord(value.pointOverrides)).filter((id): id is PointId => (POINT_IDS as readonly string[]).includes(id));
      return { mode: value.mode !== undefined, points };
    } catch {
      return { mode: false, points: [] };
    }
  }

  /** The composer's summary of one compaction in the history, read from the workspace host. */
  async summary(threadId: string, compactionId: string): Promise<{ markdown: string | null }> {
    const row = this.store.compaction(compactionId);
    if (row === null || row.threadId !== threadId || row.summaryPath === null) return { markdown: null };
    const workspace = await this.workspaceOfThread(threadId);
    const io = this.ledgerIo(workspace ?? { hostId: null, path: "" });
    return { markdown: await io.read(row.summaryPath) };
  }

  async compactNow(threadId: string): Promise<{ ok: boolean; message: string }> {
    const inProgress = { ok: false, message: "A compaction is already in progress." };
    if (!this.reserve(threadId, "manual")) return inProgress;
    try {
      const thread = await this.getThread(threadId);
      const notIdle = { ok: false, message: "Wait until the thread is idle before compacting." };
      if (threadRunning(thread.status)) return notIdle;
      const workspace = await this.workspaceOf(thread);
      const policy = await this.policyFor(threadId, workspace);
      if (!providerEnabled(policy, thread.providerId)) return { ok: false, message: PROVIDER_OFF };
      await this.syncThread(threadId, { thread }).catch((error) => this.warn(`sync ${threadId} failed`, error));
      if (this.store.pendingCompactions(threadId).length > 0) return inProgress;
      const usage = await this.loadUsage(threadId);
      const tokens = usage?.usedTokens ?? null;
      const window = usage?.modelContextWindow ?? null;
      const decision: Decision = {
        decision: "compact", point: "manual", reason: "manual", tokens, window,
        percent: tokens !== null && window !== null && window > 0 ? (tokens / window) * 100 : null,
        ...estimateCompaction(tokens, msPerTokenOf(this.store.compactionsOf(threadId, HISTORY_LIMIT))),
      };
      const row = this.store.recordDecision({ at: this.now(), threadId, decision, mode: policy.mode, origin: "manual" });
      const result = await this.requestReserved(threadId, { decisionId: row.id, policy, workspace, point: "manual", reason: "manual", tokens });
      if (result.ok) return { ok: true, message: "Compaction requested." };
      return { ok: false, message: result.error ?? "The provider declined compaction." };
    } finally {
      this.release(threadId);
    }
  }

  async setThreadMode(threadId: string, mode: Policy["mode"]): Promise<{ mode: Policy["mode"] }> {
    const override = mergeThreadOverride(this.store.threadPolicyOverride(threadId), { mode });
    this.store.setThreadPolicyOverride(threadId, JSON.stringify(override));
    this.invalidateStatus(threadId);
    return { mode: (await this.policyFor(threadId, await this.workspaceOfThread(threadId))).mode };
  }

  async setThreadPoint(threadId: string, point: PointId, enabled: boolean): Promise<{ points: EffectivePoints }> {
    const override = mergeThreadOverride(this.store.threadPolicyOverride(threadId), { pointOverrides: { [point]: enabled } });
    this.store.setThreadPolicyOverride(threadId, JSON.stringify(override));
    this.invalidateStatus(threadId);
    return { points: effectivePoints(await this.policyFor(threadId, await this.workspaceOfThread(threadId))) };
  }

  /** Drop the thread's mode and point overrides so it follows the plugin settings again. */
  async resetThread(threadId: string): Promise<{ ok: true }> {
    this.store.setThreadPolicyOverride(threadId, null);
    this.policies.delete(threadId);
    this.invalidateStatus(threadId);
    return { ok: true };
  }

  /**
   * The `compaction_point` tool. It runs inside the agent's own turn, so it only records the hint;
   * the turn's end (or the next turn's dispatch) evaluates it. The reply says what will happen then.
   */
  async compactionPoint(threadId: string, note = ""): Promise<string> {
    this.store.recordHint({ threadId, at: this.now(), reason: note.trim() !== "" ? note.trim() : "agent hint (tool)" });
    this.invalidateStatus(threadId);
    try {
      const thread = await this.getThread(threadId);
      const workspace = await this.workspaceOf(thread);
      const policy = await this.policyFor(threadId, workspace);
      if (!providerEnabled(policy, thread.providerId)) return "Press: noted, but Press is off for this provider, so it will not compact this thread.";
      const usage = await this.loadUsage(threadId);
      const signals = this.cachedSignals(threadId, thread, this.store.lastLandedAt(threadId));
      // Judge it as the thread will be when this turn ends, with this turn counted.
      const atTurnEnd = { status: "idle" as const, updatedAt: this.now() };
      const decision = decide(this.decideInput({ policy, thread: atTurnEnd, usage, threadId, signals, agentHint: true, turnEnding: true }));
      const percent = decision.percent !== null ? `${decision.percent.toFixed(0)}%` : "an unknown share of the window";
      if (decision.decision === "compact") {
        return policy.mode === "auto"
          ? `Press: noted at ${percent}. Press will compact this thread when this turn ends, before the next turn starts.`
          : `Press: noted at ${percent}. Mode is ${policy.mode}, so Press will record a proposal when this turn ends and not compact.`;
      }
      if (decision.decision === "veto") {
        // The turn's end drops a hint that the agent point fired for and a veto blocked (see evaluate).
        return decision.point === "agent"
          ? `Press: noted at ${percent}, but ${decision.reason} blocks compacting when this turn ends, so the hint is dropped then. Call compaction_point again at the next milestone.`
          : `Press: noted at ${percent}, but ${decision.reason} blocks compacting when this turn ends. The hint stays recorded for the next evaluation.`;
      }
      return `Press: noted. No compaction point fires at ${percent} (points count from ${policy.window.softPercent}%); the hint stays recorded for a day.`;
    } catch (error) {
      this.warn(`compaction point preview for ${threadId} failed`, error);
      return "Press: noted. Press will consider compacting this thread when this turn ends.";
    }
  }
}

function toSummary(row: CompactionRow): CompactionSummary {
  const elapsed = row.outcome === "ok" && row.landedAt !== null ? row.landedAt - row.requestedAt : 0;
  return {
    id: row.id,
    at: new Date(row.requestedAt).toISOString(),
    point: row.point ?? "window",
    reason: row.reason,
    tokensBefore: row.tokensBefore,
    tokensAfter: row.tokensAfter,
    ms: row.ms ?? (elapsed > 0 ? elapsed : null),
    outcome: row.status === "requested" ? "pending" : row.outcome ?? "cancelled",
    error: row.error,
    model: row.model,
    hasSummary: row.summaryPath !== null,
    boundaryAt: row.boundaryAt,
    boundaryMessageId: row.boundaryMessageId,
  };
}

/** How long compacting one token takes, calibrated on this thread's timed compactions when it has some. */
function msPerTokenOf(rows: readonly CompactionRow[]): number {
  let ms = 0;
  let measured = 0;
  for (const row of rows) {
    const summary = toSummary(row);
    if (summary.outcome !== "ok" || summary.ms === null || row.tokensBefore === null || row.tokensBefore <= 0) continue;
    ms += summary.ms;
    measured += row.tokensBefore;
  }
  return measured > 0 ? ms / measured : EST_MS_PER_TOKEN;
}

/** The lowest window percent at which an enabled point that reads the timeline may fire, or null with none on. */
function timelineGatePercent(policy: Policy): number | null {
  let gate: number | null = null;
  for (const point of policy.points) {
    const readsTimeline = point.when === "toolResultBytes" || point.when === "signal" ||
      (point.when === "boundary" && (point.signals ?? []).some((signal) => signal !== "agentHint"));
    if (!point.enabled || !readsTimeline) continue;
    gate = Math.min(gate ?? Infinity, point.minPercent ?? policy.window.softPercent);
  }
  return gate;
}

/** The lowest window percent at which any enabled point may fire; softPercent with no point on. */
export function pointsFromPercent(policy: Policy): number {
  const enabled = policy.points.filter((point) => point.enabled);
  if (enabled.length === 0) return policy.window.softPercent;
  return Math.min(...enabled.map((point) => point.minPercent ?? policy.window.softPercent));
}

/** The sweep's evaluation gate: the lowest percent at which a point or the hard window may fire. */
export function gatePercent(policy: Policy): number {
  const points = policy.points.some((point) => point.enabled) ? pointsFromPercent(policy) : Infinity;
  return Math.min(policy.window.hardPercent, points);
}
