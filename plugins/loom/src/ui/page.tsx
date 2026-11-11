import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { experimental_usePluginId, useBbNavigate, type ExperimentalPageTitle, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { useLoom } from "./common";
import { intent, keysSheet, palette, rewind, useStore } from "./dispatch";
import { Guide } from "./guide";
import { Home } from "./home";
import { InsightsPage } from "./insights-all";
import { TipProvider } from "./kit";
import { KeysSheet } from "./keys-sheet";
import { NewProject } from "./new-project";
import { Palette } from "./palette";
import { needRoute, useQueue } from "./needs";
import { usePageOpen } from "./commands";
import { PlanningView } from "./planning";
import { ProjectShell } from "./project-shell";
import { createStored, useScrollMemory, useStored } from "./remember";
import { useLoomTheme } from "./theme";
import { projectViews, viewOf } from "./views";

export { controlDone, canSyncPullRequests } from "./controls";
export { sidewaysInto } from "./project-shell";

// 36rem, where Tailwind's @xl starts: under it the page's container queries (`@max-xl/loom:`) switch to the phone layout.
const NARROW_PX = 576;

const flag = () => {
  let on = false;
  const listeners = new Set<() => void>();
  return {
    get: () => on,
    set(next: boolean): void {
      if (next === on) return;
      on = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
};

/** Whether the Loom page measured itself narrower than NARROW_PX; bb's title bar over it reads this to shorten its crumbs. */
export const narrowPage = flag();

/**
 * Whether a ticket's project crumb, by its full name, would run into Loom's controls in bb's title bar. bb draws that crumb
 * as a link that never shrinks, so a long name paints through the controls; the header measures it and the crumb then
 * goes by the project's key, as it does on a phone.
 */
export const shortCrumb = flag();

export type Route = { view: "home" } | { view: "insights" } | { view: "guide" } | { view: "new" } | { view: "plan"; threadId: string } | { view: "project"; slug: string } | { view: "ticket"; slug: string; key: string };

/**
 * The route remainder: "_home" is home, "_insights" Insights across projects, "_guide" the guide, "_new" New project, "_plan/<threadId>" a conversation,
 * "<slug>" a project, "<slug>/<KEY>" a ticket. A slug never starts with "_". "" is where bb's rail opens the page, home
 * here; the page reopens there on the route it was last left on (see `routeOf`).
 */
export function parseRoute(subPath: string): Route {
  const [first, second] = subPath.split("/").filter((part) => part !== "");
  if (first === undefined || first === "_home") return { view: "home" };
  if (first === "_insights") return { view: "insights" };
  if (first === "_guide") return { view: "guide" };
  if (first === "_new") return { view: "new" };
  if (first === "_plan") return second === undefined ? { view: "home" } : { view: "plan", threadId: second };
  return second === undefined ? { view: "project", slug: first } : { view: "ticket", slug: first, key: second };
}

export function formatRoute(route: Route): string {
  switch (route.view) {
    case "home":
      return "_home";
    case "insights":
      return "_insights";
    case "guide":
      return "_guide";
    case "new":
      return "_new";
    case "plan":
      return `_plan/${route.threadId}`;
    case "project":
      return route.slug;
    case "ticket":
      return `${route.slug}/${route.key}`;
  }
}

/** The route the page was last left on, on this device. */
export const lastRoute = createStored<string | null>("lastRoute", null, (value) => (typeof value === "string" ? formatRoute(parseRoute(value)) : null));

/** The route a subPath shows: at "", where bb's rail opens the page, the route it was last left on. */
export function routeOf(subPath: string): Route {
  return parseRoute(subPath === "" ? (lastRoute.get() ?? "") : subPath);
}

/** Opens what bb's "next thing that needs you" command asked for, once home has loaded. */
function useIntent(go: (subPath: string, replace?: boolean) => void) {
  const wanted = useStore(intent);
  const home = useLoom("home", null, { enabled: wanted !== null }).data;
  const queue = useQueue(home);
  const navigate = useBbNavigate();
  useEffect(() => {
    if (wanted === null || queue === undefined) return;
    intent.set(null);
    const first = queue[0];
    const route = first === undefined ? "_home" : needRoute(first);
    if (route === null) navigate.toThread(first!.threadId!);
    else go(route, true);
  }, [wanted, queue]);
}

export function LoomPage({ subPath }: PluginNavPanelProps) {
  useLoomTheme();
  // bb's rail opens the page at its root. The page replaces that address with the place it was last left, home included,
  // so Back never lands on the root again and resumes a newer place.
  const remembered = useStored(lastRoute);
  const resume = subPath === "" ? (remembered ?? formatRoute({ view: "home" })) : null;
  const route = parseRoute(resume ?? subPath);
  const navigate = useBbNavigate();
  const go = useCallback((next: string, replace = false) => navigate.toPluginPanel("loom", { subPath: next, ...(replace ? { replace: true } : {}) }), [navigate]);
  useEffect(() => {
    if (subPath !== "") lastRoute.set(formatRoute(parseRoute(subPath)));
    else if (resume !== null) navigate.toPluginPanel("loom", { subPath: resume, replace: true });
    // Only a change of place counts; `navigate` is a new object on each render.
  }, [subPath, resume]);
  useIntent(go);
  usePageOpen();
  useStored(projectViews);
  const slug = route.view === "project" || route.view === "ticket" ? route.slug : null;
  const view = slug === null ? null : route.view === "ticket" ? "work" : viewOf(slug);
  // A planning conversation that proposed is its project's Planner view from then on; the redirect replaces the
  // conversation's address, so Back does not land on it and bounce forward again.
  const openPlanner = useCallback(
    (next: string) => {
      projectViews.put(next, "planner");
      navigate.toPluginPanel("loom", { subPath: next, replace: true });
    },
    [navigate],
  );
  const scroller = useScrollMemory(route.view === "project" ? `${formatRoute(route)}#${view}` : formatRoute(route));
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const scrollerRef = scroller.ref;
  const rootRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollerRef(node);
      setRoot(node);
    },
    [scrollerRef],
  );
  useLayoutEffect(() => {
    if (root === null || typeof ResizeObserver === "undefined") return;
    const measure = () => narrowPage.set(root.clientWidth > 0 && root.clientWidth < NARROW_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => {
      observer.disconnect();
      narrowPage.set(false);
    };
  }, [root]);
  // The rewind is the page's, shared through a store so the title bar disables its controls and every write is refused.
  const rewound = useStore(rewind);
  const at = rewound !== null && rewound.slug === slug ? rewound.at : null;
  const seek = useCallback((next: number | null) => rewind.set(next === null || slug === null ? null : { slug, at: next }), [slug]);
  useEffect(() => {
    if (rewound !== null && rewound.slug !== slug) rewind.set(null);
  }, [slug, rewound]);
  useEffect(() => () => rewind.set(null), []);
  // With focus on the body, bb takes Esc to leave the page; while rewound, Esc means Back to now.
  useEffect(() => {
    if (at === null) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.target !== document.body) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      seek(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [at, seek]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-confirm-armed]') !== null) return;
    if (event.key === "/") {
      event.preventDefault();
      palette.set(true);
    } else if (event.key === "?") {
      event.preventDefault();
      keysSheet.set(true);
    }
  };

  return (
    <TipProvider>
      <section data-loom-page data-loom-root onKeyDown={onKeyDown} className="loom-cloth flex h-full min-h-0 min-w-0 flex-col text-foreground">
        {/* The page's narrow layouts (`@max-xl/loom:`) ask this box by name, not a part's own container; it never scrolls sideways. */}
        <div ref={rootRef} onScroll={scroller.onScroll} data-loom-scroll className="@container/loom min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          {route.view === "home" && <Home go={go} />}
          {route.view === "insights" && <InsightsPage go={go} />}
          {route.view === "guide" && <Guide onStart={() => go("_new")} />}
          {route.view === "new" && <NewProject go={go} />}
          {route.view === "plan" && <PlanningView threadId={route.threadId} openProject={openPlanner} />}
          {slug !== null && <ProjectShell key={slug} slug={slug} ticketKey={route.view === "ticket" ? route.key : null} at={at} onSeek={seek} go={go} />}
        </div>
        <Palette route={route} go={go} />
        <KeysSheet />
      </section>
    </TipProvider>
  );
}

/**
 * bb's title bar on the Loom page: where the page is, with a ticket's project linking back to it. Home keeps bb's own
 * "Loom". On a narrow page, or where its name would run into Loom's controls, a ticket's project goes by its key, as bb
 * does not shorten that crumb.
 */
export function useLoomPageTitle({ subPath }: PluginNavPanelProps): ExperimentalPageTitle | null {
  const pluginId = experimental_usePluginId();
  useStored(lastRoute);
  const narrow = useSyncExternalStore(narrowPage.subscribe, narrowPage.get, narrowPage.get);
  const short = useSyncExternalStore(shortCrumb.subscribe, shortCrumb.get, shortCrumb.get);
  const route = routeOf(subPath);
  const slug = route.view === "project" || route.view === "ticket" ? route.slug : null;
  // The sidebar's reads of home and of the conversation, so the names cost no read of their own, even on a ticket, whose page reads no project.
  const project = useLoom("home", null, { enabled: slug !== null }).data?.projects.find((entry) => entry.slug === slug);
  const name = project?.name ?? slug ?? "";
  const conversation = useLoom("planningSession", { threadId: route.view === "plan" ? route.threadId : "" }, { enabled: route.view === "plan" }).data?.title;
  switch (route.view) {
    case "home":
      return null;
    case "insights":
      return { title: "Insights" };
    case "guide":
      return { title: "How Loom works" };
    case "new":
      return { title: "New project" };
    case "plan":
      return conversation === undefined ? { title: "Planning" } : { breadcrumbs: [{ label: "Planning" }, { label: conversation }] };
    case "project":
      return { title: name };
    case "ticket":
      return { breadcrumbs: [{ label: narrow || short ? (project?.key ?? name) : name, to: `/plugins/${encodeURIComponent(pluginId)}/loom/${encodeURIComponent(route.slug)}` }, { label: route.key }] };
  }
}
