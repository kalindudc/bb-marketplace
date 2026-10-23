// The worker lifecycle: spawn a worker for a ticket, nudge or end it when it stalls, block and requeue tickets,
// and end any worker or reviewer thread in one place (endThread). Every state change goes through the store.
import { randomBytes } from "node:crypto";
import { repoCheckout, ticketRepo } from "./checkouts";
import type { ProjectRow, Store, ThreadRow, TicketRow } from "./db/store";
import { spawnEnvironment, threadBranch } from "./environments";
import { plural } from "./format";
import { SpawnRefusedError, type EnvironmentInfo, type HostPort } from "./ports";
import { latestChangesRequested, nudgeText, workerBrief } from "./prompts";
import { LoomError, type Ctx } from "./projects";
import { freshBaseOf } from "./repos";
import { idleAction, spawnable, toLite, type TicketLite } from "./scheduler";
import type { Spec } from "./spec";
import { HUMAN_ACTOR, LOOM_ACTOR, PAUSE_NOW_REASON, canMoveTicket, type AuthorKind, type TicketState } from "./states";

export interface EngineCtx extends Ctx {
  host: HostPort;
  kick(): void;
}

export type EndReason = "abandoned" | "timeout" | "failed" | "gone" | "blocked" | "cancelled" | "verdict" | "superseded" | "merged";
export type TicketMove = { to: TicketState; patch: Partial<TicketRow> };

const ENDING_LIMIT_MS = 10 * 60_000;
export const MAX_RATE_LIMIT_RETRIES = 3;
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function specOf(store: Store, project: ProjectRow): Spec {
  const row = project.approved_version === null ? null : store.specVersion(project.id, project.approved_version);
  if (row === null) throw new LoomError("loom_invalid_state", `Project ${project.slug} has no approved spec.`);
  return JSON.parse(row.spec_json) as Spec;
}

/** Where a worker's branch starts in `repo`, the Loom project's own repository for null, when no earlier worker left one. */
export function freshBase(spec: Spec, repo: string | null = null): string {
  return freshBaseOf(spec, repo);
}

// ---------------------------------------------------------------- ticket moves

export const released = { worker_thread_id: null, environment_id: null } as const;

export function ticketMoveFor(reason: EndReason, ticket: TicketRow, spec: Spec): TicketMove | null {
  const live = ticket.state === "working" || ticket.state === "checking";
  switch (reason) {
    case "abandoned":
    case "timeout":
    case "failed": {
      if (!live) return null;
      const failures = ticket.failures + 1;
      if (failures < spec.budget.max_attempts) return { to: "queued", patch: { ...released, failures } };
      const last = { abandoned: "it went idle twice without submitting", timeout: "it ran past the ticket timeout", failed: "its turns kept failing" }[reason];
      return { to: "blocked", patch: { ...released, failures, blocked_reason: `The worker failed ${plural(failures, "time")}; the last time ${last}.` } };
    }
    case "gone":
      return live ? { to: "queued", patch: released } : null;
    case "blocked":
      return canMoveTicket(ticket.state, "blocked") ? { to: "blocked", patch: { ...released, blocked_reason: ticket.blocked_reason ?? "Blocked." } } : null;
    case "cancelled":
      return canMoveTicket(ticket.state, "cancelled") ? { to: "cancelled", patch: released } : null;
    case "verdict":
    case "superseded":
    case "merged":
      return null;
  }
}

/** Pauses a running project with a reason the human reads, and flags it so the planner hears why. */
export function pauseProject(ctx: EngineCtx, projectId: number, reason: string): void {
  const { store } = ctx;
  const project = store.project(projectId);
  if (project?.state !== "running") return;
  store.tx(() => {
    store.setProjectState(projectId, "paused", LOOM_ACTOR, reason);
    store.updateProject(projectId, { triage_pending: 1 });
  });
  store.changed(project.id);
}

/** Moves the ticket, applies the patch and flags a blocked ticket for triage, in one transaction. False when the state map refuses the move. */
export function applyMove(ctx: EngineCtx, ticket: TicketRow, move: TicketMove, actor: string = LOOM_ACTOR, data: object = {}): boolean {
  return ctx.store.tx(() => {
    const current = ctx.store.ticket(ticket.id);
    if (current === null || !canMoveTicket(current.state, move.to)) return false;
    ctx.store.setTicketState(current.id, move.to, actor, move.patch.failures === undefined ? data : { ...data, failures: move.patch.failures });
    ctx.store.updateTicket(current.id, move.patch);
    if (move.to === "blocked") ctx.store.updateProject(current.project_id, { triage_pending: 1 });
    return true;
  });
}

