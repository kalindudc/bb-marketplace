// Whether each step and milestone of a project's rollout is live. A deploy-on-merge ticket is live once its pull request
// merged; a merged ticket's verify command, and a milestone's check command, run on the project's machine every 15
// minutes until one exits 0; the human marks the rest. This only records: no start, review, merge or push waits on it.
import { randomUUID } from "node:crypto";
import { stripAnsi } from "./activity";
import { repoCheckout } from "./checkouts";
import type { LiveBy, ProjectRow, RolloutMarkRow, Store, TicketRow } from "./db/store";
import { LoomError } from "./projects";
import { deployOf, followsRollout, isRolloutStep, rolloutOf, rolloutOfTicket, whenText, type RolloutView } from "./rollout";
import type { Spec } from "./spec";
import { LOOM_ACTOR, type ProjectState } from "./states";
import { specOf, type EngineCtx } from "./workers";

export const ROLLOUT_CHECK_MINUTES = 15;
const CHECK_MS = ROLLOUT_CHECK_MINUTES * 60_000;
const CHECK_TIMEOUT_MS = 2 * 60_000;
// Longer than an exec can take, its host call's own deadline included, so the claim of a run an engine left behind at a
// reload holds until that run cannot answer any more.
const RUN_LEASE_MS = 5 * 60_000;
const OUTPUT_TAIL = 2000;
const EVIDENCE_TAIL = 500;
const FOLLOWED: readonly ProjectState[] = ["running", "paused", "done"];

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const tail = (text: string, max: number) => (text.length <= max ? text : `…${text.slice(-(max - 1))}`);

interface Run {
  promise: Promise<void>;
  /** The engine that started it is gone: the run writes nothing more. */
  fenced: boolean;
}

const runsByStore = new WeakMap<Store, Map<string, Run>>();
const runsOf = (store: Store) => runsByStore.get(store) ?? runsByStore.set(store, new Map()).get(store)!;

/** Waits for every verify and check run in flight. For tests. */
export async function settleRolloutChecks(ctx: EngineCtx): Promise<void> {
  const runs = runsOf(ctx.store);
  while (runs.size > 0) await Promise.all([...runs.values()].map((run) => run.promise));
}

/**
 * The engine is going away: no run in flight writes anything after this. Each keeps its claim until the claim expires, so
 * an engine started over the same database starts no second command beside one that is still going.
 */
export function fenceRolloutChecks(ctx: EngineCtx): void {
  for (const run of runsOf(ctx.store).values()) run.fenced = true;
}

interface Check {
  target: string;
  ticketId: number | null;
  repo: string | null;
  command: string;
  by: Extract<LiveBy, "verify" | "check">;
}

const ticketCheck = (ticket: TicketRow): Check | null => {
  const verify = ticket.state === "done" ? rolloutOfTicket(ticket)?.verify : undefined;
  return verify === undefined ? null : { target: ticket.key, ticketId: ticket.id, repo: ticket.repo, command: verify, by: "verify" };
};

// A milestone belongs to no repo, so its check runs in the project's first one.
const milestoneCheck = (spec: Spec, ref: string): Check | null => {
  const check = spec.rollout?.milestone?.find((milestone) => milestone.ref === ref)?.check;
  return check === undefined ? null : { target: ref, ticketId: null, repo: spec.repo?.[0]?.name ?? null, command: check, by: "check" };
};

/** The project and its spec while Loom follows its rollout and the target's command is still `check`'s; null once it was archived, or an edit or a new spec version changed the command. */
function stillCurrent(store: Store, projectId: number, check: Check): { project: ProjectRow; spec: Spec } | null {
  const project = store.project(projectId);
  if (project === null || !FOLLOWED.includes(project.state)) return null;
  const spec = specOf(store, project);
  const ticket = check.ticketId === null ? null : store.ticket(check.ticketId);
  const now = check.ticketId === null ? milestoneCheck(spec, check.target) : ticket === null ? null : ticketCheck(ticket);
  return now !== null && now.command === check.command && now.repo === check.repo ? { project, spec } : null;
}

/**
 * The engine's rollout step for one project: marks merged deploy-on-merge tickets live, and starts each verify or check
 * command that is due. The commands run in the background, so a slow one never holds the engine's pass.
 */
export function followRollout(ctx: EngineCtx, project: ProjectRow): void {
  const { store, now } = ctx;
  const spec = specOf(store, project);
  const tickets = store.tickets(project.id);
  if (!followsRollout(spec, tickets)) return;
  const marks = new Map(store.rolloutMarks(project.id).map((mark) => [mark.target, mark]));
  const due = (mark: RolloutMarkRow | undefined) => mark?.checked_at == null || now() - mark.checked_at >= CHECK_MS;
  for (const ticket of tickets) {
    if (ticket.state !== "done" || !isRolloutStep(spec, ticket)) continue;
    const mark = marks.get(ticket.key);
    if (mark?.live_at != null) continue;
    // After the human undid it, a merge is no new evidence, so only its verify or the human marks it live again.
    if (deployOf(spec, ticket).onMerge && mark?.undone_at == null) {
      store.markLive(project.id, ticket.id, ticket.key, { by: "merge", at: ticket.state_at, evidence: ticket.pr_url }, LOOM_ACTOR);
      continue;
    }
    const check = ticketCheck(ticket);
    if (check !== null && due(mark)) start(ctx, project, check);
  }
  for (const milestone of spec.rollout?.milestone ?? []) {
    const mark = marks.get(milestone.ref);
    const check = milestoneCheck(spec, milestone.ref);
    if (check !== null && mark?.live_at == null && due(mark)) start(ctx, project, check);
  }
}

