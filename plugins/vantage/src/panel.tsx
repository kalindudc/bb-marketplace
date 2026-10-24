import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { ThreadChat, experimental_Icon as Icon, useBbNavigate, type ExperimentalThreadActionTabProps } from "@get-bb/plugin-sdk/app";
import { createArchivedPreference } from "./archived-preference";
import { AllChanges } from "./changes";
import { ICON_BUTTON } from "./file-card";
import type { RepoFocus } from "./filters";
import { Hint } from "./hint";
import { FilterChips, WorktreeList } from "./list";
import { LiveThreadsProvider, useLiveThread } from "./live";
import type { Chip } from "./model";
import { PrefToggles } from "./page";
import { Review, isTyping } from "./review";
import { useSetReviewed } from "./reviewed";
import { formatRoute, type PageRoute } from "./route";
import { reloadLoaded } from "./loaded";
import { createShared, useSession, useShared } from "./session";
import { comments, useLoaders } from "./shared";
import { SkeletonRows } from "./skeleton";
import { groupBy } from "./ui-prefs";
import { useRows } from "./use-rows";

export type PanelView = "worktrees" | "changes";
// "repositories" is what 0.5 and earlier stored for the view that is now All changes.
export const panelView = createShared<PanelView>("worktrees", {
  win: window, key: "bb-plugin-vantage:view",
  parse: (raw) => (raw === "changes" || raw === "repositories" ? "changes" : raw === "worktrees" ? "worktrees" : null),
});
// Which worktree the composer segment or the Info section asked a thread's tab to open.
export const panelSelection = createShared<{ threadId: string; key: string; at: number } | null>(null);

const archivedPreference = createArchivedPreference(window, "panel");

