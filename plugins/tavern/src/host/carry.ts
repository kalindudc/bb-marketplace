import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, openSync, unlinkSync, writeSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { BLOB_MAX_BYTES, type HostInput, type HostOutput } from "../host-contract";
import { gitOidSchema } from "../shared/placement";
import { decodeChunk } from "./files";
import type { TransferContext } from "./context";
import { HostError } from "./registry";

type CarryMethod = "carryStart" | "carryWrite" | "carryDelete" | "carryFinish" | "carryAbort";
type NativeInput<M extends CarryMethod> = HostInput<M> & { worktree: string; base: string; tree: string };
const carryMarkSchema = z.object({ base: gitOidSchema, tree: gitOidSchema, heads: z.array(gitOidSchema), from: gitOidSchema.optional(), temp: z.string().optional(), committing: z.object({ parent: gitOidSchema, tree: gitOidSchema }).strict().optional(), mismatched: gitOidSchema.optional() }).strict();
const symlinkOffset = (mode: string, offset: number) => mode === "120000" && offset !== 0;
export const carryFaults: {
  beforeRename?: () => void;
  afterRename?: () => void;
  beforeCommit?: () => void;
  afterCommit?: () => void;
  beforeMarkRename?: () => void;
  rename?: (from: string, to: string) => void;
  deviceOf?: (path: string) => number;
} = {};

