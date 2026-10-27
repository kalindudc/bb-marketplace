// The worker lifecycle: spawn a worker for a ticket, nudge or end it when it stalls, block and requeue tickets,
// and end any worker or reviewer thread in one place (endThread). Every state change goes through the store.
import { randomBytes } from "node:crypto";
import { repoCheckout, ticketRepo } from "./checkouts";
import type { HostBackoffs } from "./forge-waits";
import type { ProjectRow, Store, ThreadRow, TicketRow } from "./db/store";
import { spawnEnvironment, threadBranch, ticketInputsOf, usesNewMachine } from "./environments";
import { plural } from "./format";
import type { EnvironmentInfo, HostPort } from "./ports";
import { COMMENT_SIGNATURE, andList, latestChangesRequested, nudgeText, workerBrief } from "./prompts";
import { LoomError, type Ctx } from "./projects";
import { freshBaseOf, repoSettings } from "./repos";
import { idleAction, spawnable, toLite, type TicketLite } from "./scheduler";
import type { Spec } from "./spec";
import { EMPTY_STACK, stackBranch, stacking, stackOf, upstreamOf, type Stack } from "./stack";
import { nextWait, provisioningFailure, startProblemOf, startWaits, unavailableReason, waitOf, waitPost, type StartProblem } from "./starts";
import { HUMAN_ACTOR, LOOM_ACTOR, PAUSE_NOW_REASON, canMoveTicket, type AuthorKind, type TicketState } from "./states";
import { bringHome, carryTo, homeBranch, isRemote } from "./transport";

export interface EngineCtx extends Ctx {
  host: HostPort;
  kick(): void;
  /** Forge hosts that rate-limited Loom's pull request reads, for every project; in memory only. */
  forgeBackoffs: HostBackoffs;
  /** How long a pull request's failed checks wait for the pending ones after a push; Loom's checksSettleMinutes setting. */
  checksSettleMs?: () => number;
  /** How long a queued check may hold the failed ones; Loom's checksQueuedMinutes setting, which the spec can override. */
  checksQueuedMinutes?: () => number;
  /** How far along a running check must be to hold the failed ones; Loom's checksNearDonePercent setting, which the spec can override. */
  checksNearDonePercent?: () => number;
  /** The line a worker ends its pull request comments with; Loom's commentSignature setting. */
  commentSignature?: () => string;
}

export const signatureOf = (ctx: EngineCtx): string => ctx.commentSignature?.() ?? COMMENT_SIGNATURE;

export type EndReason = "abandoned" | "timeout" | "failed" | "gone" | "blocked" | "cancelled" | "verdict" | "superseded" | "merged" | "released";
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

