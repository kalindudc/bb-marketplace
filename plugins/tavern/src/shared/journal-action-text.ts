import type { JournalChange } from "./schema";

export function journalActionText({ action, actor, text }: Pick<JournalChange, "action" | "actor" | "text">): string {
  if (actor.kind === "import") return text;
  const phase = "Board quest phases refreshed:";
  if (action === "board-phase" && actor.kind === "tavern" && text.startsWith(phase)) {
    return "refreshed board quest phases:" + text.slice(phase.length);
  }
  if (action === "link" && text.startsWith("Tavern assigned ")) return text.slice("Tavern ".length);
  const prefix = actor.kind === "tavern" ? "Tavern " : actor.kind === "user" ? "You " : `Agent ${actor.threadId} `;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}
