import { memo } from "react";
import type { DragController } from "./use-drag";
import type { PluginSidebarThread, PluginThreadActionTarget } from "@get-bb/plugin-sdk/app";
import {
  ThreadTitle, experimental_Icon as Icon, experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_ThreadActionsMenu as ThreadActionsMenu, experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_useSidebarThreadPullRequest, experimental_useSidebarThreadSplit,
  experimental_useThreadActions, useBbNavigate, useSidebarThreadDraft,
  useSidebarThreadRowStatus, useSidebarThreadShortcut,
} from "@get-bb/plugin-sdk/app";
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
  onSnooze?(): void;
  onWake?(): void;
}

const ROW_ACTIONS = ["bb--core/pin", "bb--core/archive"];
const ARCHIVED_ACTIONS = ["bb--core/archive"];

export function toActionTarget(thread: PluginSidebarThread): PluginThreadActionTarget {
  const { id, projectId, parentThreadId, archivedAt, pinnedAt, sectionId, isUnread, status, environment } = thread;
  return { id, projectId, parentThreadId, archivedAt, pinnedAt, sectionId, isUnread, status,
    environment: environment?.id ? { id: environment.id, path: environment.path } : null };
}

function PullRequestTag({ threadId }: { threadId: string }) {
  const { pullRequest } = experimental_useSidebarThreadPullRequest(threadId);
  return pullRequest && <span className="sb-pr-badge relative z-1 min-w-0 max-w-16 shrink truncate border border-sidebar-border font-mono text-muted-foreground">#{pullRequest.number}</span>;
}

