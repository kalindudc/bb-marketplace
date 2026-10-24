// The timeline's geometry as pure functions: folding quiet stretches, the time axis and its labels, and lookups by time.
// Type-only imports, so nothing here adds to the app bundle.
import type { TicketBar } from "../replay";
import type { TicketState } from "../states";

/** A stretch with no event for this long folds to a narrow band. */
export const FOLD_MS = 15 * 60_000;
const FOLD_PX = 16;
/** Round label steps, smallest first; the axis uses the first one at least this far apart. */
const TICK_STEPS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((minutes) => minutes * 60_000);
const TICK_PX = 92;
/** A fold this long moves the clock far enough that the time work resumed earns a label of its own. */
const RESUME_MS = 60 * 60_000;

type Span = { from: number; to: number };
export type Axis = { x(at: number): number; at(x: number): number; /** Pixels per millisecond outside the folds. */ scale: number };

/** Every gap of `minMs` or more between consecutive times, which are in order. */
export function foldsOf(times: readonly number[], minMs = FOLD_MS): Span[] {
  return times.flatMap((time, index) => {
    const next = times[index + 1];
    return next !== undefined && next - time >= minMs ? [{ from: time, to: next }] : [];
  });
}

/**
 * Maps time to x from `from` at 0 to `to` at `width`: each fold inside the window takes 16 pixels, or less when there are so
 * many that together they would take more than 40% of the width, and the unfolded time shares the rest.
 */
export function axisOf(folds: readonly Span[], from: number, to: number, width: number): Axis {
  const inside = folds.map((fold) => ({ from: Math.max(fold.from, from), to: Math.min(fold.to, to) })).filter((fold) => fold.to > fold.from);
  const folded = inside.reduce((sum, fold) => sum + fold.to - fold.from, 0);
  const foldPx = inside.length === 0 ? FOLD_PX : Math.min(FOLD_PX, (0.4 * width) / inside.length);
  const scale = Math.max(0, width - foldPx * inside.length) / Math.max(1, to - from - folded);
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
    add(fold.to, x + foldPx);
  }
  if (to > time || segments.length === 0) add(to, width);
  const last = segments.at(-1)!;
  last.x1 = width;
  const lerp = (value: number, a0: number, a1: number, b0: number, b1: number) => (a1 === a0 ? b0 : b0 + ((value - a0) / (a1 - a0)) * (b1 - b0));
  return {
    scale,
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

/**
 * Where the axis puts a label between its two ends, which the page labels itself: first the times work resumed after a fold of
 * an hour or more, because the clock jumps there, then round times. A label keeps `gap` pixels from its neighbours, stays
 * `startRoom` pixels from the start and `endRoom` from the end, and keeps clear of a fold by 4 minutes.
 */
export function ticksOf(folds: readonly Span[], from: number, to: number, axis: Axis, width: number, { gap = 76, startRoom = 130, endRoom = 80 } = {}): Array<{ x: number; at: number; resume: boolean }> {
  const step = TICK_STEPS.find((ms) => ms * axis.scale >= TICK_PX) ?? TICK_STEPS.at(-1)!;
  // Round in local time at each tick, so the labels stay on the hour across a daylight saving change.
  const roundUp = (at: number) => {
    const offset = new Date(at).getTimezoneOffset() * 60_000;
    return Math.ceil((at - offset) / step) * step + offset;
  };
  const near = (at: number) => folds.some((fold) => at > fold.from - 4 * 60_000 && at < fold.to + 4 * 60_000);
  const wanted = folds.filter((fold) => fold.to - fold.from >= RESUME_MS && fold.to < to).map((fold) => ({ at: fold.to, resume: true }));
  // The next label is a step later on the local clock, so none is skipped when the clocks go forward.
  const next = (at: number) => {
    const local = new Date(at);
    local.setMinutes(local.getMinutes() + step / 60_000);
    return roundUp(local.getTime());
  };
  for (let at = roundUp(from); at < to; at = next(at)) if (!near(at)) wanted.push({ at, resume: false });
  const kept: Array<{ x: number; at: number; resume: boolean }> = [];
  for (const tick of wanted) {
    const x = axis.x(tick.at);
    if (x < startRoom || x > width - endRoom || kept.some((other) => Math.abs(other.x - x) < gap)) continue;
    kept.push({ x, ...tick });
  }
  return kept.sort((a, b) => a.x - b.x);
}

/** The last index whose value is at or below `value`, in values that are in order; 0 before them all. */
export function lastIndexAt(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (values[middle]! <= value) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The index of the value nearest `value`, in values that are in order; -1 when there are none. */
export function nearestIndex(values: readonly number[], value: number): number {
  if (values.length === 0) return -1;
  const below = lastIndexAt(values, value);
  const above = Math.min(values.length - 1, below + 1);
  return Math.abs(values[above]! - value) < Math.abs(values[below]! - value) ? above : below;
}

/** A ticket's state at a time: queued before its first start, the part it was in, and how it finished after. */
export function stateAt(bar: TicketBar, at: number): TicketState {
  if (at < bar.from) return "queued";
  const part = bar.parts.find((entry) => at >= entry.from && at < entry.to);
  if (part !== undefined) return part.state;
  if (at >= bar.to && bar.final !== null) return bar.final;
  return bar.parts.at(-1)?.state ?? "queued";
}
