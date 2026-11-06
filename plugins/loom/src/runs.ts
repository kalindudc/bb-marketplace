// Loom's own record of each call it makes to the machine for a ticket's checks and merge, shown in the ticket page's check and merge cards.
import type { Store, TicketRow } from "./db/store";
import type { HostInput, HostMethod, HostOutput } from "./host-contract";
import type { HostPort } from "./ports";
import { clip } from "./prompts";

export type RunStage = "check" | "merge";

export const RUN_OUTPUT_MAX = 70_000;

export const STEP_LABELS: Record<Exclude<HostMethod, "exec">, string> = {
  commitAll: "git commit",
  worktreeState: "git status",
  ensureWorktree: "prepare the Loom worktree",
  merge: "git merge",
  resetHard: "git reset --hard",
  prState: "read the pull request",
  prBatch: "read the pull requests",
  prCommit: "build the pull request's commit",
  push: "git push",
  prCreate: "open the pull request",
  prReady: "mark the pull request ready for review",
  stackBase: "build the commit to stack on",
  prRetarget: "move the pull request to another base",
  prRequestReview: "ask the reviewers to review again",
  fetchBranch: "git fetch",
  ensureBranch: "create the branch",
  exportChanges: "list the commit's changed files",
  readBlob: "read a file",
  importChunk: "receive a file",
  dropUploads: "remove the files received",
  importCommit: "rebuild the commit on the project's machine",
  carryStart: "prepare the worktree for the work",
  carryWrite: "write a file",
  carryDelete: "delete files",
  repoPrefix: "find the checkout's directory in its repository",
  conflictMarkers: "look for conflict markers",
  carryAbort: "stop the copy, leaving the worktree as it is",
  carryFinish: "commit the work in the worktree",
  refTip: "read a ref",
  detach: "check out the commit",
  diff: "git diff",
  changedFiles: "list the changed files",
  filePatch: "read a file's changes",
  mergeOnto: "merge without a worktree",
  fetchTip: "fetch the pull request's branch",
  behindBase: "count the commits behind the base",
  remoteBranch: "read the remote branch",
  pointRefs: "move refs",
  prEdit: "set the pull request's title and description",
  prReply: "reply on the pull request",
  prReviewState: "read who reviews the pull request",
  prMerge: "merge the pull request",
  prFeedback: "read the pull request's feedback",
  checkoutPrint: "fingerprint the checkout",
  finalScratch: "manage the final review's directory",
  homeDir: "find the home directory",
  prReviewStart: "start the review gate",
  prReviewRead: "read the review gate",
  remotes: "list the remotes",
  ghStatus: "check gh's sign-in",
  trialWorktree: "try adding a worktree",
  landedOn: "check whether the base branch has the commit",
};

/** The one run that stands for a stretch of file transfers, which move a file in ranges of up to CHUNK_BYTES each. */
export const COPY_LABEL = "copy files between machines";
const COPY_METHODS: ReadonlySet<HostMethod> = new Set(["readBlob", "importChunk", "carryWrite"]);
const LISTED_MAX = 20;

const sha12 = (sha: string) => sha.slice(0, 12);
const plural = (count: number, word: string) => `${count} ${count === 1 ? word : `${word}s`}`;

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

function listed(head: string, items: readonly string[]): string {
  const more = items.length - LISTED_MAX;
  return [head, ...items.slice(0, LISTED_MAX), ...(more > 0 ? [`and ${more} more.`] : [])].join("\n");
}

function differing(files: readonly string[]): string {
  if (files.length === 0) return "No files differ from the base.";
  return listed(files.length === 1 ? "1 file differs from the base:" : `${files.length} files differ from the base:`, files);
}

type Summary = { ok: boolean; text: string };
const done = (text: string): Summary => ({ ok: true, text });
const COPY_HOLDS = { carry: "what the copy wrote", before: "what it held before the copy", absent: "nothing", changed: "a change the copy did not make" } as const;