export function nativeCarry(context: TransferContext) {
const PATH_BATCH = 500;
const tail = (text: string) => text.trim().slice(-2000);
const parseJson = <T>(text: string): T => JSON.parse(text) as T;
const git = (_root: string, args: readonly string[], options?: { raw?: boolean; signal?: AbortSignal; env?: Record<string,string>; timeoutMs?: number; input?: string }) => context.git(args, options);
const run = (_root: string, args: readonly string[], _signal?: AbortSignal) => context.run(args);
const tryGit = async (root: string, args: readonly string[], signal?: AbortSignal) => { const result = await run(root, args, signal); return result.code === 0 ? result.stdout.trim() : null; };
const topLevel = (root: string, signal?: AbortSignal) => git(root, ["rev-parse", "--show-toplevel"], { signal });
const hasCommit = async (root: string, sha: string, signal?: AbortSignal) => (await tryGit(root, ["cat-file", "-e", sha+"^{commit}"], signal)) !== null;
const runRemote = (_root: string, args: readonly string[], timeoutMs: number, _signal?: AbortSignal) => context.run(args, { timeoutMs });
const networkTimeout = (input: {networkTimeoutMs: number}) => input.networkTimeoutMs;
const failure = (args: readonly string[], result: {stderr:string;stdout:string}) => new HostError("git-failed", "Git "+args[0]+" failed: "+tail(result.stderr || result.stdout));
const authorEnv = (author: {name:string;email:string;date:string}) => ({ GIT_AUTHOR_NAME:author.name,GIT_AUTHOR_EMAIL:author.email,GIT_AUTHOR_DATE:author.date });
const identityArgs = async (root:string,signal?:AbortSignal) => (await tryGit(root,["config","--get","user.email"],signal)) ? [] : ["-c","user.name=Tavern","-c","user.email=tavern@localhost"];
function insideWorktree(top:string,path:string,_create:boolean) { const value=reach(top,path); if(!value.safe) throw new HostError("unsafe-path","The carry path traverses a symlink or file."); return value.file; }
interface CarryMark {
  base: string;
  tree: string;
  /** The commits the carry made on the way to `tree`, as a stacked ticket's carry makes two. */
  heads: string[];
  /** The worktree's HEAD before the carry. */
  from?: string;
  /** The carry's private directory for its temporary files: outside the worktree, on its filesystem. None: in place. */
  temp?: string;
  /** Journaled right before git commit: the commit the carry builds on and the tree it commits. */
  committing?: { parent: string; tree: string };
  /** A commit the carry made whose tree is not the one sent: it may hold someone else's change, so it is never the carry's. */
  mismatched?: string;
}

/** A path's content and git mode: "f:<1 executable, else 0>:<sha256>", "l:<sha256 of the target>", "dir", "other"; null when absent. */
type State = string | null;
/** What a path reached through a symlink or a file reads as: the carry owns nothing there. */
const UNREACHABLE = "unreachable";
type Intent = { w: string; o: number; n: number; m: string; pre: State; post: State; tmp: string } | { d: string; pre: State };
const logOf = (mark: string) => `${mark}.paths`;
const contentSha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const LITERAL = { GIT_LITERAL_PATHSPECS: "1" };

/** Test seams: a throw leaves the worktree as a crash at that point would; `rename` and `deviceOf` stand in for the filesystem's. */
const carryMarkOf = async (_worktree: string, _signal?: AbortSignal): Promise<string> => context.registry.transferPath(context.authority, "carry.json");
const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
const lstatOrNull = (file: string) => {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
};
const readCarryMark = (path: string): CarryMark | null => {
  const value = context.registry.readTransferState(context.authority, "carry.json", carryMarkSchema);
  if (value && (value.base !== context.transfer.base || value.tree !== context.transfer.tree)) throw new HostError("transfer-conflict", "The carry journal belongs to a different snapshot.");
  if (value?.temp && value.temp !== carryTempOf(context.root, path)) throw new HostError("carry-state-invalid", "The carry temporary directory is not owned by this transfer.");
  return value;
};
/** Publishes the mark whole: written next to it, then renamed over it, so a carry cut short keeps the last whole mark. */
function writeCarryMark(path: string, mark: CarryMark): void {
  context.active();
  carryFaults.beforeMarkRename?.();
  context.active();
  context.registry.writeTransferState(context.authority, "carry.json", carryMarkSchema, mark);
}

/**
 * The carry's private directory: next to its mark in the git directory, or else a hidden sibling of the worktree's top
 * level, the first whose parent is on the worktree's filesystem, so a rename from it is atomic. Null when neither is.
 */
function carryTempOf(top: string, mark: string): string | null {
  const deviceOf = carryFaults.deviceOf ?? ((path: string) => statSync(path).dev);
  const device = deviceOf(top);
  const sibling = join(dirname(top), `.tavern-carry-${createHash("sha256").update(realpathSync(top)).digest("hex").slice(0, 16)}`);
  return [`${mark}.tmp`, sibling].find((dir) => isDirectory(dirname(dir)) && deviceOf(dirname(dir)) === device) ?? null;
}

/** Whether git tracks the executable bit here; where it does not, the carry ignores it too. */
const fileModeOf = async (top: string, signal?: AbortSignal) => (await tryGit(top, ["config", "--get", "core.filemode"], signal)) !== "false";

/** The path's file, and whether it is reached through real directories only: no parent is a symlink or a file. */
function reach(top: string, path: string): { file: string; safe: boolean } {
  const names = path.split("/");
  let at = top;
  for (const name of names.slice(0, -1)) {
    at = join(at, name);
    const stat = lstatOrNull(at);
    if (stat === null) break;
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { file: join(top, path), safe: false };
  }
  return { file: join(top, path), safe: !names.includes("..") && !names.includes("") };
}

function stateOfFile(file: string, fm: boolean): State {
  const stat = lstatOrNull(file);
  if (stat === null) return null;
  if (stat.isSymbolicLink()) return `l:${contentSha(readlinkSync(file))}`;
  if (stat.isDirectory()) return "dir";
  if (!stat.isFile()) return "other";
  return `f:${fm && (stat.mode & 0o111) !== 0 ? 1 : 0}:${contentSha(readFileSync(file))}`;
}
function stateAt(top: string, path: string, fm: boolean): State {
  const { file, safe } = reach(top, path);
  return safe ? stateOfFile(file, fm) : UNREACHABLE;
}

/** A tree entry: its git mode, type and object id. */
type Entry = { mode: string; type: string; id: string };

/** Whether the path's file holds exactly `entry`, a blob, or is absent where `entry` is undefined: content as git hashes it, and mode. */
function holdsEntry(top: string, path: string, entry: Entry | undefined, fm: boolean): boolean {
  const { file, safe } = reach(top, path);
  if (!safe) return false;
  const stat = lstatOrNull(file);
  if (stat === null || entry === undefined) return stat === null && entry === undefined;
  if (entry.type !== "blob" || (entry.mode === "120000" ? !stat.isSymbolicLink() : !stat.isFile())) return false;
  if (fm && entry.mode !== "120000" && ((stat.mode & 0o111) !== 0) !== (entry.mode === "100755")) return false;
  const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);
  return createHash(entry.id.length === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") === entry.id;
}

/** What `rev` has at each path, by path, a directory as a tree; a path it lacks is not in it. */
async function treeEntries(top: string, rev: string, paths: readonly string[], signal?: AbortSignal): Promise<Map<string, Entry>> {
  const entries = new Map<string, Entry>();
  for (let at = 0; at < paths.length; at += PATH_BATCH) {
    const out = await git(top, ["ls-tree", "-z", "--full-tree", rev, "--", ...paths.slice(at, at + PATH_BATCH)], { raw: true, signal, env: LITERAL });
    for (const line of out.split("\0")) {
      const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/su.exec(line);
      if (match !== null) entries.set(match[4]!, { mode: match[1]!, type: match[2]!, id: match[3]! });
    }
  }
  return entries;
}

/**
 * The worktree's changes, as `git status --porcelain -z` gives them, "XY" by path. An untracked directory git lists whole
 * is listed file by file from the filesystem, never through a symlink, so each file is judged on its own.
 */
async function statusOf(top: string, signal?: AbortSignal): Promise<Map<string, string>> {
  const fields = (await git(top, ["status", "--porcelain", "-z"], { raw: true, signal, timeoutMs: 150_000 })).split("\0");
  const entries = new Map<string, string>();
  for (let at = 0; at < fields.length; at++) {
    const entry = fields[at]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename or copy names its source in the next field, which is a change too.
    if (xy[0] === "R" || xy[0] === "C") entries.set(fields[++at] ?? "", xy);
    if (xy === "??" && path.endsWith("/")) for (const file of filesBelow(top, path.slice(0, -1))) entries.set(file, xy);
    else entries.set(path.replace(/\/$/u, ""), xy);
  }
  entries.delete("");
  return entries;
}
function filesBelow(top: string, dir: string): string[] {
  const stat = lstatOrNull(join(top, dir));
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) return [dir];
  const names = readdirSync(join(top, dir));
  return names.length === 0 ? [dir] : names.flatMap((name) => filesBelow(top, `${dir}/${name}`));
}

