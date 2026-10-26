import { experimental_useSidebarThreads, type ExperimentalBadge } from "@get-bb/plugin-sdk/app";
import type { BadgeView } from "../contract";
import { useLoom } from "./common";

// bb puts the panel's title before it, as in "Loom, 3 things need you".
const labelOf = (count: number) => (count === 1 ? "1 thing needs you" : `${count} things need you`);

/** The rail badge for `view` with `waiting` of its threads waiting on the human: red while a ticket is blocked, amber otherwise, none when nothing needs you. */
export function badgeOf(view: BadgeView, waiting: number): ExperimentalBadge | null {
  const count = view.needsYou + waiting;
  if (count === 0) return null;
  return { count, tone: view.blocked ? "critical" : "warning", label: labelOf(count) };
}

/** Loom's rail badge: the server's Needs you count, plus the Loom threads bb's own thread state shows waiting on a question or an approval. */
export function useLoomBadge(): ExperimentalBadge | null {
  const view = useLoom("badge", null).data;
  const { threads } = experimental_useSidebarThreads();
  if (view === undefined) return null;
  const ids = new Set(view.threadIds);
  return badgeOf(view, threads.filter((thread) => thread.hasPendingInteraction && ids.has(thread.id)).length);
}
