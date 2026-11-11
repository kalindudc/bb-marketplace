// The human's acknowledgement of a tab badge Loom cannot clear by itself, recorded as an ackBadge human.action event
// with the items the badge counted then. The page hides the badge while every item it counts is among them, so a new
// item brings it back, and the state survives a reload and a restart with no table of its own.
import type { ProjectRow, Store } from "./db/store";
import type { MergeOrderView } from "./merge-order";
import type { RolloutView, RolloutWarning } from "./rollout";

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

// What the Merge order and Rollout badges count, for the project's tabs and Home's queue alike.

/** A pull request that merged into the branch of a ticket that has not merged, so its change is not on the base. */
export const wrongMerges = (mergeOrder: MergeOrderView | null) => (mergeOrder?.entries ?? []).filter((entry) => entry.verdict === "merged_elsewhere" && entry.mergedIntoState !== "done");

/** The rollout warnings that call for care before a merge or a deploy; info-tone ones are left to the tab. */
export const rolloutWarnings = (rollout: RolloutView | null) => (rollout?.warnings ?? []).filter((warning) => warning.tone === "warning");

/** A warning's identity for an acknowledgement: its text names what is particular to it, such as a freeze window's title and dates, so two warnings of one kind on one ticket differ. */
export const warningId = (warning: RolloutWarning) => `${warning.kind}:${warning.keys.join(",")}:${warning.text}`;

/** Whether the human's newest acknowledgement covers every item: a new item shows the badge again, one that went away does not. */
export const acknowledged = (acked: readonly string[], items: readonly string[]) => items.length > 0 && items.every((item) => acked.includes(item));
