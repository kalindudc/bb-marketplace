import type { CompactionSummary, ThreadStatusDto } from "../contract";
import type { PointId } from "../policy";

export const POINT_LABELS: Record<PointId, { label: string; description: string }> = {
  phase: { label: "Phase", description: "Plan approved, tests green, or a PR opened." },
  agent: { label: "Agent", description: "An agent marks a compaction point." },
  volume: { label: "Tool volume", description: "A large tool result lands." },
  turns: { label: "Turns", description: "A thread runs for many turns." },
  idle: { label: "Idle", description: "A thread has been idle." },
  thrash: { label: "Thrash", description: "Repeated reads or failed commands." },
};

export const PRESS_TAB = { id: "press", context: { kind: "thread" }, availability: "action" } as const;

export const numberText = (value: number | null) => value === null ? "—" : value.toLocaleString();
export const shortTokens = (value: number | null) => value === null ? "?" : `${Math.trunc(value / 1000)}k`;
export const secondsText = (ms: number, decimals = 1) => `${Number((ms / 1000).toFixed(decimals))}s`;

export function chipText({ percent, nextPoint, mode }: Pick<ThreadStatusDto, "percent" | "nextPoint" | "mode">): string {
  const usage = percent === null ? "—" : `${Math.round(percent)}%`;
  // With no point pending the percent alone would repeat bb's own circle beside it, so say what
  // Press will do instead: the mode is the only thing that differs from the circle's reading.
  return nextPoint ? `${usage} · ${nextPoint}` : `${usage} · ${mode}`;
}

export function boundaryEntry(status: ThreadStatusDto | undefined, message: { id: string; createdAt: number }): CompactionSummary | null {
  if (!status) return null;
  // Assistant metadata uses the row's start time even though the timeline has a distinct createdAt.
  const index = status.boundaries[`message:${message.id}`] ?? status.boundaries[String(message.createdAt)];
  const entry = status.history[index];
  if (!entry || entry.boundaryAt === null) return null;
  const matches = entry.boundaryMessageId === null ? entry.boundaryAt === message.createdAt : entry.boundaryMessageId === message.id;
  return matches ? entry : null;
}

export function chatText(row: CompactionSummary): string {
  const tokens = row.tokensBefore === null && row.tokensAfter === null ? null : `${shortTokens(row.tokensBefore)} to ${shortTokens(row.tokensAfter)}`;
  return ["Pressed", tokens,
    row.ms === null ? null : secondsText(row.ms, 0), row.point].filter((part) => part !== null).join(" · ");
}
