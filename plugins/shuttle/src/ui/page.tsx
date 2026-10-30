import { useEffect, useRef, type ReactNode } from "react";
import { experimental_Icon as Icon, useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { Overview } from "../contract";
import { ActionsProvider, nudgeText, runNext, useActions } from "./actions";
import { BUTTON, ErrorNote, ICON_GHOST_LARGE, PAGE, PageHeading } from "./common";
import { AREA_META, PANEL_PATH } from "./constants";
import { isNotFound, messageOf, threadsOf, useShuttleMutation, useShuttleQuery } from "./data";
import { PrDetail } from "./detail";
import { PrMenu, TrackButton } from "./pr-menu";
import { keyLabel } from "./format";
import { BoardDetailView, BoardsView } from "./boards";
import { InboxView } from "./inbox";
import { InsightsView, type IdeaAction } from "./insights";
import { MineView } from "./mine";
import { SyncBanner } from "./sync";
import { isLive } from "./pills";
import { lastRoute, reviewFilter } from "./prefs";
import { useStored } from "./remember";
import { ReviewsView } from "./reviews";
import { SearchView } from "./search";
import { areaOf, formatRoute, parseRoute, type Area, type ListRoute, type Route } from "./route";
import type { RowLayout } from "./row";
import { useScrollMemory } from "./scroll";
import { useSurface } from "./surface";
import { useViewport } from "./viewport";

const AREAS: readonly Area[] = ["inbox", "mine", "reviews", "boards", "insights"];
const AREA_ROUTES: Record<Area, Route> = {
  inbox: { view: "inbox", key: null },
  mine: { view: "mine", key: null },
  reviews: { view: "reviews", source: "all", key: null },
  boards: { view: "boards", tab: "active" },
  insights: { view: "insights", tab: "overview" },
};
const INBOX: Route = AREA_ROUTES.inbox;

const isListRoute = (route: Route): route is ListRoute => route.view === "inbox" || route.view === "mine" || route.view === "done" || route.view === "reviews" || route.view === "search" || route.view === "board";

function countOf(area: Area, overview: Overview | undefined): number | null {
  if (overview === undefined || area === "insights" || area === "boards") return null;
  return overview.counts[area];
}

/** A narrow window's way between the areas, under the header. */
function AreaChips({ route, overview, onGo }: { route: Route; overview: Overview | undefined; onGo(next: Route): void }) {
  const current = areaOf(route);
  const chip = (on: boolean) => `inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs ${on ? "border-input bg-state-active text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`;
  return (
    <nav aria-label="Areas" className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-border px-3 py-2 [scrollbar-width:none]">
      {AREAS.map((area) => {
        const count = countOf(area, overview);
        return (
          <button key={area} type="button" aria-current={current === area ? "page" : undefined} className={chip(current === area)} onClick={() => onGo(AREA_ROUTES[area])}>
            <Icon name={AREA_META[area].icon} fallback="Circle" className="size-3.5" aria-hidden />
            {AREA_META[area].label}
            {count !== null && <b className="font-semibold text-foreground">{count}</b>}
          </button>
        );
      })}
    </nav>
  );
}

/** A phone's way between the areas, at the thumb, with the Inbox's count. */
function TabBar({ route, overview, onGo }: { route: Route; overview: Overview | undefined; onGo(next: Route): void }) {
  const current = areaOf(route);
  const inbox = overview?.counts.inbox ?? 0;
  return (
    <nav aria-label="Areas" className="flex shrink-0 border-t border-border bg-card px-1 pb-4 pt-1.5">
      {AREAS.map((area) => (
        <button key={area} type="button" aria-current={current === area ? "page" : undefined} onClick={() => onGo(AREA_ROUTES[area])}
          className={`relative flex flex-1 cursor-pointer flex-col items-center gap-0.5 text-[10.5px] ${current === area ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
          <Icon name={AREA_META[area].icon} fallback="Circle" className="size-5" aria-hidden />
          {AREA_META[area].label}
          {area === "inbox" && inbox > 0 && (
            <span data-badge className="absolute -top-1 left-[calc(50%+5px)] rounded-full bg-warning px-1.5 text-[9.5px] font-bold leading-[15px] text-background">{inbox}</span>
          )}
        </button>
      ))}
    </nav>
  );
}

/** A phone's PR screen: back, Track and Open at the top, the PR in between, its next step and Comment at the thumb. */
function PhonePrView({ prKey, backLabel, onBack }: { prKey: string; backLabel: string; onBack(): void }) {
  const actions = useActions();
  const pr = useShuttleQuery("detail", { key: prKey }).data?.pr;
  const scroller = useScrollMemory(`pr/${prKey}`, true);
  const { intent, done } = actions;
  // A phone has no composer in the PR view: a pending "compose" opens the comment sheet instead.
  useEffect(() => {
    if (pr === undefined || intent?.kind !== "compose" || intent.key !== pr.key) return;
    done(intent);
    actions.compose(pr, intent.nudge ? nudgeText(pr) : intent.text);
  }, [intent, done, pr, actions]);
  const step = pr === undefined ? null : pr.next.primary ?? pr.next.more[0] ?? null;
  // The sheet's button says what its composer can do: comment, review, or only write to the agent.
  const compose = pr === undefined ? null
    : pr.can.comment ? { label: "Comment", icon: "MessageSquare" }
      : !pr.mine && pr.can.review ? { label: "Review", icon: "Check" }
        : pr.mine && pr.agent !== null ? { label: "Ask the agent", icon: "Bot" } : null;
  const canComment = compose !== null;
  const wide = "inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2.5 text-sm";
  return (
    <div data-phone-pr className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
        <button type="button" aria-label={`Back to ${backLabel}`} className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-md px-1.5 text-sm text-foreground hover:bg-state-hover" onClick={onBack}>
          <Icon name="ChevronLeft" className="size-4" aria-hidden />{backLabel}
        </button>
        <span className="flex-1" />
        {pr !== undefined && !pr.mine && <TrackButton pr={pr} iconOnly />}
        {pr !== undefined && (
          <button type="button" aria-label={`Open on ${pr.serverName}`} title={`Open on ${pr.serverName}`} className={ICON_GHOST_LARGE} onClick={() => actions.open(pr)}>
            <Icon name="ExternalLink" className="size-4" aria-hidden />
          </button>
        )}
        {pr !== undefined && <PrMenu pr={pr} triggerClassName={ICON_GHOST_LARGE} />}
      </div>
      <div ref={scroller.ref} onScroll={scroller.onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <PrDetail key={prKey} prKey={prKey} phone />
      </div>
      {pr !== undefined && isLive(pr) && (step !== null || canComment) && (
        <div data-phone-actions className="flex shrink-0 gap-2 border-t border-border bg-card px-3 pb-4 pt-2.5">
          {step !== null && (
            <button type="button" data-next={step.id} className={`${wide} flex-[2] ${pr.next.primary !== null ? "border-foreground bg-foreground font-medium text-background" : "border-input bg-transparent"}`}
              onClick={() => runNext(actions, pr, step.id)}>
              {step.label}
            </button>
          )}
          {compose !== null && (
            <button type="button" className={`${wide} flex-1 border-border bg-card`} onClick={() => actions.compose(pr)}>
              <Icon name={compose.icon} className="size-3.5" aria-hidden />{compose.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The four areas, the PR list and the PR view; bb's sidebar holds the areas on a desktop (see sidebar.tsx). */
export function ShuttlePage({ subPath }: PluginNavPanelProps) {
  // bb opens the page at its root from the rail: that is where it was last left, until the URL says so too.
  const remembered = useStored(lastRoute);
  const resume = subPath === "" && remembered !== null ? remembered : null;
  const route = parseRoute(resume ?? subPath);
  const viewport = useViewport();
  const phone = viewport === "phone";
  const navigate = useBbNavigate();
  const overview = useShuttleQuery("overview", {});
  const filter = useStored(reviewFilter);
  const setFilter = reviewFilter.set;

  const selectedKey = route.view === "insights" || route.view === "boards" ? null : route.key;
  const inbox = useShuttleQuery("inbox", {}, route.view === "inbox");
  const listArea = route.view === "mine" || route.view === "done" || route.view === "reviews" ? route.view : "mine";
  const list = useShuttleQuery("list", { area: listArea }, route.view === "mine" || route.view === "done" || route.view === "reviews");
  const detail = useShuttleQuery("detail", { key: selectedKey ?? "" }, selectedKey !== null);
  const lookup = useShuttleMutation("lookup");
  const known = [...(inbox.data?.prs ?? []), ...(list.data?.prs ?? []), ...(detail.data ? [detail.data.pr] : [])];
  const threadIds = threadsOf(known);

  // Opening a PR from a list pushes a history entry, so Back and the swipe return to the list;
  // switching between PRs replaces it. A page opened on a PR (a deep link) never pushed one.
  const pushed = useRef(false);
  useEffect(() => {
    if (selectedKey === null) pushed.current = false;
  }, [selectedKey]);
  // A PR opened as a full page from beside a list goes back there; one reached another way goes beside its own list.
  const expanded = useRef(false);
  useEffect(() => {
    if (route.view !== "pr") expanded.current = false;
  }, [route.view]);

  const go = (next: Route, replace = false) => navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute(next), ...(replace ? { replace: true } : {}) });
  const here = formatRoute(route);
  useEffect(() => {
    if (subPath !== "") lastRoute.set(here);
    else if (resume !== null) navigate.toPluginPanel(PANEL_PATH, { subPath: resume, replace: true });
    // Only a change of place counts; `navigate` is a new object on each render.
  }, [subPath, resume, here]);
  const scroller = useScrollMemory(route.view === "pr" ? `pr/${route.key}` : isListRoute(route) ? formatRoute({ ...route, key: null }) : here, route.view === "pr");
  const prScroller = useScrollMemory(selectedKey === null ? null : `pr/${selectedKey}`, true);
  const select = (key: string) => {
    if (!isListRoute(route)) {
      if (route.view === "pr" && route.key === key) return;
      if (route.view !== "pr") pushed.current = true;
      return go({ view: "pr", key }, route.view === "pr");
    }
    if (route.key === key) return;
    if (route.key === null) pushed.current = true;
    go({ ...route, key }, route.key !== null);
  };
  const closeSelection = () => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    } else if (isListRoute(route)) {
      go({ ...route, key: null }, true);
    } else {
      go(INBOX, true);
    }
  };
  const close = useRef(closeSelection);
  close.current = closeSelection;
  const expand = (key: string) => {
    expanded.current = true;
    go({ view: "pr", key });
  };
  const collapse = (key: string) => {
    if (expanded.current) {
      expanded.current = false;
      return window.history.back();
    }
    const pr = detail.data?.pr;
    const home: Route = pr === undefined || !pr.mine ? { view: "reviews", source: "all", key } : pr.state === "merged" || pr.state === "closed" ? { view: "done", key } : { view: "mine", key };
    go(home, true);
  };

  const { actions, dialogs, dialogOpen, raise } = useSurface({ phone, sheetComposer: phone, selected: selectedKey, select, threadIds });
  const { writes } = actions;

  const onIdea = (action: IdeaAction) => {
    switch (action.id) {
      case "nudge":
        if (action.key === null) return;
        pushed.current = true;
        go({ view: "pr", key: action.key });
        // The composer writes the nudge from the PR's requested reviewers once the PR has loaded.
        return raise(action.key, "compose", { nudge: true });
      case "auto_agent": return void writes.setAutoAgent(true);
      case "hide_bots":
        setFilter({ ...filter, hideBots: true });
        return go({ view: "reviews", source: "all", key: null });
      case "show_quiet":
        setFilter({ ...filter, hideQuiet: false });
        return go({ view: "reviews", source: "asked", key: null });
      case "edit_preset": return;
    }
  };

  const lookedUp = route.view === "pr" ? detail : null;
  const showDetail = selectedKey !== null && (route.view !== "pr" || detail.data !== undefined);
  const overlay = viewport === "narrow" && isListRoute(route) && showDetail;
  useEffect(() => {
    if (!overlay || dialogOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // bb's "Back to app" also listens for Escape; while the panel is open, Escape closes the panel.
      event.preventDefault();
      close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlay, dialogOpen]);

  const layout: RowLayout = { selected: selectedKey, compact: phone || (showDetail && viewport === "wide"), phone, onSelect: select };

  let area: ReactNode;
  switch (route.view) {
    case "inbox": area = <InboxView layout={layout} onGo={go} />; break;
    case "mine":
    case "done": area = <MineView done={route.view === "done"} layout={layout} overview={overview.data} onGo={go} />; break;
    case "reviews": area = <ReviewsView source={route.source} filter={filter} layout={layout} onFilter={setFilter} onGo={go} />; break;
    case "boards": area = <BoardsView tab={route.tab} onGo={go} />; break;
    case "board": area = <BoardDetailView id={route.id} layout={layout} onGo={go} />; break;
    case "search": area = <SearchView query={route.query} layout={layout} />; break;
    case "insights": area = <InsightsView tab={route.tab} onTab={(tab) => go({ view: "insights", tab })} onAction={onIdea} onOpenPr={select} />; break;
    case "pr": area = !phone && showDetail ? <PrDetail key={route.key} prKey={route.key} page onCollapse={() => collapse(route.key)} /> : (
      <div className={PAGE}>
        <PageHeading title="Look up" description="Fetched from the server whose link pattern matches. Works for any PR, whether or not you are part of it." />
        {isNotFound(lookedUp?.error ?? null) ? (
          <div className="flex flex-wrap items-center gap-2 pb-3 text-sm text-muted-foreground">
            <span className="flex-1">Shuttle has not fetched {keyLabel(route.key)} yet.</span>
            <button type="button" className={BUTTON} disabled={lookup.isPending} onClick={() => void lookup.run({ query: route.key })}>Fetch it from its server</button>
          </div>
        ) : lookedUp?.error != null && <ErrorNote>{messageOf(lookedUp.error)}</ErrorNote>}
        {lookedUp?.data === undefined && lookedUp?.error === null && <div className="py-6 text-sm text-muted-foreground">Loading…</div>}
      </div>
    ); break;
  }

  const notices = (
    <>
      {overview.error !== null && <div className="px-4 pt-3"><ErrorNote>Could not load Shuttle's status: {messageOf(overview.error)}</ErrorNote></div>}
      {overview.data !== undefined && !(route.view === "insights" && route.tab === "sync") && (
        <SyncBanner servers={overview.data.servers} onSeeWhy={() => go({ view: "insights", tab: "sync" })} />
      )}
      {phone && overview.data?.paused === true && (
        <div role="status" className="mx-4 mt-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning-text">
          Automations are paused: no auto reviews, and nothing is sent to agents. Lists keep syncing.
        </div>
      )}
    </>
  );

  const detailPanel = (onClose?: () => void) => selectedKey !== null && <PrDetail key={selectedKey} prKey={selectedKey} onClose={onClose} onExpand={() => expand(selectedKey)} />;
  const backLabel = route.view === "pr" ? "Back" : route.view === "search" ? "Search" : AREA_META[areaOf(route) ?? "inbox"].label;
  let body: ReactNode;
  if (phone && showDetail) {
    body = <PhonePrView prKey={selectedKey!} backLabel={backLabel} onBack={closeSelection} />;
  } else if (phone) {
    body = (
      <div className="flex h-full min-h-0 flex-col">
        <div ref={scroller.ref} onScroll={scroller.onScroll} data-scroller className="min-h-0 flex-1 overflow-y-auto">{notices}{area}</div>
        <TabBar route={route} overview={overview.data} onGo={(next) => go(next)} />
      </div>
    );
  } else if (viewport === "narrow") {
    body = (
      <div className="flex h-full min-h-0 flex-col">
        <AreaChips route={route} overview={overview.data} onGo={(next) => go(next)} />
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div ref={scroller.ref} onScroll={scroller.onScroll} data-scroller className="h-full overflow-y-auto">{notices}{area}</div>
          {overlay && (
            <>
              <div data-scrim className="absolute inset-0 z-10 bg-background/60" onClick={closeSelection} />
              <div ref={prScroller.ref} onScroll={prScroller.onScroll} data-overlay className="absolute inset-y-0 right-0 z-20 w-[min(640px,88%)] overflow-y-auto border-l border-border bg-background shadow-lg animate-in slide-in-from-right duration-200">
                {detailPanel(closeSelection)}
              </div>
            </>
          )}
        </div>
      </div>
    );
  } else if (showDetail && isListRoute(route)) {
    body = (
      <div className="flex h-full min-h-0 flex-row">
        <div ref={scroller.ref} onScroll={scroller.onScroll} data-scroller className="min-w-0 flex-1 overflow-y-auto">{notices}{area}</div>
        <div ref={prScroller.ref} onScroll={prScroller.onScroll} data-panel className="w-[640px] min-w-0 max-w-[55%] shrink-0 overflow-y-auto border-l border-border">{detailPanel(closeSelection)}</div>
      </div>
    );
  } else {
    body = <div ref={scroller.ref} onScroll={scroller.onScroll} data-scroller className="h-full min-h-0 overflow-y-auto">{notices}{area}</div>;
  }

  return (
    <ActionsProvider value={actions}>
      <div className="h-full min-h-0 min-w-0 bg-background text-foreground">
        {body}
        {dialogs}
      </div>
    </ActionsProvider>
  );
}
