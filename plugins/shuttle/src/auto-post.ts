// Auto post's posting half. A checked draft in a repository whose mode posts is scheduled: at once in auto mode, after a
// countdown in countdown mode. When it is due, every condition is checked again against the PR as its server has it, and
// the review goes through the review queue as the user's, with a footer that says Shuttle posted it. What you mark as a
// mistake counts against the record, and too many marks stop posting in the repository until you resume it.
import { DEFAULT_DISCLOSURE, POSTING_MODES, type AutoPostRepo } from "./config";
import type { Finding, Gate, PostFinding } from "./contract";
import { errText, ShuttleError, type Ctx } from "./ctx";
import type { DraftRow, PrRow, TripRow } from "./db/store";
import type { FindingOutcome } from "./drafts";
import { autoPostRepo, freshPr, parseGate, prApprovalReasons } from "./gate";
import { queueReview } from "./posts";
import { requirePr, shortKey } from "./prs";
import { globMatch } from "./sync";

const DAY = 86_400_000;
type Kind = "comment" | "approve";

/** What a draft would post on its own: an approval with its passing findings, or a comment review of the passing ones. */
export interface Plan {
  verdict: Kind;
  findings: string[];
}

export const modeOf = (repo: AutoPostRepo, kind: Kind) => (kind === "approve" ? repo.approve : repo.mode);
const posts = (repo: AutoPostRepo, kind: Kind) => POSTING_MODES.includes(modeOf(repo, kind));
const KIND_TEXT: Record<Kind, string> = { comment: "comments", approve: "approvals" };

const RANK = { nit: 0, low: 1, medium: 2, high: 3 } as const;

/**
 * What the gate's decision would post in the repository's modes, or null. An approval wins when its mode posts, the
 * review itself suggested approving, and the approval rules approve; it carries the findings that pass the gate as
 * comments, highest severity first, even when comments only record. Otherwise comments post when their mode posts and
 * the gate would post them. Shadow mode records "would approve" for comment drafts too; only approve drafts post.
 */
export function planOf(ctx: Ctx, repo: AutoPostRepo, draft: DraftRow, gate: Gate): Plan | null {
  if (posts(repo, "approve") && draft.verdict === "approve" && gate.approval?.decision === "approve") {
    const passing = new Set(gate.findings.filter((f) => f.pass).map((f) => f.id));
    const findings = (JSON.parse(draft.findings) as Finding[]).map((f, order) => ({ f, order })).filter(({ f }) => passing.has(f.id))
      .sort((a, b) => RANK[b.f.severity] - RANK[a.f.severity] || a.order - b.order);
    return { verdict: "approve", findings: findings.slice(0, ctx.config().autoPost.maxComments).map(({ f }) => f.id) };
  }
  if (posts(repo, "comment") && gate.decision === "post" && gate.posting.length > 0) return { verdict: "comment", findings: gate.posting };
  return null;
}

function waitText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 6) / 10;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

const VERB: Record<Kind, string> = { comment: "comment on", approve: "approve" };

/** Critic threads an approval needs behind it, as many as a finding's quorum. */
const MIN_CRITICS = 2;

/** Refused at the moment of posting: the review is not sent, and the draft waits for the user. */
export class AutoPostRefused extends ShuttleError {
  override readonly name = "AutoPostRefused";
}

/**
 * The settings a decision to post depends on, as one string: the repository's entry (but its footer) and every global
 * auto post setting but the footer, the daily limit and the breaker, which are checked as they are now. A review
 * scheduled under other settings does not post.
 */
export function policyOf(ctx: Ctx, repo: AutoPostRepo, kind: Kind): string {
  const { disclosure: _own, ...entry } = repo;
  return JSON.stringify({ kind, mode: modeOf(repo, kind), entry, rules: rulesOf(ctx) });
}

/**
 * The global rules a gate's decision reads, and the authors Shuttle counts as bots. Left out: what is checked as it is
 * now (the daily limit and the breaker), and what does not change a decision (footers, countdowns, targets, timeout).
 */