const SUMMARIES: { [M in Exclude<HostMethod, "exec">]: (output: HostOutput<M>) => Summary } = {
  commitAll: ({ sha, committed }) => done(committed ? `Committed ${sha12(sha)}.` : `Nothing new to commit; HEAD is ${sha12(sha)}.`),
  worktreeState: (state) => done(`HEAD ${sha12(state.head)} on ${state.branch ?? "a detached HEAD"}, ${state.dirty ? "with uncommitted changes" : "clean"}. ${differing(state.changed)}`),
  resetHard: ({ sha }) => done(`Reset to ${sha12(sha)}.`),
  ensureWorktree: (ready) => (ready.outcome === "ok" ? done(`Ready at ${ready.path}.`) : { ok: false, text: ready.message }),
  merge: (merged) => {
    if (merged.outcome === "conflict") return { ok: false, text: listed("Conflicts in:", merged.files) };
    if (merged.outcome === "unfinished") return { ok: false, text: "The worktree has a merge that is not finished, so Loom left it as it is." };
    return done(`Merged as ${sha12(merged.sha)}; the branch was at ${sha12(merged.before)}.${merged.already ? " (already merged)" : ""}`);
  },
  prState: (read) => (read.outcome === "ok" ? done(`The pull request is ${read.state.toLowerCase()}.`) : { ok: false, text: read.message }),
  prBatch: (read) => {
    if (read.outcome !== "ok") return { ok: false, text: read.message };
    const lines = [...read.pulls.map((pull) => `#${pull.number} is ${pull.state.toLowerCase()}${pull.base === null ? "" : ` on ${pull.base}`}.`), ...read.missing.map((miss) => miss.message)];
    return { ok: read.missing.length === 0, text: lines.join("\n") };
  },
  prCommit: (built) => {
    if (built.outcome === "diverged") return { ok: false, text: `The branch has commits Loom did not push; its tip is ${sha12(built.tip)}.` };
    if (built.outcome !== "ok") return { ok: false, text: built.message };
    return done(built.created ? `Built ${sha12(built.sha)} with the reviewed work's files.` : `The branch already has the reviewed work at ${sha12(built.sha)}; nothing new to commit.`);
  },
  push: () => done("Pushed."),
  prCreate: (opened) => (opened.outcome === "ok" ? done(`Opened ${opened.url}.`) : { ok: false, text: opened.message }),
  stackBase: (built) => {
    if (built.outcome === "conflict") return { ok: false, text: listed("The commits to stack on conflict in:", built.files) };
    if (built.outcome !== "ok") return { ok: false, text: built.message };
    return done(`Built ${sha12(built.sha)}${built.tip === null ? "" : `, with the base branch at ${sha12(built.tip)}`}.`);
  },
  prRetarget: () => done("Moved."),
  prRequestReview: (asked) => {
    if (asked.outcome !== "ok") return { ok: false, text: asked.message };
    const lines = [asked.requested.length > 0 ? `Asked ${asked.requested.join(", ")}.` : "Asked no one.", ...asked.failed.map((miss) => `${miss.login}: ${miss.message}`)];
    return { ok: asked.failed.length === 0, text: lines.join("\n") };
  },
  fetchBranch: (fetched) => (fetched.outcome === "ok" ? done(`Fetched ${sha12(fetched.sha)}.`) : { ok: false, text: fetched.message }),
  ensureBranch: ({ sha, created }) => done(created ? `Created the branch at ${sha12(sha)}.` : `The branch is at ${sha12(sha)}.`),
  exportChanges: ({ base, head, changes }) => {
    const span = `from ${sha12(base)} to ${sha12(head)}`;
    if (changes.length === 0) return done(`No files changed ${span}.`);
    const written = changes.filter((change) => change.status !== "D");
    const bytes = written.reduce((sum, change) => sum + (change.size ?? 0), 0);
    return done(`${plural(changes.length, "file")} changed ${span}: ${written.length} written (${sizeText(bytes)}) and ${changes.length - written.length} deleted.`);
  },
  readBlob: ({ data }) => done(`Read ${sizeText(Buffer.byteLength(data, "base64"))}.`),
  importChunk: ({ size }) => done(`The upload has ${sizeText(size)}.`),
  dropUploads: () => done("Removed the files received."),
  importCommit: (made) => {
    if (made.outcome === "mismatch") return { ok: false, text: `The rebuilt commit has the tree ${sha12(made.tree)}, not the one sent.` };
    if (made.outcome !== "ok") return { ok: false, text: made.message };
    return done(`Built ${sha12(made.sha)}.`);
  },
  carryStart: (started) => {
    if (started.outcome !== "ok") return { ok: false, text: started.message };
    return done(started.present ? "The worktree has the work already." : "The worktree is at the base, ready for the files.");
  },
  carryWrite: ({ size }) => done(`The file has ${sizeText(size)}.`),
  carryDelete: () => done("Deleted the files."),
  repoPrefix: ({ prefix }) => done(prefix === "" ? "The checkout is the repository's top level." : `The checkout is ${prefix} in its repository.`),
  conflictMarkers: ({ files }) => (files.length === 0 ? done("No conflict markers left.") : { ok: false, text: listed("Conflict markers left in:", files) }),
  carryAbort: ({ carried }) =>
    done(
      carried === undefined || carried.length === 0
        ? "Left the worktree as it is; the copy had written nothing."
        : listed("Left the worktree as it is. What each file the copy wrote or deleted holds now:", carried.map(({ path, holds }) => `${path}: ${COPY_HOLDS[holds]}`)),
    ),
  carryFinish: (finished) => {
    if (finished.outcome === "ok") return done(`Committed ${sha12(finished.head)}.`);
    if (finished.outcome === "foreign") return { ok: false, text: listed("The worktree has changes the copy did not make, so Loom committed nothing:", finished.paths) };
    return { ok: false, text: `After the copy the worktree would have the tree ${sha12(finished.tree)}, not the one sent, so Loom committed nothing.` };
  },
  refTip: (tip) => {
    if (tip.outcome !== "ok") return done(tip.message);
    const contains = tip.contains === undefined ? "" : tip.contains ? "; it contains the commit asked about" : "; it does not contain the commit asked about";
    return done(`At ${sha12(tip.sha)}${contains}.`);
  },
  detach: ({ tree }) => done(`Checked out; the tree is ${sha12(tree)}.`),
  diff: ({ stat, patch, truncated }) => done(`${stat.trim().split("\n").at(-1)?.trim() || "No changes."} ${sizeText(patch.length)} of patch${truncated ? ", cut short" : ""}.`),
  changedFiles: (read) => (read.outcome === "ok" ? done(`${plural(read.files.length, "file")} changed${read.truncated ? ", and more not listed" : ""}.`) : done(read.message)),
  filePatch: (read) => (read.outcome === "ok" ? done(`${sizeText(read.patch.length)} of patch${read.truncated ? ", cut short" : ""}.`) : done(read.message)),
  mergeOnto: (merged) =>
    merged.outcome === "conflict"
      ? { ok: false, text: listed(`Committed ${sha12(merged.sha)} with conflicts in:`, merged.files) }
      : done(merged.already ? `Already merged at ${sha12(merged.sha)}.` : `Merged as ${sha12(merged.sha)}.`),
  fetchTip: (tip) => {
    if (tip.outcome === "missing") return done("The remote has no such branch.");
    if (tip.outcome !== "ok") return { ok: false, text: tip.message };
    return done(`The branch is at ${sha12(tip.sha)}${tip.mainBase === null ? "" : `, on the base at ${sha12(tip.mainBase)}`}.`);
  },
  behindBase: (read) => {
    if (read.outcome !== "ok") return { ok: false, text: read.message };
    const lines = read.behind.map(({ sha, commits }) => (commits === null ? `${sha12(sha)} is not in the repository.` : `${sha12(sha)} is ${plural(commits, "commit")} behind.`));
    return done(listed(`The base is at ${sha12(read.tip)}.`, lines));
  },
  remoteBranch: (read) => {
    if (read.outcome !== "ok") return { ok: false, text: read.message };
    return done(read.sha === null ? "The remote has no such branch." : `The remote branch is at ${sha12(read.sha)}.`);
  },
  pointRefs: () => done("Moved the refs."),
  prReady: (marked) => (marked.outcome === "ok" ? done("Marked the pull request ready for review.") : { ok: false, text: marked.message }),
  prEdit: (edited) => (edited.outcome === "ok" ? done("Set the title and description.") : { ok: false, text: edited.message }),
  prReply: (replied) => {
    if (replied.outcome !== "ok") return { ok: false, text: replied.message };
    return done([replied.resolved ? "Replied and resolved the thread." : "Replied.", ...(replied.message === undefined ? [] : [replied.message])].join("\n"));
  },
  prReviewState: (read) => {
    if (read.outcome !== "ok") return { ok: false, text: read.message };
    const names = (logins: readonly string[]) => (logins.length === 0 ? "no one" : logins.join(", "));
    return done(`Opened by ${read.author ?? "someone unknown"}; asked: ${names(read.requested)}; reviewed: ${names(read.reviewed)}.`);
  },
  prMerge: (merged) => (merged.outcome === "ok" ? done("The forge took the merge.") : { ok: false, text: merged.message }),
  prFeedback: (read) => {
    if (read.outcome !== "ok") return { ok: false, text: read.message };
    const failed = read.checks.filter((check) => check.state === "failed").length;
    const pending = read.checks.filter((check) => check.state === "pending").length;
    return done(`The pull request is ${read.state.toLowerCase()} at ${sha12(read.head)}: ${plural(read.checks.length, "check")} (${failed} failed, ${pending} pending) and ${plural(read.items.length, "review item")}.`);
  },
  checkoutPrint: (read) => (read.outcome === "ok" ? done(`HEAD ${read.head === null ? "unborn" : sha12(read.head)}, ${read.dirty ? "with uncommitted changes" : "clean"}.`) : { ok: false, text: read.message }),
  finalScratch: ({ path, entries }) => done(`${path}, with ${entries.length === 1 ? "1 entry" : `${entries.length} entries`}.`),
  homeDir: ({ path }) => done(path),
  prReviewStart: (started) => (started.outcome === "ok" ? done("Started the review gate.") : { ok: false, text: `${started.outcome.replace("_", " ")}: ${started.message}` }),
  prReviewRead: (read) => (read.outcome === "ok" ? done(`The review gate is ${read.state}${read.findings.length === 0 ? "" : `, with ${read.findings.length} finding${read.findings.length === 1 ? "" : "s"}`}.`) : { ok: false, text: read.message }),
  remotes: ({ remotes }) => done(remotes.length === 0 ? "No remotes." : remotes.map((remote) => remote.name).join(", ")),
  ghStatus: ({ status, host }) => done(`${status.replaceAll("_", " ")}${host === null ? "" : ` on ${host}`}.`),
  trialWorktree: (tried) => (tried.outcome === "ok" ? done("Loom can add its own worktree.") : { ok: false, text: tried.message }),
  landedOn: (read) => {
    if (read.outcome !== "ok") return { ok: false, text: read.message };
    return done(read.landed ? "The base branch has the commit." : "The base branch does not have the commit yet.");
  },
};

