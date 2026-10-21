// One plain sentence per event kind. The CLI's `feed` command and the page both use it.
import type { EventRow } from "./db/store";

const WHO: Record<string, string> = { human: "The human", planner: "The planner", worker: "A worker", reviewer: "A reviewer", loom: "Loom" };
const text = (value: unknown) => (typeof value === "string" ? value : null);
const num = (value: unknown) => (typeof value === "number" ? value : null);
const notesLabel = (notes: unknown) => {
  const count = Array.isArray(notes) ? notes.length : 0;
  return count === 1 ? "1 note" : `${count} notes`;
};

function moveReason(from: string, to: string, data: Record<string, unknown>): string | null {
  const reason = text(data.reason);
  if (reason !== null) return /[.!?]$/u.test(reason) ? reason : `${reason}.`;
  if (from === "review" && to === "working" && num(data.round) !== null) return `changes requested in round ${data.round}.`;
  if (to === "working" && num(data.checkFailures) !== null) return `the checks failed (${data.checkFailures} so far).`;
  if (to === "working" && num(data.attempt) !== null) return `attempt ${data.attempt}.`;
  if (to === "review" && num(data.round) !== null) return `the checks passed, round ${data.round}.`;
  if (to === "approved" && num(data.round) !== null) return `approved in round ${data.round}.`;
  if (to === "pr_open" && text(data.url) !== null) return `${data.url}.`;
  if (data.requeued === true) return "requeued.";
  return null;
}

/** `keys` maps a ticket id to its key. */
export function feedText(event: EventRow, keys: Map<number, string>): string {
  const data = JSON.parse(event.data_json) as Record<string, unknown>;
  const key = event.ticket_id === null ? "A ticket" : (keys.get(event.ticket_id) ?? `Ticket ${event.ticket_id}`);
  switch (event.kind) {
    case "project.created":
      return "The project was created.";
    case "project.state": {
      const reason = text(data.reason);
      return `The project moved from ${data.from} to ${data.to}${reason === null ? "." : `: ${reason}`}`;
    }
    case "project.landed":
      return `The integration branch was landed: ${data.url}.`;
    case "spec.proposed":
      return `Spec version ${data.version} was proposed.`;
    case "spec.revised":
      return `Spec version ${data.version} was revised.`;
    case "spec.approved":
      return `Spec version ${data.version} was approved.`;
    case "ticket.created":
      return `${key} was created.`;
    case "ticket.edited":
      return `${key} was edited: ${Array.isArray(data.fields) ? data.fields.join(", ") : "its fields"}.`;
    case "ticket.state": {
      const why = moveReason(String(data.from), String(data.to), data);
      return `${key} moved from ${data.from} to ${data.to}${why === null ? "." : `: ${why}`}`;
    }
    case "post.added":
      return `${WHO[String(data.author)] ?? "Someone"} added a ${data.kind} to ${key}.`;
    case "review.verdict":
      return data.verdict === "approved" ? `A reviewer approved ${key} in round ${data.round}.` : `A reviewer asked for changes on ${key} in round ${data.round}.`;
    case "turn.retry":
      return `${key}'s worker hit a rate limit; retry ${data.attempt} is scheduled.`;
    case "human.action": {
      if (data.action === "notes") return `The human sent ${notesLabel(data.notes)} on the spec to the planner.`;
      const target = text(data.key);
      return `The human ran ${data.action}${target === null ? "" : ` on ${target}`}.`;
    }
    default:
      return `${event.kind} by ${event.actor}.`;
  }
}
