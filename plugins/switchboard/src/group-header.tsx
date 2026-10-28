import { memo, type ReactNode } from "react";
import { experimental_Icon as Icon, type PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import type { DragController } from "./use-drag";
import type { GroupKey, HueId, SortMode } from "./layout";
import type { SectionColour } from "./settings";
import { Hint } from "./hint";
import { NameEditor } from "./name-editor";
import { SectionMenu } from "./section-menu";
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
  flash?: boolean;
  onRename(): void;
  onRenameSubmit(name: string): Promise<unknown>;
  onRenameCancel(): void;
  onSetHue(hue: HueId | null): void;
  onNewThread(): void;
  onNewSectionBelow?(): void;
  onMarkAllRead(): void;
  onDelete(): void;
  onSectionMove(direction: "up" | "down"): void;
  sortMode?: SortMode;
  staleDays?: number;
  onSort?(mode: SortMode): void;
  onArchiveStale?(): void;
  projects?: readonly PluginSidebarProject[];
  defaultProjectId?: string | null;
  onSetDefaultProject?(projectId: string | null): void;
}

const hueClasses = (hue: HueId | null, sectionColour: SectionColour): string =>
  hue ? `sb-hue-${hue} ${sectionColour !== "swatch" ? "sb-pill-hued" : ""} ${sectionColour === "tint" ? "sb-tint" : ""}` : "";

function EditingMain({ collapsed, hue, children }: { collapsed: boolean; hue: HueId | null; children: ReactNode }) {
  return <div className="sb-header-main flex h-full min-w-0 flex-1 items-center">
    <span aria-hidden className="sb-header-caret shrink-0 text-center text-2xs text-subtle-foreground">{collapsed ? "▸" : "▾"}</span>
    {hue && <span aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ background: "var(--sb-hue)" }} />}
    {children}
  </div>;
}

// A section that exists only on screen until its name is submitted, so Escape leaves nothing behind.
export function DraftSectionHeader({ hue, sectionColour, onSubmit, onCancel }: {
  hue: HueId; sectionColour: SectionColour; onSubmit(name: string): Promise<unknown>; onCancel(): void;
}) {
  return <section className={`sb-hue-${hue}`} aria-label="New section">
    <div data-editing="" data-sb-draft=""
      className={`sb-group-header relative flex min-w-0 items-center text-muted-foreground ${hueClasses(hue, sectionColour)}`}>
      <EditingMain collapsed={false} hue={hue}>
        <NameEditor placeholder="Section name" action="create" onSubmit={onSubmit} onCancel={onCancel} />
      </EditingMain>
    </div>
  </section>;
}

function GroupHeaderView({ group, collapsed, sectionColour, onToggle, drag, renaming, dropState,
  hueOverride, flash = false, onRename, onRenameSubmit, onRenameCancel, onSetHue, onNewThread, onNewSectionBelow,
  onMarkAllRead, onDelete, onSectionMove, sortMode = "manual", staleDays = 3, onSort, onArchiveStale,
  projects, defaultProjectId = null, onSetDefaultProject }: GroupHeaderProps) {
  const name = group.kind === "pinned" ? "Pinned" : group.kind === "loose" ? "Threads" : group.section?.name ?? "Section";
  const defaultProject = defaultProjectId ? projects?.find((project) => project.id === defaultProjectId) : undefined;
  const newThreadLabel = defaultProject ? `New ${defaultProject.name} thread in ${name}` : `New thread in ${name}`;
  const states: Exclude<RowState, "idle">[] = ["failed", "needs", "running", ...(collapsed ? ["unread" as const] : [])];
  const editing = renaming && group.kind === "section";
  return <>
    <div data-sb-drop={group.key} data-sb-section={group.section?.id} data-collapsed={collapsed}
      data-drop={dropState ?? undefined} data-editing={editing ? "" : undefined}
      className={`sb-group sb-group-header relative flex min-w-0 items-center text-muted-foreground ${hueClasses(group.hue, sectionColour)} ${flash ? "sb-flash" : ""}`}>
      {editing ?
        <EditingMain collapsed={collapsed} hue={group.hue}>
          <NameEditor initial={name} action="save" onSubmit={onRenameSubmit} onCancel={onRenameCancel} />
        </EditingMain> :
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
          {group.hue && <span aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ background: "var(--sb-hue)" }} />}
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
          {group.kind !== "pinned" && <Hint label={newThreadLabel}><button type="button" aria-label={newThreadLabel}
            className="sb-control sb-icon-button shrink-0 text-muted-foreground"
            onClick={onNewThread}>+</button></Hint>}
          <SectionMenu group={group} unreadCount={group.roots.reduce((total, root) => total + unreadIn(root), 0)} hueOverride={hueOverride}
            sortMode={sortMode} staleDays={staleDays} onSort={onSort} onArchiveStale={onArchiveStale}
            staleCount={group.roots.filter((root) => root.stale).length}
            staleChildCount={group.roots.filter((root) => root.stale).reduce((total, root) => total + descendants(root), 0)}
            onRename={onRename} onSetHue={onSetHue} onNewThread={onNewThread} onNewSectionBelow={onNewSectionBelow}
            onMarkAllRead={onMarkAllRead} onDelete={onDelete}
            projects={projects} defaultProjectId={defaultProjectId} onSetDefaultProject={onSetDefaultProject} />
        </span>
      </div>
    </div>
    {!collapsed && group.kind === "section" && group.threadCount === 0 &&
      <div data-sb-drop={group.key} className="sb-group sb-empty-drop border border-dashed border-sidebar-border text-subtle-foreground"
        data-drop={dropState ?? undefined}>Drop threads here</div>}
  </>;
}

export const GroupHeader = memo(GroupHeaderView);
