/**
 * Which of the visible rows the log draws. Entry ids keep a window in place while rows arrive at either
 * end. A window with no start draws the last `count` rows, one page when `count` is null, and a window
 * with no end runs through the newest row.
 */
export interface RenderWindow {
  startId: string | null;
  endId: string | null;
  count: number | null;
}

/** Visible indexes of the drawn rows; `end` is exclusive. */
export interface RowRange {
  start: number;
  end: number;
}

interface Row {
  id: string;
}

/** Where each entry sits in the full, unfiltered list, so a window survives a filter that hides its edge rows. */
export type EntryOrder = ReadonlyMap<string, number>;

export const LATEST_WINDOW: RenderWindow = { startId: null, endId: null, count: null };

export const sameWindow = (left: RenderWindow, right: RenderWindow) =>
  left.startId === right.startId && left.endId === right.endId && left.count === right.count;

// The first visible index whose entry sits at or after `position` in the full list.
function firstAtOrAfter(visible: readonly Row[], order: EntryOrder, position: number): number {
  let low = 0;
  let high = visible.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((order.get(visible[middle]!.id) ?? -1) < position) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** How many visible rows come after `id`, which need not be visible itself; 0 when it is gone. */
export function rowsAfter(visible: readonly Row[], order: EntryOrder, id: string): number {
  const position = order.get(id);
  return position === undefined ? 0 : visible.length - firstAtOrAfter(visible, order, position + 1);
}

function around(index: number, length: number, pageRows: number): RowRange {
  const start = Math.max(0, Math.min(index - Math.floor(pageRows / 2), length - pageRows));
  return { start, end: Math.min(length, start + pageRows) };
}

/** The rows `window` draws, never more than `maxRows` of them. */
export function resolveRange(
  window: RenderWindow, visible: readonly Row[], order: EntryOrder, pageRows: number, maxRows: number,
): RowRange {
  const length = visible.length;
  const endPosition = window.endId === null ? undefined : order.get(window.endId);
  let end = endPosition === undefined ? length : firstAtOrAfter(visible, order, endPosition + 1);
  const startPosition = window.startId === null ? undefined : order.get(window.startId);
  if (startPosition === undefined) {
    return { start: Math.max(0, end - Math.min(maxRows, window.count ?? pageRows)), end };
  }
  const start = Math.min(firstAtOrAfter(visible, order, startPosition), length);
  // A filter can leave no visible row between the edges; the reader then sees the page around them.
  if (start >= end) return length === 0 ? { start: 0, end: 0 } : around(Math.min(start, length - 1), length, pageRows);
  end = Math.min(end, start + maxRows);
  return { start, end };
}

function windowOf(range: RowRange, visible: readonly Row[]): RenderWindow {
  return {
    startId: visible[range.start]?.id ?? null,
    endId: range.end >= visible.length ? null : visible[range.end - 1]!.id,
    count: null,
  };
}

/** The same rows, held by their first row so new rows only add to the end. */
export function holdWindow(range: RowRange, visible: readonly Row[]): RenderWindow {
  return { ...windowOf(range, visible), endId: null };
}

/** One page more above, dropping rows from the bottom past `maxRows`; null when nothing is above. */
export function windowUp(
  window: RenderWindow, range: RowRange, visible: readonly Row[], pageRows: number, maxRows: number,
): RenderWindow | null {
  if (range.start === 0) return null;
  const start = Math.max(0, range.start - pageRows);
  if (window.startId === null && window.endId === null) {
    const count = Math.min(maxRows, range.end - start);
    return count === range.end - range.start ? null : { ...window, count };
  }
  const end = Math.min(range.end, start + maxRows);
  return { startId: visible[start]!.id, endId: end === range.end ? window.endId : visible[end - 1]!.id, count: null };
}

/** One page more below, dropping rows from the top past `maxRows`; null when the newest row is drawn. */
export function windowDown(range: RowRange, visible: readonly Row[], pageRows: number, maxRows: number): RenderWindow | null {
  if (range.end >= visible.length) return null;
  const end = Math.min(visible.length, range.end + pageRows);
  return windowOf({ start: Math.max(range.start, end - maxRows), end }, visible);
}

/** A page of rows centred on `index`. */
export function windowAround(index: number, visible: readonly Row[], pageRows: number): RenderWindow {
  return windowOf(around(index, visible.length, pageRows), visible);
}

/** A window that also draws `index`: one page further when it is near the drawn rows, otherwise a page around it. */
export function windowWith(
  index: number, window: RenderWindow, range: RowRange, visible: readonly Row[], pageRows: number, maxRows: number,
): RenderWindow | null {
  if (index >= range.start && index < range.end) return null;
  const near = index < range.start
    ? range.start - index <= pageRows && windowUp(window, range, visible, pageRows, maxRows)
    : index - range.end < pageRows && windowDown(range, visible, pageRows, maxRows);
  return near || windowAround(index, visible, pageRows);
}
