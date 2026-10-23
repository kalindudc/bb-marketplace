// Small pieces the Planner page's parts share: who did a step, and when.
import { Avatar } from "./ticket-cards";

export type Actor = "you" | "planner" | "loom" | "reviewer";

const NAMES: Record<Actor, string> = { you: "You", planner: "The planner", loom: "Loom", reviewer: "Loom's spec reviewer" };
const KINDS = { you: "human", planner: "planner", loom: "loom", reviewer: "reviewer" } as const;

/** The ticket page's avatar for the one who did a step, with its name for screen readers. */
export function ActorMark({ actor }: { actor: Actor }) {
  return (
    <span data-actor={actor} title={NAMES[actor]} className="inline-flex shrink-0">
      <Avatar kind={KINDS[actor]} />
      <span className="sr-only">{NAMES[actor]}</span>
    </span>
  );
}

export const PlannerMark = () => <ActorMark actor="planner" />;

/** "15:19" today, "Oct 23 15:19" another day. */
export function timeLabel(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === date.toDateString() ? time : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