/** Puts a ticket back in working and restarts its worker's timeout clock and idle count. Paused time and time in checks or review never count. */
export function toWorking(ctx: EngineCtx, ticket: TicketRow, row: ThreadRow | null, data: object = {}): void {
  ctx.store.tx(() => {
    ctx.store.setTicketState(ticket.id, "working", LOOM_ACTOR, data);
    if (row !== null) ctx.store.updateThread(row.id, { clock_at: ctx.now(), idle_count: 0 });
  });
}

// ---------------------------------------------------------------- spawn

const isRefError = (error: unknown) => /\bref(erence)?s?\b|revision|not a valid object|unknown branch/iu.test(errText(error));

/** `waiting` holds back tickets that may not start now, as it did when the caller picked this one. */
export async function spawnWorker(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, waiting?: (ticket: TicketLite) => boolean): Promise<void> {
  const { store } = ctx;
  const token = randomBytes(12).toString("hex");
  const fromBranch = ticket.branch !== null;
  const resume = ticket.attempt > 0;

  // The final eligibility check and the claim share one synchronous transaction, so nothing can change between them.
  const row = store.tx(() => {
    const current = store.ticket(ticket.id);
    if (current === null || current.state !== "queued") return null;
    const fresh = store.project(project.id);
    if (fresh === null) return null;
    const tickets = store.tickets(project.id).map(toLite);
    if (!spawnable(specOf(store, fresh).agents.max_workers, tickets, waiting).some((lite) => lite.id === ticket.id)) return null;
    const attempt = current.attempt + 1;
    const created = store.addThread({ project_id: project.id, ticket_id: ticket.id, role: "worker", state: "spawning", spawn_token: token });
    store.updateThread(created.id, { clock_at: ctx.now(), attempt });
    store.setTicketState(ticket.id, "working", LOOM_ACTOR, { attempt });
    store.updateTicket(ticket.id, { attempt, ...released });
    store.addPost({ project_id: project.id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "claim", body: `Worker attempt ${attempt} is starting.` });
    return store.thread(created.id)!;
  });
  if (row === null) return;

  if (store.project(project.id)?.state !== "running") {
    store.tx(() => {
      store.updateThread(row.id, { state: "ended", ended_at: ctx.now(), end_reason: "cancelled" });
      store.setTicketState(ticket.id, "queued", LOOM_ACTOR, { reason: "the project is no longer running" });
      store.updateTicket(ticket.id, { attempt: ticket.attempt });
    });
    return;
  }

  const agent = spec.agents.worker;
  let spawned;
  try {
    const repo = ticketRepo(spec, ticket);
    const checkouts = await otherCheckouts(ctx, project, spec, ticket);
    const brief = workerBrief({ project, spec, ticket: store.ticket(ticket.id)!, posts: store.posts(ticket.id), resume, checkouts });
    const spawn = (baseBranch: string) =>
      ctx.bb.spawnThread({
        bbProjectId: repo.bbProjectId ?? project.bb_project_id,
        hostId: project.host_id!,
        baseBranch,
        environment: spawnEnvironment(repo, { branch: threadBranch(project.slug, ticket.key, String(row.attempt)), base: baseBranch }),
        title: `${ticket.key} · ${ticket.title}`,
        prompt: brief,
        sectionId: project.section_id,
        metadata: { project: project.slug, role: "worker", ticket: ticket.key, spawnToken: token },
        providerId: agent.provider,
        model: agent.model,
        reasoningLevel: agent.reasoning,
        permissionMode: agent.permission_mode,
      });
    const base = ticket.branch ?? freshBase(spec, ticket.repo);
    try {
      spawned = await spawn(base);
    } catch (error) {
      if (fromBranch || spec.merge.strategy !== "pr" || !isRefError(error)) throw error;
      spawned = await spawn(repo.base);
    }
  } catch (error) {
    await failSpawn(ctx, row, errText(error), { refused: error instanceof SpawnRefusedError });
    return;
  }

  const active = store.tx(() => {
    const current = store.thread(row.id)!;
    if (current.state !== "spawning") return null;
    store.updateThread(row.id, { state: "active", environment_id: spawned.environmentId, thread_id: current.thread_id ?? spawned.threadId });
    store.updateTicket(ticket.id, { worker_thread_id: store.thread(row.id)!.thread_id, environment_id: spawned.environmentId });
    return store.thread(row.id)!;
  });
  if (active === null) return;
  store.changed(project.id);

  const now = { ticket: store.ticket(ticket.id)!, project: store.project(project.id)! };
  if (now.ticket.state !== "working" || now.project.state === "archived") {
    await endThread(ctx, active, "cancelled", { commit: false, move: null });
  } else if (now.project.state === "paused" && now.project.system_reason === PAUSE_NOW_REASON) {
    await ctx.bb.stop(spawned.threadId).catch((error) => ctx.bb.log("warn", `Could not stop ${spawned.threadId} after pause --now: ${errText(error)}`));
  }
}

