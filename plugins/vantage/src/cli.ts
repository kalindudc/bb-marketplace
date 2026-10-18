import { PLUGIN_CLI_OUTPUT_MAX_BYTES, PluginCliError, cliCommand, defineCli, type PluginCliRegistration } from "@get-bb/plugin-sdk";
import type { FileChange, Overview, Repo, Scope, ThreadSummary, Worktree } from "./contract";
import { primaryThreadId } from "./worktrees";

const MAX_FILES_PER_REPO = 50;
const MAX_COMMITS = 20;
const TITLE_WIDTH = 30;
const JSON_FILE_CAPS = [Infinity, 200, 50, 10, 0];
const OUTPUT_MARGIN_BYTES = 2048;

const STATUS_LETTER: Record<FileChange["status"], string> = {
  added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", "type-changed": "T", unmerged: "U", untracked: "?", clean: "·",
};

const CAPTION: Record<Repo["ref"]["kind"], (repo: Repo) => string> = {
  workspace: () => "Thread workspace",
  checkout: () => "Edited by path",
  branch: (repo) => `Archived branch${repo.aheadCount === null ? "" : ` · ${repo.aheadCount} ${repo.aheadCount === 1 ? "commit" : "commits"}`}`,
  recorded: () => "Recorded edits only",
};

const counts = (additions: number | null, deletions: number | null): string =>
  additions === null && deletions === null ? "binary" : `+${additions ?? 0} −${deletions ?? 0}`;

function fileLine(file: FileChange): string {
  const name = file.previousPath === null ? file.path : `${file.previousPath} → ${file.path}`;
  const note = file.status === "clean" ? "  (edited, no change now)" : "";
  return `  ${STATUS_LETTER[file.status]}  ${name}${file.status === "clean" ? "" : `  ${counts(file.additions, file.deletions)}`}${note}`;
}

function fileLines(files: readonly FileChange[], limit: number): string[] {
  const lines = files.slice(0, limit).map(fileLine);
  if (files.length > limit) lines.push(`  … ${files.length - limit} more`);
  return lines;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

function repoLines(repo: Repo, threadTitles: ReadonlyMap<string, string>, showHost: boolean): string[] {
  const header = [
    repo.label, CAPTION[repo.ref.kind](repo), repo.branch === null ? null : `branch ${repo.branch}`,
    repo.state === "ready" ? `${plural(repo.totals.files, "file")} ${counts(repo.totals.additions, repo.totals.deletions)}` : null,
    showHost ? repo.hostName : null,
  ].filter((part) => part !== null).join(" · ");
  const lines = [header];
  if (repo.root !== null) lines.push(`  path: ${repo.root}`);
  lines.push(`  threads: ${repo.threadIds.map((id) => threadTitles.get(id) ?? id).join(", ")}`);
  if (repo.state === "unavailable") {
    lines.push(`  Unavailable: ${repo.message ?? "unknown error"}`);
    return lines;
  }
  lines.push(...fileLines(repo.files, MAX_FILES_PER_REPO));
  if (repo.truncated) lines.push("  (the list was cut at the first files)");
  if (repo.otherFiles.length > 0) lines.push(`  + ${repo.otherFiles.length} other changes in this repo that these threads did not edit`);
  return lines;
}

export function formatOverview(overview: Overview): string {
  const threadTitles = new Map(overview.threads.map((thread) => [thread.id, thread.archived ? `${thread.title} (archived)` : thread.title]));
  const files = overview.repos.reduce((sum, repo) => sum + repo.totals.files, 0);
  const additions = overview.repos.reduce((sum, repo) => sum + repo.totals.additions, 0);
  const deletions = overview.repos.reduce((sum, repo) => sum + repo.totals.deletions, 0);
  const scope = overview.scope === "branch" ? "everything on the branch" : "uncommitted changes";
  const lines = [
    `${plural(overview.repos.length, "repo")} · ${plural(files, "file")} · ${counts(additions, deletions)} · ${plural(overview.threads.length, "thread")} (${scope})`,
  ];
  if (overview.truncatedThreads) lines.push("Only the first 200 threads of the tree were read.");
  if (overview.repos.length === 0 && overview.otherFiles.length === 0) lines.push("No changes in this thread or its child threads yet.");
  const showHost = new Set(overview.repos.map((repo) => repo.hostId)).size > 1;
  for (const repo of overview.repos) lines.push("", ...repoLines(repo, threadTitles, showHost));
  if (overview.otherFiles.length > 0) {
    lines.push("", "Other files (outside any repository, from recorded edits)");
    lines.push(...fileLines(overview.otherFiles, MAX_FILES_PER_REPO));
  }
  if (overview.warnings.length > 0) lines.push("", "Warnings", ...overview.warnings.map((warning) => `  - ${warning}`));
  return `${lines.join("\n")}\n`;
}

const trimTitle = (title: string): string => (title.length > TITLE_WIDTH ? `${title.slice(0, TITLE_WIDTH - 1)}…` : title);

function worktreeStatus(worktree: Worktree, thread: ThreadSummary | undefined): string {
  if (worktree.kind === "branch" || thread?.archived === true) return "archived";
  if (worktree.state === "unavailable") return "unavailable";
  if (thread?.status === "active") return "running";
  if (thread?.status === "error") return "failed";
  return thread?.status ?? "unknown";
}

const behindAhead = (worktree: Worktree): string =>
  worktree.aheadCount === null || worktree.behindCount === null ? "-" : `↑${worktree.aheadCount} ↓${worktree.behindCount}`;

function uncommittedLabel(worktree: Worktree): string {
  if (worktree.kind === "branch" || worktree.state === "unavailable") return "-";
  return worktree.uncommitted.length === 0 ? "clean" : plural(worktree.uncommitted.length, "file");
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]! + 2))).join(""));
}

