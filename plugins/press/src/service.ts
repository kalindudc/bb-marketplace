import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { mergeThreadOverride, resolvePressPolicy, type PointId, type Policy, type PolicyLayer, type PressSettings } from "./policy";
import { decide, estimateCompaction, nextCandidate, type Decision, type DecideInput } from "./decide";
import { completedCompactions, deriveSnapshot, pickBoundary, scanTimeline, type ThreadStatusView } from "./snapshot";
import type { PressStore } from "./store";
import { requestCompaction, type WorkspaceRef } from "./compact";
import {
  ledgerPath,
  lookupSummaryPath,
  threadHistory,
  mergeCompaction,
  mergeComposer,
  readLedger,
  sameComposer,
  writeLedgerAtomic,
  type Ledger,
  type LedgerIo,
  type PublishedComposer,
} from "./ledger";
import { normalizeSettings } from "./settings";
import { compactionSummarySchema, type CompactionSummary, type DecisionSummary, type EffectivePoints, type ThreadStatusDto } from "./contract";

const BOUNDARY_MAX_AGE_MS = 3 * 60 * 60_000;
const HISTORY_LIMIT = 50;

function effectivePoints(policy: Policy): EffectivePoints {
  const enabled = new Set(policy.points.filter((point) => point.enabled).map((point) => point.id));
  return { phase: enabled.has("phase"), agent: enabled.has("agent"), volume: enabled.has("volume"),
    turns: enabled.has("turns"), idle: enabled.has("idle"), thrash: enabled.has("thrash") };
}

/** A compaction still pending a landing after this long is given up as cancelled. */
export const PENDING_TTL_MS = 30 * 60_000;
export const SWEEP_INTERVAL_MS = 60_000;
/** Evaluations per sweep cap: the sweep is the low-frequency path, not a burst. */
export const SWEEP_MAX_EVALUATIONS = 20;
/** An unconsumed hint older than this is pruned as stale. */
export const HINT_TTL_MS = 24 * 60 * 60_000;

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

