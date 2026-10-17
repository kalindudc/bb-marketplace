import type { Ref } from "react";
import type { ListFilter } from "./filter";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Hint } from "./hint";
import { STATE_LABEL, type RowState, type StateCounts } from "./status";
import { StatusGlyph } from "./status-glyph";
import type { SwitchboardSettings } from "./settings";
import { ViewMenu, ViewSwitch } from "./view-menu";

const CHIP_NOUN: Readonly<Record<Exclude<RowState, "idle">, string>> = {
  failed: "failed threads", needs: "threads that need you", running: "running threads", unread: "unread threads",
};

export function chipHint(state: Exclude<RowState, "idle">, count: number, active: ReadonlySet<RowState>): string {
  if (active.has(state)) return `Stop filtering by ${CHIP_NOUN[state]}`;
  return `${active.size ? "Also show" : "Show only"} ${CHIP_NOUN[state]} (${count})`;
}

function ArchivedToggle({ shown, onChange }: { shown: boolean; onChange(shown: boolean): void }) {
  const label = shown ? "Hide archived threads" : "Show archived threads";
  return <Hint label={label}>
    <button type="button" aria-label={label} aria-pressed={shown} onClick={() => onChange(!shown)}
      className="sb-control sb-icon-button shrink-0 text-muted-foreground aria-pressed:bg-surface-selected aria-pressed:text-sidebar-foreground">
      <Icon name="Archive" aria-hidden /></button>
  </Hint>;
}

export function FilterBar(props: {
  filter: ListFilter;
  counts: StateCounts;
  showChips: boolean;
  inputRef: Ref<HTMLInputElement>;
  onChange(filter: ListFilter): void;
  settings?: SwitchboardSettings;
  onSettingsChange?(values: Partial<SwitchboardSettings>): void;
}) {
  const { filter, counts, showChips, inputRef, onChange, settings, onSettingsChange } = props;
  const states: Exclude<RowState, "idle">[] = ["failed", "needs", "running", "unread"];
  return <div className="sb-filter-bar pt-1">
    <div className="sb-filter-controls flex min-w-0 items-center gap-1">
    <label className="sb-filter flex min-w-0 flex-1 items-center border border-sidebar-border text-subtle-foreground">
      <svg aria-hidden width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" />
      </svg>
      <input ref={inputRef} value={filter.query} onChange={(event) => onChange({ ...filter, query: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); onChange({ query: "", states: new Set() }); }
        }}
        type="search" aria-label="Filter threads" placeholder="Filter threads"
        className="min-w-0 flex-1 bg-transparent text-[13px] text-sidebar-foreground outline-none placeholder:text-subtle-foreground" />
      <span aria-hidden className="rounded border border-sidebar-border px-1 font-mono text-2xs">/</span>
    </label>
    {settings && onSettingsChange && <><ViewSwitch view={settings.view} onChange={(view) => onSettingsChange({ view })} />
      <ArchivedToggle shown={settings.showArchived} onChange={(showArchived) => onSettingsChange({ showArchived })} />
      <ViewMenu settings={settings} onChange={onSettingsChange} /></>}
    </div>
    {showChips && <div className="sb-chips flex">
      {states.map((state) => (counts[state] > 0 || filter.states.has(state)) && <Hint key={state}
        label={chipHint(state, counts[state], filter.states)}><button
        type="button" aria-label={`${STATE_LABEL[state]}: ${counts[state]}`} aria-pressed={filter.states.has(state)}
        className={`sb-control sb-chip inline-flex min-w-0 items-center rounded-full border border-sidebar-border font-mono text-[11px] ${filter.states.has(state) ? "bg-surface-selected text-sidebar-foreground" : "text-muted-foreground"}`}
        onClick={() => {
          const selected = new Set(filter.states);
          if (selected.has(state)) selected.delete(state); else selected.add(state);
          onChange({ ...filter, states: selected });
        }}>
        <StatusGlyph state={state} label={STATE_LABEL[state]} />{counts[state]}
      </button></Hint>)}
    </div>}
  </div>;
}
