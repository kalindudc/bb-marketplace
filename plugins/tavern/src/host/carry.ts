import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, openSync, unlinkSync, writeSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
const failure = (args: readonly string[], result: {stderr:string;stdout:string}) => new HostError("git-failed", "Git "+args[0]+" failed: "+tail(result.stderr || result.stdout));
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
 * The carry's private directory: next to its private mark, or else a hidden sibling of the worktree's top
 * level, the first whose parent is on the worktree's filesystem, so a rename from it is atomic. Null when neither is.
 */
function carryTempOf(top: string, mark: string): string | null {
  const deviceOf = carryFaults.deviceOf ?? ((path: string) => statSync(path).dev);
  const device = deviceOf(top);
  const sibling = join(dirname(top), `.tavern-carry-${createHash("sha256").update(realpathSync(top)).digest("hex").slice(0, 16)}`);
  return [`${mark}.tmp`, sibling].find((dir) => isDirectory(dirname(dir)) && deviceOf(dirname(dir)) === device) ?? null;
}

/** Whether git tracks the executable bit here; where it does not, the carry ignores it too. */
const fileModeOf = async (top: string, signal?: AbortSignal) => (await tryGit(top, ["config", "--type=bool", "--get", "core.filemode"], signal)) !== "false";

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
  return `f:${fm && (stat.mode & 0o100) !== 0 ? 1 : 0}:${contentSha(readFileSync(file))}`;
}
function stateAt(top: string, path: string, fm: boolean): State {
  const { file, safe } = reach(top, path);
  return safe ? stateOfFile(file, fm) : UNREACHABLE;
}

/**
 * The worktree's changes, as `git status --porcelain -z` gives them, "XY" by path. An untracked directory git lists whole
 * is listed file by file from the filesystem, never through a symlink, so each file is judged on its own.
 */
