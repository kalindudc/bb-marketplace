// A ticket's activity for the ticket page: its posts, the runs Loom recorded and its worker threads, grouped into worker attempts.
import type { PostRow, RunRow, ThreadRow } from "./db/store";
import { endLabel } from "./format";
import { clip } from "./prompts";
import { STEP_LABELS } from "./runs";
import type { TicketState } from "./states";

export type Mark = "pass" | "fail" | "running" | "none";

export interface CheckStep {
  label: string;
  kind: "command" | "git";
  ok: boolean | null;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number | null;
  running: boolean;
  /** When the recorded run started; null for a step known only from its check post. */
  startedAt: number | null;
  /** The recorded run, whose output the page loads with runOutput; null for a step known only from its check post. */
  runId: number | null;
  outputChars: number;
  /** The failed step's output from an old check post's text; null otherwise. */
  output: string | null;
}

export interface ChecksItem {
  type: "checks";
  /** null for a pipeline run with no check post: one that is running, or that a restart or a host failure cut short. */
  postId: number | null;
  at: number;
  afterMerge: boolean;
  status: "passed" | "failed" | "running" | "unfinished";
  steps: CheckStep[];
  outside: string[];
  /** How an after-merge command that passed changed the branch; null otherwise. */
  changed: string | null;
}

export interface ReviewItem {
  type: "review";
  postId: number;
  reviewId: number;
  /** The notes the reviewer wrote during this review. */
  notePostIds: number[];
}

export interface MergeItem {
  type: "merge";
  /** null for merge steps that no merge post follows yet. */
  postId: number | null;
  at: number;
  outcome:
    | "merged"
    | "conflict"
    | "pr_opened"
    | "pr_pushed"
    | "pr_unchanged"
    | "pr_merged"
    | "branch_pushed"
    | "branch_landed"
    | "diverged"
    | "restacked"
    | "held"
    | "restack_conflict"
    | "restack_waits"
    | "retargeted"
    | "retarget_failed"
    | "retarget_by_hand"
    | "review_requested"
    | "review_request_failed"
    | null;
  into: string | null;
  running: boolean;
  steps: CheckStep[];
}

/** The pull request's text: the worker's, or Loom's template; a fix round's has only the commit message. */
export interface PrTextItem {
  type: "pr_text";
  postId: number;
  at: number;
  by: "worker" | "loom";
  fix: boolean;
  round: number;
  title: string | null;
  body: string | null;
  commit: string;
  /** Why Loom's template stood in; null for the worker's text. */
  reason: string | null;
}

export interface PrFeedbackEntry {
  kind: "review" | "thread" | "comment" | "reply";
  author: string;
  bot?: boolean;
  body: string;
  url: string | null;
  state: string | null;
  path: string | null;
  line: number | null;
}

/** What one fix round sent the worker: failed checks and review feedback, or the human's reply. */
export interface PrFeedbackItem {
  type: "pr_feedback";
  postId: number;
  at: number;
  round: number;
  /** Over the spec's fix-round limit: the ticket blocked instead. */
  overLimit: boolean;
  /** The rounds the pull request's feedback started since the last requeue, this one included; null for the human's reply. */
  counted: number | null;
  human: boolean;
  url: string | null;
  checks: Array<{ name: string; url: string | null }>;
  items: PrFeedbackEntry[];
  ignored: { bots: number; own: number };
}

export type ActivityItem = { type: "post"; postId: number } | ChecksItem | ReviewItem | MergeItem | PrTextItem | PrFeedbackItem;

export interface Attempt {
  n: number;
  claimPostId: number;
  threadId: string | null;
  startedAt: number;
  endedAt: number | null;
  outcome: "merged" | "in_progress" | "blocked" | "cancelled" | "ended";
  /** What happened, for the attempt's folded row; null while it is in progress. */
  line: string | null;
  /** `pr`: each push to the pull request passes, each round of its feedback fails, and it runs while the pull request is open. */
  pipeline: { work: Mark; checks: Mark[]; review: Mark[]; merge: Mark[]; pr: Mark[] };
  /** Oldest first. Replies are not items: the page nests them under their parent. */
  items: ActivityItem[];
}

export interface TicketActivity {
  brief: { postId: number; at: number; edits: number; fields: string[] } | null;
  /** The items posted before the first worker attempt. */
  before: ActivityItem[];
  /** Oldest first. */
  attempts: Attempt[];
}

/** A terminal's output without its colour and link escapes (CSI and OSC sequences). */
export const stripAnsi = (text: string) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");

