import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { FilterNames } from "./filter";

export function archivedThreads(threads: readonly PluginSidebarThread[], query: string,
  names: FilterNames): PluginSidebarThread[] {
  const needle = query.trim().toLocaleLowerCase();
  return threads
    .filter((thread) => thread.isArchived && !thread.isHidden && (!needle ||
      [thread.displayTitle, names.project(thread.projectId), thread.environment?.branchName ?? "",
        names.section(thread.sectionId)].some((value) => value.toLocaleLowerCase().includes(needle))))
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || a.id.localeCompare(b.id));
}
