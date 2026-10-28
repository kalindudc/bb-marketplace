import { experimental_usePluginId, type ExperimentalBadge, type ExperimentalPageTitle, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { AREA_META, INSIGHTS_TAB_LABELS, PANEL_PATH, SOURCE_META } from "./constants";
import { useShuttleQuery } from "./data";
import { keyLabel } from "./format";
import { routeOf } from "./prefs";
import { formatRoute, type Route } from "./route";

/** The rail badge: how many decisions wait in the Inbox. */
export function useNeedsBadge(): ExperimentalBadge | null {
  const overview = useShuttleQuery("overview", {});
  const count = overview.data?.counts.inbox ?? 0;
  if (count === 0) return null;
  return { count, tone: "warning", label: count === 1 ? "1 PR in your Inbox" : `${count} PRs in your Inbox` };
}

/** The area and its part, each linking back, then the selected PR. */
function crumbsOf(route: Route, boardName?: string): { label: string; route: Route }[] {
  switch (route.view) {
    case "inbox": return [{ label: AREA_META.inbox.label, route: { view: "inbox", key: null } }];
    case "mine": return [{ label: AREA_META.mine.label, route: { view: "mine", key: null } }, { label: "Open", route: { view: "mine", key: null } }];
    case "done": return [{ label: AREA_META.mine.label, route: { view: "mine", key: null } }, { label: "Merged and closed", route: { view: "done", key: null } }];
    case "reviews": return [{ label: AREA_META.reviews.label, route: { view: "reviews", source: "all", key: null } }, { label: SOURCE_META[route.source].label, route: { ...route, key: null } }];
    case "boards": return [{ label: AREA_META.boards.label, route: { view: "boards", tab: route.tab } }];
    case "board": return [{ label: AREA_META.boards.label, route: { view: "boards", tab: "active" } }, { label: boardName ?? "Board", route: { view: "board", id: route.id, key: null } }];
    case "insights": return [{ label: AREA_META.insights.label, route: { view: "insights", tab: "overview" } }, { label: INSIGHTS_TAB_LABELS[route.tab], route }];
    case "pr": return [{ label: "Look up", route }];
    case "search": return [{ label: route.query === "" ? "Search" : `Search: \u201c${route.query}\u201d`, route: { ...route, key: null } }];
  }
}

export function useShuttlePageTitle({ subPath }: PluginNavPanelProps): ExperimentalPageTitle | null {
  const pluginId = experimental_usePluginId();
  const route = routeOf(subPath);
  const board = useShuttleQuery("board", { id: route.view === "board" ? route.id : "board" }, route.view === "board");
  const boardName = route.view === "board" ? board.data?.board.name : undefined;
  const crumbs = crumbsOf(route, boardName);
  const key = route.view === "insights" || route.view === "boards" ? null : route.key;
  if (key === null && crumbs.length === 1) return { title: crumbs[0]!.label };
  const to = (target: Route) => {
    const path = formatRoute(target);
    return `/plugins/${encodeURIComponent(pluginId)}/${PANEL_PATH}${path === "" ? "" : `/${path}`}`;
  };
  const linked = route.view === "pr" ? crumbs.map((crumb) => ({ label: crumb.label })) : crumbs.map((crumb, index) => (key === null && index === crumbs.length - 1 ? { label: crumb.label } : { label: crumb.label, to: to(crumb.route) }));
  return { breadcrumbs: key === null ? linked : [...linked, { label: keyLabel(key) }] };
}
