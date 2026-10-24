// The Insights activity chart's geometry as pure functions: buckets of equal clock time, quiet stretches folded between
// them, and the labels under them. Buckets start and end on the reader's local clock, so across a daylight saving change a
// bucket still starts on the hour (and is an hour shorter or longer).

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Bucket sizes, smallest first; the chart uses the first that keeps the bars at a readable count for its width. */
const BUCKETS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((minutes) => minutes * MIN);
/** Width of a folded quiet stretch. */
export const FOLD_PX = 26;
/** Label steps, smallest first; a label goes on a bucket that starts on a round multiple of the step. */
const LABEL_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((minutes) => minutes * MIN);
const LABEL_PX = 70;

export interface Bucket {
  from: number;
  to: number;
  x: number;
  w: number;
}

export interface Fold {
  from: number;
  to: number;
  x: number;
  w: number;
}

export interface ActivityAxis {
  bucket: number;
  buckets: Bucket[];
  folds: Fold[];
  /** Where a time falls; a time in a fold is its middle. */
  x(at: number): number;
}

/** The start of the local-clock bucket of `size` that holds `at`. */
export function floorLocal(at: number, size: number): number {
  const date = new Date(at);
  if (size >= DAY) return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (size >= HOUR) {
    const hours = size / HOUR;
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(date.getHours() / hours) * hours).getTime();
  }
  const minutes = size / MIN;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), Math.floor(date.getMinutes() / minutes) * minutes).getTime();
}

/**
 * The next local-clock bucket start after `from`: the next cell of the grid, not `from` plus the size, so a bucket that
 * a spring-forward gap moved to 3:00 is followed by 4:00 on a two-hour grid, not 5:00.
 */
export function nextLocal(from: number, size: number): number {
  const date = new Date(from);
  const hours = size / HOUR;
  const minutes = size / MIN;
  const next =
    size >= DAY
      ? new Date(date.getFullYear(), date.getMonth(), date.getDate() + size / DAY)
      : size >= HOUR
        ? new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(date.getHours() / hours) * hours + hours)
        : new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), Math.floor(date.getMinutes() / minutes) * minutes + minutes);
  // A clock that falls back can name the same hour twice; the bucket still moves on.
  return next.getTime() > from ? next.getTime() : from + size;
}

/**
 * Groups `times` (in order) into stretches split where nothing happened for a while, picks a bucket size from the time
 * the stretches cover and the width, snaps each stretch to whole buckets and folds the gaps between them. The buckets
 * share the width less the folds, so the last one ends at `width`.
 */
export function activityAxis(times: readonly number[], start: number, end: number, width: number): ActivityAxis {
  const all = [start, ...times.filter((at) => at >= start && at <= end), end].sort((a, b) => a - b);
  const total = Math.max(MIN, end - start);
  const gap = Math.max(25 * MIN, total / 14);
  const stretches: Array<[number, number]> = [];
  let from = all[0]!;
  let last = all[0]!;
  for (const at of all.slice(1)) {
    if (at - last > gap) {
      stretches.push([from, last]);
      from = at;
    }
    last = at;
  }
  stretches.push([from, last]);
  const covered = stretches.reduce((sum, [a, b]) => sum + Math.max(b - a, MIN), 0);
  const most = Math.max(24, Math.min(64, width / 14));
  const bucket = BUCKETS.find((size) => covered / size <= most) ?? DAY;
  // Each stretch as whole buckets; stretches whose buckets touch become one.
  const runs: Array<Array<{ from: number; to: number }>> = [];
  for (const [a, b] of stretches) {
    const run: Array<{ from: number; to: number }> = [];
    for (let at = floorLocal(a, bucket); at <= b; ) {
      const to = nextLocal(at, bucket);
      run.push({ from: at, to });
      at = to;
    }
    const before = runs.at(-1);
    if (before !== undefined && run[0]!.from <= before.at(-1)!.from) {
      for (const entry of run) if (entry.from > before.at(-1)!.from) before.push(entry);
    } else if (before !== undefined && run[0]!.from === before.at(-1)!.to) before.push(...run);
    else runs.push(run);
  }
  const count = runs.reduce((sum, run) => sum + run.length, 0);
  const foldPx = runs.length <= 1 ? FOLD_PX : Math.min(FOLD_PX, (0.3 * width) / (runs.length - 1));
  const barW = Math.max(0, width - foldPx * (runs.length - 1)) / Math.max(1, count);
  const buckets: Bucket[] = [];
  const folds: Fold[] = [];
  let x = 0;
  runs.forEach((run, index) => {
    if (index > 0) {
      folds.push({ from: runs[index - 1]!.at(-1)!.to, to: run[0]!.from, x, w: foldPx });
      x += foldPx;
    }
    for (const entry of run) {
      buckets.push({ ...entry, x, w: barW });
      x += barW;
    }
  });
  return {
    bucket,
    buckets,
    folds,
    x(at) {
      const fold = folds.find((entry) => at >= entry.from && at < entry.to);
      if (fold !== undefined) return fold.x + fold.w / 2;
      const found = buckets.find((entry) => at >= entry.from && at < entry.to);
      if (found !== undefined) return found.x + ((at - found.from) / (found.to - found.from)) * found.w;
      return at < (buckets[0]?.from ?? start) ? 0 : width;
    },
  };
}

