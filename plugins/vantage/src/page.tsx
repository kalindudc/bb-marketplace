import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import {
  ThreadChat, experimental_Icon as Icon, experimental_useAppPanel, useBbNavigate, useRealtime,
  type ExperimentalPageTitle, type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { Overview } from "./contract";
import { createArchivedPreference } from "./archived-preference";
import { AllChanges } from "./changes";
import { FilterChips, WorktreeList } from "./list";
import { LiveThreadsProvider, resolveLive, useLiveThread, useSidebarIndex } from "./live";
import { plural, reviewStarted, type Outside, type Row } from "./model";
import { Overlaps } from "./overlaps";
import { Review, StatusGlyph, isTyping } from "./review";
import { useSetReviewed } from "./reviewed";
import { formatRoute, parseRoute, type PageRoute } from "./route";
import { reloadLoaded } from "./loaded";
import { useSession, useShared } from "./session";
import { comments, useLoaders } from "./shared";
import { Skeleton, SkeletonRows } from "./skeleton";
import { groupBy, pageChip, pageText } from "./ui-prefs";
import { useRows, type RowsData } from "./use-rows";

export const PAGE_PATH = "vantage";
export const PAGE_PANEL_ID = "vantage";
export const AGENT_TAB_ID = "agent";
const NARROW_BELOW_PX = 760;

const archivedPreference = createArchivedPreference(window, "page");

function usePage(subPath: string) {
  const { route, canonical } = useMemo(() => parseRoute(subPath), [subPath]);
  const includeArchived = useSyncExternalStore(archivedPreference.subscribe, archivedPreference.get, archivedPreference.get);
  const session = useSession("page", route.target, includeArchived);
  useRealtime("vantage:settings", () => { session.store?.refresh(); });
  return { route, canonical, ...session };
}

function useGo() {
  const navigate = useBbNavigate();
  const ref = useRef(navigate);
  ref.current = navigate;
  return useCallback((next: PageRoute, replace = false) => {
    ref.current.toPluginPanel(PAGE_PATH, { subPath: formatRoute(next), ...(replace ? { replace: true } : {}) });
  }, []);
}

function usePageRows(overview: Overview | null): RowsData {
  const text = useShared(pageText);
  const chip = useShared(pageChip);
  const by = useShared(groupBy);
  return useRows(overview, { currentThreadId: null, text, chip, groupBy: by });
}

const rootTitle = (overview: Overview | null, route: PageRoute, title: string | null): string =>
  route.target.kind === "all" ? `All threads${overview?.windowHours == null ? "" : ` · last ${overview.windowHours} h`}` : (title ?? "This tree");

function useOpenAgent() {
  const panel = experimental_useAppPanel();
  return useCallback(() => {
    panel.experimental_openTab({ surface: { kind: "current" }, tab: { id: AGENT_TAB_ID, context: { kind: "nav-panel", panelId: PAGE_PANEL_ID }, availability: "fixed" } });
  }, [panel]);
}

const BUTTON = "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border-seam bg-card px-2.5 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function Metric({ value, label, tone = "text-foreground", onClick }: { value: number; label: string; tone?: string; onClick(): void }) {
  return (
    <button type="button" onClick={onClick} data-metric={label}
      className="grid cursor-pointer gap-0.5 rounded-xl border border-border-seam bg-card px-3.5 py-3 text-left hover:border-ring">
      <span className={`text-2xl font-semibold ${tone}`}>{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </button>
  );
}

function RowLine({ row, action, onAction, titleOf }: { row: Row; action: string; onAction(): void; titleOf(key: string): string }) {
  const overlap = row.bucket === "archived" ? undefined : row.overlaps[0];
  let reason: ReactNode;
  if (row.bucket === "unavailable") reason = <span className="text-destructive-text">{row.worktree.message ?? "This worktree cannot be read"}</span>;
  else if (row.bucket === "needs") reason = <span className={row.live.indicator === "unread-error" ? "text-destructive-text" : "text-foreground"}>{row.live.sidebar?.indicatorLabel ?? "Needs you"}</span>;
  else if (overlap !== undefined) reason = <span className="text-warning-text">Overlaps with {titleOf(overlap.otherKeys[0]!)} in {overlap.path}</span>;
  else if (reviewStarted(row) && row.progress !== null) reason = <span className="text-muted-foreground">{row.progress.reviewed} of {row.progress.total} files reviewed</span>;
  else reason = <span className="text-muted-foreground">{plural(row.worktree.uncommitted.length + row.worktree.committed.length, "file")} changed</span>;
  const loading = row.worktree.state === "loading";
  return (
    <div className="flex items-center gap-3 border-t border-border-seam px-4 py-2.5 first:border-t-0">
      <span className="flex size-4 shrink-0 items-center justify-center"><StatusGlyph row={row} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{row.title}</span>
          <span className="shrink-0 whitespace-nowrap font-mono text-[11px]">
            {loading ? <Skeleton className="h-3 w-12 align-middle" /> : <><span className="text-diff-added">+{row.additions}</span> <span className="text-diff-removed">−{row.deletions}</span></>}
          </span>
        </span>
        <span className="block min-w-0 truncate text-xs text-muted-foreground">
          {row.worktree.label}{row.worktree.branch === null ? "" : ` · ${row.worktree.branch}`} · {loading ? "reading its changes…" : reason}
        </span>
      </span>
      <button type="button" onClick={onAction} className={row.bucket === "needs" ? "h-7 shrink-0 cursor-pointer rounded-md bg-primary px-2.5 text-xs text-primary-foreground hover:opacity-90" : BUTTON}>{action}</button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">{title}</h3>
      <div className="overflow-hidden rounded-xl border border-border-seam bg-card">{children}</div>
    </section>
  );
}

function PageOverview({ overview, route, data, onOpen, onAnswer, onOverlaps, onChanges, onOutside }: {
  overview: Overview; route: PageRoute; data: RowsData; onOpen(key: string): void; onAnswer(key: string): void; onOverlaps(): void; onChanges(): void; onOutside(entry: Outside): void;
}) {
  const rootId = route.target.kind === "tree" ? route.target.threadId : "";
  const root = useLiveThread(rootId, overview.threads.find((thread) => thread.id === rootId));
  const { rows, counts } = data;
  const active = rows.filter((row) => row.bucket !== "archived");
  const next = [...rows.filter((row) => row.bucket === "needs"), ...rows.filter((row) => row.bucket === "review"), ...rows.filter((row) => row.bucket === "unavailable")];
  const working = rows.filter((row) => row.bucket === "working");
  const reviewed = rows.filter((row) => row.bucket === "reviewed");
  const files = active.reduce((total, row) => total + row.worktree.uncommitted.length + row.worktree.committed.length, 0);
  const projects = new Set(active.map((row) => row.worktree.projectId)).size;
  const first = next[0] ?? rows[0];
  return (
    <div data-page-overview className="mx-auto w-full max-w-4xl px-7 pb-10 pt-7">
      <h1 className="text-xl font-semibold text-foreground">{route.target.kind === "tree" ? root.title : `All threads in the last ${overview.windowHours ?? 24} hours`}</h1>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
        <span>{plural(active.length, "worktree")} in {plural(projects, "project")} · {plural(files, "file")}</span>
        <span className="flex-1" />
        <button type="button" className={BUTTON} onClick={onChanges}>All changes</button>
        {first !== undefined && (
          <button type="button" onClick={() => onOpen(first.worktree.key)} className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:opacity-90">
            Start reviewing<span className="rounded border border-primary-foreground/40 px-1 text-[10px]">]</span>
          </button>
        )}
      </div>
      <div className="mt-5 grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <Metric value={counts.needs} label="Need you" onClick={() => pageChip.set("needs")} />
        <Metric value={counts.review} label="To review" onClick={() => pageChip.set("review")} />
        <Metric value={counts.working} label="Working" onClick={() => pageChip.set("working")} />
        <Metric value={counts.overlaps} label="Overlapping files" tone={counts.overlaps > 0 ? "text-warning-text" : "text-foreground"} onClick={onOverlaps} />
      </div>
      {overview.partial && <SkeletonRows count={3} label="Reading every worktree's changes" />}
      {next.length > 0 && (
        <Section title="Up next">
          {next.map((row) => (
            <RowLine key={row.worktree.key} row={row} titleOf={data.titleOf}
              action={row.bucket === "needs" ? (row.live.indicator === "waiting-for-input" ? "Answer" : "Open") : row.bucket === "review" ? "Review" : "Open"}
              onAction={() => (row.bucket === "needs" && row.live.indicator === "waiting-for-input" ? onAnswer(row.worktree.key) : onOpen(row.worktree.key))} />
          ))}
        </Section>
      )}
      {working.length > 0 && (
        <Section title="Working">
          {working.map((row) => <RowLine key={row.worktree.key} row={row} titleOf={data.titleOf} action="Open" onAction={() => onOpen(row.worktree.key)} />)}
        </Section>
      )}
      {counts.overlaps > 0 && (
        <Section title="Overlapping files">
          {overview.sharedFiles.filter((file) => file.worktreeKeys.some((key) => data.rowFor(key)?.bucket !== "archived")).map((file) => (
            <div key={`${file.projectId}\0${file.path}`} className="flex items-center gap-3 border-t border-border-seam px-4 py-2.5 first:border-t-0">
              <Icon name="AlertTriangle" className="size-3.5 shrink-0 text-warning-text" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm">
                <span className="font-mono text-foreground">{file.path}</span>
                <span className="text-muted-foreground"> · changed by {file.worktreeKeys.map(data.titleOf).join(" and ")}</span>
              </span>
              <button type="button" className={BUTTON} onClick={onOverlaps}>Compare</button>
            </div>
          ))}
        </Section>
      )}
      {reviewed.length > 0 && (
        <Section title="Reviewed">
          {reviewed.map((row) => <RowLine key={row.worktree.key} row={row} titleOf={data.titleOf} action="Open" onAction={() => onOpen(row.worktree.key)} />)}
        </Section>
      )}
      {data.outside.length > 0 && (
        <Section title="Changed outside worktrees">
          {data.outside.map((entry) => (
            <div key={entry.key} className="flex items-center gap-3 border-t border-border-seam px-4 py-2.5 first:border-t-0">
              <Icon name={entry.kind === "repo" ? "Folder" : "EditFile"} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{entry.title} <span className="text-muted-foreground">· {entry.detail} · {plural(entry.files, "file")}</span></span>
              <button type="button" className={BUTTON} onClick={() => onOutside(entry)}>Show</button>
            </div>
          ))}
        </Section>
      )}
      {rows.length === 0 && data.outside.length === 0 && !overview.partial && (
        <p className="mt-8 text-sm text-muted-foreground">
          {overview.worktrees.length === 0
            ? (route.target.kind === "all" ? `No worktrees in the last ${overview.windowHours ?? 24} hours.` : "No worktrees in this thread or its child threads yet.")
            : "Nothing has changed in these worktrees yet."}
        </p>
      )}
    </div>
  );
}

