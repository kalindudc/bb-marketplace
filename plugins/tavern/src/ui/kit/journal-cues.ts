import { useLayoutEffect, useRef, type RefObject } from "react";
import type { EntryStatus, Journal } from "../../shared/schema";
import { MAX_TRAVEL_PX, motion, type CueOptions, type Surface } from "./motion";
import { tallyFold } from "./journal-marks";

/** A thread's journal panel is its own motion surface, with one slot (README "Journal motion"). */
export const journalSurface = (threadId: string): Surface => `journal:${threadId}`;

const isDone = (s: EntryStatus) => s === "done" || s === "verified";

/** What one journal result looked like: each entry's status, and the current entry. */
export type JournalSnapshot = { statuses: ReadonlyMap<string, EntryStatus>; currentId: string | null; done: number };
export function journalSnapshot(journal: Pick<Journal, "entries" | "progress">): JournalSnapshot {
  const statuses = new Map(journal.entries.map(e => [e.id, e.status] as const));
  // The tally draws progress.done, so the cue reads the same number rather than a count of its own.
  return { statuses, currentId: journal.progress.current?.id ?? null, done: journal.progress.done };
}

export type JournalChangeSet = {
  /** Entries this mount saw open that are now done, in entry order. */
  done: { id: string; byUser: boolean }[];
  /** Entries this mount saw unverified that are now verified. */
  verified: { id: string; byUser: boolean }[];
  /** The current entry, when it changed. `from` is null when there was none. */
  current: { from: string | null; to: string; byUser: boolean } | null;
  /** The done count went up, so the tally drew a new stroke. */
  doneRose: boolean;
};

/**
 * The changes between two results of the same journal, keyed on entry ids. An id the earlier result didn't have never counts: an Undo of
 * "Clear done" brings back entries that were already done, and they cue nothing. Who made a change is the newest change record naming it.
 */
export function diffJournal(prev: JournalSnapshot, next: JournalSnapshot, changes: Journal["changes"]): JournalChangeSet {
  const byUser = (id: string) => {
    let newest: Journal["changes"][number] | undefined;
    for (const c of changes) if (c.entryIds.includes(id) && (!newest || c.id > newest.id)) newest = c;
    return newest?.actor.kind === "user";
  };
  const done: JournalChangeSet["done"] = [], verified: JournalChangeSet["verified"] = [];
  for (const [id, status] of next.statuses) {
    const was = prev.statuses.get(id);
    if (was === undefined) continue;
    if (!isDone(was) && isDone(status)) done.push({ id, byUser: byUser(id) });
    if (was !== "verified" && status === "verified") verified.push({ id, byUser: byUser(id) });
  }
  const moved = next.currentId !== null && next.currentId !== prev.currentId && next.statuses.has(next.currentId) && (prev.currentId === null || prev.statuses.has(next.currentId));
  return { done, verified, current: moved ? { from: prev.currentId, to: next.currentId!, byUser: byUser(next.currentId!) } : null, doneRose: next.done > prev.done };
}

/** One entry's own row, never a step's inside it. */
// Inside a quoted attribute value only a quote and a backslash need escaping; CSS.escape is missing in some environments.
const rowOf = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-entry="${id.replace(/["\\]/g, "\\$&")}"] > .journal-row`);

/**
 * The journal's four one-shot cues (README "Journal motion"): the new tally stroke, the gate's slash, the ribbon moving to the current
 * entry, and the seal settling on an entry a Warden verified. `root` holds the header tally and every list.
 * - Only a change between two journal results seen by this mount cues. Every result up to the end of the mount's first fetch only
 *   records: the first one, the skeleton's swap, and a cached journal with the refetch that follows it when the panel reopens, which
 *   carries what an agent did while it was closed. The Done fold, filters and the clock never cue, because they aren't journal results.
 * - One stroke per result: the last one, when several finish together. None when it folded into "+N".
 * - The user's own change plays as the answer to their click and takes no slot. An agent's or a Warden's is automatic: it shares the
 *   panel's one slot, and holds while a blocked or rejected entry is on screen when the cue is due, or while the user types.
 * - It calls the coordinator directly rather than through useTavernMotion, so focus, visibility and reduced-motion changes don't
 *   re-render the journal.
 */
