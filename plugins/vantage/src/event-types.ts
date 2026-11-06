// Streaming chunks change no file.
const DELTA_EVENT_TYPES = [
  "item/agentMessage/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta", "item/plan/delta", "item/toolCall/progress",
];

// Event types that carry no file change and no commit.
const QUIET_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...DELTA_EVENT_TYPES, "item/started", "item/mcpToolCall/progress", "item/backgroundTask/progress", "item/delegation/progress",
  "thread/tokenUsage/updated", "thread/contextWindowUsage/updated", "thread/name/updated", "thread/goal/updated", "thread/goal/cleared",
  "thread/extensionState/updated", "provider/rateLimits/updated", "provider/warning", "turn/started", "turn/input/accepted",
  "turn/plan/updated", "turn/mainRun/updated",
]);

export const ITEM_COMPLETED = "item/completed";

/** Event types after which a thread's files may have changed; the page refreshes for any of them. */
export const FILE_EVENT_TYPES: readonly string[] = [
  ITEM_COMPLETED, "turn/completed", "turn/diff/updated", "item/backgroundTask/completed", "item/delegation/completed",
];

export type EventVerdict = "changed" | "unchanged" | "look";

/**
 * What the event types of one thread event say about its files. "look" means the only thing that may have changed them is a
 * completed item, whose kind the event types do not tell. A type nobody listed counts as a change.
 */
export function classifyEventTypes(eventTypes: readonly string[] | undefined): EventVerdict {
  if (eventTypes === undefined || eventTypes.length === 0) return "changed";
  let completed = false;
  for (const type of eventTypes) {
    if (type === ITEM_COMPLETED) completed = true;
    else if (!QUIET_EVENT_TYPES.has(type)) return "changed";
  }
  return completed ? "look" : "unchanged";
}
