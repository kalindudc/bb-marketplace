import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mapLimit } from "./limit";

export const EXCLUDED_UNAVAILABLE = "Vantage does not run Git here: this checkout is excluded in Vantage's settings";

export function parseExclusionList(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean))];
}

export function isExcludedProvider(
  id: string | null | undefined,
  excludedProviders: ReadonlySet<string> | undefined,
): boolean {
  return id != null && excludedProviders?.has(id) === true;
}

export const expandHome = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

export function atOrBelow(root: string, path: string): boolean {
  const fold = (value: string) => (process.platform === "darwin" ? value.toLowerCase() : value);
  const base = fold(resolve(root));
  const full = fold(resolve(path));
  return full === base || full.startsWith(base.endsWith(sep) ? base : base + sep);
}

export function exclusionGate(excludedRoots: readonly string[] = []) {
  const roots = [...new Set(excludedRoots.map(expandHome))];
  let physical: Promise<string[]> | undefined;
  const blocksPath = (path: string) => roots.some((root) => atOrBelow(root, path));
  const blocksRealPath = async (path: string) => {
    if (blocksPath(path)) return true;
    if (roots.length === 0) return false;
    physical ??= mapLimit(roots, 4, (root) => realpath(root).catch(() => null)).then((paths) =>
      paths.filter((found) => found !== null),
    );
    return (await physical).some((root) => atOrBelow(root, path));
  };
  return { blocksPath, blocksRealPath };
}
