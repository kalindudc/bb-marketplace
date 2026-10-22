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

/** "1 ticket", "2 tickets". */
export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
/** "its worker" for one ticket, "their workers" for more. */
export const its = (count: number, noun: string) => (count === 1 ? `its ${noun}` : `their ${noun}s`);

export function noTokenUsage(threads: number): string {
  return `${threads} ${threads === 1 ? "thread reports" : "threads report"} no token usage`;
}

/** An integration project is done only after land, so one that is running or paused with every ticket finished has not landed since. */
export function readyToLand(p: { state: string; strategy: string; ticketCounts: Partial<Record<string, number>> }): boolean {
  if (p.strategy !== "integration" || (p.state !== "running" && p.state !== "paused") || (p.ticketCounts.done ?? 0) === 0) return false;
  return Object.entries(p.ticketCounts).every(([state, count]) => state === "done" || state === "cancelled" || !count);
}

/** A single-repo project's one repo has no name. */
export const isMultiRepoProject = (p: { repos: ReadonlyArray<{ name: string | null }> }) => p.repos.some((repo) => repo.name !== null);

/** `the repo "api" has` for one name, `the repos "web" and "api" have` for more. */
export function reposHave(names: readonly string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  const list = quoted.length <= 1 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
  return names.length === 1 ? `the repo ${list} has` : `the repos ${list} have`;
}

export const END_LABELS: Record<string, string> = { abandoned: "idle twice", verdict: "gave a verdict", merged: "merged", superseded: "superseded by a newer round", gone: "thread gone" };
export const endLabel = (reason: string | null) => (reason === null ? "ended" : (END_LABELS[reason] ?? reason));
