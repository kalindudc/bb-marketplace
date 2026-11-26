import type { JournalPort } from "../../src/server/ports";
import type { Keeper } from "../../src/server/keeper/service";
import { journalEntrySchema } from "../../src/shared/schema";

import { stampWaypoint } from "../../src/server/keeper/waypoint-journal";

export function waypointEntry(threadId: string, boardQuestId: string, waypointId = "w1", id = "a1") {
  return journalEntrySchema.parse({
    threadId, id, description: "Build the checked work", parentId: null,
    status: "done", owner: threadId, order: 0, note: null,
    evidence: [{ kind: "command", ref: "npm test", detail: "Checks passed", exitCode: 0 }],
    link: { boardQuestId, waypointId }, createdAt: 1_000_000, updatedAt: 1_000_000,
    createdBy: { kind: "agent", threadId }, updatedBy: { kind: "agent", threadId },
  });
}
export function fakePort(): JournalPort {
  let readLinks: JournalPort["linkedEntries"] = () => [];
  const changed = new Map<string, { before: string; after: ReturnType<typeof waypointEntry> }>();
  const added: ReturnType<typeof waypointEntry>[] = [];
  let syntheticId = 0;
  const undo = new Map<string, (() => void)[]>();
  const key = ({ threadId, id }: ReturnType<typeof waypointEntry>) => `${threadId}:${id}`;
  return {
    prepare: async () => {},
    exportMarkdown: async () => "",
    rebriefed: () => {},
    syncBoardQuests: () => {},
    get: (threadId) => ({
      threadId,
      entries: [],
      changes: [],
      progress: { done: 0, total: 0, current: null, blocked: 0 },
      canUndo: false,
      canRedo: false,
      toolOwnedElsewhere: false,
    }),
    progress: () => ({ done: 0, total: 0, current: null, blocked: 0 }),
    edit: () => ({ message: "edited" }),
    linkWaypoint: () => "a1",
    get linkedEntries() { return (questId: string) => [...readLinks(questId).map(row => {
      const stamp = changed.get(key(row));
      return stamp?.before === JSON.stringify(row) ? stamp.after : row;
    }), ...added.filter(row => row.link?.boardQuestId === questId)]; },
    set linkedEntries(read) { readLinks = read; },
    recordWaypoint(receipt) {
      const { entries, kind, link, keeperThreadId, ref, at } = receipt;
      const operations: (() => void)[] = [];
      const selected = entries.length ? entries : [journalEntrySchema.parse({
        ...waypointEntry(keeperThreadId, link.boardQuestId, link.waypointId, `k${(syntheticId++).toString(36)}`), status: "todo",
        evidence: [], createdAt: at, updatedAt: at,
      })];
      for (const entry of selected) {
        const after = structuredClone(entry);
        stampWaypoint(after, receipt);
        const index = added.findIndex(item => key(item) === key(entry));
        if (!entries.length || index >= 0) {
          if (index >= 0) added[index] = after; else added.push(after);
          operations.push(() => {
            const at = added.indexOf(after);
            if (at >= 0) { if (index >= 0) added[at] = entry; else added.splice(at, 1); }
          });
        } else {
          const id = key(entry), previous = changed.get(id);
          changed.set(id, { before: previous?.before ?? JSON.stringify(entry), after });
          operations.push(() => {
            if (changed.get(id)?.after === after) { if (previous) changed.set(id, previous); else changed.delete(id); }
          });
        }
      }
      if (kind === "keeper" || kind === "keeper-waypoint" || kind === "skip" || kind === "reopen") undo.set(ref, operations);
    },
    undoWaypoint(ref) {
      const operations = undo.get(ref);
      if (!operations) return false;
      for (const undoCall of operations) undoCall();
      undo.delete(ref);
      return true;
    },
    openSummary: () => "No open entries.",
    instructions: () => "Use journal.",
    dispatchCheck: () => null,
    onChange: () => () => {},
  };
}
export async function seedQuest(keeper: Keeper, threadId: string, title: string, short: string) {
  keeper.receiveUser(threadId, title);
  keeper.route(threadId, { kind: "new-quest", summary: title, notes: [] });
  return keeper.openQuest(threadId, title, short);
}
export function putQuestFixture(store: import("../../src/server/keeper/store").KeeperStore, id: string, quest: import("../../src/shared/schema").BoardQuest) {
  store.writeRecords("INSERT INTO tavern_records(kind,id,data,archived_at) VALUES('quests',?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,archived_at=excluded.archived_at", id, JSON.stringify(quest), quest.archivedAt ?? null);
  return quest;
}
export async function concludeQuest(runtime: import("../../src/server/runtime").TavernRuntime, threadId: string, id: string, outcome: string, left: string,
  skips: { waypointId: string; reason: string }[] = [], next?: string[], results?: import("../../src/shared/tale-results").TaleResults) {
  const quest = runtime.keeper.quest(id);
  if (quest.phase === "done") return { pendingArchives: (await runtime.proposeWrap(threadId, id, outcome, left, next, results)).pendingArchives };
  if (quest.phase === "greenlight") runtime.keeper.answerAsk(runtime.keeper.store.openAsks(threadId, id).find(ask => ask.kind === "greenlight")!.id, "approve", null, "page", "user");
  for (const skip of skips) runtime.keeper.settle(threadId, { boardQuestId: id, as: "skipped", ...skip });
  const ask = await runtime.proposeWrap(threadId, id, outcome, left, next, results);
  return runtime.answerAsk(ask.askId!, "conclude", null, "page", true);
}
export function planInput(boardQuestId: string) {
  return {
    boardQuestId,
    goal: "A thin goal",
    doneWhen: "Tests pass",
    findings: [],
    assumptions: [],
    questions: [],
    waypoints: [
      {
        id: "w1",
        title: "Build",
        actor: "agent" as const,
        owner: "smith",
        leadTime: null,
        dependsOn: [],
        doneWhen: "Tests pass",
        optional: false,
      },
    ],
    party: [],
    reviewLoad: "One review",
    eta: null,
    changeNote: null,
  };
}
