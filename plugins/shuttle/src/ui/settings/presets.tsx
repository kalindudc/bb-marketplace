import { useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Preset } from "../../config";
import { BUTTON, BUTTON_GHOST, BUTTON_GHOST_DANGER, BUTTON_PRIMARY, CARD, ErrorNote, FIELD, Pill } from "../common";
import { WORKSPACES } from "../constants";
import { ExecutionPicker, executionOf, withExecution, type Execution } from "../execution";
import { defaultPresetOf, presetSummary } from "../review-button";
import { SkillInput } from "../skill-input";
import { PROMPT_VARIABLES, renderTemplate } from "../../templates";
import { sampleReviewVariables } from "./prompt";
import { PromptEditor } from "./prompt-editor";
import { useConfig } from "./use-config";

const WORKSPACE_LABELS: Record<(typeof WORKSPACES)[number], string> = {
  "project-default": "The project's default workspace",
  worktree: "Its own checkout: the server's review workspace, else a git worktree",
};

function freshId(taken: readonly string[]): string {
  for (let n = 1; ; n += 1) {
    const id = `preset-${n}`;
    if (!taken.includes(id)) return id;
  }
}

function PresetEditor({ preset, isNew, canDelete, onChange, onExecution, onMakeDefault, onDelete }: {
  preset: Preset;
  isNew: boolean;
  canDelete: boolean;
  onChange(patch: Partial<Preset>): void;
  onExecution(next: Execution | null): void;
  onMakeDefault(): void;
  onDelete(): void;
}) {
  const label = "text-xs text-muted-foreground";
  return (
    <div data-preset-editor={preset.id} className={`${CARD} grid grid-cols-1 items-center gap-x-3.5 gap-y-3 p-3.5 text-sm sm:grid-cols-[8.5rem_minmax(0,1fr)]`}>
      <span className={label}>Name</span>
      <div className="flex items-center gap-2">
        <input aria-label="Preset name" className={`${FIELD} min-w-0 flex-1`} value={preset.name} onChange={(event) => onChange({ name: event.target.value })} />
        {preset.default ? <Pill tone="info">Default</Pill> : <button type="button" className={BUTTON} onClick={onMakeDefault}>Make default</button>}
      </div>
      {isNew && (
        <>
          <span className={label}>Id</span>
          <input aria-label="Preset id" className={`${FIELD} font-mono`} value={preset.id} onChange={(event) => onChange({ id: event.target.value })} />
        </>
      )}
      <span className={label}>Skill</span>
      <SkillInput value={preset.skill} onChange={(skill) => onChange({ skill })} />
      <span className={`${label} self-start pt-1.5`}>Agent and model</span>
      <ExecutionPicker value={executionOf(preset)} onChange={onExecution} resetLabel="Use bb default" />
      <span className={label}>Workspace</span>
      <select aria-label="Workspace" className={FIELD} value={preset.workspace} onChange={(event) => onChange({ workspace: event.target.value as Preset["workspace"] })}>
        {WORKSPACES.map((workspace) => <option key={workspace} value={workspace}>{WORKSPACE_LABELS[workspace]}</option>)}
      </select>
      <span className={`${label} self-start pt-1.5`}>Prompt</span>
      <PromptEditor label="Prompt template" value={preset.prompt} variables={PROMPT_VARIABLES} onChange={(prompt) => onChange({ prompt })} />
      <span className={`${label} self-start pt-1.5`}>Preview</span>
      <div data-prompt-preview className="whitespace-pre-wrap rounded-md border border-border bg-background px-3 py-2.5 text-xs">
        {renderTemplate(preset.prompt, sampleReviewVariables(preset.skill.trim()))}
      </div>
      {canDelete && (
        <div className="sm:col-start-2">
          <button type="button" className={BUTTON_GHOST_DANGER} onClick={onDelete}>
            <Icon name="Trash2" className="size-3.5" aria-hidden />
            Delete this preset
          </button>
        </div>
      )}
    </div>
  );
}

