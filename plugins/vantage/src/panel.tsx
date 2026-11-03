import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { ThreadChat, experimental_Icon as Icon, useBbNavigate, useRealtime, type ExperimentalThreadActionTabProps } from "@get-bb/plugin-sdk/app";
import { createArchivedPreference } from "./archived-preference";
import { AllChanges } from "./changes";
import { ICON_BUTTON } from "./file-card";
import type { RepoFocus } from "./filters";
import { Hint } from "./hint";
import { LiveThreadsProvider, useLiveThread } from "./live";
import { firstToOpen, plural, urgentFirst, type Row } from "./model";
import { Review, StatusGlyph, isTyping } from "./review";
import { useSetReviewed, useSetWhole } from "./reviewed";
import { formatRoute, type PageRoute } from "./route";
import { reloadLoaded } from "./loaded";
import { createShared, useSession, useShared } from "./session";
import { comments, useLoaders } from "./shared";
import { SkeletonRows } from "./skeleton";
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

const STRIP = 4;
// About the narrowest a chip gets with its title cut short, and the room the menu and All changes take beside the chips.
const CHIP_PX = 120;
const RESERVED_PX = 190;

// How many chips fit beside the menu and All changes; the rest go into the menu.
function useChipsThatFit(): [(node: HTMLDivElement | null) => void, number] {
  const [fit, setFit] = useState(STRIP);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (node === null || typeof ResizeObserver === "undefined") return;
    const measure = (width: number) => setFit(Math.max(1, Math.min(STRIP, Math.floor((width - RESERVED_PX) / CHIP_PX))));
    measure(node.getBoundingClientRect().width);
    observer.current = new ResizeObserver((entries) => {
      const width = entries.at(-1)?.contentRect.width;
      if (width !== undefined) measure(width);
    });
    observer.current.observe(node);
  }, []);
  return [ref, fit];
}

