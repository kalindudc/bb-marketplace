import type { Actor, JournalChange, JournalEntry } from "../../shared/schema";
export const MAX_NOTE_TEXT = 4096;
export function clip(text: string, limit: number): string {
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  return `${Buffer.from(text).subarray(0, limit - 3).toString("utf8").replace(/\uFFFD$/, "")}...`;
}
const verbs: Record<string, string> = { add: "added", split: "split", add_step: "split", done: "ticked", toggle: "ticked", start: "started", reopen: "reopened", block: "blocked", verify: "verified", reject: "rejected", update: "updated", note: "noted", link: "linked", delete: "deleted", clear: "cleared", reorder: "reordered", reparent: "reparented", undo: "undid", redo: "redid" };
export function changeSummary(actor: Actor, action: string, ids: string[], before: JournalEntry[], after: JournalEntry[]): string {
  const who = actor.kind === "agent" ? `Agent ${actor.threadId}` : actor.kind === "user" ? "You" : actor.kind === "import" ? "Import" : "Tavern";
  const shown = ids.slice(0, 10).map(id => {
    const entry = after.find(e => e.id === id) ?? before.find(e => e.id === id);
    return `[${id}] ${JSON.stringify(clip(entry?.description ?? "entry", 60))}${after.find(e => e.id === id) ? ` ${entry!.status}` : ""}`;
  });
  return clip(`${who} ${verbs[action] ?? action} ${shown.join("; ")}${ids.length > shown.length ? `; and ${ids.length - shown.length} more` : ""}.`, 1000);
}
export function formatUserChanges(changes: JournalChange[]): string {
  if (!changes.length) return "";
  const shown: string[] = [];
  let bytes = 180;
  for (const c of [...changes].reverse()) {
    const line = `- ${c.text.replace(/^You\b/, "The user").replaceAll("\n", "\n  ")}`;
    if (bytes + Buffer.byteLength(line) > 2800) break;
    bytes += Buffer.byteLength(line); shown.unshift(line);
  }
  return `The user changed the journal (or a Warden reviewed it):\n${shown.join("\n")}${changes.length > shown.length ? `\n- and ${changes.length - shown.length} earlier changes` : ""}\n\n`;
}
