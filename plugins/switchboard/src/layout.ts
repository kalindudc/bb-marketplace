export const LAYOUT_CHANNEL = "layout";
export const MAX_ENTRIES = 10_000;
export const MAX_KEY_LENGTH = 1024;
export const HUE_IDS = ["teal", "cyan", "indigo", "violet", "pink", "olive", "sand", "slate"] as const;
export type HueId = (typeof HUE_IDS)[number];
export type GroupKey = "pinned" | "loose" | `section:${string}`;
export type CollapseKey = GroupKey | `thread:${string}` | `lane:${import("./status").RowState}`;
export type ContainerKey = "loose" | `section:${string}` | `parent:${string}`;
export type SortMode = "manual" | "recent" | "status";
export interface SnoozeEntry { until: number; at: number }
export interface Layout {
  sectionOrder: readonly string[];
  sectionHues: Readonly<Record<string, HueId>>;
  collapsed: readonly string[];
  order: Readonly<Record<string, readonly string[]>>;
  sectionSort: Readonly<Record<string, SortMode>>;
  snoozes: Readonly<Record<string, SnoozeEntry>>;
  sectionProjects: Readonly<Record<string, string>>;
}
export const EMPTY_LAYOUT: Layout = { sectionOrder: [], sectionHues: {}, collapsed: [], order: {}, sectionSort: {}, snoozes: {},
  sectionProjects: {} };
export type LayoutPatch = { key: "collapsed" | "section-order" | `order:${string}`; value: readonly string[] }
  | { key: "section-hues"; value: Readonly<Record<string, HueId>> }
  | { key: "section-sort"; value: Readonly<Record<string, SortMode>> }
  | { key: "snoozes"; value: Readonly<Record<string, SnoozeEntry>> }
  | { key: "section-projects"; value: Readonly<Record<string, string>> };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_KEY_LENGTH && !/\s/.test(value);
const containerKey = (value: unknown): value is ContainerKey =>
  value === "loose" || (typeof value === "string" && value.length <= MAX_KEY_LENGTH && /^(section|parent):\S+$/.test(value));
const sortableKey = (value: string): boolean => value === "loose" ||
  (value.length <= MAX_KEY_LENGTH && /^section:\S+$/.test(value));
const sortMode = (value: unknown): value is SortMode => value === "recent" || value === "status";
const snoozeEntry = (value: unknown): value is SnoozeEntry => record(value) &&
  Number.isSafeInteger(value.until) && (value.until as number) >= 0 &&
  Number.isSafeInteger(value.at) && (value.at as number) >= 0;

export function isCollapseKey(value: unknown): value is CollapseKey {
  return value === "pinned" || value === "loose" ||
    (typeof value === "string" && value.length <= MAX_KEY_LENGTH &&
      (/^(section|thread):\S+$/.test(value) || /^lane:(failed|needs|running|unread|idle)$/.test(value)));
}

const validList = (value: unknown, check: (item: unknown) => boolean): string[] =>
  Array.isArray(value) ? [...new Set(value.slice(0, MAX_ENTRIES).filter(check) as string[])] : [];

