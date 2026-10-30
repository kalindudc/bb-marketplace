import type { ChangeOperation, ListOperation, Operation, ServerConfig } from "../config";
import type { CheckRun, CheckState, MergeMethod, MergeOptions, PrChange, Verdict } from "../contract";
import type { Activity, EditOptions, PrSummary } from "../model";

export interface ListOptions {
  /** authored only: open PRs, or closed and merged ones updated since `since`. */
  state?: "open" | "closed";
  /** YYYY-MM-DD. */
  since?: string;
}

export interface MergeInput {
  method: MergeMethod;
  /** Merge only while the PR's head is still this commit. */
  head: string;
  /** Merge once required checks pass, instead of now. */
  auto: boolean;
  deleteBranch: boolean;
  /** The squash or merge commit's title. */
  subject?: string;
}

/** A commit as a link card shows it. */
export interface CommitInfo {
  sha: string;
  message: string;
  author: string | null;
  at: number | null;
  additions: number | null;
  deletions: number | null;
  checks: CheckState | null;
  /** The PRs it belongs to, newest first. */
  prs: number[];
}

/** A check run or a workflow run as a link card shows it, with the commit it ran on and its PRs. */
export interface CheckInfo {
  run: CheckRun;
  head: string | null;
  prs: number[];
}

export interface ActivityOptions {
  detail?: boolean;
}

export interface ReviewComment {
  path: string;
  /** A line in the new version of the file; null for a comment on the whole file. */
  line: number | null;
  body: string;
}

export interface ReviewPost {
  verdict: Verdict;
  body: string;
  /** The commit the comments' lines refer to; null for the PR's current head. */
  head: string | null;
  comments: ReviewComment[];
}

/** How many comments landed on their lines, and how many the server could not place and went into the body. */
export interface ReviewPosted {
  placed: number;
  inBody: number;
}

/** A list says whether it holds every matching PR; an incomplete one never removes a reason. */
export interface ListResult {
  rows: PrSummary[];
  complete: boolean;
}

export interface Adapter {
  readonly server: ServerConfig;
  operations(): Operation[];
  whoami(signal?: AbortSignal): Promise<string>;
  list(operation: ListOperation, options: ListOptions, signal?: AbortSignal): Promise<ListResult>;
  view(repo: string, number: number, signal?: AbortSignal): Promise<PrSummary>;
  /** With `detail`, also what the PR view shows besides the conversation; watching asks without it, so syncs stay light. */
  activity(repo: string, number: number, signal?: AbortSignal, options?: ActivityOptions): Promise<Activity>;
  /** Changes the PR on its server; resolves once the server accepted the change. */
  change(repo: string, number: number, change: PrChange, signal?: AbortSignal): Promise<void>;
  /** The repo's labels, and people the server suggests as reviewers. */
  editOptions(repo: string, number: number, signal?: AbortSignal): Promise<EditOptions>;
  /** How the PR can merge. A server without merge_options gets squash and merge, state unknown. */
  mergeOptions(repo: string, number: number, signal?: AbortSignal): Promise<MergeOptions>;
  /** Merges, or turns on auto-merge with `auto`; `merged` is false when it only turned auto-merge on. */
  merge(repo: string, number: number, input: MergeInput, signal?: AbortSignal): Promise<{ merged: boolean }>;
  /** Reads one commit, for a link card; absent where the server has no way to. */
  commit?(repo: string, sha: string, signal?: AbortSignal): Promise<CommitInfo>;
  /** Reads a check run, or a workflow run when only its id is known, for a link card. */
  checkRun?(repo: string, ids: { checkRun: number | null; run: number | null }, signal?: AbortSignal): Promise<CheckInfo>;
  /** GitHub only: turns auto-merge off. Absent where the server has no auto-merge. */
  cancelAutoMerge?(repo: string, number: number, signal?: AbortSignal): Promise<void>;
  comment(repo: string, number: number, body: string, signal?: AbortSignal): Promise<void>;
  review(repo: string, number: number, post: ReviewPost, signal?: AbortSignal): Promise<ReviewPosted>;
  /** Replies in a review thread, named by an activity item's `thread`. */
  reply(repo: string, number: number, thread: string, body: string, signal?: AbortSignal): Promise<void>;
  resolve(repo: string, number: number, thread: string, resolved: boolean, signal?: AbortSignal): Promise<void>;
  /** How an agent reads the PR with its conversation, for prompts. */
  readCommand(repo: string, number: number, url: string): string;
}

/** The operation that carries out a change. */
export function changeOperation(change: PrChange): ChangeOperation {
  if (change.kind === "labels") return "edit_labels";
  if (change.kind === "reviewers") return "edit_reviewers";
  return change.kind;
}

/** What a failed command left behind, so the user can see why a sync failed. */
export interface FailureDetail {
  /** The end of what the command printed: stderr, or stdout when stderr is empty. */
  output?: string;
  exit?: number | null;
  /** The command that ran, as the user configured it. */
  command?: string;
  /** The adapter already tried again, so a sync does not retry it on top. */
  retried?: boolean;
}

export class AdapterError extends Error {
  override readonly name = "AdapterError";
  constructor(
    readonly operation: Operation,
    message: string,
    readonly detail: FailureDetail = {},
  ) {
    super(message);
  }
}