/** Starts a run once its claim is in the row, which no other run of the target, this engine's or an earlier one's, holds. */
function start(ctx: EngineCtx, project: ProjectRow, check: Check): void {
  const { store, now } = ctx;
  const runs = runsOf(store);
  const id = `${project.id}:${check.target}`;
  if (runs.has(id)) return;
  const token = randomUUID();
  if (!store.claimRolloutRun(project.id, check.target, token, now() - RUN_LEASE_MS)) return;
  const run: Run = { promise: Promise.resolve(), fenced: false };
  run.promise = runCheck(ctx, project.id, check, token, run)
    .catch((error: unknown) => ctx.bb.log("warn", `The rollout ${check.by} of ${check.target} in ${project.slug} failed: ${errText(error)}`))
    .finally(() => {
      if (runs.get(id) === run) runs.delete(id);
    });
  runs.set(id, run);
}

/**
 * One run. Each await can let an archive, an edit, a new spec version or the engine's end land, so the run looks again
 * before the command and before its result, and drops the work when anything changed. A run that could not happen (no
 * checkout, the machine away, the host call failing) is recorded like a failed one and tried again at the next interval.
 */
async function runCheck(ctx: EngineCtx, projectId: number, check: Check, token: string, run: Run): Promise<void> {
  const { store } = ctx;
  const current = () => (run.fenced ? null : stillCurrent(store, projectId, check));
  // A fenced run writes nothing, so its claim stays until it expires.
  const letGo = () => {
    if (!run.fenced) store.releaseRolloutRun(projectId, check.target, token);
  };
  let result: { exitCode: number | null; output: string };
  try {
    const before = current();
    if (before === null) return letGo();
    const checkout = await repoCheckout(ctx, before.project, before.spec, check.repo);
    // The human may have marked it live while Loom looked for the checkout.
    if (current() === null || store.rolloutMark(projectId, check.target)?.live_at != null) return letGo();
    const ran = await ctx.host.call(checkout.hostId, "exec", { cwd: checkout.path, command: check.command, timeoutMs: CHECK_TIMEOUT_MS });
    const output = tail(stripAnsi(ran.output).trim(), OUTPUT_TAIL);
    result = ran.timedOut ? { exitCode: null, output: `It timed out after 2 minutes.${output === "" ? "" : `\n${output}`}` } : { exitCode: ran.exitCode, output };
  } catch (error) {
    result = { exitCode: null, output: `Loom could not run it: ${errText(error)}` };
  }
  store.tx(() => {
    if (current() === null) return letGo();
    if (!store.finishRolloutRun(projectId, check.target, token, result)) return;
    // The human may have marked it live while the command ran.
    if (result.exitCode === 0 && store.rolloutMark(projectId, check.target)?.live_at == null) {
      store.markLive(projectId, check.ticketId, check.target, { by: check.by, evidence: result.output === "" ? null : tail(result.output, EVIDENCE_TAIL) }, LOOM_ACTOR);
    }
  });
}

/**
 * The human's Mark live, or its undo, on a ticket of the project or a milestone of its spec. It writes the mark and its
 * event, and nothing else: no ticket moves.
 */
export function markLiveByHuman(ctx: EngineCtx, slug: string, target: string, opts: { note?: string; undo?: boolean }, actor: string): RolloutMarkRow | null {
  const { store } = ctx;
  const project = store.projectBySlug(slug);
  if (project === null) throw new LoomError("loom_not_found", `No Loom project ${slug}.`, "Run `bb loom list` to see the projects.");
  if (project.state === "draft" || project.state === "archived") throw new LoomError("loom_invalid_state", `Project ${slug} is ${project.state}, so it has no rollout to follow.`);
  const spec = specOf(store, project);
  const tickets = store.tickets(project.id);
  if (!followsRollout(spec, tickets)) throw new LoomError("loom_invalid_state", `Project ${slug} has no rollout: its spec has no [rollout] table, no repo deploy and no ticket rollout.`);
  const ticket = tickets.find((row) => row.key === target) ?? null;
  const milestones = (spec.rollout?.milestone ?? []).map((milestone) => milestone.ref);
  if (ticket === null && !milestones.includes(target)) {
    throw new LoomError("loom_not_found", `"${target}" is neither a ticket of ${slug} nor a milestone of its spec.`, milestones.length === 0 ? "Use a ticket key such as the ones `bb loom tickets` lists." : `Use a ticket key, or one of the milestones: ${milestones.join(", ")}.`);
  }
  const name = ticket === null ? target : ticket.key;
  const mark = store.rolloutMark(project.id, name);
  const note = opts.note?.trim() || null;
  if (opts.undo === true) {
    if (mark?.live_at == null) throw new LoomError("loom_invalid_state", `${name} is not live, so there is nothing to undo.`);
    store.markNotLive(project.id, ticket?.id ?? null, name, actor, note);
    return store.rolloutMark(project.id, name);
  }
  if (mark?.live_at != null) {
    throw new LoomError("loom_invalid_state", `${name} is already live: marked by ${mark.live_by ?? "human"} at ${whenText(mark.live_at)}.`, `Undo it with \`bb loom live ${slug} ${name} --undo\` first to mark it again.`);
  }
  return store.markLive(project.id, ticket?.id ?? null, name, { by: "human", evidence: note }, actor);
}

/** The project's rollout now, from its approved spec; null before approval and for a project with no rollout. */
export function projectRollout(store: Store, project: ProjectRow, now: number): RolloutView | null {
  if (project.approved_version === null) return null;
  return rolloutOf(specOf(store, project), store.tickets(project.id), store.rolloutMarks(project.id), now);
}
