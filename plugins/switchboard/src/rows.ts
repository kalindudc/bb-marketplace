import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { CollapseKey } from "./layout";
import { type RowState } from "./status";
import type { Group, TreeNode } from "./tree";

export interface RowModel {
  thread: PluginSidebarThread;
  state: RowState;
  depth: number;
  guides: string;
  isLast: boolean;
  childCount: number;
  collapsed: boolean;
  rollup: RowState | null;
  rollupCount: number;
  crossProject: string | null;
  dim: boolean;
}

export function flattenGroup(group: Group, options: {
  collapsed: ReadonlySet<string>;
  filtering: boolean;
  activeThreadId: string | null;
  projectName(id: string): string;
}): RowModel[] {
  const result: RowModel[] = [];
  const includesActive = (node: TreeNode): boolean =>
    node.thread.id === options.activeThreadId || node.children.some(includesActive);
  const visit = (node: TreeNode, depth: number, guides: string, isLast: boolean, parent: PluginSidebarThread | null) => {
    const collapsed = node.children.length > 0 && !options.filtering &&
      options.collapsed.has(`thread:${node.thread.id}` satisfies CollapseKey) && !includesActive(node);
    const rollup = collapsed && node.worstDescendant !== "idle" ? node.worstDescendant : null;
    result.push({
      thread: node.thread, state: node.state, depth, guides, isLast,
      childCount: node.children.length, collapsed,
      rollup, rollupCount: rollup ? node.descendants[rollup] : 0,
      crossProject: parent && parent.projectId !== node.thread.projectId ? options.projectName(node.thread.projectId) : null,
      dim: options.filtering && !node.matches,
    });
    if (collapsed) return;
    // guides[i] keeps column i open while the depth-(i + 1) ancestor has later siblings; the row's own column comes from isLast.
    const childGuides = depth === 0 ? "" : guides + (isLast ? " " : "|");
    node.children.forEach((child, index) => visit(child, depth + 1, childGuides,
      index === node.children.length - 1, node.thread));
  };
  group.roots.forEach((root, index) => visit(root, 0, "", index === group.roots.length - 1, null));
  return result;
}