/** What a host call did, in a line or a short list, with sizes and counts rather than contents. */
export function stepSummary<M extends Exclude<HostMethod, "exec">>(method: M, output: HostOutput<M>): Summary {
  const unavailable = output as { outcome?: unknown; message?: unknown };
  if (unavailable.outcome === "unavailable" && typeof unavailable.message === "string") return { ok: false, text: unavailable.message };
  return (SUMMARIES[method] as (output: HostOutput<M>) => Summary)(output);
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A host port that records every call it passes on as a run of `ticket` in `stage`. A stretch of file transfers is one
 * run, finished again after each call with how many files and bytes it has copied so far, so it never stays open.
 */
export function recordingHost(store: Store, host: HostPort, ticket: Pick<TicketRow, "id" | "project_id">, stage: RunStage): HostPort {
  let copy: { id: number; files: number; bytes: number; calls: number } | null = null;
  const copied = (c: { files: number; bytes: number; calls: number }) => `Copied ${plural(c.files, "file")}, ${sizeText(c.bytes)}, in ${plural(c.calls, "call")}.`;
  return {
    async call<M extends HostMethod>(hostId: string, method: M, input: HostInput<M>): Promise<HostOutput<M>> {
      if (COPY_METHODS.has(method)) {
        copy ??= { id: store.startRun({ project_id: ticket.project_id, ticket_id: ticket.id, stage, kind: "git", label: COPY_LABEL }), files: 0, bytes: 0, calls: 0 };
        const run = copy;
        run.calls += 1;
        let output: HostOutput<M>;
        try {
          output = await host.call(hostId, method, input);
        } catch (error) {
          store.finishRun(run.id, { ok: false, output: clip(`${errorText(error)}\n${copied(run)}`, RUN_OUTPUT_MAX) });
          if (copy === run) copy = null;
          throw error;
        }
        if (method === "readBlob") {
          if ((input as HostInput<"readBlob">).offset === 0) run.files += 1;
          run.bytes += Buffer.byteLength((output as HostOutput<"readBlob">).data, "base64");
        }
        store.finishRun(run.id, { ok: true, output: copied(run) });
        return output;
      }
      copy = null;
      const exec = method === "exec";
      const label = exec ? (input as HostInput<"exec">).command : STEP_LABELS[method as Exclude<HostMethod, "exec">];
      const id = store.startRun({ project_id: ticket.project_id, ticket_id: ticket.id, stage, kind: exec ? "command" : "git", label });
      let output: HostOutput<M>;
      try {
        output = await host.call(hostId, method, input);
      } catch (error) {
        store.finishRun(id, { ok: false, output: clip(errorText(error), RUN_OUTPUT_MAX) });
        throw error;
      }
      if (exec) {
        const result = output as HostOutput<"exec">;
        store.finishRun(id, {
          ok: result.exitCode === 0 && !result.timedOut,
          output: clip(result.output, RUN_OUTPUT_MAX),
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
        });
      } else {
        const summary = stepSummary(method as Exclude<HostMethod, "exec">, output as HostOutput<Exclude<HostMethod, "exec">>);
        store.finishRun(id, { ok: summary.ok, output: clip(summary.text, RUN_OUTPUT_MAX) });
      }
      return output;
    },
  };
}