/** The checkout path of each other repo of the project on its machine, by repo name. A repo without a checkout is left out, so the brief lists it without a path. */
async function otherCheckouts(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow): Promise<Map<string, string>> {
  const others = (spec.repo ?? []).filter((repo) => repo.name !== ticket.repo);
  const found = await Promise.all(
    others.map(async ({ name }) => {
      try {
        return [name, (await repoCheckout(ctx, project, spec, name)).path] as const;
      } catch (error) {
        ctx.bb.log("warn", `${ticket.key}'s brief lists the repo "${name}" without a checkout path: ${errText(error)}`);
        return null;
      }
    }),
  );
  return new Map(found.filter((entry) => entry !== null));
}

/**
 * A worker that never started. The thread, when there is one, is archived. A ticket that was resumed from its branch
 * loses the branch and counts no failure, so the next try starts from the fresh base. A ticket bb refused blocks at once.
 */
export async function failSpawn(ctx: EngineCtx, row: ThreadRow, error: string, opts: { archive?: boolean; refused?: boolean } = {}): Promise<void> {
  const { store } = ctx;
  if (opts.archive === true && row.thread_id !== null) await ctx.bb.archive(row.thread_id).catch((e) => ctx.bb.log("warn", `Could not archive ${row.thread_id}: ${errText(e)}`));
  store.tx(() => {
    store.updateThread(row.id, { state: "ended", ended_at: ctx.now(), end_reason: "failed" });
    const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
    if (ticket === null || ticket.state !== "working") return;
    const project = store.project(ticket.project_id)!;
    store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "system", body: `Could not start a worker: ${error}` });
    if (ticket.branch !== null) {
      applyMove(ctx, ticket, { to: "queued", patch: { ...released, branch: null } }, LOOM_ACTOR, { reason: "the worker could not start from the earlier branch" });
      return;
    }
    const failures = ticket.failures + 1;
    if (opts.refused === true) {
      applyMove(ctx, ticket, { to: "blocked", patch: { ...released, failures, blocked_reason: `bb refused to start a worker: ${error}` } }, LOOM_ACTOR, { reason: START_REFUSED });
      return;
    }
    const blocked = failures >= specOf(store, project).budget.max_attempts;
    const move: TicketMove = blocked ? { to: "blocked", patch: { ...released, failures, blocked_reason: `could not start a worker ${plural(failures, "time")}` } } : { to: "queued", patch: { ...released, failures } };
    applyMove(ctx, ticket, move, LOOM_ACTOR, { reason: START_FAILED });
  });
  store.changed(row.project_id);
}

export const START_FAILED = "the worker could not start";
export const START_REFUSED = "bb refused to start the worker";

/** A blocked ticket whose last move to blocked came from a worker that never started. */
export function blockedAtStart(store: Store, ticket: TicketRow): boolean {
  if (ticket.state !== "blocked") return false;
  const last = store.ticketEvents(ticket.id, ["ticket.state"]).at(-1);
  if (last === undefined) return false;
  const data = JSON.parse(last.data_json) as { to?: string; reason?: string };
  return data.to === "blocked" && (data.reason === START_FAILED || data.reason === START_REFUSED);
}

// ---------------------------------------------------------------- branch and WIP commit

/**
 * The environment of a worker row. bb may attach it after `spawn` returned, so a row without one asks bb for the
 * thread's environment and keeps what it finds on the row and on the ticket the worker holds. It reads the row again,
 * because callers often hold an older snapshot. Null while bb has no environment for the thread.
 */
