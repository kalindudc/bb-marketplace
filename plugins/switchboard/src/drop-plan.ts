import type { CollapseKey, ContainerKey, GroupKey, SortMode } from "./layout";
import type { RowInstruction } from "./drop-geometry";
import type { Group, TreeNode } from "./tree";

export const MAX_DEPTH = 4;
export type DropTarget = { kind: "row"; threadId: string; instruction: RowInstruction } | { kind: "group"; key: GroupKey };
export type CoreWrite = { kind: "update"; threadId: string; parentThreadId?: string | null; sectionId?: string | null }
  | { kind: "pin" | "unpin"; threadId: string }
  | { kind: "reorderPinned"; threadId: string; previousThreadId: string | null; nextThreadId: string | null };
export interface OrderWrite { container: ContainerKey; ids: readonly string[] }
export interface Move { threadId: string; title: string; fromParent: string | null; toParent: string | null }
export type DropPlan = { ok: true; writes: readonly CoreWrite[]; orders: readonly OrderWrite[];
  expand: readonly CollapseKey[]; moves: readonly Move[]; summary: string }
  | { ok: false; reason: string } | { ok: "noop" };
export type IndexedContainer = ContainerKey | "pinned";
export interface IndexedThread {
  node: TreeNode;
  parentId: string | null;
  depth: number;
  height: number;
  groupKey: GroupKey;
  container: IndexedContainer;
  siblings: readonly string[];
}
export interface TreeIndex {
  byId: ReadonlyMap<string, IndexedThread>;
  containers: ReadonlyMap<IndexedContainer, readonly string[]>;
  groups: readonly Group[];
  visualIds: readonly string[];
  sectionSort: Readonly<Record<string, SortMode>>;
}

export function indexGroups(groups: readonly Group[], sectionSort: Readonly<Record<string, SortMode>> = {}): TreeIndex {
  const byId = new Map<string, IndexedThread>();
  const containers = new Map<IndexedContainer, readonly string[]>();
  const visualIds: string[] = [];
  const visit = (node: TreeNode, parentId: string | null, depth: number, groupKey: GroupKey,
    container: IndexedContainer, siblings: readonly string[]): number => {
    visualIds.push(node.thread.id);
    const childIds = node.children.map((child) => child.thread.id);
    containers.set(`parent:${node.thread.id}`, childIds);
    let height = 1;
    for (const child of node.children) height = Math.max(height,
      1 + visit(child, node.thread.id, depth + 1, groupKey, `parent:${node.thread.id}`, childIds));
    byId.set(node.thread.id, { node, parentId, depth, height, groupKey, container, siblings });
    return height;
  };
  for (const group of groups) {
    const ids = group.roots.map((root) => root.thread.id);
    containers.set(group.key, ids);
    for (const root of group.roots) visit(root, null, 1, group.key, group.key, ids);
  }
  return { byId, containers, groups, visualIds, sectionSort };
}

function isInside(index: TreeIndex, id: string, ancestor: string): boolean {
  let cursor: string | null = id;
  while (cursor) {
    if (cursor === ancestor) return true;
    cursor = index.byId.get(cursor)?.parentId ?? null;
  }
  return false;
}

