import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isNotFound } from "./host-errors";
import { execGitSync } from "../shared/git-safety";
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

function git(root: string, args: string[]): string {
  return execGitSync(root, args, {
    encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
}
function optional(root: string, args: string[]): string | null {
  try { return git(root, args); }
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

function dirtySubmodules(root: string): string[] {
  const configs: string[] = [];
  for (const { args, blob } of submoduleConfigReads(root)) {
    try {
      configs.push(execGitSync(root, args, { readOnly: true, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }));
    } catch (error) {
      const failure = error as { status?: number; stderr?: string | Buffer };
      if (!missingSubmoduleConfig(blob, failure.status, failure.stderr?.toString() ?? "")) throw error;
    }
  }
  return populatedSubmodules(root, configs)
    .filter(module => git(module.root, ["status", "--porcelain", "-z"]).length > 0 || dirtySubmodules(module.root).length > 0)
    .map(module => module.path);
}

/** Read a worktree's Git state. Throws when the path is not a usable repository. */
export function worktreeState(root: string): WorktreeState {
  const status = git(root, ["status", "--porcelain"]);
  const nested = dirtySubmodules(root);
  const mergeHead = git(root, ["rev-parse", "--git-path", "MERGE_HEAD"]).trim();
  return {
    branch: optional(root, ["symbolic-ref", "--short", "-q", "HEAD"])?.trim() || null,
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    tree: git(root, ["rev-parse", "HEAD^{tree}"]).trim(),
    dirty: status.trim().length > 0 || nested.length > 0,
    changed: [...new Set([...status.split("\n").filter(Boolean).map(line => line.slice(3)), ...nested])],
    ...(nested.length ? { dirtySubmodules: nested } : {}),
    unfinishedMerge: existsSync(resolve(root, mergeHead)),
  };
}

/** Commit everything in a worktree, returning the resulting head. */
export function commitWorktree(root: string, subject: string): { sha: string; committed: boolean } {
  git(root, ["add", "-A"]);
  const staged = optional(root, ["diff", "--cached", "--quiet"]);
  const identity = (optional(root, ["config", "user.email"])?.trim() ?? "") ? [] : ["-c", "user.name=Tavern", "-c", "user.email=tavern@localhost"];
  if (staged === null) git(root, [...identity, "commit", "--no-verify", "--no-gpg-sign", "-q", "-m", subject]);
  return { sha: git(root, ["rev-parse", "HEAD"]).trim(), committed: staged === null };
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

export function preserveWorktree(root: string): PreserveResult {
  // A checkout that is missing or holds nothing can lose nothing, so cleanup may proceed on it.
  if (!existsSync(root)) return { status: "none" };
  try { if (readdirSync(root).length === 0) return { status: "none" }; }
  catch (error) { return { status: "deferred", root, error: `cannot read the member worktree: ${message(error)}` }; }
  let state: WorktreeState;
  try { state = worktreeState(root); }
  catch (error) { return { status: "deferred", root, error: `cannot read the member worktree: ${message(error)}` }; }
  if (!state.dirty) return { status: "clean", root };
  if (state.dirtySubmodules?.length) return { status: "deferred", root, error: "a submodule still has uncommitted work: " + state.dirtySubmodules[0] };
  if (state.unfinishedMerge) return { status: "deferred", root, error: "the member worktree has an unfinished merge; commit or resolve it before cleanup" };
  let sha: string;
  try { sha = commitWorktree(root, PRESERVE_MESSAGE).sha; }
  catch (error) { return { status: "deferred", root, error: `cannot commit the member's uncommitted work: ${message(error)}` }; }
  try {
    const after = worktreeState(root);
    if (after.dirty) return { status: "deferred", root, error: "the member worktree is still dirty after preserving its work" };
  } catch (error) { return { status: "deferred", root, error: `cannot confirm the preserved worktree: ${message(error)}` }; }
  return { status: "committed", root, sha, changed: state.changed };
}
