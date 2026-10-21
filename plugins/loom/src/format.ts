// Small formatters and rules shared by the CLI and the page.

const DURATION_UNITS: ReadonlyArray<[number, string]> = [
  [86_400, "d"],
  [3_600, "h"],
  [60, "m"],
  [1, "s"],
];

/** "1d 2h", "3h 12m", "45s": the two largest units, the second left out when it is zero. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const found = DURATION_UNITS.findIndex(([size]) => seconds >= size);
  const index = found === -1 ? DURATION_UNITS.length - 1 : found;
  const [size, unit] = DURATION_UNITS[index]!;
  const next = DURATION_UNITS[index + 1];
  const rest = next === undefined ? 0 : Math.floor((seconds % size) / next[0]);
  return rest > 0 ? `${Math.floor(seconds / size)}${unit} ${rest}${next![1]}` : `${Math.floor(seconds / size)}${unit}`;
}

export function noTokenUsage(threads: number): string {
  return `${threads} ${threads === 1 ? "thread reports" : "threads report"} no token usage`;
}

/** An integration project is done only after land, so one that is running or paused with every ticket finished has not landed since. */
export function readyToLand(p: { state: string; strategy: string; ticketCounts: Partial<Record<string, number>> }): boolean {
  if (p.strategy !== "integration" || (p.state !== "running" && p.state !== "paused") || (p.ticketCounts.done ?? 0) === 0) return false;
  return Object.entries(p.ticketCounts).every(([state, count]) => state === "done" || state === "cancelled" || !count);
}