/** Whether a local time sits on a round multiple of `step` on the clock: midnight for a day, the hour for hours. */
function onStep(at: number, step: number): boolean {
  const date = new Date(at);
  if (step >= DAY) return date.getHours() === 0 && date.getMinutes() === 0;
  if (step >= HOUR) return date.getMinutes() === 0 && date.getHours() % (step / HOUR) === 0;
  return date.getMinutes() % (step / MIN) === 0;
}

const dayOf = (at: number) => new Date(at).toDateString();

/**
 * Where labels go: the first bucket always, even where it crowds a fold; then the first bucket of each later stretch and
 * buckets that start on a round step at least 70 pixels apart, when they fit. A label keeps clear of its neighbours, the
 * next fold and the end. `date` is true for the first label and whenever the local day changes since the label before, and
 * the caller measures each label's text with it.
 */
export function labelsOf(axis: ActivityAxis, width: number, widthOf: (at: number, date: boolean) => number): Array<{ x: number; at: number; date: boolean }> {
  const step = LABEL_STEPS.find((size) => size >= axis.bucket && (size / axis.bucket) * (axis.buckets[0]?.w ?? 0) >= LABEL_PX) ?? DAY;
  const out: Array<{ x: number; at: number; date: boolean }> = [];
  let end = -Infinity;
  let previous: Bucket | null = null;
  for (const bucket of axis.buckets) {
    const first = previous === null || previous.to !== bucket.from;
    previous = bucket;
    if (!first && !onStep(bucket.from, step)) continue;
    const date = out.length === 0 || dayOf(out.at(-1)!.at) !== dayOf(bucket.from);
    const w = widthOf(bucket.from, date);
    const nextFold = axis.folds.find((fold) => fold.x >= bucket.x);
    const head = out.length === 0;
    if (!head && (bucket.x < end + 10 || bucket.x + w > width || (nextFold !== undefined && nextFold.x < bucket.x + w + 4))) continue;
    out.push({ x: bucket.x, at: bucket.from, date });
    end = bucket.x + w;
  }
  return out;
}

/** The value of a step function, given as [time, value] pairs in order, at `at`; 0 before the first. */
export function stepAt(steps: ReadonlyArray<readonly [number, number]>, at: number): number {
  let value = 0;
  for (const [time, count] of steps) {
    if (time > at) break;
    value = count;
  }
  return value;
}

/** The largest value a step function takes from `from` up to `to`. */
export function stepMax(steps: ReadonlyArray<readonly [number, number]>, from: number, to: number): number {
  let most = stepAt(steps, from);
  for (const [time, count] of steps) if (time > from && time < to) most = Math.max(most, count);
  return most;
}
