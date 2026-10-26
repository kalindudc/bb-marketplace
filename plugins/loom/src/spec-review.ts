// The spec review: a fresh reviewer agent judges each version the planner proposes, a draft or a version pending on an
// approved project, against the human's request and for work the goal does not need, before the human is asked to approve
// it. Its row lives in spec_reviews, not in threads, so the worker and ticket reviewer machinery never sees it. bb's thread
// events and loom_propose drive it, not the tick.
import { randomBytes } from "node:crypto";
import type { ProjectRow, SpecReviewRow, Store } from "./db/store";
import { spawnEnvironment, threadBranch } from "./environments";
import { LoomError } from "./projects";
import { specReviewFailedText, specReviewNudgeText, specReviewVerdictText, specReviewerBrief } from "./prompts";
import { isMultiRepo, repoSettings } from "./repos";
import type { Spec } from "./spec";
import { SPEC_REVIEW_ROUNDS } from "./states";
import { nextWait, provisioningFailure, startProblemOf, unavailableReason, type StartProblem, type StartWait } from "./starts";
import { MAX_RATE_LIMIT_RETRIES, rateLimitRetryAt, type EngineCtx, type TurnFailure } from "./workers";

export interface SpecFinding {
  path?: string;
  title: string;
  detail: string;
}

export type SpecReviewStatus =
  | { kind: "none" }
  | { kind: "reviewing"; version: number; round: number; waiting?: { reason: string; until: number } }
  | { kind: "approved"; version: number; round: number; summary: string }
  | { kind: "changes"; version: number; round: number; findings: SpecFinding[] }
  | { kind: "failed"; version: number; round: number; reason: string }
  | { kind: "limit"; version: number; findings: SpecFinding[] };

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** The wait of a spec review whose reviewer did not start, while Loom has not started one since. */
export const waitOfReview = (row: SpecReviewRow): StartWait | null => (row.wait_json === null ? null : (JSON.parse(row.wait_json) as StartWait));
const findingsOf = (row: SpecReviewRow) => JSON.parse(row.findings_json) as SpecFinding[];
const roundsWithFindings = (rows: readonly SpecReviewRow[]) => rows.filter((row) => row.state === "changes_requested");

/** The version that waits for the human's approval, which the review is for: the newest draft, or an approved project's pending version. */
export function reviewedVersion(project: ProjectRow): number | "draft" | null {
  if (project.state === "draft") return "draft";
  if (project.state === "archived" || project.pending_version === null) return null;
  return project.pending_version;
}

/** The reviews of the versions proposed since the last approval: every row of a draft, or the rows after the version in force. */
export function cycleReviews(store: Store, project: ProjectRow): SpecReviewRow[] {
  const after = project.approved_version ?? 0;
  return store.specReviews(project.id).filter((row) => row.version > after);
}

/**
 * Where the review of the version waiting for approval stands. A cycle with no review rows has nothing to wait for: its
 * version is from before spec reviews, or was proposed without the tool. Otherwise the newest row for that version decides.
 */
export function specReviewStatus(store: Store, project: ProjectRow): SpecReviewStatus {
  const target = reviewedVersion(project);
  if (target === null) return { kind: "none" };
  const rows = cycleReviews(store, project);
  if (rows.length === 0) return { kind: "none" };
  const version = target === "draft" ? store.latestSpecVersion(project.id)!.version : target;
  const changes = roundsWithFindings(rows);
  const atLimit = changes.length >= SPEC_REVIEW_ROUNDS;
  const own = rows.filter((row) => row.version === version && row.state !== "superseded").at(-1);
  if (own === undefined) {
    if (atLimit) return { kind: "limit", version, findings: findingsOf(changes.at(-1)!) };
    return { kind: "failed", version, round: changes.length + 1, reason: "no review ran for this version" };
  }
  switch (own.state) {
    case "reviewing": {
      // A reviewer that started since is no longer waiting, though its wait counts on until it runs.
      const wait = own.thread_id === null ? waitOfReview(own) : null;
      return wait === null ? { kind: "reviewing", version, round: own.round } : { kind: "reviewing", version, round: own.round, waiting: { reason: wait.reason, until: wait.until } };
    }
    case "approved":
      return { kind: "approved", version, round: own.round, summary: own.summary ?? "" };
    case "changes_requested":
      return atLimit ? { kind: "limit", version, findings: findingsOf(own) } : { kind: "changes", version, round: own.round, findings: findingsOf(own) };
    default:
      return { kind: "failed", version, round: own.round, reason: own.reason ?? "the review did not finish" };
  }
}

