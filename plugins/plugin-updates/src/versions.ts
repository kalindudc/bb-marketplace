const COMMIT = /^[0-9a-f]{40}$/u;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;
const SEMVER_AT_END = /v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;

export const isCommit = (value: string): boolean => COMMIT.test(value);

export const shortCommit = (value: string): string => value.slice(0, 7);

/**
 * The ref inside one of bb's source displays:
 * "https://github.com/o/r.git@genui/v0.2.7 (f1fb0e872fb2)" holds "genui/v0.2.7", "…@HEAD (eed869846b8e)" holds "HEAD".
 */
export function refFromDisplay(display: string): string | null {
  return /@([^@\s]+) \([0-9a-f]{7,40}\)$/u.exec(display.trim())?.[1] ?? null;
}

/** "genui/v0.2.7" and "v0.2.7" hold "0.2.7"; "HEAD" and "main" hold none. */
export function semverFromRef(ref: string): string | null {
  return SEMVER_AT_END.exec(ref)?.[1] ?? null;
}

/** A release version from a source display when it names one, otherwise a short commit id or the version itself. */
export function versionLabel(version: string, display: string | null): string {
  const ref = display === null ? null : refFromDisplay(display);
  const semver = ref === null ? null : semverFromRef(ref);
  if (semver !== null) return semver;
  return isCommit(version) ? shortCommit(version) : version;
}

export function isSemver(value: string): boolean {
  return SEMVER.test(value);
}

/** Orders two semver versions; a prerelease sorts before its release. Throws on anything else. */
export function compareSemver(left: string, right: string): number {
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = a.core[index]! - b.core[index]!;
    if (difference !== 0) return difference;
  }
  if (a.pre === null || b.pre === null) return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1;
  return comparePrerelease(a.pre, b.pre);
}

function parse(value: string): { core: number[]; pre: string | null } {
  const match = SEMVER.exec(value);
  if (match === null) throw new Error(`not a semver version: ${JSON.stringify(value)}`);
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null };
}

function comparePrerelease(left: string, right: string): number {
  const a = left.split(".");
  const b = right.split(".");
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numeric = /^\d+$/u.test(x) && /^\d+$/u.test(y);
    const difference = numeric ? Number(x) - Number(y) : x.localeCompare(y);
    if (difference !== 0) return difference;
  }
  return 0;
}
