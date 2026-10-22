// The timeline's geometry as pure functions: packing bars into rows, folding quiet stretches and the time axis.
// Type-only imports, so nothing here adds to the app bundle.
import type { ProjectTimeline } from "../replay";
import type { TicketState } from "../states";

/** A stretch with no event for this long folds to a narrow band. */
export const FOLD_MS = 15 * 60_000;
const FOLD_PX = 16;
const ROW_GAP_MS = 30_000;

type Span = { from: number; to: number };

/** Each bar, in start order, takes the first row whose last bar ended at least 30 seconds before it starts. */
export function packRows<T extends Span>(bars: readonly T[]): { rows: number; bars: Array<T & { row: number }> } {
  const ends: number[] = [];
  const packed = [...bars]
    .sort((a, b) => a.from - b.from)
    .map((bar) => {
      let row = ends.findIndex((end) => end + ROW_GAP_MS <= bar.from);
      if (row < 0) row = ends.length;
      ends[row] = bar.to;
      return { ...bar, row };
    });
  return { rows: ends.length, bars: packed };
}

/** Every gap of `minMs` or more between consecutive times, which are in order. */
export function foldsOf(times: readonly number[], minMs = FOLD_MS): Span[] {
  return times.flatMap((time, index) => {
    const next = times[index + 1];
    return next !== undefined && next - time >= minMs ? [{ from: time, to: next }] : [];
  });
}

/** Maps time to x from `from` at 0 to `to` at `width`: each fold inside the window takes 16 pixels and the unfolded time shares the rest. */
export function axisOf(folds: readonly Span[], from: number, to: number, width: number): { x(at: number): number; at(x: number): number } {
  const inside = folds.map((fold) => ({ from: Math.max(fold.from, from), to: Math.min(fold.to, to) })).filter((fold) => fold.to > fold.from);
  const folded = inside.reduce((sum, fold) => sum + fold.to - fold.from, 0);
  const scale = Math.max(0, width - FOLD_PX * inside.length) / Math.max(1, to - from - folded);
  const segments: Array<{ t0: number; t1: number; x0: number; x1: number }> = [];
  let time = from;
  let x = 0;
  const add = (t1: number, x1: number) => {
    segments.push({ t0: time, t1, x0: x, x1 });
    time = t1;
    x = x1;
  };
  for (const fold of inside) {
    if (fold.from > time) add(fold.from, x + (fold.from - time) * scale);
    add(fold.to, x + FOLD_PX);
  }
  if (to > time || segments.length === 0) add(to, width);
  const last = segments.at(-1)!;
  last.x1 = width;
  const lerp = (value: number, a0: number, a1: number, b0: number, b1: number) => (a1 === a0 ? b0 : b0 + ((value - a0) / (a1 - a0)) * (b1 - b0));
  return {
    x(at) {
      if (at <= from) return 0;
      if (at >= to) return width;
      const segment = segments.find((entry) => at <= entry.t1) ?? last;
      return lerp(at, segment.t0, segment.t1, segment.x0, segment.x1);
    },
    at(position) {
      if (position <= 0) return from;
      if (position >= width) return to;
      const segment = segments.find((entry) => position <= entry.x1) ?? last;
      return lerp(position, segment.x0, segment.x1, segment.t0, segment.t1);
    },
  };
}

/** The last index whose time is at or before `at`; 0 before the first event. */
export function eventIndexAt(events: ReadonlyArray<readonly [number, number]>, at: number): number {
  let low = 0;
  let high = events.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (events[middle]![1] <= at) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The ticket counts after the last ticket event at or before `at`. */
export function countsAt(flow: ProjectTimeline["flow"], at: number): Partial<Record<TicketState, number>> {
  let found: Partial<Record<TicketState, number>> = {};
  for (const entry of flow) {
    if (entry.at > at) break;
    found = entry.counts;
  }
  return found;
}
