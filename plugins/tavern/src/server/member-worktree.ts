import { existsSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isNotFound } from "./host-errors";
import { execGit } from "./exec-git";
import { missingSubmoduleConfig, populatedSubmodules, submoduleConfigReads } from "../shared/submodules";

/** The subject a preservation commit carries, so the user can find it later. */
export const PRESERVE_MESSAGE = "tavern: preserve uncommitted member work before cleanup";

export interface MemberWorktree { environmentId: string; hostId: string; root: string }

export interface WorktreeState {
  branch: string | null;
  head: string;
  tree: string;
  dirty: boolean;
  changed: string[];
  dirtySubmodules?: string[];
  unfinishedMerge: boolean;
}

export type PreserveResult =
  | { status: "none" }
  | { status: "clean"; root: string }
  | { status: "committed"; root: string; sha: string; changed: string[] }
  | { status: "deferred"; root: string; error: string };

function git(root: string, args: string[]): Promise<string> {
  return execGit(root, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
}
async function optional(root: string, args: string[]): Promise<string | null> {
  try { return await git(root, args); }
  catch { return null; }
}
function message(error: unknown): string {
  const stderr = (error as { stderr?: string | Buffer }).stderr;
  const text = stderr === undefined ? "" : String(stderr).trim();
  return (text || String((error as Error).message ?? error)).slice(0, 500);
}

/** Resolve a member thread's own linked worktree when it lives on this server. */
export async function memberWorktree(
  bb: Pick<BbPluginApi, "sdk">,
  threadId: string,
): Promise<MemberWorktree | null> {
  const thread = await bb.sdk.threads.get({ threadId }).catch(error => {
    // A thread that is already gone has no work to preserve; any other failure must be retried, not swallowed.
    if (isNotFound(error)) return null;
    throw error;
  });
  if (!thread) return null;
  if (!thread.environmentId) return null;
  const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
  if (!environment || !environment.isWorktree || !environment.path) return null;
  const config = await bb.sdk.system.config();
  // A member on another machine keeps its worktree there; Tavern cannot read or commit it from here.
  if (environment.hostId !== config.primaryHostId) return null;
  return { environmentId: environment.id, hostId: environment.hostId, root: environment.path };
}

async function dirtySubmodules(root: string): Promise<string[]> {
  const configs: string[] = [];
  for (const { args, blob } of submoduleConfigReads(root)) {
    try {
      configs.push(await execGit(root, args, { readOnly: true, encoding: "utf8", timeout: 15_000 }));
    } catch (error) {
      const failure = error as { code?: number | string; stderr?: string | Buffer };
      if (!missingSubmoduleConfig(blob, typeof failure.code === "number" ? failure.code : null, failure.stderr?.toString() ?? "")) throw error;
    }
  }
  const dirty: string[] = [];
  for (const module of populatedSubmodules(root, configs)) {
    if ((await git(module.root, ["status", "--porcelain", "-z"])).length || (await dirtySubmodules(module.root)).length) dirty.push(module.path);
  }
  return dirty;
}

/** Read a worktree's Git state. Throws when the path is not a usable repository. */
export async function worktreeState(root: string): Promise<WorktreeState> {
  const status = await git(root, ["status", "--porcelain"]);
  const nested = await dirtySubmodules(root);
  const revisions = (await git(root, ["rev-parse", "--git-path", "MERGE_HEAD", "HEAD", "HEAD^{tree}"])).trimEnd().split("\n");
  const tree = revisions.pop()!, head = revisions.pop()!;
  const mergeHead = revisions.join("\n").trim();
  return {
    branch: (await optional(root, ["symbolic-ref", "--short", "-q", "HEAD"]))?.trim() || null,
    head,
    tree,
    dirty: status.trim().length > 0 || nested.length > 0,
    changed: [...new Set([...status.split("\n").filter(Boolean).map(line => line.slice(3)), ...nested])],
    ...(nested.length ? { dirtySubmodules: nested } : {}),
    unfinishedMerge: existsSync(resolve(root, mergeHead)),
  };
}

/** Commit everything in a worktree, returning the resulting head. */
export async function commitWorktree(root: string, subject: string): Promise<{ sha: string; committed: boolean }> {
  await git(root, ["add", "-A"]);
  const staged = await optional(root, ["diff", "--cached", "--quiet"]);
  const identity = (await optional(root, ["config", "user.email"]))?.trim() ? [] : ["-c", "user.name=Tavern", "-c", "user.email=tavern@localhost"];
  if (staged === null) await git(root, [...identity, "commit", "--no-verify", "--no-gpg-sign", "-q", "-m", subject]);
  return { sha: (await git(root, ["rev-parse", "HEAD"])).trim(), committed: staged === null };
}

/**
 * Keep a member's uncommitted files alive across the cleanup that follows archiving.
 * Anything this cannot prove safe is deferred, never discarded.
 */
export async function preserveMemberWork(bb: Pick<BbPluginApi, "sdk">, threadId: string): Promise<PreserveResult> {
  let worktree: MemberWorktree | null;
  try { worktree = await memberWorktree(bb, threadId); }
  catch (error) { return { status: "deferred", root: "", error: `cannot resolve the member worktree: ${message(error)}` }; }
  if (!worktree) return { status: "none" };
  return preserveWorktree(worktree.root);
}

function worktreeKey(root: string): string {
  try { return realpathSync(root); }
  catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    return resolve(root);
  }
}