export async function resolveEnvironment(ctx: EngineCtx, seen: ThreadRow): Promise<EnvironmentInfo | null> {
  const { store } = ctx;
  const row = store.thread(seen.id) ?? seen;
  let environmentId = row.environment_id;
  if (environmentId === null && row.thread_id !== null) {
    const found = (await ctx.bb.getThread(row.thread_id))?.environmentId ?? null;
    if (found !== null) {
      store.tx(() => {
        store.updateThread(row.id, { environment_id: found });
        const held = row.ticket_id === null ? null : store.ticket(row.ticket_id);
        if (held !== null && held.worker_thread_id === row.thread_id) store.updateTicket(held.id, { environment_id: found });
      });
      environmentId = found;
    }
  }
  return environmentId === null ? null : ctx.bb.getEnvironment(environmentId);
}

/** Stores the worker's real branch on the ticket. Always runs before the thread is archived. */
export async function recordBranch(ctx: EngineCtx, row: ThreadRow): Promise<void> {
  if (row.role !== "worker" || row.ticket_id === null) return;
  const environment = await resolveEnvironment(ctx, row);
  if (environment?.branchName != null) ctx.store.updateTicket(row.ticket_id, { branch: environment.branchName });
}

export async function commitWip(ctx: EngineCtx, row: ThreadRow, message: string): Promise<void> {
  const environment = await resolveEnvironment(ctx, row);
  if (environment?.path == null) return;
  await ctx.host.call(environment.hostId, "commitAll", { worktree: environment.path, message });
}

// ---------------------------------------------------------------- ending a thread

const endingNow = new WeakMap<Store, Set<number>>();
const endingOf = (store: Store) => endingNow.get(store) ?? endingNow.set(store, new Set()).get(store)!;

/**
 * Ends a worker or reviewer thread: claim the row, record the branch and commit WIP, stop and archive the thread,
 * then free the ticket. False when another path already holds the row. When the stop is not confirmed the row stays
 * `ending` with the ticket reserved, and the tick retries through resumeEnding.
 */
export async function endThread(ctx: EngineCtx, row: ThreadRow, reason: EndReason, opts: { commit: boolean; move?: TicketMove | null }): Promise<boolean> {
  if (!ctx.store.claimThread(row.id, reason)) return false;
  await finishEnding(ctx, ctx.store.thread(row.id)!, reason, opts, false);
  return true;
}

/** Runs the ending again for a row left in `ending` by a restart or an unconfirmed stop. */
export async function resumeEnding(ctx: EngineCtx, row: ThreadRow): Promise<void> {
  const current = ctx.store.thread(row.id);
  if (current === null || current.state !== "ending") return;
  const force = ctx.now() - (current.ended_at ?? ctx.now()) > ENDING_LIMIT_MS;
  await finishEnding(ctx, current, current.end_reason as EndReason, { commit: current.role === "worker" }, force);
}

async function finishEnding(ctx: EngineCtx, row: ThreadRow, reason: EndReason, opts: { commit: boolean; move?: TicketMove | null }, force: boolean): Promise<void> {
  const { store } = ctx;
  const running = endingOf(store);
  if (running.has(row.id)) return;
  running.add(row.id);
  try {
    const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
    if (opts.commit && ticket !== null) {
      try {
        await recordBranch(ctx, row);
        await commitWip(ctx, row, `WIP ${ticket.key} (attempt ${ticket.attempt})`);
      } catch (error) {
        ctx.bb.log("warn", `Could not save ${ticket.key}'s work before ending its thread: ${errText(error)}`);
      }
    }
    if (!(await stopAndArchive(ctx, row, force))) return;

    store.tx(() => {
      const current = store.thread(row.id);
      if (current === null || current.state !== "ending") return;
      store.updateThread(row.id, { state: "ended", ended_at: ctx.now() });
      const held = row.ticket_id === null ? null : store.ticket(row.ticket_id);
      if (held === null) return;
      const own = row.role === "worker" && held.worker_thread_id === row.thread_id;
      const move = opts.move !== undefined ? opts.move : own ? ticketMoveFor(reason, held, specOf(store, store.project(held.project_id)!)) : null;
      if (move !== null) applyMove(ctx, held, move, LOOM_ACTOR, { reason });
    });
    store.changed(row.project_id);
    ctx.kick();
  } finally {
    running.delete(row.id);
  }
}

