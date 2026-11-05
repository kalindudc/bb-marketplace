export interface Failure {
  /** The error that stopped the thread, as bb logged it; null when its log has none. */
  reason: string | null;
  failedAt: number | null;
  /** The error looks like a dropped connection, a timeout or a provider outage, which a retry can get past. */
  network: boolean;
  /** The agent's process died or stopped answering, so a retry only works once bb starts it again. */
  restart: boolean;
}

export interface ErrorEvent {
  type: string;
  createdAt: number;
  data: unknown;
}

export interface ErrorInfo {
  category: string;
  httpStatusCode: number | null;
}

const TURN_REQUESTED = "client/turn/requested";

/** What to read from a thread's log: its errors, and its turn requests to tell this turn's errors from older ones. */
export const FAILURE_EVENT_TYPES = [TURN_REQUESTED, "provider/error", "system/error"] as const;

const REASON_MAX = 400;

// Codex and Claude Code classify their own errors; pi reports only text, so the text decides for it.
const NETWORK_CATEGORIES = new Set(["connection-failed", "stream-disconnected", "overloaded", "internal"]);

const NETWORK_TEXT: readonly RegExp[] = [
  /\bconnection (?:error|reset|refused|closed|lost|failed|aborted|terminated|timed out)\b/i,
  /\bnot connected\b/i,
  /\bdisconnect(?:ed)?\b/i,
  /\btimed out\b|\btime-?out\b/i,
  /\bdid not answer\b.*\bin time\b/i,
  /\bE(?:CONNRESET|CONNREFUSED|CONNABORTED|TIMEDOUT|NOTFOUND|AI_AGAIN|PIPE|NETUNREACH|HOSTUNREACH|NETDOWN)\b/,
  /\bsocket hang up\b/i,
  /\bfetch failed\b/i,
  /\bnetwork ?error\b|\bnetwork (?:is )?unreachable\b/i,
  /\boverloaded\b/i,
  /\b(?:service unavailable|bad gateway|gateway time-?out)\b/i,
  /\b(?:error|status|code|http)\W{0,3}(?:50[0-4]|52\d)\b/i,
  /^(?:50[0-4]|52\d)\b/,
];

// A retry dispatched to a dead or hung agent fails at once ("No active Pi session"); stopping the thread first lets bb start a fresh one.
const RESTART_TEXT: readonly RegExp[] = [
  /\bdid not answer\b.*\bin time\b/i,
  /\bJSON-RPC request timed out\b/i,
  /\bexited (?:\(code|before input was consumed)/i,
  /\bNo active \w+ session\b/i,
];

export function needsRestart(text: string): boolean {
  return RESTART_TEXT.some((pattern) => pattern.test(text));
}

function isServerUnavailable(status: number | null): boolean {
  return status !== null && ((status >= 500 && status <= 504) || (status >= 520 && status <= 529));
}

export function isNetworkFailure(text: string, info: ErrorInfo | null): boolean {
  if (info !== null && info.category !== "unknown") {
    return NETWORK_CATEGORIES.has(info.category) || isServerUnavailable(info.httpStatusCode);
  }
  if (info !== null && isServerUnavailable(info.httpStatusCode)) return true;
  return NETWORK_TEXT.some((pattern) => pattern.test(text));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorInfo(value: unknown): ErrorInfo | null {
  const info = asRecord(value);
  if (typeof info.category !== "string") return null;
  return { category: info.category, httpStatusCode: typeof info.httpStatusCode === "number" ? info.httpStatusCode : null };
}

function clip(reason: string): string {
  const flat = reason.replace(/\s+/g, " ").trim();
  return flat.length <= REASON_MAX ? flat : `${flat.slice(0, REASON_MAX - 1)}…`;
}

/** Events newest first, as `threads.events.list({ order: "desc" })` returns them. */
export function failureFromEvents(events: readonly ErrorEvent[]): Failure {
  const latestTurn = events.findIndex((event) => event.type === TURN_REQUESTED);
  const errors = latestTurn === -1 ? events : events.slice(0, latestTurn);
  const final = errors.find((event) => asRecord(event.data).willRetry !== true) ?? errors[0];
  if (final === undefined) return { reason: null, failedAt: null, network: false, restart: false };
  const data = asRecord(final.data);
  const full = text(data.detail) || text(data.message);
  if (full === "") return { reason: null, failedAt: final.createdAt, network: false, restart: false };
  return {
    reason: clip(full),
    failedAt: final.createdAt,
    network: isNetworkFailure(full, errorInfo(data.errorInfo)),
    restart: needsRestart(full),
  };
}
