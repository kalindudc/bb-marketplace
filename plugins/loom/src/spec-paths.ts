// Paths that name one part of a spec, such as ticket[csv-export].acceptance[1]: tickets by ref, other lists by position from 0.
// Only types come from ./spec, so the page can import this file without the TOML and validation libraries.
import type { Spec, TicketSpec } from "./spec";

export interface SpecChanges {
  /** The paths of the newer spec that differ or are new, without any path that has a changed path under it. */
  changed: string[];
  /** The refs of the tickets the newer spec no longer has. */
  removed: string[];
}

/** A note the human leaves on parts of a spec, with the version it was written on. */
export interface SpecNote {
  version: number;
  paths: string[];
  /** Empty only when the note suggests a value. */
  body: string;
  /** A value the human suggests for the part, as TOML: `"pr"`, `2` or `false`, with the value it has now. */
  suggest?: { from: string; to: string };
}

/** The path of a note on the spec as a whole; any change answers it. */
export const WHOLE_SPEC = "spec";

/** True when `path` names a part inside `above`, such as ticket[a].scope[0] inside ticket[a]. */
export const isUnder = (path: string, above: string) => path.startsWith(`${above}.`) || path.startsWith(`${above}[`);

function nodesOf(spec: Spec): Map<string, string> {
  const nodes = new Map<string, string>();
  const walk = (value: unknown, path: string) => {
    if (value === undefined) return;
    if (path !== "") nodes.set(path, JSON.stringify(value));
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`));
    else if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) walk(item, path === "" ? key : `${path}.${key}`);
  };
  const { ticket, ...rest } = spec;
  walk(rest, "");
  for (const one of ticket) walk(one, `ticket[${one.ref}]`);
  return nodes;
}

export function specChanges(before: Spec, after: Spec): SpecChanges {
  const old = nodesOf(before);
  const differ = [...nodesOf(after)].filter(([path, value]) => old.get(path) !== value).map(([path]) => path);
  const refs = new Set(after.ticket.map((ticket) => ticket.ref));
  return {
    changed: differ.filter((path) => !differ.some((other) => isUnder(other, path))),
    removed: before.ticket.map((ticket) => ticket.ref).filter((ref) => !refs.has(ref)),
  };
}

/** True when a change touches any of `paths`: at it, under it or above it, or inside a removed ticket; any change touches the whole spec. */
export function changedAt(changes: SpecChanges, paths: readonly string[]): boolean {
  return paths.some(
    (path) =>
      (path === WHOLE_SPEC && (changes.changed.length > 0 || changes.removed.length > 0)) ||
      changes.changed.some((changed) => changed === path || isUnder(changed, path) || isUnder(path, changed)) ||
      changes.removed.some((ref) => path === `ticket[${ref}]` || isUnder(path, `ticket[${ref}]`)),
  );
}

/** Each ticket's wave from 0: a ticket with no dependencies is in wave 0, any other one wave after its latest dependency. Unknown refs are ignored. */
export function wavesOf(tickets: ReadonlyArray<Pick<TicketSpec, "ref" | "depends_on">>): Record<string, number> {
  const byRef = new Map(tickets.map((ticket) => [ticket.ref, ticket]));
  const waves = new Map<string, number>();
  const waveOf = (ref: string): number => {
    const known = waves.get(ref);
    if (known !== undefined) return known;
    const deps = byRef.get(ref)!.depends_on.filter((dep) => byRef.has(dep));
    const wave = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(waveOf));
    waves.set(ref, wave);
    return wave;
  };
  for (const ticket of tickets) waveOf(ticket.ref);
  return Object.fromEntries(waves);
}

/** Every ticket `ref` waits for and every ticket that waits for it, directly or not, each by wave and then spec order. Unknown refs are ignored. */
export function dependencyChain(tickets: ReadonlyArray<Pick<TicketSpec, "ref" | "depends_on">>, ref: string): { up: string[]; down: string[] } {
  const waves = wavesOf(tickets);
  const walk = (next: (ref: string) => readonly string[]) => {
    const seen = new Set<string>();
    const stack = [...next(ref)];
    while (stack.length > 0) {
      const one = stack.pop()!;
      if (one === ref || seen.has(one) || waves[one] === undefined) continue;
      seen.add(one);
      stack.push(...next(one));
    }
    return tickets.map((ticket) => ticket.ref).filter((one) => seen.has(one)).sort((a, b) => waves[a]! - waves[b]!);
  };
  const byRef = new Map(tickets.map((ticket) => [ticket.ref, ticket]));
  return {
    up: walk((one) => byRef.get(one)?.depends_on ?? []),
    down: walk((one) => tickets.filter((ticket) => ticket.depends_on.includes(one)).map((ticket) => ticket.ref)),
  };
}
