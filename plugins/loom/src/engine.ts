// The engine: a control loop that works every running project, the human's commands on the engine's state, and
// the handlers for bb's thread events. Behavior lives in workers.ts, checks.ts and triage.ts; this wires it together.
import { resumeCheckingTickets } from "./checks";
import { finishIfComplete, holdMerge, land, pollPullRequests, runMergeQueue } from "./merge";
import type { PostRow, ProjectRow, ThreadRow, TicketRow } from "./db/store";
import { heldCheckResult, resumeText } from "./prompts";
import { LoomError, type Projects } from "./projects";
import { failReviewerSpawn, onReviewerGone, onReviewerIdle, onReviewerTurnFailed, spawnReviewers } from "./review";
import { budgetReason, spawnable, toLite } from "./scheduler";
import { canMoveTicket } from "./states";
import { cancelTicket, maybeSendTriage, onPlannerIdle } from "./triage";
import {
  blockTicket,
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
  type EngineCtx,
  type TurnFailure,
} from "./workers";

const TOKEN_REFRESH_MS = 60_000;
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type EngineDeps = Omit<EngineCtx, "kick"> & { projects: Projects };

export class Engine {
  readonly ctx: EngineCtx;
  private readonly projects: Projects;
  private disposed = false;
  private currentTick: Promise<void> | null = null;
  private tickAgain = false;

  constructor(deps: EngineDeps) {
    this.projects = deps.projects;
    this.ctx = { store: deps.store, bb: deps.bb, now: deps.now, host: deps.host, kick: () => this.kick() };
  }

  private warn(what: string, error: unknown): void {
    if (!this.disposed) this.ctx.bb.log("warn", `${what}: ${errText(error)}`);
  }

  // ---------------------------------------------------------------- the control loop

  kick(): void {
    void this.tick().catch((error) => this.warn("tick", error));
  }