const worktreeQueue = new Map<string, Promise<unknown>>();
async function queueWorktree<T>(root: string, run: () => Promise<T>): Promise<T> {
  const key = worktreeKey(root);
  const previous = worktreeQueue.get(key);
  // A report must not read the checkout between preservation's status and commit.
  const next = previous ? previous.then(run, run) : run();
  worktreeQueue.set(key, next);
  try { return await next; }
  finally { if (worktreeQueue.get(key) === next) worktreeQueue.delete(key); }
}

export function readWorktree(root: string): Promise<WorktreeState> {
  return queueWorktree(root, () => worktreeState(root));
}

export async function preserveWorktree(root: string): Promise<PreserveResult> {
  try { return await queueWorktree(root, () => preserveCheckout(root)); }
  catch (error) { return { status: "deferred", root, error: `cannot read the member worktree: ${message(error)}` }; }
}

async function preserveCheckout(root: string): Promise<PreserveResult> {
  // A checkout that is missing or holds nothing can lose nothing, so cleanup may proceed on it.
  if (!existsSync(root)) return { status: "none" };
  try { if (readdirSync(root).length === 0) return { status: "none" }; }
  catch (error) { return { status: "deferred", root, error: `cannot read the member worktree: ${message(error)}` }; }
  let state: WorktreeState;
  try { state = await worktreeState(root); }
  catch (error) { return { status: "deferred", root, error: `cannot read the member worktree: ${message(error)}` }; }
  if (!state.dirty) return { status: "clean", root };
  if (state.dirtySubmodules?.length) return { status: "deferred", root, error: "a submodule still has uncommitted work: " + state.dirtySubmodules[0] };
  if (state.unfinishedMerge) return { status: "deferred", root, error: "the member worktree has an unfinished merge; commit or resolve it before cleanup" };
  let sha: string;
  try { sha = (await commitWorktree(root, PRESERVE_MESSAGE)).sha; }
  catch (error) { return { status: "deferred", root, error: `cannot commit the member's uncommitted work: ${message(error)}` }; }
  try {
    const after = await worktreeState(root);
    if (after.dirty) return { status: "deferred", root, error: "the member worktree is still dirty after preserving its work" };
  } catch (error) { return { status: "deferred", root, error: `cannot confirm the preserved worktree: ${message(error)}` }; }
  return { status: "committed", root, sha, changed: state.changed };
}
