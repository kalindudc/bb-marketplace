// The engine: a control loop that works every running project, the human's commands on the engine's state, and
// the handlers for bb's thread events. Behavior lives in workers.ts, checks.ts and triage.ts; this wires it together.
import { resumeCheckingTickets } from "./checks";
import { repoCheckout, type RepoCheckout } from "./checkouts";
import { finishIfComplete, holdMerge, land, mergeHeld, pollPullRequests, runMergeQueue, stopMerge, type LandResult } from "./merge";
import type { PostRow, ProjectRow, RolloutMarkRow, Store, ThreadRow, TicketRow } from "./db/store";
import { COMMENT_SIGNATURE, approvedText, blockedReplyText, heldCheckResult, resumeText, reviewRequeueNote, startRequeueNote } from "./prompts";
import { LoomError, type ApproveResult, type Projects } from "./projects";
import { isMultiRepo } from "./repos";
import { CHECKS_NEAR_DONE_PERCENT, CHECKS_QUEUED_MINUTES } from "./check-wait";
import { CHECKS_SETTLE_MINUTES } from "./pull-requests";
import { NO_HOOK, sendRecords, type LoomSettings } from "./record";
import { newPrReads, requestSync, SYNC_WAIT_MS, syncResult, within, type PrSyncResult } from "./pr-sync";
import { backToReview, blockedAtReview, onReviewerGone, onReviewerIdle, onReviewerTurnFailed, reviewerStartFailed, spawnReviewers } from "./review";
import { approvalRefusal, endSpecReviews, onSpecReviewerGone, onSpecReviewerIdle, onSpecReviewerTurnFailed, reconcileSpecReviews, retrySpecReviews, specReviewStatus } from "./spec-review";
import { NOT_PARKED, budgetReason, spawnable, toLite, waitsForSlot, type Parked, type TicketLite } from "./scheduler";
import { deliverHandBacks, holdForWorker, parkedThreads } from "./slots";
import { conflictWaits, stacking } from "./stack";
import { startWaits } from "./starts";
import { noteUpstreamChanges } from "./upstream";
import { LOOM_ACTOR, canMoveTicket } from "./states";
import { askForPrTexts, humanFixRound, onPrWriterIdle, resumePrAsks } from "./pull-requests";
import { recordPlannerTurn } from "./planner-view";
import { fenceRolloutChecks, followRollout, markLiveByHuman } from "./rollout-live";
import { readBehind } from "./fresh";
import { advanceWakes, releaseIdleWorkers, wakeForRestacks } from "./release";
import type { Spec } from "./spec";
import { cancelTicket, maybeSendTriage, onPlannerIdle } from "./triage";
import {
  blockTicket,
  blockedAtStart,
  endThread,
  failSpawn,
  onThreadGone as endGoneThread,
  onTurnFailed as handleTurnFailed,
  onWorkerIdle,
  pauseProject,
  requeueTicket,
  resumeEnding,
  spawnWorker,
  specOf,
  startedFine,
  type EngineCtx,
  type TurnFailure,
} from "./workers";

const TOKEN_REFRESH_MS = 60_000;
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type EngineDeps = Omit<EngineCtx, "kick" | "checksSettleMs" | "forgeBackoffs" | "prReads"> & { projects: Projects; settings?: () => LoomSettings };

export interface Approved extends ApproveResult {
  requeued: string[];
  backToReview: string[];
}

/** Who hears the human's reply on a ticket at once: the active worker holding a working ticket, or the project's active planner when it is blocked. */
export function replyRecipient(store: Store, ticket: TicketRow): { role: "worker" | "planner"; threadId: string } | null {
  // On an open pull request of a running project the reply starts a fix round (humanFixRound), which the worker gets; while paused it stays on the ticket.
  const prRound = ticket.state === "pr_open" && store.project(ticket.project_id)?.state === "running";
  const worker = (ticket.state === "working" || prRound) && ticket.worker_thread_id !== null ? store.threadByThreadId(ticket.worker_thread_id) : null;
  // A blocked ticket has no worker, and triage rounds go out only when a ticket blocks, so the planner hears the reply now.
  const planner = ticket.state === "blocked" ? store.threads({ projectId: ticket.project_id, role: "planner", states: ["active"] })[0] : undefined;
  if (worker?.state === "active" && worker.thread_id !== null) return { role: "worker", threadId: worker.thread_id };
  if (planner?.thread_id != null) return { role: "planner", threadId: planner.thread_id };
  return null;
}