export function parseLayout(value: unknown): Layout {
  if (!record(value)) return EMPTY_LAYOUT;
  const hues: Record<string, HueId> = {};
  if (record(value.sectionHues)) {
    for (const [key, hue] of Object.entries(value.sectionHues).slice(0, MAX_ENTRIES)) {
      if (id(key) && HUE_IDS.some((candidate) => candidate === hue)) hues[key] = hue as HueId;
    }
  }
  const order: Record<string, readonly string[]> = {};
  if (record(value.order)) {
    for (const [key, entries] of Object.entries(value.order).slice(0, MAX_ENTRIES)) {
      if (containerKey(key) && Array.isArray(entries)) order[key] = validList(entries, id);
    }
  }
  const sectionSort: Record<string, SortMode> = {};
  if (record(value.sectionSort)) for (const [key, mode] of Object.entries(value.sectionSort).slice(0, MAX_ENTRIES)) {
    if (sortableKey(key) && sortMode(mode)) sectionSort[key] = mode;
  }
  const snoozes: Record<string, SnoozeEntry> = {};
  if (record(value.snoozes)) for (const [key, entry] of Object.entries(value.snoozes).slice(0, MAX_ENTRIES)) {
    if (id(key) && snoozeEntry(entry)) snoozes[key] = { until: entry.until, at: entry.at };
  }
  const sectionProjects: Record<string, string> = {};
  if (record(value.sectionProjects)) for (const [key, projectId] of Object.entries(value.sectionProjects).slice(0, MAX_ENTRIES)) {
    if (sortableKey(key) && id(projectId)) sectionProjects[key] = projectId;
  }
  return {
    sectionOrder: validList(value.sectionOrder, id), sectionHues: hues,
    collapsed: validList(value.collapsed, isCollapseKey), order, sectionSort, snoozes, sectionProjects,
  };
}

export function applyLayoutPatch(layout: Layout, patch: unknown): Layout {
  if (!record(patch) || typeof patch.key !== "string") return layout;
  if (patch.key === "section-hues") {
    if (!record(patch.value) || Object.keys(patch.value).length > MAX_ENTRIES ||
      Object.entries(patch.value).some(([key, value]) => !id(key) || !HUE_IDS.some((hue) => hue === value))) return layout;
    return { ...layout, sectionHues: patch.value as Record<string, HueId> };
  }
  if (patch.key === "section-sort" || patch.key === "snoozes") {
    if (!record(patch.value) || Object.keys(patch.value).length > MAX_ENTRIES) return layout;
    const valid = patch.key === "section-sort" ?
      Object.entries(patch.value).every(([key, mode]) => sortableKey(key) && sortMode(mode)) :
      Object.entries(patch.value).every(([key, entry]) => id(key) && snoozeEntry(entry));
    return valid ? { ...layout, [patch.key === "section-sort" ? "sectionSort" : "snoozes"]: patch.value } : layout;
  }
  if (patch.key === "section-projects") {
    if (!record(patch.value) || Object.keys(patch.value).length > MAX_ENTRIES ||
      !Object.entries(patch.value).every(([key, projectId]) => sortableKey(key) && id(projectId))) return layout;
    return { ...layout, sectionProjects: patch.value as Record<string, string> };
  }
  if (!Array.isArray(patch.value) || patch.value.length > MAX_ENTRIES) return layout;
  if (patch.key === "collapsed") {
    if (patch.value.some((entry) => !isCollapseKey(entry))) return layout;
    return { ...layout, collapsed: validList(patch.value, isCollapseKey) };
  }
  if (patch.key === "section-order") {
    if (patch.value.some((entry) => !id(entry))) return layout;
    return { ...layout, sectionOrder: validList(patch.value, id) };
  }
  if (patch.key.startsWith("order:") && containerKey(patch.key.slice(6)) &&
    patch.value.every(id)) {
    const order = { ...layout.order };
    const ids = validList(patch.value, id);
    if (ids.length) order[patch.key.slice(6)] = ids;
    else delete order[patch.key.slice(6)];
    return { ...layout, order };
  }
  return layout;
}

export function defaultHue(sectionId: string): HueId {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sectionId.length; index++) {
    hash = Math.imul(hash ^ sectionId.charCodeAt(index), 0x01000193) >>> 0;
  }
  return HUE_IDS[hash % (HUE_IDS.length - 1)];
}

// Slate stays out of the choices, as it does for defaultHue.
export function leastUsedHue(sectionIds: readonly string[], overrides: Readonly<Record<string, HueId>>): HueId {
  const uses = new Map<HueId, number>();
  for (const id of sectionIds) {
    const hue = overrides[id] ?? defaultHue(id);
    uses.set(hue, (uses.get(hue) ?? 0) + 1);
  }
  return HUE_IDS.slice(0, -1).reduce((best, hue) => (uses.get(hue) ?? 0) < (uses.get(best) ?? 0) ? hue : best);
}
