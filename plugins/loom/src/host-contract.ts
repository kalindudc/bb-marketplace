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
// A pull request read that failed. `transient` marks a forge failure worth waiting out instead of pausing: a server error or
// timeout, a rate limit, or a network failure such as a name that did not resolve; `retryAfterMs` is how long the forge's
// answer said to wait, when it said. Optional, as from an older host.
const transient = z.enum(["server", "rate_limit", "network"]);
const readUnavailable = z.object({ outcome: z.literal("unavailable"), message: z.string(), transient: transient.optional(), retryAfterMs: z.number().int().min(0).optional() }).strict();

/** A pull request's number as forge commands get it in LOOM_PR_NUMBER: the last run of digits in its URL, empty when there is none. */
export function prNumber(url: string): string {
  return /(\d+)(?!.*\d)/u.exec(url)?.[1] ?? "";
}

const PULL_URL = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/u;

/** The GitHub host, owner, repository name and number in a pull request URL; null for any other URL. */
export function githubPull(url: string): { host: string; owner: string; name: string; number: number } | null {
  const match = PULL_URL.exec(url);
  return match === null ? null : { host: match[1]!, owner: match[2]!, name: match[3]!, number: Number(match[4]) };
}

/** The most pull requests one prBatch call reads, which bounds the GraphQL query's node count. */
export const PR_BATCH_MAX = 10;

const prState = z.enum(["OPEN", "MERGED", "CLOSED"]);
export const REVIEW_DECISIONS = ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"] as const;
const reviewDecision = z.enum(REVIEW_DECISIONS);
// GitHub's own limits on a host name, an owner and a repository name; they keep the values out of argv options and the query text.
const ghHost = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}(?::\d{1,5})?$/u, "must be a host name");
const ghName = z.string().regex(/^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/u, "must be a GitHub owner or repository name");

// A pull request's state, the checks on its head commit, and its reviews, unresolved review threads and comments.
const feedbackOk = z
  .object({
    outcome: z.literal("ok"),
    state: prState,
    head: sha,
    author: z.string(),
    /** Whether it is a draft, its review decision and the branch it targets; null when the forge does not say. Optional so an older host's answer still parses. */
    draft: z.boolean().nullable().optional(),
    review: reviewDecision.nullable().optional(),
    base: z.string().nullable().optional(),
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
  .strict();

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

// experimental_retryable marks the reads bb may cancel and send again when the host is slow to answer: they move no ref, change
// no worktree and write no object. landedOn fetches, which writes objects, so it is not one. Nor are the forge reads: bb
// resends at half the call's timeout, which would cut a slow pull request read short at 75 of its 150 seconds.
// Spread rather than written out: the SDK this pins (0.6.75, the newest the package proxy serves) predates the flag in its
// types, and bb 0.6.79 reads it from the contract at runtime.
const RETRYABLE = { experimental_retryable: true } as const;

/** The most bytes of a file one call carries: base64 makes it 5.6 MB, under bb's 8 MiB host payload. */
export const CHUNK_BYTES = 4 * 1024 * 1024;
/** The biggest file Loom carries between machines. */
export const BLOB_MAX_BYTES = 100 * 1024 * 1024;
const chunk = z.string().max(Math.ceil(CHUNK_BYTES / 3) * 4);
// A path inside a repository as git lists it: relative, with no empty, "." or ".." part, and never into .git.
const repoPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => !path.startsWith("/") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..") && path.split("/")[0] !== ".git", "must be a path inside the repository");
const fileMode = z.enum(["100644", "100755", "120000"]);
// An author as git records it; date is git's raw form, seconds since the epoch and the zone, such as "1800000000 +0000".
const author = z.object({ name: z.string().max(500), email: z.string().max(500), date: z.string().regex(/^\d{1,12} [+-]\d{4}$/, "must be git's raw date") }).strict();
const uploadId = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,199}$/, "must be an upload id");
const fullRef = z.string().max(250).regex(/^refs\/[A-Za-z0-9._/-]+$/, "must be a full ref name").refine((value) => !value.includes("..") && !value.endsWith("/") && !value.endsWith(".lock"), "is not a safe git ref");