function rulesOf(ctx: Ctx) {
  const {
    repos: _repos, disclosure: _disclosure, maxPerDay: _cap, breaker: _breaker, countdownMinutes: _wait, targetPrecision: _target,
    verifierTimeoutSeconds: _timeout, approvals: { target: _approvalTarget, countdownMinutes: _approvalWait, ...approvals }, ...global
  } = ctx.config().autoPost;
  return { ...global, approvals, botAuthors: ctx.settings().botAuthors };
}

/**
 * The rules every repository's decisions read, as one string. The gate takes it before it starts, and a decision is
 * only scheduled if it is the same when the gate ends.
 */
export function decisionSettings(ctx: Ctx): string {
  return JSON.stringify({ rules: rulesOf(ctx), repos: ctx.config().autoPost.repos.map(({ disclosure: _own, ...entry }) => entry) });
}

/** Reviews Shuttle posted in the last day in PRs of this repository entry, and those it queued that have not posted yet. */
function usage(ctx: Ctx, repo: AutoPostRepo, except: number): { posted: number; queued: number } {
  const mine = (draft: DraftRow) => {
    const pr = draft.id === except ? null : ctx.store.prById(draft.pr_id);
    return pr !== null && globMatch(repo.repo, pr.repo);
  };
  return { posted: ctx.store.autoPostedSince(ctx.now() - DAY).filter(mine).length, queued: ctx.store.autoQueued().filter(mine).length };
}

const capText = (repo: AutoPostRepo, cap: number) => `Shuttle already posted or queued ${cap} review${cap === 1 ? "" : "s"} in ${repo.repo} in the last day, its daily limit`;

/**
 * Why a review of this kind must not post in the PR's repository, from settings alone: paused, the mode, a breaker
 * stop, missing approval paths, or, with `policy`, settings changed since it was scheduled.
 */
function settingsRefusal(ctx: Ctx, pr: PrRow, kind: Kind, policy: string | null): string | null {
  if (ctx.settings().pauseAutomations) return "automations are paused";
  const repo = autoPostRepo(ctx.config(), pr.repo);
  if (repo === null || !posts(repo, kind)) return `auto post no longer posts ${KIND_TEXT[kind]} in ${pr.repo}`;
  const trip = ctx.store.openTrip(repo.repo, kind);
  if (trip) return `posting ${KIND_TEXT[kind]} in ${repo.repo} stopped: ${trip.reason}; resume it in Settings`;
  if (kind === "approve" && repo.approvePaths.length === 0) return "no paths are set for approvals to cover";
  if (policy !== null && policy !== policyOf(ctx, repo, kind)) return "the auto post settings changed since it was checked; check it again";
  return null;
}

/** Why the draft must not be scheduled or queued now, from what Shuttle knows without asking the server. */
function knownRefusal(ctx: Ctx, pr: PrRow, draft: DraftRow, kind: Kind, policy: string | null): string | null {
  const settings = settingsRefusal(ctx, pr, kind, policy);
  if (settings) return settings;
  if (draft.head === null || pr.head !== draft.head) return "the PR has new commits since the review read it";
  const repo = autoPostRepo(ctx.config(), pr.repo)!;
  const cap = ctx.config().autoPost.maxPerDay;
  const { posted, queued } = usage(ctx, repo, draft.id);
  if (posted + queued >= cap) return capText(repo, cap);
  if (ctx.store.activePostOfPr(pr.id)) return "a review of it is already queued to post";
  return null;
}

/** Says so when you reviewed the PR after the draft came, on its server or through Shuttle: then the review is yours. */
function reviewedSince(ctx: Ctx, fresh: PrRow, since: number): string | null {
  let server: { at: number | null } | null = null;
  try {
    server = fresh.my_review ? (JSON.parse(fresh.my_review) as { at: number | null }) : null;
  } catch {
    server = null;
  }
  if (server?.at != null && server.at >= since) return `you reviewed it yourself on ${ctx.server(fresh.server)?.name ?? fresh.server} after the draft came`;
  const mine = ctx.store.latestMyReview(fresh.id);
  if (mine && mine.at >= since) return "you reviewed it yourself after the draft came";
  return null;
}

