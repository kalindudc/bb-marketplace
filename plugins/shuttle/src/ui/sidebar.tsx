import { experimental_Icon as Icon, experimental_usePluginId, UrlLink, useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { ServerStatus } from "../contract";
import { AREA_META, PANEL_PATH, SOURCE_META } from "./constants";
import { useShuttleQuery } from "./data";
import { ago, settingsHref } from "./format";
import { sourceCounts } from "./reviews";
import { formatRoute, parseRoute, SOURCES, type Route } from "./route";

function NavItem({ icon, label, count, hot = false, on, sub = false, onClick }: { icon?: string; label: string; count: number | null; hot?: boolean; on: boolean; sub?: boolean; onClick(): void }) {
  return (
    <button type="button" aria-current={on ? "page" : undefined} onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2 rounded-md text-left ${sub ? "py-1 pl-8 pr-2 text-xs" : "px-2 py-1.5 text-sm"} ${on ? "bg-accent font-semibold text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}>
      {icon && <Icon name={icon} fallback="Circle" className="size-4 shrink-0" aria-hidden />}
      <span className="truncate">{label}</span>
      {count !== null && (
        <span data-count className={`ml-auto text-[11px] ${hot && count > 0 ? "rounded-full bg-warning px-1.5 font-bold text-background" : "font-medium text-muted-foreground"}`}>{count}</span>
      )}
    </button>
  );
}

function Health({ server }: { server: ServerStatus }) {
  const dot = server.ok === null ? "bg-muted-foreground" : server.ok ? "bg-success" : "bg-destructive";
  const when = server.lastSyncAt === null ? "not synced yet" : server.ok === false ? `sync failed ${ago(server.lastSyncAt)}` : `synced ${ago(server.lastSyncAt)}`;
  return (
    <div data-server={server.id} title={server.error ?? (server.login ? `Signed in as ${server.login}` : undefined)} className="flex items-center gap-2">
      <span aria-hidden className={`inline-block size-[7px] shrink-0 rounded-full ${dot}`} />
      <span className="truncate">{server.name} · {when}</span>
    </div>
  );
}

/** Shuttle's areas in place of bb's thread list while the page is open; on compact screens bb shows it in its drawer. */
export function ShuttleSidebar({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const overview = useShuttleQuery("overview", {});
  const route = parseRoute(subPath);
  const reviewsOpen = route.view === "reviews";
  const reviews = useShuttleQuery("list", { area: "reviews" }, reviewsOpen);
  const counts = overview.data?.counts;
  const sources = reviews.data === undefined ? null : sourceCounts(reviews.data.prs);
  const go = (next: Route) => navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute(next) });
  const mineOpen = route.view === "mine" || route.view === "done";
  const servers = overview.data?.servers.filter((server) => server.enabled) ?? [];
  return (
    <nav aria-label="Shuttle areas" className="flex h-full min-h-0 flex-col gap-px p-2">
      <div className="px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Shuttle</div>
      <NavItem icon={AREA_META.inbox.icon} label="Inbox" hot count={counts?.inbox ?? null} on={route.view === "inbox"} onClick={() => go({ view: "inbox", key: null })} />
      <NavItem icon={AREA_META.mine.icon} label="My PRs" count={counts?.mine ?? null} on={mineOpen} onClick={() => go({ view: "mine", key: null })} />
      {mineOpen && (
        <>
          <NavItem sub label="Open" count={counts?.mine ?? null} on={route.view === "mine"} onClick={() => go({ view: "mine", key: null })} />
          <NavItem sub label="Merged and closed" count={counts?.done ?? null} on={route.view === "done"} onClick={() => go({ view: "done", key: null })} />
        </>
      )}
      <NavItem icon={AREA_META.reviews.icon} label="Reviews" count={counts?.reviews ?? null} on={reviewsOpen} onClick={() => go({ view: "reviews", source: "all", key: null })} />
      {reviewsOpen && SOURCES.map((source) => (
        <NavItem key={source} sub label={SOURCE_META[source].label} count={sources?.[source] ?? null} on={route.source === source} onClick={() => go({ view: "reviews", source, key: null })} />
      ))}
      <NavItem icon={AREA_META.insights.icon} label="Insights" count={null} on={route.view === "insights"} onClick={() => go({ view: "insights", tab: "overview" })} />
      {route.view === "insights" && (
        <>
          <NavItem sub label="Overview" count={null} on={route.tab === "overview"} onClick={() => go({ view: "insights", tab: "overview" })} />
          <NavItem sub label="Automation log" count={null} on={route.tab === "log"} onClick={() => go({ view: "insights", tab: "log" })} />
        </>
      )}
      <div data-sidebar-footer className="mt-auto flex flex-col gap-1.5 border-t border-border px-2 pb-0.5 pt-2.5 text-[11.5px] text-muted-foreground">
        {servers.map((server) => <Health key={server.id} server={server} />)}
        {overview.data !== undefined && (
          <div className={`flex items-center gap-1.5 ${overview.data.paused ? "text-warning-text" : ""}`}>
            <Icon name={overview.data.paused ? "Pause" : "Bot"} fallback="Circle" className="size-3.5 shrink-0" aria-hidden />
            <span>{overview.data.paused ? "Automations paused" : "Automations on"} ·</span>
            <UrlLink href={settingsHref(pluginId)} className="text-primary hover:underline">{overview.data.paused ? "resume" : "pause"}</UrlLink>
          </div>
        )}
      </div>
    </nav>
  );
}
