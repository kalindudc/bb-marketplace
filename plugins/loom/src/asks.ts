// What the planner asks the human to do, recorded with loom_ask_human as a planner.asked event. Each call replaces the
// asks before it. Whether a step is done is read from the events that follow, so the page never stores a checkmark.
import type { EventRow, ProjectRow, Store } from "./db/store";
import { LoomError, landsOf, repoOverviews } from "./projects";
import type { Spec } from "./spec";

export const ASK_ACTIONS = ["approve", "requeue", "start", "resume", "land", "reply", "other"] as const;
export type AskAction = (typeof ASK_ACTIONS)[number];

export interface AskStep {
  action: AskAction;
  /** For approve: the version that waits for approval. */
  version?: number;
  /** For requeue and reply: the ticket. */
  key?: string;
  /** One sentence the human reads: what to do and why. */
  text: string;
}

export interface PlannerAsk {
  /** The planner.asked event. */
  id: number;
  at: number;
  why: string;
  steps: Array<AskStep & { done: boolean }>;
  /** A step is not done yet; an ask of only `other` steps stays open until the human dismisses it. */
  open: boolean;
}

interface AskData {
  why: string;
  steps: AskStep[];
}

/** Refuses a step the human could not take now: a version that does not wait, a ticket of another project, a start that is behind. */
function stepError(store: Store, project: ProjectRow, step: AskStep, index: number): string | null {
  const at = `steps[${index}]`;
  switch (step.action) {
    case "approve": {
      const waiting = project.state === "draft" ? store.latestSpecVersion(project.id)!.version : project.state === "archived" ? null : project.pending_version;
      if (step.version === undefined) return `${at}: approve needs the version.`;
      if (waiting === null) return `${at}: no spec version of ${project.slug} waits for approval. Propose one with loom_propose first.`;
      return step.version === waiting ? null : `${at}: v${step.version} does not wait for approval; v${waiting} does.`;
    }
    case "requeue":
    case "reply": {
      if (step.key === undefined) return `${at}: ${step.action} needs the ticket key.`;
      const ticket = store.ticketByKey(step.key);
      return ticket !== null && ticket.project_id === project.id ? null : `${at}: ${project.slug} has no ticket ${step.key}. Use loom_board to see the keys.`;
    }
    case "start":
      return project.state === "draft" || project.state === "ready" ? null : `${at}: ${project.slug} is ${project.state}, so there is nothing to start.`;
    case "resume":
      return project.state === "paused" ? null : `${at}: ${project.slug} is ${project.state}, not paused.`;
    case "land":
      return project.state === "draft" || project.state === "archived" ? `${at}: ${project.slug} is ${project.state}, so there is nothing to land.` : null;
    case "other":
      return null;
  }
}

/** Records the planner's asks, replacing the ones before; no steps clears them. */
export function recordAsk(store: Store, project: ProjectRow, actor: string, data: AskData): void {
  const errors = data.steps.flatMap((step, index) => stepError(store, project, step, index) ?? []);
  if (errors.length > 0) throw new LoomError("loom_invalid_input", `Nothing recorded. Fix these and call loom_ask_human again:\n${errors.map((error, n) => `${n + 1}. ${error}`).join("\n")}`);
  const steps = data.steps.map(({ action, version, key, text }) => ({ action, ...(version === undefined ? {} : { version }), ...(key === undefined ? {} : { key }), text: text.trim() }));
  store.event(project.id, null, "planner.asked", actor, { why: data.why.trim(), steps });
}

const moved = (event: EventRow, from: string, to: string) => {
  const data = JSON.parse(event.data_json) as { from?: string; to?: string };
  return data.from === from && data.to === to;
};

/** Whether the human took the step after the ask, read from the events that follow it, so a later change does not undo it. */
function stepDone(store: Store, project: ProjectRow, later: readonly EventRow[], step: AskStep): boolean {
  switch (step.action) {
    case "approve":
      return project.approved_version !== null && project.approved_version >= step.version!;
    case "requeue": {
      const ticket = store.ticketByKey(step.key!);
      if (ticket === null) return false;
      if (ticket.state === "done" || ticket.state === "cancelled") return true;
      return later.some((event) => event.kind === "ticket.state" && event.ticket_id === ticket.id && (JSON.parse(event.data_json) as { from?: string }).from === "blocked");
    }
    case "reply": {
      const ticket = store.ticketByKey(step.key!);
      return ticket !== null && later.some((event) => event.kind === "post.added" && event.ticket_id === ticket.id && (JSON.parse(event.data_json) as { author?: string }).author === "human");
    }
    case "start":
      return later.some((event) => event.kind === "project.state" && moved(event, "ready", "running"));
    case "resume":
      return later.some((event) => event.kind === "project.state" && moved(event, "paused", "running"));
    case "land": {
      // A land of one repo of several, or one that failed part way, leaves the ask open while a repo still has work to land.
      if (!later.some((event) => event.kind === "project.landed") || project.approved_version === null) return false;
      const spec = JSON.parse(store.specVersion(project.id, project.approved_version)!.spec_json) as Spec;
      return !repoOverviews(project, spec, store.tickets(project.id), landsOf(store.eventsOfKind(project.id, "project.landed"))).some((repo) => repo.toLand);
    }
    case "other":
      return false;
  }
}

/** The planner's newest asks with each step's state, or null when it has none, cleared them, or the human dismissed them. */
export function plannerAsk(store: Store, project: ProjectRow): PlannerAsk | null {
  const ask = store.eventsOfKind(project.id, "planner.asked").at(-1);
  if (ask === undefined) return null;
  const data = JSON.parse(ask.data_json) as AskData;
  if (data.steps.length === 0) return null;
  const later = store.events(project.id, ask.id, 100_000);
  const dismissed = later.some((event) => {
    if (event.kind !== "human.action") return false;
    const action = JSON.parse(event.data_json) as { action?: string; ask?: number };
    return action.action === "dismissAsk" && action.ask === ask.id;
  });
  if (dismissed) return null;
  const steps = data.steps.map((step) => ({ ...step, done: stepDone(store, project, later, step) }));
  return { id: ask.id, at: ask.at, why: data.why, steps, open: steps.some((step) => !step.done) };
}

/** The human sets the asks aside, for example once they did an `other` step; the planner's next asks show again. */
export function dismissAsk(store: Store, project: ProjectRow, id: number): void {
  const current = plannerAsk(store, project);
  if (current === null || current.id !== id) throw new LoomError("loom_invalid_state", "These asks are no longer the planner's newest. Reload the page.");
}
