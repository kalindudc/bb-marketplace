import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { experimental_Icon as Icon, useBbNavigate, useRpc, useSdk, type PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { Overview, Scope, rpcContract } from "./contract";
import { fileKey, type FileLoaders, FileRow } from "./file-row";
import { createLimiter } from "./limit";
import { RepoSection } from "./repo-section";
import { Hint } from "./hint";
import { formatRoute } from "./route";
import { createVantageStore, type VantageSnapshot, type VantageStore } from "./store";
import { createViewPreference, type VantageView } from "./view-preference";
import { WorktreeDetail, type WorktreeDetailProps } from "./worktree-detail";
import { LiveThreadsProvider, WorktreeList } from "./worktree-list";

const EMPTY_SNAPSHOT: VantageSnapshot = { status: "loading", overview: null, scope: "uncommitted", refreshing: false, error: null };
const PATCH_CONCURRENCY = 4;
const SCOPES: ReadonlyArray<{ scope: Scope; label: string }> = [
  { scope: "uncommitted", label: "Uncommitted" },
  { scope: "branch", label: "Branch" },
];

const limitPatches = createLimiter(PATCH_CONCURRENCY);
const viewPreference = createViewPreference(window);
const VIEWS: ReadonlyArray<{ view: VantageView; label: string }> = [
  { view: "worktrees", label: "Worktrees" },
  { view: "repositories", label: "Repositories" },
];

function allFileKeys(overview: Overview): string[] {
  return [
    ...overview.repos.flatMap((repo) => [...repo.files, ...repo.otherFiles].map((file) => fileKey(repo, file.path, overview.scope))),
    ...overview.otherFiles.map((file) => fileKey(null, file.path, overview.scope)),
  ];
}

function Summary({ overview }: { overview: Overview }) {
  const files = overview.repos.reduce((sum, repo) => sum + repo.totals.files, 0);
  const additions = overview.repos.reduce((sum, repo) => sum + repo.totals.additions, 0);
  const deletions = overview.repos.reduce((sum, repo) => sum + repo.totals.deletions, 0);
  return (
    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
      {overview.repos.length} {overview.repos.length === 1 ? "repo" : "repos"} · {files} {files === 1 ? "file" : "files"} ·{" "}
      <span className="text-diff-added">+{additions}</span> <span className="text-diff-removed">−{deletions}</span> ·{" "}
      {overview.threads.length} {overview.threads.length === 1 ? "thread" : "threads"}
    </span>
  );
}

export function VantagePanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const sdkRef = useRef(sdk);
  sdkRef.current = sdk;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const [mounted, setMounted] = useState<{ threadId: string; store: VantageStore } | null>(null);
  const store = mounted?.threadId === threadId ? mounted.store : null;
  useEffect(() => {
    const next = createVantageStore({
      rpc: { call: (method, input) => rpcRef.current.call(method, input) }, sdk: sdkRef.current, target: { kind: "tree", threadId },
    });
    setMounted({ threadId, store: next });
    return () => next.dispose();
  }, [threadId]);
  const subscribe = useCallback((listener: () => void) => store?.subscribe(listener) ?? (() => {}), [store]);
  const getSnapshot = useCallback(() => store?.getSnapshot() ?? EMPTY_SNAPSHOT, [store]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { overview } = snapshot;

  const [collapsedRepos, setCollapsedRepos] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((set: ReadonlySet<string>, key: string): ReadonlySet<string> => {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    return next;
  }, []);
  const onToggleRepo = useCallback((key: string) => setCollapsedRepos((current) => toggle(current, key)), [toggle]);
  const onToggleFile = useCallback((key: string) => setExpandedFiles((current) => toggle(current, key)), [toggle]);
  const onOpenThread = useCallback((id: string) => navigateRef.current.toThread(id, { split: true }), []);
  const loaders = useMemo<WorktreeDetailProps["loaders"]>(() => ({
    patch: (input) => limitPatches(() => rpcRef.current.call("patch", input)),
    recordedEdits: (input) => rpcRef.current.call("recordedEdits", input),
    commitFiles: (input) => rpcRef.current.call("commitFiles", input),
  }), []);
  const view = useSyncExternalStore(viewPreference.subscribe, viewPreference.get, viewPreference.get);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [tab, setTab] = useState<WorktreeDetailProps["tab"]>("changes");
  const worktrees = overview?.worktrees ?? [];
  const selectedIndex = selectedKey === null ? -1 : worktrees.findIndex((worktree) => worktree.key === selectedKey);
  const detailOpen = view === "worktrees" && selectedIndex !== -1;
  useEffect(() => {
    setSelectedKey(null);
    setTab("changes");
  }, [threadId]);
  useEffect(() => {
    if (selectedKey !== null && overview !== null && selectedIndex === -1) {
      setSelectedKey(null);
      setTab("changes");
    }
  }, [overview, selectedKey, selectedIndex]);
  const currentHostId = worktrees.find((worktree) => worktree.threadIds.includes(threadId))?.hostId ?? null;
  const step = useCallback((delta: -1 | 1) => {
    const next = worktrees[selectedIndex + delta];
    if (next !== undefined) setSelectedKey(next.key);
  }, [worktrees, selectedIndex]);
  const closeDetail = useCallback(() => { setSelectedKey(null); setTab("changes"); }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!detailOpen || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
    if (target.closest("input, textarea, [contenteditable='true'], [contenteditable='']")) return;
    if (event.key === "[") step(-1);
    else if (event.key === "]") step(1);
    else if (event.key === "Escape") closeDetail();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const threads = useMemo(() => new Map((overview?.threads ?? []).map((thread) => [thread.id, thread])), [overview?.threads]);

  const everythingOpen = overview !== null && collapsedRepos.size === 0 && allFileKeys(overview).every((key) => expandedFiles.has(key));
  const toggleAll = () => {
    if (overview === null) return;
    if (everythingOpen) {
      setCollapsedRepos(new Set(overview.repos.map((repo) => repo.key)));
      setExpandedFiles(new Set());
    } else {
      setCollapsedRepos(new Set());
      setExpandedFiles(new Set(allFileKeys(overview)));
    }
  };

  const showHost = overview !== null && new Set(overview.repos.map((repo) => repo.hostId)).size > 1;
  const empty = overview !== null && overview.repos.length === 0 && overview.otherFiles.length === 0;
  const warnings = overview === null ? [] : [
    ...overview.warnings,
    ...(overview.truncatedThreads ? ["Only the first 200 threads of this tree were read."] : []),
  ];

  const banners = (
    <>
      {snapshot.status === "error" && (
        <div role="alert" className="border-b border-border-seam p-3 text-sm text-destructive-text">
          Could not load changes: {snapshot.error}
          <button type="button" className="ml-2 underline" onClick={() => store?.refresh({ hard: true })}>Retry</button>
        </div>
      )}
      {snapshot.status === "ready" && snapshot.error !== null && (
        <div role="alert" className="border-b border-border-seam px-3.5 py-2 text-xs text-warning-text">
          Could not refresh: {snapshot.error}
          <button type="button" className="ml-2 underline" onClick={() => store?.refresh({ hard: true })}>Retry</button>
        </div>
      )}
      {warnings.map((warning) => (
        <div key={warning} role="status" className="border-b border-border-seam px-3.5 py-2 text-xs text-warning-text">{warning}</div>
      ))}
    </>
  );

  return (
    <LiveThreadsProvider>
      <section data-vantage-panel tabIndex={-1} onKeyDown={onKeyDown} className="flex h-full min-h-0 min-w-0 flex-col bg-surface-recessed text-foreground">
        <div className="flex shrink-0 items-center gap-2 border-b border-border-seam py-2 pl-3.5 pr-3">
          <div role="group" aria-label="View" className="inline-flex shrink-0 overflow-hidden rounded-md border border-border-seam">
            {VIEWS.map((entry) => (
              <button key={entry.view} type="button" aria-pressed={view === entry.view} onClick={() => viewPreference.set(entry.view)}
                className={`cursor-pointer px-2 py-0.5 text-xs ${view === entry.view ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}>
                {entry.label}
              </button>
            ))}
          </div>
          {view === "repositories" && overview !== null
            ? <Summary overview={overview} />
            : <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{overview === null ? "Looking for changes…" : ""}</span>}
          {snapshot.refreshing && <span aria-live="polite" className="shrink-0 text-xs text-muted-foreground">Updating…</span>}
          {view === "repositories" && (
            <>
              <div role="group" aria-label="Scope" className="inline-flex shrink-0 overflow-hidden rounded-md border border-border-seam">
                {SCOPES.map(({ scope, label }) => (
                  <button key={scope} type="button" aria-pressed={snapshot.scope === scope} onClick={() => store?.setScope(scope)}
                    className={`cursor-pointer px-2 py-0.5 text-xs ${snapshot.scope === scope ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}>
                    {label}
                  </button>
                ))}
              </div>
              <button type="button" disabled={overview === null} onClick={toggleAll}
                className="shrink-0 cursor-pointer rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-state-hover disabled:cursor-default disabled:opacity-60">
                {everythingOpen ? "Collapse all" : "Expand all"}
              </button>
            </>
          )}
          <Hint label="Open Vantage full screen for this thread tree">
            <button type="button" aria-label="Open full screen"
              onClick={() => navigate.toPluginPanel("vantage", { subPath: formatRoute({ target: { kind: "tree", threadId }, view: "worktrees", selectedKey: null }) })}
              className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              <Icon name="Maximize2" className="size-3.5" aria-hidden />
            </button>
          </Hint>
          <button type="button" aria-label="Refresh" title="Refresh" onClick={() => store?.refresh({ hard: true })}
            className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground">
            <Icon name="Refresh" className={`size-3.5 ${snapshot.refreshing ? "animate-spin" : ""}`} aria-hidden />
          </button>
        </div>
        {detailOpen && overview !== null ? (
          <>
            <div className="shrink-0">{banners}</div>
            <div className="flex min-h-0 flex-1 flex-col">
              <WorktreeDetail overview={overview} worktreeKey={selectedKey!} tab={tab} currentThreadId={threadId} currentHostId={currentHostId}
                onTab={setTab} onStep={step} onBack={closeDetail} loaders={loaders} />
            </div>
          </>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {banners}
            {overview === null && snapshot.status === "loading" && <p className="p-3.5 text-sm text-muted-foreground">Looking for changes…</p>}
            {view === "worktrees" && overview !== null && (
              <WorktreeList overview={overview} currentThreadId={threadId} onOpen={setSelectedKey}
                onShowRepositories={() => viewPreference.set("repositories")} />
            )}
            {view === "repositories" && (
              <>
                {empty && <p className="p-3.5 text-sm text-muted-foreground">No changes in this thread or its child threads yet.</p>}
                {overview?.repos.map((repo) => (
                  <RepoSection key={repo.key} repo={repo} scope={overview.scope} threads={threads} expanded={!collapsedRepos.has(repo.key)}
                    expandedFiles={expandedFiles} onToggleRepo={onToggleRepo} onToggleFile={onToggleFile} onOpenThread={onOpenThread}
                    loaders={loaders} showHost={showHost} />
                ))}
                {overview !== null && overview.otherFiles.length > 0 && (
                  <section data-other-files className="pb-2">
                    <h3 className="px-3.5 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">Other files</h3>
                    <p className="px-3.5 pb-1 text-xs text-muted-foreground">Edits outside any repository, from the agents' recorded edits.</p>
                    {overview.otherFiles.map((file) => (
                      <FileRow key={file.path} repo={null} file={file} scope={overview.scope} threads={threads}
                        expanded={expandedFiles.has(fileKey(null, file.path, overview.scope))} onToggle={onToggleFile} loaders={loaders} />
                    ))}
                  </section>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </LiveThreadsProvider>
  );
}