/** The paths the index has staged against HEAD: empty when it still matches HEAD. */
async function stagedPaths(top: string, signal?: AbortSignal): Promise<string[]> {
  const quiet = await run(top, ["diff", "--cached", "--quiet"], signal);
  if (quiet.code === 0) return [];
  if (quiet.code !== 1) throw failure(["diff", "--cached", "--quiet"], quiet);
  // On newlines only when there is no NUL at all: a machine's git may not take -z on diff, while a NUL-separated name may
  // hold a newline. The names only say what is staged; --quiet decided.
  const out = await git(top, ["diff", "--cached", "--name-only", "-z"], { raw: true, signal });
  return out.split(out.includes("\0") ? "\0" : "\n").filter((path) => path !== "");
}

/** The paths that differ between two commits, as a reset from one to the other writes or removes them. */
async function pathsBetween(top: string, from: string, to: string, signal?: AbortSignal): Promise<string[]> {
  const fields = (await git(top, ["diff", "--name-status", "--no-renames", "-z", from, to, "--"], { raw: true, signal })).split("\0");
  const paths: string[] = [];
  for (let at = 1; at < fields.length; at += 2) if (fields[at] !== "") paths.push(fields[at]!);
  return paths;
}

function logIntent(mark: string, line: Intent): void {
  appendFileSync(logOf(mark), `${JSON.stringify(line)}\n`);
}
/** The carry's last intent for each path. */
function carryLog(mark: string): Map<string, Intent> {
  const last = new Map<string, Intent>();
  const log = logOf(mark);
  if (!existsSync(log)) return last;
  for (const text of readFileSync(log, "utf8").split("\n")) {
    const line = text === "" ? null : parseJson<Intent>(text);
    if (line !== null && typeof (line as { w?: unknown }).w === "string") last.set((line as { w: string }).w, line);
    else if (line !== null && typeof (line as { d?: unknown }).d === "string") last.set((line as { d: string }).d, line);
  }
  return last;
}
/** The states the carry's last intent for a path left it in: before the change, or after it. */
const leftBy = (intent: Intent): State[] => ("w" in intent ? [intent.pre, intent.post] : [intent.pre, null]);

/** Removes the temporary files the log names, each only while it still holds what the carry wrote to it. */
function removeOwnTemps(mark: string, fm: boolean): void {
  const dir = readCarryMark(mark)?.temp;
  if (dir === undefined) return;
  for (const intent of carryLog(mark).values()) {
    if (!("w" in intent) || dirname(intent.tmp) !== dir) continue;
    if (stateOfFile(intent.tmp, fm) === intent.post) rmSync(intent.tmp, { force: true });
  }
}
function clearCarry(mark: string, fm: boolean): void {
  removeOwnTemps(mark, fm);
  rmSync(`${mark}.next`, { force: true });
  rmSync(mark, { force: true });
  rmSync(logOf(mark), { force: true });
}

/**
 * Before the carry changes a path: it must hold what the carry left there, or, for a path the carry has not changed yet,
 * exactly what HEAD has, as the carry's reset or commit left it, content and mode, with no symlink on the way. Else
 * someone else changed it, and the carry stops, keeping it as it is.
 */
