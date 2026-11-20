import type { JournalChange, JournalEntry } from "../../shared/schema";
import { journalActionText } from "../../shared/journal-action-text";
export const MAX_NOTE_TEXT = 4096;
export function clip(text: string, limit: number): string {
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  return `${Buffer.from(text).subarray(0, limit - 3).toString("utf8").replace(/\uFFFD$/, "")}...`;
}
const verbs: Record<string, string> = { add: "added", split: "split", add_step: "split", done: "ticked", toggle: "ticked", start: "started", reopen: "reopened", block: "blocked", verify: "verified", reject: "rejected", update: "updated", note: "noted", link: "linked", delete: "deleted", clear: "cleared", reorder: "reordered", reparent: "reparented", undo: "undid", redo: "redid" };
export function changeSummary(action: string, ids: string[], before: JournalEntry[], after: JournalEntry[]): string {
  const shown = ids.slice(0, 10).map(id => {
    const entry = after.find(e => e.id === id) ?? before.find(e => e.id === id);
    return `[${id}] ${JSON.stringify(clip(entry?.description ?? "entry", 60))}${after.find(e => e.id === id) ? ` ${entry!.status}` : ""}`;
  });
  return clip(`${verbs[action] ?? action} ${shown.join("; ")}${ids.length > shown.length ? `; and ${ids.length - shown.length} more` : ""}.`, 1000);
}
export function formatUserChanges(changes: JournalChange[], nameOf: (threadId: string) => string | undefined): string {
  if (!changes.length) return "";
  const shown: string[] = [];
  let bytes = 180;
  for (const c of [...changes].reverse()) {
    const action = journalActionText(c);
    const text = c.actor.kind === "user" ? `The user ${action}`
      : c.actor.kind === "tavern" ? `Tavern ${action}`
      : c.actor.kind === "agent" ? `${nameOf(c.actor.threadId) ?? `Agent ${c.actor.threadId}`} ${action}`
      : action.replace(/^You /, "The user ");
    const line = `- ${text.replaceAll("\n", "\n  ")}`;
    if (bytes + Buffer.byteLength(line) > 2800) break;
    bytes += Buffer.byteLength(line); shown.unshift(line);
  }
  return `Your journal changed since your last call:\n${shown.join("\n")}${changes.length > shown.length ? `\n- and ${changes.length - shown.length} earlier changes` : ""}\n\n`;
}
