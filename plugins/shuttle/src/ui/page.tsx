import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { experimental_copyToClipboard, experimental_Icon as Icon, useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { WatchMode } from "../config";
import type { Overview, PrView } from "../contract";
import { ActivityView } from "./activity";
import { BUTTON, BUTTON_GHOST, ErrorNote, FIELD, ICON_GHOST } from "./common";
import { PANEL_PATH, SECTIONS, SECTION_META } from "./constants";
import { isNotFound, messageOf, openExternal, useShuttleMutation, useShuttleQuery, useWatchMutation } from "./data";
import { PrDetail } from "./detail";
import { keyLabel } from "./format";
import { LinkDialog, type LinkRequest } from "./link-dialog";
import { Picker, PickerAction } from "./picker";
import { PresetChoices, useStartReview } from "./review-button";
import { ReviewDialog } from "./review-dialog";
import { formatRoute, parseRoute, type Route } from "./route";
import { isLive, PrRow, type PrActions } from "./row";
import { useViewport } from "./viewport";

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

/** A phone's way between sections, so switching does not need bb's drawer; the drawer still has them too. */
function SectionChips({ route, overview, onGo }: { route: Route; overview: Overview | undefined; onGo(next: Route): void }) {
  const chip = (on: boolean) => `shrink-0 cursor-pointer whitespace-nowrap rounded-full border px-2.5 py-1 text-xs ${on ? "border-primary/50 bg-accent text-foreground" : "border-border text-muted-foreground"}`;
  return (
    <nav aria-label="Sections" className="flex gap-1.5 overflow-x-auto border-b border-border px-3 py-2.5 [scrollbar-width:none]">
      {SECTIONS.map((section) => {
        const on = route.view === "section" && route.section === section;
        return (
          <button key={section} type="button" aria-current={on ? "page" : undefined} className={chip(on)} onClick={() => onGo({ view: "section", section, key: null })}>
            {SECTION_META[section].label}
            {overview !== undefined && <b className="ml-1 font-semibold text-foreground">{overview.counts[section]}</b>}
          </button>
        );
      })}
      <button type="button" aria-current={route.view === "activity" ? "page" : undefined} className={chip(route.view === "activity")} onClick={() => onGo({ view: "activity" })}>Activity</button>
    </nav>
  );
}

/** A phone's PR screen: back and watch at the top, the PR in between, its actions at the thumb. */
function PhonePrView({ prKey, backLabel, onBack, actions }: { prKey: string; backLabel: string; onBack(): void; actions: PrActions }) {
  const pr = useShuttleQuery("detail", { key: prKey }).data?.pr;
  const { start } = useStartReview();
  const copyLink = async (url: string) => {
    if (await experimental_copyToClipboard({ text: url })) toast.success("Copied the link");
    else toast.error("Could not copy the link");
  };
  const wide = "inline-flex h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2.5 text-sm";
  return (
    <div data-phone-pr className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
        <button type="button" aria-label={`Back to ${backLabel}`} className={`${BUTTON_GHOST} h-8 text-sm text-foreground`} onClick={onBack}>
          <Icon name="ChevronLeft" className="size-4" aria-hidden />
          {backLabel}
        </button>
        <span className="flex-1" />
        {pr !== undefined && isLive(pr) && (
          <button type="button" aria-pressed={pr.watch !== null} aria-label={pr.watch !== null ? "Stop watching" : "Watch"} title={pr.watch !== null ? "Stop watching" : "Watch"}
            className={`${ICON_GHOST} size-9 ${pr.watch !== null ? "text-primary" : ""}`} onClick={() => actions.toggleWatch(pr)}>
            <Icon name={pr.watch !== null ? "Eye" : "EyeOff"} className="size-4" aria-hidden />
          </button>
        )}
        {pr !== undefined && (
          <Picker phone title="More" triggerLabel="More actions" triggerClassName={`${ICON_GHOST} size-9`} trigger={<Icon name="MoreHorizontal" className="size-4" aria-hidden />}>
            <PickerAction onSelect={() => actions.open(pr)}><Icon name="ExternalLink" className="size-3.5" aria-hidden />Open on {pr.serverName}</PickerAction>
            <PickerAction onSelect={() => void copyLink(pr.url)}><Icon name="Copy" className="size-3.5" aria-hidden />Copy link</PickerAction>
            <PickerAction onSelect={() => actions.link(pr)}><Icon name="Link" className="size-3.5" aria-hidden />Link to a thread</PickerAction>
          </Picker>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PrDetail prKey={prKey} actions={actions} phone />
      </div>
      {pr !== undefined && (
        <div className="flex shrink-0 gap-2 border-t border-border bg-card px-3 pb-4 pt-2.5">
          {isLive(pr) && (
            <Picker phone title="Start a review" triggerLabel="Review" triggerClassName={`${wide} border-primary bg-primary font-semibold text-primary-foreground`}
              trigger={<><Icon name="Play" className="size-3.5" aria-hidden />Review<Icon name="ChevronDown" className="size-3.5" aria-hidden /></>}>
              <PresetChoices pr={pr} presets={actions.presets} start={start} onCustomize={actions.customize} />
            </Picker>
          )}
          <button type="button" className={`${wide} border-border bg-card`} onClick={() => actions.link(pr)}>
            <Icon name="Link" className="size-3.5" aria-hidden />
            Link
          </button>
          <button type="button" className={`${wide} border-border bg-card`} onClick={() => actions.open(pr)}>
            <Icon name="ExternalLink" className="size-3.5" aria-hidden />
            Open
          </button>
        </div>
      )}
    </div>
  );
}

/** The PR list and the PR view; bb's sidebar holds the sections (see sidebar.tsx), and a phone also gets them as chips. */
export function ShuttlePage({ subPath }: PluginNavPanelProps) {
  const route = parseRoute(subPath);
  const viewport = useViewport();
  const phone = viewport === "phone";
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
  const shown = route.view === "section" && !phone ? prs?.filter((pr) => matches(pr, filter)) : prs;
  const selectedKey = route.view === "activity" ? null : route.key;
  const threadIds = [...new Set((prs ?? []).flatMap((pr) => pr.links.map((link) => link.threadId)))];
  const watch = useWatchMutation(threadIds);
  const [dialog, setDialog] = useState<Dialog>(null);

  // Opening a PR from the list pushes a history entry, so Back and the swipe return to the list;
  // switching between PRs replaces it. A page opened on a PR (a deep link) never pushed one.
  const pushed = useRef(false);
  useEffect(() => {
    if (selectedKey === null) pushed.current = false;
  }, [selectedKey]);

  const go = (next: Route, replace = false) => navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute(next), ...(replace ? { replace: true } : {}) });
  const closeSelection = () => {
    if (route.view === "pr") return go({ view: "section", section: "needs", key: null }, true);
    if (route.view !== "section") return;
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    } else {
      go({ ...route, key: null }, true);
    }
  };
  const close = useRef(closeSelection);
  close.current = closeSelection;

  const actions: PrActions = {
    presets: config.data?.config.presets ?? null,
    select: (key) => {
      if (route.view !== "section") return;
      if (route.key === null) pushed.current = true;
      go({ ...route, key }, route.key !== null);
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

  const showDetail = selectedKey !== null && (route.view !== "pr" || lookedUp.data !== undefined);
  const overlay = viewport === "narrow" && route.view === "section" && showDetail;
  useEffect(() => {
    if (!overlay || dialog !== null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // bb's "Back to app" also listens for Escape; while the panel is open, Escape closes the panel.
      event.preventDefault();
      close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlay, dialog]);

  const heading = route.view === "pr" ? "Look up" : route.view === "section" ? SECTION_META[route.section].label : "Activity";
  const description = route.view === "pr"
    ? "Fetched from the server whose link pattern matches. Works for any PR, whether or not you are part of it."
    : route.view === "section" ? SECTION_META[route.section].description : "";
  const compactList = phone && route.view === "section";

  const listBody = (
    <>
      {phone && <SectionChips route={route} overview={overview.data} onGo={(next) => go(next)} />}
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
          {!compactList && (
            <div className="px-4 pb-2.5 pt-3.5">
              <h2 className="text-sm font-semibold">{heading}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
            </div>
          )}
          {route.view === "section" && !phone && <Filters filter={filter} overview={overview.data} onChange={setFilter} />}
          {route.view === "pr" && isNotFound(loadError) ? (
            <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-sm text-muted-foreground">
              <span className="flex-1">Shuttle has not fetched {keyLabel(route.key)} yet.</span>
              <button type="button" className={BUTTON} disabled={lookup.isPending} onClick={() => void lookup.run({ query: route.key })}>Fetch it from its server</button>
            </div>
          ) : (
            loadError !== null && <div className="px-4 py-3"><ErrorNote>{messageOf(loadError)}</ErrorNote></div>
          )}
          {shown === undefined && loadError === null && <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>}
          {shown !== undefined && shown.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">{prs?.length === 0 ? "Nothing here." : "No PR matches the filter."}</div>
          )}
          {shown !== undefined && shown.length > 0 && (
            <ul aria-label="Pull requests" className={compactList ? "border-b border-border" : ""}>
              {shown.map((pr) => <PrRow key={pr.key} pr={pr} selected={pr.key === selectedKey} actions={actions} compact={compactList} />)}
            </ul>
          )}
        </section>
      )}
    </>
  );

  const detail = (onClose?: () => void) => selectedKey !== null && <PrDetail key={selectedKey} prKey={selectedKey} actions={actions} onClose={onClose} />;
  let body: ReactNode;
  if (phone && showDetail) {
    body = <PhonePrView prKey={selectedKey} backLabel={route.view === "section" ? SECTION_META[route.section].label : SECTION_META.needs.label} onBack={closeSelection} actions={actions} />;
  } else if (phone || !showDetail) {
    body = <div className="h-full min-h-0 overflow-y-auto">{listBody}</div>;
  } else if (overlay) {
    body = (
      <div className="relative h-full min-h-0 overflow-hidden">
        <div className="h-full overflow-y-auto">{listBody}</div>
        <div data-scrim className="absolute inset-0 z-10 bg-background/60" onClick={closeSelection} />
        <div data-overlay className="absolute inset-y-0 right-0 z-20 w-[min(560px,88%)] overflow-y-auto border-l border-border bg-card shadow-lg animate-in slide-in-from-right duration-200">
          {detail(closeSelection)}
        </div>
      </div>
    );
  } else if (viewport === "narrow") {
    body = <div className="h-full min-h-0 overflow-y-auto">{listBody}<div className="border-t border-border">{detail()}</div></div>;
  } else {
    body = (
      <div className="flex h-full min-h-0 flex-row">
        <div className="min-w-0 flex-1 overflow-y-auto">{listBody}</div>
        <div className="w-[min(640px,45%)] min-w-0 shrink-0 overflow-y-auto border-l border-border">
          {detail(route.view === "section" ? closeSelection : undefined)}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 min-w-0 bg-background text-foreground">
      {body}
      {dialog?.kind === "link" && <LinkDialog request={dialog.request} onClose={() => setDialog(null)} />}
      {dialog?.kind === "review" && config.data !== undefined && <ReviewDialog pr={dialog.pr} presets={config.data.config.presets} onClose={() => setDialog(null)} />}
    </div>
  );
}