async function skippedPaths(top: string, paths: string[], signal?: AbortSignal): Promise<Set<string>> {
  const skipped = new Set<string>();
  for (let at = 0; at < paths.length; at += PATH_BATCH) {
    const output = await git(top, ["ls-files", "-t", "-z", "--", ...paths.slice(at, at + PATH_BATCH)], { raw: true, signal, env: LITERAL });
    for (const row of output.split("\0")) if (row.startsWith("S ")) skipped.add(row.slice(2));
  }
  return skipped;
}
async function guardPath(top: string, mark: string, path: string, fm: boolean, signal?: AbortSignal, skipped?: Set<string>): Promise<{ pre: State; left: boolean }> {
  if (!reach(top, path).safe) throw new Error(`${path} is reached through a symlink or a file now, so Tavern stops the carry and keeps it as it is`);
  const now = stateAt(top, path, fm);
  const intent = carryLog(mark).get(path);
  if (intent !== undefined) {
    if (!leftBy(intent).includes(now)) throw new Error(`${path} is not as the carry left it, so Tavern stops the carry and keeps the file as it is`);
    return { pre: now, left: true };
  }
  if (now === null && (skipped ? skipped.has(path) : (await skippedPaths(top, [path], signal)).has(path))) return { pre: null, left: false };
  if (!holdsEntry(top, path, (await treeEntries(top, "HEAD", [path], signal)).get(path), fm)) throw new Error(`${path} is not as the carry started it, so Tavern stops the carry and keeps the file as it is`);
  return { pre: now, left: false };
}
const changedSince = (path: string, left: boolean) => new Error(`${path} is not as the carry ${left ? "left" : "started"} it, so Tavern stops the carry and keeps the file as it is`);

/**
 * The paths a write or a reset would replace that hold something git does not show as a change: an ignored file or
 * directory where HEAD has nothing, or a path reached through a symlink or a file. A path holding what HEAD has, or what the
 * carry's log left there, is not one.
 */
async function obstructions(top: string, mark: string, paths: readonly string[], fm: boolean, signal?: AbortSignal): Promise<string[]> {
  const unique = [...new Set(paths)];
  const log = carryLog(mark);
  const atHead = await treeEntries(top, "HEAD", unique, signal);
  return unique.filter((path) => {
    if (!reach(top, path).safe) return true;
    const now = stateAt(top, path, fm);
    if (now === null) return false;
    const intent = log.get(path);
    if (intent !== undefined && leftBy(intent).includes(now)) return false;
    const entry = atHead.get(path);
    if (now === "dir") return entry?.type !== "tree";
    return !holdsEntry(top, path, entry, fm);
  });
}

/**
 * What of a carry cut short the worktree still has, and whether it is all the carry's: each changed path holds a state the
 * carry's log left it in, or, with no intent, what HEAD has; and the index differs from HEAD only where the worktree's
 * file is the carry's and matches it. Anything else is someone else's.
 */
async function carryLeftovers(top: string, mark: string, fm: boolean, signal?: AbortSignal): Promise<{ foreign: string[]; untracked: string[] }> {
  const log = carryLog(mark);
  const status = await statusOf(top, signal);
  const atHead = await treeEntries(top, "HEAD", [...status.keys()], signal);
  const foreign: string[] = [];
  const untracked: string[] = [];
  for (const [path, xy] of status) {
    const intent = log.get(path);
    const worktreeOwned = intent !== undefined ? leftBy(intent).includes(stateAt(top, path, fm)) : holdsEntry(top, path, atHead.get(path), fm);
    const indexOwned = xy[0] === " " || xy[0] === "?" || (intent !== undefined && xy[1] === " ");
    if (!worktreeOwned || !indexOwned) foreign.push(path);
    else if (xy === "??") untracked.push(path);
  }
  return { foreign, untracked };
}

const refusal = (message: string): HostOutput<"carryStart"> => ({ outcome: "unavailable", code: "carry-blocked", retryable: false, message });
const named = (paths: readonly string[]) => {
  const files = [...paths].sort().slice(0, 10);
  return `${files.join(", ")}${paths.length > files.length ? ", …" : ""}`;
};

