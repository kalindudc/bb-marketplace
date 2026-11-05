// The human's acknowledgement of a tab badge Loom cannot clear by itself, recorded as an ackBadge human.action event
// with the items the badge counted then. The page hides the badge while every item it counts is among them, so a new
// item brings it back, and the state survives a reload and a restart with no table of its own.
import type { ProjectRow, Store } from "./db/store";

/** The tabs whose badge the human can acknowledge: what they count is advice Loom cannot see the human act on. */
export const ACK_TABS = ["merge", "rollout"] as const;
export type AckTab = (typeof ACK_TABS)[number];
export type BadgeAcks = Record<AckTab, string[]>;

export const noAcks = (): BadgeAcks => ({ merge: [], rollout: [] });

/** The items of each tab's newest acknowledgement; an empty list for a tab never acknowledged. */
export function badgeAcksOf(store: Store, project: ProjectRow): BadgeAcks {
  const acks = noAcks();
  for (const event of store.eventsOfKind(project.id, "human.action")) {
    const data = JSON.parse(event.data_json) as { action?: string; tab?: string; items?: unknown };
    if (data.action !== "ackBadge" || !ACK_TABS.includes(data.tab as AckTab) || !Array.isArray(data.items)) continue;
    acks[data.tab as AckTab] = data.items.map(String);
  }
  return acks;
}
