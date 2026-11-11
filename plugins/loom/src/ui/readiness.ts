// What merging one ticket's pull request changes for the tickets that wait on it, from the same facts Ship's merge order
// reads (each entry's waits and the holds of its own pull request) and the board's live prerequisites. It says which
// prerequisite the merge removes and names every hold that remains, so a confirmation never promises what Ship refuses.
import type { BoardCard, MergeOrderView } from "../contract";
import { holdText } from "../verdict";
import { listText } from "./common";

export interface MergeConsequence {
  key: string;
  /** The wait this merge removes: it merges after, depends on or is stacked on the merged ticket; null when it only needs that ticket live. */
  removes: "merge_after" | "depends" | "stacked" | null;
  /** Nothing else holds it once this merge lands. */
  free: boolean;
  /** What it does once free: "can merge", or "is next to merge" before it has a pull request. */
  then: string;
  /** What still holds it, in words: other tickets it waits on, its pull request's own holds, live requirements. */
  holds: string[];
}

export function mergeConsequences(key: string, order: MergeOrderView | null, board: readonly BoardCard[]): MergeConsequence[] {
  const out: MergeConsequence[] = [];
  const seen = new Set<string>();
  for (const entry of order?.entries ?? []) {
    const wait = entry.waitsOn.find((one) => one.key === key);
    if (wait === undefined || entry.state === "done" || entry.state === "cancelled") continue;
    seen.add(entry.key);
    const others = entry.waitsOn.filter((one) => one.key !== key).map((one) => one.key);
    const live = (board.find((card) => card.key === entry.key)?.prereqs ?? []).filter((prereq) => prereq.kind === "live").map((prereq) => prereq.key);
    const holds = [...(others.length > 0 ? [`waits on ${listText(others)}`] : []), ...entry.prHolds.map(holdText), ...(live.length > 0 ? [`needs ${listText(live)} live`] : [])];
    out.push({ key: entry.key, removes: wait.why, free: holds.length === 0, then: entry.prUrl === null ? "is next to merge" : "can merge", holds });
  }
  // A ticket that needs this one live, but not merged first, still waits: merging is not going live.
  for (const card of board) {
    if (seen.has(card.key) || card.state === "done" || card.state === "cancelled") continue;
    if (!card.prereqs.some((prereq) => prereq.kind === "live" && prereq.key === key)) continue;
    out.push({ key: card.key, removes: null, free: false, then: "can deploy", holds: [`needs ${key} live`] });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

/**
 * "CSV-15 stops waiting on CSV-12, but 1 check failing and 1 check pending still hold it · CSV-17 still needs CSV-12
 * live", or null when nothing waits on it.
 */
export function consequenceText(key: string, consequences: readonly MergeConsequence[]): string | null {
  if (consequences.length === 0) return null;
  return consequences
    .map((one) => {
      if (one.removes === null) return `${one.key} still needs ${key} live`;
      const ends = `${one.key} stops waiting on ${key}`;
      return one.free ? `${ends} and ${one.then}` : `${ends}, but ${listText(one.holds)} still ${one.holds.length === 1 ? "holds" : "hold"} it`;
    })
    .join(" · ");
}
