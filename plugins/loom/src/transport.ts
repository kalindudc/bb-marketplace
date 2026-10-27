// Carrying a ticket's work between the project's checkout and a thread on another machine. A thread whose environment
// is on the checkout's machine shares its git objects, so nothing moves. Any other thread's commit moves through Loom's
// host entry as its changed files, never through a provider's sync, and lands only when its tree is the one it left with.
import { randomBytes } from "node:crypto";
import { repoCheckout } from "./checkouts";
import type { ProjectRow, TicketRow } from "./db/store";
import { threadBranch } from "./environments";
import { BLOB_MAX_BYTES, CHUNK_BYTES, type HostOutput } from "./host-contract";
import type { EnvironmentInfo } from "./ports";
import { freshBaseOf } from "./repos";
import type { Spec } from "./spec";
import type { EngineCtx } from "./workers";

/** The branch on the project's checkout with the newest work Loom brought home from the ticket's workers. */
export const homeBranch = (slug: string, key: string) => threadBranch(slug, key, "home");
/** The ref that keeps the commit a ticket was submitted at, its head_sha, from being collected. */
export const reviewedRef = (slug: string, key: string) => `refs/loom/${slug}/${key.toLowerCase()}/reviewed`;

/** Whether the environment is on another machine than the project's checkout. */
export const isRemote = (project: Pick<ProjectRow, "host_id">, environment: Pick<EnvironmentInfo, "hostId">): boolean => project.host_id !== null && environment.hostId !== project.host_id;

type Exported = HostOutput<"exportChanges">;

/** The offsets of a file's ranges: one for an empty file. */
function offsets(size: number): number[] {
  const found = [0];
  for (let offset = CHUNK_BYTES; offset < size; offset += CHUNK_BYTES) found.push(offset);
  return found;
}

const worktreeOf = (environment: EnvironmentInfo): string => {
  if (environment.path === null) throw new Error("the thread's worktree is not available");
  return environment.path;
};

/**
 * The worker's commit on the project's checkout: rebuilt there from the files it changed on its own machine, as one
 * commit on the same base, on the ticket's home branch, and for a submit on its reviewed ref too. A worker on the
 * checkout's machine copies nothing; its HEAD is already there. A submit's commit must have `checked`, the tree the
 * checks passed.
 */
export async function bringHome(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, environment: EnvironmentInfo, kind: "submit" | "wip", checked?: string): Promise<{ sha: string; tree: string; copied: boolean }> {
  const worktree = worktreeOf(environment);
  const base = freshBaseOf(spec, ticket.repo);
  if (!isRemote(project, environment)) {
    const state = await ctx.host.call(environment.hostId, "worktreeState", { worktree, base });
    return { sha: state.head, tree: state.tree, copied: false };
  }
  const checkout = await repoCheckout(ctx, project, spec, ticket.repo);
  const exported = await ctx.host.call(environment.hostId, "exportChanges", { worktree, base });
  if (checked !== undefined && exported.tree !== checked) throw new Error(`the worktree changed after the checks passed: its tree is ${exported.tree.slice(0, 12)}, not the checked ${checked.slice(0, 12)}`);
  const big = exported.changes.find((change) => (change.size ?? 0) > BLOB_MAX_BYTES);
  if (big !== undefined) throw new Error(`${big.path} is ${Math.ceil(big.size! / 1024 / 1024)} MiB, and files over ${BLOB_MAX_BYTES / 1024 / 1024} MiB can't move between machines`);
  const entries = [];
  const sent = new Set<string>();
  // Per transfer: a WIP save and a submit of one ticket can run at once.
  const transfer = randomBytes(4).toString("hex");
  try {
    for (const change of exported.changes) {
      if (change.status === "D") {
        entries.push({ path: change.path, delete: true as const });
        continue;
      }
      const upload = `${ticket.key.toLowerCase()}-${transfer}-${change.blob!}`;
      entries.push({ path: change.path, mode: change.mode!, upload });
      if (sent.has(upload)) continue;
      sent.add(upload);
      for (const offset of offsets(change.size!)) {
        const { data } = await ctx.host.call(environment.hostId, "readBlob", { repo: worktree, sha: change.blob!, offset, length: Math.min(CHUNK_BYTES, change.size! - offset) });
        await ctx.host.call(checkout.hostId, "importChunk", { upload, offset, data });
      }
    }
  } catch (error) {
    // The first error says what went wrong; one from the clean-up would hide it.
    await ctx.host.call(checkout.hostId, "dropUploads", { uploads: [...sent] }).catch(() => undefined);
    throw error;
  }
  const refs = [`refs/heads/${homeBranch(project.slug, ticket.key)}`, ...(kind === "submit" ? [reviewedRef(project.slug, ticket.key)] : [])];
  const { remote, base: baseBranch } = checkout.settings;
  const made = await ctx.host.call(checkout.hostId, "importCommit", { repo: checkout.path, remote, baseBranch, base: exported.base, tree: exported.tree, message: exported.message, author: exported.author, entries, refs });
  if (made.outcome === "unavailable") throw new Error(made.message);
  if (made.outcome === "mismatch") throw new Error(`the commit Loom rebuilt on the project's machine has the tree ${made.tree.slice(0, 12)}, not the worker's ${exported.tree.slice(0, 12)}`);
  return { sha: made.sha, tree: exported.tree, copied: true };
}