export const hostContract = defineRpcContract({
  ensureBranch: {
    input: z.object({ repo: absPath, branch: ref, from: ref }).strict(),
    output: z.object({ sha, created: z.boolean() }).strict(),
  },
  worktreeState: {
    ...RETRYABLE,
    // trackedOnly leaves untracked files out of `dirty`: a build or a test run may leave some behind, and they cannot reach a commit.
    // baseTree measures `changed` from the newest commit on HEAD's first-parent line with that tree, which a machine that
    // gives commits new ids keeps; onBase says whether there is one, and without one `changed` is measured from base.
    input: z.object({ worktree: absPath, base: ref, trackedOnly: z.boolean().optional(), baseTree: commit.optional() }).strict(),
    output: z.object({ branch: z.string().nullable(), head: sha, tree: sha, dirty: z.boolean(), changed: z.array(z.string()), onBase: z.boolean().optional() }).strict(),
  },
  // What one commit changed against its merge base with `base`, for carrying it to another machine: each changed file's
  // status, and for one that is not deleted its mode, blob and size. head defaults to the worktree's HEAD.
  exportChanges: {
    input: z.object({ worktree: absPath, base: ref, head: commit.optional() }).strict(),
    output: z
      .object({
        base: sha,
        head: sha,
        tree: sha,
        message: z.string(),
        author,
        changes: z.array(z.object({ status: z.enum(["A", "M", "T", "D"]), path: z.string(), mode: fileMode.optional(), blob: sha.optional(), size: z.number().int().min(0).optional() }).strict()),
      })
      .strict(),
  },
  // Up to CHUNK_BYTES of a blob from offset, base64-encoded. A blob over BLOB_MAX_BYTES is refused.
  readBlob: {
    input: z.object({ repo: absPath, sha: commit, offset: z.number().int().min(0), length: z.number().int().min(0).max(CHUNK_BYTES) }).strict(),
    output: z.object({ data: z.string() }).strict(),
  },
  // Appends one range of a file to the upload of that id in the data directory; offset 0 starts it again.
  importChunk: {
    input: z.object({ upload: uploadId, offset: z.number().int().min(0), data: chunk }).strict(),
    output: z.object({ size: z.number().int() }).strict(),
  },
  // Removes the uploads of a transfer that failed before importCommit.
  dropUploads: {
    input: z.object({ uploads: z.array(uploadId).max(50_000) }).strict(),
    output: z.object({}).strict(),
  },
  // The commit on `base` whose tree is `base` with the entries applied, built with a temporary index so no worktree moves,
  // with the author as its committer too, so the same input gives the same commit. A missing base is fetched from
  // remote's baseBranch, or by its sha. parent, a commit of this repository, takes base's place as the commit's parent.
  // Each of refs is pointed at it only when its tree is `tree`; the uploads go.
  importCommit: {
    input: z
      .object({
        repo: absPath,
        remote: ref,
        baseBranch: ref,
        base: commit,
        tree: commit,
        message: z.string().max(20_000),
        author,
        entries: z.array(z.union([z.object({ path: repoPath, mode: fileMode, upload: uploadId }).strict(), z.object({ path: repoPath, delete: z.literal(true) }).strict()])).max(50_000),
        refs: z.array(fullRef).max(4),
        parent: commit.optional(),
      })
      .strict(),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok"), sha }).strict(), z.object({ outcome: z.literal("mismatch"), tree: sha }).strict(), unavailable]),
  },
  // The other way, into a thread's worktree on its own machine, whose git may refuse a temporary index: only worktree
  // commands. carryStart resets a clean worktree to base, fetching base, and the remote's base branch when it lacks base,
  // unless HEAD has the tree already (present) or commits a reset would drop, which it may drop when HEAD has the tree `replaces`, one the
  // project's machine keeps; carryWrite and carryDelete change the files; carryFinish commits them as the author on HEAD
  // and checks the tree, and resets to base when it differs.
  carryStart: {
    input: z.object({ worktree: absPath, remote: ref, baseBranch: ref, base: commit, tree: commit, replaces: commit.optional() }).strict(),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok"), present: z.boolean() }).strict(), unavailable]),
  },
  // Offset 0 starts the file again; a symlink comes in one range, its target as the data.
  carryWrite: {
    input: z.object({ worktree: absPath, path: repoPath, mode: fileMode, offset: z.number().int().min(0), data: chunk }).strict(),
    output: z.object({ size: z.number().int() }).strict(),
  },
  carryDelete: {
    input: z.object({ worktree: absPath, paths: z.array(repoPath).max(50_000) }).strict(),
    output: z.object({}).strict(),
  },
  // The files of paths that still have a line git's conflict markers start, as a merge Loom carried in left them.
  conflictMarkers: {
    input: z.object({ worktree: absPath, paths: z.array(repoPath).max(5000) }).strict(),
    output: z.object({ files: z.array(z.string()) }).strict(),
  },
  // Puts the worktree back at base after a carry that failed part-way, so the next carryStart finds it clean.
  carryAbort: {
    input: z.object({ worktree: absPath, base: commit }).strict(),
    output: z.object({}).strict(),
  },
  // paths are the files carryWrite wrote, staged even where .gitignore matches them, as the commit had them.
  carryFinish: {
    input: z.object({ worktree: absPath, base: commit, message: z.string().max(20_000), author, tree: commit, paths: z.array(repoPath).max(50_000) }).strict(),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok"), head: sha, tree: sha }).strict(), z.object({ outcome: z.literal("mismatch"), tree: sha }).strict()]),
  },
  // The commit a ref points at, and its tree; with contains, whether that commit is it or one of its ancestors.
  refTip: {
    input: z.object({ repo: absPath, ref, contains: commit.optional() }).strict(),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok"), sha, tree: sha, contains: z.boolean().optional() }).strict(), missing]),
  },
  // git checkout --detach <sha> in a worktree that shares the checkout's objects, and the tree it then has.
  detach: {
    input: z.object({ worktree: absPath, sha: commit }).strict(),
    output: z.object({ tree: sha }).strict(),
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
    ...RETRYABLE,
    input: z.object({ repo: absPath, base: ref, head: commit, maxBytes: z.number().int().min(1000).max(200_000) }).strict(),
    output: z.object({ stat: z.string(), patch: z.string(), truncated: z.boolean() }).strict(),
  },
  // The files that differ from base to head. mergeBase compares head with its merge base with base, as base...head does; landed,
  // for a head that base already contains, compares it with base as it was before the merge that brought it in.
  changedFiles: {
    ...RETRYABLE,
    input: z.object({ repo: absPath, base: ref, head: ref, mergeBase: z.boolean(), landed: z.boolean().optional(), maxFiles: z.number().int().min(1).max(5000) }).strict(),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok"), base: sha, head: sha, files: z.array(changedFile), truncated: z.boolean() }).strict(), missing]),
  },
  filePatch: {
    ...RETRYABLE,
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
  // head's merge base with base. `pushed` is the tip Loom last accounted for: its own push, or commits someone else pushed
  // that it merged into head's work. A tip that is neither it nor in head's history has commits from someone else, which a
  // commit with head's tree would undo, so it is reported as diverged instead.
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
      z.object({ outcome: z.literal("ok"), sha, tip: sha.nullable(), tree: sha }).strict(),
      z.object({ outcome: z.literal("conflict"), files: z.array(z.string()) }).strict(),
      unavailable,
    ]),
  },
  // Merges `ref` into `head` on the project's checkout with merge-tree, which touches no worktree, as one commit whose
  // parents are head and ref, and points refs at it. A conflict is committed too, as the tree with conflict markers in
  // the files it names, for a worker on another machine to resolve. A ref head already has is merged, and moves no ref.
  // `base`, when it is an ancestor of ref, is the merge base instead of git's own: a commit whose tree head builds on,
  // which git cannot tell when head was rebuilt from a worktree on another machine.
  mergeOnto: {
    input: z.object({ repo: absPath, head: commit, ref: commit, message: z.string().min(1).max(500), refs: z.array(fullRef).max(4), base: commit.optional() }).strict(),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("merged"), sha, tree: sha, already: z.boolean() }).strict(),
      z.object({ outcome: z.literal("conflict"), files: z.array(z.string()), sha, tree: sha }).strict(),
    ]),
  },
  // A ticket's pull request branch where `git push` sends it: its tip fetched and `ref` pointed at it, and the remote's
  // base branch fetched into its remote-tracking ref. mainBase is the newest base commit the tip has; missing, no branch.
  fetchTip: {
    input: z.object({ repo: absPath, remote: ref, branch: ref, base: ref, ref: fullRef }).strict(),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("ok"), sha, tree: sha, mainBase: sha.nullable() }).strict(),
      z.object({ outcome: z.literal("missing") }).strict(),
      unavailable,
    ]),
  },
  // Points each ref at sha, a commit of the repository.
  pointRefs: {
    input: z.object({ repo: absPath, sha: commit, refs: z.array(fullRef).min(1).max(4) }).strict(),
    output: z.object({}).strict(),
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
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok"), state: prState }).strict(), readUnavailable]),
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
  // A pull request's feedback (feedbackOk) through gh, or the spec's feedback command, which prints the same object as JSON on its last line.
  prFeedback: {
    input: z
      .object({
        repo: absPath,
        url: z.string().regex(/^https?:\/\/\S+$/, "must be a pull request URL").max(500),
        forge: z.discriminatedUnion("kind", [z.object({ kind: z.literal("gh") }).strict(), z.object({ kind: z.literal("command"), feedback: forgeCommand }).strict()]),
      })
      .strict(),
    output: z.discriminatedUnion("outcome", [feedbackOk, readUnavailable]),
  },
  // Many pull requests of one GitHub repository in one GraphQL call: each one's state, draft flag, review decision and base
  // branch, and with `feedback` what prFeedback reads for it. A number GitHub does not answer for is in `missing`.
  prBatch: {
    input: z
      .object({
        repo: absPath,
        host: ghHost,
        owner: ghName,
        name: ghName,
        numbers: z.array(z.number().int().min(1).max(2_147_483_647)).min(1).max(PR_BATCH_MAX),
        feedback: z.boolean(),
      })
      .strict(),
    output: z.discriminatedUnion("outcome", [
      z
        .object({
          outcome: z.literal("ok"),
          pulls: z.array(
            z
              .object({
                number: z.number().int(),
                state: prState,
                /** Null for one GitHub leaves out of its answer. */
                draft: z.boolean().nullable(),
                review: reviewDecision.nullable(),
                base: z.string().nullable(),
                /** What prFeedback answers for it; null when `feedback` was not asked for. */
                feedback: feedbackOk.nullable(),
              })
              .strict(),
          ),
          /** A number GitHub answered no pull request for; `transient` when its error is one worth waiting out, as for a whole failed read. */
          missing: z.array(z.object({ number: z.number().int(), message: z.string(), transient: transient.optional(), retryAfterMs: z.number().int().min(0).optional() }).strict()),
        })
        .strict(),
      readUnavailable,
    ]),
  },
  // Each git remote with its push URLs, in `git remote` order.
  remotes: {
    ...RETRYABLE,
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
