import type { Commit, GitFile } from "./contract";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const PATCH_LIMIT = 1_048_576;
export const FILE_LIMIT = 2000;
export const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%at%x1f%s";
export const REFLOG_FORMAT = "%H%x1f%gd%x1f%gs";
// Reflog times are whole seconds, and bb's clock and the machine's may differ a little.
export const REFLOG_SLACK_MS = 2000;

export interface GitEntry { path: string; previousPath: string | null; code: string }
export interface ReflogEntry { sha: string; at: number; action: string }
export interface TimeWindow { start: number; end: number }
export interface NumstatEntry { additions: number | null; deletions: number | null; previousPath: string | null }

const fields = (output: string): string[] => {
  const parts = output.split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
};

const hasPair = (letter: string | undefined): boolean => letter === "R" || letter === "C";

// `git status --porcelain=v1 -z`: `XY path\0`; a rename or copy is `XY new\0old\0`.
export function parseStatusZ(output: string): GitEntry[] {
  const parts = fields(output);
  const entries: GitEntry[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const code = part.slice(0, 2);
    const path = part.slice(3);
    const pair = hasPair(code[0]) || hasPair(code[1]);
    entries.push({ path, previousPath: pair ? (parts[++index] ?? null) : null, code });
  }
  return entries;
}

// `git diff --name-status -z -M`: `S\0path\0`; a rename or copy is `Sscore\0old\0new\0`.
export function parseNameStatusZ(output: string): GitEntry[] {
  const parts = fields(output);
  const entries: GitEntry[] = [];
  for (let index = 0; index < parts.length; index++) {
    const code = parts[index]!;
    if (hasPair(code[0])) {
      const previousPath = parts[++index] ?? null;
      entries.push({ path: parts[++index] ?? "", previousPath, code });
    } else {
      entries.push({ path: parts[++index] ?? "", previousPath: null, code });
    }
  }
  return entries;
}

// `git diff --numstat -z`: `a\td\tpath\0`; a rename is `a\td\t\0old\0new\0`; `-` counts mean binary.
export function parseNumstatZ(output: string): Map<string, NumstatEntry> {
  const parts = fields(output);
  const stats = new Map<string, NumstatEntry>();
  for (let index = 0; index < parts.length; index++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[index]!);
    if (match === null) continue;
    const additions = match[1] === "-" ? null : Number(match[1]);
    const deletions = match[2] === "-" ? null : Number(match[2]);
    if (match[3] === "") {
      const previousPath = parts[++index] ?? null;
      const path = parts[++index];
      if (path !== undefined) stats.set(path, { additions, deletions, previousPath });
    } else {
      stats.set(match[3]!, { additions, deletions, previousPath: null });
    }
  }
  return stats;
}

export function statusFromCode(code: string): GitFile["status"] {
  if (code === "??") return "untracked";
  if (code.includes("U") || code === "AA" || code === "DD") return "unmerged";
  switch (code.trim()[0]) {
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "T": return "type-changed";
    default: return "modified";
  }
}

// `git rev-parse --show-toplevel --show-prefix`: the root, then the prefix of the cwd inside it.
export function splitToplevel(output: string): { root: string; prefix: string } | null {
  const [root = "", prefix = ""] = output.split("\n");
  return root === "" ? null : { root, prefix };
}

export function isSafeRelativePath(path: string): boolean {
  if (path === "" || path.includes("\0") || /^([/\\]|[A-Za-z]:)/.test(path)) return false;
  return path.split(/[/\\]/).every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function isSafeSha(sha: string): boolean {
  return /^[0-9a-f]{7,64}$/.test(sha);
}

// `git log --format=LOG_FORMAT`: one `sha\x1fshort\x1fauthor\x1fseconds\x1fsubject` line per commit.
export function parseLog(output: string): Commit[] {
  const commits: Commit[] = [];
  for (const line of output.split("\n")) {
    const parts = line.split("\x1f");
    if (parts.length !== 5) continue;
    const [sha, shortSha, authorName, seconds, subject] = parts as [string, string, string, string, string];
    const authoredAt = Number(seconds) * 1000;
    if (!isSafeSha(sha) || !Number.isFinite(authoredAt)) continue;
    commits.push({ sha, shortSha, subject, authorName, authoredAt });
  }
  return commits;
}

// `git log -g --date=unix --format=REFLOG_FORMAT`: `sha\x1fHEAD@{seconds}\x1faction: message` per entry, newest first.
export function parseReflog(output: string): ReflogEntry[] {
  const entries: ReflogEntry[] = [];
  for (const line of output.split("\n")) {
    const [sha = "", selector = "", ...subject] = line.split("\x1f");
    const seconds = /@\{(\d+)\}$/.exec(selector)?.[1];
    if (subject.length === 0 || !isSafeSha(sha) || seconds === undefined) continue;
    const text = subject.join("\x1f");
    const colon = text.indexOf(":");
    entries.push({ sha, at: Number(seconds) * 1000, action: colon === -1 ? text : text.slice(0, colon) });
  }
  return entries;
}

const COMMIT_ACTION = /^commit(?: \((?:amend|initial|merge)\))?$/;

// The commits `git commit` made while one of the windows was open, newest first and each once.
export function commitsInWindows(entries: readonly ReflogEntry[], windows: readonly TimeWindow[]): string[] {
  const found = new Set<string>();
  for (const entry of entries) {
    if (!COMMIT_ACTION.test(entry.action)) continue;
    if (windows.some((window) => entry.at >= window.start - REFLOG_SLACK_MS && entry.at <= window.end + REFLOG_SLACK_MS)) found.add(entry.sha);
  }
  return [...found];
}

export function isSafeRef(ref: string): boolean {
  return /^[A-Za-z0-9._/@-]+$/.test(ref) && !ref.startsWith("-") && !ref.includes("..");
}

export function truncatePatch(patch: string, limit: number = PATCH_LIMIT): { patch: string; truncated: boolean } {
  if (patch.length <= limit) return { patch, truncated: false };
  const newline = patch.lastIndexOf("\n", limit - 1);
  return { patch: patch.slice(0, newline === -1 ? limit : newline + 1), truncated: true };
}

export function countDiffLines(diff: string | null | undefined): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of (diff ?? "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}
