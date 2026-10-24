import { experimental_Icon as Icon, useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { PANEL_PATH, SECTIONS, SECTION_META } from "./constants";
import { useShuttleQuery } from "./data";
import { formatRoute, parseRoute, type Route } from "./route";

function NavItem({ icon, label, count, hot = false, on, onClick }: { icon: string; label: string; count: number | null; hot?: boolean; on: boolean; onClick(): void }) {
  return (
    <button type="button" aria-current={on ? "page" : undefined} onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${on ? "bg-accent font-semibold text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}>
      <Icon name={icon} className="size-4 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
      {count !== null && (
        <span data-count className={`ml-auto text-[11px] ${hot && count > 0 ? "rounded-full bg-primary px-1.5 font-bold text-primary-foreground" : "text-muted-foreground"}`}>{count}</span>
      )}
    </button>
  );
}

/** Shuttle's sections in place of bb's thread list while the page is open; on compact screens bb shows it in its drawer. */
export function ShuttleSidebar({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const overview = useShuttleQuery("overview", {});
  const route = parseRoute(subPath);
  const go = (next: Route) => navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute(next) });
  const group = (name: "inbox" | "mine") => SECTIONS.filter((section) => SECTION_META[section].group === name).map((section) => (
    <NavItem key={section} icon={SECTION_META[section].icon} label={SECTION_META[section].label} hot={SECTION_META[section].hot}
      count={overview.data?.counts[section] ?? null} on={route.view === "section" && route.section === section}
      onClick={() => go({ view: "section", section, key: null })} />
  ));
  const heading = "px-2 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground";
  return (
    <nav aria-label="Shuttle sections" className="flex flex-col gap-0.5 p-2">
      <div className={heading}>Inbox</div>
      {group("inbox")}
      <div className={heading}>My pull requests</div>
      {group("mine")}
      <div className="h-2.5" />
      <NavItem icon="ListView" label="Activity" count={null} on={route.view === "activity"} onClick={() => go({ view: "activity" })} />
    </nav>
  );
}
