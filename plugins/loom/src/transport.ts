// Carrying a ticket's work between the project's checkout and a thread on another machine. A thread whose environment
// is on the checkout's machine shares its git objects, so nothing moves. Any other thread's commit moves through Loom's
// host entry as its changed files, never through a provider's sync, and lands only when its tree is the one it left with.
// A machine only ever gets linear commits: a stacked ticket's history there is the fresh base, one commit with the tree
// of the commit it is stacked on, then its own work, and work brought home is rebuilt on the commit it is stacked on.
import { randomBytes } from "node:crypto";
import { repoCheckout } from "./checkouts";
import type { ProjectRow, TicketRow } from "./db/store";
import { threadBranch } from "./environments";
import { BLOB_MAX_BYTES, CHUNK_BYTES, type HostOutput } from "./host-contract";
import type { EnvironmentInfo } from "./ports";
import { freshBaseOf, gitNetwork } from "./repos";
import type { Spec } from "./spec";
import { stackOf } from "./stack";
import type { EngineCtx } from "./workers";

/** The branch on the project's checkout with the newest work Loom brought home from the ticket's workers. */
export const homeBranch = (slug: string, key: string) => threadBranch(slug, key, "home");
/** The ref that keeps the commit a ticket was submitted at, its head_sha, from being collected. */
export const reviewedRef = (slug: string, key: string) => `refs/loom/${slug}/${key.toLowerCase()}/reviewed`;

/** Whether the ticket's head came home from another machine: its reviewed ref is at the head. */
export async function headCameHome(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow): Promise<boolean> {
  if (ticket.head_sha === null) return false;
  const checkout = await repoCheckout(ctx, project, spec, ticket.repo);
  const reviewed = await ctx.host.call(checkout.hostId, "refTip", { repo: checkout.path, ref: reviewedRef(project.slug, ticket.key) });
  return reviewed.outcome === "ok" && reviewed.sha === ticket.head_sha;
}

/** Whether the environment is on another machine than the project's checkout. */
export const isRemote = (project: Pick<ProjectRow, "host_id">, environment: Pick<EnvironmentInfo, "hostId">): boolean => project.host_id !== null && environment.hostId !== project.host_id;

/**
 * The base to measure a thread's worktree against: the commit its ticket is stacked on, or the fresh base, which is all
 * a thread on another machine has, since the commit it is stacked on exists only on the project's checkout.
 */
export const worktreeBaseOf = (project: Pick<ProjectRow, "host_id">, spec: Spec, ticket: Pick<TicketRow, "repo" | "stack_json">, environment: Pick<EnvironmentInfo, "hostId">): string =>
  (isRemote(project, environment) ? null : stackOf(ticket)?.base) ?? freshBaseOf(spec, ticket.repo);

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
  const stacked = stackOf(ticket)?.base ?? null;
  const made = await ctx.host.call(checkout.hostId, "importCommit", { repo: checkout.path, remote, baseBranch, base: exported.base, tree: exported.tree, message: exported.message, author: exported.author, entries, refs, ...(stacked === null ? {} : { parent: stacked }), ...gitNetwork(checkout.settings) });
  if (made.outcome === "unavailable") throw new Error(made.message);
  if (made.outcome === "mismatch") throw new Error(`the commit Loom rebuilt on the project's machine has the tree ${made.tree.slice(0, 12)}, not the worker's ${exported.tree.slice(0, 12)}`);
  return { sha: made.sha, tree: exported.tree, copied: true };
}

/**
 * Puts the commit `sha` of the project's checkout in a thread's worktree: on the checkout's machine by checking it out
 * detached, and on another machine with worktree commands alone, on its merge base with the repo's base: as one commit
 * with its tree, or for a stacked ticket whose `sha` builds on the commit it is stacked on, as one commit with that
 * commit's tree and one more with its own. `replaces` is a tree the checkout keeps, which the worktree may drop. Throws
 * when the tree in the worktree is not the commit's.
 */
export async function carryTo(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, sha: string, environment: EnvironmentInfo, opts: { replaces?: string } = {}): Promise<{ tree: string }> {
  const worktree = worktreeOf(environment);
  if (!isRemote(project, environment)) return { tree: (await ctx.host.call(environment.hostId, "detach", { worktree, sha })).tree };
  const checkout = await repoCheckout(ctx, project, spec, ticket.repo);
  const fresh = freshBaseOf(spec, ticket.repo);
  const exportOf = (base: string, head: string): Promise<Exported> => ctx.host.call(checkout.hostId, "exportChanges", { worktree: checkout.path, base, head });
  const stacked = stackOf(ticket)?.base ?? null;
  let steps = [await exportOf(fresh, sha)];
  if (stacked !== null && stacked !== sha) {
    const own = await exportOf(stacked, sha);
    if (own.base === stacked) steps = [await exportOf(fresh, stacked), own];
  }
  const start = steps[0]!.base;
  const tree = steps.at(-1)!.tree;
  const started = await ctx.host.call(environment.hostId, "carryStart", { worktree, remote: checkout.settings.remote, baseBranch: checkout.settings.base, base: start, tree, ...(opts.replaces === undefined ? {} : { replaces: opts.replaces }), ...gitNetwork(checkout.settings) });
  if (started.outcome === "unavailable") throw new Error(started.message);
  if (started.present) return { tree };
  let finished;
  try {
    for (const exported of steps) {
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
      finished = await ctx.host.call(environment.hostId, "carryFinish", { worktree, base: start, message: exported.message, author: exported.author, tree: exported.tree, paths: written });
      if (finished.outcome === "mismatch") throw new Error(`the worktree had the tree ${finished.tree.slice(0, 12)}, not ${exported.tree.slice(0, 12)}, after Loom put the work in, so Loom reset it to the base`);
    }
  } catch (error) {
    // The first error says what went wrong; one from the reset would hide it.
    await ctx.host.call(environment.hostId, "carryAbort", { worktree, base: start }).catch(() => undefined);
    throw error;
  }
  return { tree: finished!.tree };
}
