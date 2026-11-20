import type { BoardQuestMirror } from "../ports";
import type { JournalEntry } from "../../shared/schema";
import { clip } from "./text";
import { waiverLine } from "../../shared/closing";
import { copy, validateEntries } from "./engine";

export function boardMirrors(entries: JournalEntry[], quests: readonly BoardQuestMirror[], now: number): JournalEntry[] {
  const next = copy(entries);
  for (const entry of next) {
    const quest = entry.boardQuestId ? quests.find(q => q.id === entry.boardQuestId) : quests.find(q =>
      entry.createdBy.kind === "agent" && entry.createdBy.threadId === entry.threadId && (entry.description.startsWith("Board quest: ") || entry.description.startsWith("Quest: ")) && entry.description.endsWith(` (${q.id})`));
    if (!quest) continue;
    const done = quest.phase === "done";
    const stopped = quest.phase === "stopped" || quest.phase === "stopping";
    const fields = {
      boardQuestId: quest.id,
      description: clip(`Quest: ${quest.title}`, 500),
      status: done ? "done" as const : stopped ? "blocked" as const : "todo" as const,
      parentId: null,
      note: stopped ? `Board quest phase: ${quest.phase}. ${quest.phase === "stopping" ? "Tavern is confirming that every member has stopped." : "Stopped by you, not finished."}`
        : done && quest.outcome === "closed-early"
          ? `Board quest phase: done. Closed early at your request: ${quest.waivers?.map(waiverLine).join("; ")}.`
          : done && quest.outcome === "concluded" ? "Board quest phase: done. Concluded." : `Board quest phase: ${quest.phase}. This entry mirrors the board; use tavern_wrap to finish it.`,

      doneAt: done ? quest.endedAt ?? quest.updatedAt : null,
      doneBy: done ? {kind:"tavern" as const} : null,
      review: null,
      link: null,
    };
    if (Object.entries(fields).some(([key, value]) => JSON.stringify(entry[key as keyof JournalEntry]) !== JSON.stringify(value))) {
      Object.assign(entry, fields, {updatedAt:now,updatedBy:{kind:"tavern"}});
    }
  }
  const mirrors = new Set(next.filter(e => e.boardQuestId).map(e => e.id));
  for (const entry of next) if (entry.parentId && mirrors.has(entry.parentId)) {
    entry.parentId = null; entry.updatedAt = now; entry.updatedBy = {kind:"tavern"};
  }
  return validateEntries(next);
}

export function mirrorHistory(entries: JournalEntry[], current: JournalEntry[]): JournalEntry[] {
  const mirrors = new Map(current.filter(e => e.boardQuestId).map(e => [e.id, e]));
  return validateEntries(entries.map(entry => mirrors.has(entry.id) ? copy(mirrors.get(entry.id)!) :
    entry.parentId && mirrors.has(entry.parentId) ? {...entry,parentId:null} : entry));
}
