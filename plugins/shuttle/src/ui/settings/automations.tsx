import { useState, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Config } from "../../config";
import { BUTTON_GHOST, BUTTON_PRIMARY, CARD, Checkbox, ErrorNote, FIELD, Toggle } from "../common";
import { AUTO_TRIGGERS, WATCH_MODES } from "../constants";
import { ACT_PROMPT_VARIABLES } from "../../templates";
import { PromptEditor } from "./prompt-editor";
import { useConfig } from "./use-config";

type AutoReview = Config["autoReview"];
type Watch = Config["watch"];
type Trigger = (typeof AUTO_TRIGGERS)[number];

const TRIGGER_LABELS: Record<Trigger, { label: string; hint?: string }> = {
  requested: { label: "I am requested as a reviewer by name", hint: "Never for my own PRs." },
  team: { label: "One of my teams is requested", hint: "Can be many PRs: consider a repository filter." },
  mentioned: { label: "I am @mentioned" },
};

const WATCH_MODE_SETTINGS: Record<(typeof WATCH_MODES)[number], string> = {
  act: "Send it to the owner threads and ask them to act",
  forward: "Send it to the owner threads only",
};

const splitGlobs = (text: string) => text.split(/[\s,]+/u).filter((glob) => glob !== "");

function Card({ icon, title, hint, on, onToggle, children }: { icon: string; title: string; hint: string; on: boolean; onToggle(next: boolean): void; children: ReactNode }) {
  return (
    <div className={CARD}>
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <Icon name={icon} className="size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{title}</div>
          <div className="text-xs text-muted-foreground">{hint}</div>
        </div>
        <Toggle on={on} label={`${title} enabled`} onChange={onToggle} />
      </div>
      <div className={`px-3.5 pb-3.5 ${on ? "" : "opacity-60"}`}>{children}</div>
    </div>
  );
}

