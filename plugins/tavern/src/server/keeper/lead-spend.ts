import type { KeeperStore } from "./store";

export function projectLeadSpendSubtree(store: Pick<KeeperStore, "leadLinksBy">, rootQuestId: string): string[] {
  const quests = new Set([rootQuestId]);
  for (const id of quests)
    for (const link of store.leadLinksBy("parentQuestId", id))
      if (link.childQuestId) quests.add(link.childQuestId);
  return [...quests];
}
