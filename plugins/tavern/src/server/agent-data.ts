const holdEvents = new Set(["checker-handoff.held", "checker-handoff.released"]);

export function agentData(value: unknown, eventType?: string): unknown {
  if (eventType !== undefined && !holdEvents.has(eventType)) return value;
  return project(value, false, eventType !== undefined);
}

function project(value: unknown, hold: boolean, eventData: boolean): unknown {
  if (Array.isArray(value)) return value.map(item => project(item, hold, eventData));
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const releaseAsk = record.kind === "blocker" && typeof record.keeperThreadId === "string" && Array.isArray(record.options);
  const heldEvent = typeof record.type === "string" && holdEvents.has(record.type);
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => !(eventData && key === "holdId") && !(releaseAsk && key === "releaseHoldId") && !(hold && key === "id"))
    .map(([key, item]) => [key, project(item, key === "checkerHandoffHold", key === "data" && heldEvent)]));
}