/** What a ticket's own changes are measured against: the commit it is stacked on, else its repo's fresh base. */
export function baseOf(spec: Spec, ticket: Pick<TicketRow, "repo" | "stack_json">): string {
  return stackOf(ticket)?.base ?? freshBase(spec, ticket.repo);
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
    case "released":
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

/**
 * `waiting` holds back tickets that may not start now, as it did when the caller picked this one, and `parked` names the
 * tickets whose worker waits for the human, which hold no worker slot. A ticket that waits after a failed start tries
 * again with the same thread row, so the wait keeps one attempt and one claim on the ticket.
 */
export async function spawnWorker(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, waiting?: (ticket: TicketLite) => boolean, parked?: ReadonlySet<number>): Promise<void> {
  const { store } = ctx;
  const token = randomBytes(12).toString("hex");
  const fromBranch = ticket.branch !== null;
  const stack = stacking(spec);
  let start: { branch: string | null; stack: Stack } | null = null;
  if (stack && !fromBranch) {
    if (store.ticket(ticket.id)?.state !== "queued") return;
    start = await stackStart(ctx, project, spec, store.ticket(ticket.id)!);
    if (start === null) return;
  }

  // The final eligibility check and the claim share one synchronous transaction, so nothing can change between them.
  const row = store.tx(() => {
    const current = store.ticket(ticket.id);
    if (current === null || current.state !== "queued" || startWaits(current, "worker", ctx.now())) return null;
    const fresh = store.project(project.id);
    if (fresh === null) return null;
    const tickets = store.tickets(project.id).map(toLite);
    const freshSpec = specOf(store, fresh);
    if (!spawnable(freshSpec.agents.max_workers, tickets, waiting, stacking(freshSpec), parked).some((lite) => lite.id === ticket.id)) return null;
    const stackPatch = start === null ? {} : { stack_json: JSON.stringify(start.stack) };
    const wait = waitOf(current, "worker");
    const again = wait?.row == null ? null : store.thread(wait.row);
    if (again !== null && again.state === "ended" && again.end_reason === "failed" && again.role === "worker" && again.ticket_id === ticket.id && again.attempt === current.attempt) {
      store.updateThread(again.id, { state: "spawning", spawn_token: token, thread_id: null, environment_id: null, ended_at: null, end_reason: null, clock_at: ctx.now(), idle_count: 0, rate_limit_retries: 0, maintenance_seq: 0 });
      store.setTicketState(ticket.id, "working", LOOM_ACTOR, { attempt: current.attempt, retry: wait!.tries });
      store.updateTicket(ticket.id, { ...released, ...stackPatch });
      return store.thread(again.id)!;
    }
    const attempt = current.attempt + 1;
    const created = store.addThread({ project_id: project.id, ticket_id: ticket.id, role: "worker", state: "spawning", spawn_token: token });
    store.updateThread(created.id, { clock_at: ctx.now(), attempt });
    store.setTicketState(ticket.id, "working", LOOM_ACTOR, { attempt });
    store.updateTicket(ticket.id, { attempt, ...released, ...stackPatch });
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

  // A wait's retry keeps its attempt number, so only an attempt after the first has an earlier worker to resume from.
  const resume = (row.attempt ?? 1) > 1;
  const agent = spec.agents.worker;
  let spawned;
  // Until bb is asked, a failure is Loom's own, such as a ticket whose repo the spec no longer lists: no wait helps it.
  let asked = false;
  try {
    const repo = ticketRepo(spec, ticket);
    // A worker on a machine of its own starts at the fresh base, which bb can make there, and carries in what earlier workers left with loom_resume.
    const onMachine = usesNewMachine(repo, "worker");
    let earlier: EarlierWork | null = null;
    if (onMachine || resume) {
      try {
        earlier = await earlierWork(ctx, project, spec, ticket);
      } catch (error) {
        await failSpawn(ctx, row, { kind: "failed", message: `Loom could not read the work brought home for ${ticket.key}: ${errText(error)}` });
        return;
      }
    }
    const pending: Resume | null = onMachine && earlier !== null ? { sha: earlier.sha, tree: earlier.tree } : null;
    if (onMachine) store.updateThread(row.id, { resume_json: pending === null ? null : JSON.stringify(pending) });
    const checkouts = onMachine ? new Map<string, string>() : await otherCheckouts(ctx, project, spec, ticket);
    // A thread bb never gave an environment never ran, so it has no conversation to read.
    const earlierThreads = store.threads({ ticketId: ticket.id, role: "worker" }).flatMap((other) => (other.id !== row.id && other.thread_id !== null && (other.environment_id !== null || other.released_at !== null) ? [other.thread_id] : []));
    const brief = workerBrief({ project, spec, ticket: store.ticket(ticket.id)!, posts: store.posts(ticket.id), resume, checkouts, tickets: store.tickets(project.id), signature: signatureOf(ctx), earlierThreads, remote: onMachine, resumePending: pending !== null });
    const spawn = (baseBranch: string) =>
      ctx.bb.spawnThread({
        bbProjectId: repo.bbProjectId ?? project.bb_project_id,
        hostId: project.host_id!,
        baseBranch,
        environment: spawnEnvironment(repo, { branch: threadBranch(project.slug, ticket.key, String(row.attempt)), base: baseBranch }, "worker", ticketInputsOf(ticket)),
        title: `${ticket.key} · ${ticket.title}`,
        prompt: brief,
        sectionId: project.section_id,
        metadata: { project: project.slug, role: "worker", ticket: ticket.key, spawnToken: token },
        providerId: agent.provider,
        model: agent.model,
        reasoningLevel: agent.reasoning,
        permissionMode: agent.permission_mode,
      });
    const base = onMachine ? freshBase(spec, ticket.repo) : (start?.branch ?? earlier?.branch ?? ticket.branch ?? freshBase(spec, ticket.repo));
    asked = true;
    try {
      spawned = await spawn(base);
    } catch (error) {
      // A stacked start never falls back to the base: its dependencies' work would be missing.
      if (onMachine || fromBranch || (start?.branch ?? null) !== null || spec.merge.strategy !== "pr" || !isRefError(error)) throw error;
      spawned = await spawn(repo.base);
    }
  } catch (error) {
    await failSpawn(ctx, row, asked ? startProblemOf(error) : { kind: "broken", message: errText(error) });
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

type EarlierWork = Resume & { branch: string };

/**
 * The ticket's newest work on the project's checkout: the home branch, with the work Loom brought from other machines,
 * unless the last worker's branch there builds on it, as one from the checkout's machine after a placement change does,
 * or there is no home branch. A branch from another machine never builds on it, even where its provider copies it to
 * the checkout. Null when neither is there.
 */
async function earlierWork(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow): Promise<EarlierWork | null> {
  const checkout = await repoCheckout(ctx, project, spec, ticket.repo);
  const home = homeBranch(project.slug, ticket.key);
  const homeTip = await ctx.host.call(checkout.hostId, "refTip", { repo: checkout.path, ref: `refs/heads/${home}` });
  const contains = homeTip.outcome === "ok" ? { contains: homeTip.sha } : {};
  const ownTip = ticket.branch === null ? null : await ctx.host.call(checkout.hostId, "refTip", { repo: checkout.path, ref: `refs/heads/${ticket.branch}`, ...contains });
  if (ownTip?.outcome === "ok" && (homeTip.outcome !== "ok" || ownTip.contains === true)) return { branch: ticket.branch!, sha: ownTip.sha, tree: ownTip.tree };
  return homeTip.outcome === "ok" ? { branch: home, sha: homeTip.sha, tree: homeTip.tree } : null;
}

/**
 * Where a ticket's first worker starts when its project stacks pull requests: on the pull request commits of its open
 * dependencies in its repo, with the base branch's tip when one of them merged already, through a branch Loom points at
 * that commit; or at the fresh base when none is open. Null while it must wait: the commits conflict with each other, or
 * the machine cannot build the commit now.
 */
async function stackStart(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow): Promise<{ branch: string | null; stack: Stack } | null> {
  const { store } = ctx;
  const up = upstreamOf(store.tickets(project.id), ticket);
  const cross = Object.fromEntries(up.cross.filter((dep) => dep.state !== "done" && dep.pushed_sha !== null).map((dep) => [dep.key, dep.pushed_sha!]));
  const open = up.open.filter((dep) => dep.pushed_sha !== null);
  if (open.length === 0) return { branch: null, stack: { ...EMPTY_STACK, synced: ctx.now(), cross } };
  const deps = Object.fromEntries(open.map((dep) => [dep.key, dep.pushed_sha!]));
  const withBase = up.merged.length > 0;
  const settings = repoSettings(spec, ticket.repo);
  const branch = stackBranch(project.slug, ticket.key);
  let built;
  try {
    const checkout = await repoCheckout(ctx, project, spec, ticket.repo);
    built = await ctx.host.call(checkout.hostId, "stackBase", {
      repo: checkout.path,
      branch,
      commits: open.map((dep) => dep.pushed_sha!),
      ...(withBase ? { base: { remote: settings.remote, branch: settings.base } } : {}),
      message: `Loom: ${andList(open.map((dep) => dep.key))} for ${ticket.key}`,
    });
  } catch (error) {
    ctx.bb.log("warn", `${ticket.key} cannot start on its dependencies' pull requests yet: ${errText(error)}`);
    return null;
  }
  if (built.outcome === "unavailable") {
    ctx.bb.log("warn", `${ticket.key} cannot start on its dependencies' pull requests yet: ${built.message}`);
    return null;
  }
  if (built.outcome === "conflict") {
    const known = stackOf(ticket) ?? EMPTY_STACK;
    const body = `Loom cannot start ${ticket.key} on its dependencies' pull requests: ${andList(open.map((dep) => dep.key))} conflict with each other in ${built.files.join(", ")}. It starts once one of them changes or merges.`;
    store.tx(() => {
      store.updateTicket(ticket.id, { stack_json: JSON.stringify({ ...known, conflict: { on: deps, files: built.files } } satisfies Stack) });
      store.addPost({ project_id: project.id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "system", body, data_json: JSON.stringify({ stackConflict: true, on: deps, files: built.files }) });
    });
    store.changed(project.id);
    return null;
  }
  const synced = withBase ? ctx.now() : Math.min(...open.map((dep) => stackOf(dep)?.synced ?? 0));
  return { branch, stack: { deps, base: built.sha, synced, cross } };
}

/** The checkout path of each other repo of the project on its machine, by repo name, for worker and reviewer briefs. A repo without a checkout is left out, so the brief lists it without a path. */
export async function otherCheckouts(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: Pick<TicketRow, "key" | "repo">): Promise<Map<string, string>> {
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
 * A worker that never started. The thread, when there is one, is archived. A ticket bb refused blocks at once. Any other
 * failed start waits and tries again (StartWait): one that bb or the provider says cannot happen now counts nothing, and
 * a failure counts as a failed attempt only once it has happened START_GRACE times in a row. A ticket resumed from a
 * branch bb could not find loses the branch and counts no failure, so the next try starts from the fresh base; a ticket
 * whose pull request is open always keeps its branch, which has the pull request's work.
 */
export async function failSpawn(ctx: EngineCtx, row: ThreadRow, problem: StartProblem, opts: { archive?: boolean } = {}): Promise<void> {
  const { store } = ctx;
  if (opts.archive === true && row.thread_id !== null) await ctx.bb.archive(row.thread_id).catch((e) => ctx.bb.log("warn", `Could not archive ${row.thread_id}: ${errText(e)}`));
  const error = problem.message;
  store.tx(() => {
    store.updateThread(row.id, { state: "ended", ended_at: ctx.now(), end_reason: "failed" });
    const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
    if (ticket === null || ticket.state !== "working") return;
    const project = store.project(ticket.project_id)!;
    const post = (body: string) => store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "system", body });
    if (problem.kind === "refused") {
      post(`Could not start a worker: ${error}`);
      applyMove(ctx, ticket, { to: "blocked", patch: { ...released, failures: ticket.failures + 1, blocked_reason: `bb refused to start a worker: ${error}`, start_wait_json: null } }, LOOM_ACTOR, { reason: START_REFUSED });
      return;
    }
    if (problem.kind === "broken") {
      const failures = ticket.failures + 1;
      const blocked = failures >= specOf(store, project).budget.max_attempts;
      post(`Could not start a worker: ${error}`);
      const move: TicketMove = blocked ? { to: "blocked", patch: { ...released, failures, blocked_reason: `could not start a worker ${plural(failures, "time")}`, start_wait_json: null } } : { to: "queued", patch: { ...released, failures, start_wait_json: null } };
      applyMove(ctx, ticket, move, LOOM_ACTOR, { reason: START_FAILED });
      return;
    }
    if (ticket.branch !== null && ticket.pushed_sha === null && isRefError(error)) {
      post(`Could not start a worker: ${error}`);
      applyMove(ctx, ticket, { to: "queued", patch: { ...released, branch: null, start_wait_json: null } }, LOOM_ACTOR, { reason: "the worker could not start from the earlier branch" });
      return;
    }
    const previous = waitOf(ticket, "worker");
    const wait = nextWait(previous, { role: "worker", row: row.id, problem, now: ctx.now() });
    if (wait.expired) {
      const reason = `no worker could start: ${unavailableReason(wait)}`;
      post(`Could not start a worker: ${error}. The ticket blocks, because ${unavailableReason(wait)}.`);
      applyMove(ctx, ticket, { to: "blocked", patch: { ...released, blocked_reason: reason, start_wait_json: null } }, LOOM_ACTOR, { reason: START_UNAVAILABLE });
      return;
    }
    const failures = ticket.failures + (wait.counted ? 1 : 0);
    if (wait.counted && failures >= specOf(store, project).budget.max_attempts) {
      post(`Could not start a worker: ${error}`);
      applyMove(ctx, ticket, { to: "blocked", patch: { ...released, failures, blocked_reason: `could not start a worker ${plural(failures, "time")}; the last time: ${error}`, start_wait_json: null } }, LOOM_ACTOR, { reason: START_FAILED });
      return;
    }
    const text = waitPost("a worker", wait, previous, ctx.now());
    if (text !== null) post(text);
    const reason = wait.kind === "unavailable" ? START_WAITS : START_FAILED;
    applyMove(ctx, ticket, { to: "queued", patch: { ...released, failures, start_wait_json: JSON.stringify(wait) } }, LOOM_ACTOR, { reason, retryAt: wait.until });
  });
  store.changed(row.project_id);
  ctx.kick();
}

export const RELEASED_TEXT =
  "Loom archived the idle worker's thread to free its environment while the pull request waits. When the pull request needs a fix, or its branch must catch up with a dependency, Loom brings the same thread back with a new environment on its branch, so the worker keeps its conversation.";

export const START_FAILED = "the worker could not start";
export const START_REFUSED = "bb refused to start the worker";
export const START_WAITS = "the environment provider cannot start a worker now";
export const START_UNAVAILABLE = "the environment provider stayed unavailable";

/** The thread ran, so the wait after a failed start is over and the next failed start begins a new count. */
export function startedFine(ctx: EngineCtx, row: ThreadRow): void {
  const ticket = row.ticket_id === null ? null : ctx.store.ticket(row.ticket_id);
  if (ticket === null || ticket.start_wait_json === null) return;
  const wait = waitOf(ticket);
  if (wait?.role === row.role || (wait !== null && wait.row === row.id)) ctx.store.updateTicket(ticket.id, { start_wait_json: null });
}

/** A blocked ticket whose last move to blocked came from a worker that never started. */
export function blockedAtStart(store: Store, ticket: TicketRow): boolean {
  if (ticket.state !== "blocked") return false;
  const last = store.ticketEvents(ticket.id, ["ticket.state"]).at(-1);
  if (last === undefined) return false;
  const data = JSON.parse(last.data_json) as { to?: string; reason?: string };
  return data.to === "blocked" && (data.reason === START_FAILED || data.reason === START_REFUSED || data.reason === START_UNAVAILABLE);
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

/**
 * Stores the worker's real branch on the ticket. Always runs before the thread is archived. A worker that never called
 * loom_resume leaves the ticket's branch alone, since the earlier work it never carried in may be on that branch.
 */
export async function recordBranch(ctx: EngineCtx, row: ThreadRow): Promise<void> {
  if (row.role !== "worker" || row.ticket_id === null || row.resume_json !== null) return;
  const environment = await resolveEnvironment(ctx, row);
  if (environment?.branchName != null) ctx.store.updateTicket(row.ticket_id, { branch: environment.branchName });
}

/** Resume: the work Loom brought home from a ticket's earlier workers, which a worker on a machine of its own carries in with loom_resume. */
export interface Resume {
  sha: string;
  tree: string;
}

export const resumeOf = (row: Pick<ThreadRow, "resume_json">): Resume | null => (row.resume_json === null ? null : (JSON.parse(row.resume_json) as Resume));

/** loom_resume: puts the work brought home from the ticket's earlier workers in this worker's worktree, as one commit with its tree. */
export async function resumeWork(ctx: EngineCtx, threadId: string): Promise<string> {
  const { store } = ctx;
  const row = store.threadByThreadId(threadId);
  if (row === null || row.role !== "worker") throw new LoomError("loom_forbidden", "loom_resume is for a Loom worker thread.");
  const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
  if (row.state !== "active" || ticket === null || ticket.state !== "working" || ticket.worker_thread_id !== threadId) {
    throw new LoomError("loom_invalid_state", "You are not the live worker of a ticket in working state, so there is nothing to resume.");
  }
  const resume = resumeOf(row);
  if (resume === null) return `Nothing to resume: ${ticket.key}'s earlier work is already in your worktree, or there was none. Go on with the ticket.`;
  const environment = await resolveEnvironment(ctx, row);
  if (environment?.path == null) throw new LoomError("loom_invalid_state", "Your worktree is not available yet. Try again in a moment.");
  const project = store.project(row.project_id)!;
  let tree: string;
  try {
    ({ tree } = await carryTo(ctx, project, specOf(store, project), ticket, resume.sha, environment));
  } catch (error) {
    throw new LoomError("loom_unavailable", `Loom could not put the earlier work in your worktree: ${errText(error)}. Call loom_resume again, or loom_block if it keeps failing.`);
  }
  store.updateThread(row.id, { resume_json: null });
  return `Loom put ${ticket.key}'s earlier work in your worktree as one commit on the base, with the tree ${tree.slice(0, 12)}. Read the ticket thread in your brief, then continue from what is there.`;
}

/** The WIP commit was made on the worker's own machine and could not be brought home, so that machine has the only copy. */
class NotBroughtHome extends Error {}

/**
 * Commits the worker's worktree; a worker on a machine of its own also has the commit brought home, since that machine
 * goes when its thread ends. One that never called loom_resume does not: its worktree lacks the earlier work, and
 * bringing it home would put the home branch where the next worker cannot resume that work.
 */
export async function commitWip(ctx: EngineCtx, row: ThreadRow, ticket: TicketRow, message: string): Promise<void> {
  const environment = await resolveEnvironment(ctx, row);
  if (environment?.path == null) return;
  await ctx.host.call(environment.hostId, "commitAll", { worktree: environment.path, message });
  const project = ctx.store.project(row.project_id)!;
  if (!isRemote(project, environment)) return;
  if (resumeOf(row) !== null) {
    ctx.bb.log("info", `${ticket.key}'s worker ended before loom_resume, so Loom kept the work brought home as it was; the worker's own changes stay committed on its machine.`);
    return;
  }
  try {
    await bringHome(ctx, project, specOf(ctx.store, project), ticket, environment, "wip");
  } catch (error) {
    throw new NotBroughtHome(errText(error));
  }
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
        await commitWip(ctx, row, ticket, `WIP ${ticket.key} (attempt ${ticket.attempt})`);
      } catch (error) {
        if (!(error instanceof NotBroughtHome)) {
          ctx.bb.log("warn", `Could not save ${ticket.key}'s work before ending its thread: ${errText(error)}`);
        } else if (!force) {
          // Archived, the thread no longer holds its machine, and bb removes it with the only copy; the tick tries again.
          ctx.bb.log("warn", `Could not bring ${ticket.key}'s work home before ending its thread, so Loom keeps the thread and its machine and tries again: ${errText(error)}`);
          if (row.thread_id !== null) await ctx.bb.stop(row.thread_id).catch((stopError) => ctx.bb.log("warn", `Could not stop ${row.thread_id}: ${errText(stopError)}`));
          return;
        } else {
          const body = `Loom could not bring the worker's work home from its machine, so the next worker starts without the changes it made since it last submitted or saved: ${errText(error)}. Loom tried for ${ENDING_LIMIT_MS / 60_000} minutes before it ended the thread.`;
          store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "system", body });
        }
      }
    }
    if (!(await stopAndArchive(ctx, row, force))) return;

    store.tx(() => {
      const current = store.thread(row.id);
      if (current === null || current.state !== "ending") return;
      store.updateThread(row.id, { state: "ended", ended_at: ctx.now(), ...(reason === "released" ? { released_at: ctx.now() } : {}) });
      const held = row.ticket_id === null ? null : store.ticket(row.ticket_id);
      if (held === null) return;
      const own = row.role === "worker" && held.worker_thread_id === row.thread_id;
      // A released worker stays the ticket's worker, without an environment, so the pull request's next fix round brings it back.
      if (reason === "released" && own) {
        store.updateTicket(held.id, { environment_id: null });
        store.addPost({ project_id: held.project_id, ticket_id: held.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "system", body: RELEASED_TEXT, data_json: JSON.stringify({ released: true }) });
      }
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

/**
 * Whether this idle is the one bb caused by moving the thread's machine, which it reports as a machine_maintenance
 * error. The event is consumed, so the next idle counts; only threads on machines of their own are asked about.
 */
export async function machineMoved(ctx: EngineCtx, row: ThreadRow): Promise<boolean> {
  const { store } = ctx;
  const project = store.project(row.project_id);
  const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
  if (row.thread_id === null || project === null || ticket === null || row.role === "planner" || !usesNewMachine(ticketRepo(specOf(store, project), ticket), row.role)) return false;
  const error = await ctx.bb.latestSystemError(row.thread_id).catch(() => null);
  if (error?.code !== "machine_maintenance" || error.seq <= row.maintenance_seq) return false;
  store.updateThread(row.id, { maintenance_seq: error.seq });
  return true;
}

/** The first idle of a worker whose ticket is working gets a nudge; the next one ends the worker. */
export async function onWorkerIdle(ctx: EngineCtx, seen: ThreadRow, reason: EndReason = "abandoned"): Promise<void> {
  const row = ctx.store.thread(seen.id);
  if (row === null || row.state !== "active" || row.role !== "worker" || row.thread_id === null || row.released_at !== null) return;
  // An idle while Loom still holds work for the worker is not the worker stopping: the message is on its way, or waits for a slot.
  if (row.ticket_id !== null && ctx.store.ticket(row.ticket_id)?.handback_json != null) return;
  if (ctx.store.project(row.project_id)?.state !== "running") return;
  const ticket = row.ticket_id === null ? null : ctx.store.ticket(row.ticket_id);
  if (ticket === null || ticket.state !== "working" || ticket.worker_thread_id !== row.thread_id) return;
  if (await machineMoved(ctx, row)) return;
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
  // A worker coming back from a release has no turn yet; the tick reads how its restore went (advanceWakes).
  if (row.released_at !== null) return;
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
      if (ctx.store.claimThread(row.id, "failed")) await failSpawn(ctx, ctx.store.thread(row.id)!, provisioningFailure(failure), { archive: true });
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
    // A block that let go of the pull request leaves no commit pushed; what Loom last read of that pull request goes with it.
    const gone = ticket.pushed_sha === null ? { pr_meta_json: null } : {};
    ctx.store.updateTicket(ticket.id, { failures: 0, check_failures: 0, blocked_reason: null, ...released, ...fix, ...gone, pr_ask_json: null, pr_text_json: null, handback_json: null, start_wait_json: null });
    if (note !== "") {
      ctx.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: a.author, author_thread_id: a.threadId ?? null, kind: "reply", body: note });
    }
  });
  ctx.store.changed(ticket.project_id);
  ctx.kick();
  return ctx.store.ticket(ticket.id)!;
}