// True once the thread is confirmed stopped (or gone) and archived, or when the ten-minute limit forces it.
async function stopAndArchive(ctx: EngineCtx, row: ThreadRow, force: boolean): Promise<boolean> {
  const threadId = row.thread_id;
  if (threadId === null) return true;
  const tokens = await ctx.bb.threadTokens(threadId).catch(() => null);
  if (tokens !== null) ctx.store.updateThread(row.id, { tokens, tokens_at: ctx.now() });
  await ctx.bb.stop(threadId).catch((error) => ctx.bb.log("warn", `Could not stop ${threadId}: ${errText(error)}`));
  const thread = await ctx.bb.getThread(threadId).catch(() => undefined);
  if (thread === null || (thread?.deletedAt ?? null) !== null) return true;
  const stopped = thread !== undefined && thread.status !== "active" && thread.status !== "stopping";
  if (!stopped) {
    if (!force) return false;
    ctx.bb.log("warn", `Thread ${threadId} did not stop within ${ENDING_LIMIT_MS / 60_000} minutes; archiving it anyway.`);
  }
  await ctx.bb.archive(threadId).catch((error) => ctx.bb.log("warn", `Could not archive ${threadId}: ${errText(error)}`));
  return true;
}

// ---------------------------------------------------------------- idle, failed turns, vanished threads

/** The first idle of a worker whose ticket is working gets a nudge; the next one ends the worker. */
export async function onWorkerIdle(ctx: EngineCtx, seen: ThreadRow, reason: EndReason = "abandoned"): Promise<void> {
  const row = ctx.store.thread(seen.id);
  if (row === null || row.state !== "active" || row.role !== "worker" || row.thread_id === null) return;
  if (ctx.store.project(row.project_id)?.state !== "running") return;
  const ticket = row.ticket_id === null ? null : ctx.store.ticket(row.ticket_id);
  if (ticket === null || ticket.state !== "working" || ticket.worker_thread_id !== row.thread_id) return;
  if (idleAction(row.idle_count) === "nudge") {
    ctx.store.updateThread(row.id, { idle_count: row.idle_count + 1 });
    await ctx.bb.send(row.thread_id, nudgeText(ticket.key, latestChangesRequested(ctx.store.posts(ticket.id))));
  } else {
    await endThread(ctx, row, reason, { commit: true });
  }
}

export interface TurnFailure {
  threadId: string;
  requestId: string;
  attemptNumber: number;
  errorInfo: { category?: string | null } | null;
  rateLimits: { windows: Array<{ resetsAtMs: number | null; status?: string }> } | null;
}

/** A failed turn: rate limits are retried at the window's reset; anything else counts like an idle. */
export async function onTurnFailed(ctx: EngineCtx, event: TurnFailure): Promise<void> {
  const row = ctx.store.threadByThreadId(event.threadId);
  if (row === null || row.state !== "active") return;
  const project = ctx.store.project(row.project_id);
  if (project === null) return;
  if (event.errorInfo?.category === "rate-limit") {
    if (row.role !== "planner" && project.state !== "running") return;
    if (await retryRateLimited(ctx, row, project, event)) return;
  }
  if (row.role !== "worker") return;

  if (event.errorInfo?.category !== "rate-limit") {
    const failure = await ctx.bb.latestSystemError(event.threadId).catch(() => null);
    if (failure?.code === "thread_provisioning_failed") {
      if (ctx.store.claimThread(row.id, "failed")) await failSpawn(ctx, ctx.store.thread(row.id)!, failure.message, { archive: true });
      return;
    }
  }
  await onWorkerIdle(ctx, row, "failed");
}

/** When to retry a rate-limited turn: 15 seconds after the blocking window resets, else a minute per attempt. */
export function rateLimitRetryAt(now: number, event: TurnFailure): number {
  const windows = event.rateLimits?.windows ?? [];
  const blocked = windows.filter((window) => window.status === "blocked" && window.resetsAtMs !== null).map((window) => window.resetsAtMs!);
  const any = windows.filter((window) => window.resetsAtMs !== null).map((window) => window.resetsAtMs!);
  const reset = blocked.length > 0 ? Math.max(...blocked) : any.length > 0 ? Math.min(...any) : null;
  return reset !== null && reset > now ? reset + 15_000 : now + 60_000 * Math.max(1, event.attemptNumber);
}

// True when a retry was queued; false when the row used up its retries and the failure should be handled like any other.
export async function retryRateLimited(ctx: EngineCtx, row: ThreadRow, project: ProjectRow, event: TurnFailure): Promise<boolean> {
  if (row.rate_limit_retries >= MAX_RATE_LIMIT_RETRIES || event.attemptNumber > MAX_RATE_LIMIT_RETRIES) {
    ctx.bb.log("warn", `Thread ${event.threadId} stayed rate limited after ${row.rate_limit_retries} retries.`);
    return false;
  }
  const sendAt = rateLimitRetryAt(ctx.now(), event);
  await ctx.bb.retryTurn(event.threadId, event.requestId, sendAt);
  ctx.store.updateThread(row.id, { rate_limit_retries: row.rate_limit_retries + 1 });
  ctx.store.updateProject(project.id, { hold_until: Math.max(project.hold_until ?? 0, sendAt) });
  ctx.store.event(project.id, row.ticket_id, "turn.retry", LOOM_ACTOR, { thread: event.threadId, attempt: event.attemptNumber, sendAt });
  return true;
}