/** The plan the draft's stored gate makes now; null when it would post nothing. */
function currentPlan(ctx: Ctx, pr: PrRow, draft: DraftRow): Plan | null {
  const repo = autoPostRepo(ctx.config(), pr.repo);
  const gate = parseGate(draft.gate);
  return repo && gate ? planOf(ctx, repo, draft, gate) : null;
}

const samePlan = (plan: Plan | null, verdict: Kind, findings: readonly string[]) => plan !== null && plan.verdict === verdict && plan.findings.join("\n") === findings.join("\n");

/**
 * The check just before an auto post's review is sent, against `fresh`, the PR its server reported a moment ago. The
 * critic threads are read first; everything else is checked after the last read, so nothing can change in between but
 * the server itself. Throws AutoPostRefused with the reason.
 */
export async function authorizeAutoPost(ctx: Ctx, fresh: PrRow, draftId: number, input: { verdict: string; findings: ReadonlyArray<{ id?: string }> }): Promise<void> {
  const before = ctx.store.draftById(draftId);
  if (!before) throw new AutoPostRefused("its draft is gone");
  const ids = input.findings.map((f) => f.id ?? "");
  const findings = JSON.parse(before.findings) as Finding[];
  // An approval needs critics behind it even with no findings to vote on: at least the two a finding's quorum needs.
  const votes = Math.max(before.auto_post_verdict === "approve" ? MIN_CRITICS : 0, ...findings.filter((f) => ids.includes(f.id)).map((f) => f.consensus?.total ?? 0));
  const critics = votes > 0 ? await ctx.port.childThreads(before.thread_id).then((rows) => rows.length, () => null) : 0;
  const draft = ctx.store.draftById(draftId)!;
  const kind = draft.auto_post_verdict;
  const refusal = (() => {
    if (draft.state !== "draft" || draft.auto_post_state !== "queued" || kind === null || input.verdict !== kind) return "it is no longer queued to post";
    if (ctx.store.pastDrafts(draft.pr_id, 1)[0]?.id !== draft.id) return "a newer review of the PR replaced it";
    const settings = settingsRefusal(ctx, fresh, kind, draft.auto_post_policy);
    if (settings) return settings;
    const repo = autoPostRepo(ctx.config(), fresh.repo)!;
    const cap = ctx.config().autoPost.maxPerDay;
    // Posts are sent one at a time per server, so the ones already sent today are all that count here.
    if (usage(ctx, repo, draft.id).posted >= cap) return capText(repo, cap);
    if (!samePlan(currentPlan(ctx, fresh, draft), kind, ids)) return "it no longer passes the gate as it did";
    if (fresh.state !== "open") return fresh.state === "draft" ? "the PR went back to draft" : `the PR is ${fresh.state}`;
    const yours = reviewedSince(ctx, fresh, draft.created_at);
    if (yours) return yours;
    if (draft.head === null || fresh.head !== draft.head) return "the PR has new commits since the review read it";
    if (kind === "approve") {
      const late = prApprovalReasons(ctx, fresh, draft, repo);
      if (late.length) return late[0]!;
    }
    // Votes the review reports need critic threads to have cast them; a review that invents votes has none.
    if (critics === null) return "could not read the review's critic threads";
    if (critics < votes) return kind === "approve" && votes === MIN_CRITICS && critics < votes
      ? `an approval needs at least ${MIN_CRITICS} critic threads behind it, and the review's thread has ${critics}`
      : `the review reports ${votes} critic votes, but its thread has ${critics} child thread${critics === 1 ? "" : "s"}`;
    return null;
  })();
  if (refusal !== null) throw new AutoPostRefused(refusal);
}

