import { useState } from "react";
import { toast } from "sonner";
import { useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { WatchMode } from "../config";
import type { Overview, PrView } from "../contract";
import { ActivityView } from "./activity";
import { BUTTON, ErrorNote, FIELD } from "./common";
import { PANEL_PATH, SECTION_META } from "./constants";
import { isNotFound, messageOf, openExternal, useShuttleMutation, useShuttleQuery, useWatchMutation } from "./data";
import { PrDetail } from "./detail";
import { keyLabel } from "./format";
import { LinkDialog, type LinkRequest } from "./link-dialog";
import { ReviewDialog } from "./review-dialog";
import { formatRoute, parseRoute, type Route } from "./route";
import { PrRow, type PrActions } from "./row";

type Dialog = { kind: "link"; request: LinkRequest } | { kind: "review"; pr: PrView } | null;

const ALL_SERVERS = "all";

interface Filter {
  server: string;
  text: string;
}

function matches(pr: PrView, filter: Filter): boolean {
  if (filter.server !== ALL_SERVERS && pr.server !== filter.server) return false;
  const text = filter.text.trim().toLowerCase();
  return text === "" || `${pr.title} ${pr.key} ${pr.author}`.toLowerCase().includes(text);
}

function Filters({ filter, overview, onChange }: { filter: Filter; overview: Overview | undefined; onChange(next: Filter): void }) {
  const servers = overview?.servers.filter((item) => item.enabled) ?? [];
  const chip = (on: boolean) => `cursor-pointer rounded-full border px-2.5 py-0.5 text-xs ${on ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2.5">
      <div role="group" aria-label="Server" className="flex flex-wrap gap-1.5">
        <button type="button" aria-pressed={filter.server === ALL_SERVERS} className={chip(filter.server === ALL_SERVERS)} onClick={() => onChange({ ...filter, server: ALL_SERVERS })}>All servers</button>
        {servers.map((item) => (
          <button key={item.id} type="button" aria-pressed={filter.server === item.id} className={chip(filter.server === item.id)} onClick={() => onChange({ ...filter, server: item.id })}>{item.name}</button>
        ))}
      </div>
      <span className="flex-1" />
      <input aria-label="Filter" placeholder="Filter" value={filter.text} onChange={(event) => onChange({ ...filter, text: event.target.value })} className={`${FIELD} w-40 py-1 text-xs`} />
    </div>
  );
}

/** The PR list and the drawer; bb's sidebar holds the sections (see sidebar.tsx). */
export function ShuttlePage({ subPath }: PluginNavPanelProps) {
  const route = parseRoute(subPath);
  const navigate = useBbNavigate();
  const overview = useShuttleQuery("overview", {});
  const config = useShuttleQuery("getConfig", {});
  const section = route.view === "section" ? route.section : "needs";
  const list = useShuttleQuery("list", { section }, route.view === "section");
  const lookupKey = route.view === "pr" ? route.key : "";
  const lookedUp = useShuttleQuery("detail", { key: lookupKey }, route.view === "pr");
  const lookup = useShuttleMutation("lookup");
  const prs = route.view === "pr" ? (lookedUp.data ? [lookedUp.data.pr] : undefined) : list.data?.prs;
  const loadError = route.view === "pr" ? lookedUp.error : list.error;

  const [filter, setFilter] = useState<Filter>({ server: ALL_SERVERS, text: "" });
  const shown = route.view === "section" ? prs?.filter((pr) => matches(pr, filter)) : prs;
  const selectedKey = route.view === "activity" ? null : route.key;
  const threadIds = [...new Set((prs ?? []).flatMap((pr) => pr.links.map((link) => link.threadId)))];
  const watch = useWatchMutation(threadIds);
  const [dialog, setDialog] = useState<Dialog>(null);

  const go = (next: Route, replace = false) => navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute(next), replace });
  const actions: PrActions = {
    presets: config.data?.config.presets ?? null,
    select: (key) => {
      if (route.view === "section") go({ ...route, key }, true);
    },
    open: (pr) => openExternal(navigate, pr.url),
    openThread: (threadId) => navigate.toThread(threadId),
    link: (pr, tab = "existing") => setDialog({ kind: "link", request: { pr, tab, watchAfter: null } }),
    customize: (pr) => {
      if (config.data === undefined) toast.error("Shuttle's presets have not loaded yet");
      else setDialog({ kind: "review", pr });
    },
    toggleWatch: (pr) => {
      if (pr.watch !== null) return void watch.run({ key: pr.key, mode: null });
      if (config.data === undefined) return void toast.error("Shuttle's settings have not loaded yet");
      const mode = config.data.config.watch.mode;
      if (pr.links.some((link) => link.role === "owner" && !link.archived)) return void watch.run({ key: pr.key, mode });
      setDialog({ kind: "link", request: { pr, tab: "existing", watchAfter: mode } });
    },
    setWatchMode: (pr, mode: WatchMode) => void watch.run({ key: pr.key, mode }),
  };

  const heading = route.view === "pr" ? "Look up" : route.view === "section" ? SECTION_META[route.section].label : "Activity";
  const description = route.view === "pr"
    ? "Fetched from the server whose link pattern matches. Works for any PR, whether or not you are part of it."
    : route.view === "section" ? SECTION_META[route.section].description : "";
  const showDetail = selectedKey !== null && (route.view !== "pr" || lookedUp.data !== undefined);

  return (
    <div className={`flex h-full min-h-0 min-w-0 flex-col overflow-y-auto bg-background text-foreground ${showDetail ? "xl:flex-row xl:overflow-hidden" : ""}`}>
      <div className={`min-w-0 flex-1 ${showDetail ? "xl:overflow-y-auto" : ""}`}>
        {overview.error !== null && <div className="px-4 pt-3"><ErrorNote>Could not load Shuttle's status: {messageOf(overview.error)}</ErrorNote></div>}
        {overview.data?.paused === true && (
          <div role="status" className="mx-4 mt-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning-text">
            Automations are paused: no auto reviews, and nothing is sent to watched PRs' threads. Lists keep syncing.
          </div>
        )}
        {route.view === "activity" ? (
          <ActivityView onOpenPr={(key) => go({ view: "pr", key })} onOpenThread={(threadId) => navigate.toThread(threadId)} />
        ) : (
          <section aria-label={heading} className="min-w-0">
            <div className="px-4 pb-2.5 pt-3.5">
              <h2 className="text-sm font-semibold">{heading}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
            </div>
            {route.view === "section" && <Filters filter={filter} overview={overview.data} onChange={setFilter} />}
            {route.view === "pr" && isNotFound(loadError) ? (
              <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-sm text-muted-foreground">
                <span className="flex-1">Shuttle has not fetched {keyLabel(route.key)} yet.</span>
                <button type="button" className={BUTTON} disabled={lookup.isPending} onClick={() => void lookup.run({ query: route.key })}>Fetch it from its server</button>
              </div>
            ) : (
              loadError !== null && <div className="px-4 pb-3"><ErrorNote>{messageOf(loadError)}</ErrorNote></div>
            )}
            {shown === undefined && loadError === null && <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>}
            {shown !== undefined && shown.length === 0 && (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">{prs?.length === 0 ? "Nothing here." : "No PR matches the filter."}</div>
            )}
            {shown !== undefined && shown.length > 0 && (
              <ul aria-label="Pull requests">
                {shown.map((pr) => <PrRow key={pr.key} pr={pr} selected={pr.key === selectedKey} actions={actions} />)}
              </ul>
            )}
          </section>
        )}
      </div>
      {showDetail && (
        <div className="min-w-0 border-t border-border xl:w-[min(640px,45%)] xl:shrink-0 xl:overflow-y-auto xl:border-l xl:border-t-0">
          <PrDetail key={selectedKey} prKey={selectedKey} actions={actions}
            onClose={route.view === "section" ? () => go({ ...route, key: null }, true) : undefined} />
        </div>
      )}
      {dialog?.kind === "link" && <LinkDialog request={dialog.request} onClose={() => setDialog(null)} />}
      {dialog?.kind === "review" && config.data !== undefined && <ReviewDialog pr={dialog.pr} presets={config.data.config.presets} onClose={() => setDialog(null)} />}
    </div>
  );
}