function warn(bb: BbPluginApi, message: string, error: unknown): void {
  bb.log.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`);
}

export interface EvaluateOptions {
  origin: string;
  agentHint?: boolean;
  dryRun?: boolean;
  /** `bb press compact --point <id>`: force this point as the candidate; the vetoes still apply. */
  forcePoint?: string;
  timelineRows?: readonly unknown[];
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

/**
 * The loop: subscribe to the thread lifecycle, evaluate on the moments that matter, and sweep idle
 * threads once a minute for the idle, volume, turns and thrash points. `observe` logs, `advisor`
 * records a proposal without acting, `auto` acts.
 */
export class PressService {
  private readonly evaluatedAt = new Map<string, number>();
  private readonly nativeCheckedAt = new Map<string, number>();
  private readonly manualRequests = new Set<string>();

  /** Workspaces this service has evaluated, newest last, so a settings change can republish to them. */
  private readonly seenWorkspaces = new Map<string, { workspace: WorkspaceRef; threadId: string }>();

  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: PressStore,
    private readonly now: () => number = Date.now,
    private readonly getSettings: () => Promise<Record<string, unknown>> = async () => ({}),
  ) {}

  register(): void {
    this.bb.events.on("thread.active", ({ thread }) => {
      // A running thread can never compact (the midTurn veto decides that), so this is bookkeeping only.
      this.evaluatedAt.delete(thread.id);
      this.invalidateStatus(thread.id);
    });
    this.bb.events.on("thread.idle", ({ thread }) => {
      this.store.bumpTurns(thread.id);
      void this.evaluate(thread.id, { origin: "idle" })
        .catch((error) => warn(this.bb, `evaluate ${thread.id} failed`, error))
        .finally(() => this.invalidateStatus(thread.id));
    });
    this.bb.events.on("thread.failed", ({ thread }) => {
      void this.settlePending(thread.id, "failed", `thread failed: ${thread.id}`)
        .catch((error) => warn(this.bb, `settle ${thread.id} failed`, error))
        .finally(() => this.invalidateStatus(thread.id));
    });
    this.bb.events.on("experimental_thread.events", ({ thread }) => {
      // Coalesced per thread; only an idle thread can compact, and the sweep re-checks the rest.
      if (thread.status !== "idle") return;
      void this.evaluate(thread.id, { origin: "events" }).catch(() => undefined);
    });
  }

  async sweepLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await sleep(SWEEP_INTERVAL_MS, signal);
      if (signal.aborted) break;
      await this.sweep().catch((error) => warn(this.bb, "sweep failed", error));
    }
  }

  /**
   * The low-frequency path: evaluate every idle thread whose usage is far enough up its window to
   * have a point fire, plus any thread with a pending agent hint. Hints older than a day are pruned.
   */
  async sweep(): Promise<void> {
    this.store.pruneHints(this.now() - HINT_TTL_MS);
    const threads = (await this.bb.sdk.threads.list({ limit: 200 })) as unknown as Array<{
      id: string;
      status?: string;
      archivedAt?: number | null;
      updatedAt?: number;
    }>;
    let evaluated = 0;
    const cutoff = this.now() - BOUNDARY_MAX_AGE_MS;
    for (const thread of threads) {
      if (thread.archivedAt != null) continue;
      const timelineRows = thread.updatedAt === undefined || thread.updatedAt >= cutoff
        ? await this.refreshHistory(thread.id, thread.updatedAt, cutoff).catch((error) => { warn(this.bb, `history ${thread.id} failed`, error); })
        : undefined;
      if (evaluated >= SWEEP_MAX_EVALUATIONS || thread.status !== "idle") continue;
      const pending = this.store.pendingHints(thread.id).length > 0 || this.store.pendingCompactions(thread.id).length > 0;
      if (!pending) {
        const policy = await this.policyFor(thread.id, null);
        const usage = await this.loadUsage(thread.id);
        const percent = usage !== null ? (usage.usedTokens / usage.modelContextWindow) * 100 : null;
        if (percent === null || percent < gatePercent(policy)) continue;
      }
      await this.evaluate(thread.id, { origin: "sweep", timelineRows: timelineRows ?? undefined })
        .catch((error) => warn(this.bb, `sweep ${thread.id} failed`, error));
      evaluated += 1;
    }
  }

  private invalidateStatus(threadId: string): void {
    this.bb.rpc.experimental_invalidate([`status:${threadId}`]);
  }

  private async hasUnrecordedNative(threadId: string, updatedAt: number | undefined, cutoff: number): Promise<boolean> {
    if (updatedAt !== undefined && this.nativeCheckedAt.get(threadId) === updatedAt) return false;
    const [event] = await this.bb.sdk.threads.events.list({ threadId, types: ["thread/compacted"], limit: "1", order: "desc" });
    if (event && event.createdAt >= cutoff && !this.store.compactionsOf(threadId, HISTORY_LIMIT)
      .some((row) => row.outcome === "ok" && row.landedAt === event.createdAt)) return true;
    if (updatedAt !== undefined) {
      this.nativeCheckedAt.set(threadId, updatedAt);
      const oldest = this.nativeCheckedAt.keys().next();
      if (this.nativeCheckedAt.size > 200 && !oldest.done) this.nativeCheckedAt.delete(oldest.value);
    }
    return false;
  }

  private syncNativeHistory(threadId: string, rows: readonly unknown[], cutoff: number): void {
    let changed = false;
    for (const operation of completedCompactions(rows)) {
      if (operation.finishedAt >= cutoff && this.store.recordNativeCompaction(threadId, operation)) changed = true;
    }
    const pending = this.store.unanchoredNativeCompaction(threadId, cutoff);
    if (pending?.landedAt != null) {
      const boundary = pickBoundary(rows, pending.landedAt);
      if (boundary && this.store.setNativeBoundary(pending.id, boundary)) changed = true;
    }
    if (changed) this.invalidateStatus(threadId);
  }

  private async refreshHistory(threadId: string, updatedAt: number | undefined, cutoff: number): Promise<readonly unknown[] | undefined> {
    const workspace = await this.workspaceOfThread(threadId);
    const io = workspace && this.ledgerIo(workspace);
    const path = workspace && ledgerPath(workspace.path);
    const ledger = io && path ? await readLedger(io, path) : null;
    const candidate = threadHistory(ledger, threadId).filter((row) => row.boundaryAt == null && (row.finishedAt ?? Date.parse(row.at)) >= cutoff)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    const unrecorded = await this.hasUnrecordedNative(threadId, updatedAt, cutoff).catch((error) => {
      warn(this.bb, `native compaction lookup for ${threadId} failed`, error);
      return false;
    });
    if (!candidate && !unrecorded && !this.store.unanchoredNativeCompaction(threadId, cutoff)) return;
    const rows = await this.loadTimelineRows(threadId);
    if (unrecorded) await this.settlePending(threadId, "check", null, rows);
    this.syncNativeHistory(threadId, rows, cutoff);
    if (!candidate || !io || !path) return rows;
    const boundary = pickBoundary(rows, candidate.finishedAt ?? Date.parse(candidate.at));
    if (boundary === null) return rows;
    const fresh = await readLedger(io, path);
    const current = threadHistory(fresh, threadId).find((row) => row.id === candidate.id);
    if (fresh && current && current.boundaryAt == null) {
      await writeLedgerAtomic(io, path, {
        ...fresh,
        history: fresh.history.map((row) => row === current
          ? { ...row, boundaryAt: boundary.createdAt, boundaryMessageId: boundary.id } : row),
      });
      this.invalidateStatus(threadId);
    }
    return rows;
  }

  /** Resolve the policy for one thread: defaults, dataDir policy, workspace policy, settings, override. */
  async policyFor(threadId: string, workspace: WorkspaceRef | null): Promise<Policy> {
    const layers: PolicyLayer[] = [];
    const dataDir = this.bb.server.experimental_dataDir;
    try {
      layers.push({
        source: `${dataDir}/press/policy.json`,
        value: JSON.parse(await readFile(join(dataDir, "press", "policy.json"), "utf8")),
      });
    } catch {
      // No user policy; the defaults carry.
    }
    if (workspace !== null) {
      const policy = await this.readFileFor(workspace, ".bb/press/policy.json");
      if (policy !== null) layers.push({ source: `workspace ${workspace.path}`, value: JSON.parse(policy) });
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
    const settings: PressSettings = normalizeSettings(await this.getSettings());
    return resolvePressPolicy(layers, settings, override, (source, issues) => {
      this.bb.log.warn(`press policy: skipping ${source}: ${issues.join("; ")}`);
    });
  }

  /** Publish the resolved composer config into the workspace ledger, so the pi half sees the UI settings. */
  private async publishComposerConfig(workspace: WorkspaceRef, policy: Policy): Promise<void> {
    const composer: PublishedComposer = {
      model: policy.composer.model,
      maxSummaryTokens: policy.composer.maxSummaryTokens,
      ledger: true,
      resumeContract: true,
    };
    const io = this.ledgerIo(workspace);
    const path = ledgerPath(workspace.path);
    const existing = await readLedger(io, path);
    if (existing !== null && sameComposer(existing.composer, composer)) return;
    // Read, merge only this field, write atomically: a ledger the composer just wrote survives.
    await writeLedgerAtomic(io, path, mergeComposer(existing, composer, new Date(this.now()).toISOString()));
  }

  /** Settings changed: republish the composer config into every workspace seen since the start. */
  async republishComposerConfigs(): Promise<void> {
    for (const { workspace, threadId } of [...this.seenWorkspaces.values()]) {
      try {
        await this.publishComposerConfig(workspace, await this.policyFor(threadId, workspace));
      } catch (error) {
        warn(this.bb, `composer config republish for ${workspace.path} failed`, error);
      }
    }
  }

  private rememberWorkspace(workspace: WorkspaceRef, threadId: string): void {
    this.seenWorkspaces.delete(workspace.path);
    this.seenWorkspaces.set(workspace.path, { workspace, threadId });
    while (this.seenWorkspaces.size > 64) {
      this.seenWorkspaces.delete(this.seenWorkspaces.keys().next().value as string);
    }
  }

  private async readFileFor(workspace: WorkspaceRef, relative: string): Promise<string | null> {
    try {
      const result = (await this.bb.sdk.files.read({
        path: `${workspace.path.replace(/[/\\]+$/, "")}/${relative}`,
        ...(workspace.hostId !== null ? { hostId: workspace.hostId } : {}),
      })) as unknown as { content: string; contentEncoding?: string };
      if (result.contentEncoding === "base64") return Buffer.from(result.content, "base64").toString("utf8");
      return result.content;
    } catch {
      return null;
    }
  }

  async workspaceOfThread(threadId: string): Promise<WorkspaceRef | null> {
    try {
      const thread = asRecord(await this.bb.sdk.threads.get({ threadId })) as unknown as { environmentId: string | null };
      if (thread.environmentId == null) return null;
      const environment = asRecord(await this.bb.sdk.environments.get({ environmentId: thread.environmentId }));
      const hostId = typeof environment.hostId === "string" ? environment.hostId : null;
      const path = typeof environment.path === "string" ? environment.path : null;
      return path !== null ? { hostId, path } : null;
    } catch {
      return null;
    }
  }

  /** File operations against the thread's workspace, through `bb.sdk.files` so remote hosts work. */
  ledgerIo(workspace: WorkspaceRef): LedgerIo {
    const bb = this.bb;
    const routing = workspace.hostId !== null ? { hostId: workspace.hostId } : {};
    return {
      read: async (path) => {
        try {
          const result = (await bb.sdk.files.read({ path, ...routing })) as unknown as {
            content: string;
            contentEncoding?: string;
          };
          if (result.contentEncoding === "base64") return Buffer.from(result.content, "base64").toString("utf8");
          return result.content;
        } catch {
          return null;
        }
      },
      write: async (path, content) => {
        await bb.sdk.files.write({ path, content, ...routing, createParents: true });
      },
      move: async (from, to) => {
        await bb.sdk.files.move({ sourcePath: from, destinationPath: to, ...routing });
      },
      mkdir: async (path) => {
        await bb.sdk.files.mkdir({ path, ...routing, recursive: true });
      },
    };
  }

  /** Evaluate one thread: build the snapshot, decide, record, and act when the mode says to. */
  async evaluate(threadId: string, options: EvaluateOptions): Promise<EvaluateResult> {
    const now = this.now();
    this.evaluatedAt.set(threadId, now);
    const thread = asRecord(await this.bb.sdk.threads.get({ threadId })) as unknown as {
      status: ThreadStatusView["status"];
      updatedAt: number;
      providerId: string;
      environmentId: string | null;
    };
    const workspace = await this.workspaceOfThread(threadId);
    const policy = await this.policyFor(threadId, workspace);
    const mode = policy.mode;
    if (workspace !== null) {
      this.rememberWorkspace(workspace, threadId);
      await this.publishComposerConfig(workspace, policy).catch((error) =>
        warn(this.bb, `composer config publish for ${workspace.path} failed`, error),
      );
    }

    const usage = await this.loadUsage(threadId);
    const rows = options.timelineRows ?? await this.loadTimelineRows(threadId);
    await this.settlePending(threadId, "check", null, rows, usage).catch(() => undefined);
    this.syncNativeHistory(threadId, rows, now - BOUNDARY_MAX_AGE_MS);

    const state = this.store.threadState(threadId);
    const lastCompaction = state.lastCompactionAt !== null ? { at: state.lastCompactionAt, failed: state.lastCompactionFailed } : null;
    const hints = this.store.pendingHints(threadId);
    const snapshot = deriveSnapshot({ usage, thread, now, turnsSinceCompaction: state.turnsSince, rows });
    const recentSignals = [...snapshot.phaseSignals, ...(hints.length > 0 || options.agentHint === true ? ["agentHint"] : [])];

    let input: DecideInput = { policy, snapshot, now, lastCompaction, recentSignals };
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
        recentSignals: [...recentSignals, "agentHint"],
      };
    }

    const decision = decide(input);
    const next = nextCandidate(input);

    if (decision.decision === "skip") return { decision, decisionId: null, mode, acted: false, next };

    const row = this.store.recordDecision({ at: now, threadId, decision, mode, origin: options.origin });
    // The hint fired: it produced this row, so it is consumed whatever the vetoes said.
    if (decision.point === "agent") this.store.consumeHints(hints.map((hint) => hint.id));
    this.logDecision(threadId, decision, mode, options.dryRun === true);

    let acted = false;
    let error: string | undefined;
    if (decision.decision === "compact" && mode === "auto" && options.dryRun !== true) {
      const ledger = workspace !== null ? await readLedger(this.ledgerIo(workspace), ledgerPath(workspace.path)) : null;
      if (this.manualRequests.has(threadId) || this.store.pendingCompactions(threadId).length > 0) {
        this.invalidateStatus(threadId);
        return { decision, decisionId: row.id, mode, acted, next, error: "A compaction is already in progress." };
      }
      const result = await requestCompaction(this.bb, this.store, {
        threadId,
        decisionId: row.id,
        providerId: thread.providerId,
        policy,
        ledger,
        mode,
        now,
        tokensBefore: decision.tokens,
        point: decision.point,
      });
      acted = result.ok;
      error = result.error ?? undefined;
      if (!result.ok) {
        this.store.settleCompaction(result.compactionId, "failed", now, result.error, null);
        this.store.setDecisionOutcome(row.id, "failed", now, result.error);
        this.store.resetTurns(threadId, now, true);
        this.bb.log.warn(`compaction of ${threadId} failed: ${result.error}`);
      } else {
        this.bb.log.info(
          `compaction requested for ${threadId} (${result.method}, point ${decision.point}, ` +
            `${decision.percent !== null ? decision.percent.toFixed(0) : "?"}%, est ${decision.estMs}ms)`,
        );
      }
    }
    this.invalidateStatus(threadId);
    return { decision, decisionId: row.id, mode, acted, next, error };
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

  private async loadUsage(threadId: string): Promise<{ estimated: boolean; modelContextWindow: number; usedTokens: number } | null> {
    try {
      const response = asRecord(await this.bb.sdk.threads.context({ threadId })) as unknown as { usage: unknown };
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
      return response.rows;
    } catch {
      return [];
    }
  }

  /**
   * Fill the outcome of compactions still pending for a thread: landed (a `contextCompaction` row
   * after the request), failed (the thread errored after the request) or cancelled (past the TTL).
   */
  async settlePending(
    threadId: string,
    cause: "check" | "failed",
    errorHint: string | null,
    rows?: readonly unknown[],
    usage?: { usedTokens: number } | null,
  ): Promise<void> {
    const pending = this.store.pendingCompactions(threadId);
    if (pending.length === 0) return;
    const now = this.now();
    const timeline = rows ?? (await this.loadTimelineRows(threadId));
    const currentUsage = usage ?? (await this.loadUsage(threadId));
    const workspace = await this.workspaceOfThread(threadId);

    const lastLanded = scanTimeline(timeline).lastCompactionEventAt;
    for (const row of pending) {
      if (lastLanded !== null && lastLanded >= row.requestedAt) {
        this.store.settleCompaction(row.id, "ok", lastLanded, null, currentUsage?.usedTokens ?? null);
        if (row.decisionId !== null) this.store.setDecisionOutcome(row.decisionId, "ok", now, null);
        this.store.resetTurns(threadId, now, false);
        await this.appendLedgerHistory(workspace, row, currentUsage?.usedTokens ?? null, lastLanded);
      } else if (cause === "failed") {
        this.store.settleCompaction(row.id, "failed", now, errorHint ?? "thread failed", null);
        if (row.decisionId !== null) this.store.setDecisionOutcome(row.decisionId, "failed", now, errorHint);
        this.store.resetTurns(threadId, now, true);
      } else if (now - row.requestedAt > PENDING_TTL_MS) {
        this.store.settleCompaction(row.id, "cancelled", now, "pending compaction timed out", null);
        if (row.decisionId !== null) this.store.setDecisionOutcome(row.decisionId, "cancelled", now, null);
        this.store.resetTurns(threadId, now, false);
      }
    }
  }

  private async appendLedgerHistory(
    workspace: WorkspaceRef | null,
    row: { id: string; threadId: string; point: string | null; tokensBefore: number | null; requestedAt: number },
    tokensAfter: number | null,
    finishedAt: number,
  ): Promise<void> {
    if (workspace === null) return;
    try {
      const io = this.ledgerIo(workspace);
      const path = ledgerPath(workspace.path);
      const existing = await readLedger(io, path);
      const composerRow = threadHistory(existing, row.threadId).find((entry) =>
        entry.id.startsWith("press-") && !entry.requestId && Date.parse(entry.at) >= row.requestedAt && Date.parse(entry.at) <= finishedAt);
      const now = new Date(this.now()).toISOString();
      const ledger: Ledger = existing && composerRow ? {
        ...existing, updatedAt: now,
        history: existing.history.map((entry) => entry === composerRow ? { ...entry, requestId: row.id, finishedAt } : entry),
      } : mergeCompaction(existing, {
        id: row.id,
        threadId: row.threadId,
        at: new Date(row.requestedAt).toISOString(),
        finishedAt,
        boundaryAt: null,
        point: row.point ?? "window",
        tokensBefore: row.tokensBefore ?? 0,
        tokensAfter,
        model: null,
        ms: finishedAt - row.requestedAt,
        keptTurns: null,
        summaryHash: "",
      }, now);
      await writeLedgerAtomic(io, path, ledger);
    } catch (error) {
      warn(this.bb, `ledger write for ${workspace.path} failed`, error);
    }
  }

  /**
   * The one status builder: `bb press status --json` and the `status` RPC both call it, so the
   * thread context card and the CLI can never disagree. Read-only, cheap: no provider calls, no
   * writes, and nulls instead of a throw when the thread has no recorded usage.
   */
  async buildThreadStatus(threadId: string): Promise<ThreadStatusDto> {
    const now = this.now();
    const thread = asRecord(await this.bb.sdk.threads.get({ threadId })) as unknown as {
      status: ThreadStatusView["status"];
      updatedAt: number;
    };
    const workspace = await this.workspaceOfThread(threadId);
    const policy = await this.policyFor(threadId, workspace);
    const usage = await this.loadUsage(threadId);
    const ledger =
      workspace !== null ? await readLedger(this.ledgerIo(workspace), ledgerPath(workspace.path)) : null;
    const state = this.store.threadState(threadId);
    const lastCompaction =
      state.lastCompactionAt !== null ? { at: state.lastCompactionAt, failed: state.lastCompactionFailed } : null;
    // Cheap snapshot: usage and the turn counter, no timeline scan, so this stays a pair of reads.
    const snapshot = deriveSnapshot({
      usage,
      thread,
      now,
      turnsSinceCompaction: state.turnsSince,
      rows: [],
    });
    const next = nextCandidate({ policy, snapshot, now, lastCompaction, recentSignals: [] });

    const ledgerRows = threadHistory(ledger, threadId);
    const recorded = new Set(ledgerRows.flatMap((row) => row.requestId ? [row.id, row.requestId] : [row.id]));
    const history: CompactionSummary[] = [];
    for (const row of ledgerRows) {
      const entry = compactionSummarySchema.safeParse({
        id: row.id, at: row.at, point: row.point, tokensBefore: row.tokensBefore, tokensAfter: row.tokensAfter,
        ms: row.ms, outcome: "ok", model: row.model,
        summaryPath: lookupSummaryPath(ledger, threadId, row.at),
        boundaryAt: row.boundaryAt ?? null, boundaryMessageId: row.boundaryMessageId ?? null,
      });
      if (entry.success) history.push(entry.data);
    }
    const compactions = this.store.compactionsOf(threadId, HISTORY_LIMIT);
    const managedLandings = new Set(compactions.filter((row) => row.method !== "native" && row.outcome === "ok").map((row) => row.landedAt));
    for (const row of compactions) {
      if (recorded.has(row.id)) continue;
      const { landedAt } = row;
      if (row.method === "native" && landedAt !== null && (managedLandings.has(landedAt) || ledgerRows.some((entry) => {
        const at = Date.parse(entry.at);
        return entry.finishedAt === landedAt || (entry.id.startsWith("press-") && at >= row.requestedAt && at <= landedAt);
      }))) continue;
      const ms = landedAt === null ? null : landedAt - row.requestedAt;
      history.push({
        id: row.id, at: new Date(row.requestedAt).toISOString(), point: row.point ?? "window", tokensBefore: row.tokensBefore,
        tokensAfter: row.tokensAfter, ms: row.method === "native" && ms === 0 ? null : ms,
        outcome: row.outcome, model: null, summaryPath: null, boundaryAt: row.boundaryAt, boundaryMessageId: row.boundaryMessageId,
      });
    }
    history.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const recent = history.slice(0, HISTORY_LIMIT);
    const boundaries: ThreadStatusDto["boundaries"] = {};
    recent.forEach(({ boundaryAt, boundaryMessageId }, index) => {
      if (boundaryAt === null) return;
      boundaries[String(boundaryAt)] ??= index;
      if (boundaryMessageId !== null) boundaries[`message:${boundaryMessageId}`] ??= index;
    });

    const decisions: DecisionSummary[] = this.store
      .decisions({ threadId, limit: 5 })
      .map((row) => ({
        at: new Date(row.at).toISOString(),
        point: row.point,
        decision: row.decision,
        reason: row.reason,
        percent: row.percent,
      }));

    return {
      threadId,
      percent: snapshot.percent,
      tokens: snapshot.tokens,
      window: snapshot.window,
      mode: policy.mode,
      points: effectivePoints(policy),
      summaryModel: policy.composer.model,
      nextPoint: next?.point ?? null,
      lastCompaction: history[0] ?? null,
      history: recent,
      boundaries,
      decisions,
    };
  }

  async summary(threadId: string, at: string): Promise<{ markdown: string | null; path: string | null }> {
    const workspace = await this.workspaceOfThread(threadId);
    if (!workspace) return { markdown: null, path: null };
    const ledger = await readLedger(this.ledgerIo(workspace), ledgerPath(workspace.path));
    const path = lookupSummaryPath(ledger, threadId, at);
    return { path, markdown: path === null ? null : await this.readFileFor(workspace, path) };
  }

  async compactNow(threadId: string): Promise<{ ok: boolean; message: string }> {
    const inProgress = { ok: false, message: "A compaction is already in progress." };
    if (this.manualRequests.has(threadId)) return inProgress;
    this.manualRequests.add(threadId);
    try {
      const thread = await this.bb.sdk.threads.get({ threadId });
      const notIdle = { ok: false, message: "Wait until the thread is idle before compacting." };
      if (thread.status !== "idle") return notIdle;
      const workspace = await this.workspaceOfThread(threadId);
      const policy = await this.policyFor(threadId, workspace);
      if (policy.providers[thread.providerId]?.enabled === false) return { ok: false, message: "Compaction is disabled for this provider in Press policy." };
      const usage = await this.loadUsage(threadId);
      await this.settlePending(threadId, "check", null, undefined, usage);
      if (this.store.pendingCompactions(threadId).length > 0) return inProgress;
      if (workspace !== null) {
        this.rememberWorkspace(workspace, threadId);
        await this.publishComposerConfig(workspace, policy);
      }
      const current = await this.bb.sdk.threads.get({ threadId });
      if (current.status !== "idle") return notIdle;
      if (current.providerId !== thread.providerId) return { ok: false, message: "The thread’s provider changed. Try again." };
      const now = this.now();
      const snapshot = deriveSnapshot({ usage, thread, now, turnsSinceCompaction: 0, rows: [] });
      const decision: Decision = {
        decision: "compact", point: "manual", reason: "manual", percent: snapshot.percent, tokens: snapshot.tokens,
        window: snapshot.window, ...estimateCompaction(snapshot.tokens),
      };
      const row = this.store.recordDecision({ at: now, threadId, decision, mode: policy.mode, origin: "manual" });
      const result = await requestCompaction(this.bb, this.store, {
        threadId, decisionId: row.id, providerId: thread.providerId, policy, ledger: null, mode: policy.mode,
        now, tokensBefore: decision.tokens, point: decision.point,
      });
      if (result.ok) return { ok: true, message: "Compaction requested." };
      this.store.settleCompaction(result.compactionId, "failed", this.now(), result.error, null);
      this.store.setDecisionOutcome(row.id, "failed", this.now(), result.error);
      return { ok: false, message: result.error ?? "The provider declined compaction." };
    } finally {
      this.manualRequests.delete(threadId);
      this.invalidateStatus(threadId);
    }
  }

  async setThreadMode(threadId: string, mode: Policy["mode"]): Promise<{ mode: Policy["mode"] }> {
    const workspace = await this.workspaceOfThread(threadId);
    const override = mergeThreadOverride(this.store.threadPolicyOverride(threadId), { mode });
    this.store.setThreadPolicyOverride(threadId, JSON.stringify(override));
    this.invalidateStatus(threadId);
    return { mode: (await this.policyFor(threadId, workspace)).mode };
  }

  async setThreadPoint(threadId: string, point: PointId, enabled: boolean): Promise<{ points: EffectivePoints }> {
    const workspace = await this.workspaceOfThread(threadId);
    const override = mergeThreadOverride(this.store.threadPolicyOverride(threadId), { pointOverrides: { [point]: enabled } });
    this.store.setThreadPolicyOverride(threadId, JSON.stringify(override));
    this.invalidateStatus(threadId);
    return { points: effectivePoints(await this.policyFor(threadId, workspace)) };
  }

  /** The agent-callable path behind the `compaction_point` tool: record a hint, then evaluate now. */
  async compactionPoint(threadId: string): Promise<string> {
    this.store.recordHint({ threadId, at: this.now(), reason: "agent hint (tool)" });
    const result = await this.evaluate(threadId, { origin: "agentHint" });
    const percent = result.decision.percent !== null ? `${result.decision.percent.toFixed(0)}%` : "?";
    if (result.decision.decision === "skip") {
      return `Press: no compaction point fires at ${percent}; the hint stays recorded for the next evaluation.`;
    }
    const acted = result.acted ? "compaction requested" : `mode ${result.mode}: proposal recorded, not acted on`;
    return `Press: ${result.decision.decision} (${result.decision.point}, ${result.decision.reason ?? ""}) at ${percent}. ${acted}.`;
  }
}

/** The lowest window percent at which any enabled point may fire: the sweep's evaluation gate. */
export function gatePercent(policy: Policy): number {
  let gate = policy.window.hardPercent;
  for (const point of policy.points) {
    if (!point.enabled) continue;
    gate = Math.min(gate, point.minPercent ?? policy.window.softPercent);
  }
  return gate;
}