/** Records a review the queue refused to send, and tells the user. */
export function refusedAtPost(ctx: Ctx, pr: PrRow, draftId: number, reason: string): void {
  const draft = ctx.store.draftById(draftId);
  if (!draft) return;
  const kind = draft.auto_post_verdict ?? "comment";
  ctx.store.setAutoPost(draft.id, { state: "refused", reason });
  ctx.store.addEvent("auto_post", `Auto post did not ${VERB[kind]} ${shortKey(ctx, pr)}: ${reason}.`, pr.id, draft.thread_id);
  void ctx.port.notify(`Shuttle did not ${VERB[kind]} ${shortKey(ctx, pr)}`, `${reason}. The draft waits for you.`);
}

/** Records and announces a review the queue sent. */
export function postedByShuttle(ctx: Ctx, pr: PrRow, draft: DraftRow, comments: number): void {
  const kind = draft.auto_post_verdict ?? "comment";
  const text = `${kind === "approve" ? "approved" : "commented on"} ${shortKey(ctx, pr)}${comments ? ` with ${comments} comment${comments === 1 ? "" : "s"}` : ""}`;
  ctx.store.addEvent("auto_post", `Auto post ${text}.`, pr.id, draft.thread_id);
  void ctx.port.notify(`Shuttle ${text}`, `${pr.title}. Mark anything wrong from the PR's Your review tab.`);
}

/**
 * Schedules, keeps or drops the draft's auto post after a fresh check. A draft you stopped, or one queued or posted,
 * keeps its state; a refused one may be scheduled again by a new check. In countdown mode it waits and you are told.
 */
export function scheduleAutoPost(ctx: Ctx, draftId: number, checkedUnder: string): void {
  const draft = ctx.store.draftById(draftId);
  if (!draft || draft.state !== "draft") return;
  const known = ctx.store.prById(draft.pr_id);
  // Settings changed while the gate ran: its decision is about other settings, so it posts nothing until checked again.
  const postsHere = (repo: AutoPostRepo | null) => repo !== null && (posts(repo, "comment") || posts(repo, "approve"));
  if (checkedUnder !== decisionSettings(ctx) && (draft.auto_post_state !== null || postsHere(known ? autoPostRepo(ctx.config(), known.repo) : null))) {
    const reason = "the auto post settings changed while it was checked; check it again";
    if (draft.auto_post_state !== "stopped" && draft.auto_post_state !== "queued" && draft.auto_post_state !== "posted") ctx.store.setAutoPost(draft.id, { state: "refused", reason });
    if (known) ctx.store.addEvent("auto_post", `Auto post did not schedule ${shortKey(ctx, known)}: ${reason}.`, known.id, draft.thread_id);
    if (known && draft.auto_post_state === "scheduled") void ctx.port.notify(`Shuttle will not post on ${shortKey(ctx, known)} after all`, `The auto post settings changed while it was checked; check it again.`);
    return;
  }
  if (draft.auto_post_state === "stopped" || draft.auto_post_state === "queued" || draft.auto_post_state === "posted") return;
  const pr = ctx.store.prById(draft.pr_id);
  const gate = parseGate(draft.gate);
  const repo = pr ? autoPostRepo(ctx.config(), pr.repo) : null;
  const plan = pr && repo && gate ? planOf(ctx, repo, draft, gate) : null;
  if (!pr || !repo || plan === null) {
    if (draft.auto_post_state === "scheduled" && pr) {
      const why = gate?.approval?.reasons[0] ?? gate?.reasons[0] ?? "it no longer passes";
      ctx.store.setAutoPost(draft.id, { state: "refused", reason: `a check again held it: ${why}` });
      ctx.store.addEvent("auto_post", `Auto post will not post on ${shortKey(ctx, pr)} after all: a check again held it (${why}).`, pr.id, draft.thread_id);
      void ctx.port.notify(`Shuttle will not post on ${shortKey(ctx, pr)} after all`, `A check again held it: ${why}.`);
    }
    return;
  }
  const refusal = knownRefusal(ctx, pr, draft, plan.verdict, null);
  if (refusal) {
    if (draft.auto_post_state === "scheduled") void ctx.port.notify(`Shuttle will not post on ${shortKey(ctx, pr)} after all`, `${refusal}.`);
    ctx.store.setAutoPost(draft.id, { state: "refused", at: null, verdict: plan.verdict, reason: refusal, policy: null, findings: JSON.stringify(plan.findings) });
    ctx.store.addEvent("auto_post", `Auto post would ${VERB[plan.verdict]} ${shortKey(ctx, pr)}, but won't: ${refusal}.`, pr.id, draft.thread_id);
    return;
  }
  const config = ctx.config().autoPost;
  const wait = modeOf(repo, plan.verdict) === "auto" ? 0 : (plan.verdict === "approve" ? config.approvals.countdownMinutes : config.countdownMinutes) * 60_000;
  // A check again keeps the countdown already running for the same review under the same mode and settings.
  const policy = policyOf(ctx, repo, plan.verdict);
  const findings = JSON.stringify(plan.findings);
  const kept = draft.auto_post_state === "scheduled" && draft.auto_post_verdict === plan.verdict && draft.auto_post_at !== null && draft.auto_post_policy === policy && draft.auto_post_findings === findings;
  const at = kept ? draft.auto_post_at! : ctx.now() + wait;
  ctx.store.setAutoPost(draft.id, { state: "scheduled", at, verdict: plan.verdict, reason: null, policy, findings });
  if (kept || wait === 0) return;
  const what = `${plan.verdict === "approve" ? "approve" : "comment on"} ${shortKey(ctx, pr)}${plan.findings.length ? ` with ${plan.findings.length} comment${plan.findings.length === 1 ? "" : "s"}` : ""}`;
  ctx.store.addEvent("auto_post", `Auto post will ${what} in ${waitText(wait)} unless you stop it.`, pr.id, draft.thread_id);
  void ctx.port.notify(`Shuttle will ${what} in ${waitText(wait)}`, `${pr.title}. Stop it from the PR's Your review tab.`);
}

