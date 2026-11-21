import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ThreadChat,
  experimental_Icon as Icon,
  experimental_useAppPanel,
  useBbNavigate,
  type ExperimentalPageTitle,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { Overview } from "./contract";
import { createArchivedPreference } from "./archived-preference";
import { AllChanges } from "./changes";
import { FilterChips, WorktreeList } from "./list";
import {
  archiveReported,
  LiveThreadsProvider,
  resolveLive,
  useLiveIndex,
  useLiveThread,
  useSidebarIndex,
} from "./live";
import { firstToOpen, plural } from "./model";
import { Overlaps } from "./overlaps";
import { isTyping } from "./review";
import { EvidenceReader } from "./evidence-reader";
import { readingKey, readingOf, type Subject } from "./reading-state";
import { useRemembered } from "./remember";
import { useTrail, worktreeSubject } from "./trail";
import { useSetReviewed, useSetWhole } from "./reviewed";
import { formatRoute, parseRoute, type PageRoute } from "./route";
import { reloadLoaded } from "./loaded";
import { sessionKey, useSession, useShared } from "./session";
import { comments, useLoaders } from "./shared";
import { SkeletonRows } from "./skeleton";
import { arrivedHandoffs, groupBy, pageChip, pageResume, pageText, readerFocus } from "./ui-prefs";
import { useRows, type RowsData } from "./use-rows";

export const PAGE_PATH = "vantage";
export const PAGE_PANEL_ID = "vantage";
export const AGENT_TAB_ID = "agent";
const NARROW_BELOW_PX = 760;

const archivedPreference = createArchivedPreference(window, "page");