export class Engine {
  readonly ctx: EngineCtx;
  private readonly projects: Projects;
  private disposed = false;
  private currentTick: Promise<void> | null = null;
  private tickAgain = false;

  private readonly settings: () => LoomSettings;

  constructor(deps: EngineDeps) {
    this.projects = deps.projects;
    this.settings = deps.settings ?? (() => NO_HOOK);
    const settleMs = () => (this.settings().checksSettleMinutes ?? CHECKS_SETTLE_MINUTES) * 60_000;
    const signature = () => this.settings().commentSignature ?? COMMENT_SIGNATURE;
    this.ctx = {
      store: deps.store,
      bb: deps.bb,
      now: deps.now,
      host: deps.host,
      kick: () => this.kick(),
      forgeBackoffs: new Map(),
      prReads: newPrReads(),
      checksSettleMs: settleMs,
      checksQueuedMinutes: () => this.settings().checksQueuedMinutes ?? CHECKS_QUEUED_MINUTES,
      checksNearDonePercent: () => this.settings().checksNearDonePercent ?? CHECKS_NEAR_DONE_PERCENT,
      commentSignature: signature,
    };
  }

  private warn(what: string, error: unknown): void {
    if (!this.disposed) this.ctx.bb.log("warn", `${what}: ${errText(error)}`);
  }

  // ---------------------------------------------------------------- the control loop

  kick(): void {
    void this.tick().catch((error) => this.warn("tick", error));
  }

