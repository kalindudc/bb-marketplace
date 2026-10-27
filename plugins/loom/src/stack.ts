// Stacked pull requests on the pr strategy, as pure functions over ticket rows. A ticket starts once its dependencies'
// pull requests are open, on top of their commits when they are in its repo. Loom keeps its branch up to date as those
// pull requests change and merge, opens its pull request on its one open dependency's branch, or on the base branch once
// they merged, and holds the pull request while two or more are open, since a pull request builds on one branch.
import type { TicketRow } from "./db/store";
import { prSettings } from "./repos";
import type { Spec } from "./spec";
import type { TicketState } from "./states";

export interface Stack {
  /** The pull request commit of each dependency in the ticket's repo that its branch contains, by ticket key. */
  deps: Record<string, string>;
  /** The commit the ticket's own changes are measured against; null for the repo's fresh base. */
  base: string | null;
  /** When the ticket's branch last took the repo's base branch: its first start, or Loom's last merge of the base into it. */
  synced: number;
  /** The pull request commit of each dependency in another repo that the worker knows of, by ticket key. */
  cross: Record<string, string>;
  /** Dependencies' commits that conflicted with each other, by ticket key, so the ticket waits until one of them changes. */
  conflict?: { on: Record<string, string>; files: string[] };
  /** The hold last posted on the ticket, so each hold is posted once. */
  held?: string;
  /** Files Loom carried to the worker's machine with conflict markers, which a submit may not keep. */
  markers?: string[];
}

export const EMPTY_STACK: Stack = { deps: {}, base: null, synced: 0, cross: {} };

/** Whether the project stacks pull requests: the pr strategy, unless the spec sets merge.stack = false. */
export const stacking = (spec: Spec) => spec.merge.strategy === "pr" && prSettings(spec).stack;

export const stackOf = (ticket: Pick<TicketRow, "stack_json">): Stack | null => (ticket.stack_json === null ? null : (JSON.parse(ticket.stack_json) as Stack));

/** The local branch Loom points at the commit a stacked ticket starts from or merges in. */
export const stackBranch = (slug: string, key: string) => `loom/${slug}/${key.toLowerCase()}-stack`;

/** A dependency a ticket may start on: merged, or, when the project stacks, its pull request open with a commit Loom pushed. */
export function startsOn(dep: { state: TicketState; pushed: boolean }, stack: boolean): boolean {
  return dep.state === "done" || (stack && dep.pushed && dep.state !== "blocked" && dep.state !== "cancelled");
}

export interface Upstream {
  /** Dependencies in the ticket's repo that have not merged, in depends_on order. */
  open: TicketRow[];
  /** Dependencies in the ticket's repo that merged. */
  merged: TicketRow[];
  /** Dependencies in other repos. */
  cross: TicketRow[];
}

const finished = (ticket: TicketRow) => ticket.state === "done" || ticket.state === "cancelled";

export function upstreamOf(tickets: readonly TicketRow[], ticket: TicketRow): Upstream {
  const byKey = new Map(tickets.map((row) => [row.key, row]));
  const deps = (JSON.parse(ticket.deps_json) as string[]).flatMap((key) => byKey.get(key) ?? []);
  const same = deps.filter((dep) => dep.repo === ticket.repo && dep.state !== "cancelled");
  return { open: same.filter((dep) => dep.state !== "done"), merged: same.filter((dep) => dep.state === "done"), cross: deps.filter((dep) => dep.repo !== ticket.repo) };
}

// A dependent whose pull request opens on `of`'s branch carries work merged into the base branch after `of` last took it,
// which the pull request would show as its own until `of` takes the base branch too.
function lagsFor(tickets: readonly TicketRow[], of: TicketRow, dependent: TicketRow): boolean {
  const up = upstreamOf(tickets, dependent);
  const synced = stackOf(of)?.synced ?? 0;
  return up.open.length === 1 && up.open[0]!.id === of.id && up.merged.some((dep) => dep.state_at > synced);
}

/** Whether a dependent stacked on this ticket waits for its branch to take the base branch. */
export function syncWanted(tickets: readonly TicketRow[], ticket: TicketRow): boolean {
  if (finished(ticket) || ticket.pushed_sha === null) return false;
  return tickets.some((other) => other.repo === ticket.repo && !finished(other) && stackOf(other)?.deps[ticket.key] !== undefined && lagsFor(tickets, ticket, other));
}

export type Hold = { why: "merge" | "push" | "sync"; keys: string[] };

/** Why a ticket's pull request may not open yet: two or more open dependencies in its repo, one with no pull request, or one that must take the base branch first. */
export function holdOf(tickets: readonly TicketRow[], ticket: TicketRow): Hold | null {
  const { open } = upstreamOf(tickets, ticket);
  if (open.length >= 2) return { why: "merge", keys: open.map((dep) => dep.key) };
  const only = open[0];
  if (only === undefined) return null;
  if (only.pushed_sha === null) return { why: "push", keys: [only.key] };
  return lagsFor(tickets, only, ticket) ? { why: "sync", keys: [only.key] } : null;
}

export const holdKey = (hold: Hold) => `${hold.why}:${hold.keys.join(",")}`;

/** What a ticket's branch must take to be up to date: each open dependency's newest pull request commit, and the base branch's tip when one merged or a dependent waits for it. */
export interface Restack {
  deps: Record<string, string>;
  commits: string[];
  withBase: boolean;
}

export function restackOf(tickets: readonly TicketRow[], ticket: TicketRow): Restack | null {
  if (finished(ticket) || ticket.state === "blocked") return null;
  const stack = stackOf(ticket);
  const up = upstreamOf(tickets, ticket);
  const open = up.open.filter((dep) => dep.pushed_sha !== null);
  const deps = Object.fromEntries(open.map((dep) => [dep.key, dep.pushed_sha!]));
  if (stack?.conflict !== undefined && sameCommits(stack.conflict.on, deps)) return null;
  const changed = stack !== null && open.some((dep) => stack.deps[dep.key] !== dep.pushed_sha);
  const merged = stack !== null && up.merged.some((dep) => stack.deps[dep.key] !== undefined);
  const sync = syncWanted(tickets, ticket);
  if (!changed && !merged && !sync) return null;
  return { deps, commits: open.map((dep) => dep.pushed_sha!), withBase: merged || sync };
}

const sameCommits = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

/** A stacked start that conflicted waits while its dependencies' commits are the ones that conflicted. */
export function conflictWaits(tickets: readonly TicketRow[], ticket: TicketRow): boolean {
  const conflict = stackOf(ticket)?.conflict;
  if (conflict === undefined) return false;
  const open = upstreamOf(tickets, ticket).open.filter((dep) => dep.pushed_sha !== null);
  return sameCommits(conflict.on, Object.fromEntries(open.map((dep) => [dep.key, dep.pushed_sha!])));
}

/** The branch a ticket's pull request builds on: its one open dependency's pull request branch, else the repo's base. */
export function prBaseOf(tickets: readonly TicketRow[], ticket: TicketRow, base: string): string {
  const { open } = upstreamOf(tickets, ticket);
  return open.length === 1 && open[0]!.pr_branch !== null ? open[0]!.pr_branch : base;
}