/** What Shuttle does by itself: auto reviews and the messages a watched PR sends to its threads. */
export function AutomationsSection() {
  const { config, loadError, saving, saveError, save, clearSaveError } = useConfig();
  const [draft, setDraft] = useState<{ autoReview: AutoReview; watch: Watch; repos: string } | null>(null);
  if (config === null) return loadError !== null ? <ErrorNote>Could not load Shuttle's settings: {loadError}</ErrorNote> : <div className="text-sm text-muted-foreground">Loading…</div>;

  const shown = draft ?? { autoReview: config.autoReview, watch: config.watch, repos: config.autoReview.repos.join(", ") };
  const { autoReview: auto, watch } = shown;
  const setAuto = (patch: Partial<AutoReview>) => {
    clearSaveError();
    setDraft({ ...shown, autoReview: { ...auto, ...patch } });
  };
  const setWatch = (patch: Partial<Watch>) => {
    clearSaveError();
    setDraft({ ...shown, watch: { ...watch, ...patch } });
  };
  const toggleTrigger = (trigger: Trigger, on: boolean) =>
    setAuto({ when: AUTO_TRIGGERS.filter((item) => (item === trigger ? on : auto.when.includes(item))) });
  const submit = async () => {
    if (draft === null) return;
    const next: Config = { ...config, autoReview: { ...draft.autoReview, repos: splitGlobs(draft.repos) }, watch: draft.watch };
    if (await save(next, "Saved the automations")) setDraft(null);
  };
  const row = "grid grid-cols-1 items-center gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3";
  const label = "text-xs text-muted-foreground";
  const number = (value: string) => (value.trim() === "" ? Number.NaN : Number(value));

  return (
    <div data-section="automations" className="flex flex-col gap-3">
      {saveError !== null && <ErrorNote>{saveError}</ErrorNote>}
      <Card icon="Bot" title="Auto review" hint="Start a review thread by itself when a PR asks for you." on={auto.enabled} onToggle={(enabled) => setAuto({ enabled })}>
        <div className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Start one when</div>
        {AUTO_TRIGGERS.map((trigger) => (
          <Checkbox key={trigger} checked={auto.when.includes(trigger)} label={TRIGGER_LABELS[trigger].label} hint={TRIGGER_LABELS[trigger].hint} onChange={(on) => toggleTrigger(trigger, on)} />
        ))}
        <Checkbox checked={auto.drafts} label="Also when the PR is a draft" onChange={(drafts) => setAuto({ drafts })} />
        <div className="mt-2.5 flex flex-col gap-2.5 text-sm">
          <label className={row}>
            <span className={label}>Preset</span>
            <select aria-label="Auto review preset" className={FIELD} value={auto.preset} onChange={(event) => setAuto({ preset: event.target.value })}>
              <option value="">The default preset</option>
              {config.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
            </select>
          </label>
          <label className={row}>
            <span className={label}>Only these repositories</span>
            <input aria-label="Only these repositories" className={`${FIELD} font-mono`} placeholder="Any repository, or globs such as shop/world, get-bb/*" value={shown.repos}
              onChange={(event) => { clearSaveError(); setDraft({ ...shown, repos: event.target.value }); }} />
          </label>
          <label className={row}>
            <span className={label}>At most</span>
            <span className="flex items-center gap-2">
              <input aria-label="Auto reviews a day" type="number" min={0} max={100} className={`${FIELD} w-20`} value={Number.isNaN(auto.maxPerDay) ? "" : auto.maxPerDay}
                onChange={(event) => setAuto({ maxPerDay: number(event.target.value) })} />
              <span className="text-xs text-muted-foreground">a day; the rest wait for you in Needs you</span>
            </span>
          </label>
          <label className={row}>
            <span className={label}>Again on new commits</span>
            <select aria-label="Again on new commits" className={FIELD} value={auto.rerun} onChange={(event) => setAuto({ rerun: event.target.value as AutoReview["rerun"] })}>
              <option value="never">Never</option>
              <option value="new_head">On every new head</option>
            </select>
          </label>
        </div>
      </Card>

      <Card icon="Eye" title="Watched PRs" hint="Send new reviews on a watched PR to its owner threads." on={watch.enabled} onToggle={(enabled) => setWatch({ enabled })}>
        <div className="flex flex-col gap-2.5 text-sm">
          <label className={row}>
            <span className={label}>When a review arrives</span>
            <select aria-label="When a review arrives" className={FIELD} value={watch.mode} onChange={(event) => setWatch({ mode: event.target.value as Watch["mode"] })}>
              {WATCH_MODES.map((mode) => <option key={mode} value={mode}>{WATCH_MODE_SETTINGS[mode]}</option>)}
            </select>
          </label>
          <label className={row}>
            <span className={label}>Wait to batch</span>
            <span className="flex items-center gap-2">
              <input aria-label="Minutes to batch" type="number" min={0} max={60} className={`${FIELD} w-20`} value={Number.isNaN(watch.batchMinutes) ? "" : watch.batchMinutes}
                onChange={(event) => setWatch({ batchMinutes: number(event.target.value) })} />
              <span className="text-xs text-muted-foreground">minutes, so a review with many comments arrives as one message</span>
            </span>
          </label>
        </div>
        <div className="mt-1.5">
          <Checkbox checked={watch.autoWatch} label="Watch my PRs as soon as they are linked to a thread" onChange={(autoWatch) => setWatch({ autoWatch })} />
          <Checkbox checked={watch.includeChecks} label="Also send CI failures on the head" onChange={(includeChecks) => setWatch({ includeChecks })} />
          <Checkbox checked={watch.ignoreBots} label="Ignore bots" hint="Reviews and comments from accounts the server marks as bots." onChange={(ignoreBots) => setWatch({ ignoreBots })} />
        </div>
        <div className={`${row} mt-2 items-start text-sm`}>
          <span className={`${label} pt-1.5`}>Act prompt</span>
          <PromptEditor label="Act prompt" rows={4} value={watch.actPrompt} variables={ACT_PROMPT_VARIABLES} onChange={(actPrompt) => setWatch({ actPrompt })} />
        </div>
      </Card>

      <div className="flex items-center justify-end gap-2">
        {draft !== null && <span className="flex-1 text-xs text-muted-foreground">Unsaved changes</span>}
        <button type="button" className={BUTTON_GHOST} disabled={draft === null || saving} onClick={() => { setDraft(null); clearSaveError(); }}>Discard</button>
        <button type="button" className={BUTTON_PRIMARY} disabled={draft === null || saving} onClick={() => void submit()}>{saving ? "Saving…" : "Save automations"}</button>
      </div>
    </div>
  );
}
