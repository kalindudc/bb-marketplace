import type { TimelineDelta, TimelinePage, TimelineRow } from "./types";

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

export function applyDelta(previous: readonly TimelineRow[], delta: TimelineDelta): readonly TimelineRow[] | null {
  if (delta.upsertRows.length === 0 && delta.rowOrder === undefined) return previous;

  const byId = new Map(previous.map((row) => [row.id, row]));
  for (const row of delta.upsertRows) byId.set(row.id, row);
  const ids = delta.rowOrder ?? previous.map((row) => row.id);
  if (delta.rowOrder === undefined && delta.upsertRows.some((row) => !ids.includes(row.id))) return null;

  const next: TimelineRow[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) return null;
    next.push(row);
  }
  return sameRows(previous, next) ? previous : next;
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
