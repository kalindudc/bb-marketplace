// The calls the server makes on the machine that owns a project's checkout and worktrees.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const absPath = z.string().min(1).max(4096).regex(/^\//, "must be an absolute path");

// A branch or a remote-prefixed base. Git itself rejects the rest; this keeps option-like and multi-word values out of argv.
const ref = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("..") && !value.startsWith("-") && !/[\u0000-\u0020\u007f~^:?*[\\]/.test(value), "is not a safe git ref");

const sha = z.string().min(1).max(64);
const commit = z.string().regex(/^[0-9a-fA-F]{4,64}$/, "must be a commit hash");
// A Loom worktree's key: the project slug, or the slug and a [[repo]] name joined by a dot. It names a directory, so nothing looser.
const worktreeKey = z.string().regex(/^[a-z][a-z0-9-]{1,39}(?:\.[a-z][a-z0-9-]{0,23})?$/, "must be a project slug, or a project slug and a repo name joined by a dot");
const missing = z.object({ outcome: z.literal("missing"), message: z.string() }).strict();
const forgeCommand = z.string().min(1).max(2000);
const unavailable = z.object({ outcome: z.literal("unavailable"), message: z.string() }).strict();
// A pull request read that failed. `transient` marks a GitHub failure worth waiting out instead of pausing: a server error or
// timeout, or a rate limit; `retryAfterMs` is how long GitHub's answer said to wait, when it said. Optional, as from an older host.
const readUnavailable = z
  .object({ outcome: z.literal("unavailable"), message: z.string(), transient: z.enum(["server", "rate_limit"]).optional(), retryAfterMs: z.number().int().min(0).optional() })
  .strict();

/** A pull request's number as forge commands get it in LOOM_PR_NUMBER: the last run of digits in its URL, empty when there is none. */
export function prNumber(url: string): string {
  return /(\d+)(?!.*\d)/u.exec(url)?.[1] ?? "";
}

export const FILE_STATUSES = ["added", "modified", "deleted", "renamed", "copied", "type_changed"] as const;
const changedFile = z
  .object({
    path: z.string(),
    status: z.enum(FILE_STATUSES),
    additions: z.number().int(),
    deletions: z.number().int(),
    binary: z.boolean(),
    /** The file's blob after the change; null when it was deleted. */
    blob: z.string().nullable(),
  })
  .strict();