// One chip per worktree, the thread's own first, then its child threads' with the most urgent first; the rest in a menu.
function WorktreeStrip({ rows, selectedKey, view, archivedHidden, onPick, onChanges, onShowArchived }: {
  rows: readonly Row[]; selectedKey: string | null; view: PanelView; archivedHidden: number;
  onPick(key: string): void; onChanges(): void; onShowArchived(): void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const [measured, fit] = useChipsThatFit();
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const picked = view === "worktrees" ? selectedKey : null;
  // A worktree picked from the menu takes the last chip's place, so the chosen one is always in sight.
  let shown = rows.slice(0, fit);
  const chosen = rows.find((row) => row.worktree.key === picked);
  if (chosen !== undefined && !shown.includes(chosen)) shown = [...shown.slice(0, fit - 1), chosen];
  const more = rows.filter((row) => !shown.includes(row));
  // A chip gives up its title down to CHIP_PX's worth, so two always fit in the room useChipsThatFit measured.
  const chip = (selected: boolean) => `inline-flex h-7 min-w-24 max-w-48 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs ${
    selected ? "border-foreground/40 bg-card font-medium text-foreground" : "border-border-seam text-muted-foreground hover:bg-state-hover hover:text-foreground"}`;
  // The chips give up their titles first, then scroll; the menu and All changes stay in reach outside them.
  return (
    <div ref={measured} role="group" aria-label="Worktrees" data-worktree-strip className="flex min-w-0 flex-1 items-center gap-1">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {shown.map((row) => (
          <button key={row.worktree.key} type="button" aria-pressed={row.worktree.key === picked} title={row.live.title}
            onClick={() => onPick(row.worktree.key)} className={chip(row.worktree.key === picked)}>
            <span className="flex size-3.5 shrink-0 items-center justify-center"><StatusGlyph row={row} /></span>
            <span className="min-w-0 truncate">{row.title}</span>
            <span className="shrink-0 font-mono text-[10.5px] tabular-nums"><span className="text-diff-added">+{row.additions}</span> <span className="text-diff-removed">−{row.deletions}</span></span>
          </button>
        ))}
      </div>
      {(more.length > 0 || archivedHidden > 0) && (
        <div ref={wrap} className="relative shrink-0"
          onKeyDown={(event) => { if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>
          <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((shown) => !shown)} className={`${chip(false)} shrink-0`}>
            {more.length > 0 ? `${more.length} more` : "Archived"}<Icon name="ChevronDown" className="size-3 shrink-0" aria-hidden />
          </button>
          {open && (
            <div role="menu" className="absolute right-0 top-8 z-20 max-h-80 w-72 overflow-y-auto rounded-lg border border-border-seam bg-card p-1 shadow-lg">
              {more.map((row) => (
                <button key={row.worktree.key} type="button" role="menuitem" onClick={() => { onPick(row.worktree.key); setOpen(false); }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-state-hover">
                  <span className="flex size-3.5 shrink-0 items-center justify-center"><StatusGlyph row={row} /></span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{row.title}</span>
                  <span className="shrink-0 font-mono text-[10.5px]"><span className="text-diff-added">+{row.additions}</span> <span className="text-diff-removed">−{row.deletions}</span></span>
                </button>
              ))}
              {archivedHidden > 0 && (
                <button type="button" role="menuitem" onClick={() => { onShowArchived(); setOpen(false); }}
                  className="block w-full cursor-pointer rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-state-hover">
                  Show {plural(archivedHidden, "archived thread")}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <button type="button" aria-pressed={view === "changes"} onClick={onChanges} className={`${chip(view === "changes")} shrink-0`}>All changes</button>
    </div>
  );
}

// The worktree the tab opens on: the thread's own when it has changes, else the child worktree that most needs a person,
// else the first one listed, such as an archived child's kept branch.
export function defaultKey(rows: readonly Row[], threadId: string): string | null {
  return (rows.find((row) => row.threadId === threadId) ?? firstToOpen(rows) ?? rows[0])?.worktree.key ?? null;
}

// Its own worktree, then its child threads' by urgency; archived ones last.
export function stripOrder(rows: readonly Row[], threadId: string): Row[] {
  const own = rows.filter((row) => row.threadId === threadId);
  return [...own, ...urgentFirst(rows.filter((row) => row.threadId !== threadId))];
}

function PanelScreen({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const loaders = useLoaders();
  const setReviewed = useSetReviewed();
  const setWhole = useSetWhole();
  const includeArchived = useSyncExternalStore(archivedPreference.subscribe, archivedPreference.get, archivedPreference.get);
  const target = useMemo(() => ({ kind: "tree" as const, threadId }), [threadId]);
  const { store, snapshot } = useSession("thread", target, includeArchived);
  const { overview } = snapshot;
  const view = useShared(panelView);
  const [picked, setPicked] = useState<string | null>(null);
  const [focus, setFocus] = useState<RepoFocus | null>(null);
  const [tab, setTab] = useState<"changes" | "chat">("changes");
  const data = useRows(overview, { currentThreadId: threadId, text: "", chip: null, groupBy: "status" });
  const live = useLiveThread(threadId, overview?.threads.find((thread) => thread.id === threadId));
  const order = useMemo(() => stripOrder(data.rows, threadId), [data.rows, threadId]);
  useRealtime("vantage:settings", () => { store?.refresh(); });

  const requested = useShared(panelSelection);
  useEffect(() => {
    if (requested === null || requested.threadId !== threadId) return;
    panelView.set("worktrees");
    setPicked(requested.key);
    setTab("changes");
    panelSelection.set(null);
  }, [requested, threadId]);

  // A worktree picked here, or asked for by another surface, while it still has changes; otherwise the default one.
  const pickedRow = picked === null ? null : data.rowFor(picked);
  const selectedKey = pickedRow !== null ? picked : defaultKey(order, threadId);
  const row = selectedKey === null ? null : data.rowFor(selectedKey);
  useEffect(() => {
    if (overview === null || overview.partial) return;
    // Once the numbers are in, the default stays picked, so a status change elsewhere never swaps the worktree or its chat.
    if (picked === null || pickedRow === null) setPicked(defaultKey(order, threadId));
  }, [picked, overview, pickedRow, order, threadId]);
  const index = row === null ? -1 : order.findIndex((entry) => entry.worktree.key === row.worktree.key);
  const open = useCallback((key: string) => { setPicked(key); setTab("changes"); panelView.set("worktrees"); }, []);
  const step = useCallback((delta: -1 | 1) => {
    const next = order[index + delta];
    if (next !== undefined) open(next.worktree.key);
  }, [order, index, open]);
  const fullScreen = (route: Partial<PageRoute> = {}) => navigate.toPluginPanel("vantage", {
    subPath: formatRoute({ target, view: "overview", selectedKey: row?.worktree.key ?? null, focus: null, ...route }),
  });
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (row === null || view !== "worktrees" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || isTyping(event.target)) return;
    if (event.key === "[") step(-1);
    else if (event.key === "]") step(1);
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
  if (view === "changes") {
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto">
        {banners}
        {overview === null
          ? <SkeletonRows count={4} label="Loading changes" />
          : <AllChanges overview={overview} scope={snapshot.scope} onScope={(scope) => store?.setScope(scope)} focus={focus} onClearFocus={() => setFocus(null)}
            text="" compact loaders={loaders} onOpenThread={(id) => navigate.toThread(id, { split: true })} />}
      </div>
    );
  } else if (row !== null && overview !== null) {
    body = tab === "chat" && !own
      ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-border-seam px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{row.live.title}</span>{switcher}
          </div>
          <div className="min-h-0 flex-1"><ThreadChat threadId={row.threadId} variant="compact" layout="contained" permissionPolicy="inherit" /></div>
        </div>
      )
      : (
        <div data-panel-drill className="min-h-0 flex-1 overflow-y-auto">
          {banners}
          <Review key={row.worktree.key} overview={overview} row={row} index={index} total={order.length} compact currentThreadId={threadId} currentHostId={currentHostId}
            terminal="thread" marks={data.marks[row.worktree.key]} titleOf={data.titleOf} branchOf={data.branchOf} comments={comments} loaders={loaders}
            setReviewed={setReviewed} onStep={step} onWhole={(whole) => setWhole(row.worktree.key, whole).then(() => store?.refresh())}
            onMessage={() => setTab("chat")} onCompare={() => fullScreen({ view: "overlaps", selectedKey: null })}
            onSent={() => { if (!own) setTab("chat"); }} toolbar={switcher} />
        </div>
      );
  } else {
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto">
        {banners}
        {overview === null || overview.partial && data.rows.length === 0
          ? <SkeletonRows count={4} label="Loading worktrees" />
          : (
            <p className="p-4 text-sm text-muted-foreground">
              No worktree in this thread or its child threads has changes yet.{" "}
              <button type="button" className="cursor-pointer underline" onClick={() => panelView.set("changes")}>See every change by repository</button>
            </p>
          )}
      </div>
    );
  }

  return (
    <section data-vantage-panel tabIndex={-1} onKeyDown={onKeyDown} className="flex h-full min-h-0 min-w-0 flex-col bg-surface-recessed text-foreground">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border-seam px-2.5 py-1.5">
        <WorktreeStrip rows={order} selectedKey={selectedKey} view={view} archivedHidden={includeArchived || overview === null ? 0 : overview.archivedHidden}
          onPick={open} onChanges={() => { setFocus(null); panelView.set("changes"); }} onShowArchived={() => archivedPreference.set(true)} />
        {snapshot.refreshing && <span aria-live="polite" className="sr-only">Updating</span>}
        <button type="button" aria-label="Refresh" title="Refresh" onClick={() => { reloadLoaded(); store?.refresh({ hard: true }); }} className={ICON_BUTTON}>
          <Icon name="ArrowReloadHorizontal" fallback="RotateCcw" className={`size-3.5 ${snapshot.refreshing ? "animate-spin" : ""}`} aria-hidden />
        </button>
        <Hint label={`Open Vantage full screen for ${live.title}`}>
          <button type="button" aria-label="Open full screen" onClick={() => fullScreen(view === "changes" ? { view: "changes", selectedKey: null } : {})} className={ICON_BUTTON}>
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