interface Row {
  preset: Preset;
  /** Not saved yet, so its id can still change. */
  fresh: boolean;
}

/** What a review runs with: a list of presets and an editor for the one picked; Save sends them all. */
export function PresetsSection() {
  const { config, loadError, saving, saveError, save, clearSaveError } = useConfig();
  const [draft, setDraft] = useState<Row[] | null>(null);
  const [index, setIndex] = useState(0);
  if (config === null) return loadError !== null ? <ErrorNote>Could not load Shuttle's settings: {loadError}</ErrorNote> : <div className="text-sm text-muted-foreground">Loading…</div>;

  const rows = draft ?? config.presets.map((preset) => ({ preset, fresh: false }));
  const presets = rows.map((row) => row.preset);
  const current = Math.min(index, rows.length - 1);
  const selected = rows[current]!;
  const change = (next: Row[]) => {
    clearSaveError();
    setDraft(next);
  };
  const patchSelected = (patch: Partial<Preset>) => change(rows.map((row, at) => (at === current ? { ...row, preset: { ...row.preset, ...patch } } : row)));
  const add = () => {
    const template = defaultPresetOf(presets);
    const id = freshId(presets.map((preset) => preset.id));
    change([...rows, { fresh: true, preset: { id, name: "New preset", default: false, skill: "", workspace: "project-default", prompt: template?.prompt ?? "" } }]);
    setIndex(rows.length);
  };
  const submit = async () => {
    if (draft === null) return;
    const next = draft.map(({ preset }) => ({ ...preset, id: preset.id.trim(), name: preset.name.trim(), skill: preset.skill.trim() }));
    if (await save({ ...config, presets: next }, "Saved the presets")) setDraft(null);
  };

  return (
    <div data-section="presets" className="flex flex-col gap-3">
      {saveError !== null && <ErrorNote>{saveError}</ErrorNote>}
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5">
          <ul aria-label="Presets" className="flex flex-col gap-1.5">
            {presets.map((preset, at) => (
              <li key={at}>
                <button type="button" aria-current={at === current ? "true" : undefined} onClick={() => setIndex(at)}
                  className={`w-full cursor-pointer rounded-lg border bg-card px-3 py-2 text-left ${at === current ? "border-surface-selected-border bg-surface-selected shadow-[inset_3px_0_0_var(--primary)]" : "border-border hover:bg-state-hover"}`}>
                  <span className="flex items-center gap-2">
                    <b className="min-w-0 flex-1 truncate text-sm">{preset.name || "Untitled"}</b>
                    {preset.default && <Pill tone="info">default</Pill>}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">{presetSummary(preset)}</span>
                </button>
              </li>
            ))}
          </ul>
          <div>
            <button type="button" className={BUTTON} onClick={add}>
              <Icon name="Plus" className="size-3.5" aria-hidden />
              New preset
            </button>
          </div>
        </div>
        <PresetEditor
          key={current}
          preset={selected.preset}
          isNew={selected.fresh}
          canDelete={rows.length > 1}
          onChange={patchSelected}
          onExecution={(next) => change(rows.map((row, at) => (at === current ? { ...row, preset: withExecution(row.preset, next) } : row)))}
          onMakeDefault={() => change(rows.map((row, at) => ({ ...row, preset: { ...row.preset, default: at === current } })))}
          onDelete={() => {
            change(rows.filter((_, at) => at !== current));
            setIndex(Math.max(0, current - 1));
          }}
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        {draft !== null && <span className="flex-1 text-xs text-muted-foreground">Unsaved changes</span>}
        <button type="button" className={BUTTON_GHOST} disabled={draft === null || saving} onClick={() => { setDraft(null); clearSaveError(); }}>Discard</button>
        <button type="button" className={BUTTON_PRIMARY} disabled={draft === null || saving} onClick={() => void submit()}>{saving ? "Saving…" : "Save presets"}</button>
      </div>
    </div>
  );
}