export const hostContract = defineRpcContract({
  ensureBranch: {
    input: z.object({ repo: absPath, branch: ref, from: ref }).strict(),
    output: z.object({ sha, created: z.boolean() }).strict(),
  },
  worktreeState: {
    // trackedOnly leaves untracked files out of `dirty`: a build or a test run may leave some behind, and they cannot reach a commit.
    input: z.object({ worktree: absPath, base: ref, trackedOnly: z.boolean().optional() }).strict(),
    output: z.object({ branch: z.string().nullable(), head: sha, dirty: z.boolean(), changed: z.array(z.string()) }).strict(),
  },
  commitAll: {
    input: z.object({ worktree: absPath, message: z.string().min(1).max(500) }).strict(),
    output: z.object({ sha, committed: z.boolean() }).strict(),
  },
  exec: {
    input: z
      .object({
        cwd: absPath,
        command: z.string().min(1).max(4096),
        timeoutMs: z.number().int().min(1000).max(1_770_000),
        stdin: z.string().max(400_000).optional(),
        env: z.record(z.string().regex(/^LOOM_[A-Z_]{1,40}$/), z.string().max(2000)).optional(),
      })
      .strict(),
    output: z.object({ exitCode: z.number().int().nullable(), timedOut: z.boolean(), durationMs: z.number(), output: z.string() }).strict(),
  },
  diff: {
    input: z.object({ repo: absPath, base: ref, head: commit, maxBytes: z.number().int().min(1000).max(200_000) }).strict(),
    output: z.object({ stat: z.string(), patch: z.string(), truncated: z.boolean() }).strict(),
  },
  // The files that differ from base to head. mergeBase compares head with its merge base with base, as base...head does; landed,
  // for a head that base already contains, compares it with base as it was before the merge that brought it in.
  changedFiles: {
    input: z.object({ repo: absPath, base: ref, head: ref, mergeBase: z.boolean(), landed: z.boolean().optional(), maxFiles: z.number().int().min(1).max(5000) }).strict(),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok"), base: sha, head: sha, files: z.array(changedFile), truncated: z.boolean() }).strict(), missing]),
  },
  filePatch: {
    input: z.object({ repo: absPath, base: commit, head: commit, path: z.string().min(1).max(4096), maxBytes: z.number().int().min(1000).max(400_000) }).strict(),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok"), patch: z.string(), truncated: z.boolean() }).strict(), missing]),
  },
  ensureWorktree: {
    input: z.object({ repo: absPath, key: worktreeKey, branch: ref, path: absPath.optional() }).strict(),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("ok"), path: z.string() }).strict(),
      z.object({ outcome: z.literal("unavailable"), reason: z.enum(["branch_checked_out", "git"]), message: z.string() }).strict(),
    ]),
  },
  merge: {
    // before is the rollback point the caller persisted ahead of the first attempt. A rerun that finds the merge made reports it back.
    input: z.object({ worktree: absPath, ref: commit, message: z.string().min(1).max(500), before: commit.optional() }).strict(),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("merged"), sha, before: sha, already: z.boolean() }).strict(),
      z.object({ outcome: z.literal("conflict"), files: z.array(z.string()) }).strict(),
    ]),
  },
  resetHard: {
    input: z.object({ worktree: absPath, sha: commit }).strict(),
    output: z.object({ sha }).strict(),
  },
  // git fetch <remote> refs/heads/<branch> in the Loom worktree, whose FETCH_HEAD is its own; sha is the fetched tip.
  fetchBranch: {
    input: z.object({ worktree: absPath, remote: ref, branch: ref }).strict(),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok"), sha }).strict(), z.object({ outcome: z.literal("unavailable"), message: z.string() }).strict()]),
  },
  // The commit to push to a ticket's pull request branch, with head's tree: on the remote branch's tip when it exists, else on
  // head's merge base with base. `pushed` is the commit Loom pushed there last; a tip that is neither it nor in head's history
  // has commits from someone else, which a commit with head's tree would undo, so it is reported as diverged instead.
  prCommit: {
    input: z.object({ repo: absPath, remote: ref, branch: ref, base: ref, head: commit, message: z.string().min(1).max(8000), pushed: commit.optional() }).strict(),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("ok"), sha, created: z.boolean() }).strict(),
      z.object({ outcome: z.literal("diverged"), tip: sha }).strict(),
      unavailable,
    ]),
  },
  // The commit a stacked ticket starts from, or merges in to catch up: the commits given, with `base` the remote base branch's
  // tip fetched as well, less any that another one contains, merged into one commit when more than one is left. `branch`
  // is pointed at it, for a worker to start from or merge. A conflict between them names the files and moves no branch.
  stackBase: {
    input: z
      .object({
        repo: absPath,
        branch: ref,
        commits: z.array(commit).max(20),
        base: z.object({ remote: ref, branch: ref }).strict().optional(),
        message: z.string().min(1).max(500),
      })
      .strict(),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("ok"), sha, tip: sha.nullable() }).strict(),
      z.object({ outcome: z.literal("conflict"), files: z.array(z.string()) }).strict(),
      unavailable,
    ]),
  },
  // Moves an open pull request to another base branch: gh pr edit <url> --base <base>.
  prRetarget: {
    input: z.object({ repo: absPath, url: z.string().regex(/^https?:\/\/\S+$/, "must be a pull request URL").max(500), base: ref }).strict(),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok") }).strict(), unavailable]),
  },
  push: {
    input: z.object({ repo: absPath, remote: ref, src: ref, branch: ref }).strict(),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok") }).strict(), z.object({ outcome: z.literal("unavailable"), message: z.string() }).strict()]),
  },
  prCreate: {
    input: z
      .object({
        repo: absPath,
        remote: ref,
        base: ref,
        head: ref,
        title: z.string().min(1).max(256),
        body: z.string().max(60_000),
        draft: z.boolean(),
        forge: z.discriminatedUnion("kind", [z.object({ kind: z.literal("gh") }).strict(), z.object({ kind: z.literal("command"), open: forgeCommand }).strict()]),
      })
      .strict(),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok"), url: z.string() }).strict(), z.object({ outcome: z.literal("unavailable"), message: z.string() }).strict()]),
  },
  // The pull request's state through the repo's forge: gh pr view <url> --json state, or the spec's state command.
  prState: {
    input: z
      .object({
        repo: absPath,
        url: z.string().regex(/^https?:\/\/\S+$/, "must be a pull request URL").max(500),
        forge: z.discriminatedUnion("kind", [z.object({ kind: z.literal("gh") }).strict(), z.object({ kind: z.literal("command"), state: forgeCommand }).strict()]),
      })
      .strict(),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok"), state: z.enum(["OPEN", "MERGED", "CLOSED"]) }).strict(), readUnavailable]),
  },
  // Asks each login for a review of the pull request, again for one who already reviewed it: one REST call each through gh,
  // so one who cannot be asked, such as a person without access to the repository, does not stop the others.
  prRequestReview: {
    input: z
      .object({
        repo: absPath,
        url: z.string().regex(/^https?:\/\/\S+$/, "must be a pull request URL").max(500),
        reviewers: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/, "must be a forge login")).min(1).max(20),
      })
      .strict(),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("ok"), requested: z.array(z.string()), failed: z.array(z.object({ login: z.string(), message: z.string() }).strict()) }).strict(),
      unavailable,
    ]),
  },
  // A pull request's state, the checks on its head commit, and its reviews, unresolved review threads and comments.
  // Through gh, or the spec's feedback command, which prints the same object as JSON on its last line.
  prFeedback: {
    input: z
      .object({
        repo: absPath,
        url: z.string().regex(/^https?:\/\/\S+$/, "must be a pull request URL").max(500),
        forge: z.discriminatedUnion("kind", [z.object({ kind: z.literal("gh") }).strict(), z.object({ kind: z.literal("command"), feedback: forgeCommand }).strict()]),
      })
      .strict(),
    output: z.discriminatedUnion("outcome", [
      z
        .object({
          outcome: z.literal("ok"),
          state: z.enum(["OPEN", "MERGED", "CLOSED"]),
          head: sha,
          author: z.string(),
          checks: z.array(
            z
              .object({
                key: z.string(),
                name: z.string(),
                state: z.enum(["pending", "passed", "failed", "neutral"]),
                url: z.string().nullable(),
                /** False while it waits in a queue to start; null when the forge cannot tell, as with a commit status. Optional so an older host's answer still parses. */
                started: z.boolean().nullable().optional(),
                startedAt: z.number().int().nullable().optional(),
                completedAt: z.number().int().nullable().optional(),
                /** How much of it is done, 0 to 100, as the forge's own command reports it. */
                progress: z.number().min(0).max(100).nullable().optional(),
                /** A GitHub Actions job's steps: those finished, and all of them. */
                steps: z.object({ done: z.number().int().min(0), total: z.number().int().min(0) }).strict().nullable().optional(),
              })
              .strict(),
          ),
          items: z.array(
            z
              .object({
                key: z.string(),
                kind: z.enum(["review", "thread", "comment"]),
                author: z.string(),
                bot: z.boolean(),
                body: z.string(),
                url: z.string().nullable(),
                /** The review's state; the thread's path and line. */
                state: z.string().nullable(),
                path: z.string().nullable(),
                line: z.number().int().nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
      readUnavailable,
    ]),
  },
  // Each git remote with its push URLs, in `git remote` order.
  remotes: {
    input: z.object({ repo: absPath }).strict(),
    output: z.object({ remotes: z.array(z.object({ name: z.string(), pushUrls: z.array(z.string()) }).strict()) }).strict(),
  },
  // Whether gh can open pull requests where pushUrl points: gh auth status --hostname <its host>.
  ghStatus: {
    input: z.object({ repo: absPath, pushUrl: z.string().min(1).max(2000) }).strict(),
    output: z.object({ status: z.enum(["ready", "signed_out", "missing", "not_a_url"]), host: z.string().nullable() }).strict(),
  },
  // Whether Loom could add its own worktree of the repository: a worktree added in the data directory and removed at once.
  trialWorktree: {
    input: z.object({ repo: absPath }).strict(),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok") }).strict(), z.object({ outcome: z.literal("refused"), message: z.string() }).strict()]),
  },
  // Whether the remote's base branch contains sha, for the push-only forge. Leaves no FETCH_HEAD behind.
  landedOn: {
    input: z.object({ repo: absPath, remote: ref, base: ref, sha: commit }).strict(),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok"), landed: z.boolean() }).strict(), unavailable]),
  },
});

export type HostMethod = keyof typeof hostContract & string;
export type HostInput<M extends HostMethod> = z.input<(typeof hostContract)[M]["input"]>;
export type HostOutput<M extends HostMethod> = z.output<(typeof hostContract)[M]["output"]>;