export function useJournalCues(threadId: string, journal: Pick<Journal, "entries" | "changes" | "progress"> | undefined, root: RefObject<HTMLElement | null>, query: { fetching: boolean }) {
  const surface = journalSurface(threadId);
  const seen = useRef<JournalSnapshot | null>(null);
  const settled = useRef(false);
  // Installs the coordinator's listeners on mount, so typing before the panel's first cue still holds it.
  useLayoutEffect(() => { motion.install(); return () => motion.setHeld(surface, false); }, [surface]);
  useLayoutEffect(() => {
    if (!journal) return;
    const next = journalSnapshot(journal), prev = seen.current;
    seen.current = next;
    const baseline = !settled.current;
    if (!query.fetching) settled.current = true;
    const el = root.current;
    if (baseline || !prev || !el) return;
    const d = diffJournal(prev, next, journal.changes);
    const last = d.done.at(-1);
    // Decided now, not by an observer: filters, folds and this very result can draw a stuck row that nothing has measured yet.
    if ([last, ...d.verified, d.current].some(c => c && !c.byUser)) motion.setHeld(surface, stuckInView(el));
    const cue = (target: Element | null | undefined, kind: string, o: CueOptions) => motion.cue(surface, target ?? null, kind, o);
    const as = (byUser: boolean) => ({ auto: !byUser, ambient: !byUser });
    if (last && d.doneRose) {
      const visible = next.done - tallyFold(next.done);
      const stroke = visible > 0 ? el.querySelector<SVGLineElement>('[data-tally="head"] line:last-of-type') : null;
      if (stroke) cue(stroke, visible % 5 === 0 ? "gate slash" : "tally stroke", { key: `tally:${threadId}:${last.id}`, ms: 180, className: visible % 5 === 0 ? "mo-slash" : "mo-chalk", ...as(last.byUser) });
    }
    for (const v of d.verified) {
      const mark = rowOf(el, v.id)?.querySelector(".smark.s-verified");
      if (mark) cue(mark, "seal", { key: `seal:${threadId}:${v.id}`, ms: 260, className: "mo-verified", ...as(v.byUser) });
    }
    if (d.current) {
      const { from, to, byUser } = d.current;
      const ribbon = rowOf(el, to)?.querySelector<HTMLElement>(".ribbon.row");
      const toRow = rowOf(el, to), fromRow = from ? rowOf(el, from) : null;
      if (ribbon && toRow) {
        const dy = fromRow ? fromRow.getBoundingClientRect().top - toRow.getBoundingClientRect().top : Infinity;
        cue(ribbon, "ribbon", {
          key: `ribbon:${threadId}`, ms: 300, ...as(byUser),
          run: r => [Math.abs(dy) <= MAX_TRAVEL_PX && dy !== 0
            ? r.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 300, easing: "cubic-bezier(.65, 0, .35, 1)" })
            : r.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: "cubic-bezier(.2, .8, .2, 1)" })],
        });
      }
    }
  }, [journal, query.fetching]); // eslint-disable-line react-hooks/exhaustive-deps
}

const STUCK_ROWS = '[data-entry-state="blocked"] > .journal-row, [data-entry-state="rejected"] > .journal-row';
const clips = (overflow: string) => overflow !== "" && overflow !== "visible";

/** Whether a blocked or rejected entry's row is on screen: inside the window and every ancestor that clips. Read once, when a cue is due. */
export function stuckInView(root: HTMLElement): boolean {
  const rows = root.querySelectorAll<HTMLElement>(STUCK_ROWS);
  if (!rows.length) return false;
  let top = 0, left = 0, bottom = window.innerHeight, right = window.innerWidth;
  for (let n: HTMLElement | null = root; n; n = n.parentElement) {
    const style = getComputedStyle(n);
    if (!clips(style.overflowX) && !clips(style.overflowY)) continue;
    const b = n.getBoundingClientRect();
    top = Math.max(top, b.top); left = Math.max(left, b.left); bottom = Math.min(bottom, b.bottom); right = Math.min(right, b.right);
  }
  for (const row of rows) {
    const b = row.getBoundingClientRect();
    if (b.width > 0 && b.height > 0 && b.bottom > top && b.top < bottom && b.right > left && b.left < right) return true;
  }
  return false;
}