interface DataRun {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

interface PostData {
  passed?: boolean;
  afterMerge?: boolean;
  changed?: string;
  runs?: DataRun[];
  outside?: string[];
  review?: number;
  verdict?: string;
  outcome?: MergeItem["outcome"] | "pr_text" | "pr_feedback" | "after_open_failed";
  branch?: string;
  patch?: Record<string, unknown>;
  by?: "worker" | "loom";
  fix?: boolean;
  round?: number;
  title?: string | null;
  body?: string | null;
  commit?: string;
  reason?: string;
  overLimit?: boolean;
  human?: boolean;
  counted?: number | null;
  url?: string | null;
  checks?: PrFeedbackItem["checks"];
  items?: PrFeedbackEntry[];
  ignored?: PrFeedbackItem["ignored"];
}

// Stacking's holds, catch-ups that could not run and base moves are about the pull request, so they mark no merge either.
const PR_STAGE: ReadonlySet<string> = new Set(["pr_opened", "pr_pushed", "pr_unchanged", "pr_merged", "branch_pushed", "branch_landed", "held", "restack_conflict", "restack_waits", "retargeted", "retarget_failed", "retarget_by_hand", "review_requested", "review_request_failed"]);
const isPrStage = (data: PostData) => data.outcome === "pr_text" || data.outcome === "pr_feedback";

const LINE_MAX = 140;
const IN_PROGRESS: readonly TicketState[] = ["working", "checking", "review", "approved", "merging", "pr_open"];
const CHECK_MARKS: Record<ChecksItem["status"], Mark> = { passed: "pass", failed: "fail", running: "running", unfinished: "none" };

const dataOf = (post: PostRow) => JSON.parse(post.data_json) as PostData;

const runStep = (run: RunRow): CheckStep => ({
  label: run.label,
  kind: run.kind,
  ok: run.ok === null ? null : run.ok === 1,
  exitCode: run.exit_code,
  timedOut: run.timed_out === 1,
  durationMs: run.duration_ms,
  running: run.ended_at === null,
  startedAt: run.started_at,
  runId: run.id,
  outputChars: run.output_chars,
  output: null,
});

const dataStep = (run: DataRun): CheckStep => ({
  label: run.command,
  kind: "command",
  ok: run.exitCode === 0 && !run.timedOut,
  exitCode: run.exitCode,
  timedOut: run.timedOut,
  durationMs: run.durationMs,
  running: false,
  startedAt: null,
  runId: null,
  outputChars: 0,
  output: null,
});

/** Every run of the pipeline commits first, so each check-stage commit starts a new run of it. */
function pipelineRuns(runs: readonly RunRow[]): RunRow[][] {
  const groups: RunRow[][] = [];
  for (const run of runs) {
    if (groups.length === 0 || (run.kind === "git" && run.label === STEP_LABELS.commitAll)) groups.push([]);
    groups.at(-1)!.push(run);
  }
  return groups;
}

/** A command that failed or timed out; for an after-merge command that passed but changed the branch, the last command. -1 for none. */
function failedStep(steps: readonly CheckStep[], data: PostData): number {
  const failed = steps.findIndex((step) => step.timedOut || (step.exitCode !== null && step.exitCode !== 0));
  if (failed !== -1 || data.afterMerge !== true || data.changed === undefined) return failed;
  return steps.map((step) => step.kind).lastIndexOf("command");
}

// checkPost and afterMergePost write a title line, one line per command, a blank line, then the tail of the failed command's output.
function postTail(post: PostRow, data: PostData): string | null {
  const tail = stripAnsi(post.body.split("\n").slice(1 + (data.runs?.length ?? 0)).join("\n").trim());
  return tail === "" ? null : tail;
}

function checksItem(post: PostRow, runs: readonly RunRow[]): ChecksItem {
  const data = dataOf(post);
  const recorded = runs.map(runStep);
  const labels = recorded.filter((step) => step.kind === "command").map((step) => step.label);
  // A refusal ("scope check", "worktree check") is only in the post: the runs table never records it.
  const unrecorded = (data.runs ?? []).filter((run) => {
    const index = labels.indexOf(run.command);
    if (index !== -1) labels.splice(index, 1);
    return index === -1;
  });
  const steps = [...recorded, ...unrecorded.map(dataStep)];
  const passed = data.passed === true;
  const failed = passed ? -1 : failedStep(steps, data);
  if (failed !== -1 && steps[failed]!.runId === null) steps[failed] = { ...steps[failed]!, output: postTail(post, data) };
  return { type: "checks", postId: post.id, at: post.at, afterMerge: data.afterMerge === true, status: passed ? "passed" : "failed", steps, outside: data.outside ?? [], changed: data.changed ?? null };
}

const unposted = (runs: readonly RunRow[], at: number, status: "running" | "unfinished"): ChecksItem => ({
  type: "checks",
  postId: null,
  at: runs[0]?.started_at ?? at,
  afterMerge: false,
  status,
  steps: runs.map(runStep),
  outside: [],
  changed: null,
});

function mergeMark(item: MergeItem): Mark {
  if (item.outcome === "conflict" || item.outcome === "diverged") return "fail";
  if (item.outcome !== null) return "pass";
  return item.running ? "running" : "none";
}

/** stripAnsi, whitespace collapsed, cut after the first ".", "!" or "?" that a space or the end follows, and clipped. */
function firstSentence(text: string): string {
  const flat = stripAnsi(text).replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](?=\s|$)/);
  return clip(end === -1 ? flat : flat.slice(0, end + 1), LINE_MAX);
}

