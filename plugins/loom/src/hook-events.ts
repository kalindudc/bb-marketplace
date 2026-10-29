// The project events a spec's [[hook]] can follow, in the order they happen, with no imports so the page can read them too.
export const HOOK_EVENTS = ["spec.approved", "project.started", "ticket.started", "pr.opened", "ticket.blocked", "ticket.done", "project.done"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Each event as the page and the docs say it, after "when". */
export const HOOK_EVENT_NAMES: Readonly<Record<HookEvent, string>> = {
  "spec.approved": "the human approves a spec version",
  "project.started": "the human starts the project",
  "ticket.started": "a worker starts on a ticket",
  "pr.opened": "Loom opens a pull request",
  "ticket.blocked": "a ticket is blocked",
  "ticket.done": "a ticket is done",
  "project.done": "the project is done",
};