async function statusOf(top: string, signal?: AbortSignal): Promise<Map<string, string>> {
  const fields = (await git(top, ["status", "--porcelain", "-z"], { raw: true, signal, timeoutMs: 300_000 })).split("\0");
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
 * exactly what the carry recorded before writing, content and mode, with no symlink on the way. Else
 * someone else changed it, and the carry stops, keeping it as it is.
 */
async function guardPath(top: string, mark: string, path: string, fm: boolean, cached?: { log: Map<string, Intent>; initial: Record<string, string | null> | null }): Promise<{ pre: State; left: boolean }> {
  if (!reach(top, path).safe) throw new Error(`${path} is reached through a symlink or a file now, so Tavern stops the carry and keeps it as it is`);
  const now = stateAt(top, path, fm);
  const log = cached ? cached.log : carryLog(mark);
  const intent = log.get(path);
  if (intent !== undefined) {
    if (!leftBy(intent).includes(now)) throw new Error(`${path} is not as the carry left it, so Tavern stops the carry and keeps the file as it is`);
    return { pre: now, left: true };
  }
  const initial = cached ? cached.initial : context.registry.readTransferState(context.authority, "carry-initial.json", z.record(z.string(), z.string().nullable()));
  const structuralDeletion = now === null && initial && (initial[path] === UNREACHABLE
    ? [...log.values()].some(intent => "d" in intent && path.startsWith(intent.d + "/"))
    : initial[path] === "dir" && [...log.values()].some(intent => "d" in intent && intent.d.startsWith(path + "/")));
  if (!initial || !(path in initial) || initial[path] !== now && !structuralDeletion) throw changedSince(path, false);
  return { pre: now, left: false };
}
const changedSince = (path: string, left: boolean) => new Error(`${path} is not as the carry ${left ? "left" : "started"} it, so Tavern stops the carry and keeps the file as it is`);

const refusal = (message: string): HostOutput<"carryStart"> => ({ outcome: "unavailable", code: "carry-blocked", retryable: false, message });
const named = (paths: readonly string[]) => {
  const files = [...paths].sort().slice(0, 10);
  return `${files.join(", ")}${paths.length > files.length ? ", …" : ""}`;
};

// Ported from plugins/loom/src/host/ops.ts. A retry takes over only the carry's journaled files.
async function carryStart(input: NativeInput<"carryStart">, signal?: AbortSignal): Promise<HostOutput<"carryStart">> {
  const top = await topLevel(input.worktree, signal), mark = await carryMarkOf(input.worktree), fm = await fileModeOf(top, signal);
  const head = await git(top, ["rev-parse", "--verify", "HEAD"]), tree = await git(top, ["rev-parse", "--verify", "HEAD^{tree}"]);
  const carried = readCarryMark(mark);
  if (carried?.committing && head !== carried.committing.parent && tree === input.tree && /^parent ([a-f0-9]+)$/mu.exec((await git(top, ["cat-file", "commit", head], { raw: true })).split("\n\n")[0]!)?.[1] === carried.committing.parent) {
    if ((await statusOf(top)).size) return dirtyRefusal(top, [...(await statusOf(top)).keys()], "");
    clearCarry(mark, fm); return { outcome: "ok", present: true, from: head };
  }
  if (head !== (input.expectedHead ?? input.base)) return refusal("The member HEAD differs from Tavern's recorded commit. Preserve its commits and provision a fresh checkout before retrying; Tavern will not reset this branch.");
  if (await git(top, ["ls-files", "--unmerged", "-z"], { raw: true })) return refusal("Resolve the member's unmerged entries before carrying work.");
  const status = await statusOf(top, signal), log = carryLog(mark);
  if (carried) {
    const foreign = [...status.keys()].filter(path => { const intent = log.get(path); return !intent || !leftBy(intent).includes(stateAt(top, path, fm)); });
    foreign.push(...await foreignStaged(top, mark, fm));
    if (foreign.length) return dirtyRefusal(top, foreign, " that an earlier carry did not make");
    return { outcome: "ok", present: tree === input.tree && status.size === 0, from: carried.from ?? head };
  }
  if (status.size) return dirtyRefusal(top, [...status.keys()], "");
  if (tree === input.tree) return { outcome: "ok", present: true, from: head };
  for (let at = 0; at < input.paths.length; at += PATH_BATCH) {
    const paths = input.paths.slice(at, at + PATH_BATCH);
    if (await git(top, ["status", "--porcelain", "--ignored", "-z", "--", ...paths], { raw: true, env: LITERAL, timeoutMs: 300_000 })) return obstructed(top, paths);
  }
  const initial = Object.fromEntries(input.paths.map(path => [path, stateAt(top, path, fm)]));
  context.registry.writeTransferState(context.authority, "carry-initial.json", z.record(z.string(), z.string().nullable()), initial);
  const temp = carryTempOf(top, mark);
  writeCarryMark(mark, { base: input.base, tree: input.tree, heads: [], from: head, ...(temp === null ? {} : { temp }) });
  return { outcome: "ok", present: false, from: head };
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
  const intent = carryLog(mark).get(path);
  if (left && intent && "w" in intent && pre === intent.post) {
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
  const cached = { log: carryLog(mark), initial: context.registry.readTransferState(context.authority, "carry-initial.json", z.record(z.string(), z.string().nullable())) };
  for (const path of input.paths) {
    context.active();
    insideWorktree(top, path, false);
    const { pre, left } = await guardPath(top, mark, path, fm, cached);
    const intent = { d: path, pre };
    logIntent(mark, intent); cached.log.set(path, intent);
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

async function foreignStaged(top: string, mark: string, fm: boolean): Promise<string[]> {
  const log = carryLog(mark), foreign: string[] = [];
  const paths = await stagedPaths(top), entries = new Map<string, { mode: string; sha: string }>();
  for (let at = 0; at < paths.length; at += PATH_BATCH) {
    const rows = await git(top, ["ls-files", "--stage", "-z", "--", ...paths.slice(at, at + PATH_BATCH)], { raw: true, env: LITERAL });
    for (const row of rows.split("\0").filter(Boolean)) {
      const match = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/u.exec(row);
      if (!match) throw new HostError("invalid-index", "Git ls-files returned an unreadable staged entry.");
      if (match[3] !== "0") foreign.push(match[4]!);
      else entries.set(match[4]!, { mode: match[1]!, sha: match[2]! });
    }
  }
  for (const path of paths) {
    const intent = log.get(path), entry = entries.get(path);
    if (!intent) { foreign.push(path); continue; }
    if ("d" in intent) { if (entry) foreign.push(path); continue; }
    const file = join(top, path), stat = lstatOrNull(file);
    if (!stat || stateAt(top, path, fm) !== intent.post) { foreign.push(path); continue; }
    if (!entry && context.endpoint.inspection!.sparse && readCarryMark(mark)?.committing) continue;
    if (!entry) { foreign.push(path); continue; }
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);
    const sha = createHash(entry.sha.length === 40 ? "sha1" : "sha256").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (sha !== entry.sha || intent.m !== entry.mode) foreign.push(path);
  }
  return foreign;
}

/** A mismatched commit stays on the branch for reconciliation; it is never claimed as a completed carry. */
async function carryFinish(input: NativeInput<"carryFinish">, signal?: AbortSignal): Promise<HostOutput<"carryFinish">> {
  const { worktree, tree, paths } = input;
  const top = await topLevel(worktree, signal);
  const fm = await fileModeOf(top, signal);
  const mark = await carryMarkOf(worktree, signal);
  const log = carryLog(mark);
  const written = [...new Set(paths)];
  const deleted = [...log.values()].flatMap((intent) => ("d" in intent && !written.includes(intent.d) ? [intent.d] : []));
  const foreign = new Set<string>(await foreignStaged(top, mark, fm));
  for (const path of written) {
    const intent = log.get(path);
    if (intent === undefined || !("w" in intent) || stateAt(top, path, fm) !== intent.post) foreign.add(path);
  }
  const replaced = (path: string) => written.some(file => path.startsWith(file + "/") || file.startsWith(path + "/"));
  for (const path of deleted) if (stateAt(top, path, fm) !== null && !replaced(path)) foreign.add(path);
  if (foreign.size > 0) return { outcome: "foreign", paths: [...foreign].sort() };

  const parent = await git(top, ["rev-parse", "--verify", "HEAD"], { signal });
  const carried = readCarryMark(mark);
  if (carried === null || parent !== carried.from) throw new HostError("carry-head-changed", "The member HEAD changed after the carry started; preserve and reconcile before retrying.");
  writeCarryMark(mark, { ...carried, committing: { parent, tree } });
  const sparse = context.endpoint.inspection!.sparse;
  const removed = deleted.filter(path => !replaced(path));
  const staged = [...new Set([...written, ...(sparse ? [] : removed)])];
  const unstaged = [...new Set([...written, ...removed])];
  if (sparse) for (let at = 0; at < unstaged.length; at += PATH_BATCH) await git(top, ["rm", "--cached", "--sparse", "--ignore-unmatch", "--", ...unstaged.slice(at, at + PATH_BATCH)], { signal, env: LITERAL, timeoutMs: 300_000 });
  for (let at = 0; at < staged.length; at += PATH_BATCH) await git(top, ["add", "-A", ...(sparse ? ["--sparse"] : []), "--", ...staged.slice(at, at + PATH_BATCH)], { signal, env: LITERAL, timeoutMs: 300_000 });
  carryFaults.beforeCommit?.();
  if ((await stagedPaths(top, signal)).length > 0) {
    await git(top, ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "user.name=Tavern", "-c", "user.email=tavern@localhost", "commit", "--no-verify", "--no-gpg-sign", "-q", "-m", "Tavern carried snapshot"], { signal, env: { GIT_AUTHOR_NAME: "Tavern", GIT_AUTHOR_EMAIL: "tavern@localhost" }, timeoutMs: 300_000 });
  }
  carryFaults.afterCommit?.();
  const head = await git(top, ["rev-parse", "--verify", "HEAD"], { signal });
  const built = await git(top, ["rev-parse", "--verify", head + "^{tree}"], { signal });
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
