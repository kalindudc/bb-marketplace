// The scheduler as pure functions over plain data: no store, no bb, no clock.
import type { ThreadRow, TicketRow } from "./db/store";
import { globsOverlap, type Spec } from "./spec";
import { startsOn } from "./stack";
import type { TicketState } from "./states";

export interface TicketLite {
  id: number;
  key: string;
  state: TicketState;
  priority: number;
  seq: number;
  deps: string[];
  scope: string[];
  /** The ticket's [[repo]] name, or null for the Loom project's own repository. Scopes only collide within one repo. */
  repo: string | null;
  /** Loom pushed a commit to its pull request, so a stacked dependent may start on it. */
  pushed: boolean;
  /** Its worker holds a worker slot: it runs a turn Loom gave it, or is about to (working, checking, or writing its pull request). */
  holds: boolean;
  /** When work for its worker began waiting for a free worker slot; null when none waits. */
  waitsSince: number | null;
}

/** A message to the worker is plain text, or a short summary the human sees and detail only the agent reads. */
export type WorkerMessage = string | { summary: string; detail: string };

/**
 * HandBack: work going back to a ticket's worker (a pull request's fix round, a review's changes, a merge that did not
 * land), stored with the ticket's move to working and sent after it, so a failed send or a restart sends it again.
 */
export interface HandBack {
  /** The worker thread it goes to. */
  thread: string;
  text: WorkerMessage;
  /** When it began waiting for a free worker slot; absent once it has one. */
  waiting?: number;
  /** The ticket says it waits for a slot. */
  noticed?: boolean;
}

const parse = <T>(json: string | null): T | null => (json === null ? null : (JSON.parse(json) as T));
export const handBackOf = (ticket: Pick<TicketRow, "handback_json">): HandBack | null => parse<HandBack>(ticket.handback_json);

/** Work for the ticket's worker waits for a free worker slot. */
export const waitsForSlot = (ticket: Pick<TicketRow, "state" | "handback_json">): boolean => ticket.state === "working" && handBackOf(ticket)?.waiting !== undefined;

/** Loom asked the approved ticket's worker for its pull request's text at this head, and it is not in yet, so the worker is writing it. */
function writingPr(ticket: Pick<TicketRow, "head_sha" | "pr_ask_json" | "pr_text_json">): boolean {
  const ask = parse<{ head: string }>(ticket.pr_ask_json);
  return ask !== null && ask.head === ticket.head_sha && parse<{ head: string }>(ticket.pr_text_json)?.head !== ticket.head_sha;
}

/** States in which a ticket holds its scope: someone is still working on, checking, reviewing or merging its files. */
export const IN_FLIGHT: readonly TicketState[] = ["working", "checking", "review", "approved", "merging", "pr_open"];

export function toLite(row: TicketRow): TicketLite {
  const waitsSince = waitsForSlot(row) ? handBackOf(row)!.waiting! : null;
  const holds = row.state === "checking" || (row.state === "working" && waitsSince === null) || (row.state === "approved" && writingPr(row));
  return { id: row.id, key: row.key, state: row.state, priority: row.priority, seq: row.seq, deps: JSON.parse(row.deps_json) as string[], scope: JSON.parse(row.scope_json) as string[], repo: row.repo, pushed: row.pushed_sha !== null, holds, waitsSince };
}

/** True when any glob of `a` can match a path a glob of `b` matches. */
export const overlaps = (a: readonly string[], b: readonly string[]) => a.some((left) => b.some((right) => globsOverlap(left, right)));

/** The keys of the tickets a dependent may start on: the done ones, and with `stack` those whose pull request is open. */
export function startable(tickets: readonly TicketLite[], stack: boolean): Set<string> {
  return new Set(tickets.filter((ticket) => startsOn(ticket, stack)).map((ticket) => ticket.key));
}

/**
 * Queued tickets whose dependencies are done (or, with `stack`, have an open pull request) and whose scope clears every
 * ticket in flight and every earlier pick in the same repo, in pick order (priority 0 first, then seq).
 */
export function readyTickets(tickets: readonly TicketLite[], stack = false): TicketLite[] {
  const done = startable(tickets, stack);
  const held = tickets.filter((ticket) => IN_FLIGHT.includes(ticket.state));
  const queued = tickets.filter((ticket) => ticket.state === "queued").sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  const kin = stack ? kinship(tickets) : () => false;
  const picked: TicketLite[] = [];
  for (const ticket of queued) {
    if (!ticket.deps.every((key) => done.has(key))) continue;
    if (held.some((other) => other.repo === ticket.repo && !kin(other, ticket) && overlaps(other.scope, ticket.scope))) continue;
    picked.push(ticket);
    held.push(ticket);
  }
  return picked;
}

