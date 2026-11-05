import type {
  ActiveThinking, TimelineDelta, TimelineDeltaResponse, TimelinePage, TimelineResponse, TimelineRow,
} from "./types";

/** What the log keeps of the server's latest window, so it can apply the next delta to it. */
export interface LatestWindow {
  tag: string;
  maxSeq: number;
  rows: readonly TimelineRow[];
  timelinePage: TimelinePage;
  activeThinking: ActiveThinking | null;
}

export function windowOf(response: TimelineResponse): LatestWindow {
  const { tag, maxSeq, rows, timelinePage, activeThinking } = response;
  return { tag, maxSeq, rows, timelinePage, activeThinking };
}

export function childRowsOf(row: TimelineRow): readonly TimelineRow[] | null {
  if (row.kind === "turn") return row.children;
  if (row.kind === "work" && row.workKind === "delegation") return row.childRows;
  return null;
}

function sameRows(left: readonly TimelineRow[], right: readonly TimelineRow[]): boolean {
  return left.length === right.length && left.every((row, index) => row === right[index]);
}

function joinChildren(older: TimelineRow, newer: TimelineRow): TimelineRow {
  if (older.kind === "turn" && newer.kind === "turn" && older.children && newer.children) {
    const children = prependOlderRows(older.children, newer.children);
    return sameRows(children, newer.children) ? newer : { ...newer, children };
  }
  if (
    older.kind === "work" && older.workKind === "delegation" &&
    newer.kind === "work" && newer.workKind === "delegation" &&
    older.childRows && newer.childRows
  ) {
    const childRows = prependOlderRows(older.childRows, newer.childRows);
    return sameRows(childRows, newer.childRows) ? newer : { ...newer, childRows };
  }
  return newer;
}

export function prependOlderRows(older: readonly TimelineRow[], loaded: readonly TimelineRow[]): TimelineRow[] {
  const uniqueLoaded: TimelineRow[] = [];
  const loadedIds = new Set<string>();
  for (const row of loaded) {
    if (loadedIds.has(row.id)) continue;
    loadedIds.add(row.id);
    uniqueLoaded.push(row);
  }
  const olderById = new Map<string, TimelineRow>();
  const result: TimelineRow[] = [];

  for (const row of older) {
    if (olderById.has(row.id)) continue;
    olderById.set(row.id, row);
    if (!loadedIds.has(row.id)) result.push(row);
  }
  for (const row of uniqueLoaded) {
    const previous = olderById.get(row.id);
    result.push(previous ? joinChildren(previous, row) : row);
  }
  return result;
}

/**
 * Applies a delta's rows to the window it was computed from, as bb's own client does: `rowOrder`
 * lists runs `[start, count]` of the previous rows and the ids of new ones, and is left out when the
 * order did not change. Returns null when the delta does not fit `previous`.
 */
export function applyDelta(
  previous: readonly TimelineRow[],
  delta: Pick<TimelineDelta, "upsertRows" | "rowOrder">,
): readonly TimelineRow[] | null {
  const upserts = new Map(delta.upsertRows.map((row) => [row.id, row]));
  let used = 0;
  const current = (row: TimelineRow): TimelineRow => {
    const upsert = upserts.get(row.id);
    if (upsert === undefined) return row;
    used++;
    return upsert;
  };
  let next: TimelineRow[];
  if (delta.rowOrder === undefined) {
    next = previous.map(current);
  } else {
    next = [];
    for (const part of delta.rowOrder) {
      if (typeof part === "string") {
        const row = upserts.get(part);
        if (row === undefined) return null;
        used++;
        next.push(row);
        continue;
      }
      const [start, count] = part;
      for (let index = start; index < start + count; index++) {
        const row = previous[index];
        if (row === undefined) return null;
        next.push(current(row));
      }
    }
  }
  if (used !== upserts.size) return null;
  return sameRows(previous, next) ? previous : next;
}

function patchPage(page: TimelinePage, patch: TimelineDelta["fields"]["timelinePage"]): TimelinePage {
  if (patch === undefined) return page;
  const { olderRowUpdates, ...fields } = patch;
  const { olderRowUpdates: previousUpdates, ...rest } = page;
  // A null olderRowUpdates means the new window has none.
  const updates = olderRowUpdates === undefined ? previousUpdates : olderRowUpdates ?? undefined;
  return { ...rest, ...fields, ...(updates === undefined ? {} : { olderRowUpdates: updates }) };
}

/** The window after `response`, or null when the delta was computed from another window or does not fit this one. */
export function applyWindowDelta(previous: LatestWindow, response: TimelineDeltaResponse): LatestWindow | null {
  const { delta } = response;
  if (delta.afterTag !== previous.tag) return null;
  const rows = applyDelta(previous.rows, delta);
  if (rows === null) return null;
  const { activeThinking, timelinePage } = delta.fields;
  return {
    tag: response.tag,
    maxSeq: response.maxSeq,
    rows,
    timelinePage: patchPage(previous.timelinePage, timelinePage),
    activeThinking: activeThinking === undefined ? previous.activeThinking : activeThinking,
  };
}

export function spliceLatestWindow(
  loaded: readonly TimelineRow[],
  window: readonly TimelineRow[],
  page: TimelinePage,
): readonly TimelineRow[] | null {
  const loadedById = new Map(loaded.map((row) => [row.id, row]));
  const start = page.olderCursor === null ? 0 : loaded.findIndex((row) => row.id === window[0]?.id);
  if (start < 0) return null;

  const updates = new Map(page.olderRowUpdates?.map((row) => [row.id, row]));
  const next: TimelineRow[] = loaded.slice(0, start).map((row) => {
    const update = updates.get(row.id);
    return update ? joinChildren(row, update) : row;
  });
  for (const row of window) {
    const older = loadedById.get(row.id);
    next.push(older ? joinChildren(older, row) : row);
  }
  return sameRows(next, loaded) ? loaded : next;
}
