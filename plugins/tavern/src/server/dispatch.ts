import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";

export function isUser(author: {
  initiator: string;
  originPluginId: string | null;
  senderThreadId: string | null;
}) {
  return (
    author.initiator === "user" && author.originPluginId === null && author.senderThreadId === null
  );
}
export function inputText(
  input: MessageDispatchHookContext["queuedMessages"][number]["content"],
): string {
  return input
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
export function userInputText(
  input: Readonly<MessageDispatchHookContext["queuedMessages"][number]["content"]>,
): string {
  return input
    .filter((block) => block.type === "text" && block.visibility !== "agent-only")
    .map((block) => block.type === "text" ? block.text : "")
    .join("\n");
}
export function classSelectionOnly(input: Readonly<MessageDispatchHookContext["queuedMessages"][number]["content"]>, classId: string): boolean {
  let selected = false;
  const remaining: string[] = [];
  for (const block of input) {
    if (block.type !== "text") return false;
    if (block.visibility === "agent-only") continue;
    const ranges = (block.mentions ?? []).filter(mention => mention.resource.kind === "plugin" &&
      mention.resource.pluginId === "tavern" && mention.resource.itemId === `classes:${classId}` &&
      Number.isInteger(mention.start) && Number.isInteger(mention.end) && mention.start >= 0 &&
      mention.end > mention.start && mention.end <= block.text.length).sort((a, b) => b.start - a.start);
    let text = block.text;
    for (const range of ranges) { selected = true; text = text.slice(0, range.start) + " ".repeat(range.end - range.start) + text.slice(range.end); }
    remaining.push(text);
  }
  return selected && remaining.every(text => !text.trim());
}
export function tickId(text: string): string | null {
  return /^\[Tavern tick\] id=(tick_[a-f0-9-]+)/.exec(text)?.[1] ?? null;
}
