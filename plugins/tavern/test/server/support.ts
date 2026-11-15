import type { JournalPort } from "../../src/server/ports";
import type { Keeper } from "../../src/server/keeper/service";
import { journalEntrySchema } from "../../src/shared/schema";

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
    linkedEntries: () => [],
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
