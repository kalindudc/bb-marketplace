import { useState, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Config } from "../../config";
import { BUTTON_GHOST, BUTTON_PRIMARY, CARD, Checkbox, ErrorNote, FIELD, FitTextarea, Toggle } from "../common";
import { AUTO_TRIGGERS, WATCH_MODES } from "../constants";
import { ACT_PROMPT_VARIABLES } from "../../templates";
import { AutomationPauseControls } from "../automation-pause";
import { useShuttleQuery } from "../data";
import { AutoPostCard, fromAutoPostDraft, toAutoPostDraft, type AutoPostDraft } from "./auto-post";
import { PromptEditor } from "./prompt-editor";
import { useConfig } from "./use-config";

type AutoReview = Config["autoReview"];
type Watch = Config["watch"];
type Trigger = (typeof AUTO_TRIGGERS)[number];

const TRIGGER_LABELS: Record<Trigger, { label: string; hint?: string }> = {
  requested: { label: "I am requested as a reviewer by name", hint: "Or a review of mine was dismissed and the PR has new commits since. Never for my own PRs." },
  team: { label: "One of my teams is requested", hint: "Can be many PRs: consider a repository filter." },
  mentioned: { label: "I am @mentioned" },
};

const splitGlobs = (text: string) => text.split(/[\s,]+/u).filter((glob) => glob !== "");
const splitLines = (text: string) => text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
/** One bot a line: its login or glob, a colon, then its phrases separated by commas. */
const phrasesText = (rules: Watch["botPhrases"]) => rules.map((rule) => `${rule.bot}: ${rule.phrases.join(", ")}`).join("\n");
const parsePhrases = (text: string): Watch["botPhrases"] =>
  splitLines(text).map((line) => {
    const colon = line.indexOf(":");
    if (colon < 0) return { bot: line, phrases: [] };
    return { bot: line.slice(0, colon).trim(), phrases: line.slice(colon + 1).split(",").map((phrase) => phrase.trim()).filter((phrase) => phrase !== "") };
  });

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

