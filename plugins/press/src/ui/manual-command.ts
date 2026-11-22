export function isCompactDraft(draft: { text: string; attachments: readonly unknown[]; mentions: readonly unknown[] }): boolean {
  return draft.text.trim() === "/compact" && draft.attachments.length === 0 && draft.mentions.length === 0;
}

export function isCompactSubmitKey(event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing">): boolean {
  return event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.isComposing;
}