async function carryStart(input: NativeInput<"carryStart">, signal?: AbortSignal): Promise<HostOutput<"carryStart">> {
  const { worktree, remote, baseBranch, base } = input;
  const mark = await carryMarkOf(worktree, signal);
  const top = await topLevel(worktree, signal);
  const fm = await fileModeOf(top, signal);
  let carried = readCarryMark(mark);
  let head = await git(worktree, ["rev-parse", "HEAD"], { signal });
  if (carried?.mismatched === head) {
    return refusal(`The worktree ${worktree} is at ${head.slice(0, 12)}, a commit Tavern's last carry made whose tree is not the one it sent, so it may hold changes the carry did not make. Tavern left it as it is: look at it, keep what is yours, and reset the branch, then try again`);
  }
  // A commit the carry journaled is its own when its parent and tree say so, the first of a stacked carry too. HEAD still at
  // the journaled parent means the commit never happened; that parent's own parent is never asked for, as a root has none.
  const committing = carried?.committing;
  if (carried !== null && committing !== undefined && head !== committing.parent && !carried.heads.includes(head)) {
    const parent = await tryGit(worktree, ["rev-parse", "--verify", "HEAD^"], signal);
    const tree = await git(worktree, ["rev-parse", "HEAD^{tree}"], { signal });
    if (parent === committing.parent && tree === committing.tree) carried = { ...carried, heads: [...carried.heads, head] };
  }
  // A carry cut short, by a crash, a lost answer, or a carry that failed and left its files, is taken over when all the
  // worktree's changes are its own and nothing ignored sits where its reset writes; else it touches nothing.
  const cutShort = carried !== null && carried.from !== undefined && (carried.base === head || carried.heads.includes(head));
  if (cutShort) {
    const { foreign, untracked } = await carryLeftovers(top, mark, fm, signal);
    if (foreign.length > 0) return dirtyRefusal(worktree, foreign, " that an earlier carry did not make");
    const blocked = await obstructions(top, mark, [...(await pathsBetween(top, head, carried!.base, signal)), ...carryLog(mark).keys()], fm, signal);
    if (blocked.length > 0) return obstructed(worktree, blocked);
    const log = carryLog(mark);
    for (const path of untracked) {
      const intent = log.get(path);
      if (intent !== undefined && leftBy(intent).includes(stateAt(top, path, fm))) removeFile(top, path);
    }
    await git(worktree, ["reset", "-q", "--hard", carried!.base], { signal, timeoutMs: 150_000 });
    head = await git(worktree, ["rev-parse", "HEAD"], { signal });
  }
  const [mergeHead = "", tree = ""] = (await git(worktree, ["rev-parse", "--git-path", "MERGE_HEAD", "HEAD^{tree}"], { signal })).split("\n");
  const from = cutShort ? carried!.from! : head;
  if (tree === input.tree) {
    const dirty = [...(await statusOf(top, signal)).keys()];
    if (dirty.length) return dirtyRefusal(worktree, dirty, "");
    clearCarry(mark, fm);
    return { outcome: "ok", present: true, from: head };
  }
  if (existsSync(resolve(worktree, mergeHead))) {
    return refusal(`The worktree ${worktree} has a merge that is not finished, so Tavern left it as it is. Finish it with git commit, or abort it with git merge --abort, then try again`);
  }
  const dirty = [...(await statusOf(top, signal)).keys()];
  if (dirty.length > 0) return dirtyRefusal(worktree, dirty, "");
  // merge-base rather than --is-ancestor, which a machine's git may not have.
  const fullRef = baseBranch.startsWith("refs/"), tracking = fullRef ? null : `refs/remotes/${remote}/${baseBranch}`;
  if (!cutShort && head !== base && tree !== input.replaces && (tracking === null || (await tryGit(worktree, ["merge-base", head, tracking], signal)) !== head)) {
    return refusal(fullRef
      ? `The worktree ${worktree} is not at the pinned base and has no matching trusted previous tree. Preserve its work before retrying; Tavern will not guess a tracking ref or drop unknown commits.`
      : `The worktree ${worktree} has commits that are not on ${remote}/${baseBranch}, so putting the work in would drop them: ${head.slice(0, 12)}. Stash them or move them to another branch, then try again`);
  }
  // The base is a commit of the remote's base branch. One that branch lacks here, as after the pull request's branch took
  // a newer base, moves it up, so the worker's changes are measured from that base and not from an older one.
  const fetchArgs = fullRef ? ["-c", "fetch.uriprotocols=", "-c", "transfer.bundleURI=false", "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--refmap="] : ["fetch", "--no-tags"];
  if (tracking === null ? !(await hasCommit(worktree, base, signal)) : (await tryGit(worktree, ["merge-base", base, tracking], signal)) !== base) await runRemote(worktree, [...fetchArgs, remote, baseBranch], networkTimeout(input), signal);
  if (!(await hasCommit(worktree, base, signal))) {
    const fetched = await runRemote(worktree, [...fetchArgs, remote, base], networkTimeout(input), signal);
    if (!(await hasCommit(worktree, base, signal))) {
      return { outcome: "unavailable", message: `The base commit ${base.slice(0, 12)} is not on this machine, and git fetch ${remote} ${base.slice(0, 12)} did not bring it: ${tail(fetched.stderr || fetched.stdout)}`, code: "base-unavailable", retryable: true };
    }
  }
  const temp = carryTempOf(top, mark);
  const blocked = await obstructions(top, mark, [...(input.paths ?? []), ...(head === base ? [] : await pathsBetween(top, head, base, signal))], fm, signal);
  if (blocked.length > 0) return obstructed(worktree, blocked);
  // The mark first, so a carry cut short during the reset is known as one.
  removeOwnTemps(mark, fm);
  rmSync(logOf(mark), { force: true });
  writeCarryMark(mark, { base, tree: input.tree, heads: [], from, ...(temp === null ? {} : { temp }) });
  if (head !== base) await git(worktree, ["reset", "-q", "--hard", base], { signal, timeoutMs: 150_000 });
  return { outcome: "ok", present: false, from };
}

