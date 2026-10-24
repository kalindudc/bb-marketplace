import { experimental_usePluginId, type ExperimentalBadge, type ExperimentalPageTitle, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { PANEL_PATH, SECTION_META } from "./constants";
import { useShuttleQuery } from "./data";
import { keyLabel } from "./format";
import { formatRoute, parseRoute } from "./route";

/** The rail badge: how many PRs wait on you. */
export function useNeedsBadge(): ExperimentalBadge | null {
  const overview = useShuttleQuery("overview", {});
  const count = overview.data?.counts.needs ?? 0;
  if (count === 0) return null;
  return { count, tone: "warning", label: count === 1 ? "1 PR needs you" : `${count} PRs need you` };
}

/** Shuttle, then the section, then the selected or looked-up PR. */
export function useShuttlePageTitle({ subPath }: PluginNavPanelProps): ExperimentalPageTitle | null {
  const pluginId = experimental_usePluginId();
  const route = parseRoute(subPath);
  if (route.view === "activity") return { title: "Activity" };
  if (route.view === "pr") return { breadcrumbs: [{ label: "Look up" }, { label: keyLabel(route.key) }] };
  const label = SECTION_META[route.section].label;
  if (route.key === null) return { title: label };
  const sectionPath = formatRoute({ ...route, key: null });
  return {
    breadcrumbs: [
      { label, to: `/plugins/${encodeURIComponent(pluginId)}/${PANEL_PATH}${sectionPath === "" ? "" : `/${sectionPath}`}` },
      { label: keyLabel(route.key) },
    ],
  };
}
