import type { TreeIndex } from "./drop-plan";

export interface Selection { ids: ReadonlySet<string>; anchor: string | null }
export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null };

export function toggleRow(selection: Selection, id: string): Selection {
  const ids = new Set(selection.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return ids.size ? { ids, anchor: ids.has(id) ? id : [...ids].at(-1)! } : EMPTY_SELECTION;
}

export function selectRange(selection: Selection, visibleIds: readonly string[], id: string): Selection {
  const end = visibleIds.indexOf(id);
  if (end < 0) return selection;
  const anchor = selection.anchor && visibleIds.includes(selection.anchor) ? selection.anchor : id;
  const start = visibleIds.indexOf(anchor);
  const ids = new Set(selection.ids);
  for (const current of visibleIds.slice(Math.min(start, end), Math.max(start, end) + 1)) ids.add(current);
  return { ids, anchor };
}

export type SelectionRun = "start" | "middle" | "end";

export function selectedRuns(groups: ReadonlyArray<readonly string[]>, selected: ReadonlySet<string>): ReadonlyMap<string, SelectionRun> {
  const runs = new Map<string, SelectionRun>();
  for (const ids of groups) {
    ids.forEach((id, position) => {
      if (!selected.has(id)) return;
      const before = position > 0 && selected.has(ids[position - 1]!);
      const after = position + 1 < ids.length && selected.has(ids[position + 1]!);
      if (before || after) runs.set(id, before ? after ? "middle" : "end" : "start");
    });
  }
  return runs;
}

export function selectionRoots(selection: Selection, index: TreeIndex): string[] {
  return index.visualIds.filter((id) => {
    if (!selection.ids.has(id)) return false;
    let parent = index.byId.get(id)?.parentId ?? null;
    while (parent) {
      if (selection.ids.has(parent)) return false;
      parent = index.byId.get(parent)?.parentId ?? null;
    }
    return true;
  });
}