/** Why the version waiting for approval cannot be approved yet, or null when it can: the kinds specReviewBlocks names. */
export function approvalRefusal(slug: string, status: SpecReviewStatus, pending = false): LoomError | null {
  const refuse = (version: number, why: string) =>
    new LoomError(
      "loom_invalid_state",
      `${pending ? "Pending" : "Draft"} v${version} of ${slug} ${why}.`,
      `Wait for the planner to hand it over, or approve it anyway with \`bb loom approve ${slug}${pending ? ` --version ${version}` : ""} --skip-review\`.`,
    );
  switch (status.kind) {
    case "reviewing":
      return refuse(status.version, `is still in its spec review (round ${status.round} of ${SPEC_REVIEW_ROUNDS})${status.waiting === undefined ? "" : `: its reviewer could not start (${status.waiting.reason}), and Loom tries again`}`);
    case "changes":
      return refuse(status.version, `has ${status.findings.length === 1 ? "1 open finding" : `${status.findings.length} open findings`} from round ${status.round}, and the planner is revising it`);
    case "failed":
      return refuse(status.version, `was not reviewed: ${status.reason}`);
    default:
      return null;
  }
}

/** The spec reviewer row of a thread: by its thread id, or bound once through the single-use spawn token in its metadata, as Projects.roleOf does. */
export function specReviewerOf(store: Store, threadId: string, metadata: Readonly<Record<string, unknown>>): SpecReviewRow | null {
  const row = store.specReviewByThreadId(threadId);
  if (row !== null) return row;
  const token = typeof metadata.spawnToken === "string" ? metadata.spawnToken : null;
  if (token === null) return null;
  return store.tx(() => {
    const unbound = store.specReviewBySpawnToken(token);
    if (unbound === null || unbound.thread_id !== null) return null;
    store.updateSpecReview(unbound.id, { thread_id: threadId });
    return store.specReview(unbound.id);
  });
}

// ---------------------------------------------------------------- starting

/**
 * Runs after every successful loom_propose of a draft or a pending version. Reviews of older versions are superseded; the
 * newest version keeps a review that is running, passed, has findings or reached the round limit, and gets a new one when
 * it has none or it failed.
 */
export async function ensureSpecReview(ctx: EngineCtx, slug: string): Promise<SpecReviewStatus> {
  const { store } = ctx;
  const project = store.projectBySlug(slug);
  if (project === null || reviewedVersion(project) === null) return { kind: "none" };
  const latest = store.latestSpecVersion(project.id)!;
  // A pending version is always the newest one: a revision of an approved project replaces the version waiting.
  if (project.state !== "draft" && project.pending_version !== latest.version) return { kind: "none" };
  for (const row of store.specReviews(project.id)) {
    if (row.state === "reviewing" && row.version < latest.version) await supersede(ctx, row);
  }
  const status = specReviewStatus(store, project);
  // Proposing again tries a reviewer that waits to start at once, as it starts a review that failed again.
  const waiting = status.kind === "reviewing" && status.waiting !== undefined ? store.specReviews(project.id).filter((row) => row.version === latest.version && row.state === "reviewing" && row.thread_id === null).at(-1) : undefined;
  if (waiting !== undefined) return spawnReviewer(ctx, project, waiting, latest.toml, JSON.parse(latest.spec_json) as Spec, false);
  if (status.kind !== "none" && status.kind !== "failed") return status;
  return startReview(ctx, project, latest.version, latest.toml, JSON.parse(latest.spec_json) as Spec);
}

