import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import {
  experimental_Icon as Icon, useBbNavigate, useRealtime, useRpc, useSdk, type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { DEFAULT_FILTER, filterRepos, filterWorktrees, projectOptions, type PageFilter } from "./filters";
import type { FileChange, Overview, Repo, Scope, rpcContract } from "./contract";
import { fileKey, FileRow } from "./file-row";
import { createLimiter } from "./limit";
import { RepoSection } from "./repo-section";
import { formatRoute, parseRoute, type PageRoute, type PageView } from "./route";
import { createVantageStore, type VantageSnapshot, type VantageStore } from "./store";
import { WorktreeDetail, type WorktreeDetailProps } from "./worktree-detail";
import { LiveThreadsProvider, WorktreeList, lineCounts, useLiveThread, useWorktreeTally } from "./worktree-list";

const PAGE_PATH = "vantage";
const WIDE_FROM_PX = 880;
const PATCH_CONCURRENCY = 4;
const EMPTY_SNAPSHOT: VantageSnapshot = { status: "loading", overview: null, scope: "uncommitted", refreshing: false, error: null };
const VIEWS: ReadonlyArray<{ view: PageView; label: string }> = [
  { view: "worktrees", label: "Worktrees" },
  { view: "repositories", label: "Repositories" },
];
const SCOPES: ReadonlyArray<{ scope: Scope; label: string }> = [
  { scope: "uncommitted", label: "Uncommitted" },
  { scope: "branch", label: "Branch" },
];
const SWITCH = "inline-flex shrink-0 overflow-hidden rounded-md border border-border-seam";
const FIELD = "h-7 rounded-md border border-border-seam bg-transparent px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const limitPatches = createLimiter(PATCH_CONCURRENCY);
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

function fileKeys(repos: readonly Repo[], otherFiles: readonly FileChange[], scope: Scope): string[] {
  return [
    ...repos.flatMap((repo) => [...repo.files, ...repo.otherFiles].map((file) => fileKey(repo, file.path, scope))),
    ...otherFiles.map((file) => fileKey(null, file.path, scope)),
  ];
}

function SwitchButtons<T extends string>({ label, options, value, onChange }: {
  label: string; options: ReadonlyArray<{ value: T; text: string }>; value: T; onChange(value: T): void;
}) {
  return (
    <div role="group" aria-label={label} className={SWITCH}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}
          className={`cursor-pointer px-2 py-0.5 text-xs ${value === option.value ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}>
          {option.text}
        </button>
      ))}
    </div>
  );
}

function ScopeLabel({ overview, route, onShowAll }: { overview: Overview | null; route: PageRoute; onShowAll(): void }) {
  const threadId = route.target.kind === "tree" ? route.target.threadId : "";
  const live = useLiveThread(threadId, overview?.threads.find((thread) => thread.id === threadId));
  if (route.target.kind === "all") {
    return <span className="shrink-0 text-sm font-semibold text-foreground">All threads{overview?.windowHours == null ? "" : ` · last ${overview.windowHours} h`}</span>;
  }
  return (
    <>
      <span className="min-w-0 truncate text-sm font-semibold text-foreground">Tree: {live.title}</span>
      <button type="button" onClick={onShowAll}
        className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-xs text-muted-foreground underline hover:bg-state-hover hover:text-foreground">
        Show all threads
      </button>
    </>
  );
}

function WorktreeSummary({ overview, worktrees }: { overview: Overview; worktrees: Overview["worktrees"] }) {
  const tally = useWorktreeTally(overview, worktrees, null);
  const files = worktrees.reduce((sum, worktree) => sum + worktree.uncommitted.length + worktree.committed.length, 0);
  const lines = worktrees.map(lineCounts);
  const projects = new Set(worktrees.map((worktree) => worktree.projectId)).size;
  return (
    <span data-page-summary className="text-xs text-muted-foreground">
      {plural(worktrees.length, "workspace")} · {tally.running} running · {tally.needs} {tally.needs === 1 ? "needs" : "need"} you · {tally.failed} failed ·{" "}
      {plural(files, "file")} <span className="text-diff-added">+{lines.reduce((sum, entry) => sum + entry.additions, 0)}</span>{" "}
      <span className="text-diff-removed">−{lines.reduce((sum, entry) => sum + entry.deletions, 0)}</span> · {plural(projects, "project")}
    </span>
  );
}

function RepoSummary({ repos }: { repos: readonly Repo[] }) {
  const files = repos.reduce((sum, repo) => sum + repo.totals.files, 0);
  const projects = new Set(repos.map((repo) => repo.projectId)).size;
  return (
    <span data-page-summary className="text-xs text-muted-foreground">
      {plural(repos.length, "repo")} · {plural(files, "file")} <span className="text-diff-added">+{repos.reduce((sum, repo) => sum + repo.totals.additions, 0)}</span>{" "}
      <span className="text-diff-removed">−{repos.reduce((sum, repo) => sum + repo.totals.deletions, 0)}</span> · {plural(projects, "project")}
    </span>
  );
}

function VantageScreen({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const sdkRef = useRef(sdk);
  sdkRef.current = sdk;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const { route, canonical } = useMemo(() => parseRoute(subPath), [subPath]);
  const go = useCallback((next: PageRoute, replace = false) => {
    navigateRef.current.toPluginPanel(PAGE_PATH, { subPath: formatRoute(next), ...(replace ? { replace: true } : {}) });
  }, []);
  useEffect(() => {
    if (canonical !== subPath) go(route, true);
  }, [canonical, subPath, route, go]);

  const targetKey = JSON.stringify(route.target);
  const [mounted, setMounted] = useState<{ key: string; store: VantageStore } | null>(null);
  const store = mounted?.key === targetKey ? mounted.store : null;
  useEffect(() => {
    const next = createVantageStore({ rpc: { call: (method, input) => rpcRef.current.call(method, input) }, sdk: sdkRef.current, target: route.target });
    setMounted({ key: targetKey, store: next });
    return () => next.dispose();
    // The store follows the target's content, not the identity of the route object.
  }, [targetKey]);
  const subscribe = useCallback((listener: () => void) => store?.subscribe(listener) ?? (() => {}), [store]);
  const getSnapshot = useCallback(() => store?.getSnapshot() ?? EMPTY_SNAPSHOT, [store]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { overview } = snapshot;
  useRealtime("vantage:settings", () => { store?.refresh(); });

  const rootRef = useRef<HTMLElement | null>(null);
  const [wide, setWide] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    setWide(root.getBoundingClientRect().width >= WIDE_FROM_PX);
    const observer = new ResizeObserver((entries) => {
      const width = entries.at(-1)?.contentRect.width;
      if (width !== undefined) setWide(width >= WIDE_FROM_PX);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const [filter, setFilter] = useState<PageFilter>(DEFAULT_FILTER);
  const worktrees = useMemo(() => (overview === null ? [] : filterWorktrees(overview, filter)), [overview, filter]);
  const repoView = useMemo(() => (overview === null ? { repos: [], otherFiles: [] } : filterRepos(overview, filter)), [overview, filter]);
  const projects = useMemo(() => (overview === null ? [] : projectOptions(overview)), [overview]);
  // The list's "changed outside worktrees" rows follow the filters too.
  const listOverview = useMemo(() => (overview === null ? null : { ...overview, ...repoView }), [overview, repoView]);
  const threads = useMemo(() => new Map((overview?.threads ?? []).map((thread) => [thread.id, thread])), [overview?.threads]);

  const selectedKey = route.selectedKey;
  const selected = selectedKey === null ? undefined : overview?.worktrees.find((worktree) => worktree.key === selectedKey);
  const detailOpen = route.view === "worktrees" && selected !== undefined;
  useEffect(() => {
    if (overview !== null && selectedKey !== null && selected === undefined) go({ ...route, selectedKey: null }, true);
  }, [overview, selectedKey, selected, route, go]);
  const [tab, setTab] = useState<WorktreeDetailProps["tab"]>("changes");
  useEffect(() => { setTab("changes"); }, [selectedKey]);

  const select = useCallback((key: string) => { if (key !== selectedKey) go({ ...route, selectedKey: key }); }, [go, route, selectedKey]);
  const clear = useCallback(() => go({ ...route, selectedKey: null }), [go, route]);
  const step = useCallback((delta: -1 | 1) => {
    const next = worktrees[worktrees.findIndex((worktree) => worktree.key === selectedKey) + delta];
    if (next !== undefined) go({ ...route, selectedKey: next.key });
  }, [go, route, selectedKey, worktrees]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!detailOpen || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
    if (target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']")) return;
    if (event.key === "[") step(-1);
    else if (event.key === "]") step(1);
    else if (event.key === "Escape") clear();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const loaders = useMemo<WorktreeDetailProps["loaders"]>(() => ({
    patch: (input) => limitPatches(() => rpcRef.current.call("patch", input)),
    recordedEdits: (input) => rpcRef.current.call("recordedEdits", input),
    commitFiles: (input) => rpcRef.current.call("commitFiles", input),
  }), []);
  const onOpenThread = useCallback((id: string) => navigateRef.current.toThread(id), []);

  const [collapsedRepos, setCollapsedRepos] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const flip = useCallback((set: ReadonlySet<string>, key: string): ReadonlySet<string> => {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    return next;
  }, []);
  const onToggleRepo = useCallback((key: string) => setCollapsedRepos((current) => flip(current, key)), [flip]);
  const onToggleFile = useCallback((key: string) => setExpandedFiles((current) => flip(current, key)), [flip]);
  const allKeys = fileKeys(repoView.repos, repoView.otherFiles, snapshot.scope);
  const everythingOpen = overview !== null && repoView.repos.every((repo) => !collapsedRepos.has(repo.key)) && allKeys.every((key) => expandedFiles.has(key));
  const toggleAll = () => {
    if (everythingOpen) {
      setCollapsedRepos(new Set(repoView.repos.map((repo) => repo.key)));
      setExpandedFiles(new Set());
    } else {
      setCollapsedRepos(new Set());
      setExpandedFiles(new Set(allKeys));
    }
  };

  const setView = (view: PageView) => { if (view !== route.view) go({ ...route, view, selectedKey: null }); };
  const showAll = () => go({ ...route, target: { kind: "all" }, selectedKey: null });
  const refreshHard = () => store?.refresh({ hard: true });

  const notices = overview === null ? [] : [
    ...overview.warnings,
    ...(overview.truncatedThreads
      ? [route.target.kind === "all"
        ? `Showing the ${overview.threads.length} most recent threads; raise the limit in Settings`
        : "Only the first 200 threads of this tree were read."]
      : []),
  ];
  const banners = (
    <>
      {snapshot.status === "error" && (
        <div role="alert" className="border-b border-border-seam px-4 py-3 text-sm text-destructive-text">
          Could not load changes: {snapshot.error}
          <button type="button" className="ml-2 underline" onClick={refreshHard}>Retry</button>
        </div>
      )}
      {snapshot.status === "ready" && snapshot.error !== null && (
        <div role="alert" className="border-b border-border-seam px-4 py-2 text-xs text-warning-text">
          Could not refresh: {snapshot.error}
          <button type="button" className="ml-2 underline" onClick={refreshHard}>Retry</button>
        </div>
      )}
      {notices.map((notice) => (
        <div key={notice} role="status" className="border-b border-border-seam px-4 py-2 text-xs text-warning-text">{notice}</div>
      ))}
    </>
  );

  const detail = detailOpen && overview !== null && (
    <WorktreeDetail overview={overview} worktreeKey={selectedKey!} worktrees={worktrees} tab={tab} currentThreadId={null} currentHostId={null}
      terminal="environment" onTab={setTab} onStep={step} onBack={clear} loaders={loaders} />
  );
  const list = overview !== null && listOverview !== null && (
    <WorktreeList overview={listOverview} worktrees={worktrees} currentThreadId={null} selectedKey={selectedKey} showSummary={false}
      onOpen={select} onShowRepositories={() => setView("repositories")} />
  );

  const groups = useMemo(() => {
    const byProject = new Map<string | null, Repo[]>();
    for (const repo of repoView.repos) byProject.set(repo.projectId, [...(byProject.get(repo.projectId) ?? []), repo]);
    const named = projects.flatMap((project) => (byProject.has(project.id) ? [{ id: project.id, name: project.name, repos: byProject.get(project.id)! }] : []));
    const listed = new Set(projects.map((project) => project.id));
    const rest = [...byProject].flatMap(([id, repos]) => (id !== null && listed.has(id) ? [] : [{ id, name: "Other repositories", repos }]));
    return [...named, ...rest];
  }, [repoView.repos, projects]);
  const showHost = overview !== null && new Set(overview.repos.map((repo) => repo.hostId)).size > 1;

  let body;
  if (wide === null || overview === null) {
    body = snapshot.status === "error" ? null : <p className="p-4 text-sm text-muted-foreground">Looking for changes…</p>;
  } else if (route.view === "repositories") {
    body = (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl pb-6">
          {repoView.repos.length === 0 && repoView.otherFiles.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              {overview.repos.length === 0 && overview.otherFiles.length === 0 ? "No changes in these threads yet." : "No repositories match the filters."}
            </p>
          )}
          {groups.map((group) => (
            <section key={group.id ?? "none"}>
              <h3 data-project-group={group.name} className="px-4 pb-1 pt-4 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">
                {`${group.name} · ${plural(group.repos.length, "repo")} · ${plural(group.repos.reduce((sum, repo) => sum + repo.totals.files, 0), "file")}`}
              </h3>
              {group.repos.map((repo) => (
                <RepoSection key={repo.key} repo={repo} scope={overview.scope} threads={threads} expanded={!collapsedRepos.has(repo.key)}
                  expandedFiles={expandedFiles} onToggleRepo={onToggleRepo} onToggleFile={onToggleFile} onOpenThread={onOpenThread}
                  loaders={loaders} showHost={showHost} />
              ))}
            </section>
          ))}
          {repoView.otherFiles.length > 0 && (
            <section data-other-files className="pb-2">
              <h3 className="px-4 pb-1 pt-4 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">Other files</h3>
              <p className="px-4 pb-1 text-xs text-muted-foreground">Edits outside any repository, from the agents' recorded edits.</p>
              {repoView.otherFiles.map((file) => (
                <FileRow key={file.path} repo={null} file={file} scope={overview.scope} threads={threads}
                  expanded={expandedFiles.has(fileKey(null, file.path, overview.scope))} onToggle={onToggleFile} loaders={loaders} />
              ))}
            </section>
          )}
        </div>
      </div>
    );
  } else if (overview.worktrees.length === 0) {
    body = <p className="p-4 text-sm text-muted-foreground">{route.target.kind === "all" ? `No worktrees in the last ${overview.windowHours ?? 24} hours.` : "No worktrees in this thread or its child threads yet."}</p>;
  } else if (wide) {
    body = (
      <div data-page-panes className="grid h-full min-h-0 grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
        <div className="min-h-0 overflow-y-auto border-r border-border-seam">{list}</div>
        <div className="flex min-h-0 min-w-0 flex-col">
          {detail || <p className="p-6 text-sm text-muted-foreground">Select a worktree to inspect it.</p>}
        </div>
      </div>
    );
  } else {
    body = <div data-page-panes className="h-full min-h-0">{detail || <div className="h-full overflow-y-auto">{list}</div>}</div>;
  }

  return (
    <section ref={rootRef} data-vantage-page tabIndex={-1} onKeyDown={onKeyDown} className="flex h-full min-h-0 min-w-0 flex-col bg-surface-recessed text-foreground">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-seam px-4 py-2.5">
        <ScopeLabel overview={overview} route={route} onShowAll={showAll} />
        <SwitchButtons label="View" options={VIEWS.map((entry) => ({ value: entry.view, text: entry.label }))} value={route.view} onChange={setView} />
        <label className="relative inline-flex items-center">
          <Icon name="Search" className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" aria-hidden />
          <input type="search" aria-label="Filter by text" placeholder="Thread, branch or file" value={filter.text}
            onChange={(event) => setFilter({ ...filter, text: event.target.value })} className={`${FIELD} w-44 pl-7`} />
        </label>
        <label className="relative inline-flex items-center">
          <Icon name="Filter" className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" aria-hidden />
          <select aria-label="Project" value={filter.projectId ?? ""} onChange={(event) => setFilter({ ...filter, projectId: event.target.value === "" ? null : event.target.value })}
            className={`${FIELD} max-w-44 cursor-pointer pl-7`}>
            <option value="">All projects</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={filter.changedOnly} onChange={(event) => setFilter({ ...filter, changedOnly: event.target.checked })} />
          With changes only
        </label>
        {route.view === "repositories" && (
          <>
            <SwitchButtons label="Scope" options={SCOPES.map((entry) => ({ value: entry.scope, text: entry.label }))} value={snapshot.scope}
              onChange={(scope) => store?.setScope(scope)} />
            <button type="button" disabled={overview === null} onClick={toggleAll}
              className="shrink-0 cursor-pointer rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-state-hover disabled:cursor-default disabled:opacity-60">
              {everythingOpen ? "Collapse all" : "Expand all"}
            </button>
          </>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {snapshot.refreshing && <span aria-live="polite" className="text-xs text-muted-foreground">Updating…</span>}
          <button type="button" aria-label="Refresh" title="Refresh" onClick={refreshHard}
            className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground">
            <Icon name="Refresh" className={`size-3.5 ${snapshot.refreshing ? "animate-spin" : ""}`} aria-hidden />
          </button>
        </span>
        {overview !== null && (
          <div className="basis-full">
            {route.view === "repositories" ? <RepoSummary repos={repoView.repos} /> : <WorktreeSummary overview={overview} worktrees={worktrees} />}
          </div>
        )}
      </div>
      <div className="shrink-0">{banners}</div>
      <div className="min-h-0 flex-1">{body}</div>
    </section>
  );
}

export function VantagePage(props: PluginNavPanelProps) {
  return (
    <LiveThreadsProvider>
      <VantageScreen {...props} />
    </LiveThreadsProvider>
  );
}