/** What Shuttle does by itself: auto reviews, and what agents get sent about your PRs. */
export function AutomationsSection() {
  const overview = useShuttleQuery("overview", {});
  const { config, loadError, saving, saveError, save, clearSaveError } = useConfig();
  const [draft, setDraft] = useState<{ autoReview: AutoReview; watch: Watch; repos: string; bots: string; phrases: string; checks: string; autoPost: AutoPostDraft } | null>(null);
  if (config === null) return loadError !== null ? <ErrorNote>Could not load Shuttle's settings: {loadError}</ErrorNote> : <div className="text-sm text-muted-foreground">Loading…</div>;

  const shown = draft ?? {
    autoReview: config.autoReview, watch: config.watch, repos: config.autoReview.repos.join(", "), bots: config.watch.allowBots.join(", "),
    phrases: phrasesText(config.watch.botPhrases), checks: config.watch.ignoreChecks.join("\n"), autoPost: toAutoPostDraft(config.autoPost),
  };
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
    const watch: Watch = { ...draft.watch, allowBots: splitGlobs(draft.bots), botPhrases: parsePhrases(draft.phrases), ignoreChecks: splitLines(draft.checks) };
    const next: Config = { ...config, autoReview: { ...draft.autoReview, repos: splitGlobs(draft.repos) }, watch, autoPost: fromAutoPostDraft(draft.autoPost) };
    if (await save(next, "Saved the automations")) setDraft(null);
  };
  const row = "grid grid-cols-1 items-center gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3";
  const label = "text-xs text-muted-foreground";
  const number = (value: string) => (value.trim() === "" ? Number.NaN : Number(value));

  return (
    <div data-section="automations" className="flex flex-col gap-3">
      {overview.data !== undefined && <div className={`${CARD} p-3.5 text-xs`}><AutomationPauseControls overview={overview.data} /></div>}
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
            <input aria-label="Only these repositories" className={`${FIELD} font-mono`} placeholder="Any repository, or globs such as acme/app, acme/*" value={shown.repos}
              onChange={(event) => { clearSaveError(); setDraft({ ...shown, repos: event.target.value }); }} />
          </label>
          <label className={row}>
            <span className={label}>At most</span>
            <span className="flex items-center gap-2">
              <input aria-label="Auto reviews a day" type="number" min={0} max={100} className={`${FIELD} w-20`} value={Number.isNaN(auto.maxPerDay) ? "" : auto.maxPerDay}
                onChange={(event) => setAuto({ maxPerDay: number(event.target.value) })} />
              <span className="text-xs text-muted-foreground">a day; the rest wait for you in Reviews</span>
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

      <Card icon="Bot" title="Agents" hint="Send new reviews, comments and failed checks on your PRs to the thread that handles them." on={watch.enabled} onToggle={(enabled) => setWatch({ enabled })}>
        <div className="flex flex-col gap-2.5 text-sm">
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
          <Checkbox checked={watch.autoWatch} label="A thread that links one of your PRs becomes its agent" hint="Only when the PR has no agent yet." onChange={(autoWatch) => setWatch({ autoWatch })} />
          <Checkbox checked={watch.includeChecks} label="Also send failed checks on the head" onChange={(includeChecks) => setWatch({ includeChecks })} />
        </div>
        <label className={`${row} mt-1.5 items-start text-sm`}>
          <span className={`${label} pt-1.5`}>Except these checks</span>
          <span className="flex min-w-0 flex-col gap-1">
            <FitTextarea aria-label="Checks an agent never gets" rows={2} className={`${FIELD} font-mono`} disabled={!watch.includeChecks} placeholder="No check, or one name or glob a line, such as review-gate*" value={shown.checks}
              onChange={(event) => { clearSaveError(); setDraft({ ...shown, checks: event.target.value }); }} />
            <span className="text-xs text-muted-foreground">For checks with nothing in them to fix, such as a gate that waits for a person's approval or for a reviewer's threads to be resolved. The PR's Checks tab still shows them.</span>
          </span>
        </label>
        <div className="mt-1.5">
          <Checkbox checked={watch.quietReviews} label="Hold approvals and review summaries for the next message"
            hint="Approvals, dismissals and a bot's review of its own open threads never make a message by themselves. They come with the thread's next one, and are dropped when the PR merges or closes."
            onChange={(quietReviews) => setWatch({ quietReviews })} />
          <Checkbox checked={watch.ignoreBots} label="Ignore bots" hint="Reviews and comments from accounts the server marks as bots, or that Bot authors in Shuttle's settings names." onChange={(ignoreBots) => setWatch({ ignoreBots })} />
        </div>
        <label className={`${row} mt-1.5 text-sm`}>
          <span className={label}>Except these bots</span>
          <span className="flex min-w-0 flex-col gap-1">
            <input aria-label="Bots an agent still hears from" className={`${FIELD} font-mono`} disabled={!watch.ignoreBots} placeholder="No bot, or logins and globs such as review-bot, *-scanner" value={shown.bots}
              onChange={(event) => { clearSaveError(); setDraft({ ...shown, bots: event.target.value }); }} />
            <span className="text-xs text-muted-foreground">An agent still gets their reviews and comments, such as an AI reviewer's findings. What a bot said before you add it is not sent.</span>
          </span>
        </label>
        <label className={`${row} mt-1.5 items-start text-sm`}>
          <span className={`${label} pt-1.5`}>Other bots, only when they say</span>
          <span className="flex min-w-0 flex-col gap-1">
            <FitTextarea aria-label="Phrases that let a bot through" rows={2} className={`${FIELD} font-mono`} disabled={!watch.ignoreBots} placeholder="merge-queue*: failed, removed from the queue" value={shown.phrases}
              onChange={(event) => { clearSaveError(); setDraft({ ...shown, phrases: event.target.value }); }} />
            <span className="text-xs text-muted-foreground">One bot a line: its login or glob, a colon, then phrases separated by commas. An agent gets what the bot writes only when it has one of them, in any case, such as a merge queue's note that it removed the PR.</span>
          </span>
        </label>
        <div className={`${row} mt-2 items-start text-sm`}>
          <span className={`${label} pt-1.5`}>What a Fix it agent is asked to do</span>
          <PromptEditor label="What a Fix it agent is asked to do" rows={4} value={watch.actPrompt} variables={ACT_PROMPT_VARIABLES} onChange={(actPrompt) => setWatch({ actPrompt })} />
        </div>
      </Card>

      <AutoPostCard value={shown.autoPost} onChange={(autoPost) => { clearSaveError(); setDraft({ ...shown, autoPost }); }} />

      <div className="flex items-center justify-end gap-2">
        {draft !== null && <span className="flex-1 text-xs text-muted-foreground">Unsaved changes</span>}
        <button type="button" className={BUTTON_GHOST} disabled={draft === null || saving} onClick={() => { setDraft(null); clearSaveError(); }}>Discard</button>
        <button type="button" className={BUTTON_PRIMARY} disabled={draft === null || saving} onClick={() => void submit()}>{saving ? "Saving…" : "Save automations"}</button>
      </div>
    </div>
  );
}