/** The review's body: its summary, then the footer that says Shuttle posted it. Approvals always carry a footer. */
export function bodyOf(ctx: Ctx, repo: AutoPostRepo, draft: DraftRow, kind: Kind): string {
  const footer = (repo.disclosure.trim() || ctx.config().autoPost.disclosure.trim() || (kind === "approve" ? DEFAULT_DISCLOSURE : "")).trim();
  const summary = draft.summary.trim();
  return footer ? `${summary}\n\n---\n${footer}` : summary;
}

/**
 * Queues the scheduled draft's review when nothing Shuttle knows stops it, else records why. The queue checks it again
 * against the PR on its server just before sending it. Returns whether it queued.
 */
export function queueAutoDraft(ctx: Ctx, draftId: number): boolean {
  const draft = ctx.store.draftById(draftId);
  if (!draft || draft.state !== "draft" || draft.auto_post_state !== "scheduled" || draft.auto_post_verdict === null) return false;
  const pr = ctx.store.prById(draft.pr_id);
  if (!pr) return false;
  const kind = draft.auto_post_verdict;
  const repo = autoPostRepo(ctx.config(), pr.repo);
  const plan = currentPlan(ctx, pr, draft);
  const scheduled = draft.auto_post_findings ? (JSON.parse(draft.auto_post_findings) as string[]) : [];
  const refusal = knownRefusal(ctx, pr, draft, kind, draft.auto_post_policy)
    ?? (repo === null || !samePlan(plan, kind, scheduled) ? "it no longer passes the gate as it did" : null);
  if (refusal !== null || repo === null || plan === null) return refuse(ctx, pr, draft, refusal ?? "it no longer passes the gate as it did");
  const byId = new Map((JSON.parse(draft.findings) as Finding[]).map((f) => [f.id, f]));
  const findings = plan.findings.map((id) => byId.get(id)!).filter(Boolean);
  const input = {
    verdict: plan.verdict, body: bodyOf(ctx, repo, draft, plan.verdict), draftId: draft.id, auto: true,
    findings: findings.map((f): PostFinding => ({ id: f.id, path: f.path, line: f.line, body: f.body })),
  };
  try {
    ctx.store.tx(() => {
      queueReview(ctx, pr.key, input);
      ctx.store.setAutoPost(draft.id, { state: "queued", at: ctx.now(), reason: null });
    });
  } catch (error) {
    return refuse(ctx, pr, draft, errText(error));
  }
  ctx.store.addEvent("auto_post", `Auto post queued its ${plan.verdict === "approve" ? "approval" : "review"} of ${shortKey(ctx, pr)}; it checks the PR again just before it posts.`, pr.id, draft.thread_id);
  ctx.port.publish();
  return true;
}

