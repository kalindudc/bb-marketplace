// A ticket's timeline: its worker and reviewer threads, the runs Loom recorded, and the posts that mark each stage, in order.
import type { PostRow, RunRow, ThreadRow } from "./db/store";
import { endLabel, formatDuration } from "./format";
import { clip } from "./prompts";
import { REVIEWER_REFUSED } from "./review";
import type { PostKind } from "./states";

export type TimelineStage = "work" | "checks" | "review" | "merge" | "other";

export interface TimelineRun {
  id: number;
  kind: "command" | "git";
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number | null;
  running: boolean;
  outputChars: number;
}

export interface TimelineEntry {
  at: number;
  stage: TimelineStage;
  kind: "worker" | "reviewer" | "run" | PostKind;
  title: string;
  detail: string | null;
  /** null for a step with no result: a thread that started, a submit, a system post, and a run that is running or did not finish. */
  ok: boolean | null;
  threadId: string | null;
  run: TimelineRun | null;
}

const TITLE_MAX = 160;
const THREAD_STATE_TEXT = { spawning: "starting", active: "working", ending: "ending" } as const;

interface Ranked {
  entry: TimelineEntry;
  /** Orders entries of one moment by where they come in the pipeline. */
  rank: number;
  id: number;
}

/**
 * When an ended worker's last submit passed its checks and nothing sent the work back before the worker ended, the
 * worker's part was done at that submit, whatever ended its thread later (a refused reviewer blocks the ticket, for one).
 */
function submittedAt(row: ThreadRow, posts: readonly PostRow[]): number | null {
  if (row.role !== "worker" || row.state !== "ended" || row.end_reason === "merged") return null;
  const last = posts.reduce((found, post, index) => (post.kind === "submit" && post.author_thread_id === row.thread_id ? index : found), -1);
  if (last === -1) return null;
  const later = posts
    .slice(last + 1)
    .filter((post) => post.at <= row.ended_at!)
    .map((post) => ({ kind: post.kind, data: JSON.parse(post.data_json) as { passed?: unknown; afterMerge?: unknown; verdict?: unknown; outcome?: unknown } }));
  const check = later.find((post) => post.kind === "check" && post.data.afterMerge !== true);
  const sentBack = later.some(
    ({ kind, data }) => (kind === "review" && data.verdict === "changes_requested") || (kind === "merge" && data.outcome === "conflict") || (kind === "check" && data.afterMerge === true && data.passed !== true),
  );
  return check?.data.passed === true && !sentBack ? posts[last]!.at : null;
}

function threadEntry(row: ThreadRow, posts: readonly PostRow[]): Ranked {
  const worker = row.role === "worker";
  const title = worker ? (row.attempt === null ? "Worker" : `Worker, attempt ${row.attempt}`) : `Reviewer, round ${row.review_round}`;
  const unstarted = row.state === "ended" && row.thread_id === null && row.end_reason === "failed";
  const submitted = submittedAt(row, posts);
  const detail = unstarted
    ? "could not start"
    : submitted !== null
      ? `submitted after ${formatDuration(submitted - row.started_at)}`
      : row.state === "ended"
        ? `${endLabel(row.end_reason)} after ${formatDuration((row.ended_at ?? row.started_at) - row.started_at)}`
        : THREAD_STATE_TEXT[row.state];
  return {
    rank: worker ? 0 : 4,
    id: row.id,
    entry: { at: row.started_at, stage: worker ? "work" : "review", kind: row.role as "worker" | "reviewer", title, detail, ok: unstarted ? false : null, threadId: row.thread_id, run: null },
  };
}

function runEntry(row: RunRow): Ranked {
  const check = row.stage === "check";
  return {
    rank: check ? 2 : 6,
    id: row.id,
    entry: {
      at: row.started_at,
      stage: check ? "checks" : "merge",
      kind: "run",
      title: row.label,
      detail: null,
      ok: row.ok === null ? null : row.ok === 1,
      threadId: null,
      run: { id: row.id, kind: row.kind, exitCode: row.exit_code, timedOut: row.timed_out === 1, durationMs: row.duration_ms, running: row.ended_at === null, outputChars: row.output_chars },
    },
  };
}

function postEntry(post: PostRow): Ranked | null {
  const data = JSON.parse(post.data_json) as { passed?: unknown; afterMerge?: unknown; verdict?: unknown; outcome?: unknown };
  const [first = "", ...rest] = post.body.split("\n");
  const detail = rest.join("\n").trim();
  const base = { at: post.at, kind: post.kind, title: clip(first, TITLE_MAX), detail: detail === "" ? null : detail, threadId: post.author_thread_id, run: null };
  const ranked = (rank: number, stage: TimelineStage, ok: boolean | null): Ranked => ({ rank, id: post.id, entry: { ...base, stage, ok } });
  switch (post.kind) {
    case "submit":
      return { rank: 1, id: post.id, entry: { ...base, stage: "work", title: "Submitted for checks", detail: post.body, ok: null } };
    case "check":
      return data.afterMerge === true ? ranked(7, "merge", data.passed === true) : ranked(3, "checks", data.passed === true);
    case "review":
      return ranked(5, "review", data.verdict === "approved");
    case "merge":
      return ranked(7, "merge", data.outcome !== "conflict");
    // A thread that could not start, and the block a refused reviewer causes, show in the stage of that thread.
    case "block":
      return post.body.startsWith(`${REVIEWER_REFUSED}:`) ? ranked(5, "review", false) : ranked(8, "other", false);
    case "system":
      if (post.body.startsWith("Could not start a worker:")) return ranked(1, "work", false);
      if (post.body.startsWith("Could not start a reviewer:")) return ranked(5, "review", false);
      return ranked(8, "other", null);
    default:
      return null;
  }
}

/** Briefs, notes, replies and claims stay in the post thread, so the timeline leaves them out. */
export function ticketTimeline(a: { posts: readonly PostRow[]; threads: readonly ThreadRow[]; runs: readonly RunRow[] }): TimelineEntry[] {
  const items: Ranked[] = [
    ...a.threads.filter((row) => row.role === "worker" || row.role === "reviewer").map((row) => threadEntry(row, a.posts)),
    ...a.runs.map(runEntry),
    ...a.posts.flatMap((post) => postEntry(post) ?? []),
  ];
  items.sort((x, y) => x.entry.at - y.entry.at || x.rank - y.rank || x.id - y.id);
  return items.map((item) => item.entry);
}