function dirtyRefusal(worktree: string, paths: readonly string[], whose: string): HostOutput<"carryStart"> {
  return refusal(`The worktree ${worktree} has uncommitted changes${whose}, so Tavern cannot put the work in it: ${named(paths)}. Stash or discard them, then try again`);
}
function obstructed(worktree: string, paths: readonly string[]): HostOutput<"carryStart"> {
  return refusal(`The worktree ${worktree} has ignored or untracked files, or a symlink, where the work goes, so Tavern left them as they are: ${named(paths)}. Move them away, then try again`);
}

/** Removes a file the carry owns, and each real directory that leaves empty below the top level; never a symlinked one. */
function removeFile(top: string, path: string): void {
  const { file, safe } = reach(top, path);
  if (!safe) return;
  rmSync(file, { force: true });
  for (let dir = dirname(file); dir.length > top.length && dir.startsWith(`${top}/`); dir = dirname(dir)) {
    const stat = lstatOrNull(dir);
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory() || readdirSync(dir).length > 0) break;
    rmdirSync(dir);
  }
}

// The carry's paths are relative to the repository's top level, which a thread's worktree path may be a subdirectory of.
async function carryWrite(input: NativeInput<"carryWrite">): Promise<HostOutput<"carryWrite">> {
  const { path, mode, offset } = input;
  const top = await topLevel(input.worktree);
  insideWorktree(top, path, false);
  const fm = await fileModeOf(top);
  const mark = await carryMarkOf(input.worktree);
  const carried = readCarryMark(mark);
  if (carried === null) throw new Error(`No carry into ${input.worktree} has started, so Tavern writes nothing`);
  const { pre, left } = await guardPath(top, mark, path, fm);
  const { file } = reach(top, path);
  const bytes = decodeChunk(input.data);
  if (offset + bytes.length > BLOB_MAX_BYTES) throw new HostError("file-too-large", "Files over 100 MiB cannot move between machines.");
  if (symlinkOffset(mode, offset)) throw new HostError("chunk-offset", "A symlink target must be sent as one range at offset zero.");
  if (left) {
    const existing = mode === "120000" ? Buffer.from(readlinkSync(file)) : pre?.startsWith("f:") ? readFileSync(file) : null;
    if (existing && offset + bytes.length <= existing.length && existing.subarray(offset, offset + bytes.length).equals(bytes)) return { size: existing.length };
    if (offset === 0) throw new HostError("chunk-conflict", "A retried carry range differs from the bytes already accepted.");
  }
  const symlink = mode === "120000";
  let next: Buffer;
  if (symlink || offset === 0) next = bytes;
  else {
    const has = pre?.startsWith("f:") === true ? readFileSync(file) : null;
    if (has === null || has.length !== offset) throw new Error(`${path} has ${has?.length ?? 0} bytes, not ${offset}, so this range is out of order; send the file again from offset 0`);
    next = Buffer.concat([has, bytes]);
  }
  const executable = mode === "100755";
  const post = symlink ? `l:${contentSha(next)}` : `f:${fm && executable ? 1 : 0}:${contentSha(next)}`;
  const tmp = carried.temp === undefined ? "" : join(carried.temp, randomBytes(8).toString("hex"));
  // Logged before anything is written, so a carry cut short at any point knows the path and the file as its own.
  logIntent(mark, { w: path, o: offset, n: bytes.length, m: mode, pre, post, tmp });
  if (tmp === "") writeInPlace(top, path, { pre, left, next, symlink, executable, fm, append: !symlink && offset > 0 ? bytes : null });
  else {
    if (lstatOrNull(carried.temp!)?.isSymbolicLink()) throw new HostError("unsafe-path", "The carry temporary directory became a symlink.");
    mkdirSync(carried.temp!, { recursive: true });
    if (symlink) symlinkSync(next.toString("utf8"), tmp);
    else {
      writeFileSync(tmp, next);
      chmodSync(tmp, executable ? 0o755 : 0o644);
    }
    mkdirSync(dirname(file), { recursive: true });
    carryFaults.beforeRename?.();
    context.active();
    // Checked once more right before the file goes in, through real directories only.
    if (stateAt(top, path, fm) !== pre) {
      rmSync(tmp, { force: true });
      throw changedSince(path, left);
    }
    try {
      (carryFaults.rename ?? renameSync)(tmp, file);
    } catch (error) {
      rmSync(tmp, { force: true });
      // A rename across filesystems would need a write in place, which this carry chose not to make when it started.
      if ((error as NodeJS.ErrnoException).code === "EXDEV") throw new Error(`${path} would have to be written in place, as the carry's private directory is on another filesystem, so Tavern stops the carry and keeps the file as it is`);
      throw error;
    }
  }
  carryFaults.afterRename?.();
  return { size: symlink ? next.length : offset + bytes.length };
}