export function formatWorktrees(overview: Overview): string {
  if (overview.worktrees.length === 0) return "No worktrees in this thread or its child threads yet.\n";
  const threads = new Map(overview.threads.map((thread) => [thread.id, thread]));
  const titleOf = (worktree: Worktree): string => {
    const id = primaryThreadId(worktree, overview.threadId);
    return threads.get(id)?.title ?? id;
  };
  const rows = overview.worktrees.map((worktree) => [
    worktreeStatus(worktree, threads.get(primaryThreadId(worktree, overview.threadId))), trimTitle(titleOf(worktree)),
    behindAhead(worktree), uncommittedLabel(worktree), worktree.branch ?? "-",
  ]);
  const lines = table([["STATUS", "THREAD", "AHEAD/BEHIND", "UNCOMMITTED", "BRANCH"], ...rows]);
  if (overview.sharedFiles.length > 0) {
    const titles = new Map(overview.worktrees.map((worktree) => [worktree.key, titleOf(worktree)]));
    lines.push("", "Shared files (changed in more than one worktree)");
    for (const shared of overview.sharedFiles) {
      lines.push(`  ${shared.path}  (${shared.worktreeKeys.map((key) => titles.get(key) ?? key).join(", ")})`);
    }
  }
  if (overview.truncatedThreads) lines.push("", "Only the first 200 threads of the tree were read.");
  if (overview.warnings.length > 0) lines.push("", "Warnings", ...overview.warnings.map((warning) => `  - ${warning}`));
  return `${lines.join("\n")}\n`;
}

export function formatWorktree(overview: Overview, threadId: string): string {
  const worktree = overview.worktrees.find((entry) => entry.threadIds.includes(threadId));
  if (worktree === undefined) return `Thread ${threadId} has no worktree.\n`;
  const thread = overview.threads.find((entry) => entry.id === primaryThreadId(worktree, threadId));
  const counts = worktree.aheadCount === null || worktree.behindCount === null
    ? null : `${behindAhead(worktree)}${worktree.base === null ? "" : ` on ${worktree.base}`}`;
  const lines = [
    [thread?.title ?? threadId, worktree.branch, counts, worktreeStatus(worktree, thread)].filter((part) => part !== null).join(" · "),
    worktree.kind === "branch" ? `  kept in: ${worktree.root}` : `  path: ${worktree.root}`,
  ];
  if (worktree.state === "unavailable") {
    lines.push(`  Unavailable: ${worktree.message ?? "unknown error"}`);
    return `${lines.join("\n")}\n`;
  }
  if (worktree.uncommitted.length > 0) lines.push("", `Uncommitted (${plural(worktree.uncommitted.length, "file")})`, ...fileLines(worktree.uncommitted, MAX_FILES_PER_REPO));
  if (worktree.committed.length > 0) {
    const where = worktree.kind === "branch" ? "Committed on the kept branch" : "Committed on this branch";
    lines.push("", `${where} (${plural(worktree.committed.length, "file")})`, ...fileLines(worktree.committed, MAX_FILES_PER_REPO));
  }
  if (worktree.commits.length > 0) {
    lines.push("", `Commits (${worktree.commits.length})`);
    for (const commit of worktree.commits.slice(0, MAX_COMMITS)) {
      lines.push(`  ${commit.shortSha}  ${commit.subject}  (${commit.authorName}, ${new Date(commit.authoredAt).toISOString().slice(0, 10)})`);
    }
    if (worktree.commits.length > MAX_COMMITS) lines.push(`  … ${worktree.commits.length - MAX_COMMITS} more`);
  }
  if (lines.length === 2) lines.push("", "No changes.");
  return `${lines.join("\n")}\n`;
}

const bytes = (text: string): number => Buffer.byteLength(text);

const capWorktree = (worktree: Worktree, cap: number): Worktree => ({
  ...worktree, uncommitted: worktree.uncommitted.slice(0, cap), committed: worktree.committed.slice(0, cap), commits: worktree.commits.slice(0, cap),
});