  /** One pass over every running project. Concurrent callers share a pass; a kick during a pass makes another one. */
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
    for (const project of store.projects()) {
      if (this.disposed) return;
      if (project.state !== "running" && project.state !== "paused") continue;
      try {
        if (project.state === "running") await this.tickProject(project.id);
        else await this.tickPaused(project.id);
      } catch (error) {
        this.warn(`project ${project.slug}`, error);
      }
    }
  }

  // A paused project starts no worker, reviewer or merge; it still follows its open pull requests and finishes when the last one is done.
  private async tickPaused(projectId: number): Promise<void> {
    const project = this.ctx.store.project(projectId);
    if (project?.state !== "paused") return;
    await pollPullRequests(this.ctx, project);
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
        if (ticket?.state !== "working" || ticket.worker_thread_id !== row.thread_id) continue;
        await endThread(this.ctx, row, "timeout", { commit: true });
      }
      if (running() === null) return;
      await runMergeQueue(this.ctx, running()!, spec);
      if (running() === null) return;
      await spawnReviewers(this.ctx, running()!, spec);
      if (running() === null) return;
      await this.spawnReady(projectId);
    }

    const current = store.project(projectId)!;
    if (current.state === "running" || current.state === "paused") {
      await pollPullRequests(this.ctx, current);
      finishIfComplete(this.ctx, store.project(projectId)!);
    }
    await maybeSendTriage(this.ctx, store.project(projectId)!);
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
  private async spawnReady(projectId: number): Promise<void> {
    const { store, now } = this.ctx;
    const next = (tried: ReadonlySet<number>) => {
      const project = store.project(projectId);
      if (project?.state !== "running" || (project.hold_until !== null && project.hold_until > now())) return null;
      const spec = specOf(store, project);
      // A worker's worktree branches from the integration branch's tip, so none starts while a merge there has not passed its checks.
      if (spec.merge.strategy === "integration" && store.tickets(projectId, ["merging"]).length > 0) return null;
      const lite = spawnable(spec.agents.max_workers, store.tickets(projectId).map(toLite)).find((candidate) => !tried.has(candidate.id));
      return lite === undefined ? null : { project, spec, ticket: store.ticket(lite.id)! };
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
      await spawnWorker(this.ctx, pick.project, pick.spec, pick.ticket);
    }
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
        if (row.role === "reviewer") failReviewerSpawn(this.ctx, row, "The plugin restarted before the reviewer started.");
        else await failSpawn(this.ctx, row, "The plugin restarted before the worker started.");
        rolledBack += 1;
      } else {
        await this.adopt(row, threadId);
        adopted += 1;
      }
    }
    for (const row of store.threads({ states: ["active"] })) {
      if (row.thread_id === null) continue;
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
  }

  // ---------------------------------------------------------------- the human's lifecycle commands

  /** Creates the integration branch in the project's checkout, then starts the project. Refused, with nothing changed, when that cannot be done. */
  async start(slug: string, actor: string): Promise<ProjectRow> {
    const project = this.ctx.store.projectBySlug(slug);
    if (project?.state === "ready") await this.prepare(project);
    const started = await this.projects.start(slug, actor);
    this.kick();
    return started;
  }

  private async prepare(project: ProjectRow): Promise<void> {
    const spec = specOf(this.ctx.store, project);
    const checkout = project.host_id === null ? null : await this.ctx.bb.projectCheckout(project.bb_project_id, project.host_id);
    if (project.host_id === null || checkout === null) {
      throw new LoomError("loom_no_checkout", `The bb project has no checkout on the machine ${project.host_id ?? "(unknown)"} that this Loom project uses.`, "Add the repository to the bb project on that machine, then start again.");
    }
    if (spec.merge.strategy !== "integration") return;
    const branch = spec.merge.branch!;
    try {
      await this.ctx.host.call(project.host_id, "ensureBranch", { repo: checkout, branch, from: spec.project.base });
    } catch (error) {
      throw new LoomError("loom_invalid_state", `Could not create the integration branch ${branch} from ${spec.project.base}: ${errText(error)}`, `Check that ${spec.project.base} exists in ${checkout}.`);
    }
  }

  async pause(slug: string, actor: string, now: boolean): Promise<ProjectRow> {
    const project = await this.projects.pause(slug, actor, { now });
    if (now) {
      for (const row of this.ctx.store.threads({ projectId: project.id, role: "worker", states: ["active"] })) {
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
      if (ticket?.state !== "working") continue;
      store.updateThread(row.id, { clock_at: now() });
      const thread = await bb.getThread(row.thread_id!).catch(() => null);
      if (thread !== null && ["active", "starting", "pending"].includes(thread.status)) continue;
      await bb.send(row.thread_id!, resumeText(ticket.key, heldCheckResult(store.posts(ticket.id)))).catch((error) => this.warn(`resume ${row.thread_id}`, error));
    }
    this.kick();
    return project;
  }

  async archive(slug: string, actor: string): Promise<ProjectRow> {
    const project = await this.projects.archive(slug, actor);
    for (const row of this.ctx.store.threads({ projectId: project.id, states: ["active"] })) {
      if (row.role !== "planner") await endThread(this.ctx, row, "cancelled", { commit: false, move: null });
    }
    this.kick();
    return project;
  }

  // ---------------------------------------------------------------- the human's ticket commands

  async requeue(key: string, note: string, actor: string): Promise<TicketRow> {
    const ticket = await requeueTicket(this.ctx, key, { note, actor, author: "human" });
    this.kick();
    return ticket;
  }

  /** Runs a human block or cancel under the project's merge guard, so no ticket can enter merging halfway through it. */
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
      if (ticket.state === "merging") throw new LoomError("loom_invalid_state", `${key} is merging; try again when the merge finishes.`);
      if (!canMoveTicket(ticket.state, "blocked")) throw new LoomError("loom_invalid_state", `${key} is ${ticket.state}; it cannot be blocked.`);
      await blockTicket(this.ctx, ticket, { reason: text, needs: "", actor });
      return this.ctx.store.ticket(ticket.id)!;
    });
    this.kick();
    return blocked;
  }

  async cancel(key: string, reason: string, actor: string): Promise<TicketRow> {
    const ticket = await this.whileNoMergeRuns(key, "cancel", () => cancelTicket(this.ctx, key, reason, actor));
    this.kick();
    return ticket;
  }

  /** The human's land: push the integration branch and open or update its one pull request. */
  async land(slug: string, actor: string, opts: { title?: string; ready: boolean }): Promise<{ url: string; done: boolean }> {
    const result = await land(this.ctx, slug, { actor, ...opts });
    this.kick();
    return result;
  }

  /** The human's reply on a ticket. A worker that holds the ticket gets it as a message too. */
  async humanPost(key: string, body: string, parentId?: number): Promise<PostRow> {
    const { store, bb } = this.ctx;
    const post = this.projects.post(key, { body, parentId, author: "human" });
    const ticket = store.ticketByKey(key)!;
    const worker = ticket.state === "working" && ticket.worker_thread_id !== null ? store.threadByThreadId(ticket.worker_thread_id) : null;
    if (worker?.state === "active" && worker.thread_id !== null) {
      const where = parentId === undefined ? "" : ` (answering #${parentId})`;
      await bb.send(worker.thread_id, { summary: `[loom] Reply on ${key} from the human`, detail: `${post.body}${where}` }).catch((error) => this.warn(`reply to ${worker.thread_id}`, error));
    }
    this.kick();
    return post;
  }

  // ---------------------------------------------------------------- bb's events

  async onThreadIdle(threadId: string): Promise<void> {
    const row = this.ctx.store.threadByThreadId(threadId);
    if (row === null || row.state !== "active") return;
    if (row.role === "planner") onPlannerIdle(this.ctx, row);
    else if (row.role === "worker") await onWorkerIdle(this.ctx, row);
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
    if (row === null) return;
    if (row.role === "reviewer") await onReviewerGone(this.ctx, row);
    else if (row.role === "worker") await endGoneThread(this.ctx, threadId);
    else if (why === "deleted") this.projects.threadGone(threadId, why);
    this.kick();
  }

  async onTurnFailed(event: TurnFailure): Promise<void> {
    if (this.ctx.store.threadByThreadId(event.threadId)?.role === "reviewer") await onReviewerTurnFailed(this.ctx, event);
    else await handleTurnFailed(this.ctx, event);
    this.kick();
  }
}
