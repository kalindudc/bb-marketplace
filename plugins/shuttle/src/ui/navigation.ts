import { experimental_usePluginId, type ExperimentalBadge, type ExperimentalPageTitle, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { AREA_META, PANEL_PATH, SOURCE_META } from "./constants";
import { useShuttleQuery } from "./data";
import { keyLabel } from "./format";
import { formatRoute, parseRoute, type Route } from "./route";

/** The rail badge: how many decisions wait in the Inbox. */
export function useNeedsBadge(): ExperimentalBadge | null {
  const overview = useShuttleQuery("overview", {});
  const count = overview.data?.counts.inbox ?? 0;
  if (count === 0) return null;
  return { count, tone: "warning", label: count === 1 ? "1 PR in your Inbox" : `${count} PRs in your Inbox` };
}

/** The area and its part, each linking back, then the selected PR. */
function crumbsOf(route: Route): { label: string; route: Route }[] {
  switch (route.view) {
    case "inbox": return [{ label: AREA_META.inbox.label, route: { view: "inbox", key: null } }];
    case "mine": return [{ label: AREA_META.mine.label, route: { view: "mine", key: null } }, { label: "Open", route: { view: "mine", key: null } }];
    case "done": return [{ label: AREA_META.mine.label, route: { view: "mine", key: null } }, { label: "Merged and closed", route: { view: "done", key: null } }];
    case "reviews": return [{ label: AREA_META.reviews.label, route: { view: "reviews", source: "all", key: null } }, { label: SOURCE_META[route.source].label, route: { ...route, key: null } }];
    case "insights": return [{ label: AREA_META.insights.label, route: { view: "insights", tab: "overview" } }, { label: route.tab === "log" ? "Automation log" : "Overview", route }];
    case "pr": return [{ label: "Look up", route }];
  }
}

export function useShuttlePageTitle({ subPath }: PluginNavPanelProps): ExperimentalPageTitle | null {
  const pluginId = experimental_usePluginId();
  const route = parseRoute(subPath);
  const crumbs = crumbsOf(route);
  const key = route.view === "insights" ? null : route.key;
  if (key === null && crumbs.length === 1) return { title: crumbs[0]!.label };
  const to = (target: Route) => {
    const path = formatRoute(target);
    return `/plugins/${encodeURIComponent(pluginId)}/${PANEL_PATH}${path === "" ? "" : `/${path}`}`;
  };
  const linked = route.view === "pr" ? crumbs.map((crumb) => ({ label: crumb.label })) : crumbs.map((crumb, index) => (key === null && index === crumbs.length - 1 ? { label: crumb.label } : { label: crumb.label, to: to(crumb.route) }));
  return { breadcrumbs: key === null ? linked : [...linked, { label: keyLabel(key) }] };
}
