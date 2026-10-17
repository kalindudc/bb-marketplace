import { memo } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { DragController } from "./use-drag";
import type { GroupKey, HueId, SortMode } from "./layout";
import type { SectionColour } from "./settings";
import { Hint } from "./hint";
import { SectionMenu, RenameInput } from "./section-menu";
import { STATE_LABEL, type RowState } from "./status";
import { StatusGlyph } from "./status-glyph";
import type { Group, TreeNode } from "./tree";

const SORT_LABEL = { recent: "Sorted by recent activity", status: "Sorted by status" } as const;
const unreadIn = (node: TreeNode): number =>
  Number(node.thread.isUnread) + node.children.reduce((total, child) => total + unreadIn(child), 0);
const descendants = (node: TreeNode): number =>
  node.children.reduce((total, child) => total + 1 + descendants(child), 0);

export interface GroupHeaderProps {
  group: Group;
  collapsed: boolean;
  sectionColour: SectionColour;
  onToggle(key: GroupKey): void;
  drag: Pick<DragController, "onSectionPointerDown" | "consumeClick">;
  renaming: boolean;
  dropState: "ok" | "blocked" | null;
  hueOverride: HueId | null;
  onRename(): void;
  onRenameSubmit(name: string): void;
  onRenameCancel(): void;
  onSetHue(hue: HueId | null): void;
  onNewThread(): void;
  onMarkAllRead(): void;
  onDelete(): void;
  onSectionMove(direction: "up" | "down"): void;
  sortMode?: SortMode;
  staleDays?: number;
  onSort?(mode: SortMode): void;
  onArchiveStale?(): void;
}

function GroupHeaderView({ group, collapsed, sectionColour, onToggle, drag, renaming, dropState,
  hueOverride, onRename, onRenameSubmit, onRenameCancel, onSetHue, onNewThread,
  onMarkAllRead, onDelete, onSectionMove, sortMode = "manual", staleDays = 3, onSort, onArchiveStale }: GroupHeaderProps) {
  const name = group.kind === "pinned" ? "Pinned" : group.kind === "loose" ? "Threads" : group.section?.name ?? "Section";
  const states: Exclude<RowState, "idle">[] = ["failed", "needs", "running", ...(collapsed ? ["unread" as const] : [])];
  return <>
    <div data-sb-drop={group.key} data-sb-section={group.section?.id} data-collapsed={collapsed}
      data-drop={dropState ?? undefined} className={`sb-group sb-group-header relative flex min-w-0 items-center text-muted-foreground ${group.hue ? `sb-hue-${group.hue}` : ""} ${group.hue && sectionColour !== "swatch" ? "sb-pill-hued" : ""} ${group.hue && sectionColour === "tint" ? "sb-tint" : ""}`}>
      {renaming && group.kind === "section" ?
        <RenameInput initial={name} onSubmit={onRenameSubmit} onCancel={onRenameCancel} /> :
        <button type="button" aria-expanded={!collapsed} onClick={(event) => {
          if (drag.consumeClick()) { event.preventDefault(); event.stopPropagation(); return; }
          onToggle(group.key);
        }}
          onPointerDown={(event) => { if (group.section) drag.onSectionPointerDown(event, group.section.id); }}
          onKeyDown={(event) => {
            if (group.kind !== "section" || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault(); event.stopPropagation();
              onSectionMove(event.key === "ArrowUp" ? "up" : "down");
            }
          }}
          className="sb-header-main flex h-full min-w-0 flex-1 items-center text-left">
          <span aria-hidden className="sb-header-caret shrink-0 text-center text-2xs text-subtle-foreground">{collapsed ? "▸" : "▾"}</span>
          {group.kind === "pinned" && <Icon name="Pin" className="size-3 shrink-0 text-subtle-foreground" aria-hidden />}
          {group.hue && <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ background: "var(--sb-hue)" }} />}
          <span className="sb-header-name min-w-0 truncate text-[11px] font-semibold uppercase tracking-[.06em]">{name}</span>
          {sortMode !== "manual" && <Hint label={`${SORT_LABEL[sortMode]}. Change it in Section actions.`}>
            <span role="img" aria-label={SORT_LABEL[sortMode]} className="inline-grid shrink-0 text-subtle-foreground">
              <Icon name="Sort" className="size-3" aria-hidden /></span></Hint>}
          <span className="shrink-0 font-mono text-[11px] font-normal tracking-normal text-subtle-foreground">{String(group.threadCount).padStart(2, "0")}</span>
        </button>}
      <div className="sb-section-slot relative z-10 ml-auto flex shrink-0 items-center">
        <span className="sb-section-rollups items-center gap-2">
          {states.map((state) => group.counts[state] > 0 && <span key={state}
            className="inline-flex items-center gap-0.5 font-mono text-[11px] text-subtle-foreground">
            <StatusGlyph state={state} label={STATE_LABEL[state]} />{group.counts[state]}
          </span>)}
        </span>
        <span className="sb-section-controls items-center gap-0.5">
          {group.kind !== "pinned" && <Hint label={`New thread in ${name}`}><button type="button" aria-label={`New thread in ${name}`}
            className="sb-control sb-icon-button shrink-0 text-muted-foreground"
            onClick={onNewThread}>+</button></Hint>}
          <SectionMenu group={group} unreadCount={group.roots.reduce((total, root) => total + unreadIn(root), 0)} hueOverride={hueOverride}
            sortMode={sortMode} staleDays={staleDays} onSort={onSort} onArchiveStale={onArchiveStale}
            staleCount={group.roots.filter((root) => root.stale).length}
            staleChildCount={group.roots.filter((root) => root.stale).reduce((total, root) => total + descendants(root), 0)}
            onRename={onRename} onSetHue={onSetHue} onNewThread={onNewThread}
            onMarkAllRead={onMarkAllRead} onDelete={onDelete} />
        </span>
      </div>
    </div>
    {!collapsed && group.kind === "section" && group.threadCount === 0 &&
      <div data-sb-drop={group.key} className="sb-group sb-empty-drop border border-dashed border-sidebar-border text-subtle-foreground"
        data-drop={dropState ?? undefined}>Drop threads here</div>}
  </>;
}

export const GroupHeader = memo(GroupHeaderView);