function refuse(ctx: Ctx, pr: PrRow, draft: DraftRow, reason: string): false {
  refusedAtPost(ctx, pr, draft.id, reason);
  ctx.port.publish();
  return false;
}

/** Queues every draft whose countdown ended. */
export function runAutoPosts(ctx: Ctx): number {
  let queued = 0;
  for (const draft of ctx.store.dueAutoPosts(ctx.now())) {
    if (ctx.lifetime?.aborted) break;
    try {
      if (queueAutoDraft(ctx, draft.id)) queued++;
    } catch (error) {
      ctx.port.log("warn", `auto post of draft ${draft.id}: ${errText(error)}`);
    }
  }
  return queued;
}

function scheduledDraft(ctx: Ctx, key: string, draftId: number): { pr: PrRow; draft: DraftRow } {
  const pr = requirePr(ctx, key);
  const draft = ctx.store.draftById(draftId);
  if (!draft || draft.pr_id !== pr.id) throw new ShuttleError("That draft is not this PR's");
  if (draft.state !== "draft" || draft.auto_post_state !== "scheduled") throw new ShuttleError("That draft is not waiting to post on its own");
  return { pr, draft };
}

export function stopAutoPost(ctx: Ctx, key: string, draftId: number): PrRow {
  const { pr, draft } = scheduledDraft(ctx, key, draftId);
  ctx.store.setAutoPost(draft.id, { state: "stopped", reason: "you stopped it" });
  ctx.store.addEvent("auto_post", `You stopped auto post on ${shortKey(ctx, pr)}; the draft waits for you.`, pr.id, draft.thread_id);
  ctx.port.publish();
  return pr;
}

/** Queues a scheduled draft now; the queue checks it against the PR on its server just before it posts. */
export function autoPostNow(ctx: Ctx, key: string, draftId: number): PrRow {
  const { pr, draft } = scheduledDraft(ctx, key, draftId);
  queueAutoDraft(ctx, draft.id);
  const after = ctx.store.draftById(draft.id)!;
  if (after.auto_post_state === "refused") throw new ShuttleError(`Shuttle did not post it: ${after.auto_post_reason ?? "a check refused it"}`);
  return pr;
}

/** The repository entry a PR's auto post settings come from, matched on the entry as it is now. */
function entryOf(ctx: Ctx, pr: PrRow): AutoPostRepo | null {
  return ctx.config().autoPost.repos.find((repo) => globMatch(repo.repo, pr.repo)) ?? null;
}

/** Stops posting of one kind in the repository entry until the user resumes it, and says why. Never edits the config. */
function trip(ctx: Ctx, repo: AutoPostRepo, kind: Kind, reason: string): void {
  if (ctx.store.openTrip(repo.repo, kind)) return;
  ctx.store.addTrip(repo.repo, kind, reason);
  for (const draft of ctx.store.scheduledAutoPosts()) {
    const pr = ctx.store.prById(draft.pr_id);
    if (pr && draft.auto_post_verdict === kind && globMatch(repo.repo, pr.repo)) ctx.store.setAutoPost(draft.id, { state: "refused", reason: `posting ${KIND_TEXT[kind]} stopped: ${reason}` });
  }
  ctx.store.addEvent("auto_post_breaker", `Auto post stopped posting ${KIND_TEXT[kind]} in ${repo.repo}: ${reason}. Resume it in Settings › Automations.`);
  void ctx.port.notify(`Shuttle stopped posting ${KIND_TEXT[kind]} in ${repo.repo}`, `${reason}. Resume it in Settings › Automations.`);
}

