import { memo } from "react";
import type { CollapseKey } from "./layout";
import type { Lane } from "./lanes";
import type { RowModel } from "./rows";
import type { SwitchboardSettings } from "./settings";
import { STATE_LABEL } from "./status";
import { StatusGlyph } from "./status-glyph";
import { ThreadRow } from "./thread-row";

export interface LanesViewProps {
  lanes: readonly Lane[];
  collapsed: ReadonlySet<string>;
  activeThreadId: string | null;
  settings: SwitchboardSettings;
  now: number;
  projectName(id: string): string;
  onToggle(key: CollapseKey): void;
  onNavigate(): void;
  onSnooze?(id: string): void;
  canSnooze?(id: string): boolean;
}

function LanesViewComponent({ lanes, collapsed, activeThreadId, settings, now, projectName,
  onToggle, onNavigate, onSnooze, canSnooze }: LanesViewProps) {
  return <>{lanes.map((lane) => {
    const closed = collapsed.has(lane.key) && !lane.rows.some((row) => row.thread.id === activeThreadId);
    return <section key={lane.key} className="sb-lane">
      <div className="sb-group-header relative flex min-w-0 items-center text-muted-foreground">
        <button type="button" className="sb-header-main flex h-full min-w-0 flex-1 items-center text-left"
          aria-expanded={!closed} onClick={() => onToggle(lane.key)}>
          <span aria-hidden className="sb-header-caret shrink-0 text-center text-2xs text-subtle-foreground">{closed ? "▸" : "▾"}</span>
          <StatusGlyph state={lane.state} label={STATE_LABEL[lane.state]} />
          <span className="sb-header-name truncate text-[11px] font-semibold uppercase tracking-[.06em]">{STATE_LABEL[lane.state]}</span>
          <span className="shrink-0 font-mono text-[11px] text-subtle-foreground">{String(lane.rows.length).padStart(2, "0")}</span>
        </button>
      </div>
      {!closed && <div className="sb-group-body relative">{lane.rows.map((entry) => {
        const row: RowModel = { thread: entry.thread, state: entry.state, depth: 0, guides: "", isLast: true,
          childCount: 0, collapsed: false, rollup: null, rollupCount: 0, crossProject: null, dim: entry.dim };
        return <ThreadRow key={entry.thread.id} variant="lane" row={row}
          isActive={entry.thread.id === activeThreadId} settings={settings} now={now}
          projectName={projectName(entry.thread.projectId)} parentTitle={entry.parentTitle}
          hue={entry.hue} stale={entry.stale} onNavigate={onNavigate}
          onSnooze={onSnooze && canSnooze?.(entry.thread.id) ? () => onSnooze(entry.thread.id) : undefined} />;
      })}</div>}
    </section>;
  })}</>;
}

export const LanesView = memo(LanesViewComponent);
