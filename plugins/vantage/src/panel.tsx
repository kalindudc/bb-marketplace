import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ThreadChat,
  experimental_Icon as Icon,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_useTabVisible,
  useBbNavigate,
  type ExperimentalThreadActionTabProps,
} from "@get-bb/plugin-sdk/app";
import { createArchivedPreference } from "./archived-preference";
import { AllChanges } from "./changes";
import { ICON_BUTTON } from "./file-card";
import { Hint } from "./hint";
import { incompleteWarning } from "./incomplete";
import { LiveThreadsProvider, useLiveThread } from "./live";
import { firstToOpen, plural, urgentFirst } from "./model";
import {
  CUTOVER_PX,
  FlareHelpers,
  IncompleteRecords,
  NAV_MUTED,
  NAV_TONES,
  navWidth,
  PanelNavContext,
  ResizeHandle,
  trapTab,
  usePanelWidth,
  useTreeKeys,
  type PanelNav,
} from "./navigator";
import { shortSource, SOURCE_LABEL, ThreadLine } from "./panel-head";
import { isTyping } from "./review";
import { useRemembered } from "./remember";
import { EvidenceReader } from "./evidence-reader";
import { newHandoff, readingKey, type Subject } from "./reading-state";
import {
  evidenceOf,
  filesFoldKey,
  helpersOf,
  incompleteOf,
  isHelper,
  ownerName,
  sameSubject,
  sourceChoices,
  Trail,
  trailCount,
  useTrail,
  worktreeSubject,
} from "./trail";
import { fileTree, navigatorWidth, panelResume, readerFiles, readerFocus, readerTrees, trailFolds } from "./ui-prefs";
import { useSetReviewed, useSetWhole } from "./reviewed";
import { formatRoute, type PageRoute } from "./route";
import { reloadLoaded } from "./loaded";
import { createShared, useSession, useShared } from "./session";
import { comments, useLoaders } from "./shared";
import { SkeletonRows } from "./skeleton";
import { useRows } from "./use-rows";

// Which worktree the composer segment or the Info section asked a thread's tab to open.
export const panelSelection = createShared<{ threadId: string; key: string; at: number } | null>(null);

const archivedPreference = createArchivedPreference(window, "panel");
const RECENT_ARCHIVED = 12;

type Resume = { view: "worktrees" | "changes"; subject: Subject | null; tab: "changes" | "chat"; recent?: string[] };

