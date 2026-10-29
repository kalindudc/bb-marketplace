import { useMemo } from "react";
import { createStored, useStored } from "./remember";
import { formatRoute, parseRoute, type Route } from "./route";
import { DONE_SORTS, MINE_SORTS, type SortKey } from "./sort";
import { BOARD_GROUP_LABELS, BOARD_SORT_LABELS, DEFAULT_BOARD_VIEW, type BoardGrouping, type BoardSort, type BoardViewPrefs } from "./board-prs";

// What the page remembers on this device, so it opens where it was left and the way it was left.

export type MineLayout = "grouped" | "list";

export interface ReviewFilter {
  team: string;
  hideBots: boolean;
  hideQuiet: boolean;
}

export const DEFAULT_FILTER: ReviewFilter = { team: "all", hideBots: true, hideQuiet: true };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(options: readonly T[]) => (value: unknown): T | null => (options.includes(value as T) ? (value as T) : null);

/** The page's last subPath, selected PR included; opening Shuttle at its root goes back there. */
export const lastRoute = createStored<string | null>("last-route", null, (value) => (typeof value === "string" && value !== "" ? formatRoute(parseRoute(value)) || null : null));
export const mineLayout = createStored<MineLayout>("mine-layout", "grouped", oneOf<MineLayout>(["grouped", "list"]));
export const mineSort = createStored<SortKey>("mine-sort", MINE_SORTS[0]!, oneOf(MINE_SORTS));
export const doneSort = createStored<SortKey>("done-sort", DONE_SORTS[0]!, oneOf(DONE_SORTS));
export const boardViews = createStored<Readonly<Record<string, BoardViewPrefs>>>("board-views", {}, (value) => {
  if (!isRecord(value)) return null;
  const parseSort = oneOf<BoardSort>(Object.keys(BOARD_SORT_LABELS) as BoardSort[]);
  const parseGroup = oneOf<BoardGrouping>(Object.keys(BOARD_GROUP_LABELS) as BoardGrouping[]);
  return Object.fromEntries(Object.entries(value).flatMap(([id, prefs]) => isRecord(prefs) ? [[id, {
    sort: parseSort(prefs.sort) ?? DEFAULT_BOARD_VIEW.sort,
    group: parseGroup(prefs.group) ?? DEFAULT_BOARD_VIEW.group,
  }]] : []));
});
export const reviewFilter = createStored<ReviewFilter>("review-filter", DEFAULT_FILTER, (value) =>
  isRecord(value) && typeof value.team === "string" && typeof value.hideBots === "boolean" && typeof value.hideQuiet === "boolean"
    ? { team: value.team, hideBots: value.hideBots, hideQuiet: value.hideQuiet }
    : null);
/** Sections folded by hand, as "<area>/<title>"; every other section is open. */
export const folds = createStored<readonly string[]>("folds", [], (value) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null));

const MAX_SCROLLS = 30;
/** How far each list was scrolled, by its subPath without a selected PR. */
export const scrolls = createStored<Readonly<Record<string, number>>>("scroll", {}, (value) => {
  if (!isRecord(value)) return null;
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] >= 0));
}, 250);

export function rememberScroll(key: string, top: number): void {
  const current = scrolls.get();
  if (current[key] === top) return;
  // The list scrolled last goes to the end, so the oldest drop first; every search keeps its own position.
  const { [key]: _old, ...rest } = current;
  const entries = Object.entries(rest);
  scrolls.set(Object.fromEntries([...entries.slice(Math.max(0, entries.length - MAX_SCROLLS + 1)), [key, top]]));
}

const MAX_PANEL_PRS = 50;
/** The PR each thread's Shuttle tab shows in full, by thread id; a thread without one shows its list. */
export const panelPrs = createStored<Readonly<Record<string, string>>>("panel-pr", {}, (value) => {
  if (!isRecord(value)) return null;
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
});

export function rememberPanelPr(threadId: string, key: string | null): void {
  const current = panelPrs.get();
  if ((current[threadId] ?? null) === key) return;
  const { [threadId]: _old, ...rest } = current;
  if (key === null) return panelPrs.set(rest);
  // The thread opened last goes to the end, so the oldest drop first.
  const entries = Object.entries(rest);
  panelPrs.set(Object.fromEntries([...entries.slice(Math.max(0, entries.length - MAX_PANEL_PRS + 1)), [threadId, key]]));
}

/** The page's route; at the root, the route it was last left on. */
export function routeOf(subPath: string): Route {
  return parseRoute(subPath === "" ? lastRoute.get() ?? "" : subPath);
}

export interface Folding {
  folded(title: string): boolean;
  toggle(title: string): void;
  setAll(titles: readonly string[], folded: boolean): void;
}

/** Folded sections of one area, such as "mine" or "reviews". */
export function useFolding(area: string): Folding {
  const stored = useStored(folds);
  return useMemo(() => {
    const keyOf = (title: string) => `${area}/${title}`;
    const set = new Set(stored);
    const setAll = (titles: readonly string[], folded: boolean) => {
      const next = new Set(folds.get());
      for (const title of titles) {
        if (folded) next.add(keyOf(title));
        else next.delete(keyOf(title));
      }
      folds.set([...next]);
    };
    return {
      folded: (title) => set.has(keyOf(title)),
      toggle: (title) => setAll([title], !set.has(keyOf(title))),
      setAll,
    };
  }, [area, stored]);
}

/** Tests clear localStorage between cases; this reads every remembered value again. */
export function reloadPrefs(): void {
  for (const stored of [lastRoute, mineLayout, mineSort, doneSort, boardViews, reviewFilter, folds, scrolls, panelPrs]) stored.reload();
}
