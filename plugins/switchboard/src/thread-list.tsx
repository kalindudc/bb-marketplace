import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { experimental_useSidebarThreads, useBbNavigate, useSdk, type PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { applyPlan } from "./apply-plan";
import { archivedThreads } from "./archived";
import { BulkBar } from "./bulk-bar";
import { registerListHandlers } from "./commands";
import { DropIndicator, DragGhost } from "./drop-indicator";
import { indexGroups, planDrop, planKeyboardMove, type DropPlan } from "./drop-plan";
import { FilterBar } from "./filter-bar";
import { chipCounts, filterGroups, isFiltering, type ListFilter } from "./filter";
import { buildLanes } from "./lanes";
import { LanesView } from "./lanes-view";
import { GroupHeader } from "./group-header";
import { InfoCardProvider } from "./info-card";
import { type CollapseKey, type GroupKey, type SortMode } from "./layout";
import { densityMetrics } from "./metrics";
import { flattenGroup } from "./rows";
import { EMPTY_SELECTION, selectedRuns, selectRange, selectionRoots, toggleRow, type Selection } from "./selection";
import { EMPTY_COUNTS, rowState } from "./status";
import { useLayout } from "./use-layout";
import { useDrag } from "./use-drag";
import { useNow } from "./use-now";
import { useSwitchboardSettings } from "./use-settings";
import { ThreadRow } from "./thread-row";
import { buildModel, type Group, type TreeNode } from "./tree";
import { canSnooze, lastActivity, nextWake, wakeLabel } from "./triage";
import { useUpdateSettings } from "./use-update-settings";

const hasThread = (node: TreeNode, threadId: string | null): boolean =>
  node.thread.id === threadId || node.children.some((child) => hasThread(child, threadId));
const visit = (node: TreeNode, action: (entry: TreeNode) => void): void => {
  action(node);
  node.children.forEach((child) => visit(child, action));
};
const descendants = (node: TreeNode): number => node.children.reduce((total, child) => total + 1 + descendants(child), 0);
const WITH_ARCHIVED = { experimental_lifecycles: ["active", "archived"] } as const;
const message = (cause: unknown): string => cause instanceof Error && cause.message ? cause.message : "Switchboard could not save that change";

export function ThreadList(props: PluginThreadListProps) {
  const settings = useSwitchboardSettings();
  const sidebar = experimental_useSidebarThreads(settings.showArchived ? WITH_ARCHIVED : undefined);
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const metrics = densityMetrics(settings.density);
  const layoutApi = useLayout();
  const { layout, setCollapsed, setSectionOrder, setSectionHue, setSectionSort, snooze, unsnooze } = layoutApi;
  const updateSettings = useUpdateSettings();
  const now = useNow(60_000);
  const [filter, setFilter] = useState<ListFilter>({ query: "", states: new Set() });
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingSectionId, setPendingSectionId] = useState<string | null>(null);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [needsOpen, setNeedsOpen] = useState(true);
  const prunedSnoozes = useRef(new Set<string>());
  const [announcement, announce] = useState("");
  const [flashIds, setFlashIds] = useState<ReadonlySet<string>>(new Set());
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const projects = useMemo(() => new Map(sidebar.projects.map((project) => [project.id, project.name])), [sidebar.projects]);
  const sections = useMemo(() => new Map(sidebar.sections.map((section) => [section.id, section.name])), [sidebar.sections]);
  const names = useMemo(() => ({
    project: (id: string) => projects.get(id) ?? id,
    section: (id: string | null) => id ? sections.get(id) ?? "" : "",
  }), [projects, sections]);
  const activeThreads = useMemo(() => sidebar.threads.filter((thread) => !thread.isArchived), [sidebar.threads]);
  const model = useMemo(() => buildModel({ threads: activeThreads, sections: sidebar.sections, layout,
    now, staleDays: settings.staleDays }), [activeThreads, sidebar.sections, layout, now, settings.staleDays]);
  const archivedPage = sidebar.experimental_archived;
  const archived = useMemo(() => settings.showArchived && filter.states.size === 0 ?
    archivedThreads(sidebar.threads, filter.query, names) : [],
  [settings.showArchived, filter.states.size, filter.query, sidebar.threads, names]);
  const { groups, snoozed } = model;
  const index = useMemo(() => indexGroups(groups, layout.sectionSort), [groups, layout.sectionSort]);
  const counts = useMemo(() => chipCounts(groups), [groups]);
  const filtering = isFiltering(filter);
  const visible = useMemo(() => filterGroups(groups, filter, names), [groups, filter, names]);
  const lanes = useMemo(() => buildLanes(groups, filter, names), [groups, filter, names]);
  const urgent = useMemo(() => lanes.flatMap((lane) => lane.state === "failed" || lane.state === "needs" ? lane.rows : [])
    .sort((a, b) => lastActivity(b.thread) - lastActivity(a.thread)), [lanes]);
  const collapsed = useMemo(() => new Set(layout.collapsed), [layout.collapsed]);
  const rows = useMemo(() => visible.map((group) => ({
    group,
    items: flattenGroup(group, { collapsed, filtering, activeThreadId: props.activeThreadId, projectName: names.project }),
    isCollapsed: !filtering && collapsed.has(group.key) &&
      !group.roots.some((root) => hasThread(root, props.activeThreadId)),
  })), [visible, collapsed, filtering, props.activeThreadId, names]);
  const visibleIds = useMemo(() => rows.flatMap(({ isCollapsed, items }) => isCollapsed ? [] : items.map((row) => row.thread.id)), [rows]);
  const runs = useMemo(() => selectedRuns(rows.map(({ isCollapsed, items }) =>
    isCollapsed ? [] : items.map((row) => row.thread.id)), selection.ids), [rows, selection.ids]);
  const sectionIds = useMemo(() => groups.filter((group) => group.kind === "section").map((group) => group.section!.id), [groups]);
  const onToggle = useCallback((key: CollapseKey) => setCollapsed(key, !collapsed.has(key)), [collapsed, setCollapsed]);
  const canSnoozeId = useCallback((id: string) => {
    const entry = index.byId.get(id);
    return entry?.parentId === null && canSnooze(entry.node);
  }, [index]);
  const onSnoozeId = useCallback((id: string) => {
    if (canSnoozeId(id)) snooze([id], nextWake(now, settings.snoozeHour));
  }, [canSnoozeId, snooze, now, settings.snoozeHour]);
  useEffect(() => {
    const ready = Object.entries(layout.snoozes).filter(([id, entry]) =>
      !prunedSnoozes.current.has(id) && (now >= entry.until || index.byId.has(id))).map(([id]) => id);
    if (!ready.length) return;
    ready.forEach((id) => prunedSnoozes.current.add(id));
    for (let offset = 0; offset < ready.length; offset += 500) unsnooze(ready.slice(offset, offset + 500));
  }, [layout.snoozes, index, now, unsnooze]);
  const onNavigate = useCallback(() => { setSelection(EMPTY_SELECTION); props.onNavigate(); }, [props.onNavigate]);
  const onSelect = useCallback((id: string, mode: "toggle" | "range") => {
    setSelection((current) => mode === "toggle" ? toggleRow(current, id) : selectRange(current, visibleIds, id));
  }, [visibleIds]);
  const flash = useCallback((ids: readonly string[]) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlashIds(new Set(ids));
    flashTimer.current = setTimeout(() => setFlashIds(new Set()), 900);
  }, []);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);
  useEffect(() => { setSelection(EMPTY_SELECTION); }, [props.activeThreadId]);
  useEffect(() => {
    if (pendingSectionId && sidebar.sections.some((section) => section.id === pendingSectionId)) {
      setRenamingId(pendingSectionId);
      setPendingSectionId(null);
    }
  }, [pendingSectionId, sidebar.sections]);
  const apply = useCallback((plan: DropPlan) => {
    if (plan.ok === false) { announce(plan.reason); return; }
    if (plan.ok !== true) return;
    void applyPlan(plan, { sdk, layout: layoutApi, index, announce,
      onApplied: () => flash(plan.moves.map((move) => move.threadId)) });
  }, [sdk, layoutApi, index, flash]);
  const onKeyboardMove = useCallback((id: string, direction: "up" | "down" | "right" | "left") => {
    apply(planKeyboardMove(index, id, direction));
  }, [apply, index]);
  const onSectionMove = useCallback((ids: readonly string[]) => {
    if (ids.every((id, position) => id === sectionIds[position])) return;
    const previous = sectionIds;
    setSectionOrder(ids);
    const summary = "Reordered sections";
    toast(summary, { action: { label: "Undo", onClick: () => setSectionOrder(previous) } });
    announce(summary);
  }, [sectionIds, setSectionOrder]);
  const drag = useDrag({ index, selection, metrics, enabled: settings.view === "sections" && !filtering && !props.isCompactViewport, rootRef, sectionIds,
    onDropThreads: apply, onDropSection: onSectionMove, onExpand: (key) => setCollapsed(key, false) });
  const onBulkMove = (key: GroupKey) => {
    apply(planDrop(index, selectionRoots(selection, index), { kind: "group", key }));
    setSelection(EMPTY_SELECTION);
  };
  const roots = selectionRoots(selection, index);
  const childCount = roots.reduce((total, id) => total + descendants(index.byId.get(id)!.node), 0);
  const onBulkSnooze = () => {
    if (!roots.length || !roots.every(canSnoozeId)) return;
    for (let offset = 0; offset < roots.length; offset += 500)
      snooze(roots.slice(offset, offset + 500), nextWake(now, settings.snoozeHour));
    setSelection(EMPTY_SELECTION);
  };
  const onBulkArchive = async () => {
    const archivedIds: string[] = [];
    for (const id of roots) visit(index.byId.get(id)!.node, (node) => archivedIds.push(node.thread.id));
    try {
      for (const id of roots) await sdk.threads.archive({ threadId: id });
      const summary = `Archived ${roots.length} ${roots.length === 1 ? "thread" : "threads"}`;
      toast(summary, { action: { label: "Undo", onClick: () => {
        void (async () => {
          for (const id of archivedIds) {
            try { await sdk.threads.unarchive({ threadId: id }); }
            catch (cause) { console.warn("Switchboard could not unarchive a thread.", id, cause); }
          }
          announce("Archive undone");
        })();
      } } });
      announce(summary);
      setSelection(EMPTY_SELECTION);
    } catch (cause) { toast.error(message(cause)); }
  };
  const onArchiveStale = async (group: Group) => {
    const stale = group.roots.filter((root) => root.stale);
    if (!stale.length) return;
    const archivedIds: string[] = [];
    stale.forEach((root) => visit(root, (node) => archivedIds.push(node.thread.id)));
    try {
      for (const root of stale) await sdk.threads.archive({ threadId: root.thread.id });
      const summary = `Archived ${stale.length} stale ${stale.length === 1 ? "thread" : "threads"}`;
      toast(summary, { action: { label: "Undo", onClick: () => {
        void (async () => {
          for (const id of archivedIds) {
            try { await sdk.threads.unarchive({ threadId: id }); }
            catch (cause) { console.warn("Switchboard could not unarchive a thread.", id, cause); }
          }
          announce("Archive undone");
        })();
      } } });
      announce(summary);
    } catch (cause) { toast.error(message(cause)); }
  };
  const onNewThread = (group: Group) => {
    const newest = [...group.roots].sort((a, b) => b.thread.updatedAt - a.thread.updatedAt)[0];
    const projectId = props.activeProjectId ?? newest?.thread.projectId;
    navigate.toCompose({ ...(projectId ? { projectId } : {}),
      placement: { sectionId: group.section?.id ?? null, pinned: false }, focusPrompt: true });
    onNavigate();
  };
  const onMarkAllRead = (group: Group) => {
    const ids: string[] = [];
    group.roots.forEach((root) => visit(root, (node) => { if (node.thread.isUnread) ids.push(node.thread.id); }));
    void Promise.all(ids.map((threadId) => sdk.threads.markRead({ threadId })))
      .catch((cause: unknown) => toast.error(message(cause)));
  };
  const onDelete = (group: Group) => {
    if (!group.section) return;
    const id = group.section.id;
    void sdk.threadSections.delete({ id }).then(() => {
      setSectionOrder(layout.sectionOrder.filter((sectionId) => sectionId !== id));
      setSectionHue(id, null);
      layoutApi.setOrder(`section:${id}`, []);
      setSectionSort(`section:${id}`, "manual");
      announce(`Deleted section ${group.section!.name}`);
    }).catch((cause: unknown) => toast.error(message(cause)));
  };
  const onNewSection = useCallback(() => {
    void sdk.threadSections.create({ name: "New section" })
      .then((section) => setPendingSectionId(section.id)).catch((cause: unknown) => toast.error(message(cause)));
  }, [sdk]);
  const commandRows = useMemo(() => {
    if (settings.view === "status") return lanes.flatMap((lane) => lane.rows.map((row) =>
      ({ id: row.thread.id, state: row.state, matches: true })));
    const result: { id: string; state: TreeNode["state"]; matches: boolean }[] = [];
    visible.forEach((group) => group.roots.forEach((root) => visit(root, (node) => {
      result.push({ id: node.thread.id, state: node.state, matches: node.matches });
    })));
    return result;
  }, [settings.view, lanes, visible]);
  const nextNeedsYou = useCallback(() => {
    if (!commandRows.some((row) => row.matches && (row.state === "failed" || row.state === "needs"))) {
      toast("Nothing needs you right now");
      return;
    }
    const start = commandRows.findIndex((row) => row.id === props.activeThreadId);
    for (let offset = 1; offset <= commandRows.length; offset++) {
      const row = commandRows[(start + offset) % commandRows.length]!;
      if (row.matches && (row.state === "failed" || row.state === "needs")) {
        navigate.toThread(row.id);
        onNavigate();
        break;
      }
    }
  }, [commandRows, props.activeThreadId, navigate, onNavigate]);
  useEffect(() => registerListHandlers({
    focusFilter: () => inputRef.current?.focus(), nextNeedsYou,
    toggleView: () => updateSettings({ view: settings.view === "sections" ? "status" : "sections" }),
    newSection: onNewSection,
  }), [nextNeedsYou, updateSettings, settings.view, onNewSection]);
  useEffect(() => { if (settings.view === "status") setSelection(EMPTY_SELECTION); }, [settings.view]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && selection.ids.size) { setSelection(EMPTY_SELECTION); return; }
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey ||
        (event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable]"))) return;
    event.preventDefault();
    inputRef.current?.focus();
  };
  const current = drag.view;
  const target = current?.target;
  const blocked = current?.plan?.ok === false;
  const spacing = {
    "--sb-row-h": `${metrics.rowH}px`, "--sb-indent": `${metrics.indent}px`,
    "--sb-gap": `${metrics.gap}px`, "--sb-header-h": `${metrics.headerH}px`,
    "--sb-section-gap": `${metrics.sectionGap}px`, "--sb-control-h": `${metrics.controlH}px`,
    "--sb-base": `${metrics.base}px`, "--sb-pill-l": `${metrics.pillLeft}px`,
    "--sb-pill-r": `${metrics.pillRight}px`,
  } as CSSProperties;
  const dragActive = useRef(false);
  dragActive.current = current !== null;
  const isSuppressed = useCallback(() => dragActive.current, []);
  return <InfoCardProvider mode={props.isCompactViewport ? "off" : settings.infoCard} sdk={sdk} isSuppressed={isSuppressed}>
  <nav ref={rootRef} aria-label="Threads" onKeyDown={onKeyDown} style={spacing}
    className={`sb-list sb-density-${settings.density} relative min-w-0 pb-3 text-[13px] text-sidebar-foreground`}>
    <FilterBar filter={filter} counts={sidebar.status === "ready" ? counts : EMPTY_COUNTS}
      showChips={sidebar.status === "ready" && settings.statusChips} inputRef={inputRef}
      settings={settings} onSettingsChange={updateSettings}
      onChange={(next) => { setFilter(next); setSelection(EMPTY_SELECTION); }} />
    {settings.view === "sections" && selection.ids.size > 0 && <BulkBar count={selection.ids.size} childCount={childCount} groups={groups}
      canSnooze={roots.length > 0 && roots.every(canSnoozeId)} onSnooze={onBulkSnooze}
      onMove={onBulkMove} onArchive={() => { void onBulkArchive(); }} onClear={() => setSelection(EMPTY_SELECTION)} />}
    {sidebar.status === "error" && <p className="px-3 py-3 text-muted-foreground">Could not load threads</p>}
    {sidebar.status === "ready" && settings.view === "sections" && current?.subject.kind === "threads" && !groups.some((group) => group.kind === "pinned") &&
      <div data-sb-drop="pinned"
        className="sb-group sb-pinned-drop absolute top-0 z-20 border border-primary bg-popover uppercase text-popover-foreground shadow-lg">Pinned</div>}
    {sidebar.status === "ready" && settings.view === "status" && <LanesView lanes={lanes} collapsed={collapsed}
      activeThreadId={props.activeThreadId} settings={settings} now={now} projectName={names.project}
      onToggle={onToggle} onNavigate={onNavigate} onSnooze={onSnoozeId} canSnooze={canSnoozeId} />}
    {sidebar.status === "ready" && settings.view === "sections" && settings.needsYouShelf && urgent.length > 0 &&
      <section className="sb-needs-shelf">
        <div className="sb-group-header relative flex min-w-0 items-center text-muted-foreground">
          <button type="button" aria-expanded={needsOpen} onClick={() => setNeedsOpen(!needsOpen)}
            className="sb-header-main flex h-full min-w-0 flex-1 items-center text-left">
            <span aria-hidden className="sb-header-caret shrink-0 text-center text-2xs text-subtle-foreground">{needsOpen ? "▾" : "▸"}</span>
            <span className="sb-header-name text-[11px] font-semibold uppercase tracking-[.06em]">Needs you</span>
            <span className="font-mono text-[11px] text-subtle-foreground">{String(urgent.length).padStart(2, "0")}</span>
          </button>
        </div>
        {needsOpen && <div className="sb-group-body relative">{urgent.map((entry) => <ThreadRow key={entry.thread.id}
          variant="mirror" row={{ thread: entry.thread, state: entry.state, depth: 0, guides: "", isLast: true,
            childCount: 0, collapsed: false, rollup: null, rollupCount: 0, crossProject: null, dim: false }}
          isActive={entry.thread.id === props.activeThreadId} settings={settings} now={now}
          projectName={names.project(entry.thread.projectId)} hue={entry.hue} onNavigate={onNavigate} />)}</div>}
      </section>}
    {sidebar.status === "ready" && settings.view === "sections" && rows.map(({ group, items, isCollapsed }) => <section key={group.key}
      className={group.hue ? `sb-hue-${group.hue}` : undefined}>
      <GroupHeader group={group} collapsed={isCollapsed} sectionColour={settings.sectionColour}
        onToggle={onToggle} drag={drag} renaming={renamingId === group.section?.id && group.kind === "section"}
        dropState={target && ((target.kind === "group" && target.key === group.key) ||
          (target.kind === "section" && target.sectionId === group.section?.id)) ? blocked ? "blocked" : "ok" : null}
        hueOverride={group.section ? layout.sectionHues[group.section.id] ?? null : null}
        sortMode={layout.sectionSort[group.key] ?? "manual"} staleDays={settings.staleDays}
        onSort={(mode: SortMode) => setSectionSort(group.key as "loose" | `section:${string}`, mode)}
        onArchiveStale={() => { void onArchiveStale(group); }}
        onRename={() => setRenamingId(group.section?.id ?? null)}
        onRenameSubmit={(name) => {
          if (!group.section) return;
          void sdk.threadSections.update({ id: group.section.id, name })
            .then(() => setRenamingId(null)).catch((cause: unknown) => toast.error(message(cause)));
        }}
        onRenameCancel={() => setRenamingId(null)}
        onSetHue={(hue) => { if (group.section) setSectionHue(group.section.id, hue); }}
        onNewThread={() => onNewThread(group)} onMarkAllRead={() => onMarkAllRead(group)}
        onDelete={() => onDelete(group)} onSectionMove={(direction) => {
          const id = group.section?.id;
          if (!id) return;
          const position = sectionIds.indexOf(id);
          const other = position + (direction === "up" ? -1 : 1);
          if (other < 0 || other >= sectionIds.length) return;
          const next = [...sectionIds];
          [next[position], next[other]] = [next[other]!, next[position]!];
          onSectionMove(next);
        }} />
      {!isCollapsed && <div className={`sb-group-body relative ${group.hue && settings.sectionColour !== "swatch" ? "sb-rail" : ""}`}>
        {items.map((row) => <ThreadRow key={row.thread.id} row={row}
          isActive={row.thread.id === props.activeThreadId} settings={settings} now={now}
          projectName={names.project(row.thread.projectId)} drag={drag}
          isSelected={selection.ids.has(row.thread.id)} selectedRun={runs.get(row.thread.id)}
          isDragging={current?.subject.kind === "threads" && current.subject.ids.includes(row.thread.id)}
          dropState={target?.kind === "row" && target.threadId === row.thread.id ?
            blocked ? "blocked" : target.instruction.kind === "child" ? "child" : null : null}
          flash={flashIds.has(row.thread.id)} onSelect={onSelect} onKeyboardMove={onKeyboardMove}
          stale={index.byId.get(row.thread.id)?.node.stale}
          onSnooze={canSnoozeId(row.thread.id) ? () => onSnoozeId(row.thread.id) : undefined}
          onNavigate={onNavigate} onToggle={onToggle} />)}
      </div>}
    </section>)}
    {sidebar.status === "ready" && snoozed.length > 0 && <section className="sb-snoozed-shelf">
      <div className="sb-group-header relative flex min-w-0 items-center text-muted-foreground">
        <button type="button" aria-expanded={snoozedOpen} onClick={() => setSnoozedOpen(!snoozedOpen)}
          className="sb-header-main flex h-full min-w-0 flex-1 items-center text-left">
          <span aria-hidden className="sb-header-caret shrink-0 text-center text-2xs text-subtle-foreground">{snoozedOpen ? "▾" : "▸"}</span>
          <span className="sb-header-name text-[11px] font-semibold uppercase tracking-[.06em]">Snoozed · {snoozed.length}</span>
        </button>
      </div>
      {snoozedOpen && <div className="sb-group-body relative">{snoozed.map((node) => <ThreadRow key={node.thread.id}
        variant="snoozed" row={{ thread: node.thread, state: node.state, depth: 0, guides: "", isLast: true,
          childCount: 0, collapsed: false, rollup: null, rollupCount: 0, crossProject: null, dim: false }}
        isActive={node.thread.id === props.activeThreadId} settings={settings} now={now}
        projectName={names.project(node.thread.projectId)} onNavigate={onNavigate}
        wakeLabel={wakeLabel(layout.snoozes[node.thread.id]!.until, now)} onWake={() => unsnooze([node.thread.id])} />)}</div>}
    </section>}
    {sidebar.status === "ready" && settings.showArchived && filter.states.size === 0 && (archived.length > 0 || !filter.query.trim()) &&
      <section className="sb-archived-shelf" aria-label="Archived threads">
        <div className="sb-group-header relative flex min-w-0 items-center text-muted-foreground">
          <div className="sb-header-main flex h-full min-w-0 flex-1 items-center">
            <span aria-hidden className="sb-header-caret shrink-0" />
            <span className="sb-header-name text-[11px] font-semibold uppercase tracking-[.06em]">Archived</span>
            <span className="font-mono text-[11px] text-subtle-foreground">{String(archived.length).padStart(2, "0")}{archivedPage?.hasNextPage ? "+" : ""}</span>
          </div>
        </div>
        <div className="sb-group-body relative">
          {archived.map((thread) => <ThreadRow key={thread.id} variant="archived"
            row={{ thread, state: rowState(thread), depth: 0, guides: "", isLast: true, childCount: 0, collapsed: false,
              rollup: null, rollupCount: 0, crossProject: null, dim: false }}
            isActive={thread.id === props.activeThreadId} settings={settings} now={now}
            projectName={names.project(thread.projectId)} onNavigate={onNavigate} />)}
          {archivedPage?.status === "loading" && <p className="sb-shelf-note text-[11px] text-subtle-foreground">Loading archived threads…</p>}
          {archivedPage?.status === "error" && <p className="sb-shelf-note text-[11px] text-subtle-foreground">Could not load archived threads</p>}
          {archivedPage?.status === "ready" && archived.length === 0 && !archivedPage.hasNextPage &&
            <p className="sb-shelf-note text-[11px] text-subtle-foreground">No archived threads</p>}
          {archivedPage?.hasNextPage && <button type="button" aria-label="Show more archived threads"
            disabled={archivedPage.isFetchingNextPage} className="sb-control sb-text-button sb-shelf-more text-[11px] text-muted-foreground"
            onClick={() => { void archivedPage.fetchNextPage().catch(() => toast.error("Switchboard could not load more archived threads")); }}>
            {archivedPage.isFetchingNextPage ? "Loading…" : "Show more"}</button>}
        </div>
      </section>}
    {sidebar.status === "ready" && settings.view === "sections" && <button type="button" className="sb-control sb-new-section flex items-center text-muted-foreground"
      onClick={onNewSection}>+ New section</button>}
    {settings.view === "sections" && <><DropIndicator view={current} />
      <DragGhost view={current} ghostRef={drag.ghostRef}
        titleOf={(id) => index.byId.get(id)?.node.thread.displayTitle ?? sections.get(id) ?? id}
        stateOf={(id) => index.byId.get(id)?.node.state ?? "idle"} /></>}
    <span className="sr-only" aria-live="polite">{announcement}</span>
  </nav></InfoCardProvider>;
}