/**
 * Writes a carry file in place, where no private directory shares the worktree's filesystem. The path is checked right
 * before the write and reached through real directories only; the file is opened with O_NOFOLLOW, so a symlink put there
 * since the check fails the write instead of being followed. A leaf symlink, which the check found to be HEAD's or the
 * carry's own, is removed first; a range is appended only to the file the check read, of the length it read.
 */
function writeInPlace(top: string, path: string, a: { pre: State; left: boolean; next: Buffer; symlink: boolean; executable: boolean; fm: boolean; append: Buffer | null }): void {
  const { file } = reach(top, path);
  mkdirSync(dirname(file), { recursive: true });
  carryFaults.beforeRename?.();
    context.active();
  if (!reach(top, path).safe || stateAt(top, path, a.fm) !== a.pre) throw changedSince(path, a.left);
  const existing = lstatOrNull(file);
  if (existing?.isFile() && existing.nlink !== 1) throw new HostError("unsafe-path", "Cannot carry in place over a hard-linked file.");
  if (existing?.isDirectory() === true) throw new Error(`${path} is a directory now, so Tavern stops the carry and keeps it as it is`);
  if (a.symlink || existing?.isSymbolicLink() === true) {
    if (a.append !== null) throw changedSince(path, a.left);
    if (existing !== null) unlinkSync(file);
    if (a.symlink) return symlinkSync(a.next.toString("utf8"), file);
  }
  const { O_WRONLY, O_CREAT, O_TRUNC, O_APPEND, O_NOFOLLOW } = fsConstants;
  const fd = openSync(file, a.append === null ? O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW : O_WRONLY | O_APPEND | O_NOFOLLOW, 0o644);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || (a.append !== null && opened.size !== a.next.length - a.append.length)) throw changedSince(path, a.left);
    const data = a.append ?? a.next;
    for (let at = 0; at < data.length; ) at += writeSync(fd, data, at, data.length - at);
    fchmodSync(fd, a.executable ? 0o755 : 0o644);
  } finally {
    closeSync(fd);
  }
}

/** Deletes each path, and each directory that leaves empty, so a file may take a deleted directory's place. */
async function carryDelete(input: NativeInput<"carryDelete">): Promise<HostOutput<"carryDelete">> {
  const top = await topLevel(input.worktree);
  const fm = await fileModeOf(top);
  const mark = await carryMarkOf(input.worktree);
  const skipped = await skippedPaths(top, input.paths.filter(path => stateAt(top, path, fm) === null));
  for (const path of input.paths) {
    insideWorktree(top, path, false);
    const { pre, left } = await guardPath(top, mark, path, fm, undefined, skipped);
    logIntent(mark, { d: path, pre });
    if (stateAt(top, path, fm) !== pre) throw changedSince(path, left);
    removeFile(top, path);
  }
  return {};
}

/** What a path the carry wrote or deleted holds now: what the carry wrote, what it held before, nothing, or anything else. */
function holdsNow(top: string, path: string, intent: Intent, fm: boolean): "carry" | "before" | "absent" | "changed" {
  const now = stateAt(top, path, fm);
  if (now === UNREACHABLE) return "changed";
  if ("w" in intent && now === intent.post) return "carry";
  if (now === null) return "absent";
  return now === intent.pre ? "before" : "changed";
}