  /** One pass over every project: works the running and paused ones and removes a done or archived one's section. Concurrent callers share a pass; a kick during a pass makes another one. */
  tick(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.currentTick !== null) {
      this.tickAgain = true;
      return this.currentTick;
    }
    this.currentTick = (async () => {
      await Promise.resolve();
      try {
        do {
          this.tickAgain = false;
          await this.pass();
        } while (this.tickAgain && !this.disposed);
      } finally {
        this.currentTick = null;
      }
    })();
    return this.currentTick;
  }

  private async pass(): Promise<void> {
    const { store } = this.ctx;
    for (const row of store.threads({ states: ["ending"] })) {
      await resumeEnding(this.ctx, row).catch((error) => this.warn(`ending ${row.thread_id}`, error));
    }
    resumeCheckingTickets(this.ctx);
    if (store.openSpecReviews().some((row) => row.thread_id === null && row.wait_json !== null)) await retrySpecReviews(this.ctx).catch((error) => this.warn("spec reviews", error));
    for (const project of store.projects()) {
      if (this.disposed) return;
      try {
        if (project.state === "running") await this.tickProject(project.id);
        else if (project.state === "paused") await this.tickPaused(project.id);
        // The last merge finishes a project, and its deploys come after; their verify and check commands keep running.
        else if (project.state === "done") followRollout(this.ctx, project);
        // Read again: the tick may have finished it, and a land or an archive may have moved it since the list was read.
        await this.projects.removeFinishedSection(store.project(project.id)!);
      } catch (error) {
        this.warn(`project ${project.slug}`, error);
      }
    }
    sendRecords(this.ctx, this.settings());
  }

  // A paused project starts no worker, reviewer or merge; it still follows its open pull requests and finishes when the last one is done.
  private async tickPaused(projectId: number): Promise<void> {
    const project = this.ctx.store.project(projectId);
    if (project?.state !== "paused") return;
    await this.releaseAndWake(projectId, specOf(this.ctx.store, project), false);
    await pollPullRequests(this.ctx, project);
    followRollout(this.ctx, this.ctx.store.project(projectId)!);
    finishIfComplete(this.ctx, this.ctx.store.project(projectId)!);
  }

  // Every await can let a pause land, so the project is read again after each one and the pass stops once it is not running.
  private async tickProject(projectId: number): Promise<void> {
    const { store, now } = this.ctx;
    const running = (): ProjectRow | null => {
      const current = store.project(projectId);
      return current?.state === "running" ? current : null;
    };
    let project = running();
    if (project === null) return;
    const spec = specOf(store, project);

    await this.refreshTokens(project);
    project = running();
    if (project === null) return;

    const tokens = store.threads({ projectId }).reduce((sum, row) => sum + (row.tokens ?? 0), 0);
    const reason = budgetReason(spec, tokens, now());
    if (reason !== null) {
      pauseProject(this.ctx, projectId, reason);
    } else {
      const timeoutMs = spec.agents.ticket_timeout_minutes * 60_000;
      for (const row of store.threads({ projectId, role: "worker", states: ["active"] })) {
        if (running() === null) return;
        if (row.clock_at === null || now() - row.clock_at <= timeoutMs) continue;
        const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
        // A hand-back waiting for a worker slot runs no turn; its clock starts once it has a slot.
        if (ticket?.state !== "working" || ticket.worker_thread_id !== row.thread_id || waitsForSlot(ticket)) continue;
        await endThread(this.ctx, row, "timeout", { commit: true });
      }
      if (running() === null) return;
      await readBehind(this.ctx, running()!, spec);
      if (running() === null) return;
      await this.releaseAndWake(projectId, spec, true);
      if (running() === null) return;
      await noteUpstreamChanges(this.ctx, running()!, spec);
      if (running() === null) return;
      // Work going back to a worker takes the free worker slots first, then a worker writing its pull request, then a new worker.
      const parked = await parkedThreads(this.ctx, projectId, spec);
      if (running() === null) return;
      await deliverHandBacks(this.ctx, projectId, parked);
      if (running() === null) return;
      await askForPrTexts(this.ctx, running()!, spec, parked);
      if (running() === null) return;
      await runMergeQueue(this.ctx, running()!, spec);
      if (running() === null) return;
      await spawnReviewers(this.ctx, running()!, spec, parked);
      if (running() === null) return;
      await this.spawnReady(projectId, parked);
    }

    const current = store.project(projectId)!;
    if (current.state === "running" || current.state === "paused") {
      await pollPullRequests(this.ctx, current);
      followRollout(this.ctx, store.project(projectId)!);
      finishIfComplete(this.ctx, store.project(projectId)!);
    }
    await maybeSendTriage(this.ctx, store.project(projectId)!);
  }

  /** Releases the idle workers of open pull requests and brings released ones back; `running` also wakes them for catch-ups. A project with none skips the steps. */
  private async releaseAndWake(projectId: number, spec: Spec, running: boolean): Promise<void> {
    const { store } = this.ctx;
    if (spec.merge.strategy !== "pr") return;
    if (store.threads({ projectId, role: "worker", states: ["active", "ended"] }).some((row) => row.released_at !== null)) await advanceWakes(this.ctx, projectId);
    if (store.tickets(projectId, ["pr_open", "approved"]).length === 0) return;
    const project = store.project(projectId)!;
    await releaseIdleWorkers(this.ctx, project, spec);
    if (running && store.project(projectId)?.state === "running") await wakeForRestacks(this.ctx, store.project(projectId)!, spec);
  }

  private async refreshTokens(project: ProjectRow): Promise<void> {
    const { store, bb, now } = this.ctx;
    for (const row of store.threads({ projectId: project.id, states: ["active"] })) {
      if (row.thread_id === null || (row.tokens_at !== null && now() - row.tokens_at <= TOKEN_REFRESH_MS)) continue;
      const tokens = await bb.threadTokens(row.thread_id).catch(() => null);
      store.updateThread(row.id, { tokens: tokens ?? row.tokens, tokens_at: now() });
    }
  }

  /** Spawns one worker at a time. Readiness and slots are computed again from fresh rows before each reservation, and a ticket is tried once per pass. */
  private async spawnReady(projectId: number, parked: Parked = NOT_PARKED): Promise<void> {
    const { store, now } = this.ctx;
    const next = (tried: ReadonlySet<number>) => {
      const project = store.project(projectId);
      if (project?.state !== "running" || (project.hold_until !== null && project.hold_until > now())) return null;
      const spec = specOf(store, project);
      const rows = store.tickets(projectId);
      const stack = stacking(spec);
      // A stacked start whose dependencies' commits conflicted waits until one of them changes, and a failed start until its retry time.
      const waiting = (ticket: TicketLite) => {
        const row = rows.find((candidate) => candidate.id === ticket.id)!;
        return (spec.merge.strategy === "integration" && this.integrationMoving(projectId, ticket.repo)) || (stack && conflictWaits(rows, row)) || startWaits(row, "worker", now());
      };
      const lite = spawnable(spec.agents.max_workers, rows.map(toLite), waiting, stack, parked.workers).find((candidate) => !tried.has(candidate.id));
      return lite === undefined ? null : { project, spec, ticket: store.ticket(lite.id)!, waiting };
    };

    const tried = new Set<number>();
    const first = next(tried);
    if (first === null) return;
    await this.projects.ensureProjectSection(first.project);
    for (;;) {
      if (this.disposed) return;
      const pick = next(tried);
      if (pick === null) return;
      tried.add(pick.ticket.id);
      await spawnWorker(this.ctx, pick.project, pick.spec, pick.ticket, pick.waiting, parked.workers);
    }
  }

  /**
   * Whether a repo's integration branch may move before a worker's worktree branches from its tip. A merge moves only its
   * ticket's repo. The merge guard held with no ticket merging is a direct land, a human block or cancel, or a merge about
   * to begin or just done, so every repo waits.
   */
  private integrationMoving(projectId: number, repo: string | null): boolean {
    const merging = this.ctx.store.tickets(projectId, ["merging"]);
    return merging.some((ticket) => ticket.repo === repo) || (merging.length === 0 && mergeHeld(this.ctx, projectId));
  }

  /** After a restart: adopt or roll back half-made spawns, end rows and planning conversations whose thread is gone, finish endings, check again, and run merges left in merging again. */
  async reconcile(): Promise<{ adopted: number; rolledBack: number; rechecked: number }> {
    const { store, bb } = this.ctx;
    let adopted = 0;
    let rolledBack = 0;
    for (const row of store.threads({ states: ["spawning"] })) {
      if (row.role === "planner") continue;
      const threadId = row.thread_id ?? (row.spawn_token === null ? null : await bb.findSpawnedThread(row.spawn_token));
      if (threadId === null) {
        if (row.role === "reviewer") await reviewerStartFailed(this.ctx, row, { kind: "failed", message: "The plugin restarted before the reviewer started." });
        else await failSpawn(this.ctx, row, { kind: "failed", message: "The plugin restarted before the worker started." });
        rolledBack += 1;
      } else {
        await this.adopt(row, threadId);
        adopted += 1;
      }
    }
    for (const row of store.threads({ states: ["active"] })) {
      // A worker coming back from a release is archived until advanceWakes unarchives it.
      if (row.thread_id === null || row.released_at !== null) continue;
      const thread = await bb.getThread(row.thread_id);
      if (thread !== null && thread.archivedAt === null && thread.deletedAt === null) continue;
      if (row.role === "planner") this.projects.threadGone(row.thread_id, "deleted");
      else await endThread(this.ctx, row, "gone", { commit: row.role === "worker", ...(row.role === "worker" ? {} : { move: null }) });
    }
    for (const session of store.openPlanning()) {
      const thread = await bb.getThread(session.thread_id);
      if (thread === null || thread.archivedAt !== null || thread.deletedAt !== null) this.projects.planningGone(session.thread_id, "gone");
    }
    for (const row of store.threads({ states: ["ending"] })) await resumeEnding(this.ctx, row);
    await reconcileSpecReviews(this.ctx);
    const rechecked = resumeCheckingTickets(this.ctx);
    for (const project of store.projects()) {
      if (project.state === "running") await runMergeQueue(this.ctx, project, specOf(store, project));
    }
    this.kick();
    return { adopted, rolledBack, rechecked };
  }

  private async adopt(row: ThreadRow, threadId: string): Promise<void> {
    const { store, bb, now } = this.ctx;
    const thread = await bb.getThread(threadId);
    const environmentId = thread?.environmentId ?? null;
    const worker = row.role === "worker";
    store.tx(() => {
      const current = store.thread(row.id);
      if (current === null || current.state !== "spawning") return;
      const bound = current.thread_id ?? threadId;
      store.updateThread(row.id, { state: "active", thread_id: bound, environment_id: environmentId, clock_at: now() });
      if (worker && row.ticket_id !== null) store.updateTicket(row.ticket_id, { worker_thread_id: bound, environment_id: environmentId });
    });
    if (thread === null || thread.archivedAt !== null || thread.deletedAt !== null) {
      await endThread(this.ctx, store.thread(row.id)!, "gone", { commit: worker, ...(worker ? {} : { move: null }) });
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.currentTick?.catch(() => undefined);
    fenceRolloutChecks(this.ctx);
  }

  // ---------------------------------------------------------------- the human's lifecycle commands

  /**
   * Approves the draft or the pending version. A pending version also requeues the tickets whose worker never started,
   * sends the tickets whose reviewer bb refused back to review, and tells the planner.
   */
  async approve(slug: string, actor: string, version?: number, opts: { skipReview?: boolean } = {}): Promise<Approved> {
    const { store, bb } = this.ctx;
    const waiting = store.projectBySlug(slug);
    if (waiting !== null && opts.skipReview !== true) {
      const refusal = approvalRefusal(slug, specReviewStatus(store, waiting), waiting.state !== "draft");
      if (refusal !== null) throw refusal;
    }
    const result = await this.projects.approve(slug, actor, version);
    const project = store.projectBySlug(slug)!;
    await endSpecReviews(this.ctx, project.id, result.version);
    if (result.applied !== "pending") return { ...result, requeued: [], backToReview: [] };
    const requeued: string[] = [];
    const sentBack: string[] = [];
    for (const ticket of store.tickets(project.id, ["blocked"])) {
      if (blockedAtStart(store, ticket)) {
        await requeueTicket(this.ctx, ticket.key, { note: startRequeueNote(result.version), actor: LOOM_ACTOR, author: "loom" });
        requeued.push(ticket.key);
      } else if (blockedAtReview(ticket)) {
        backToReview(this.ctx, ticket, reviewRequeueNote(result.version));
        sentBack.push(ticket.key);
      }
    }
    const stillBlocked = store.tickets(project.id, ["blocked"]).map((ticket) => ticket.key);
    const planner = store.threads({ projectId: project.id, role: "planner", states: ["active"] })[0];
    if (planner?.thread_id != null) {
      await bb
        .send(planner.thread_id, approvedText({ slug, version: result.version, requeued, backToReview: sentBack, stillBlocked }))
        .catch((error) => this.warn(`tell ${planner.thread_id} about the approval`, error));
    }
    this.kick();
    return { ...result, requeued, backToReview: sentBack };
  }

  /** Creates the integration branch in every repo's checkout, then starts the project. Refused, with the project left ready, when that cannot be done. */
  async start(slug: string, actor: string): Promise<ProjectRow> {
    const project = this.ctx.store.projectBySlug(slug);
    if (project?.state === "ready") await this.prepare(project);
    const started = await this.projects.start(slug, actor);
    this.kick();
    return started;
  }

  // Every checkout is found before any branch is made, so a missing one leaves every repo as it was.
  private async prepare(project: ProjectRow): Promise<void> {
    const spec = specOf(this.ctx.store, project);
    const names = isMultiRepo(spec) ? spec.repo!.map((repo) => repo.name) : [null];
    const checkouts: RepoCheckout[] = [];
    const missing: string[] = [];
    for (const name of names) {
      try {
        checkouts.push(await repoCheckout(this.ctx, project, spec, name));
      } catch (error) {
        if (!(error instanceof LoomError)) throw error;
        // repoCheckout's advice is for a running project; a ready one is started again, not resumed.
        missing.push(error.message.replace(/then resume\.$/u, "then start the project again."));
      }
    }
    if (missing.length > 0) throw new LoomError("loom_no_checkout", missing.join("\n"));
    if (spec.merge.strategy !== "integration") return;
    for (const checkout of checkouts) {
      const { name, branch, base } = checkout.settings;
      try {
        await this.ctx.host.call(checkout.hostId, "ensureBranch", { repo: checkout.path, branch: branch!, from: base });
      } catch (error) {
        const where = name === null ? "" : ` in the repo "${name}"`;
        throw new LoomError("loom_invalid_state", `Could not create the integration branch ${branch!}${where} from ${base}: ${errText(error)}`, `Check that ${base} exists in ${checkout.path}.`);
      }
    }
  }

  async pause(slug: string, actor: string, now: boolean): Promise<ProjectRow> {
    const project = await this.projects.pause(slug, actor, { now });
    if (now) {
      for (const row of this.ctx.store.threads({ projectId: project.id, role: "worker", states: ["active"] })) {
        // A worker coming back from a release runs no turn; stopping it would stop its restore.
        if (row.released_at !== null) continue;
        await this.ctx.bb.stop(row.thread_id!).catch((error) => this.warn(`stop ${row.thread_id}`, error));
      }
    }
    this.kick();
    return project;
  }

  async resume(slug: string, actor: string): Promise<ProjectRow> {
    const { store, bb, now } = this.ctx;
    const project = await this.projects.resume(slug, actor);
    for (const row of store.threads({ projectId: project.id, role: "worker", states: ["active"] })) {
      const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
      // A hand-back not sent yet is the worker's next turn, which the tick sends once it has a worker slot.
      if (ticket?.state !== "working" || row.released_at !== null || ticket.handback_json !== null) continue;
      store.updateThread(row.id, { clock_at: now() });
      const thread = await bb.getThread(row.thread_id!).catch(() => null);
      if (thread !== null && ["active", "starting", "pending"].includes(thread.status)) continue;
      await bb.send(row.thread_id!, resumeText(ticket.key, heldCheckResult(store.posts(ticket.id)))).catch((error) => this.warn(`resume ${row.thread_id}`, error));
    }
    await resumePrAsks(this.ctx, project.id);
    this.kick();
    return project;
  }

  async archive(slug: string, actor: string): Promise<ProjectRow> {
    const project = await this.projects.archive(slug, actor);
    await endSpecReviews(this.ctx, project.id);
    for (const row of this.ctx.store.threads({ projectId: project.id, states: ["active"] })) {
      if (row.role !== "planner") await endThread(this.ctx, row, "cancelled", { commit: false, move: null });
    }
    this.kick();
    return project;
  }

  // ---------------------------------------------------------------- the human's ticket commands

  /** With `review`, the ticket goes back as it is: to review for the commit whose checks passed, or to its open pull request. */
  async requeue(key: string, note: string, actor: string, opts: { review?: boolean } = {}): Promise<TicketRow> {
    const ticket = await requeueTicket(this.ctx, key, { note, actor, author: "human", ...(opts.review === true ? { review: true } : {}) });
    this.kick();
    return ticket;
  }

  /**
   * Runs a human block or cancel under the project's merge guard, so no ticket can enter merging halfway through it. A
   * merge that runs holds the guard, so a ticket in merging here waits, after a failure or a pause, and may be stopped.
   */
  private async whileNoMergeRuns<T>(key: string, what: string, fn: () => Promise<T>): Promise<T> {
    const ticket = this.ctx.store.ticketByKey(key);
    const release = ticket === null ? () => undefined : holdMerge(this.ctx, ticket.project_id);
    if (release === null) throw new LoomError("loom_invalid_state", `Cannot ${what} ${key}: a merge is running; try again in a moment.`);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async block(key: string, reason: string, actor: string): Promise<TicketRow> {
    const blocked = await this.whileNoMergeRuns(key, "block", async () => {
      const ticket = this.ctx.store.ticketByKey(key);
      if (ticket === null) throw new LoomError("loom_not_found", `No ticket ${key}.`, "Run `bb loom tickets <slug>` to see the ticket keys.");
      const text = reason.trim();
      if (text === "") throw new LoomError("loom_invalid_input", "The block reason is empty.");
      if (!canMoveTicket(ticket.state, "blocked")) throw new LoomError("loom_invalid_state", `${key} is ${ticket.state}; it cannot be blocked.`);
      if (ticket.state === "merging") await stopMerge(this.ctx, ticket);
      await blockTicket(this.ctx, this.ctx.store.ticket(ticket.id)!, { reason: text, needs: "", actor });
      return this.ctx.store.ticket(ticket.id)!;
    });
    this.kick();
    return blocked;
  }

  async cancel(key: string, reason: string, actor: string): Promise<TicketRow> {
    const ticket = await this.whileNoMergeRuns(key, "cancel", async () => {
      const seen = this.ctx.store.ticketByKey(key);
      if (seen?.state === "merging") await stopMerge(this.ctx, seen);
      return cancelTicket(this.ctx, key, reason, actor, seen?.state === "merging");
    });
    this.kick();
    return ticket;
  }

  /** The human's land: push the integration branch and open or update its one pull request, or with `direct` push it to the base branch. A multi-repo project lands every repo with merged work, or only `repo`. */
  async land(slug: string, actor: string, opts: { title?: string; ready: boolean; direct?: boolean; repo?: string }): Promise<LandResult> {
    const result = await land(this.ctx, slug, { actor, ...opts });
    this.kick();
    return result;
  }

  /**
   * The human's sync: the project's open pull requests, or only `key`'s, are read in the next pass instead of at their next
   * poll (pr-sync.ts). Waits up to `waitMs` for that pass, then says what each read found or that it is still going.
   */
  async syncPullRequests(slug: string, opts: { key?: string; waitMs?: number } = {}): Promise<PrSyncResult> {
    const request = requestSync(this.ctx, slug, opts.key);
    const finished = request.tickets.length === 0 || (await within(this.tick(), opts.waitMs ?? SYNC_WAIT_MS));
    return syncResult(this.ctx, request, finished);
  }

  /** The human's Mark live on a rollout step or milestone, or its undo. Deploy order is advice, so nothing else moves. */
  markLive(slug: string, target: string, opts: { note?: string; undo?: boolean }, actor: string): RolloutMarkRow | null {
    return markLiveByHuman(this.ctx, slug, target, opts, actor);
  }

  /** The human's `report --send`: queues a finished project's record for the done hook again. */
  sendRecord(slug: string): ProjectRow {
    const project = this.projects.require(slug);
    if (project.state !== "done") throw new LoomError("loom_invalid_state", `Project ${slug} is ${project.state}; only a finished project's record goes to the done hook.`, `Print the record with \`bb loom report ${slug}\`.`);
    if (this.settings().doneHook.trim() === "") {
      throw new LoomError("loom_invalid_state", "No done hook is set, so there is nowhere to send the record.", "Set one in Loom's settings, or with `bb plugin config loom set doneHook '<command>'`.");
    }
    const row = this.ctx.store.record(project.id);
    if (row?.state === "summarizing" || row?.state === "sending") throw new LoomError("loom_invalid_state", `The record of ${slug} is being sent now; the feed says when it is done.`);
    this.ctx.store.queueRecord(project.id);
    this.kick();
    return project;
  }

  /**
   * The human's reply on a ticket. A worker that holds the ticket gets it as a message too, with the work going back to it
   * when that is not sent yet (it waits for a worker slot); on a blocked ticket, the planner does.
   */
  async humanPost(key: string, body: string, parentId?: number): Promise<PostRow> {
    const { store, bb } = this.ctx;
    const post = this.projects.post(key, { body, parentId, author: "human" });
    const ticket = store.ticketByKey(key)!;
    if (await humanFixRound(this.ctx, ticket, post)) return post;
    const where = parentId === undefined ? "" : ` (answering #${parentId})`;
    const message = { summary: `[loom] Reply on ${key} from the human`, detail: `${post.body}${where}` };
    const to = replyRecipient(store, ticket);
    if (to?.role === "planner") {
      await bb.send(to.threadId, blockedReplyText(key, `${post.body}${where}`)).catch((error) => this.warn(`reply to ${to.threadId}`, error));
    } else if (!holdForWorker(store, ticket, message) && to?.role === "worker") {
      await bb.send(to.threadId, message).catch((error) => this.warn(`reply to ${to.threadId}`, error));
    }
    this.kick();
    return post;
  }

  /** The human's message to a planner from the Loom page: sent to its thread as their own words, and kept for the Planner page. */
  async messagePlanner(threadId: string, text: string): Promise<void> {
    const { store, bb } = this.ctx;
    const row = store.threadByThreadId(threadId);
    const planning = store.planning(threadId);
    const live = (row?.role === "planner" && row.state === "active") || (row === null && planning !== null && planning.ended_at === null);
    if (!live) throw new LoomError("loom_invalid_state", "This thread is not a live Loom planner, so there is no one to message.");
    const body = text.trim();
    if (body === "") throw new LoomError("loom_invalid_input", "The message is empty.");
    await bb.send(threadId, body);
    store.addPlannerLog({ thread_id: threadId, author: "human", text: body }, row?.project_id ?? null);
  }

  // ---------------------------------------------------------------- bb's events

  /** `lastText` is the turn's last assistant text, which the Planner page shows for a planner thread. */
  async onThreadIdle(threadId: string, lastText: string | null = null): Promise<void> {
    const { store } = this.ctx;
    const row = store.threadByThreadId(threadId);
    const review = row === null ? store.specReviewByThreadId(threadId) : null;
    if (review !== null) return onSpecReviewerIdle(this.ctx, review);
    const planning = row === null ? store.planning(threadId) : null;
    if ((row?.role === "planner" && row.state === "active") || (planning !== null && planning.ended_at === null)) recordPlannerTurn(store, threadId, row?.project_id ?? null, lastText);
    if (row === null || row.state !== "active") return;
    // The idle that ends a restore: the tick gives the worker its environment and its fix round (advanceWakes).
    if (row.released_at !== null) return this.kick();
    if (row.role !== "planner") startedFine(this.ctx, row);
    if (row.role === "planner") onPlannerIdle(this.ctx, row);
    else if (row.role === "worker") {
      if (!(await onPrWriterIdle(this.ctx, row))) await onWorkerIdle(this.ctx, row);
    }
    else await onReviewerIdle(this.ctx, row);
    this.kick();
  }

  /** A failed turn follows `thread.failed` for the same failure and decides what happens; this only wakes the loop. */
  async onThreadFailed(threadId: string): Promise<void> {
    if (this.ctx.store.threadByThreadId(threadId) !== null) this.kick();
  }

  async onThreadGone(threadId: string, why: "archived" | "deleted"): Promise<void> {
    this.projects.planningGone(threadId, why);
    const row = this.ctx.store.threadByThreadId(threadId);
    const review = row === null ? this.ctx.store.specReviewByThreadId(threadId) : null;
    if (review !== null) return onSpecReviewerGone(this.ctx, review);
    if (row === null) return;
    if (row.role === "reviewer") await onReviewerGone(this.ctx, row);
    else if (row.role === "worker") await endGoneThread(this.ctx, threadId);
    else if (why === "deleted") this.projects.threadGone(threadId, why);
    this.kick();
  }

  async onTurnFailed(event: TurnFailure): Promise<void> {
    const review = this.ctx.store.specReviewByThreadId(event.threadId);
    if (review !== null) return onSpecReviewerTurnFailed(this.ctx, review, event);
    if (this.ctx.store.threadByThreadId(event.threadId)?.role === "reviewer") await onReviewerTurnFailed(this.ctx, event);
    else await handleTurnFailed(this.ctx, event);
    this.kick();
  }
}
