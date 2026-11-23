import type { Blocker, CompactionSummary, ThreadStatusDto } from "../contract";
import type { PointId } from "../policy";

export const POINT_LABELS: Record<PointId, { label: string; description: string }> = {
  phase: { label: "Phase", description: "Plan approved, tests green, PR opened" },
  agent: { label: "Agent", description: "An agent marks a point" },
  volume: { label: "Tool volume", description: "A large tool result lands" },
  turns: { label: "Turns", description: "Many turns since the last one" },
  idle: { label: "Idle", description: "The thread sits idle" },
  thrash: { label: "Thrash", description: "Same file re-read, same command failing" },
};

/** Labels for every point a decision or a history row can name, the six policy points included. */
const POINT_NAMES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(POINT_LABELS).map(([id, { label }]) => [id, label])),
  window: "Force at",
  manual: "Manual",
  native: "Native",
};

export const PRESS_TAB = { id: "press", context: { kind: "thread" }, availability: "action" } as const;

/** Press policy switches Press off for the thread's provider: it never compacts or holds the thread. */
export const PROVIDER_OFF_TEXT = "Press is off for this provider";

export const MODE_DESCRIPTIONS: Record<ThreadStatusDto["mode"], string> = {
  observe: "Records what Press would do, never compacts",
  advisor: "Proposes a compaction, you compact",
  auto: "Compacts on its own",
};

export const VETO_WORDS: Record<Blocker["veto"], string> = {
  midTurn: "mid-turn",
  cooldownSeconds: "cooldown",
  minTurnsBetween: "min turns",
  belowFloor: "below floor",
  previousCompactionFailed: "last compaction failed",
};

export const numberText = (value: number | null) => value === null ? "—" : value.toLocaleString();
export const shortTokens = (value: number | null) => value === null ? "?"
  : value >= 1_000_000 ? `${Number((value / 1_000_000).toFixed(2))}M` : `${Math.trunc(value / 1000)}k`;
export const secondsText = (ms: number, decimals = 1) => `${Number((ms / 1000).toFixed(decimals))}s`;
const pad = (value: number) => String(value).padStart(2, "0");

/** A duration as m:ss, or h:mm:ss from an hour. */
export function clockText(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`;
}

/** Local wall-clock time as HH:MM. */
export function timeText(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function agoText(iso: string, now: number): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ${minutes % 60} min ago` : `${Math.floor(hours / 24)} d ago`;
}

export function bytesText(bytes: number): string {
  if (bytes >= 1_000_000) return `${Number((bytes / 1_000_000).toFixed(1))} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function durationWords(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function pointName(point: string | null): string {
  return point === null ? "Unknown point" : POINT_NAMES[point] ?? point;
}

/** A point inside a sentence: lower case, and the backstop names its threshold. */
export function pointWord(point: string | null, hardPercent: number): string {
  if (point === "window") return `force at ${hardPercent}%`;
  if (point === "manual") return "requested by you";
  return pointName(point).toLowerCase();
}

const REASON_WORDS: Record<string, string> = {
  "tests.green": "tests green",
  "plan.approved": "plan approved",
  "pr.opened": "PR opened",
  agentHint: "agent hint",
  manual: "you asked",
  "window.hard": "force at",
};

/** The signal or threshold behind a decision, in words; unknown reasons pass through unchanged. */
export function reasonText(reason: string | null): string | null {
  if (reason === null) return null;
  const known = REASON_WORDS[reason];
  if (known !== undefined) return known;
  const match = /^([a-zA-Z]+)(>=|<=|>|<|==)(\d+(?:\.\d+)?)$/.exec(reason.replace(/\s+/g, ""));
  if (match === null) return reason;
  const [, name, , raw] = match;
  const value = Number(raw);
  switch (name) {
    case "toolResultBytes": return `${bytesText(value)} result`;
    case "idleSeconds": return `idle ${durationWords(value)}`;
    case "turnsSinceCompaction": return plural(value, "turn");
    case "sameFileRead": return `same file read ${plural(value, "time")}`;
    case "sameCommandFailed": return `same command failed ${plural(value, "time")}`;
    case "subagentReportBytes": return `subagent report over ${bytesText(value)}`;
    default: return reason;
  }
}

export function vetoWord(veto: string | null): string {
  return veto !== null && veto in VETO_WORDS ? VETO_WORDS[veto as Blocker["veto"]] : veto ?? "a veto";
}

export function chipText({ percent }: Pick<ThreadStatusDto, "percent">): string {
  return percent === null ? "—" : `${Math.round(percent)}%`;
}

export type UsageTone = "calm" | "near" | "over";

/** Where the thread stands against Press's own lines: below "compact at", past it, or past "force at". */
export function usageTone({ percent, thresholds }: Pick<ThreadStatusDto, "percent" | "thresholds">): UsageTone {
  if (percent === null || percent < thresholds.softPercent) return "calm";
  return percent < thresholds.hardPercent ? "near" : "over";
}

/** The chip spins while Press is compacting the thread or holding its next message. */
export const chipBusy = ({ compacting, held }: Pick<ThreadStatusDto, "compacting" | "held">) => compacting !== null || held !== null;

const MODE_TEXT: Record<ThreadStatusDto["mode"], string> = {
  observe: "Observe: records what it would do",
  advisor: "Advisor: proposes, you compact",
  auto: "Auto: compacts on its own",
};

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** What the chip and the context row say in full: their tooltip and accessible name. */
export function statusLines(dto: Pick<ThreadStatusDto, "percent" | "tokens" | "window" | "providerEnabled" | "mode" | "thresholds" | "compacting" | "held" | "nextPoint" | "lastCompaction">): string[] {
  const lines = [dto.tokens === null
    ? "No context usage reported yet"
    : `${chipText(dto)} of the context window (${shortTokens(dto.tokens)} of ${shortTokens(dto.window)} tokens)`];
  if (dto.held) lines.push(`Holding the next message since ${clock(dto.held.since)}, until the compaction lands`);
  else if (dto.compacting) lines.push(`Compacting since ${clock(dto.compacting.since)}`);
  if (!dto.providerEnabled) lines.push(PROVIDER_OFF_TEXT);
  else {
    lines.push(`${MODE_TEXT[dto.mode]}, from ${dto.thresholds.softPercent}%, forced at ${dto.thresholds.hardPercent}%`);
    if (dto.nextPoint) lines.push(`Next point: ${pointWord(dto.nextPoint, dto.thresholds.hardPercent)}`);
  }
  const last = dto.lastCompaction;
  lines.push(last
    ? `Last compacted at ${clock(last.at)}${last.tokensBefore === null ? "" : `: ${shortTokens(last.tokensBefore)} to ${shortTokens(last.tokensAfter)}`}`
    : "Not compacted yet");
  return lines;
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

export function chatText(row: Pick<CompactionSummary, "tokensBefore" | "tokensAfter" | "ms" | "point">): string {
  const tokens = row.tokensBefore === null && row.tokensAfter === null ? null : `${shortTokens(row.tokensBefore)} to ${shortTokens(row.tokensAfter)}`;
  return ["Pressed", tokens,
    row.ms === null ? null : secondsText(row.ms, 0), row.point].filter((part) => part !== null).join(" · ");
}