function PanelScreen({ threadId, visible }: { threadId: string; visible: boolean }) {
  const navigate = useBbNavigate();
  const loaders = useLoaders();
  const setReviewed = useSetReviewed();
  const setWhole = useSetWhole();
  const includeArchived = useSyncExternalStore(
    archivedPreference.subscribe,
    archivedPreference.get,
    archivedPreference.get,
  );
  const target = useMemo(() => ({ kind: "tree" as const, threadId }), [threadId]);
  const { store, snapshot } = useSession("thread", target, includeArchived, { load: visible });
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) store?.catchUp();
    wasVisible.current = visible;
  }, [store, visible]);
  const { overview } = snapshot;
  const [resume, setResume] = useState<Resume>(
    () => panelResume.get(threadId) ?? { view: "worktrees" as const, subject: null, tab: "changes" as const },
  );
  const { view, tab } = resume;
  const recent = useMemo(() => new Set(resume.recent ?? []), [resume.recent]);
  const chatButton = useRef<HTMLButtonElement | null>(null);
  const focusChat = useRef(false);
  useLayoutEffect(() => {
    if (tab !== "chat" || !focusChat.current) return;
    focusChat.current = false;
    chatButton.current?.focus();
  }, [tab]);
  const data = useRows(overview, { currentThreadId: threadId, text: "", chip: null, groupBy: "status" });
  const live = useLiveThread(
    threadId,
    overview?.threads.find((thread) => thread.id === threadId),
  );
  const trail = useTrail(overview, data, threadId);
  const hasOutline = overview !== null && overview.target.kind === "tree" && overview.target.threadId === threadId;
  const ready = hasOutline && !overview.partial;
  const order = useMemo(() => urgentFirst(data.rows), [data.rows]);
  const firstSource = useMemo(() => {
    const first = data.rows.find((row) => row.threadId === threadId) ?? firstToOpen(data.rows) ?? order[0];
    const defaultEntry = trail.byId.get(first?.threadId ?? threadId);
    if (defaultEntry === undefined) return null;
    const sources = evidenceOf(defaultEntry);
    return sources.find((source) => source.worktreeKey === first?.worktree.key) ?? sources[0]!;
  }, [data.rows, order, threadId, trail.byId]);
  const selected = hasOutline ? (resume.subject ?? firstSource) : null;
  const entry = selected === null ? undefined : trail.byId.get(selected.threadId);
  const canRead = hasOutline && selected !== null && (ready || entry !== undefined);
  const surface = `panel:${threadId}`;

  const requested = useShared(panelSelection);
  const { rowFor } = data;
  useEffect(() => {
    if (!ready || requested === null || requested.threadId !== threadId) return;
    const row = rowFor(requested.key);
    if (row !== null)
      setResume((current) => ({ ...current, view: "worktrees", subject: worktreeSubject(row), tab: "changes" }));
    panelSelection.set(null);
  }, [requested, threadId, ready, rowFor]);
  useEffect(() => {
    if (ready && resume.subject === null && firstSource !== null) {
      setResume((current) => (current.subject === null ? { ...current, subject: firstSource } : current));
    }
  }, [ready, resume.subject, firstSource]);
  useEffect(() => {
    if (ready && (resume.subject !== null || resume.view === "changes")) panelResume.set(threadId, resume);
  }, [ready, threadId, resume]);

  const open = (subject: Subject) =>
    setResume((current) => {
      const archived = trail.byId.get(subject.threadId)?.live.archived === true;
      const kept = current.recent ?? [];
      return {
        view: "worktrees",
        subject,
        tab: "changes",
        recent: archived
          ? [subject.threadId, ...kept.filter((id) => id !== subject.threadId)].slice(0, RECENT_ARCHIVED)
          : kept,
      };
    });
  const setTab = (tab: "changes" | "chat") => setResume((current) => ({ ...current, tab }));
  const openChat = () => {
    focusChat.current = tab !== "chat";
    setTab("chat");
  };
  const allChanges = () => setResume((current) => ({ ...current, view: "changes" }));
  const index = selected === null ? -1 : order.findIndex((row) => row.worktree.key === selected.worktreeKey);
  const step = (delta: -1 | 1) => {
    const next = order[index + delta];
    if (next !== undefined) open(worktreeSubject(next));
  };
  const fullScreen = (next: Partial<PageRoute> = {}) => {
    const reading = selected === null ? undefined : readerFiles.get(readingKey(surface, selected));
    const handoff =
      selected === null || (next.view !== undefined && next.view !== "overview")
        ? undefined
        : newHandoff({
            ...selected,
            ...(reading ?? { scope: selected.source === "recorded" ? "recorded" : "all" }),
          });
    navigate.toPluginPanel("vantage", {
      subPath: formatRoute({
        target,
        view: "overview",
        selectedKey: null,
        focus: null,
        ...(handoff === undefined ? {} : { handoff }),
        ...next,
      }),
    });
  };
  const refresh = () => {
    reloadLoaded();
    store?.refresh({ hard: true });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      selected === null ||
      view !== "worktrees" ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.defaultPrevented ||
      isTyping(event.target)
    )
      return;
    if (event.key === "[") step(-1);
    else if (event.key === "]") step(1);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const currentHostId = overview?.worktrees.find((worktree) => worktree.threadIds.includes(threadId))?.hostId ?? null;
  const own = selected?.threadId === threadId;
  const showChat = tab === "chat" && !own && entry !== undefined && !entry.stub && !entry.live.archived;
  const focusMode = useRemembered(readerFocus).get(surface) === true && view === "worktrees" && canRead && !showChat;

  // Layout: the navigator beside the diffs from CUTOVER_PX of panel width, a modal sheet below it.
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const width = usePanelWidth(root);
  const layout = width === null || width >= CUTOVER_PX ? "columns" : "sheet";
  const legacyTree = useShared(fileTree);
  const treeOn = useRemembered(readerTrees).get(surface) ?? legacyTree;
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetReturn = useRef<"crumb" | "stream" | null>(null);
  const crumbRef = useRef<HTMLButtonElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const showSheet = layout === "sheet" && sheetOpen && !focusMode;
  const navigatorShown = !focusMode && (layout === "columns" ? treeOn : showSheet);
  const [navActive, setNavActive] = useState<string | null>(null);
  const [treeRoot, setTreeRoot] = useState<HTMLElement | null>(null);
  const [treeSlot, setTreeSlot] = useState<HTMLElement | null>(null);
  useTreeKeys(treeRoot);
  const [incompleteOpen, setIncompleteOpen] = useState(false);
  const incompleteButton = useRef<HTMLButtonElement | null>(null);
  const focusIncomplete = useRef(false);
  useEffect(() => {
    if (layout === "columns") setSheetOpen(false);
  }, [layout]);
  const closeSheet = useCallback((back: "crumb" | "stream") => {
    sheetReturn.current = back;
    setSheetOpen(false);
  }, []);
  useLayoutEffect(() => {
    if (showSheet) {
      const tree = sheetRef.current?.querySelector<HTMLElement>('[data-navigator-tree] [tabindex="0"]');
      (tree ?? sheetRef.current)?.focus();
      return;
    }
    const back = sheetReturn.current;
    sheetReturn.current = null;
    if (back === "crumb") crumbRef.current?.focus();
    else if (back === "stream") root?.querySelector<HTMLElement>("[data-diff-stream]")?.focus({ preventScroll: true });
  }, [showSheet, root]);
  // A native listener: the file tree is portalled into the sheet from the review, so React would send its keys through
  // the review instead, and Tab from the Files section would leave the modal sheet.
  useEffect(() => {
    const element = sheetRef.current;
    if (!showSheet || element === null) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeSheet("crumb");
      } else trapTab(event, element);
    };
    element.addEventListener("keydown", onKeyDown);
    return () => element.removeEventListener("keydown", onKeyDown);
  }, [showSheet, closeSheet]);
  useLayoutEffect(() => {
    if (!focusIncomplete.current || !incompleteOpen) return;
    focusIncomplete.current = false;
    incompleteButton.current?.focus();
  });
  // Whether the selected source's file tree is drawn: when it goes, its Tab stop comes back to the Trail.
  const [filesPresent, setFilesPresent] = useState(false);
  const onFilesPresent = useCallback((present: boolean) => setFilesPresent(present), []);

  // The Files section lists the selected source's files below the Trail; the person can fold the list away.
  const filesId = useId();
  const folds = useRemembered(trailFolds);
  const filesShown =
    view === "worktrees" &&
    selected !== null &&
    entry !== undefined &&
    !entry.stub &&
    selected.source !== "unavailable";
  const filesKey = selected === null ? null : filesFoldKey(threadId, selected);
  const filesHidden = filesKey !== null && folds.get(filesKey) === true;
  const filesLabel =
    selected === null
      ? ""
      : ((entry === undefined || entry.stub
          ? undefined
          : sourceChoices(entry, threadId).find((choice) => sameSubject(choice.subject, selected))?.label) ??
        SOURCE_LABEL[selected.source]);
  const savedWidth = useShared(navigatorWidth);
  const [dragWidth, setDragWidth] = useState<number | null | undefined>(undefined);
  const columnWidth = dragWidth === undefined ? savedWidth : dragWidth;

  const incomplete = incompleteOf(trail);
  const helpers = helpersOf(trail);
  const count = trailCount(trail);
  const showIncomplete = useCallback(() => {
    focusIncomplete.current = true;
    setIncompleteOpen(true);
    if (layout === "columns") readerTrees.set(surface, true);
    else setSheetOpen(true);
  }, [layout, surface]);
  const panelNav: PanelNav = {
    layout,
    sourcesShown: layout === "sheet" || treeOn,
    treeSlot: navigatorShown ? treeSlot : null,
    files: {
      id: filesId,
      label: filesLabel,
      hidden: filesHidden,
      toggle: () => {
        if (filesKey !== null) trailFolds.set(filesKey, filesHidden ? undefined : true);
      },
    },
    filesTabStop: navActive === "files" && filesPresent,
    onFilesFocus: () => setNavActive("files"),
    onFilesPresent,
    onFilePicked: () => {
      if (layout === "sheet") closeSheet("stream");
    },
    showIncomplete,
    refreshRecords: refresh,
    openFullScreen: () => fullScreen(),
    recordedOf: (id) => {
      const found = trail.byId.get(id);
      return found === undefined || found.stub ? null : found.recorded.length;
    },
    isHelper: (id) => {
      const found = trail.byId.get(id);
      return found !== undefined && isHelper(found);
    },
  };

  const shownWarnings = (overview?.warnings ?? []).filter(
    (warning) => incomplete.length === 0 || warning !== incompleteWarning(incomplete.length, "tree"),
  );
  const banners = (
    <>
      {snapshot.status === "error" && (
        <div role="alert" className="border-b border-border-seam p-3 text-sm text-destructive-text">
          Could not load changes: {snapshot.error}
          <button
            type="button"
            className="ml-2 cursor-pointer underline"
            onClick={() => store?.refresh({ hard: true })}
          >
            Retry
          </button>
        </div>
      )}
      {snapshot.status === "ready" && snapshot.error !== null && (
        <div role="alert" className="border-b border-border-seam px-3 py-2 text-xs text-warning-text">
          Could not refresh: {snapshot.error}
          <button
            type="button"
            className="ml-2 cursor-pointer underline"
            onClick={() => store?.refresh({ hard: true })}
          >
            Retry
          </button>
        </div>
      )}
      {shownWarnings.map((warning) => (
        <div key={warning} role="status" className="border-b border-border-seam px-3 py-2 text-xs text-warning-text">
          {warning}
        </div>
      ))}
    </>
  );

  const refreshButton = (
    <button type="button" aria-label="Refresh" title="Refresh" onClick={refresh} className={`${ICON_BUTTON} size-7`}>
      <Icon
        name="ArrowReloadHorizontal"
        fallback="RotateCcw"
        className={`size-3.5 ${snapshot.refreshing ? "animate-spin" : ""}`}
        aria-hidden
      />
    </button>
  );
  const fullScreenButton = (
    <Hint label={`Open Vantage full screen for ${live.title}`}>
      <button
        type="button"
        aria-label="Open full screen"
        onClick={() => fullScreen(view === "changes" ? { view: "changes", selectedKey: null } : {})}
        className={`${ICON_BUTTON} size-7`}
      >
        <Icon name="Maximize2" className="size-3.5" aria-hidden />
      </button>
    </Hint>
  );
  const allChangesButton = (
    <button
      type="button"
      aria-pressed={view === "changes"}
      onClick={() => {
        allChanges();
        if (layout === "sheet") closeSheet("crumb");
      }}
      className={`min-h-7 shrink-0 rounded border border-border-seam px-2 text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${view === "changes" ? "bg-surface-selected" : ""}`}
    >
      All changes
    </button>
  );
  const updating = snapshot.refreshing && (
    <span aria-live="polite" className="sr-only">
      Updating
    </span>
  );

  const filesOpen = filesShown && filesPresent && !filesHidden;
  const navigatorBody = hasOutline && trail.roots.length > 0 && (
    <div ref={setTreeRoot} data-navigator-tree className="flex min-h-0 flex-1 flex-col">
      {/* With files listed, the Trail keeps at most about half the column and scrolls on its own, so sibling threads and
          warnings stay in reach however many files the source has. */}
      <nav
        aria-label="Thread trail"
        className={`min-h-0 overflow-y-auto px-1 pb-2 pt-0.5 ${filesOpen ? "max-h-[55%] shrink-0" : "flex-1"}`}
      >
        <Trail
          rootId={threadId}
          trail={trail}
          selected={view === "worktrees" ? selected : null}
          recent={recent}
          onSelect={(subject) =>
            open(
              selected !== null && subject.threadId === selected.threadId && !sameSubject(selected, subject)
                ? selected
                : subject,
            )
          }
          onSource={open}
          active={navActive === "files" && !filesPresent ? null : navActive}
          onActive={setNavActive}
          filesId={filesId}
        />
        {!includeArchived && overview !== null && overview.archivedHidden > 0 && (
          <button
            type="button"
            onClick={() => archivedPreference.set(true)}
            className={`ml-1.5 mt-1 min-h-7 cursor-pointer text-xs underline hover:text-foreground ${NAV_MUTED}`}
          >
            Show {plural(overview.archivedHidden, "archived thread")}
          </button>
        )}
        <IncompleteRecords
          threads={incomplete.map((found) => ({
            id: found.id,
            title: found.live.title,
            recorded: found.recorded.length,
          }))}
          open={incompleteOpen}
          onToggle={() => setIncompleteOpen((shown) => !shown)}
          onRefresh={refresh}
          onSelect={(id) => {
            const found = trail.byId.get(id);
            if (found !== undefined) open(evidenceOf(found)[0]!);
          }}
          buttonRef={incompleteButton}
        />
        <FlareHelpers helpers={helpers.map((found) => ({ id: found.id, title: found.live.title }))} />
      </nav>
      {filesShown && (
        <div
          ref={setTreeSlot}
          id={filesId}
          data-navigator-files
          className={`flex min-h-0 flex-col border-t border-border-seam px-1 ${!filesPresent ? "hidden" : filesHidden ? "shrink-0" : "min-h-32 flex-1"}`}
        />
      )}
    </div>
  );
  const trailLabel = (
    <span className="flex min-w-0 flex-1 items-baseline gap-1.5 px-1">
      <span className="text-xs font-semibold">Trail</span>
      <span data-trail-count className={`text-[11px] tabular-nums ${NAV_MUTED}`}>
        {count}
      </span>
    </span>
  );

  const selectedRow =
    selected?.worktreeKey === undefined
      ? undefined
      : entry?.worktrees.find(({ worktree }) => worktree.key === selected.worktreeKey);
  const readsGit = selected !== null && (selected.source === "checkout" || selected.source === "branch");
  const threadLine = (trailing?: ReactNode) =>
    view === "worktrees" &&
    entry !== undefined &&
    !focusMode && (
      <ThreadLine
        live={entry.live}
        threadId={entry.id}
        own={own}
        stub={entry.stub}
        narrow={layout === "sheet"}
        worktree={readsGit ? selectedRow?.worktree : undefined}
        currentThreadId={threadId}
        currentHostId={currentHostId}
        tab={showChat ? "chat" : "changes"}
        onTab={setTab}
        chatButtonRef={chatButton}
        onMessage={openChat}
        trailing={trailing}
      />
    );

  let body;
  if (view === "changes") {
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto">
        {banners}
        {overview === null ? (
          <SkeletonRows count={4} label="Loading changes" />
        ) : (
          <AllChanges
            overview={overview}
            scope={snapshot.scope}
            onScope={(scope) => store?.setScope(scope)}
            focus={null}
            onClearFocus={() => {}}
            text=""
            compact
            loaders={loaders}
            onOpenThread={(id) => navigate.toThread(id, { split: true })}
          />
        )}
      </div>
    );
  } else if (canRead) {
    const subjectKey = readingKey(surface, selected);
    body = showChat ? (
      <div className="flex min-h-0 flex-1 flex-col">
        {banners}
        <div className="min-h-0 flex-1">
          <ThreadChat threadId={entry.id} variant="compact" layout="contained" permissionPolicy="inherit" />
        </div>
      </div>
    ) : (
      <div data-panel-drill className="flex min-h-0 flex-1 flex-col">
        {!focusMode && banners}
        <div className="min-h-0 flex-1">
          <EvidenceReader
            readerKey={subjectKey}
            reader={{ surface, subject: selected }}
            entry={entry}
            onSource={open}
            overview={overview}
            index={index}
            total={order.length}
            compact
            visible={visible}
            currentThreadId={threadId}
            currentHostId={currentHostId}
            terminal="thread"
            marks={selected.worktreeKey === undefined ? undefined : data.marks[selected.worktreeKey]}
            titleOf={data.titleOf}
            branchOf={data.branchOf}
            comments={comments}
            loaders={loaders}
            setReviewed={setReviewed}
            onStep={step}
            onWhole={(whole) =>
              selected.worktreeKey === undefined
                ? undefined
                : setWhole(selected.worktreeKey, whole).then(() => store?.refresh())
            }
            onMessage={openChat}
            onCompare={() => fullScreen({ view: "overlaps", selectedKey: null })}
            onSent={() => {
              if (!own && !entry?.live.archived) openChat();
            }}
          />
        </div>
      </div>
    );
  } else {
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto">
        {banners}
        {!ready && snapshot.error === null ? (
          <SkeletonRows count={4} label="Loading thread trail" />
        ) : (
          ready && (
            <p className="p-4 text-sm text-muted-foreground">
              No thread evidence in this overview.{" "}
              <button type="button" className="cursor-pointer underline" onClick={allChanges}>
                See every change by repository
              </button>
            </p>
          )
        )}
      </div>
    );
  }

  const globals = (
    <>
      {allChangesButton}
      {refreshButton}
      {fullScreenButton}
    </>
  );
  let content;
  if (layout === "columns") {
    const showNavigator = navigatorShown && navigatorBody !== false;
    content = (
      <>
        {showNavigator && (
          <aside
            data-navigator
            aria-label="Trail"
            style={{ ...NAV_TONES, "--vantage-nav-width": navWidth(columnWidth) } as CSSProperties}
            className="relative flex w-[var(--vantage-nav-width)] shrink-0 flex-col border-r border-border-seam"
          >
            <div className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-2">
              {trailLabel}
              {globals}
            </div>
            {navigatorBody}
            <ResizeHandle
              panel={width ?? CUTOVER_PX}
              width={columnWidth}
              onDrag={setDragWidth}
              onWidth={(next) => {
                setDragWidth(undefined);
                navigatorWidth.set(next);
              }}
            />
          </aside>
        )}
        <div data-panel-main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!showNavigator && view === "changes" && (
            <div className="flex shrink-0 items-center gap-1 px-3 pt-2">
              <button
                type="button"
                aria-label="Show the trail and file tree"
                aria-pressed={false}
                onClick={() => readerTrees.set(surface, true)}
                className={`${ICON_BUTTON} size-7`}
              >
                <Icon name="PanelLeft" fallback="Rows2" className="size-3.5" aria-hidden />
              </button>
              <span className="flex-1" />
              {globals}
            </div>
          )}
          {threadLine(!showNavigator && <span className="flex items-center gap-1">{globals}</span>)}
          {body}
        </div>
      </>
    );
  } else {
    const subjectRow = selectedRow?.worktree;
    const sourceText =
      view === "changes"
        ? "All changes"
        : selected === null
          ? null
          : entry === undefined
            ? SOURCE_LABEL[selected.source]
            : shortSource(selected, subjectRow, ownerName(entry, threadId));
    const name = view === "changes" || entry === undefined ? null : own ? "This thread" : entry.live.title;
    const readingLabel =
      view === "changes"
        ? "All changes"
        : name === null || selected === null
          ? "nothing yet"
          : `${name}, ${SOURCE_LABEL[selected.source]}`;
    content = (
      <>
        <div data-panel-background inert={showSheet} className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!focusMode && (
            <div data-panel-crumbs className="relative flex shrink-0 flex-wrap items-center gap-1 px-2 py-1.5">
              <button
                ref={crumbRef}
                type="button"
                aria-haspopup="dialog"
                aria-expanded={showSheet}
                aria-label={`Trail: ${plural(count, "thread")}. Reading ${readingLabel}`}
                onClick={() => setSheetOpen(true)}
                className="flex min-h-7 min-w-0 flex-1 basis-48 cursor-pointer items-center gap-1.5 rounded px-1 text-left text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <span className="inline-flex shrink-0 items-center gap-1 rounded border border-border-seam bg-card px-1.5 py-0.5">
                  <Icon name="Menu" fallback="Rows2" className="size-3.5" aria-hidden />
                  Trail <span className="tabular-nums text-muted-foreground">{count}</span>
                </span>
                {entry !== undefined && view === "worktrees" && (
                  <span className="flex size-3.5 shrink-0 items-center justify-center">
                    <ThreadStatusGlyph indicator={entry.live.indicator} archived={entry.live.archived} size="compact" />
                  </span>
                )}
                {name !== null && <span className="min-w-0 truncate font-semibold">{name}</span>}
                {sourceText !== null && (
                  <>
                    {name !== null && <span className="shrink-0 text-muted-foreground">›</span>}
                    <span className="min-w-0 shrink truncate text-muted-foreground">{sourceText}</span>
                  </>
                )}
              </button>
              {threadLine()}
              {refreshButton}
              {fullScreenButton}
            </div>
          )}
          {body}
        </div>
        {showSheet && (
          <>
            <div aria-hidden className="absolute inset-0 z-30 bg-foreground/20" onClick={() => closeSheet("crumb")} />
            <div
              ref={sheetRef}
              role="dialog"
              aria-modal="true"
              aria-label="Trail"
              data-trail-sheet
              tabIndex={-1}
              style={NAV_TONES}
              className="absolute inset-y-0 left-0 z-40 flex w-[min(24rem,92%)] flex-col border-r border-border-seam bg-surface-recessed shadow-xl outline-none"
            >
              <div className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-2">
                {trailLabel}
                {allChangesButton}
                <button
                  type="button"
                  aria-label="Close the trail"
                  onClick={() => closeSheet("crumb")}
                  className={`${ICON_BUTTON} size-7`}
                >
                  <Icon name="X" className="size-3.5" aria-hidden />
                </button>
              </div>
              {navigatorBody}
            </div>
          </>
        )}
      </>
    );
  }

  return (
    <PanelNavContext.Provider value={panelNav}>
      <section
        ref={setRoot}
        data-vantage-panel
        data-layout={layout}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`relative flex h-full min-h-0 min-w-0 bg-surface-recessed text-foreground ${layout === "columns" ? "flex-row" : "flex-col"}`}
      >
        {updating}
        {content}
      </section>
    </PanelNavContext.Provider>
  );
}

export function VantagePanel({ threadId }: Pick<ExperimentalThreadActionTabProps, "threadId">) {
  const visible = experimental_useTabVisible();
  // A new thread starts a new tab state; keying it also keeps a worktree another surface asked for when the tab first opens.
  return (
    <LiveThreadsProvider>
      <PanelScreen key={threadId} threadId={threadId} visible={visible} />
    </LiveThreadsProvider>
  );
}
