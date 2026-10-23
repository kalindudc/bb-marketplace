// The spec review: a fresh reviewer agent judges each draft spec version against the human's request and for work the
// goal does not need, before the human is asked to approve it. Its row lives in spec_reviews, not in threads, so the
// worker and ticket reviewer machinery never sees it. Drafts are not ticked, so bb's thread events and loom_propose drive it.
import { randomBytes } from "node:crypto";
import type { ProjectRow, SpecReviewRow, Store } from "./db/store";
import { spawnEnvironment, threadBranch } from "./environments";
import { LoomError } from "./projects";
import { specReviewFailedText, specReviewNudgeText, specReviewVerdictText, specReviewerBrief } from "./prompts";
import { isMultiRepo, repoSettings } from "./repos";
import type { Spec } from "./spec";
import { SPEC_REVIEW_ROUNDS } from "./states";
import { MAX_RATE_LIMIT_RETRIES, rateLimitRetryAt, type EngineCtx, type TurnFailure } from "./workers";

export interface SpecFinding {
  path?: string;
  title: string;
  detail: string;
}

export type SpecReviewStatus =
  | { kind: "none" }
  | { kind: "reviewing"; version: number; round: number }
  | { kind: "approved"; version: number; round: number; summary: string }
  | { kind: "changes"; version: number; round: number; findings: SpecFinding[] }
  | { kind: "failed"; version: number; round: number; reason: string }
  | { kind: "limit"; version: number; findings: SpecFinding[] };

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const findingsOf = (row: SpecReviewRow) => JSON.parse(row.findings_json) as SpecFinding[];
const roundsWithFindings = (rows: readonly SpecReviewRow[]) => rows.filter((row) => row.state === "changes_requested");

/**
 * Where the newest draft version's review stands. A project with no review rows has nothing to wait for: its draft is
 * from before spec reviews, or was proposed without the tool. Otherwise the newest row for the newest version decides.
 */
export function specReviewStatus(store: Store, project: ProjectRow): SpecReviewStatus {
  if (project.state !== "draft") return { kind: "none" };
  const rows = store.specReviews(project.id);
  if (rows.length === 0) return { kind: "none" };
  const version = store.latestSpecVersion(project.id)!.version;
  const changes = roundsWithFindings(rows);
  const atLimit = changes.length >= SPEC_REVIEW_ROUNDS;
  const own = rows.filter((row) => row.version === version && row.state !== "superseded").at(-1);
  if (own === undefined) {
    if (atLimit) return { kind: "limit", version, findings: findingsOf(changes.at(-1)!) };
    return { kind: "failed", version, round: changes.length + 1, reason: "no review ran for this version" };
  }
  switch (own.state) {
    case "reviewing":
      return { kind: "reviewing", version, round: own.round };
    case "approved":
      return { kind: "approved", version, round: own.round, summary: own.summary ?? "" };
    case "changes_requested":
      return atLimit ? { kind: "limit", version, findings: findingsOf(own) } : { kind: "changes", version, round: own.round, findings: findingsOf(own) };
    default:
      return { kind: "failed", version, round: own.round, reason: own.reason ?? "the review did not finish" };
  }
}