export function ticketActivity(a: { state: TicketState; posts: readonly PostRow[]; threads: readonly ThreadRow[]; runs: readonly RunRow[] }): TicketActivity {
  const top = a.posts.filter((post) => post.parent_id === null);
  const postById = new Map(a.posts.map((post) => [post.id, post]));
  const isAfterMerge = (post: PostRow) => post.kind === "check" && dataOf(post).afterMerge === true;

  // Check runs, by the submit whose window (until the next submit) they started in.
  const checkCards = new Map<number, ChecksItem>();
  const afterSubmit = new Map<number, ChecksItem[]>();
  const submits = top.filter((post) => post.kind === "submit");
  const checkRuns = a.runs.filter((run) => run.stage === "check");
  submits.forEach((submit, index) => {
    const next = submits[index + 1];
    const groups = pipelineRuns(checkRuns.filter((run) => run.started_at >= submit.at && (next === undefined || run.started_at < next.at)));
    const posted = top.find((post) => post.id > submit.id && (next === undefined || post.id < next.id) && post.kind === "check" && !isAfterMerge(post));
    const cards = groups.slice(0, -1).map((group) => unposted(group, submit.at, "unfinished"));
    const last = groups.at(-1);
    if (posted !== undefined) {
      checkCards.set(posted.id, checksItem(posted, last ?? []));
    } else {
      const running = (next === undefined && a.state === "checking") || (last?.some((run) => run.ended_at === null) ?? false);
      if (last !== undefined || running) cards.push(unposted(last ?? [], submit.at, running ? "running" : "unfinished"));
    }
    afterSubmit.set(submit.id, cards);
  });

  // Merge runs, by the first merge result posted at or after they started.
  // The pull request's text and feedback posts run no steps: the steps belong to the push that follows.
  const mergeTargets = top.filter((post) => (post.kind === "merge" && !isPrStage(dataOf(post))) || isAfterMerge(post));
  const mergeRuns = new Map<number, RunRow[]>(mergeTargets.map((post) => [post.id, []]));
  const trailing: RunRow[] = [];
  for (const run of a.runs) {
    if (run.stage !== "merge") continue;
    const target = mergeTargets.find((post) => post.at >= run.started_at);
    if (target === undefined) trailing.push(run);
    else mergeRuns.get(target.id)!.push(run);
  }

  const itemsOf = (posts: readonly PostRow[]): ActivityItem[] => {
    const reviewPosts = posts.filter((post) => post.kind === "review");
    const reviews = new Map(reviewPosts.map((post): [number, ReviewItem] => [post.id, { type: "review", postId: post.id, reviewId: dataOf(post).review!, notePostIds: [] }]));
    const reviewBy = new Map(reviewPosts.filter((post) => post.author_thread_id !== null).map((post) => [post.author_thread_id!, reviews.get(post.id)!]));
    return posts.flatMap((post): ActivityItem[] => {
      switch (post.kind) {
        case "submit":
          return [{ type: "post", postId: post.id }, ...afterSubmit.get(post.id)!];
        case "check":
          return [checkCards.get(post.id) ?? checksItem(post, mergeRuns.get(post.id) ?? [])];
        case "review":
          return [reviews.get(post.id)!];
        case "merge": {
          const data = dataOf(post);
          if (data.outcome === "pr_text") {
            return [{ type: "pr_text", postId: post.id, at: post.at, by: data.by ?? "loom", fix: data.fix === true, round: data.round ?? 0, title: data.title ?? null, body: data.body ?? null, commit: data.commit ?? "", reason: data.reason ?? null }];
          }
          if (data.outcome === "pr_feedback") {
            return [{ type: "pr_feedback", postId: post.id, at: post.at, round: data.round ?? 0, overLimit: data.overLimit === true, counted: data.counted ?? null, human: data.human === true, url: data.url ?? null, checks: data.checks ?? [], items: data.items ?? [], ignored: data.ignored ?? { bots: 0, own: 0 } }];
          }
          const outcome = data.outcome === "after_open_failed" ? null : (data.outcome ?? null);
          return [{ type: "merge", postId: post.id, at: post.at, outcome, into: data.branch ?? null, running: false, steps: (mergeRuns.get(post.id) ?? []).map(runStep) }];
        }
        case "note": {
          const review = post.author_kind === "reviewer" && post.author_thread_id !== null ? reviewBy.get(post.author_thread_id) : undefined;
          if (review === undefined) return [{ type: "post", postId: post.id }];
          review.notePostIds.push(post.id);
          return [];
        }
        default:
          return [{ type: "post", postId: post.id }];
      }
    });
  };

  // Every top-level post goes to the attempt of the last claim before it; those before the first claim go to `before`.
  let brief: PostRow | null = null;
  const segments: PostRow[][] = [[]];
  for (const post of top) {
    if (post.kind === "brief" && brief === null) brief = post;
    else if (post.kind === "claim") segments.push([]);
    else segments.at(-1)!.push(post);
  }

  // spawnWorker writes a claim and its worker row in one transaction, and nothing else writes either.
  const claims = top.filter((post) => post.kind === "claim");
  const workers = a.threads.filter((row) => row.role === "worker");
  const attempts = claims.map((claim, index): Attempt => {
    const row = workers[index];
    const posts = segments[index + 1]!;
    const newest = index === claims.length - 1;
    const items = itemsOf(posts);
    const late = trailing.filter((run) => claims.filter((other) => other.at <= run.started_at).at(-1) === claim);
    if (late.length > 0) items.push({ type: "merge", postId: null, at: late[0]!.started_at, outcome: null, into: null, running: newest && a.state === "merging", steps: late.map(runStep) });
    const endedAt = row?.state === "ended" ? row.ended_at : null;

    const work: Mark = posts.some((post) => post.kind === "submit") ? "pass" : endedAt === null ? "running" : "fail";
    const pipeline = {
      work,
      checks: items.flatMap((item) => (item.type === "checks" && !item.afterMerge ? [CHECK_MARKS[item.status]] : [])),
      review: [
        ...items.flatMap((item): Mark[] => (item.type === "review" ? [dataOf(postById.get(item.postId)!).verdict === "approved" ? "pass" : "fail"] : [])),
        ...(newest && a.state === "review" ? (["running"] as const) : []),
      ],
      merge: items.flatMap((item): Mark[] => (item.type === "merge" && !PR_STAGE.has(item.outcome ?? "") ? [mergeMark(item)] : item.type === "checks" && item.afterMerge ? ["fail"] : [])),
      pr: [
        ...items.flatMap((item): Mark[] => (item.type === "merge" && PR_STAGE.has(item.outcome ?? "") ? ["pass"] : item.type === "pr_feedback" ? ["fail"] : [])),
        ...(newest && a.state === "pr_open" ? (["running"] as const) : []),
      ],
    };

    const merged = items.find((item): item is MergeItem => item.type === "merge" && (item.outcome === "merged" || item.outcome === "pr_merged"));
    const block = posts.filter((post) => post.kind === "block").at(-1);
    const outcome: Attempt["outcome"] =
      merged !== undefined
        ? "merged"
        : newest && a.state === "cancelled"
          ? "cancelled"
          : newest && IN_PROGRESS.includes(a.state)
            ? "in_progress"
            : block !== undefined || (newest && a.state === "blocked")
              ? "blocked"
              : "ended";
    const ended = row?.thread_id == null ? "The worker could not start." : `The worker ended: ${endLabel(row.end_reason)}.`;
    let line: string | null = null;
    if (outcome === "merged") line = postById.get(merged!.postId!)!.body;
    else if (outcome === "cancelled") line = posts.filter((post) => post.kind === "system" && post.body.startsWith("Cancelled:")).at(-1)?.body ?? "Cancelled.";
    else if (outcome === "blocked" && block !== undefined) line = `${block.author_kind === "worker" ? "Asked the planner: " : "Blocked: "}${firstSentence(block.body)}`;
    else if (outcome !== "in_progress") line = ended;

    return { n: row?.attempt ?? index + 1, claimPostId: claim.id, threadId: row?.thread_id ?? null, startedAt: claim.at, endedAt, outcome, line, pipeline, items };
  });

  const edits = a.posts.filter((post) => post.kind === "system" && post.author_kind === "planner" && dataOf(post).patch !== undefined);
  return {
    brief: brief === null ? null : { postId: brief.id, at: brief.at, edits: edits.length, fields: [...new Set(edits.flatMap((post) => Object.keys(dataOf(post).patch!)))] },
    before: itemsOf(segments[0]!),
    attempts,
  };
}
