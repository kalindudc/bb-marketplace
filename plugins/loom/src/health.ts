// A project's health strip as one pure function over its rows, its metrics and its approved spec.
import type { ThreadRow, TicketRow } from "./db/store";
import type { ProjectMetrics } from "./metrics";
import { readyTickets, toLite, workerSlots } from "./scheduler";
import type { Spec } from "./spec";
import { stacking } from "./stack";

export interface ProjectHealth {
  progress: { done: number; total: number; inFlight: number; blocked: number; queued: number };
  /** perHour is null when the project did not run in the window; etaMs is running time, and null without a pace. */
  pace: { perHour: number | null; remaining: number; etaMs: number | null };
  budget: { used: number; max: number } | null;
  deadline: { date: string; daysLeft: number } | null;
  capacity: { workers: number; maxWorkers: number; reviewers: number; maxReviewers: number; readyWaiting: number };
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Pace is the tickets done in the metrics' throughput window over the time the project ran in it, so a project younger
 * than the window, or one paused for part of it, is not paced by days it did not run. The deadline day counts until it
 * is over, as budgetReason pauses.
 */
export function projectHealth(a: { tickets: TicketRow[]; threads: ThreadRow[]; metrics: ProjectMetrics; spec: Spec; now: number }): ProjectHealth {
  const { tickets, metrics, spec } = a;
  const count = (state: TicketRow["state"]) => tickets.filter((ticket) => ticket.state === state).length;
  const done = count("done");
  const total = tickets.length - count("cancelled");
  const doneInWindow = metrics.throughput.reduce((sum, day) => sum + day.done, 0);
  const perHour = metrics.windowActiveMs === 0 ? null : doneInWindow / (metrics.windowActiveMs / HOUR_MS);
  const remaining = total - done;
  const { max_tokens: maxTokens, deadline } = spec.budget;
  const { max_workers: maxWorkers, max_reviewers: maxReviewers } = spec.agents;
  const lites = tickets.map(toLite);
  return {
    progress: { done, total, inFlight: metrics.wip, blocked: count("blocked"), queued: count("queued") },
    pace: { perHour, remaining, etaMs: perHour === null || perHour === 0 ? null : (remaining / perHour) * HOUR_MS },
    budget: maxTokens === undefined ? null : { used: metrics.tokens.total, max: maxTokens },
    deadline: deadline === undefined ? null : { date: deadline, daysLeft: Math.ceil((Date.parse(`${deadline}T00:00:00Z`) + DAY_MS - a.now) / DAY_MS) },
    capacity: {
      workers: count("working") + count("checking"),
      maxWorkers,
      reviewers: a.threads.filter((thread) => thread.role === "reviewer" && (thread.state === "spawning" || thread.state === "active")).length,
      maxReviewers,
      readyWaiting: Math.max(0, readyTickets(lites, stacking(spec)).length - workerSlots(maxWorkers, lites)),
    },
  };
}
