import { experimental_Icon as Icon, experimental_usePluginId, UrlLink, useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { ServerStatus } from "../contract";
import { AREA_META, PANEL_PATH, SOURCE_META } from "./constants";
import { useShuttleQuery } from "./data";
import { ago, settingsHref } from "./format";
import { sourceCounts } from "./reviews";
import { routeOf } from "./prefs";
import { formatRoute, SOURCES, type Route } from "./route";
import { sidebarReason } from "./sync";

function NavItem({ icon, label, count, hot = false, on, sub = false, onClick }: { icon?: string; label: string; count: number | null; hot?: boolean; on: boolean; sub?: boolean; onClick(): void }) {
  return (
    <button type="button" aria-current={on ? "page" : undefined} onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2 rounded-md text-left ${sub ? "py-1 pl-8 pr-2 text-xs" : "px-2 py-1.5 text-sm"} ${on ? "bg-state-active font-semibold text-foreground" : "text-muted-foreground hover:bg-state-hover hover:text-foreground"}`}>
      {icon && <Icon name={icon} fallback="Circle" className="size-4 shrink-0" aria-hidden />}
      <span className="truncate">{label}</span>
      {count !== null && (
        <span data-count className={`ml-auto text-[11px] ${hot && count > 0 ? "rounded-full bg-warning px-1.5 font-bold text-background" : "font-medium text-muted-foreground"}`}>{count}</span>
      )}
    </button>
  );
}

const DOT = { ok: "bg-success", partial: "bg-warning", failed: "bg-destructive" } as const;
const REASON_TONE = { bad: "text-destructive-text", warn: "text-warning-text", neutral: "text-muted-foreground" } as const;

/** A server's last sync; one that fails, or failed in the last hour, says why in a line and opens Insights › Sync. */
function Health({ server, onOpen }: { server: ServerStatus; onOpen(): void }) {
  const dot = server.state === null ? "bg-muted-foreground" : DOT[server.state];
  const when = server.lastSyncAt === null ? "not synced yet" : server.state === "failed" ? `sync failed ${ago(server.lastSyncAt)}` : `synced ${ago(server.lastSyncAt)}`;
  const reason = sidebarReason(server);
  const line = (
    <span className="flex min-w-0 items-center gap-2">
      <span aria-hidden className={`inline-block size-[7px] shrink-0 rounded-full ${dot}`} />
      <span className="truncate">{server.name} · {when}</span>
    </span>
  );
  if (reason === null) return <div data-server={server.id} title={server.login ? `Signed in as ${server.login}` : undefined} className="flex items-center">{line}</div>;
  return (
    <button type="button" data-server={server.id} title="Open Insights › Sync" onClick={onOpen}
      className="-mx-1 flex cursor-pointer flex-col items-start gap-px rounded px-1 py-0.5 text-left hover:bg-state-hover">
      {line}
      <span className={`line-clamp-2 pl-[15px] text-[11px] leading-snug ${REASON_TONE[reason.tone]}`}>
        {reason.text} · <span className="text-primary">why?</span>
      </span>
    </button>
  );
}

/** Shuttle's areas in place of bb's thread list while the page is open; on compact screens bb shows it in its drawer. */
export function ShuttleSidebar({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const overview = useShuttleQuery("overview", {});
  const route = routeOf(subPath);
  const reviewsOpen = route.view === "reviews";
  const reviews = useShuttleQuery("list", { area: "reviews" }, reviewsOpen);
  const counts = overview.data?.counts;
  const sources = reviews.data === undefined ? null : sourceCounts(reviews.data.prs);
  const go = (next: Route) => navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute(next) });
  const mineOpen = route.view === "mine" || route.view === "done";
  const boardsOpen = route.view === "boards" || route.view === "board";
  const boards = useShuttleQuery("boards", { archived: "exclude" });
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
      <NavItem icon={AREA_META.boards.icon} label="Boards" count={boards.data?.boards.length ?? null} on={boardsOpen} onClick={() => go({ view: "boards", tab: "active" })} />
      {boardsOpen && boards.data !== undefined && boards.data.boards.map((board) => (
        <NavItem key={board.id} sub label={board.name} count={board.prCount} on={route.view === "board" && route.id === board.id} onClick={() => go({ view: "board", id: board.id, key: null })} />
      ))}
      <NavItem icon={AREA_META.insights.icon} label="Insights" count={null} on={route.view === "insights"} onClick={() => go({ view: "insights", tab: "overview" })} />
      {route.view === "insights" && (
        <>
          <NavItem sub label="Overview" count={null} on={route.tab === "overview"} onClick={() => go({ view: "insights", tab: "overview" })} />
          <NavItem sub label="Automation log" count={null} on={route.tab === "log"} onClick={() => go({ view: "insights", tab: "log" })} />
          <NavItem sub label="Sync" count={null} on={route.tab === "sync"} onClick={() => go({ view: "insights", tab: "sync" })} />
        </>
      )}
      <div data-sidebar-footer className="mt-auto flex flex-col gap-1.5 border-t border-border px-2 pb-0.5 pt-2.5 text-[11.5px] text-muted-foreground">
        {servers.map((server) => <Health key={server.id} server={server} onOpen={() => go({ view: "insights", tab: "sync" })} />)}
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