async function startReview(ctx: EngineCtx, project: ProjectRow, version: number, toml: string, spec: Spec): Promise<SpecReviewStatus> {
  const { store } = ctx;
  const earlier = cycleReviews(store, project);
  const round = roundsWithFindings(earlier).length + 1;
  // Reserved before the spawn, so a restart mid-spawn leaves a row that reconcile can fail.
  const row = store.addSpecReview({ project_id: project.id, version, round, spawn_token: randomBytes(12).toString("hex") });
  return spawnReviewer(ctx, project, row, toml, spec, false);
}

/**
 * Starts the reviewer thread of a reviewing row with no thread: a new review, or one that waits after a failed start.
 * `tell` sends the planner a failure, which loom_propose otherwise returns to it.
 */
async function spawnReviewer(ctx: EngineCtx, project: ProjectRow, row: SpecReviewRow, toml: string, spec: Spec, tell: boolean): Promise<SpecReviewStatus> {
  const { store } = ctx;
  const { version, round } = row;
  const earlier = cycleReviews(store, project).filter((other) => other.id !== row.id);
  const inForce = project.approved_version === null ? null : { version: project.approved_version, spec: JSON.parse(store.specVersion(project.id, project.approved_version)!.spec_json) as Spec };
  const token = row.wait_json === null ? row.spawn_token : randomBytes(12).toString("hex");
  if (token !== row.spawn_token) store.updateSpecReview(row.id, { spawn_token: token });
  // A multi-repo project's reviewer starts in its first repo. Not freshBaseOf: a draft has no integration branch yet.
  const settings = repoSettings(spec, isMultiRepo(spec) ? spec.repo![0]!.name : null);
  const agent = spec.agents.reviewer;
  try {
    if (project.host_id === null) throw new Error("the project has no machine");
    const spawned = await ctx.bb.spawnThread({
      bbProjectId: settings.bbProjectId ?? project.bb_project_id,
      hostId: project.host_id,
      baseBranch: `${settings.remote}/${settings.base}`,
      environment: spawnEnvironment(settings, { branch: threadBranch(project.slug, "spec", `review-${version}-${round}`), base: `${settings.remote}/${settings.base}` }, "reviewer"),
      title: `${project.key} · spec review v${version}`,
      prompt: specReviewerBrief({ project, spec, toml, version, round, earlier, inForce }),
      sectionId: project.section_id,
      metadata: { project: project.slug, role: "spec-review", version: String(version), spawnToken: token },
      providerId: agent.provider,
      model: agent.model,
      reasoningLevel: agent.reasoning,
      permissionMode: agent.permission_mode,
    });
    // Configure may have bound the thread through its token already.
    if (store.specReview(row.id)!.thread_id === null) store.updateSpecReview(row.id, { thread_id: spawned.threadId });
  } catch (error) {
    return reviewerStartFailed(ctx, store.specReview(row.id)!, startProblemOf(error), tell);
  }
  store.changed(project.id);
  return { kind: "reviewing", version, round };
}

/**
 * A spec reviewer that did not start. It waits and tries again from the tick (retrySpecReviews), as a ticket's reviewer
 * does: an unavailable provider never fails the review, and any other failure does once it has happened START_GRACE
 * times in a row. bb refusing the reviewer fails it at once.
 */
async function reviewerStartFailed(ctx: EngineCtx, row: SpecReviewRow, problem: StartProblem, tell: boolean): Promise<SpecReviewStatus> {
  const { store } = ctx;
  const wait = problem.kind === "refused" || problem.kind === "broken" ? null : nextWait(waitOfReview(row), { role: "reviewer", row: null, problem, now: ctx.now() });
  if (wait === null || wait.counted || wait.expired) {
    const reason = `bb could not start the reviewer: ${wait?.expired === true ? unavailableReason(wait) : problem.message}`;
    if (tell) await fail(ctx, row, reason);
    else store.endSpecReview(row.id, "failed", { reason });
    return { kind: "failed", version: row.version, round: row.round, reason };
  }
  store.updateSpecReview(row.id, { thread_id: null, wait_json: JSON.stringify(wait) });
  store.changed(row.project_id);
  return { kind: "reviewing", version: row.version, round: row.round, waiting: { reason: wait.reason, until: wait.until } };
}

