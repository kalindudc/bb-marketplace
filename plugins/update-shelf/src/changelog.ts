import { compareSemver, isSemver } from "./versions";

export interface ChangelogEntry {
  version: string;
  title: string;
  body: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/u;
const VERSION = /^\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?(?=$|[\s(\-–—:,])/u;
const FENCE = /^\s*(```|~~~)/u;
const MAX_BODY = 12_000;

/**
 * The sections of a changelog newer than `from` and no newer than `to`, in file order.
 * Version sections are the headings that start with a version ("## 0.29.3 (2026-10-28)", "## [0.2.6] - 2026-10-21",
 * "## v1.2.0"); the first one sets the heading level, so "### Fixed" under it stays part of its body.
 * With `from` unknown only the `to` section is kept; with `to` unknown every section newer than `from` is.
 */
export function sliceChangelog(markdown: string, range: { from: string | null; to: string | null }): ChangelogEntry[] {
  const from = range.from !== null && isSemver(range.from) ? range.from : null;
  const to = range.to !== null && isSemver(range.to) ? range.to : null;
  if (from === null && to === null) return [];
  const sections = versionSections(markdown);
  return sections.filter(({ version }) => {
    if (from === null) return compareSemver(version, to!) === 0;
    if (compareSemver(version, from) <= 0) return false;
    return to === null || compareSemver(version, to) <= 0;
  });
}

function versionSections(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let level: number | null = null;
  let current: { version: string; title: string; lines: string[] } | null = null;
  let fenced = false;
  const close = () => {
    if (current === null) return;
    entries.push({ version: current.version, title: current.title, body: bounded(current.lines.join("\n").trim()) });
    current = null;
  };
  for (const line of markdown.split(/\r?\n/u)) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : HEADING.exec(line);
    if (heading !== null) {
      const depth = heading[1]!.length;
      const text = heading[2]!;
      const version = VERSION.exec(text)?.[1];
      if (version !== undefined && (level === null || depth === level)) {
        close();
        level = depth;
        current = { version, title: text.replace(/^\[([^\]]+)\]/u, "$1"), lines: [] };
        continue;
      }
      if (level !== null && depth <= level) {
        close();
        continue;
      }
    }
    current?.lines.push(line);
  }
  close();
  return entries;
}

function bounded(body: string): string {
  return body.length <= MAX_BODY ? body : `${body.slice(0, MAX_BODY).trimEnd()}\n\n…`;
}
