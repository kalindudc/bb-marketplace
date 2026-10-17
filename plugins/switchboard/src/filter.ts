import { EMPTY_COUNTS, type RowState, type StateCounts } from "./status";
import { combineCounts, type Group, type TreeNode } from "./tree";

export interface ListFilter { query: string; states: ReadonlySet<RowState> }
export interface FilterNames { project(id: string): string; section(id: string | null): string }
export function isFiltering(filter: ListFilter): boolean {
  return filter.query.trim().length > 0 || filter.states.size > 0;
}

export function chipCounts(groups: readonly Group[]): StateCounts {
  const counts = { ...EMPTY_COUNTS };
  const visit = (node: TreeNode) => {
    if (node.state !== "idle") counts[node.state]++;
    node.children.forEach(visit);
  };
  groups.forEach((group) => group.roots.forEach(visit));
  return counts;
}

export function filterGroups(
  groups: readonly Group[], filter: ListFilter,
  names: FilterNames,
): Group[] {
  if (!isFiltering(filter)) return [...groups];
  const query = filter.query.trim().toLocaleLowerCase();
  return groups.flatMap((group) => {
    const sectionName = group.section ? names.section(group.section.id) : "";
    const prune = (node: TreeNode): TreeNode | null => {
      const { thread } = node;
      const matches = (!query || [thread.displayTitle, names.project(thread.projectId),
        thread.environment?.branchName ?? "", sectionName].some((value) => value.toLocaleLowerCase().includes(query))) &&
        (!filter.states.size || filter.states.has(node.state));
      const children = node.children.map(prune).filter((child): child is TreeNode => child !== null);
      return matches || children.length ? { ...node, matches, children } : null;
    };
    const roots = group.roots.map(prune).filter((node): node is TreeNode => node !== null);
    if (!roots.length) return [];
    const accumulate = (node: TreeNode): { count: number; states: StateCounts } => {
      const own = node.state === "idle" ? EMPTY_COUNTS : { ...EMPTY_COUNTS, [node.state]: 1 };
      return node.children.reduce((total, child) => {
        const nested = accumulate(child);
        return { count: total.count + nested.count, states: combineCounts(total.states, nested.states) };
      }, { count: 1, states: own });
    };
    const totals = roots.reduce((total, root) => {
      const nested = accumulate(root);
      return { count: total.count + nested.count, states: combineCounts(total.states, nested.states) };
    }, { count: 0, states: EMPTY_COUNTS });
    return [{ ...group, roots, threadCount: totals.count, counts: totals.states }];
  });
}
