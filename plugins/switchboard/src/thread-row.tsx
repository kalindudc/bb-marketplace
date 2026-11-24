import { memo, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { DragController } from "./use-drag";
import type { PluginSidebarThread, PluginThreadActionTarget, PluginThreadActionsInlineItem } from "@get-bb/plugin-sdk/app";
import {
  ThreadTitle, experimental_Icon as Icon, experimental_THREAD_ACTION_GROUPS as ACTION_GROUPS, experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_ThreadActionsMenu as ThreadActionsMenu, experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_ThreadRowMetadata as ThreadRowMetadata, experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders, experimental_useSidebarThreadSplit,
  experimental_useThreadActions, useBbNavigate, useSidebarThreadDraft,
  useSidebarThreadRowStatus, useSidebarThreadShortcut,
} from "@get-bb/plugin-sdk/app";
import { InfoCard, useInfoCardMode } from "./info-card";
import type { CollapseKey, HueId } from "./layout";
import type { RowModel } from "./rows";
import type { SelectionRun } from "./selection";
import type { SwitchboardSettings } from "./settings";
import { STATE_LABEL } from "./status";
import { StatusGlyph } from "./status-glyph";
import { ageLabel } from "./time";
import { lastActivity, nextWake, wakeLabel as formatWakeLabel } from "./triage";

export interface ThreadRowProps {
  row: RowModel;
  isActive: boolean;
  settings: SwitchboardSettings;
  now: number;
  projectName: string;
  onNavigate(): void;
  onToggle?(key: CollapseKey): void;
  drag?: Pick<DragController, "onRowPointerDown" | "consumeClick">;
  isSelected?: boolean;
  selectedRun?: SelectionRun;
  isDragging?: boolean;
  dropState?: "child" | "blocked" | null;
  flash?: boolean;
  onSelect?(id: string, mode: "toggle" | "range"): void;
  onKeyboardMove?(id: string, direction: "up" | "down" | "right" | "left"): void;
  variant?: "tree" | "lane" | "mirror" | "snoozed" | "archived";
  parentTitle?: string | null;
  hue?: HueId | null;
  stale?: boolean;
  wakeLabel?: string;
  splitLocation?: string;
  onInspect?(id: string, trigger: HTMLButtonElement): void;
  onSnooze?(id: string): void;
  onWake?(): void;
  bulk?: RowBulk;
}

/** bb's menu for a multi-row selection, given only to the selected rows. */
export interface RowBulk {
  threads: readonly PluginThreadActionTarget[];
  inline: readonly PluginThreadActionsInlineItem[];
  onEscape(): void;
}

const QUICK_ACTIONS = ["bb--core/archive"];

export function toActionTarget(thread: PluginSidebarThread): PluginThreadActionTarget {
  const { id, projectId, parentThreadId, parentNotifications, archivedAt, pinnedAt, sectionId, isUnread, status, environment } = thread;
  return { id, projectId, parentThreadId, parentNotifications, archivedAt, pinnedAt, sectionId, isUnread, status,
    environment: environment?.id ? { id: environment.id, path: environment.path } : null };
}

interface ProviderMarkProps {
  providerId: string;
  onPointerDown(event: PointerEvent<HTMLElement>): void;
  onClick(event: MouseEvent<HTMLElement>): void;
}

function ProviderMark({ providerId, onPointerDown, onClick }: ProviderMarkProps) {
  const { providers } = experimental_useProviders();
  const provider = providers.find((entry) => entry.id === providerId);
  const label = provider?.displayName ?? providerId;
  return <span role="img" aria-label={label} title={label} onPointerDown={onPointerDown} onClick={onClick}
    className="switchboard-provider pointer-events-auto relative z-1 grid shrink-0 cursor-pointer place-items-center text-subtle-foreground">
    <ProviderIcon providerKind="agent" provider={provider ?? { id: providerId }} className="size-3" aria-hidden />
  </span>;
}

function ThreadRowView({ row, isActive, settings, now, projectName, onNavigate, onToggle,
  drag, isSelected, selectedRun, isDragging, dropState, flash, onSelect, onKeyboardMove,
  variant = "tree", parentTitle, hue, stale, wakeLabel, splitLocation, onInspect, onSnooze, onWake, bulk }: ThreadRowProps) {
  const { thread, state, depth, guides, isLast, childCount, collapsed, rollup, rollupCount } = row;
  const [menuOpen, setMenuOpen] = useState(false);
  const split = experimental_useSidebarThreadSplit(thread.id);
  const navigate = useBbNavigate();
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  const draft = useSidebarThreadDraft(thread.id);
  const shortcut = useSidebarThreadShortcut(thread.id);
  const infoCardMode = useInfoCardMode();
  const target = toActionTarget(thread);
  const quickActions = experimental_useThreadActions(target, { keys: QUICK_ACTIONS });
  const snoozeUntil = onSnooze && formatWakeLabel(nextWake(now, settings.snoozeHour), now);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const onLinkPointerDown = (event: PointerEvent<HTMLElement>) => {
    split.splitProps.onPointerDown?.(event);
    if (variant === "tree") drag?.onRowPointerDown(event, thread.id);
  };
  // A metadata item or provider icon draws above the row link, so a click on it would otherwise not open the thread.
  const forwardClick = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    const { altKey, ctrlKey, metaKey, shiftKey, button } = event;
    linkRef.current?.dispatchEvent(new window.MouseEvent("click",
      { bubbles: true, cancelable: true, altKey, ctrlKey, metaKey, shiftKey, button }));
  };
  const metadata = !thread.parentThreadId && settings.showPullRequests &&
    <span className="switchboard-row-meta relative z-1" onPointerDown={onLinkPointerDown} onClick={forwardClick}>
      <ThreadRowMetadata thread={thread} /></span>;
  const inline = useMemo<PluginThreadActionsInlineItem[] | undefined>(() => onSnooze && [{
    key: "switchboard/snooze", group: ACTION_GROUPS.state,
    action: { label: `Snooze until ${snoozeUntil}`, icon: "Clock", run: () => onSnooze(thread.id) },
  }], [onSnooze, snoozeUntil, thread.id]);
  const hostGlyph = ((state === "idle" || state === "unread") && rowStatus) || (state === "idle" && draft.hasUnsubmittedDraft);
  const label = thread.indicatorLabel ?? STATE_LABEL[state];
  const emphasis = variant === "archived" ? "text-muted-foreground" :
    `${state === "failed" || state === "needs" || state === "unread" ? "font-semibold" : ""} ${state === "idle" ? "text-muted-foreground" : ""}`;
  const title = <>
    {settings.showProviderIcons && <ProviderMark providerId={thread.providerId} onPointerDown={onLinkPointerDown} onClick={forwardClick} />}
    <span className={`switchboard-thread-title relative z-1 min-w-24 flex-1 truncate ${emphasis}`}>
      <ThreadTitle threadId={thread.id} />
    </span>
  </>;
  const branch = settings.showBranch && thread.environment?.branchName;
  const age = variant !== "snoozed" && (settings.showAge || (shortcut && variant === "tree")) && <span className={`${shortcut && variant === "tree" ? "switchboard-shortcut" : "switchboard-age"} switchboard-meta relative z-1 shrink-0 font-mono tabular-nums text-subtle-foreground`}>
    {shortcut && variant === "tree" ? shortcut.label : ageLabel(now, variant === "archived" ? thread.archivedAt ?? lastActivity(thread) : lastActivity(thread))}
  </span>;
  const count = childCount > 0 && <span className="switchboard-child-count switchboard-meta relative z-1 inline-flex shrink-0 items-center gap-0.5 font-mono text-subtle-foreground" aria-label={`${childCount} child threads`}>
    {rollup ? <StatusGlyph state={rollup} label={STATE_LABEL[rollup]} /> : "↳"}{rollup ? rollupCount : childCount}
  </span>;
  const tags = <>
    {row.crossProject && <span className="switchboard-meta relative z-1 min-w-0 max-w-20 shrink truncate font-mono text-subtle-foreground" title={row.crossProject}>{row.crossProject}</span>}
    {settings.density !== "two-line" && branch && <span className="switchboard-meta relative z-1 min-w-0 max-w-20 shrink truncate font-mono text-subtle-foreground" title={branch}>{branch}</span>}
    {settings.density !== "two-line" && count}
    {metadata}
  </>;
  const withQuickActions = variant === "tree" || variant === "archived";
  const withMenu = withQuickActions || variant === "lane";
  const actions = withQuickActions && <span className="switchboard-quick-actions relative z-10 shrink-0 items-center gap-0.5">
    {quickActions.map(({ key, action }) => <button key={key} type="button" aria-label={action.label}
      disabled={action.disabled} className="switchboard-control switchboard-icon-button text-muted-foreground"
      onClick={() => { void action.run(); }}><Icon name={action.icon} className="size-3.5" aria-hidden /></button>)}
  </span>;
  return <ThreadActionsContextMenu thread={target} inline={bulk ? bulk.inline : inline} dragging={isDragging}
    experimental_bulkThreads={bulk?.threads} onEscapeKeyDown={bulk?.onEscape}>
    <div data-switchboard-row="" data-thread-id={thread.id} data-depth={depth} data-last-child={isLast}
      data-open-children={childCount > 0 && !collapsed} data-collapsed={collapsed}
      data-active={isActive} data-selected={isSelected} data-run={selectedRun}
      data-dragging={isDragging} data-drop={dropState ?? undefined} data-menu-open={menuOpen || undefined}
      className={`switchboard-row relative flex min-w-0 overflow-hidden text-sidebar-foreground ${stale ? "switchboard-stale" : ""} ${row.dim ? "opacity-60" : ""} ${flash ? "switchboard-flash" : ""}`}
      title={stale && infoCardMode === "off" ? `Idle for ${Math.floor((now - lastActivity(thread)) / 86_400_000)} days` : undefined}
      style={{ paddingLeft: `calc(var(--switchboard-base) + ${variant === "tree" ? depth : 0} * var(--switchboard-indent))` }}>
      {variant === "tree" && settings.treeGuides && depth > 0 && <>
        {[...guides].map((line, index) => line === "|" &&
          <span key={index} aria-hidden className="switchboard-guide pointer-events-none absolute top-0 bottom-0 w-px"
            style={{ left: `calc(var(--switchboard-base) + ${index} * var(--switchboard-indent) + 7px)` }} />)}
        {childCount > 0 ? <>
          <span aria-hidden className="switchboard-guide switchboard-guide-nested-top pointer-events-none absolute w-px"
            style={{ left: `calc(var(--switchboard-base) + ${depth - 1} * var(--switchboard-indent) + 7px)` }} />
          {!isLast && <span aria-hidden className="switchboard-guide switchboard-guide-nested-bottom pointer-events-none absolute w-px"
            style={{ left: `calc(var(--switchboard-base) + ${depth - 1} * var(--switchboard-indent) + 7px)` }} />}
        </> : <span aria-hidden className="switchboard-elbow pointer-events-none absolute top-0 rounded-bl border-b border-l"
          style={{ left: `calc(var(--switchboard-base) + ${depth - 1} * var(--switchboard-indent) + 7px)` }} />}
      </>}
      {variant === "tree" && childCount > 0 && <button type="button" aria-label={`${collapsed ? "Expand" : "Collapse"} ${thread.displayTitle}`}
        aria-expanded={!collapsed} onClick={() => onToggle?.(`thread:${thread.id}`)}
        className="switchboard-caret absolute z-10 grid place-items-center text-2xs text-subtle-foreground hover:text-sidebar-foreground"
        style={{ left: `calc(var(--switchboard-base) + ${depth} * var(--switchboard-indent) - 16px)` }}>{collapsed ? "▸" : "▾"}</button>}
      <InfoCard thread={thread} state={state} projectName={projectName} stale={stale === true} now={now}>
      <a ref={linkRef} href={thread.href} data-sidebar-thread-shortcut-target={variant === "tree" || variant === "lane" ? "" : undefined}
        data-sidebar-thread-id={variant === "tree" || variant === "lane" ? thread.id : undefined}
        aria-label={splitLocation ? `${thread.displayTitle}, ${splitLocation}` : thread.displayTitle} aria-current={isActive ? "page" : undefined}
        aria-keyshortcuts={variant === "tree" ? shortcut?.ariaKeyshortcuts : undefined}
        className="switchboard-row-link absolute inset-0 z-0" draggable={false} {...split.splitProps}
        onPointerDown={onLinkPointerDown}
        onClick={(event) => {
          if (variant === "tree" && drag?.consumeClick()) { event.preventDefault(); event.stopPropagation(); return; }
          if (variant === "tree" && (event.altKey || event.shiftKey)) {
            event.preventDefault(); event.stopPropagation();
            onSelect?.(thread.id, event.altKey ? "toggle" : "range");
            return;
          }
          if (event.metaKey || event.ctrlKey) {
            if (split.isAvailable) { event.preventDefault(); navigate.toThread(thread.id, { split: true }); }
            return;
          }
          onNavigate();
        }}
        onKeyDown={(event) => {
          if (variant !== "tree" || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          const direction = { ArrowUp: "up", ArrowDown: "down", ArrowRight: "right", ArrowLeft: "left" } as const;
          const move = direction[event.key as keyof typeof direction];
          if (move) { event.preventDefault(); event.stopPropagation(); onKeyboardMove?.(thread.id, move); }
        }} /></InfoCard>
      {hue && <span aria-hidden className={`switchboard-hue-${hue} relative z-1 size-2 shrink-0 rounded-sm`} style={{ background: "var(--switchboard-hue)" }} />}
      {variant === "lane" && parentTitle && <span aria-hidden className="relative z-1 shrink-0 text-subtle-foreground">↳</span>}
      <span className="switchboard-leading-glyph pointer-events-none relative z-1 grid shrink-0 place-items-center">
        {variant === "archived" ? <span role="img" aria-label="Archived" className="inline-grid size-[14px] place-items-center text-subtle-foreground">
          <Icon name="Archive" className="size-3.5" aria-hidden /></span>
        : hostGlyph ? <ThreadStatusGlyph size="compact" indicator={rowStatus ? thread.indicator : "draft"} rowStatus={rowStatus} />
          : <StatusGlyph state={state} label={label} spin={state === "running"} />}
      </span>
      {settings.density === "two-line" ? <span className="switchboard-two-line-stack pointer-events-none relative z-1 flex min-w-0 flex-1 flex-col">
        <span className="switchboard-two-line-title switchboard-row-line flex min-w-0 items-center">{title}{metadata}{age}</span>
        <span className="switchboard-two-line-meta switchboard-row-line flex min-w-0 items-center truncate font-mono text-subtle-foreground">
          {variant === "lane" && parentTitle ? <span className="truncate" title={parentTitle}>{parentTitle}</span> :
            <span className="truncate">{projectName}</span>}{branch && <span className="truncate">{branch}</span>}
          {variant === "tree" && count}
        </span>
      </span> : <span className="switchboard-row-line pointer-events-none relative z-1 flex min-w-0 flex-1 items-center">
        {title}{variant === "tree" && tags}{age}
      </span>}
      {variant === "snoozed" && <span className="switchboard-meta relative z-1 shrink-0 font-mono text-subtle-foreground">{wakeLabel}</span>}
      {variant === "snoozed" && <button type="button" className="switchboard-control switchboard-text-button relative z-10 shrink-0 text-[11px] text-muted-foreground"
        onClick={onWake}>Wake</button>}
      {splitLocation && <span aria-hidden className="switchboard-split-mark relative z-1 shrink-0">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M2.5 3h11v10h-11zM8 3v10" />
        </svg>
      </span>}
      {infoCardMode !== "off" && onInspect && <button type="button" aria-label={`Info for ${thread.displayTitle}`}
        aria-haspopup="dialog" className="switchboard-info-trigger switchboard-control switchboard-icon-button relative z-10 shrink-0 text-muted-foreground"
        onClick={(event) => onInspect(thread.id, event.currentTarget)}>
        <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <circle cx="8" cy="8" r="6" /><path strokeLinecap="round" d="M8 7.5v3.5m0-6h.01" />
        </svg>
      </button>}
      {actions}
      {withMenu && <ThreadActionsMenu thread={target} inline={inline} side="right" align="start" onOpenChange={setMenuOpen}
        trigger={(triggerProps) => <button {...triggerProps} type="button" aria-label="Thread actions"
          className={`${triggerProps.className ?? ""} switchboard-control switchboard-menu-trigger switchboard-icon-button relative z-10 shrink-0 place-items-center text-muted-foreground`}>⋯</button>} />}
    </div>
  </ThreadActionsContextMenu>;
}

export const ThreadRow = memo(ThreadRowView, (left, right) =>
  left.row.thread === right.row.thread && left.row.state === right.row.state &&
  left.row.depth === right.row.depth && left.row.guides === right.row.guides &&
  left.row.isLast === right.row.isLast && left.row.childCount === right.row.childCount &&
  left.row.collapsed === right.row.collapsed && left.row.rollup === right.row.rollup &&
  left.row.rollupCount === right.row.rollupCount && left.row.crossProject === right.row.crossProject &&
  left.row.dim === right.row.dim && left.isActive === right.isActive &&
  left.settings === right.settings && left.now === right.now && left.projectName === right.projectName &&
  left.onNavigate === right.onNavigate && left.onToggle === right.onToggle &&
  left.drag?.onRowPointerDown === right.drag?.onRowPointerDown &&
  left.drag?.consumeClick === right.drag?.consumeClick &&
  left.isSelected === right.isSelected && left.selectedRun === right.selectedRun && left.isDragging === right.isDragging &&
  left.dropState === right.dropState && left.flash === right.flash &&
  left.onSelect === right.onSelect && left.onKeyboardMove === right.onKeyboardMove &&
  left.variant === right.variant && left.parentTitle === right.parentTitle && left.hue === right.hue &&
  left.stale === right.stale && left.wakeLabel === right.wakeLabel &&
  left.splitLocation === right.splitLocation && left.onInspect === right.onInspect &&
  left.onSnooze === right.onSnooze && left.onWake === right.onWake && left.bulk === right.bulk);