/**
 * Whether one ticket depends on the other, directly or through others. A stacked ticket builds on its dependencies'
 * branches, so its scope may overlap theirs while they are in flight, and theirs may overlap its own.
 */
export function kinship(tickets: readonly TicketLite[]): (a: TicketLite, b: TicketLite) => boolean {
  const deps = new Map(tickets.map((ticket) => [ticket.key, ticket.deps]));
  const ancestors = new Map<string, Set<string>>();
  const of = (key: string): Set<string> => {
    const known = ancestors.get(key);
    if (known !== undefined) return known;
    const found = new Set<string>();
    ancestors.set(key, found);
    for (const dep of deps.get(key) ?? []) {
      found.add(dep);
      for (const further of of(dep)) found.add(further);
    }
    return found;
  };
  return (a, b) => of(a.key).has(b.key) || of(b.key).has(a.key);
}

/** The tickets a spawn may claim now: the ready ones, less those `waiting` holds back, that fit in the worker slots left for new work, in pick order. */
export function spawnable(maxWorkers: number, tickets: readonly TicketLite[], waiting: (ticket: TicketLite) => boolean = () => false, stack = false, parked: ReadonlySet<number> = NONE): TicketLite[] {
  return readyTickets(tickets, stack)
    .filter((ticket) => !waiting(ticket))
    .slice(0, workerSlots(maxWorkers, tickets, parked));
}

const NONE: ReadonlySet<number> = new Set();

/**
 * Threads that wait for the human hold no slot: the ids of the tickets whose worker does, and of the reviewer rows that
 * do. Their work is not being done, so others may run in their place.
 */
export interface Parked {
  workers: ReadonlySet<number>;
  reviewers: ReadonlySet<number>;
}

export const NOT_PARKED: Parked = { workers: NONE, reviewers: NONE };

/**
 * The worker slots no worker holds. A worker holds one while it runs a turn Loom gave it, or is about to; one that waits
 * in review or on an open pull request, or for the human (`parked`, ticket ids), holds a worktree but no slot.
 */
export function freeWorkerSlots(maxWorkers: number, tickets: readonly TicketLite[], parked: ReadonlySet<number> = NONE): number {
  return Math.max(0, maxWorkers - tickets.filter((ticket) => ticket.holds && !parked.has(ticket.id)).length);
}

/** The worker slots new work may take: the free ones, less those the work already waiting for a slot takes first. */
export function workerSlots(maxWorkers: number, tickets: readonly TicketLite[], parked: ReadonlySet<number> = NONE): number {
  return Math.max(0, freeWorkerSlots(maxWorkers, tickets, parked) - tickets.filter((ticket) => ticket.waitsSince !== null).length);
}

/** The tickets whose waiting work takes a free worker slot now: priority 0 first, then the longest waiting. */
export function slotTurns(maxWorkers: number, tickets: readonly TicketLite[], parked: ReadonlySet<number> = NONE): TicketLite[] {
  return tickets
    .filter((ticket) => ticket.waitsSince !== null)
    .sort((a, b) => a.priority - b.priority || a.waitsSince! - b.waitsSince! || a.seq - b.seq)
    .slice(0, freeWorkerSlots(maxWorkers, tickets, parked));
}

/** The reviewer slots no reviewer holds: a reviewer starting or running holds one, unless it waits for the human (`parked`, row ids). */
export function freeReviewerSlots(maxReviewers: number, rows: ReadonlyArray<Pick<ThreadRow, "id" | "role" | "state">>, parked: ReadonlySet<number> = NONE): number {
  return Math.max(0, maxReviewers - rows.filter((row) => row.role === "reviewer" && (row.state === "spawning" || row.state === "active") && !parked.has(row.id)).length);
}

/** `idleCount` is the number of idles already seen: the first idle gets a nudge, the next ones end the worker. */
export function idleAction(idleCount: number): "nudge" | "abandon" {
  return idleCount === 0 ? "nudge" : "abandon";
}

const DAY_MS = 86_400_000;

/** Why the project must pause, or null. The deadline date counts as a whole day: it passes when that day is over. */
export function budgetReason(spec: Spec, tokens: number, now: number): string | null {
  const { max_tokens: maxTokens, deadline } = spec.budget;
  if (maxTokens !== undefined && tokens >= maxTokens) return `The token budget is used up: ${tokens} of ${maxTokens} tokens.`;
  if (deadline !== undefined && now >= Date.parse(`${deadline}T00:00:00Z`) + DAY_MS) return `The deadline ${deadline} has passed.`;
  return null;
}

/** Whether a project's pause reason is one of budgetReason's, which a new spec version can lift. */
export const isBudgetPause = (reason: string | null): boolean => reason !== null && (/^The token budget is used up: \d+ of \d+ tokens\.$/u.test(reason) || /^The deadline \S+ has passed\.$/u.test(reason));
