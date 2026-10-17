import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { FilterNames, ListFilter } from "./filter";
import type { HueId } from "./layout";
import { STATE_ORDER, type RowState } from "./status";
import { lastActivity } from "./triage";
import type { Group, TreeNode } from "./tree";

export interface LaneRow {
  thread: PluginSidebarThread;
  state: RowState;
  parentTitle: string | null;
  hue: HueId | null;
  stale: boolean;
  dim: boolean;
}
export interface Lane { key: `lane:${RowState}`; state: RowState; rows: readonly LaneRow[] }

export function buildLanes(groups: readonly Group[], filter: ListFilter, names: FilterNames): Lane[] {
  const rows: (LaneRow & { sectionName: string })[] = [];
  for (const group of groups) {
    const visit = (node: TreeNode, parentTitle: string | null) => {
      rows.push({ thread: node.thread, state: node.state, parentTitle, hue: group.hue,
        stale: node.stale, dim: false, sectionName: group.section?.name ?? "" });
      node.children.forEach((child) => visit(child, node.thread.displayTitle));
    };
    group.roots.forEach((root) => visit(root, null));
  }
  const query = filter.query.trim().toLocaleLowerCase();
  const matching = rows.filter((row) => (!filter.states.size || filter.states.has(row.state)) &&
    (!query || [row.thread.displayTitle, names.project(row.thread.projectId),
      row.thread.environment?.branchName ?? "", row.sectionName].some((value) => value.toLocaleLowerCase().includes(query))));
  return STATE_ORDER.flatMap((state): Lane[] => {
    const laneRows = matching.filter((row) => row.state === state)
      .sort((a, b) => lastActivity(b.thread) - lastActivity(a.thread));
    return laneRows.length ? [{ key: `lane:${state}`, state, rows: laneRows }] : [];
  });
}