function usePage(subPath: string, recoveryTarget?: string | null) {
  const { route, canonical, arrivalKey, memoryKey } = useMemo(() => {
    const parsed = parseRoute(subPath);
    const { route } = parsed;
    const memoryKey = sessionKey("page", route.target);
    const plain =
      parsed.canonical === subPath &&
      route.view === "overview" &&
      route.selectedKey === null &&
      route.handoff === undefined;
    const saved = plain ? pageResume.get(memoryKey) : undefined;
    const remembered = saved === undefined ? undefined : parseRoute(saved).route;
    return {
      ...parsed,
      memoryKey,
      arrivalKey:
        route.handoff === undefined || route.handoff.arrival === "resume"
          ? null
          : (route.handoff.arrival ?? parsed.canonical),
      route: remembered !== undefined && sessionKey("page", remembered.target) === memoryKey ? remembered : route,
    };
  }, [subPath]);
  const archivePreference = useSyncExternalStore(
    archivedPreference.subscribe,
    archivedPreference.get,
    archivedPreference.get,
  );
  const includeArchived = archivePreference || recoveryTarget === memoryKey;
  // The page body owns the current view's filter; companion slots share the same store.
  const session = useSession("page", route.target, includeArchived, { syncArchives: recoveryTarget !== undefined });
  return { route, canonical, arrivalKey, memoryKey, includeArchived, ...session };
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
  route.target.kind === "all"
    ? `All threads${overview?.windowHours == null ? "" : ` · last ${overview.windowHours} h`}`
    : (title ?? "This tree");

function useOpenAgent() {
  const panel = experimental_useAppPanel();
  return useCallback(() => {
    panel.openTab({
      tab: { id: AGENT_TAB_ID, context: { kind: "nav-panel", panelId: PAGE_PANEL_ID }, availability: "fixed" },
    });
  }, [panel]);
}

function NoWorktrees({
  all,
  windowHours,
  filtered,
  onChanges,
}: {
  all: boolean;
  windowHours: number | null;
  filtered: boolean;
  onChanges(): void;
}) {
  return (
    <div data-page-empty className="mx-auto w-full max-w-4xl px-7 pb-10 pt-7">
      <h1 className="text-xl font-semibold text-foreground">
        {all ? `All threads in the last ${windowHours ?? 24} hours` : "This tree"}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {filtered
          ? "No worktree matches the filter."
          : all
            ? "No worktree has changes yet."
            : "No worktree in this thread or its child threads has changes yet."}
      </p>
      <button
        type="button"
        onClick={onChanges}
        className="mt-4 inline-flex h-7 cursor-pointer items-center rounded-md border border-border-seam bg-card px-2.5 text-xs text-foreground hover:bg-state-hover"
      >
        See every change by repository
      </button>
    </div>
  );
}

function Banners({
  overview,
  error,
  status,
  onRetry,
  all,
}: {
  overview: Overview | null;
  error: string | null;
  status: string;
  onRetry(): void;
  all: boolean;
}) {
  const notices =
    overview === null
      ? []
      : [
          ...overview.warnings,
          ...(overview.truncatedThreads
            ? [
                all
                  ? `Showing the ${overview.threads.length} most recent threads; raise the limit in Vantage's settings`
                  : "Only the first 200 threads of this tree were read.",
              ]
            : []),
        ];
  return (
    <>
      {status === "error" && (
        <div role="alert" className="border-b border-border-seam px-5 py-3 text-sm text-destructive-text">
          Could not load changes: {error}
          <button type="button" className="ml-2 cursor-pointer underline" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
      {status === "ready" && error !== null && (
        <div role="alert" className="border-b border-border-seam px-5 py-2 text-xs text-warning-text">
          Could not refresh: {error}
          <button type="button" className="ml-2 cursor-pointer underline" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
      {notices.map((notice) => (
        <div key={notice} role="status" className="border-b border-border-seam px-5 py-2 text-xs text-warning-text">
          {notice}
        </div>
      ))}
    </>
  );
}

function PageScreen({ subPath }: PluginNavPanelProps) {
  const [recovery, setRecovery] = useState<{ key: string; before: Overview | null } | null>(null);
  const { route, canonical, arrivalKey, memoryKey, includeArchived, store, snapshot } = usePage(
    subPath,
    recovery?.key ?? null,
  );
  const initial = useMemo(() => {
    const handoff = route.handoff;
    if (arrivalKey === null || handoff === undefined || arrivedHandoffs.get(arrivalKey)) return undefined;
    return readingOf(handoff);
  }, [arrivalKey, route.handoff]);
  const markArrival = useCallback(() => {
    if (arrivalKey !== null) arrivedHandoffs.set(arrivalKey, true);
  }, [arrivalKey]);
  const go = useGo();
  const navigate = useBbNavigate();
  const openAgent = useOpenAgent();
  const loaders = useLoaders();
  const setReviewed = useSetReviewed();
  const setWhole = useSetWhole();
  const text = useShared(pageText);
  const { overview } = snapshot;
  const data = usePageRows(overview);
  const trail = useTrail(overview, data, route.target.kind === "tree" ? route.target.threadId : null);
  const hasOutline = overview !== null && sessionKey("page", overview.target) === memoryKey;
  const ready = hasOutline && !overview.partial;
  useEffect(() => {
    if (canonical !== subPath) go(parseRoute(canonical).route, true);
  }, [canonical, subPath, go]);

  const rootRef = useRef<HTMLElement | null>(null);
  const recoveryFocus = useRef(false);
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
  const open = useCallback(
    (key: string) => go({ target: route.target, view: "overview", selectedKey: key, focus: null }),
    [go, route],
  );
  // One list, one place: the sidebar is the index, and the page always shows the worktree that most needs a person.
  const first = firstToOpen(data.rows);
  const shown = route.view === "overview" && route.handoff === undefined ? (selectedKey === null ? first : row) : null;
  const savedRoute = selectedKey !== null && row === null ? pageResume.get(memoryKey) : undefined;
  const previous = savedRoute === undefined ? undefined : parseRoute(savedRoute).route.handoff;
  const subject =
    route.view !== "overview"
      ? null
      : (route.handoff ??
        (shown !== null
          ? worktreeSubject(shown)
          : previous !== undefined && previous.worktreeKey === selectedKey
            ? previous
            : null));
  const surface = "page";
  const focusMode = useRemembered(readerFocus).get(surface) === true;
  const readerSurface = memoryKey;
  const entry = subject === null ? undefined : trail.byId.get(subject.threadId);
  const canRead = hasOutline && subject !== null && (ready || (entry !== undefined && !entry.stub));
  const missingHandoff = route.handoff !== undefined && (entry === undefined || entry.stub);
  const hiddenHandoff =
    ready &&
    !includeArchived &&
    missingHandoff &&
    (overview.archivedHidden > 0 || data.live.get(route.handoff!.threadId)?.isArchived === true);
  const pendingRecovery = recovery !== null && recovery.key === memoryKey && recovery.before !== null;
  const recovered =
    pendingRecovery && ready && overview !== recovery.before && !snapshot.refreshing && snapshot.error === null;
  const recoveringHandoff = pendingRecovery && !recovered && route.handoff !== undefined;
  useEffect(() => {
    if (recovered) setRecovery({ key: memoryKey, before: null });
    else if (recovery !== null && (recovery.key !== memoryKey || route.handoff === undefined)) setRecovery(null);
  }, [recovered, recovery, memoryKey, route.handoff]);
  useLayoutEffect(() => {
    if (!recoveryFocus.current || !ready || hiddenHandoff || recoveringHandoff) return;
    recoveryFocus.current = false;
    if (document.activeElement === document.body)
      (rootRef.current?.querySelector<HTMLElement>('[aria-label="Evidence source"]') ?? rootRef.current)?.focus();
  }, [ready, hiddenHandoff, recoveringHandoff]);
  useEffect(() => {
    if (!ready) return;
    if (subject === null) pageResume.set(memoryKey, formatRoute(route));
    else {
      const { threadId, source, worktreeKey } = subject;
      pageResume.set(
        memoryKey,
        formatRoute({
          target: route.target,
          view: "overview",
          focus: null,
          selectedKey: null,
          handoff: {
            threadId,
            source,
            ...(worktreeKey === undefined ? {} : { worktreeKey }),
            scope: source === "recorded" ? "recorded" : "all",
          },
        }),
      );
    }
  }, [ready, route, memoryKey, subject]);
  useEffect(() => {
    if (
      overview === null ||
      overview.partial ||
      route.view !== "overview" ||
      route.selectedKey !== null ||
      route.handoff !== undefined ||
      route.focus !== null
    )
      return;
    if (first !== null) go({ ...route, selectedKey: first.worktree.key }, true);
  }, [overview, route, first, go]);
  const index = subject === null ? -1 : data.order.findIndex((entry) => entry.worktree.key === subject.worktreeKey);
  const step = useCallback(
    (delta: -1 | 1) => {
      const list = data.order;
      if (list.length === 0) return;
      const next = index === -1 ? list[delta > 0 ? 0 : list.length - 1] : list[index + delta];
      if (next !== undefined) open(next.worktree.key);
    },
    [data.order, index, open],
  );
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || isTyping(event.target)) return;
    if (event.key === "[") step(-1);
    else if (event.key === "]") step(1);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const compare = (path: string) => {
    go({ ...route, view: "overlaps", selectedKey: null, focus: null });
    // The overlaps page draws its cards only once every worktree's files are known, so look again for a few seconds.
    let tries = 0;
    const look = () => {
      const card = [...document.querySelectorAll<HTMLElement>("[data-overlap]")].find(
        (entry) => entry.dataset.overlap === path,
      );
      if (card !== undefined) card.scrollIntoView?.({ block: "start" });
      else if (tries++ < 40) setTimeout(look, 100);
    };
    requestAnimationFrame(look);
  };

  let body: ReactNode;
  if (overview === null)
    body = snapshot.status === "error" ? null : <SkeletonRows count={4} label="Loading worktrees" />;
  else if (route.view === "overview" && !ready && !canRead)
    body = snapshot.error === null ? <SkeletonRows count={4} label="Loading worktrees" /> : null;
  else if (hiddenHandoff) {
    body = (
      <section className="space-y-2 p-4 text-sm">
        <p role="status">
          Archived threads are hidden here. Include them to look for the thread and evidence in this handoff.
        </p>
        <button
          type="button"
          className="underline"
          onClick={(event) => {
            recoveryFocus.current = event.currentTarget === document.activeElement;
            setRecovery({ key: memoryKey, before: overview });
          }}
        >
          Include archived threads in this view
        </button>
      </section>
    );
  } else if (recoveringHandoff) {
    body = snapshot.error === null ? <SkeletonRows count={4} label="Loading archived handoff" /> : null;
  } else if (canRead) {
    body = (
      <EvidenceReader
        readerKey={`${readingKey(readerSurface, subject)}:${arrivalKey ?? ""}`}
        reader={{
          surface,
          keyScope: readerSurface,
          subject,
          ...(initial === undefined ? {} : { initial, onArrival: markArrival }),
        }}
        entry={entry}
        onSource={(next: Subject) =>
          go({
            target: route.target,
            view: "overview",
            focus: null,
            selectedKey: null,
            handoff: { ...next, scope: next.source === "recorded" ? "recorded" : "all", arrival: "resume" },
          })
        }
        overview={overview}
        index={index}
        total={data.order.length}
        compact={narrow}
        currentThreadId={null}
        currentHostId={null}
        terminal="environment"
        marks={subject.worktreeKey === undefined ? undefined : data.marks[subject.worktreeKey]}
        titleOf={data.titleOf}
        branchOf={data.branchOf}
        comments={comments}
        loaders={loaders}
        setReviewed={setReviewed}
        onStep={step}
        onWhole={(whole) =>
          subject.worktreeKey === undefined
            ? undefined
            : setWhole(subject.worktreeKey, whole).then(() => store?.refresh())
        }
        onMessage={openAgent}
        onCompare={compare}
        onSent={openAgent}
      />
    );
  } else if (route.view === "changes") {
    body = (
      <div className="h-full overflow-y-auto">
        {/* Space as a child, not padding: the sticky toolbar sticks inside the padding and shows rows above it. */}
        <div aria-hidden className="h-2" />
        <AllChanges
          overview={overview}
          scope={snapshot.scope}
          onScope={(scope) => store?.setScope(scope)}
          focus={route.focus}
          onClearFocus={() => go({ ...route, focus: null })}
          text={text}
          loaders={loaders}
          onOpenThread={(id) => navigate.toThread(id)}
        />
      </div>
    );
  } else if (route.view === "overlaps") {
    body = (
      <div className="h-full overflow-y-auto">
        <Overlaps
          overview={overview}
          rows={data.rows}
          titleOf={data.titleOf}
          loaders={loaders}
          comments={comments}
          onReview={open}
          onDraft={(row) =>
            go({
              target: route.target,
              view: "overview",
              selectedKey: null,
              focus: null,
              handoff: { ...worktreeSubject(row), scope: "all", arrival: "resume" },
            })
          }
          text={text}
        />
      </div>
    );
  } else {
    body =
      selectedKey !== null ? (
        <p className="p-4 text-sm text-muted-foreground" role="status">
          The requested worktree is not available in this overview. Select a worktree from the sidebar or{" "}
          <button
            type="button"
            className="underline"
            onClick={() => go({ target: route.target, view: "changes", selectedKey: null, focus: null })}
          >
            see all changes
          </button>
          .
        </p>
      ) : (
        <div className="h-full overflow-y-auto">
          <NoWorktrees
            all={route.target.kind === "all"}
            windowHours={overview.windowHours}
            filtered={text.trim() !== ""}
            onChanges={() => go({ ...route, view: "changes", selectedKey: null, focus: null })}
          />
        </div>
      );
  }

  return (
    <section
      ref={rootRef}
      data-vantage-page
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex h-full min-h-0 min-w-0 flex-col bg-surface-recessed text-foreground"
    >
      {!(focusMode && canRead && !hiddenHandoff && !recoveringHandoff) && (
        <div className="shrink-0">
          <Banners
            overview={overview}
            error={snapshot.error}
            status={snapshot.status}
            onRetry={() => store?.refresh({ hard: true })}
            all={route.target.kind === "all"}
          />
        </div>
      )}
      <div className="min-h-0 flex-1">{body}</div>
    </section>
  );
}

export function VantagePage(props: PluginNavPanelProps) {
  return (
    <LiveThreadsProvider>
      <PageScreen {...props} />
    </LiveThreadsProvider>
  );
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
  const root = useLiveThread(
    rootId,
    overview?.threads.find((thread) => thread.id === rootId),
  );
  const selectedOutside =
    route.view === "changes" && route.focus !== null
      ? route.focus.kind === "repo"
        ? route.focus.key
        : "other-files"
      : null;
  const includeArchived = useSyncExternalStore(
    archivedPreference.subscribe,
    archivedPreference.get,
    archivedPreference.get,
  );
  return (
    <div data-vantage-sidebar className="flex h-full min-h-0 flex-col text-foreground">
      <div className="grid shrink-0 gap-2 px-2.5 pb-2 pt-1">
        <div className="flex items-baseline gap-2 px-0.5 text-xs">
          <span className="font-medium text-foreground">Worktrees</span>
          {overview !== null && (
            <span className="text-muted-foreground">
              {plural(data.rows.filter((row) => row.bucket !== "archived").length, "worktree")} with changes
            </span>
          )}
        </div>
        <label className="flex h-8 items-center gap-1.5 rounded-lg border border-border-seam bg-card px-2 text-muted-foreground">
          <Icon name="Search" className="size-3.5 shrink-0" aria-hidden />
          <input
            type="search"
            aria-label="Filter worktrees"
            placeholder="Filter by title, branch or file"
            value={text}
            onChange={(event) => pageText.set(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-subtle-foreground"
          />
        </label>
        <div className="flex min-w-0 items-center gap-1 text-xs">
          <span
            data-scope
            className="inline-flex h-6 min-w-0 items-center gap-1 rounded-md bg-surface-selected py-px pl-2 pr-1 font-medium text-foreground"
          >
            <Icon name="Layers" fallback="FolderGit" className="size-3 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">
              {route.target.kind === "tree" ? `Tree: ${root.title}` : rootTitle(overview, route, null)}
            </span>
            {route.target.kind === "tree" && (
              <button
                type="button"
                aria-label="Show all threads"
                title="Show all threads"
                onClick={() => go({ target: { kind: "all" }, view: "overview", selectedKey: null, focus: null })}
                className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-state-hover"
              >
                <Icon name="X" className="size-3" aria-hidden />
              </button>
            )}
          </span>
        </div>
        <FilterChips counts={data.counts} chip={chip} onChip={(next) => pageChip.set(next)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
        {overview === null ? (
          <SkeletonRows count={5} label="Loading worktrees" />
        ) : (
          <WorktreeList
            groups={data.groups}
            outside={data.outside}
            counts={data.counts}
            chip={chip}
            onChip={(next) => pageChip.set(next)}
            selectedKey={route.handoff?.worktreeKey ?? route.selectedKey}
            selectedOutside={selectedOutside}
            titleOf={data.titleOf}
            onOpen={(key) => go({ target: route.target, view: "overview", selectedKey: key, focus: null })}
            onOpenOutside={(entry) =>
              go({
                ...route,
                view: "changes",
                selectedKey: null,
                focus: entry.kind === "repo" ? { kind: "repo", key: entry.key } : { kind: "otherFiles" },
              })
            }
            hidden={data.hidden}
            archivedHidden={includeArchived ? 0 : overview.archivedHidden}
            onIncludeArchived={() => archivedPreference.set(true)}
            partial={overview.partial}
            underOf={(row) => {
              if (route.target.kind === "tree") return null;
              const summary = overview.threads.find((thread) => thread.id === row.threadId);
              if (summary === undefined || summary.rootThreadId === row.threadId) return null;
              const root = overview.threads.find((thread) => thread.id === summary.rootThreadId);
              return resolveLive(data.live.get(summary.rootThreadId) ?? null, root, summary.rootThreadId).title;
            }}
          />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border-seam px-2.5 py-2 text-xs text-muted-foreground">
        Group by
        <span role="group" aria-label="Group by" className="inline-flex rounded-md bg-surface-recessed p-0.5">
          {(["status", "project"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={by === value}
              onClick={() => groupBy.set(value)}
              className={`h-6 cursor-pointer rounded px-2 ${by === value ? "bg-card font-medium text-foreground shadow-sm" : "hover:text-foreground"}`}
            >
              {value === "status" ? "Status" : "Project"}
            </button>
          ))}
        </span>
        <span className="flex-1" />
        {includeArchived && (
          <button
            type="button"
            onClick={() => archivedPreference.set(false)}
            className="cursor-pointer text-[11px] underline hover:text-foreground"
            title="Leave archived threads out again"
          >
            Hide archived
          </button>
        )}
        {store === null && <span className="sr-only">Loading</span>}
      </div>
    </div>
  );
}

export function VantageSidebar(props: PluginNavPanelProps) {
  return (
    <LiveThreadsProvider>
      <SidebarScreen {...props} />
    </LiveThreadsProvider>
  );
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
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(timer);
      timer = undefined;
      if (document.visibilityState !== "visible") return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), 5000);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  const overview = snapshot.overview;
  const updated =
    overview === null || overview.partial
      ? "Loading"
      : snapshot.refreshing
        ? "Updating"
        : `Updated ${ago(overview.generatedAt, now)}`;
  return (
    <span data-vantage-header className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <button
        type="button"
        aria-label="Refresh"
        title={`Refresh · ${updated}`}
        onClick={() => {
          reloadLoaded();
          store?.refresh({ hard: true });
        }}
        className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-state-hover hover:text-foreground"
      >
        <Icon
          name="ArrowReloadHorizontal"
          fallback="RotateCcw"
          className={`size-3.5 ${snapshot.refreshing ? "animate-spin" : ""}`}
          aria-hidden
        />
      </button>
      <button
        type="button"
        onClick={() => go({ ...route, view: "changes", selectedKey: null, focus: null })}
        title="Everything these threads changed, by repository"
        className="inline-flex h-7 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border border-border-seam px-2 text-xs text-foreground hover:bg-state-hover"
      >
        <Icon name="Layers" fallback="FolderGit" className="size-3.5" aria-hidden />
        All changes
      </button>
      {data.counts.overlaps > 0 && (
        <button
          type="button"
          onClick={() => go({ ...route, view: "overlaps", selectedKey: null, focus: null })}
          title={`${plural(data.counts.overlaps, "worktree")} change files another worktree also changes`}
          className="inline-flex h-7 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border border-border-seam px-2 text-xs text-foreground hover:bg-state-hover"
        >
          <Icon name="AlertTriangle" className="size-3.5 text-warning-text" aria-hidden />
          {data.counts.overlaps}
          <span className="sr-only"> overlaps</span>
        </button>
      )}
    </span>
  );
}

export function VantageHeader(props: PluginNavPanelProps) {
  return (
    <LiveThreadsProvider>
      <HeaderScreen {...props} />
    </LiveThreadsProvider>
  );
}

// bb's title bar shares its row with the header buttons, so a long thread title is cut.
const CRUMB_MAX = 60;
const clip = (label: string): string =>
  label.length <= CRUMB_MAX ? label : `${label.slice(0, CRUMB_MAX - 1).trimEnd()}…`;

// The page title: where you are, each part linking back.
export function usePageTitle({ subPath }: PluginNavPanelProps): ExperimentalPageTitle | null {
  const { route, snapshot } = usePage(subPath);
  const live = useSidebarIndex();
  const overview = snapshot.overview;
  const rootId = route.target.kind === "tree" ? route.target.threadId : null;
  const rootTitleText =
    rootId === null
      ? null
      : resolveLive(
          live.get(rootId) ?? null,
          overview?.threads.find((thread) => thread.id === rootId),
          rootId,
        ).title;
  const scope = route.target.kind === "tree" ? (rootTitleText ?? "This tree") : "All threads";
  let last: string | null = null;
  if (route.handoff !== undefined) {
    const id = route.handoff.threadId;
    last = resolveLive(
      live.get(id) ?? null,
      overview?.threads.find((thread) => thread.id === id),
      id,
    ).title;
  } else if (route.selectedKey !== null) {
    const worktree = overview?.worktrees.find((entry) => entry.key === route.selectedKey);
    if (worktree !== undefined) {
      const id = worktree.threadIds[0] ?? "";
      last = resolveLive(
        live.get(id) ?? null,
        overview?.threads.find((thread) => thread.id === id),
        id,
      ).title;
    }
  } else if (route.view === "changes") last = "All changes";
  else if (route.view === "overlaps") last = "Overlapping files";
  // One title, not breadcrumbs: bb draws two crumbs over each other when the page is narrow. The sidebar names the scope.
  return { title: clip(last ?? scope), windowTitle: `Vantage · ${last ?? scope}` };
}

function AgentScreen({ subPath }: PluginNavPanelProps) {
  const { route, snapshot } = usePage(subPath);
  // Keyed, so a thread picked for one worktree is not kept for the next.
  const threadId = route.handoff?.threadId;
  return (
    <AgentChat
      key={threadId ?? route.selectedKey ?? ""}
      selectedKey={route.view === "overview" ? route.selectedKey : null}
      explicit={route.view === "overview" ? threadId : undefined}
      overview={snapshot.overview}
    />
  );
}

function AgentChat({
  selectedKey,
  explicit,
  overview,
}: {
  selectedKey: string | null;
  explicit: string | undefined;
  overview: Overview | null;
}) {
  const worktree = selectedKey === null ? undefined : overview?.worktrees.find((entry) => entry.key === selectedKey);
  const live = useLiveIndex();
  const known = explicit !== undefined && overview?.threads.some((thread) => thread.id === explicit);
  const ids = (explicit === undefined ? (worktree?.threadIds ?? []) : known ? [explicit] : []).filter(
    (id) =>
      !archiveReported(
        live.get(id),
        overview?.threads.find((thread) => thread.id === id),
      ),
  );
  const [picked, setPicked] = useState<string | null>(null);
  const threadId = picked !== null && ids.includes(picked) ? picked : (ids[0] ?? null);
  if (threadId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Select a worktree to talk to its agent here.</p>;
  }
  return (
    <div data-vantage-agent className="flex h-full min-h-0 flex-col">
      {ids.length > 1 && (
        <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-border-seam px-3 py-1.5">
          {ids.map((id) => (
            <AgentChip
              key={id}
              threadId={id}
              overview={overview}
              selected={id === threadId}
              onSelect={() => setPicked(id)}
            />
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <ThreadChat threadId={threadId} variant="compact" layout="contained" permissionPolicy="inherit" />
      </div>
    </div>
  );
}

function AgentChip({
  threadId,
  overview,
  selected,
  onSelect,
}: {
  threadId: string;
  overview: Overview | null;
  selected: boolean;
  onSelect(): void;
}) {
  const live = useLiveThread(
    threadId,
    overview?.threads.find((thread) => thread.id === threadId),
  );
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`max-w-48 cursor-pointer truncate rounded-full border px-2 py-px text-xs ${selected ? "border-ring text-foreground" : "border-border-seam text-muted-foreground hover:text-foreground"}`}
    >
      {live.title}
    </button>
  );
}

export function AgentTab(props: PluginNavPanelProps) {
  return (
    <LiveThreadsProvider>
      <AgentScreen {...props} />
    </LiveThreadsProvider>
  );
}