export function planDrop(index: TreeIndex, draggedIds: readonly string[], target: DropTarget): DropPlan {
  const selected = new Set(draggedIds.filter((id) => index.byId.has(id)));
  const roots = index.visualIds.filter((id) => selected.has(id) &&
    ![...selected].some((ancestor) => ancestor !== id && isInside(index, id, ancestor)));
  if (!roots.length) return { ok: "noop" };
  let parentId: string | null;
  let container: IndexedContainer;
  let beforeId: string | null = null;
  let afterId: string | null = null;
  let expand: CollapseKey;
  let groupKey: GroupKey;
  if (target.kind === "group") {
    const group = index.groups.find((entry) => entry.key === target.key);
    if (!group && target.key !== "pinned") return { ok: "noop" };
    parentId = null;
    container = target.key;
    groupKey = target.key;
    expand = target.key;
  } else {
    const hit = index.byId.get(target.threadId);
    if (!hit) return { ok: "noop" };
    if (roots.includes(target.threadId)) return { ok: "noop" };
    if (roots.some((id) => isInside(index, target.threadId, id)))
      return { ok: false, reason: "Can't move a thread inside itself" };
    groupKey = hit.groupKey;
    if (target.instruction.kind === "child") {
      parentId = target.threadId;
      container = `parent:${parentId}`;
      expand = `thread:${parentId}`;
    } else {
      let reference = hit;
      if (target.instruction.kind === "out") {
        while (reference.depth > target.instruction.level + 1 && reference.parentId) {
          reference = index.byId.get(reference.parentId)!;
        }
      }
      parentId = reference.parentId;
      container = reference.container;
      expand = reference.groupKey;
      if (target.instruction.kind === "above") beforeId = target.threadId;
      else afterId = reference.node.thread.id;
    }
  }
  const mode = index.sectionSort[container] ?? "manual";
  if (target.kind === "row" && target.instruction.kind !== "child" && parentId === null &&
      mode !== "manual") return { ok: false, reason: mode === "recent" ? "Sorted by recent activity" : "Sorted by status" };
  const parentDepth = parentId ? index.byId.get(parentId)?.depth ?? 0 : 0;
  if (roots.some((id) => parentDepth + index.byId.get(id)!.height > MAX_DEPTH))
    return { ok: false, reason: "bb allows 4 levels of threads" };
  const next = new Map<IndexedContainer, string[]>();
  const list = (key: IndexedContainer): string[] => {
    if (!next.has(key)) next.set(key, [...(index.containers.get(key) ?? [])]);
    return next.get(key)!;
  };
  for (const id of roots) {
    const siblings = list(index.byId.get(id)!.container);
    siblings.splice(siblings.indexOf(id), 1);
  }
  const destination = list(container);
  const position = beforeId ? destination.indexOf(beforeId) : afterId ? destination.indexOf(afterId) + 1 :
    target.kind === "group" ? 0 : destination.length;
  destination.splice(position < 0 ? destination.length : position, 0, ...roots);
  const orders: OrderWrite[] = [];
  for (const [key, ids] of next) {
    const previous = index.containers.get(key) ?? [];
    if (key !== "pinned" && (ids.length !== previous.length || ids.some((id, i) => id !== previous[i])))
      orders.push({ container: key, ids });
  }
  const writes: CoreWrite[] = [];
  const moves: Move[] = [];
  for (const id of roots) {
    const entry = index.byId.get(id)!;
    const thread = entry.node.thread;
    const sectionId = parentId === null && container !== "pinned" ?
      groupKey.startsWith("section:") ? groupKey.slice(8) : null : thread.sectionId;
    const change: Extract<CoreWrite, { kind: "update" }> = { kind: "update", threadId: id };
    if (entry.parentId !== parentId) change.parentThreadId = parentId;
    if (thread.sectionId !== sectionId) change.sectionId = sectionId;
    if ("parentThreadId" in change || "sectionId" in change) writes.push(change);
    if (thread.isPinned && container !== "pinned") writes.push({ kind: "unpin", threadId: id });
    if (!thread.isPinned && container === "pinned") writes.push({ kind: "pin", threadId: id });
    moves.push({ threadId: id, title: thread.displayTitle, fromParent: entry.parentId, toParent: parentId });
  }
  if (container === "pinned" &&
      (roots.some((id) => !index.byId.get(id)!.node.thread.isPinned) ||
       destination.some((id, i) => id !== (index.containers.get("pinned") ?? [])[i]))) {
    for (const id of [...roots].reverse()) {
      const position = destination.indexOf(id);
      writes.push({ kind: "reorderPinned", threadId: id,
        previousThreadId: destination[position - 1] ?? null, nextThreadId: destination[position + 1] ?? null });
    }
  }
  if (!writes.length && !orders.length) return { ok: "noop" };
  const name = roots.length === 1 ? `“${moves[0]!.title}”` : `${roots.length} threads`;
  const destinationName = container === "pinned" ? "Pinned" : parentId ?
    index.byId.get(parentId)?.node.thread.displayTitle ?? "thread" :
    index.groups.find((group) => group.key === groupKey)?.section?.name ?? "Threads";
  const summary = container === "pinned" ? `Pinned ${name}` : parentId ?
    `Moved ${name} under “${destinationName}”` : `Moved ${name} to ${destinationName}`;
  return { ok: true, writes, orders, expand: [expand], moves, summary };
}

export function planKeyboardMove(index: TreeIndex, threadId: string,
  direction: "up" | "down" | "right" | "left"): DropPlan {
  const entry = index.byId.get(threadId);
  if (!entry) return { ok: "noop" };
  const position = entry.siblings.indexOf(threadId);
  const mode = index.sectionSort[entry.container] ?? "manual";
  if ((direction === "up" || direction === "down") && entry.parentId === null && mode !== "manual")
    return { ok: false, reason: mode === "recent" ? "Sorted by recent activity" : "Sorted by status" };
  if (direction === "left") return entry.parentId ?
    planDrop(index, [threadId], { kind: "row", threadId: entry.parentId, instruction: { kind: "below" } }) : { ok: "noop" };
  const sibling = entry.siblings[position + (direction === "up" || direction === "right" ? -1 : 1)];
  if (!sibling) return { ok: "noop" };
  return planDrop(index, [threadId], { kind: "row", threadId: sibling,
    instruction: { kind: direction === "right" ? "child" : direction === "up" ? "above" : "below" } });
}