function PanelScreen({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const loaders = useLoaders();
  const setReviewed = useSetReviewed();
  const includeArchived = useSyncExternalStore(archivedPreference.subscribe, archivedPreference.get, archivedPreference.get);
  const target = useMemo(() => ({ kind: "tree" as const, threadId }), [threadId]);
  const { store, snapshot } = useSession("thread", target, includeArchived);
  const { overview } = snapshot;
  const view = useShared(panelView);
  const by = useShared(groupBy);
  const [chip, setChip] = useState<Chip | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [focus, setFocus] = useState<RepoFocus | null>(null);
  const [tab, setTab] = useState<"changes" | "chat">("changes");
  const data = useRows(overview, { currentThreadId: threadId, text: "", chip, groupBy: by });
  const live = useLiveThread(threadId, overview?.threads.find((thread) => thread.id === threadId));

  const requested = useShared(panelSelection);
  useEffect(() => {
    if (requested === null || requested.threadId !== threadId) return;
    panelView.set("worktrees");
    setSelectedKey(requested.key);
    setTab("changes");
    panelSelection.set(null);
  }, [requested, threadId]);

  const row = selectedKey === null ? null : data.rowFor(selectedKey);
  useEffect(() => {
    if (selectedKey !== null && overview !== null && !overview.partial && row === null) setSelectedKey(null);
  }, [selectedKey, overview, row]);
  const index = row === null ? -1 : data.order.findIndex((entry) => entry.worktree.key === row.worktree.key);
  const open = useCallback((key: string) => { setSelectedKey(key); setTab("changes"); }, []);
  const step = useCallback((delta: -1 | 1) => {
    const next = data.order[index + delta];
    if (next !== undefined) open(next.worktree.key);
  }, [data.order, index, open]);
  const back = () => { setSelectedKey(null); setTab("changes"); };
  const fullScreen = (route: Partial<PageRoute> = {}) => navigate.toPluginPanel("vantage", {
    subPath: formatRoute({ target, view: "overview", selectedKey: row?.worktree.key ?? null, focus: null, ...route }),
  });
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (row === null || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || isTyping(event.target)) return;
    if (event.key === "[") step(-1);
    else if (event.key === "]") step(1);
    // In Chat, Escape belongs to bb's chat.
    else if (event.key === "Escape" && tab !== "chat") back();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const currentHostId = overview?.worktrees.find((worktree) => worktree.threadIds.includes(threadId))?.hostId ?? null;
  const own = row !== null && row.threadId === threadId;

  const banners = (
    <>
      {snapshot.status === "error" && (
        <div role="alert" className="border-b border-border-seam p-3 text-sm text-destructive-text">
          Could not load changes: {snapshot.error}<button type="button" className="ml-2 cursor-pointer underline" onClick={() => store?.refresh({ hard: true })}>Retry</button>
        </div>
      )}
      {snapshot.status === "ready" && snapshot.error !== null && (
        <div role="alert" className="border-b border-border-seam px-3 py-2 text-xs text-warning-text">
          Could not refresh: {snapshot.error}<button type="button" className="ml-2 cursor-pointer underline" onClick={() => store?.refresh({ hard: true })}>Retry</button>
        </div>
      )}
      {(overview?.warnings ?? []).map((warning) => <div key={warning} role="status" className="border-b border-border-seam px-3 py-2 text-xs text-warning-text">{warning}</div>)}
    </>
  );

  const switcher = !own && row !== null && (
    <div role="group" aria-label="Show" className="inline-flex rounded-md bg-surface-recessed p-0.5">
      {(["changes", "chat"] as const).map((value) => (
        <button key={value} type="button" aria-pressed={tab === value} onClick={() => setTab(value)}
          className={`h-6 cursor-pointer rounded px-2 text-xs ${tab === value ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
          {value === "changes" ? "Changes" : "Chat"}
        </button>
      ))}
    </div>
  );

  let body;
  if (row !== null && overview !== null) {
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 px-2 pt-1.5 text-xs text-muted-foreground">
          <button type="button" onClick={back} className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-state-hover hover:text-foreground">
            <Icon name="ArrowLeft" className="size-3.5" aria-hidden />All worktrees
          </button>
          <span className="flex-1" />
          <button type="button" aria-label="Previous worktree" title="Previous worktree ([)" disabled={index <= 0} onClick={() => step(-1)} className={ICON_BUTTON}>
            <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
          </button>
          {index >= 0 && <span>{index + 1} of {data.order.length}</span>}
          <button type="button" aria-label="Next worktree" title="Next worktree (])" disabled={index < 0 || index >= data.order.length - 1} onClick={() => step(1)} className={ICON_BUTTON}>
            <Icon name="ChevronRight" className="size-3.5" aria-hidden />
          </button>
        </div>
        {tab === "chat" && !own
          ? (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-border-seam px-3 pb-2 pt-1">
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{row.live.title}</span>{switcher}
              </div>
              <div className="min-h-0 flex-1"><ThreadChat threadId={row.threadId} variant="compact" layout="contained" permissionPolicy="inherit" /></div>
            </>
          )
          : (
            <div data-panel-drill className="min-h-0 flex-1 overflow-y-auto">
              <Review key={row.worktree.key} overview={overview} row={row} index={index} total={data.order.length} compact currentThreadId={threadId} currentHostId={currentHostId}
                terminal="thread" marks={data.marks[row.worktree.key]} titleOf={data.titleOf} branchOf={data.branchOf} comments={comments} loaders={loaders}
                setReviewed={setReviewed} onToggleReviews={() => data.toggleFor("reviews", row.threadId, threadId)} onStep={step}
                onMessage={() => setTab("chat")} onCompare={() => fullScreen({ view: "overlaps", selectedKey: null })}
                onSent={() => { if (!own) setTab("chat"); }} toolbar={switcher} />
            </div>
          )}
      </div>
    );
  } else if (view === "changes") {
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto">
        {banners}
        {overview === null
          ? <SkeletonRows count={4} label="Loading changes" />
          : <AllChanges overview={overview} scope={snapshot.scope} onScope={(scope) => store?.setScope(scope)} focus={focus} onClearFocus={() => setFocus(null)}
            text="" compact loaders={loaders} onOpenThread={(id) => navigate.toThread(id, { split: true })} />}
      </div>
    );
  } else {
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
        {banners}
        {overview === null
          ? <SkeletonRows count={4} label="Loading worktrees" />
          : (
            <>
              <div className="px-1.5 pt-2"><FilterChips counts={data.counts} chip={chip} onChip={setChip} /></div>
              <WorktreeList groups={data.groups} outside={data.outside} counts={data.counts} chip={chip} onChip={setChip} selectedKey={null}
                titleOf={data.titleOf} onOpen={open}
                onOpenOutside={(entry) => { setFocus(entry.kind === "repo" ? { kind: "repo", key: entry.key } : { kind: "otherFiles" }); panelView.set("changes"); }}
                hidden={data.hidden} archivedHidden={includeArchived ? 0 : overview.archivedHidden} onIncludeArchived={() => archivedPreference.set(true)}
                partial={overview.partial} />
            </>
          )}
      </div>
    );
  }

  return (
    <section data-vantage-panel tabIndex={-1} onKeyDown={onKeyDown} className="flex h-full min-h-0 min-w-0 flex-col bg-surface-recessed text-foreground">
      <div className="flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-border-seam px-2.5 py-1.5">
        <div role="group" aria-label="View" className="inline-flex rounded-md bg-card p-0.5">
          {(["worktrees", "changes"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={row === null && view === value} onClick={() => { setSelectedKey(null); if (value === "worktrees") setFocus(null); panelView.set(value); }}
              className={`h-6 cursor-pointer rounded px-2 text-xs ${row === null && view === value ? "bg-surface-selected font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {value === "worktrees" ? "Worktrees" : "All changes"}
            </button>
          ))}
        </div>
        <span className="min-w-0 flex-1" />
        <PrefToggles threadId={threadId} data={data} size="small" />
        {snapshot.refreshing && <span aria-live="polite" className="sr-only">Updating</span>}
        <button type="button" aria-label="Refresh" title="Refresh" onClick={() => { reloadLoaded(); store?.refresh({ hard: true }); }} className={ICON_BUTTON}>
          <Icon name="ArrowReloadHorizontal" fallback="RotateCcw" className={`size-3.5 ${snapshot.refreshing ? "animate-spin" : ""}`} aria-hidden />
        </button>
        <Hint label={`Open Vantage full screen for ${live.title}`}>
          <button type="button" aria-label="Open full screen" onClick={() => fullScreen(view === "changes" && row === null ? { view: "changes", selectedKey: null } : {})} className={ICON_BUTTON}>
            <Icon name="Maximize2" className="size-3.5" aria-hidden />
          </button>
        </Hint>
      </div>
      {body}
    </section>
  );
}

export function VantagePanel({ threadId }: Pick<ExperimentalThreadActionTabProps, "threadId">) {
  // A new thread starts a new tab state; keying it also keeps a worktree another surface asked for when the tab first opens.
  return <LiveThreadsProvider><PanelScreen key={threadId} threadId={threadId} /></LiveThreadsProvider>;
}