/** Why a draft cannot be approved yet, or null when it can: the kinds specReviewBlocks names. */
export function approvalRefusal(slug: string, status: SpecReviewStatus): LoomError | null {
  const refuse = (version: number, why: string) =>
    new LoomError("loom_invalid_state", `Draft v${version} of ${slug} ${why}.`, `Wait for the planner to hand it over, or approve it anyway with \`bb loom approve ${slug} --skip-review\`.`);
  switch (status.kind) {
    case "reviewing":
      return refuse(status.version, `is still in its spec review (round ${status.round} of ${SPEC_REVIEW_ROUNDS})`);
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
 * Runs after every successful loom_propose on a draft. Reviews of older versions are superseded; the newest version keeps
 * a review that is running, passed, has findings or reached the round limit, and gets a new one when it has none or it failed.
 */
export async function ensureSpecReview(ctx: EngineCtx, slug: string): Promise<SpecReviewStatus> {
  const { store } = ctx;
  const project = store.projectBySlug(slug);
  if (project === null || project.state !== "draft") return { kind: "none" };
  const latest = store.latestSpecVersion(project.id)!;
  for (const row of store.specReviews(project.id)) {
    if (row.state === "reviewing" && row.version < latest.version) await supersede(ctx, row);
  }
  const status = specReviewStatus(store, project);
  if (status.kind !== "none" && status.kind !== "failed") return status;
  return startReview(ctx, project, latest.version, latest.toml, JSON.parse(latest.spec_json) as Spec);
}

async function startReview(ctx: EngineCtx, project: ProjectRow, version: number, toml: string, spec: Spec): Promise<SpecReviewStatus> {
  const { store } = ctx;
  const earlier = store.specReviews(project.id);
  const round = roundsWithFindings(earlier).length + 1;
  const token = randomBytes(12).toString("hex");
  // Reserved before the spawn, so a restart mid-spawn leaves a row that reconcile can fail.
  const row = store.addSpecReview({ project_id: project.id, version, round, spawn_token: token });
  // A multi-repo project's reviewer starts in its first repo. Not freshBaseOf: a draft has no integration branch yet.
  const settings = repoSettings(spec, isMultiRepo(spec) ? spec.repo![0]!.name : null);
  const agent = spec.agents.reviewer;
  try {
    if (project.host_id === null) throw new Error("the project has no machine");
    const spawned = await ctx.bb.spawnThread({
      bbProjectId: settings.bbProjectId ?? project.bb_project_id,
      hostId: project.host_id,
      baseBranch: `${settings.remote}/${settings.base}`,
      environment: spawnEnvironment(settings, { branch: threadBranch(project.slug, "spec", `review-${version}-${round}`), base: `${settings.remote}/${settings.base}` }),
      title: `${project.key} · spec review v${version}`,
      prompt: specReviewerBrief({ project, spec, toml, version, round, earlier }),
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
    const reason = `bb could not start the reviewer: ${errText(error)}`;
    store.endSpecReview(row.id, "failed", { reason });
    return { kind: "failed", version, round, reason };
  }
  store.changed(project.id);
  return { kind: "reviewing", version, round };
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
  await tellPlanner(ctx, project, specReviewVerdictText({ slug: project.slug, version: row.version, round: row.round, summary: text, findings }));
  // The reviewer's own thread is busy running this call; its next idle archives it.
  return `Your verdict on spec v${row.version} is recorded and goes to the planner. End your turn.`;
}

// ---------------------------------------------------------------- the reviewer's thread

/** The first idle without a verdict gets a nudge, the second fails the review. A review that has ended has its thread archived. */
export async function onSpecReviewerIdle(ctx: EngineCtx, seen: SpecReviewRow): Promise<void> {
  const row = ctx.store.specReview(seen.id);
  if (row === null || row.thread_id === null) return;
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

/** A rate limit retries the turn at the window's reset, as for ticket reviewers; bb's attempt number is the cap. Anything else counts as an idle. */
export async function onSpecReviewerTurnFailed(ctx: EngineCtx, row: SpecReviewRow, event: TurnFailure): Promise<void> {
  if (row.state === "reviewing" && event.errorInfo?.category === "rate-limit" && event.attemptNumber <= MAX_RATE_LIMIT_RETRIES) {
    await ctx.bb.retryTurn(event.threadId, event.requestId, rateLimitRetryAt(ctx.now(), event));
    return;
  }
  await onSpecReviewerIdle(ctx, row);
}

/** Supersedes every running review of the project and ends its thread: the project was approved or archived. */
export async function endSpecReviews(ctx: EngineCtx, projectId: number): Promise<void> {
  for (const row of ctx.store.specReviews(projectId)) {
    if (row.state === "reviewing") await supersede(ctx, row);
  }
}

/** After a restart: a review with no thread never started, one whose thread is gone failed, and an idle one missed its idle event. */
export async function reconcileSpecReviews(ctx: EngineCtx): Promise<void> {
  for (const row of ctx.store.openSpecReviews()) {
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