/**
 * Puts the commit `sha` of the project's checkout in a thread's worktree: on the checkout's machine by checking it out
 * detached, and on another machine as one commit with its tree on its merge base with the repo's base, made with
 * worktree commands alone. Throws when the tree in the worktree is not the commit's.
 */
export async function carryTo(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, sha: string, environment: EnvironmentInfo): Promise<{ tree: string }> {
  const worktree = worktreeOf(environment);
  if (!isRemote(project, environment)) return { tree: (await ctx.host.call(environment.hostId, "detach", { worktree, sha })).tree };
  const checkout = await repoCheckout(ctx, project, spec, ticket.repo);
  const exported: Exported = await ctx.host.call(checkout.hostId, "exportChanges", { worktree: checkout.path, base: freshBaseOf(spec, ticket.repo), head: sha });
  const started = await ctx.host.call(environment.hostId, "carryStart", { worktree, remote: checkout.settings.remote, baseBranch: checkout.settings.base, base: exported.base, tree: exported.tree });
  if (started.outcome === "unavailable") throw new Error(started.message);
  if (started.present) return { tree: exported.tree };
  let finished;
  try {
    const deleted = exported.changes.filter((change) => change.status === "D").map((change) => change.path);
    if (deleted.length > 0) await ctx.host.call(environment.hostId, "carryDelete", { worktree, paths: deleted });
    for (const change of exported.changes) {
      if (change.status === "D") continue;
      for (const offset of offsets(change.size!)) {
        const { data } = await ctx.host.call(checkout.hostId, "readBlob", { repo: checkout.path, sha: change.blob!, offset, length: Math.min(CHUNK_BYTES, change.size! - offset) });
        await ctx.host.call(environment.hostId, "carryWrite", { worktree, path: change.path, mode: change.mode!, offset, data });
      }
    }
    const written = exported.changes.filter((change) => change.status !== "D").map((change) => change.path);
    finished = await ctx.host.call(environment.hostId, "carryFinish", { worktree, base: exported.base, message: exported.message, author: exported.author, tree: exported.tree, paths: written });
  } catch (error) {
    // The first error says what went wrong; one from the reset would hide it.
    await ctx.host.call(environment.hostId, "carryAbort", { worktree, base: exported.base }).catch(() => undefined);
    throw error;
  }
  if (finished.outcome === "mismatch") throw new Error(`the worktree had the tree ${finished.tree.slice(0, 12)}, not ${exported.tree.slice(0, 12)}, after Loom put the work in, so Loom reset it to the base`);
  return { tree: finished.tree };
}
