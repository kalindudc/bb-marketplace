// What waits on what, from the board's cards: each ticket's prerequisites by kind, its dependents, what it unblocks
// (open tickets only, directly and in all) and the longest chain of open work. Pure, so the list, the maps, the pane and
// the exact list read the same facts.
import type { BoardCard, Prereq } from "../contract";

export type Kind = Prereq["kind"];
export const KINDS: readonly Kind[] = ["work", "merge", "live"];

export const isOpen = (card: Pick<BoardCard, "state">) => card.state !== "done" && card.state !== "cancelled";

export interface Dependent {
  key: string;
  kind: Kind;
}

export interface DepIndex {
  by: ReadonlyMap<string, BoardCard>;
  prereqs(key: string): Prereq[];
  dependents(key: string): Dependent[];
  /** Open tickets that have `key` as a work prerequisite. */
  direct(key: string): string[];
  /** Open tickets that wait on `key` through work prerequisites, at any depth. */
  inAll(key: string): string[];
  /** The longest path of open tickets along work edges, first to last; a count of tickets, not a schedule. */
  longest: string[];
}

const byKey = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export function depIndex(cards: readonly BoardCard[]): DepIndex {
  const by = new Map(cards.map((card) => [card.key, card]));
  const prereqs = (key: string) => (by.get(key)?.prereqs ?? []).filter((prereq) => by.has(prereq.key));
  const dependents = new Map<string, Dependent[]>();
  for (const card of cards) for (const prereq of prereqs(card.key)) dependents.set(prereq.key, [...(dependents.get(prereq.key) ?? []), { key: card.key, kind: prereq.kind }]);
  const openWorkDependents = (key: string) => (dependents.get(key) ?? []).filter((dep) => dep.kind === "work" && isOpen(by.get(dep.key)!)).map((dep) => dep.key);
  const closure = new Map<string, string[]>();
  const inAll = (key: string): string[] => {
    const known = closure.get(key);
    if (known !== undefined) return known;
    const seen = new Set<string>();
    const stack = [...openWorkDependents(key)];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next) || next === key) continue;
      seen.add(next);
      stack.push(...openWorkDependents(next));
    }
    const all = [...seen].sort(byKey);
    closure.set(key, all);
    return all;
  };
  // The spec refuses work cycles; a path that meets itself stops there rather than looping.
  const chain = new Map<string, string[]>();
  const visiting = new Set<string>();
  const longestFrom = (key: string): string[] => {
    const known = chain.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) return [key];
    visiting.add(key);
    const next = openWorkDependents(key).map(longestFrom).sort((a, b) => b.length - a.length || byKey(a[0]!, b[0]!))[0] ?? [];
    visiting.delete(key);
    const path = [key, ...next];
    chain.set(key, path);
    return path;
  };
  const open = cards.filter(isOpen).map((card) => card.key).sort(byKey);
  const longest = open.map(longestFrom).sort((a, b) => b.length - a.length)[0] ?? [];
  return {
    by,
    prereqs,
    dependents: (key) => dependents.get(key) ?? [],
    direct: (key) => [...new Set(openWorkDependents(key))].sort(byKey),
    inAll,
    longest: longest.length > 1 ? longest : [],
  };
}

/** One edge per pair and kind, from prerequisite to dependent, among `keys`. */
export function edgesAmong(index: DepIndex, keys: ReadonlySet<string>): Array<{ from: string; to: string; kind: Kind }> {
  const edges: Array<{ from: string; to: string; kind: Kind }> = [];
  const seen = new Set<string>();
  for (const to of keys)
    for (const prereq of index.prereqs(to)) {
      if (!keys.has(prereq.key)) continue;
      const id = `${prereq.key}>${to}>${prereq.kind}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ from: prereq.key, to, kind: prereq.kind });
    }
  return edges;
}