/** The human archived or deleted a worker or reviewer thread. Its ticket goes back to the queue with no failure counted. */
export async function onThreadGone(ctx: EngineCtx, threadId: string): Promise<void> {
  const row = ctx.store.threadByThreadId(threadId);
  if (row === null || row.state !== "active" || row.role === "planner") return;
  await endThread(ctx, row, "gone", { commit: true });
}

// ---------------------------------------------------------------- block and requeue

/**
 * Blocks a ticket. Its live rows end first; the worker's own row carries the move to blocked, so the ticket is freed
 * only once that thread has stopped. `actor` is the worker's thread id, or "human".
 */
export async function blockTicket(ctx: EngineCtx, ticket: TicketRow, a: { reason: string; needs: string; actor: string }): Promise<void> {
  const reason = a.reason.trim();
  const needs = a.needs.trim();
  const text = needs === "" ? reason : `${reason.replace(/[.\s]+$/, "")}. Needs: ${needs}`;
  const human = a.actor === HUMAN_ACTOR;
  ctx.store.tx(() => {
    ctx.store.updateTicket(ticket.id, { blocked_reason: text });
    ctx.store.addPost({
      project_id: ticket.project_id,
      ticket_id: ticket.id,
      parent_id: null,
      author_kind: human ? "human" : "worker",
      author_thread_id: human ? null : a.actor,
      kind: "block",
      body: text,
      data_json: JSON.stringify({ reason, needs }),
    });
  });
  await endLiveRows(ctx, ticket, "blocked");
  ctx.kick();
}

/** Ends every live row of a ticket for a block or a cancel, then moves the ticket if no worker thread still holds it. */
export async function endLiveRows(ctx: EngineCtx, ticket: TicketRow, reason: "blocked" | "cancelled"): Promise<void> {
  const { store } = ctx;
  for (const row of store.threads({ ticketId: ticket.id, states: ["active"] })) {
    const own = row.role === "worker";
    await endThread(ctx, row, reason, { commit: own && (ticket.state === "working" || ticket.state === "checking"), ...(own ? {} : { move: null }) });
  }
  if (store.threads({ ticketId: ticket.id, role: "worker", states: ["ending"] }).length > 0) return;
  const left = store.ticket(ticket.id)!;
  const move = ticketMoveFor(reason, left, specOf(store, store.project(left.project_id)!));
  if (move !== null) applyMove(ctx, left, move, LOOM_ACTOR, { reason });
}

/** Blocked to queued, for the human or the planner. The next worker starts from the ticket's branch and reads the whole thread. */
export async function requeueTicket(ctx: EngineCtx, key: string, a: { note: string; actor: string; author: AuthorKind; threadId?: string }): Promise<TicketRow> {
  const ticket = ctx.store.ticketByKey(key);
  if (ticket === null) throw new LoomError("loom_not_found", `No ticket ${key}.`, "Run `bb loom tickets <slug>` to see the ticket keys.");
  if (ticket.state !== "blocked") throw new LoomError("loom_invalid_state", `${key} is ${ticket.state}; only a blocked ticket can be requeued.`);
  const note = a.note.trim();
  ctx.store.tx(() => {
    ctx.store.setTicketState(ticket.id, "queued", a.actor, { requeued: true, failures: 0 });
    // A ticket whose pull request stays open comes back as a fix round on it, asked for its own text again.
    const fix = ticket.pushed_sha !== null ? { pr_rounds: ticket.pr_rounds + 1 } : {};
    ctx.store.updateTicket(ticket.id, { failures: 0, check_failures: 0, blocked_reason: null, ...released, ...fix, pr_ask_json: null, pr_text_json: null, pr_deliver_json: null });
    if (note !== "") {
      ctx.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: a.author, author_thread_id: a.threadId ?? null, kind: "reply", body: note });
    }
  });
  ctx.store.changed(ticket.project_id);
  ctx.kick();
  return ctx.store.ticket(ticket.id)!;
}
