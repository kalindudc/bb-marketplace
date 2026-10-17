import type { PluginSidebarSection, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { defaultHue, type GroupKey, type HueId, type Layout } from "./layout";
import { EMPTY_COUNTS, rowState, worstState, type RowState, type StateCounts } from "./status";
import { isSnoozed, isStale, sortRoots } from "./triage";

export interface TreeNode {
  thread: PluginSidebarThread;
  state: RowState;
  depth: number;
  children: readonly TreeNode[];
  descendants: StateCounts;
  worstDescendant: RowState;
  matches: boolean;
  stale: boolean;
}
export interface Group {
  key: GroupKey;
  kind: "pinned" | "section" | "loose";
  section: PluginSidebarSection | null;
  hue: HueId | null;
  roots: readonly TreeNode[];
  threadCount: number;
  counts: StateCounts;
}

export const combineCounts = (left: StateCounts, right: StateCounts): StateCounts => ({
  failed: left.failed + right.failed, needs: left.needs + right.needs,
  running: left.running + right.running, unread: left.unread + right.unread,
});
const countOne = (state: RowState): StateCounts =>
  state === "idle" ? EMPTY_COUNTS : { ...EMPTY_COUNTS, [state]: 1 };
const countAll = (node: TreeNode): StateCounts => combineCounts(countOne(node.state), node.descendants);
const threadCount = (node: TreeNode): number => 1 + node.children.reduce((total, child) => total + threadCount(child), 0);

function pinnedSort(a: PluginSidebarThread, b: PluginSidebarThread): number {
  if (a.pinSortKey && b.pinSortKey) return a.pinSortKey.localeCompare(b.pinSortKey);
  return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

type ModelInput = {
  threads: readonly PluginSidebarThread[];
  sections: readonly PluginSidebarSection[];
  layout: Layout;
  now: number;
  staleDays: number;
};

export function buildGroups(input: Omit<ModelInput, "now" | "staleDays">): Group[] {
  return buildModel({ ...input, now: 0, staleDays: 0 }).groups;
}

export function buildModel(input: ModelInput): { groups: Group[]; snoozed: TreeNode[] } {
  const { layout, sections } = input;
  const visible = input.threads.filter((thread) => !thread.isHidden);
  const byId = new Map(visible.map((thread) => [thread.id, thread]));
  const sectionIds = new Set(sections.map((section) => section.id));
  const groupKey = (thread: PluginSidebarThread): GroupKey =>
    thread.isPinned ? "pinned" : thread.sectionId && sectionIds.has(thread.sectionId) ? `section:${thread.sectionId}` : "loose";
  const roots = visible.filter((thread) => !thread.parentThreadId || !byId.has(thread.parentThreadId));
  const children = new Map<string, PluginSidebarThread[]>();
  for (const thread of visible) {
    if (!thread.parentThreadId || !byId.has(thread.parentThreadId)) continue;
    const siblings = children.get(thread.parentThreadId) ?? [];
    siblings.push(thread);
    children.set(thread.parentThreadId, siblings);
  }
  const sort = (siblings: PluginSidebarThread[], container: string, oldestFirst = false) => {
    const saved = layout.order[container] ?? [];
    const positions = new Map(saved.map((id, index) => [id, index]));
    return siblings.sort((a, b) => {
      const left = positions.get(a.id), right = positions.get(b.id);
      if (left === undefined && right !== undefined) return -1;
      if (left !== undefined && right === undefined) return 1;
      if (left !== undefined && right !== undefined) return left - right;
      return (oldestFirst ? a.createdAt - b.createdAt : b.createdAt - a.createdAt) || a.id.localeCompare(b.id);
    });
  };
  const seen = new Set<string>();
  const makeNode = (thread: PluginSidebarThread, depth: number): TreeNode | null => {
    if (seen.has(thread.id)) return null;
    seen.add(thread.id);
    const nested = sort([...(children.get(thread.id) ?? [])], `parent:${thread.id}`, true)
      .map((child) => makeNode(child, depth + 1))
      .filter((node): node is TreeNode => node !== null);
    const descendants = nested.reduce((counts, child) => combineCounts(counts, countAll(child)), EMPTY_COUNTS);
    const node: TreeNode = { thread, state: rowState(thread), depth, children: nested, descendants,
      worstDescendant: worstState(nested.map((child) => worstState([child.state, child.worstDescendant]))),
      matches: true, stale: false };
    node.stale = isStale(node, input.now, input.staleDays);
    return node;
  };
  const rootThreads = [...roots];
  for (const thread of visible) if (!seen.has(thread.id)) {
    // A parent cycle has no natural root; the visited set also prevents a loop.
    let cursor: PluginSidebarThread | null = thread;
    const path = new Set<string>();
    while (cursor && !path.has(cursor.id) && !seen.has(cursor.id)) {
      path.add(cursor.id);
      cursor = cursor.parentThreadId ? byId.get(cursor.parentThreadId) ?? null : null;
    }
    if (!cursor || seen.has(cursor.id)) continue;
    if (!rootThreads.some((root) => root.id === cursor!.id)) rootThreads.push(cursor);
    makeNode(cursor, 0);
  }
  seen.clear();
  const grouped = new Map<GroupKey, PluginSidebarThread[]>();
  for (const root of rootThreads) grouped.set(groupKey(root), [...(grouped.get(groupKey(root)) ?? []), root]);
  const orderedSections = [...sections].sort((a, b) => {
    const ai = layout.sectionOrder.indexOf(a.id), bi = layout.sectionOrder.indexOf(b.id);
    if (ai < 0) return bi < 0 ? 0 : 1;
    if (bi < 0) return -1;
    return ai - bi;
  });
  const groupKeys: GroupKey[] = [
    ...(grouped.get("pinned")?.length ? ["pinned" as const] : []),
    ...orderedSections.map((section) => `section:${section.id}` as const), "loose",
  ];
  const snoozed: TreeNode[] = [];
  const groups = groupKeys.map((key): Group => {
    const section = key.startsWith("section:") ? sections.find((item) => item.id === key.slice(8)) ?? null : null;
    const candidates = [...(grouped.get(key) ?? [])];
    const ordered = key === "pinned" ? candidates.sort(pinnedSort) : sort(candidates, key);
    const active = ordered.map((thread) => makeNode(thread, 0)).filter((node): node is TreeNode => node !== null)
      .filter((node) => {
        if (!isSnoozed(node, layout.snoozes[node.thread.id], input.now)) return true;
        snoozed.push(node);
        return false;
      });
    const nodes = key === "pinned" ? active : sortRoots(active, layout.sectionSort[key] ?? "manual");
    return {
      key, kind: key === "pinned" ? "pinned" : section ? "section" : "loose", section,
      hue: section ? layout.sectionHues[section.id] ?? defaultHue(section.id) : null,
      roots: nodes, threadCount: nodes.reduce((total, node) => total + threadCount(node), 0),
      counts: nodes.reduce((counts, node) => combineCounts(counts, countAll(node)), EMPTY_COUNTS),
    };
  });
  return { groups, snoozed };
}
