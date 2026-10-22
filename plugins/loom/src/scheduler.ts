// The scheduler as pure functions over plain data: no store, no bb, no clock.
import type { TicketRow } from "./db/store";
import { globsOverlap, type Spec } from "./spec";
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
}

/** States in which a ticket holds its scope: someone is still working on, checking, reviewing or merging its files. */
export const IN_FLIGHT: readonly TicketState[] = ["working", "checking", "review", "approved", "merging", "pr_open"];

export function toLite(row: TicketRow): TicketLite {
  return { id: row.id, key: row.key, state: row.state, priority: row.priority, seq: row.seq, deps: JSON.parse(row.deps_json) as string[], scope: JSON.parse(row.scope_json) as string[], repo: row.repo };
}

/** True when any glob of `a` can match a path a glob of `b` matches. */
export const overlaps = (a: readonly string[], b: readonly string[]) => a.some((left) => b.some((right) => globsOverlap(left, right)));

/**
 * Queued tickets whose dependencies are done and whose scope clears every ticket in flight and every earlier pick in
 * the same repo, in pick order (priority 0 first, then seq).
 */
export function readyTickets(tickets: readonly TicketLite[]): TicketLite[] {
  const done = new Set(tickets.filter((ticket) => ticket.state === "done").map((ticket) => ticket.key));
  const held = tickets.filter((ticket) => IN_FLIGHT.includes(ticket.state));
  const queued = tickets.filter((ticket) => ticket.state === "queued").sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  const picked: TicketLite[] = [];
  for (const ticket of queued) {
    if (!ticket.deps.every((key) => done.has(key))) continue;
    if (held.some((other) => other.repo === ticket.repo && overlaps(other.scope, ticket.scope))) continue;
    picked.push(ticket);
    held.push(ticket);
  }
  return picked;
}

/** The tickets a spawn may claim now: the ready ones, less those `waiting` holds back, that fit in the free worker slots, in pick order. */
export function spawnable(maxWorkers: number, tickets: readonly TicketLite[], waiting: (ticket: TicketLite) => boolean = () => false): TicketLite[] {
  return readyTickets(tickets)
    .filter((ticket) => !waiting(ticket))
    .slice(0, workerSlots(maxWorkers, tickets));
}

/** Workers waiting in review hold a worktree but no slot. */
export function workerSlots(maxWorkers: number, tickets: readonly TicketLite[]): number {
  return Math.max(0, maxWorkers - tickets.filter((ticket) => ticket.state === "working" || ticket.state === "checking").length);
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
