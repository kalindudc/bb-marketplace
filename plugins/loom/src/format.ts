// Small formatters shared by the CLI and the page.

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