/**
 * A carry that failed changes nothing in the worktree, its files and its index: losing the carry's progress is fine,
 * losing a worker's edit is not. It removes its own temporary files, keeps its mark, so a later carry takes its files
 * over, and says what each path it wrote or deleted holds now (`carried`) and what the worktree has changed (`kept`).
 */
async function carryAbort(input: NativeInput<"carryAbort">, signal?: AbortSignal): Promise<HostOutput<"carryAbort">> {
  const top = await topLevel(input.worktree, signal);
  const fm = await fileModeOf(top, signal);
  const mark = await carryMarkOf(input.worktree, signal);
  removeOwnTemps(mark, fm);
  const carried = [...carryLog(mark)].map(([path, intent]) => ({ path, holds: holdsNow(top, path, intent, fm) })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const kept = [...(await statusOf(top, signal)).keys()].sort();
  return { clean: kept.length === 0, kept, carried };
}

/**
 * Commits the carry's own paths with git add and git commit: the files it wrote, each still holding what it wrote, and
 * the ones it deleted, still gone. Refused ("foreign") before anything is staged when a carry path holds anything else or
 * the worker's index differs from HEAD anywhere, as a worker's staged change. The commit is journaled first. A commit
 * whose tree is not `tree` is a mismatch: it stays as it is, and is never the carry's own, so the next carry refuses it.
 */
async function carryFinish(input: NativeInput<"carryFinish">, signal?: AbortSignal): Promise<HostOutput<"carryFinish">> {
  const { worktree, message, author, tree, paths } = input;
  const top = await topLevel(worktree, signal);
  const fm = await fileModeOf(top, signal);
  const mark = await carryMarkOf(worktree, signal);
  const log = carryLog(mark);
  const written = [...new Set(paths)];
  const deleted = [...log.values()].flatMap((intent) => ("d" in intent && !written.includes(intent.d) ? [intent.d] : []));
  const foreign = new Set<string>(await stagedPaths(top, signal));
  for (const path of written) {
    const intent = log.get(path);
    if (intent === undefined || !("w" in intent) || stateAt(top, path, fm) !== intent.post) foreign.add(path);
  }
  for (const path of deleted) if (stateAt(top, path, fm) !== null) foreign.add(path);
  if (foreign.size > 0) return { outcome: "foreign", paths: [...foreign].sort() };

  const parent = await git(top, ["rev-parse", "HEAD"], { signal });
  const carried = readCarryMark(mark);
  if (carried !== null) writeCarryMark(mark, { ...carried, committing: { parent, tree } });
  const skipped = await skippedPaths(top, written, signal);
  if (skipped.size) await git(top, ["update-index", "-z", "--no-skip-worktree", "--stdin"], { signal, input: [...skipped].join("\0") + "\0", timeoutMs: 150_000 });
  if (written.length || deleted.length) await git(top, ["update-index", "-z", "--add", "--remove", "--stdin"], { signal, input: [...written, ...deleted].join("\0") + "\0", timeoutMs: 150_000 });
  carryFaults.beforeCommit?.();
  if ((await stagedPaths(top, signal)).length > 0) {
    await git(top, ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...(await identityArgs(top, signal)), "commit", "--no-verify", "--no-gpg-sign", "-q", "-m", message], { signal, env: authorEnv(author), timeoutMs: 150_000 });
  }
  carryFaults.afterCommit?.();
  const [head = "", built = ""] = (await git(top, ["rev-parse", "HEAD", "HEAD^{tree}"], { signal })).split("\n");
  // The mark ends with the tree the carry started for; a commit on the way to it, as a stacked ticket's first, joins it. A
  // commit whose tree is not the one sent never does: the next carry refuses it, touching nothing.
  const now = readCarryMark(mark);
  if (now === null || (now.tree === built && built === tree)) clearCarry(mark, fm);
  else {
    const { committing: _done, ...rest } = now;
    if (built === tree) {
      writeCarryMark(mark, { ...rest, heads: head === parent ? now.heads : [...now.heads, head] });
      rmSync(logOf(mark), { force: true });
    } else writeCarryMark(mark, { ...rest, ...(head === parent ? {} : { mismatched: head }) });
  }
  return built === tree ? { outcome: "ok", head, tree: built } : { outcome: "mismatch", tree: built };
}


return { carryStart, carryWrite, carryDelete, carryFinish, carryAbort };
}