function Banners({ overview, error, status, onRetry, all }: { overview: Overview | null; error: string | null; status: string; onRetry(): void; all: boolean }) {
  const notices = overview === null ? [] : [
    ...overview.warnings,
    ...(overview.truncatedThreads ? [all ? `Showing the ${overview.threads.length} most recent threads; raise the limit in Vantage's settings` : "Only the first 200 threads of this tree were read."] : []),
  ];
  return (
    <>
      {status === "error" && (
        <div role="alert" className="border-b border-border-seam px-5 py-3 text-sm text-destructive-text">
          Could not load changes: {error}<button type="button" className="ml-2 cursor-pointer underline" onClick={onRetry}>Retry</button>
        </div>
      )}
      {status === "ready" && error !== null && (
        <div role="alert" className="border-b border-border-seam px-5 py-2 text-xs text-warning-text">
          Could not refresh: {error}<button type="button" className="ml-2 cursor-pointer underline" onClick={onRetry}>Retry</button>
        </div>
      )}
      {notices.map((notice) => <div key={notice} role="status" className="border-b border-border-seam px-5 py-2 text-xs text-warning-text">{notice}</div>)}
    </>
  );
}

function PageScreen({ subPath }: PluginNavPanelProps) {
  const { route, canonical, store, snapshot } = usePage(subPath);
  const go = useGo();
  const navigate = useBbNavigate();
  const openAgent = useOpenAgent();
  const loaders = useLoaders();
  const setReviewed = useSetReviewed();
  const text = useShared(pageText);
  const { overview } = snapshot;
  const data = usePageRows(overview);
  useEffect(() => { if (canonical !== subPath) go(route, true); }, [canonical, subPath, route, go]);

  const rootRef = useRef<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null || typeof ResizeObserver === "undefined") return;
    setNarrow(root.getBoundingClientRect().width < NARROW_BELOW_PX);
    const observer = new ResizeObserver((entries) => {
      const width = entries.at(-1)?.contentRect.width;
      if (width !== undefined) setNarrow(width < NARROW_BELOW_PX);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const selectedKey = route.selectedKey;
  const row = selectedKey === null ? null : data.rowFor(selectedKey);
  useEffect(() => {
    // The outline may leave out a worktree the full overview has, so only the full result can say it is gone.
    if (overview !== null && !overview.partial && selectedKey !== null && row === null) go({ ...route, selectedKey: null }, true);
  }, [overview, selectedKey, row, route, go]);
  const open = useCallback((key: string) => go({ ...route, view: "overview", selectedKey: key, focus: null }), [go, route]);
  const home = useCallback(() => go({ ...route, view: "overview", selectedKey: null, focus: null }), [go, route]);
  const index = row === null ? -1 : data.order.findIndex((entry) => entry.worktree.key === row.worktree.key);
  const step = useCallback((delta: -1 | 1) => {
    const list = data.order;
    if (list.length === 0) return;
    const next = index === -1 ? list[delta > 0 ? 0 : list.length - 1] : list[index + delta];
    if (next !== undefined) open(next.worktree.key);
  }, [data.order, index, open]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || isTyping(event.target)) return;
    if (event.key === "[") step(-1);
    else if (event.key === "]") step(1);
    else if (event.key === "Escape" && (route.selectedKey !== null || route.view !== "overview")) home();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const compare = (path: string) => {
    go({ ...route, view: "overlaps", selectedKey: null, focus: null });
    // The overlaps page draws its cards only once every worktree's files are known, so look again for a few seconds.
    let tries = 0;
    const look = () => {
      const card = [...document.querySelectorAll<HTMLElement>("[data-overlap]")].find((entry) => entry.dataset.overlap === path);
      if (card !== undefined) card.scrollIntoView?.({ block: "start" });
      else if (tries++ < 40) setTimeout(look, 100);
    };
    requestAnimationFrame(look);
  };
  const openOutside = (entry: Outside) => go({ ...route, view: "changes", selectedKey: null, focus: entry.kind === "repo" ? { kind: "repo", key: entry.key } : { kind: "otherFiles" } });

  let body: ReactNode;
  if (overview === null) body = snapshot.status === "error" ? null : <SkeletonRows count={4} label="Loading worktrees" />;
  else if (row !== null) {
    const review = (
      <Review key={row.worktree.key} overview={overview} row={row} index={index} total={data.order.length} compact={narrow} currentThreadId={null} currentHostId={null}
        terminal="environment" marks={data.marks[row.worktree.key]} titleOf={data.titleOf} branchOf={data.branchOf} comments={comments}
        loaders={loaders} setReviewed={setReviewed} onStep={step}
        onMessage={openAgent} onCompare={compare} onSent={openAgent} />
    );
    // A compact review is one column with no scroll area of its own.
    body = narrow ? <div className="h-full overflow-y-auto">{review}</div> : review;
  } else if (route.view === "changes") {
    body = (
      <div className="h-full overflow-y-auto pt-2">
        <AllChanges overview={overview} scope={snapshot.scope} onScope={(scope) => store?.setScope(scope)} focus={route.focus}
          onClearFocus={() => go({ ...route, focus: null })} text={text} loaders={loaders} onOpenThread={(id) => navigate.toThread(id)} />
      </div>
    );
  } else if (route.view === "overlaps") {
    body = <div className="h-full overflow-y-auto"><Overlaps overview={overview} rows={data.rows} titleOf={data.titleOf} loaders={loaders} comments={comments} onReview={open} text={text} /></div>;
  } else {
    body = (
      <div className="h-full overflow-y-auto">
        <PageOverview overview={overview} route={route} data={data} onOpen={open} onAnswer={(key) => { open(key); openAgent(); }}
          onOverlaps={() => go({ ...route, view: "overlaps", selectedKey: null, focus: null })}
          onChanges={() => go({ ...route, view: "changes", selectedKey: null, focus: null })} onOutside={openOutside} />
      </div>
    );
  }

  return (
    <section ref={rootRef} data-vantage-page tabIndex={-1} onKeyDown={onKeyDown} className="flex h-full min-h-0 min-w-0 flex-col bg-surface-recessed text-foreground">
      <div className="shrink-0">
        <Banners overview={overview} error={snapshot.error} status={snapshot.status} onRetry={() => store?.refresh({ hard: true })} all={route.target.kind === "all"} />
      </div>
      <div className="min-h-0 flex-1">{body}</div>
    </section>
  );
}

export function VantagePage(props: PluginNavPanelProps) {
  return <LiveThreadsProvider><PageScreen {...props} /></LiveThreadsProvider>;
}

function SidebarScreen({ subPath }: PluginNavPanelProps) {
  const { route, snapshot, store } = usePage(subPath);
  const go = useGo();
  const text = useShared(pageText);
  const chip = useShared(pageChip);
  const by = useShared(groupBy);
  const data = usePageRows(snapshot.overview);
  const overview = snapshot.overview;
  const rootId = route.target.kind === "tree" ? route.target.threadId : "";
  const root = useLiveThread(rootId, overview?.threads.find((thread) => thread.id === rootId));
  const selectedOutside = route.view === "changes" && route.focus !== null ? (route.focus.kind === "repo" ? route.focus.key : "other-files") : null;
  const includeArchived = useSyncExternalStore(archivedPreference.subscribe, archivedPreference.get, archivedPreference.get);
  return (
    <div data-vantage-sidebar className="flex h-full min-h-0 flex-col text-foreground">
      <div className="grid shrink-0 gap-2 px-2.5 pb-2 pt-1">
        <label className="flex h-8 items-center gap-1.5 rounded-lg border border-border-seam bg-card px-2 text-muted-foreground">
          <Icon name="Search" className="size-3.5 shrink-0" aria-hidden />
          <input type="search" aria-label="Filter worktrees" placeholder="Filter by title, branch or file" value={text}
            onChange={(event) => pageText.set(event.target.value)} className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-subtle-foreground" />
        </label>
        <div className="flex min-w-0 items-center gap-1 text-xs">
          <span data-scope className="inline-flex h-6 min-w-0 items-center gap-1 rounded-md bg-surface-selected py-px pl-2 pr-1 font-medium text-foreground">
            <Icon name="Layers" fallback="FolderGit" className="size-3 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{route.target.kind === "tree" ? `Tree: ${root.title}` : rootTitle(overview, route, null)}</span>
            {route.target.kind === "tree" && (
              <button type="button" aria-label="Show all threads" title="Show all threads" onClick={() => go({ target: { kind: "all" }, view: "overview", selectedKey: null, focus: null })}
                className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-state-hover">
                <Icon name="X" className="size-3" aria-hidden />
              </button>
            )}
          </span>
        </div>
        <FilterChips counts={data.counts} chip={chip} onChip={(next) => pageChip.set(next)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
        {overview === null
          ? <SkeletonRows count={5} label="Loading worktrees" />
          : (
            <WorktreeList groups={data.groups} outside={data.outside} counts={data.counts} chip={chip} onChip={(next) => pageChip.set(next)}
              selectedKey={route.selectedKey} selectedOutside={selectedOutside} titleOf={data.titleOf}
              onOpen={(key) => go({ ...route, view: "overview", selectedKey: key, focus: null })}
              onOpenOutside={(entry) => go({ ...route, view: "changes", selectedKey: null, focus: entry.kind === "repo" ? { kind: "repo", key: entry.key } : { kind: "otherFiles" } })}
              hidden={data.hidden} archivedHidden={includeArchived ? 0 : overview.archivedHidden} onIncludeArchived={() => archivedPreference.set(true)}
              partial={overview.partial}
              underOf={(row) => {
                if (route.target.kind === "tree") return null;
                const summary = overview.threads.find((thread) => thread.id === row.threadId);
                if (summary === undefined || summary.rootThreadId === row.threadId) return null;
                const root = overview.threads.find((thread) => thread.id === summary.rootThreadId);
                return resolveLive(data.live.get(summary.rootThreadId) ?? null, root, summary.rootThreadId).title;
              }} />
          )}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border-seam px-2.5 py-2 text-xs text-muted-foreground">
        Group by
        <span role="group" aria-label="Group by" className="inline-flex rounded-md bg-surface-recessed p-0.5">
          {(["status", "project"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={by === value} onClick={() => groupBy.set(value)}
              className={`h-6 cursor-pointer rounded px-2 ${by === value ? "bg-card font-medium text-foreground shadow-sm" : "hover:text-foreground"}`}>
              {value === "status" ? "Status" : "Project"}
            </button>
          ))}
        </span>
        <span className="flex-1" />
        {includeArchived && (
          <button type="button" onClick={() => archivedPreference.set(false)} className="cursor-pointer text-[11px] underline hover:text-foreground" title="Leave archived threads out again">Hide archived</button>
        )}
        {store === null && <span className="sr-only">Loading</span>}
      </div>
    </div>
  );
}

export function VantageSidebar(props: PluginNavPanelProps) {
  return <LiveThreadsProvider><SidebarScreen {...props} /></LiveThreadsProvider>;
}

function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

function HeaderScreen({ subPath }: PluginNavPanelProps) {
  const { route, snapshot, store } = usePage(subPath);
  const go = useGo();
  const data = usePageRows(snapshot.overview);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const overview = snapshot.overview;
  const updated = overview === null || overview.partial ? "Loading" : snapshot.refreshing ? "Updating" : `Updated ${ago(overview.generatedAt, now)}`;
  return (
    <span data-vantage-header className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <button type="button" aria-label="Refresh" title={`Refresh · ${updated}`} onClick={() => { reloadLoaded(); store?.refresh({ hard: true }); }}
        className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-state-hover hover:text-foreground">
        <Icon name="ArrowReloadHorizontal" fallback="RotateCcw" className={`size-3.5 ${snapshot.refreshing ? "animate-spin" : ""}`} aria-hidden />
      </button>
      {data.counts.overlaps > 0 && (
        <button type="button" onClick={() => go({ ...route, view: "overlaps", selectedKey: null, focus: null })}
          title={`${plural(data.counts.overlaps, "worktree")} change files another worktree also changes`}
          className="inline-flex h-7 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border border-border-seam px-2 text-xs text-foreground hover:bg-state-hover">
          <Icon name="AlertTriangle" className="size-3.5 text-warning-text" aria-hidden />{data.counts.overlaps}<span className="sr-only"> overlaps</span>
        </button>
      )}
    </span>
  );
}

export function VantageHeader(props: PluginNavPanelProps) {
  return <LiveThreadsProvider><HeaderScreen {...props} /></LiveThreadsProvider>;
}

// bb's title bar shares its row with the header buttons, so a long thread title is cut.
const CRUMB_MAX = 60;
const clip = (label: string): string => (label.length <= CRUMB_MAX ? label : `${label.slice(0, CRUMB_MAX - 1).trimEnd()}…`);

// The page title: where you are, each part linking back.
export function usePageTitle({ subPath }: PluginNavPanelProps): ExperimentalPageTitle | null {
  const { route, snapshot } = usePage(subPath);
  const live = useSidebarIndex();
  const overview = snapshot.overview;
  const rootId = route.target.kind === "tree" ? route.target.threadId : null;
  const rootTitleText = rootId === null ? null : resolveLive(live.get(rootId) ?? null, overview?.threads.find((thread) => thread.id === rootId), rootId).title;
  const scope = route.target.kind === "tree" ? (rootTitleText ?? "This tree") : "All threads";
  let last: string | null = null;
  if (route.selectedKey !== null) {
    const worktree = overview?.worktrees.find((entry) => entry.key === route.selectedKey);
    if (worktree !== undefined) {
      const id = worktree.threadIds[0] ?? "";
      last = resolveLive(live.get(id) ?? null, overview?.threads.find((thread) => thread.id === id), id).title;
    }
  } else if (route.view === "changes") last = "All changes";
  else if (route.view === "overlaps") last = "Overlapping files";
  // One title, not breadcrumbs: bb draws two crumbs over each other when the page is narrow. The sidebar names the scope.
  return { title: clip(last ?? scope), windowTitle: `Vantage · ${last ?? scope}` };
}

function AgentScreen({ subPath }: PluginNavPanelProps) {
  const { route, snapshot } = usePage(subPath);
  // Keyed, so a thread picked for one worktree is not kept for the next.
  return <AgentChat key={route.selectedKey ?? ""} selectedKey={route.selectedKey} overview={snapshot.overview} />;
}

function AgentChat({ selectedKey, overview }: { selectedKey: string | null; overview: Overview | null }) {
  const worktree = selectedKey === null ? undefined : overview?.worktrees.find((entry) => entry.key === selectedKey);
  const ids = worktree?.threadIds ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const threadId = picked !== null && ids.includes(picked) ? picked : ids[0] ?? null;
  if (threadId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Select a worktree to talk to its agent here.</p>;
  }
  return (
    <div data-vantage-agent className="flex h-full min-h-0 flex-col">
      {ids.length > 1 && (
        <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-border-seam px-3 py-1.5">
          {ids.map((id) => <AgentChip key={id} threadId={id} overview={overview} selected={id === threadId} onSelect={() => setPicked(id)} />)}
        </div>
      )}
      <div className="min-h-0 flex-1"><ThreadChat threadId={threadId} variant="compact" layout="contained" permissionPolicy="inherit" /></div>
    </div>
  );
}

function AgentChip({ threadId, overview, selected, onSelect }: { threadId: string; overview: Overview | null; selected: boolean; onSelect(): void }) {
  const live = useLiveThread(threadId, overview?.threads.find((thread) => thread.id === threadId));
  return (
    <button type="button" aria-pressed={selected} onClick={onSelect}
      className={`max-w-48 cursor-pointer truncate rounded-full border px-2 py-px text-xs ${selected ? "border-ring text-foreground" : "border-border-seam text-muted-foreground hover:text-foreground"}`}>
      {live.title}
    </button>
  );
}

export function AgentTab(props: PluginNavPanelProps) {
  return <LiveThreadsProvider><AgentScreen {...props} /></LiveThreadsProvider>;
}