// Prints the largest version of `build(cap)` that fits bb's output limit, trying fewer files each time.
function fitJson(build: (cap: number) => unknown): string {
  const limit = PLUGIN_CLI_OUTPUT_MAX_BYTES - OUTPUT_MARGIN_BYTES;
  let text = "";
  for (const cap of JSON_FILE_CAPS) {
    text = `${JSON.stringify(build(cap), null, 2)}\n`;
    if (bytes(text) <= limit) return text;
  }
  throw new PluginCliError("The output is too large to print.", { code: "output_too_large", hint: "Ask for a single thread or use the text output." });
}

const formatJson = (overview: Overview): string => fitJson((cap): Overview => ({
  ...overview,
  repos: overview.repos.map((repo) => ({
    ...repo,
    files: repo.files.slice(0, cap), otherFiles: repo.otherFiles.slice(0, cap),
    truncated: repo.truncated || repo.files.length > cap || repo.otherFiles.length > cap,
  })),
  worktrees: overview.worktrees.map((worktree) => capWorktree(worktree, cap)),
  otherFiles: overview.otherFiles.slice(0, cap),
}));

const formatWorktreesJson = (overview: Overview): string => fitJson((cap) => ({
  threadId: overview.threadId,
  threads: overview.threads,
  worktrees: overview.worktrees.map((worktree) => capWorktree(worktree, cap)),
  sharedFiles: overview.sharedFiles,
}));

function fitText(text: string): string {
  const limit = PLUGIN_CLI_OUTPUT_MAX_BYTES - OUTPUT_MARGIN_BYTES;
  return bytes(text) <= limit ? text : `${Buffer.from(text).subarray(0, limit).toString("utf8")}\n… output cut\n`;
}

const signalOf = (ctx: { signal?: AbortSignal }): AbortSignal => ctx.signal ?? new AbortController().signal;

const threadRequired = (): PluginCliError =>
  new PluginCliError("No thread to read.", { code: "thread_required", hint: "Pass --thread <id>, or run this inside a thread." });

export function createCli(
  run: (input: { threadId: string; scope: Scope }, signal: AbortSignal) => Promise<Overview>,
  rootOf: (threadId: string, signal: AbortSignal) => Promise<string>,
): PluginCliRegistration {
  return defineCli({
    name: "vantage",
    summary: "Show what a thread and its child threads changed across repositories",
    commands: {
      changes: cliCommand({
        summary: "List the repositories a thread and its child threads changed, with each changed file",
        description: "Groups the changes of the thread and every descendant, archived ones included, by repository.",
        options: {
          thread: { type: "string", description: "Thread id to read; defaults to the current thread." },
          scope: {
            type: "enum", values: ["uncommitted", "branch"], default: "uncommitted",
            description: "uncommitted: working-tree changes. branch: everything since the base branch.",
          },
          json: { type: "boolean", description: "Print the overview as JSON." },
        },
        async run({ options }, ctx) {
          const threadId = options.thread ?? ctx.threadId;
          if (threadId === undefined) throw threadRequired();
          const overview = await run({ threadId, scope: options.scope }, signalOf(ctx));
          return { exitCode: 0, stdout: options.json ? formatJson(overview) : fitText(formatOverview(overview)) };
        },
      }),
      worktrees: cliCommand({
        summary: "List the worktrees of a thread and its child threads, with status, commits ahead and behind, and uncommitted files",
        description: "One row per workspace in the thread tree, archived children's kept branches included, then the files changed in more than one worktree.",
        options: {
          thread: { type: "string", description: "Thread id to read; defaults to the current thread." },
          json: { type: "boolean", description: "Print the worktrees and shared files as JSON." },
        },
        async run({ options }, ctx) {
          const threadId = options.thread ?? ctx.threadId;
          if (threadId === undefined) throw threadRequired();
          const overview = await run({ threadId, scope: "uncommitted" }, signalOf(ctx));
          return { exitCode: 0, stdout: options.json ? formatWorktreesJson(overview) : fitText(formatWorktrees(overview)) };
        },
      }),
      worktree: cliCommand({
        summary: "Show one thread's worktree: its uncommitted and committed files and its commits",
        description: "Reads the whole tree the thread belongs to, so files shared with sibling worktrees are known, and prints the worktree the thread works in.",
        positionals: [{ name: "thread", description: "Thread id whose worktree to show.", required: true }],
        options: { json: { type: "boolean", description: "Print the worktree as JSON." } },
        async run({ options, positionals }, ctx) {
          const signal = signalOf(ctx);
          const overview = await run({ threadId: await rootOf(positionals.thread, signal), scope: "uncommitted" }, signal);
          const worktree = overview.worktrees.find((entry) => entry.threadIds.includes(positionals.thread));
          if (worktree === undefined) {
            throw new PluginCliError(`Thread ${positionals.thread} has no worktree.`, {
              code: "worktree_not_found", hint: "A thread has a worktree only while its workspace exists or its branch is kept.",
            });
          }
          const stdout = options.json ? fitJson((cap) => capWorktree(worktree, cap)) : fitText(formatWorktree(overview, positionals.thread));
          return { exitCode: 0, stdout };
        },
      }),
    },
  });
}