/** Findings Shuttle posted in PRs of the repository entry, newest first, each with whether you marked it. */
function postedFindings(ctx: Ctx, repo: AutoPostRepo): Array<{ marked: boolean }> {
  return ctx.store.autoPostedSince(0).flatMap((draft) => {
    const pr = ctx.store.prById(draft.pr_id);
    if (!pr || !globMatch(repo.repo, pr.repo) || !draft.outcome) return [];
    return (JSON.parse(draft.outcome) as FindingOutcome[]).filter((o) => o.outcome === "auto" || o.outcome === "retracted").map((o) => ({ marked: o.outcome === "retracted" }));
  });
}

/**
 * Marks a finding Shuttle posted, or with no finding its approval, as a mistake, or takes the mark back. A marked
 * approval stops approvals in the repository at once; marked findings stop comments when there are too many of them.
 */
export function markAutoPost(ctx: Ctx, key: string, draftId: number, findingId: string | undefined, undo = false): PrRow {
  const pr = requirePr(ctx, key);
  const draft = ctx.store.draftById(draftId);
  if (!draft || draft.pr_id !== pr.id) throw new ShuttleError("That draft is not this PR's");
  if (draft.auto_post_state !== "posted") throw new ShuttleError("Shuttle did not post that draft itself");
  const repo = entryOf(ctx, pr);
  if (findingId === undefined) {
    if (draft.auto_post_verdict !== "approve") throw new ShuttleError("Shuttle did not approve that PR");
    ctx.store.setApprovalMistake(draft.id, undo ? null : ctx.now());
    ctx.store.addEvent("auto_post", undo ? `You took back marking Shuttle's approval of ${shortKey(ctx, pr)} as a mistake.` : `You marked Shuttle's approval of ${shortKey(ctx, pr)} as a mistake.`, pr.id, draft.thread_id);
    if (!undo && repo) trip(ctx, repo, "approve", `you marked its approval of ${shortKey(ctx, pr)} as a mistake`);
  } else {
    const outcomes = draft.outcome ? (JSON.parse(draft.outcome) as FindingOutcome[]) : [];
    const row = outcomes.find((o) => o.id === findingId && (o.outcome === "auto" || o.outcome === "retracted"));
    if (!row) throw new ShuttleError("Shuttle did not post that finding");
    row.outcome = undo ? "auto" : "retracted";
    ctx.store.setDraftFindingOutcomes(draft.id, JSON.stringify(outcomes));
    ctx.store.addEvent("auto_post", `You ${undo ? "took back marking" : "marked"} a comment Shuttle posted on ${shortKey(ctx, pr)}${undo ? " as a mistake" : " as one it should not have posted"}.`, pr.id, draft.thread_id);
    if (!undo && repo) {
      const { window, maxMarked } = ctx.config().autoPost.breaker;
      const marked = postedFindings(ctx, repo).slice(0, window).filter((f) => f.marked).length;
      if (marked > maxMarked) trip(ctx, repo, "comment", `you marked ${marked} of the last ${window} comments it posted as mistakes`);
    }
  }
  ctx.port.publish();
  return pr;
}

export function resumeAutoPost(ctx: Ctx, repo: string, kind: Kind): number {
  const cleared = ctx.store.clearTrips(repo, kind);
  if (cleared) ctx.store.addEvent("auto_post_breaker", `You resumed posting ${KIND_TEXT[kind]} in ${repo}.`);
  ctx.port.publish();
  return cleared;
}