/** The tick's step for spec reviews whose reviewer did not start: each one past its retry time starts again. */
export async function retrySpecReviews(ctx: EngineCtx): Promise<void> {
  for (const row of ctx.store.openSpecReviews()) {
    const wait = waitOfReview(row);
    if (row.thread_id !== null || wait === null || wait.until > ctx.now()) continue;
    const project = ctx.store.project(row.project_id);
    const version = project === null ? null : ctx.store.specVersion(project.id, row.version);
    if (project === null || version === null) continue;
    await spawnReviewer(ctx, project, row, version.toml, JSON.parse(version.spec_json) as Spec, true);
  }
}

// ---------------------------------------------------------------- verdicts

/** The reviewer's verdict: no findings is an approval. It goes to the planner as a message. */
export async function specVerdict(ctx: EngineCtx, threadId: string, findings: SpecFinding[], summary: string): Promise<string> {
  const { store } = ctx;
  const row = store.specReviewByThreadId(threadId);
  if (row === null) throw new LoomError("loom_forbidden", "This tool is for Loom's spec reviewer thread.");
  if (row.state !== "reviewing") throw new LoomError("loom_invalid_state", "This review is over, so there is nothing to decide. End your turn.");
  const text = summary.trim();
  if (text === "") throw new LoomError("loom_invalid_input", "The summary is empty. Say why the spec builds what the human asked for, or what is wrong.");
  if (!store.endSpecReview(row.id, findings.length === 0 ? "approved" : "changes_requested", { summary: text, findings })) {
    throw new LoomError("loom_invalid_state", "This review is over, so there is nothing to decide. End your turn.");
  }
  const project = store.project(row.project_id)!;
  await tellPlanner(ctx, project, specReviewVerdictText({ slug: project.slug, version: row.version, round: row.round, summary: text, findings, pending: project.approved_version !== null }));
  // The reviewer's own thread is busy running this call; its next idle archives it.
  return `Your verdict on spec v${row.version} is recorded and goes to the planner. End your turn.`;
}

// ---------------------------------------------------------------- the reviewer's thread

/** The first idle without a verdict gets a nudge, the second fails the review. A review that has ended has its thread archived. */
export async function onSpecReviewerIdle(ctx: EngineCtx, seen: SpecReviewRow): Promise<void> {
  const row = ctx.store.specReview(seen.id);
  if (row === null || row.thread_id === null) return;
  // The reviewer ran, so a wait after an earlier failed start is over.
  if (row.wait_json !== null) ctx.store.updateSpecReview(row.id, { wait_json: null });
  if (row.state !== "reviewing") return endReviewerThread(ctx, row.thread_id);
  if (row.idle_count === 0) {
    ctx.store.updateSpecReview(row.id, { idle_count: 1 });
    await ctx.bb.send(row.thread_id, specReviewNudgeText(row.version)).catch((error) => ctx.bb.log("warn", `Could not nudge ${row.thread_id}: ${errText(error)}`));
    return;
  }
  await fail(ctx, row, "the reviewer ended its turn twice without a verdict");
}

export async function onSpecReviewerGone(ctx: EngineCtx, seen: SpecReviewRow): Promise<void> {
  const row = ctx.store.specReview(seen.id);
  if (row?.state === "reviewing") await fail(ctx, row, "the reviewer's thread was archived or deleted");
}

/**
 * A rate limit retries the turn at the window's reset, as for ticket reviewers; bb's attempt number is the cap. A thread
 * whose environment bb could not provision is a reviewer that did not start. Anything else counts as an idle.
 */