function ThreadRowView({ row, isActive, settings, now, projectName, onNavigate, onToggle,
  drag, isSelected, selectedRun, isDragging, dropState, flash, onSelect, onKeyboardMove,
  variant = "tree", parentTitle, hue, stale, wakeLabel, onSnooze, onWake }: ThreadRowProps) {
  const { thread, state, depth, guides, isLast, childCount, collapsed, rollup, rollupCount } = row;
  const split = experimental_useSidebarThreadSplit(thread.id);
  const navigate = useBbNavigate();
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  const draft = useSidebarThreadDraft(thread.id);
  const shortcut = useSidebarThreadShortcut(thread.id);
  const target = toActionTarget(thread);
  const quickActions = experimental_useThreadActions(target, { keys: variant === "archived" ? ARCHIVED_ACTIONS : ROW_ACTIONS });
  const hostGlyph = ((state === "idle" || state === "unread") && rowStatus) || (state === "idle" && draft.hasUnsubmittedDraft);
  const label = thread.indicatorLabel ?? STATE_LABEL[state];
  const emphasis = variant === "archived" ? "text-muted-foreground" :
    `${state === "failed" || state === "needs" || state === "unread" ? "font-semibold" : ""} ${state === "idle" ? "text-muted-foreground" : ""}`;
  const title = <span className={`relative z-1 min-w-24 flex-1 truncate ${emphasis}`}>
    <ThreadTitle threadId={thread.id} />
  </span>;
  const branch = settings.showBranch && thread.environment?.branchName;
  const age = variant !== "snoozed" && (settings.showAge || (shortcut && variant === "tree")) && <span className={`${shortcut && variant === "tree" ? "sb-shortcut" : "sb-age"} sb-meta relative z-1 shrink-0 font-mono tabular-nums text-subtle-foreground`}>
    {shortcut && variant === "tree" ? shortcut.label : ageLabel(now, variant === "archived" ? thread.archivedAt ?? lastActivity(thread) : lastActivity(thread))}
  </span>;
  const count = childCount > 0 && <span className="sb-meta relative z-1 inline-flex shrink-0 items-center gap-0.5 font-mono text-subtle-foreground" aria-label={`${childCount} child threads`}>
    {rollup ? <StatusGlyph state={rollup} label={STATE_LABEL[rollup]} /> : "↳"}{rollup ? rollupCount : childCount}
  </span>;
  const tags = <>
    {row.crossProject && <span className="sb-meta relative z-1 min-w-0 max-w-20 shrink truncate font-mono text-subtle-foreground" title={row.crossProject}>{row.crossProject}</span>}
    {settings.density !== "two-line" && branch && <span className="sb-meta relative z-1 min-w-0 max-w-20 shrink truncate font-mono text-subtle-foreground" title={branch}>{branch}</span>}
    {settings.density !== "two-line" && count}
    {!thread.parentThreadId && settings.showPullRequests && <PullRequestTag threadId={thread.id} />}
  </>;
  const withThreadActions = variant === "tree" || variant === "archived";
  const actions = (withThreadActions || variant === "lane") && <span className="sb-quick-actions relative z-10 shrink-0 items-center gap-0.5">
    {onSnooze && <button type="button" aria-label={`Snooze until ${formatWakeLabel(nextWake(now, settings.snoozeHour), now)}`}
      className="sb-control sb-icon-button grid place-items-center text-muted-foreground" onClick={onSnooze}>
      <Icon name="Clock" aria-hidden /></button>}
    {withThreadActions && quickActions.map(({ key, action }) => <button key={key} type="button" aria-label={action.label}
      disabled={action.disabled} className="sb-control sb-icon-button text-muted-foreground"
      onClick={() => { void action.run(); }}><Icon name={action.icon} className="size-3.5" aria-hidden /></button>)}
  </span>;
  return <ThreadActionsContextMenu thread={target} dragging={isDragging}>
    <div data-sb-row="" data-thread-id={thread.id} data-depth={depth} data-last-child={isLast}
      data-open-children={childCount > 0 && !collapsed} data-collapsed={collapsed}
      data-active={isActive} data-selected={isSelected} data-run={selectedRun}
      data-dragging={isDragging} data-drop={dropState ?? undefined}
      className={`sb-row relative flex min-w-0 overflow-hidden text-sidebar-foreground ${stale ? "sb-stale" : ""} ${row.dim ? "opacity-60" : ""} ${flash ? "sb-flash" : ""}`}
      title={stale ? `Idle for ${Math.floor((now - lastActivity(thread)) / 86_400_000)} days` : undefined}
      style={{ paddingLeft: `calc(var(--sb-base) + ${variant === "tree" ? depth : 0} * var(--sb-indent))` }}>
      {variant === "tree" && settings.treeGuides && depth > 0 && <>
        {[...guides].map((line, index) => line === "|" && !(childCount > 0 && index === depth - 1) &&
          <span key={index} aria-hidden className="sb-guide pointer-events-none absolute top-0 bottom-0 w-px"
            style={{ left: `calc(var(--sb-base) + ${index} * var(--sb-indent) + 7px)` }} />)}
        {childCount > 0 ? <>
          <span aria-hidden className="sb-guide sb-guide-nested-top pointer-events-none absolute w-px"
            style={{ left: `calc(var(--sb-base) + ${depth - 1} * var(--sb-indent) + 7px)` }} />
          {!isLast && <span aria-hidden className="sb-guide sb-guide-nested-bottom pointer-events-none absolute w-px"
            style={{ left: `calc(var(--sb-base) + ${depth - 1} * var(--sb-indent) + 7px)` }} />}
        </> : <>
          <span aria-hidden className="sb-elbow pointer-events-none absolute top-0 rounded-bl border-b border-l"
            style={{ left: `calc(var(--sb-base) + ${depth - 1} * var(--sb-indent) + 7px)` }} />
          {!isLast && <span aria-hidden className="sb-guide sb-guide-cont pointer-events-none absolute bottom-0 w-px"
            style={{ left: `calc(var(--sb-base) + ${depth - 1} * var(--sb-indent) + 7px)` }} />}
        </>}
      </>}
      {variant === "tree" && childCount > 0 && <button type="button" aria-label={`${collapsed ? "Expand" : "Collapse"} ${thread.displayTitle}`}
        aria-expanded={!collapsed} onClick={() => onToggle?.(`thread:${thread.id}`)}
        className="sb-caret absolute z-10 grid place-items-center text-2xs text-subtle-foreground hover:text-sidebar-foreground"
        style={{ left: `calc(var(--sb-base) + ${depth} * var(--sb-indent) - 16px)` }}>{collapsed ? "▸" : "▾"}</button>}
      <a href={thread.href} data-sidebar-thread-shortcut-target={variant === "tree" || variant === "lane" ? "" : undefined}
        data-sidebar-thread-id={variant === "tree" || variant === "lane" ? thread.id : undefined}
        aria-label={thread.displayTitle} aria-current={isActive ? "page" : undefined}
        aria-keyshortcuts={variant === "tree" ? shortcut?.ariaKeyshortcuts : undefined}
        className="sb-row-link absolute inset-0 z-0" draggable={false} {...split.splitProps}
        onPointerDown={(event) => {
          split.splitProps.onPointerDown?.(event);
          if (variant === "tree") drag?.onRowPointerDown(event, thread.id);
        }}
        onClick={(event) => {
          if (variant === "tree" && drag?.consumeClick()) { event.preventDefault(); event.stopPropagation(); return; }
          if (variant === "tree" && (event.altKey || event.shiftKey)) {
            event.preventDefault(); event.stopPropagation();
            onSelect?.(thread.id, event.altKey ? "toggle" : "range");
            return;
          }
          if ((event.metaKey || event.ctrlKey) && split.isAvailable) {
            event.preventDefault(); navigate.toThread(thread.id, { split: true });
          } else onNavigate();
        }}
        onKeyDown={(event) => {
          if (variant !== "tree" || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          const direction = { ArrowUp: "up", ArrowDown: "down", ArrowRight: "right", ArrowLeft: "left" } as const;
          const move = direction[event.key as keyof typeof direction];
          if (move) { event.preventDefault(); event.stopPropagation(); onKeyboardMove?.(thread.id, move); }
        }} />
      {hue && <span aria-hidden className={`sb-hue-${hue} relative z-1 size-2 shrink-0 rounded-[3px]`} style={{ background: "var(--sb-hue)" }} />}
      {variant === "lane" && parentTitle && <span aria-hidden className="relative z-1 shrink-0 text-subtle-foreground">↳</span>}
      <span className="sb-leading-glyph pointer-events-none relative z-1 shrink-0">
        {variant === "archived" ? <span role="img" aria-label="Archived" className="inline-grid size-[14px] place-items-center text-subtle-foreground">
          <Icon name="Archive" className="size-3.5" aria-hidden /></span>
        : hostGlyph ? <ThreadStatusGlyph size="compact" indicator={rowStatus ? thread.indicator : "draft"} rowStatus={rowStatus} />
          : <StatusGlyph state={state} label={label} spin={state === "running"} />}
      </span>
      {settings.density === "two-line" ? <span className="sb-two-line-stack pointer-events-none relative z-1 flex min-w-0 flex-1 flex-col">
        <span className="sb-two-line-title sb-row-line flex min-w-0 items-center">{title}{!thread.parentThreadId && settings.showPullRequests && <PullRequestTag threadId={thread.id} />}{age}</span>
        <span className="sb-two-line-meta sb-row-line flex min-w-0 items-center truncate font-mono text-subtle-foreground">
          {variant === "lane" && parentTitle ? <span className="truncate" title={parentTitle}>{parentTitle}</span> :
            <span className="truncate">{projectName}</span>}{branch && <span className="truncate">{branch}</span>}
          {variant === "tree" && count}
        </span>
      </span> : <span className="sb-row-line pointer-events-none relative z-1 flex min-w-0 flex-1 items-center">
        {title}{variant === "tree" && tags}{age}
      </span>}
      {variant === "snoozed" && <span className="sb-meta relative z-1 shrink-0 font-mono text-subtle-foreground">{wakeLabel}</span>}
      {variant === "snoozed" && <button type="button" className="sb-control sb-text-button relative z-10 shrink-0 text-[11px] text-muted-foreground"
        onClick={onWake}>Wake</button>}
      {actions}
      {withThreadActions && <ThreadActionsMenu thread={target} side="right" align="start"
        trigger={(triggerProps) => <button {...triggerProps} type="button" aria-label="Thread actions"
          className={`${triggerProps.className ?? ""} sb-control sb-menu-trigger sb-icon-button relative z-10 shrink-0 place-items-center text-muted-foreground`}>⋯</button>} />}
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
  left.onSnooze === right.onSnooze && left.onWake === right.onWake);