export async function onSpecReviewerTurnFailed(ctx: EngineCtx, row: SpecReviewRow, event: TurnFailure): Promise<void> {
  if (row.state === "reviewing" && event.errorInfo?.category === "rate-limit" && event.attemptNumber <= MAX_RATE_LIMIT_RETRIES) {
    await ctx.bb.retryTurn(event.threadId, event.requestId, rateLimitRetryAt(ctx.now(), event));
    return;
  }
  if (row.state === "reviewing" && event.errorInfo?.category !== "rate-limit") {
    const failure = await ctx.bb.latestSystemError(event.threadId).catch(() => null);
    if (failure?.code === "thread_provisioning_failed" && row.thread_id === event.threadId) {
      // Unbound first, so the archive's event does not read as the human archiving a running reviewer.
      await reviewerStartFailed(ctx, row, provisioningFailure(failure), true);
      await endReviewerThread(ctx, event.threadId);
      return;
    }
  }
  await onSpecReviewerIdle(ctx, row);
}

/**
 * Supersedes the running reviews of the project and ends their threads: of every version when it is archived, or of the
 * versions up to `upTo` when that version was approved, so a newer version proposed meanwhile keeps its review.
 */
export async function endSpecReviews(ctx: EngineCtx, projectId: number, upTo = Number.POSITIVE_INFINITY): Promise<void> {
  for (const row of ctx.store.specReviews(projectId)) {
    if (row.state === "reviewing" && row.version <= upTo) await supersede(ctx, row);
  }
}

/** After a restart: a review with no thread never started, unless it waits to try again; one whose thread is gone failed, and an idle one missed its idle event. */
export async function reconcileSpecReviews(ctx: EngineCtx): Promise<void> {
  for (const row of ctx.store.openSpecReviews()) {
    if (row.thread_id === null && row.wait_json !== null) continue;
    if (row.thread_id === null) {
      await fail(ctx, row, "Loom restarted before the reviewer started");
      continue;
    }
    const thread = await ctx.bb.getThread(row.thread_id);
    if (thread === null || thread.archivedAt !== null || thread.deletedAt !== null) await onSpecReviewerGone(ctx, row);
    else if (thread.status === "idle") await onSpecReviewerIdle(ctx, row);
  }
}

async function supersede(ctx: EngineCtx, row: SpecReviewRow): Promise<void> {
  if (ctx.store.endSpecReview(row.id, "superseded", { reason: "a newer version or an approval replaced it" }) && row.thread_id !== null) await endReviewerThread(ctx, row.thread_id);
}

async function fail(ctx: EngineCtx, row: SpecReviewRow, reason: string): Promise<void> {
  if (!ctx.store.endSpecReview(row.id, "failed", { reason })) return;
  if (row.thread_id !== null) await endReviewerThread(ctx, row.thread_id);
  const project = ctx.store.project(row.project_id)!;
  await tellPlanner(ctx, project, specReviewFailedText({ slug: project.slug, version: row.version, reason }));
}

async function tellPlanner(ctx: EngineCtx, project: ProjectRow, text: string): Promise<void> {
  const planner = project.planner_thread_id;
  if (planner === null) return;
  await ctx.bb.send(planner, text).catch((error) => ctx.bb.log("warn", `Could not tell the planner ${planner} about the spec review: ${errText(error)}`));
}

/** Stops the thread unless it is idle or in error, then archives it, as the record agent's ending does. Cleanup never throws. */
async function endReviewerThread(ctx: EngineCtx, threadId: string): Promise<void> {
  try {
    const thread = await ctx.bb.getThread(threadId);
    if (thread === null || thread.archivedAt !== null || thread.deletedAt !== null) return;
    if (thread.status !== "idle" && thread.status !== "error") await ctx.bb.stop(threadId);
    await ctx.bb.archive(threadId);
  } catch (error) {
    ctx.bb.log("warn", `Could not end the spec reviewer ${threadId}: ${errText(error)}`);
  }
}
