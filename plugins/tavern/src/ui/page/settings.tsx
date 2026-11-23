import { experimental_ProviderModelPicker as ProviderModelPicker, experimental_copyToClipboard, experimental_useProviders, experimental_useRpcMutation, experimental_useRpcQuery, useBbNavigate, type ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import { createContext, useContext, useCallback, useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ambientMotionPatch, characterQuietPatch, charactersPatch, CHARACTER_QUIET_HOUR_MS, DEFAULT_SETTINGS, KNOB_FIELDS, importSummary, isGuardrailSetting, settingsContract, voicePatch, type TavernSettings, type SettingsChange, type SettingsPatch, type ResettableSetting, type SettingsView, type TunableKey } from "../../shared/settings";
import { Glyph, OpensMark, TimeAgo, plural, useRegistry, useSidebarActorNames, useRemembered, ExpandsMark, FoldSummary } from "../kit";
import { useCharacterQuiet } from "../engine/character-quiet";
import { ReadState, SegFilter } from "./common";
import { BACKUP_INTRO, BackupSection } from "./backup";
import { PageGlyph, type PageGlyphName } from "./glyphs";
import { MachinesSettingsRow } from "./machines-row";
import { PLACEMENT_RPC_LIVE } from "./machines-contract";
import { formatValue, isUserKnob, knobLabel, knobValue } from "./insights";
import { AwayStopChoices } from "./away-preferences";
import { AWAY_STOP_LABELS } from "../../shared/away";
import { ALWAYS_ASK_KINDS } from "../../shared/quest-authority";
import { sendToolsSchema, type SendTools } from "../../shared/communication";
import { SetupSettings } from "./setup";
import { settingLabel } from "./settings-label";
import { SETUP_CALLER_NOTICE } from "../../shared/setup";
import { alertRouteContract, type AlertRouteView, type HoldReason } from "../../shared/alert-route";
import { insightsContract } from "../../shared/insights";
import { WardenQualitySection } from "./warden-quality";
import { MemorySettings } from "./memory-settings";

const WHY = "Changed on the settings page";
export const ATMOSPHERE_ANCHOR = "tavern-settings-atmosphere";
export const VOICE_HELP = {
  full: "Show speech bubbles at greetings, milestones, intervals and on clicks.",
  light: "Show speech bubbles after verification, at a quest wrap and on clicks.",
  off: "Hide speech bubbles and saved voice lines in reports and character sheets.",
} as const;
type Problem = { line: number; key: string; message: string; allowed?: string };
type Change = SettingsChange;

/** One read and one writer for every section, so a change in one shows in all and a stale revision is caught. */
export function useTavernSettings() {
  const query = experimental_useRpcQuery({ contract: settingsContract, method: "settings", input: null });
  const update = experimental_useRpcMutation({ contract: settingsContract, method: "settingsUpdate" });
  const [problems, setProblems] = useState<Problem[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const save = async (patch: SettingsPatch, pins?: Partial<Record<TunableKey, number | null>>, reset?: ResettableSetting[]) => {
    if (!query.data) return;
    setProblems([]); setNote(null);
    const out = await update.mutate({ revision: query.data.revision, patch, ...(pins ? { pins } : {}), ...(reset ? { reset } : {}), why: reset ? "Reset to default on the settings page" : WHY });
    if (out.code === "stale") setNote("Settings changed somewhere else, so nothing was saved. The latest values are shown; make the change again.");
    if (out.code === "invalid") setProblems(out.problems);
    void query.refetch();
    return out.code === "ok";
  };
  return { data: query.data, error: query.error, refetch: query.refetch, save, reset: (key: ResettableSetting) => save({}, undefined, [key]), pending: update.isPending, problems, note };
}
type Api = ReturnType<typeof useTavernSettings>;
type SettingsGroup = Exclude<keyof TavernSettings, "classes">;
type SettingKey = ResettableSetting;
const SettingsBody = createContext<Api | null>(null);
const settingsValue = (settings: TavernSettings, path: SettingKey): unknown => {
  const [section, key] = path.split(".") as [SettingsGroup, string];
  return (settings[section] as Record<string, unknown>)[key];
};
function differsFromDefault(effective: TavernSettings, key: SettingKey) {
  const current = settingsValue(effective, key), fallback = settingsValue(DEFAULT_SETTINGS, key);
  if (Array.isArray(current) && Array.isArray(fallback)) return current.length !== fallback.length || current.some(value => !fallback.includes(value));
  return JSON.stringify(current) !== JSON.stringify(fallback) || (key === "tavern.ambientMotion" && !effective.tavern.hearthFlicker);
}
const settingsPatch = (path: SettingKey, value: unknown): SettingsPatch => {
  const [section, key] = path.split(".");
  return { [section!]: { [key!]: value } };
};

function Shell({ api, children, className = "" }: { api: Api; children: (data: SettingsView) => ReactNode; className?: string }) {
  return <div className={`tavern tv-page tv-set ${className}`}>
    {api.note && <p className="tv-problem" role="alert">{api.note}</p>}
    {api.problems.length > 0 && <ul className="tv-problem" role="alert">{api.problems.map((p) => <li key={`${p.key}${p.line}`}><b>{p.key}</b>: {p.message}{p.allowed ? ` (allowed: ${p.allowed})` : ""}</li>)}</ul>}
    {api.data ? <SettingsBody.Provider value={api}>{children(api.data)}</SettingsBody.Provider> : <ReadState error={api.error} retry={api.refetch} />}
  </div>;
}

export function SettingsCard({ title, hint, glyph, guardrail = false, children }: { title: string; hint: string; glyph: PageGlyphName; guardrail?: boolean; children: ReactNode }) {
  const id = useId();
  return <section className="tv-card tv-settings-card" aria-labelledby={id}><header className="tv-settings-head"><PageGlyph name={glyph} size={18} /><div><h3 id={id}>{title}</h3><p className="tv-settings-hint">{hint}{guardrail && " Agents in Tavern threads can't change these; only you can."}</p></div></header><div className="tv-settings-body">{children}</div></section>;
}

export function SettingDefault({ setting, api: provided, managed = false }: { setting: SettingKey; api?: Api; managed?: boolean }) {
  const inherited = useContext(SettingsBody);
  const api = provided ?? inherited;
  const context = api?.data;
  const value = settingsValue(DEFAULT_SETTINGS, setting);
  const changed = !!context && differsFromDefault(context.effective, setting);
  const last = context?.lastChangers?.[setting] ?? context?.history.find(change => change.changes.some(c => c.key === setting));
  return <div className="tv-set-default">
    <span data-setting-changed={changed || undefined}>{changed ? "Changed from " : "Default: "}<b>{defaultWords(setting, value)}</b></span>
    {managed && last && <span>Last changed by <SettingAuthor threadId={last.threadId} by={last.by} /> <TimeAgo at={last.at} /></span>}
    {changed && api && <button type="button" className="tv-ilink act" aria-label={`Reset ${settingLabel(setting)} to default`} disabled={api.pending} onClick={() => void api.reset(setting)}>Reset to default</button>}
  </div>;
}

function Row({ label, help, children, control, setting, managed = false, coveredBy = [] }: { label: string; help?: ReactNode; children?: ReactNode; control: (id: string) => ReactNode; setting?: SettingKey; managed?: boolean; coveredBy?: SettingKey[] }) {
  const id = useId();
  return <div className="tv-set-row" data-setting-keys={setting ? [setting, ...coveredBy].join(" ") : undefined}><div className="tv-set-l"><label htmlFor={id}>{label}</label>{help && <p>{help}</p>}{children}{setting && <SettingDefault setting={setting} managed={managed} />}</div><div className="tv-set-c">{control(id)}</div></div>;
}

const NUMBER_HELP: Record<{ [G in keyof typeof KNOB_FIELDS]: keyof typeof KNOB_FIELDS[G] }[keyof typeof KNOB_FIELDS], string> = {
  reportedPoseSeconds: "How long a character holds its finished pose above the composer.",
  verifiedPoseMinutes: "How long a character holds its verified pose above the composer.",
  productionWakeHours: "How long a production or cluster write ask waits before waking you, if that option is on for the window.",
  defaultBackAtHour: "Prefills Back at with the next time at this local hour that's at least an hour away.",
  restatementBytes: "Caps the Keeper's restatement. Lower limits make Keepers forget what you told them.",
  tickFactChars: "Caps the facts in each routine Keeper check-in. Lower limits make Keepers forget what you told them.",
  failuresBeforeAsk: "How many provider failures or refused check-ins in a row trigger a question for you.",
  stopAskAfterSeconds: "How long Tavern retries an unconfirmed stop before asking you for help.",
  retryAfterSeconds: "How long Tavern waits before retrying a routine Keeper check-in the host refused.",
  briefRetryAttempts: "How many times Tavern tries to deliver a member's brief before asking you.",
  replacementsPerSlot: "How many fresh members may take the same party slot on one version of the plan.",
  rangerMax: "The fallback limit when the Keeper's class file has no Ranger budget.",
  keepMaxHours: "How far ahead a Keeper may reserve a resting member for follow-up.",
  registryWaitSeconds: "How long Tavern waits for class files before letting your message through with the built-in Keeper.",
  clusterGrantMinutes: "How long a confirmed cluster command can wait to run once before it needs a new ask.",
  successionRecoverySeconds: "How long Tavern checks an uncertain refresh before returning control to the current Keeper.",
  registryBlockerMinutes: "How long a member's class files can stay unavailable before Tavern asks the Keeper.",
  remindEveryMinutes: "The shortest gap between reminders for the same journal.",
  reportGraceMinutes: "How long a delegate's unchecked report waits before the journal calls it out.",
  minSamples: "How much recorded work Tavern needs before it can suggest a change.",
  windowDays: "How far back Tavern looks for evidence when tuning.",
  cooldownDays: "How long Tavern waits before automatically changing the same knob again.",
  ledgerRefreshMinutes: "How often the Keeper gets the full ledger even when nothing has changed.",
};

function AgentLimits({ title, hint, groups }: { title: string; hint: string; groups: (keyof typeof KNOB_FIELDS)[] }) {
  const api = useContext(SettingsBody);
  if (!api?.data) throw new Error("Agent limits must be inside the Settings body");
  const effective = api.data.effective;
  const changed = groups.flatMap(group => Object.keys(KNOB_FIELDS[group]).map(key => `${group}.${key}` as SettingKey))
    .filter(key => differsFromDefault(effective, key)).length;
  return <details className="tv-set-advanced">
    <FoldSummary><strong>{title}</strong><span className="tag">{changed} changed</span></FoldSummary>
    <p className="tv-set-intro">{hint}</p>
    {groups.map(group => <NumberKnobRows key={group} group={group} managed />)}
  </details>;
}

function NumberKnobRows({ group, managed = false }: { group: keyof typeof KNOB_FIELDS; managed?: boolean }) {
  const api = useContext(SettingsBody);
  if (!api?.data) throw new Error("Number knobs must be inside the Settings body");
  return Object.entries(KNOB_FIELDS[group]).map(([key, rule]) => {
    const setting = `${group}.${key}` as SettingKey;
    const value = settingsValue(api.data!.effective, setting) as number;
    const help = NUMBER_HELP[key as keyof typeof NUMBER_HELP];
    return <Row key={setting} setting={setting} label={rule.label} managed={managed} help={help}
      control={id => <NumberField id={id} value={value} min={rule.min} max={rule.max} unit={rule.unit} disabled={api.pending} onSave={v => void api.save(settingsPatch(setting, v))} />} />;
  });
}

function Toggle({ id, checked, onChange, disabled }: { id: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <button type="button" id={id} role="switch" aria-checked={checked} className={`tv-switch ${checked ? "on" : ""}`} disabled={disabled} onClick={() => onChange(!checked)}><span className="tv-switch-k" /><span className="tv-switch-t">{checked ? "On" : "Off"}</span></button>;
}

/** A whole number that saves on Enter or when focus leaves, refusing values outside its bounds. */
export function NumberField({ id, value, min, max, unit, onSave, disabled }: { id: string; value: number; min: number; max: number; unit?: string; onSave: (v: number) => void; disabled?: boolean }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const n = Number(text), valid = text.trim() !== "" && Number.isInteger(n) && n >= min && n <= max;
  const commit = () => { if (valid && n !== value) onSave(n); else if (!valid) setText(String(value)); };
  return <span className="tv-num">
    <input id={id} type="number" inputMode="numeric" min={min} max={max} step={1} value={text} disabled={disabled} aria-invalid={!valid} aria-describedby={`${id}-b`}
      onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setText(String(value)); }} />
    {unit && <span className="m">{unit}</span>}
    <span id={`${id}-b`} className={`tv-num-b ${valid ? "" : "bad"}`}>{min.toLocaleString("en")} to {max.toLocaleString("en")}</span>
  </span>;
}


export function TavernSection() {
  const api = useTavernSettings();
  const registry = useRegistry();
  return <Shell api={api}>{(d) => { const t = d.effective.tavern; return <>
<SettingsCard title="Control of Tavern" hint="Pause work or choose whether agents can change settings." glyph="lock" guardrail>
    <Row label="Pause every Keeper" setting="tavern.paused" help="No ticks, hires or timers while paused. Asks stay answerable." control={(id) => <Toggle id={id} checked={t.paused} disabled={api.pending} onChange={(v) => void api.save({ tavern: { paused: v } })} />} />
    <Row label="Agents may change settings" setting="tavern.agentsMayChangeSettings" help="Agent CLI changes are recorded with their thread and can be undone below." control={(id) => <Toggle id={id} checked={t.agentsMayChangeSettings} disabled={api.pending} onChange={(v) => void api.save({ tavern: { agentsMayChangeSettings: v } })} />} />
</SettingsCard>
<SettingsCard title="New threads" hint="Choose how a thread starts and where Tavern appears." glyph="file">
    <Row label="New threads start as" setting="tavern.defaultClass" help="The class a new thread starts with. None is an ordinary thread." control={(id) => <select id={id} className="tv-select" value={t.defaultClass} disabled={api.pending} onChange={(e) => void api.save({ tavern: { defaultClass: e.target.value } })}><option value="none">None (an ordinary thread)</option>{registry.data?.classes.map((c) => <option key={c.id} value={c.id}>{c.label} ({c.plain})</option>)}</select>} />
    <Row label="Widget row" setting="tavern.widgetRow" help="Shows Tavern's row above the message box on every thread. Off hides it everywhere; when on, each thread can still hide its own." control={(id) => <Toggle id={id} checked={t.widgetRow} disabled={api.pending} onChange={(v) => void api.save({ tavern: { widgetRow: v } })} />} />
    <Row label="Batch wake events" setting="tavern.batchWakeEvents" help="Off by default. When on, a wake the Keeper gets from a new event waits a short window so a burst gathers into one turn. Regular sweep ticks ignore this and always carry every unread event." control={(id) => <Toggle id={id} checked={t.batchWakeEvents} disabled={api.pending} onChange={(v) => void api.save({ tavern: { batchWakeEvents: v } })} />} />
</SettingsCard>
  </>; }}</Shell>;
}

function CharacterQuietRow({ until, api }: { until: number; api: Api }) {
  const quiet = useCharacterQuiet(until);
  const local = new Date(until);
  const two = (n: number) => String(n).padStart(2, "0");
  const saved = quiet ? `${String(local.getFullYear()).padStart(4, "0")}-${two(local.getMonth() + 1)}-${two(local.getDate())}T${two(local.getHours())}:${two(local.getMinutes())}` : "";
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const save = (end: number) => void api.save(characterQuietPatch(end));
  const commit = () => {
    if (draft === saved) return;
    const end = new Date(draft).getTime();
    if (end > Date.now()) save(end);
    else setDraft(saved);
  };
  return <Row label={quiet ? "Quiet until" : "Character quiet"} setting="tavern.characterQuietUntil"
    help="Keeps characters still and silent until this time, without changing their motion or speech settings."
    control={id => <span className="tv-quiet">
      <input id={id} aria-label="Quiet until" type="datetime-local" className="tv-text" value={draft} disabled={api.pending}
        onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(saved);
        }} />
      {quiet ? <button type="button" className="btn sm" onClick={() => save(0)} disabled={api.pending}>End now</button>
        : <button type="button" className="btn sm" onClick={() => save(Date.now() + CHARACTER_QUIET_HOUR_MS)} disabled={api.pending}>Quiet for an hour</button>}
    </span>} />;
}

export function AtmosphereSection() {
  const api = useTavernSettings();
  const navigate = useBbNavigate();
  return <Shell api={api} className="tv-set-atmosphere">{d => { const t = d.effective.tavern; return <>
    <SettingsCard title="The party" hint="Choose how characters appear and open their sheets to roll new avatars." glyph="shield">
      <Row label="Show characters" setting="tavern.characters" help="Draws the pixel-art characters above the composer. Off leaves the class crest in the widget row." control={id => <Toggle id={id} checked={t.characters} disabled={api.pending} onChange={v => void api.save(charactersPatch(v))} />} />
      <Row label="Speech bubbles" setting="tavern.voice" coveredBy={["tavern.voiceBeforeOff"]} help={VOICE_HELP[t.voice]} control={() => <SegFilter label="Speech bubbles" value={t.voice} onChange={v => void api.save(voicePatch(v, t.voice))} options={[{ id: "full", label: "Full" }, { id: "light", label: "Light" }, { id: "off", label: "Off" }]} />} />
      <Row label="Levels and crest notches" setting="tavern.levels" help="Shows levels and crest notches earned from verified work. Off hides them without changing what characters have earned." control={id => <Toggle id={id} checked={t.levels} disabled={api.pending} onChange={v => void api.save({ tavern: { levels: v } })} />} />
      <div className="tv-set-links"><button type="button" className="tv-ilink act" onClick={() => navigate.toPluginPanel("tavern", { subPath: "characters" })}><span>Character sheets</span><OpensMark /></button></div>
    </SettingsCard>
    <SettingsCard title="Motion" hint="Choose how the tavern moves while work runs." glyph="lantern">
      <Row label="Ambient motion" setting="tavern.ambientMotion" coveredBy={["tavern.hearthFlicker"]} help="Calm uses brief cues and keeps characters in place. Lively lets working characters walk and repeats ambient cues. Off keeps the characters and hearth still and stops ambient repeats." control={() => <SegFilter label="Ambient motion" value={t.hearthFlicker ? t.ambientMotion : "off"} onChange={v => void api.save(ambientMotionPatch(v))} options={[{ id: "calm", label: "Calm" }, { id: "lively", label: "Lively" }, { id: "off", label: "Off" }]} />} />
      <CharacterQuietRow until={t.characterQuietUntil} api={api} />
      <Row label="Repeat every" setting="tavern.repeatSeconds" help="In Lively, sets how often the hearth flickers, the party takes steps on the board and the widget pulses." control={id => <NumberField id={id} value={t.repeatSeconds} min={3} max={60} unit="seconds" disabled={api.pending} onSave={v => void api.save({ tavern: { repeatSeconds: v } })} />} />
    </SettingsCard>
    <SettingsCard title="Lantern" hint="Choose how carried lanterns and hearth-lights warm the thread." glyph="lantern">
      <Row label="Lantern light" setting="tavern.lanternLight" help="Adds a pixel halo around the flame and a warm pool below it. Off removes the light without hiding the character." control={id => <Toggle id={id} checked={t.lanternLight} disabled={api.pending} onChange={v => void api.save({ tavern: { lanternLight: v } })} />} />
      <Row label="Strength" setting="tavern.lanternStrength" help="Changes how strongly the halo, pool and nearby edges glow." control={id => <select id={id} className="tv-select" value={t.lanternStrength} disabled={api.pending} onChange={e => void api.save({ tavern: { lanternStrength: e.target.value as typeof t.lanternStrength } })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select>} />
      <Row label="Light bb's surfaces" setting="tavern.lanternLightBb" help="Lights the nearby edges of the composer box and message bubbles, never the text. Off keeps the light on Tavern's own surfaces." control={id => <Toggle id={id} checked={t.lanternLightBb} disabled={api.pending} onChange={v => void api.save({ tavern: { lanternLightBb: v } })} />} />
    </SettingsCard>
    <SettingsCard title="Character cues" hint="Choose how long poses last." glyph="shield"><NumberKnobRows group="tavern" /></SettingsCard>
  </>; }}</Shell>;
}

export function AwaySettingsSection() {
  const api = useTavernSettings();
  return <Shell api={api}>{d => {
    const a = d.effective.away;
    return <SettingsCard title="Defaults for Closing time" hint="Changes prepare your next window. They do not widen ordinary scopes or alter a stop list already in force." glyph="lantern" guardrail>
      <div className="tv-set-row tv-set-ro" data-setting-keys="away.neverWhileClosed"><AwayStopChoices items={a.neverWhileClosed} disabled={api.pending} onChange={items => void api.save({ away: { neverWhileClosed: items } })} /><SettingDefault setting="away.neverWhileClosed" /></div>
      <NumberKnobRows group="away" />
      <Row label="Default quest end" setting="away.defaultEndState" control={id => <select id={id} className="tv-select" value={a.defaultEndState} disabled={api.pending} onChange={e => void api.save({ away: { defaultEndState: e.target.value as "pause" | "drafts-ready" } })}><option value="drafts-ready">Drafts ready</option><option value="pause">Pause</option></select>} />
      {([["defaultAllowWatched","Let watched members keep drafting by default"],["defaultWakeBlockers","Wake me for blockers by default"],["defaultWakeProduction","Wake me for waiting production or cluster write asks by default"]] as const).map(([key,label]) => <Row key={key} setting={`away.${key}`} label={label} control={id => <Toggle id={id} checked={a[key]} disabled={api.pending} onChange={v => void api.save({ away: { [key]: v } })} />} />)}
    </SettingsCard>;
  }}</Shell>;
}

function SettingsAuthors({ history, children }: { history: SettingsView["history"]; children: (names: ReturnType<typeof useSidebarActorNames>) => ReactNode }) {
  const names = useSidebarActorNames(history.flatMap(c => c.threadId ? [c.threadId] : []));
  return children(names);
}

export function SettingAuthor({ threadId, by, label = "another thread", sentenceStart = false }: { threadId?: string | null; by: "user" | "keeper" | "tavern"; label?: string; sentenceStart?: boolean }) {
  const navigate = useBbNavigate();
  if (!threadId) return <>{WHO[by]}</>;
  const link = <button type="button" className="tv-ilink act" onClick={() => navigate.toThread(threadId)}>{label}</button>;
  return by === "keeper" ? <>{link} (Keeper)</> : <>{sentenceStart ? "An" : "an"} agent in {link}</>;
}

function historySection(key: string) {
  const path = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  if (path === "knobs.rangerTimeboxMaxMinutes") return "Keepers and decisions";
  if (/^tavern\.(characters|voice|voiceBeforeOff|levels|ambientMotion|hearthFlicker|characterQuietUntil|repeatSeconds|lanternLight|lanternStrength|lanternLightBb|reportedPoseSeconds|verifiedPoseMinutes)$/.test(path)) return "Atmosphere";
  if (/^(knobs|tuned|overrides|tuning\.pinned)\./.test(path)) return "Tuning";
  return ({tavern:"Tavern",away:"Closing time",attention:"Your attention",keepers:"Keepers and decisions",classes:"Classes and models",scopes:"Scopes",machines:"Where work runs",journal:"Journal",tuning:"Tuning",data:"Data and backups",backup:"Data and backups"} as Record<string,string>)[path.split(".")[0]!] ?? "Settings";
}

function defaultWords(key: SettingKey, value: unknown): string {
  if (key === "keepers.greenlight") return value === "explicit" ? "Always ask me" : "By size";
  if (key === "away.defaultEndState") return value === "drafts-ready" ? "Drafts ready" : "Pause";
  if (key === "tavern.defaultClass" && value === "none") return "None (an ordinary thread)";
  if (key === "attention.quietHours" && value === null) return "Off";
  if (key === "away.defaultBackAtHour") return `${String(value).padStart(2, "0")}:00`;
  const [group, field] = key.split(".");
  const numberRule = (KNOB_FIELDS[group as keyof typeof KNOB_FIELDS] as Record<string, {unit: string}> | undefined)?.[field!];
  if (numberRule && typeof value === "number") return `${value.toLocaleString("en")} ${numberRule.unit}`;
  return historyValue(key, value);
}

function historyValue(key: string, value: unknown): string {
  if (value === null) return "Default";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (Array.isArray(value) && key === "scopes.sendTools") return value.length ? plural(value.length, "tool rule") : "None";
  if (Array.isArray(value)) return value.length ? value.map(item => key === "away.neverWhileClosed" ? AWAY_STOP_LABELS[item as keyof typeof AWAY_STOP_LABELS] : ALWAYS_WORDS[item as keyof typeof ALWAYS_WORDS] ?? String(item)).join(", ") : "None";
  if (typeof value === "object") return Object.entries(value).map(([k,v]) => `${settingLabel(`${key}.${k}`)}: ${historyValue(`${key}.${k}`,v)}`).join(", ");
  if (key === "knobs.rangerTimeboxMaxMinutes") return `${value} min`;
  if (key === "tavern.repeatSeconds") return `${value} s`;
  if (key === "tavern.characterQuietUntil" && typeof value === "number") return value === 0 ? "Off" : new Date(value).toLocaleString();
  if (key.startsWith("data.") || key === "backup.keep") return `${value} ${key === "backup.keep" || key === "data.backupKeep" ? "backups" : "days"}`;
  if (/^(knobs|tuned|tuning\.pinned)\./.test(key)) return knobValue(key.replace(/^(?:tuning\.pinned|tuned)\./,"knobs."),value);
  return typeof value === "string" && ["full","light","off","all","none","calm","lively","apply","suggest","enforce","watch","consequential"].includes(value) ? value.charAt(0).toUpperCase() + value.slice(1) : String(value);
}

type DisplayClasses = NonNullable<ReturnType<typeof useRegistry>["data"]>["classes"];
type DisplayProviders = ReturnType<typeof experimental_useProviders>["providers"];
function ModelName({ value }: { value: string }) {
  return <span title={value}>{value.split("/").at(-1) || value}</span>;
}
function HistoryKeys({ changes, classes, providers }: { changes: Change[]; classes: DisplayClasses; providers: DisplayProviders }) {
  const label = (key: string) => {
    const match = key.match(/^classes\.([^.]+)\.(provider|model|reasoning)$/);
    const cls = match && classes.find(c => c.id === match[1]);
    return cls ? `${cls.label} ${match![2]}` : settingLabel(key);
  };
  const value = (key: string, stored: unknown): ReactNode => {
    key = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    if (typeof stored === "string") {
      if (/^classes\.[^.]+\.model$/.test(key)) return <ModelName value={stored} />;
      if (/^classes\.[^.]+\.provider$/.test(key)) return providers.find(p => p.id === stored)?.displayName ?? stored;
      if (key === "keepers.greenlight") return ({ explicit: "Always ask me", "by-size": "By size" } as Record<string, string>)[stored] ?? stored;
      if (key === "tavern.defaultClass") {
        const cls = classes.find(c => c.id === stored);
        return cls ? `${cls.label} (${cls.plain})` : stored === "none" ? "None (an ordinary thread)" : stored;
      }
    }
    return historyValue(key, stored);
  };
  return <ul className="tv-settings-keys">{changes.map((change,i)=><li key={`${change.key}-${i}`}>{historySection(change.key)} · {label(change.key)}: {value(change.key,change.from)} to {value(change.key,change.to)}{change.kind==="pin"?" (pinned)":change.kind==="unpin"?" (unpinned)":""}</li>)}</ul>;
}

export function SettingsHistorySection() {
  const api = useTavernSettings();
  const registry = useRegistry();
  const providers = experimental_useProviders();
  const undo = experimental_useRpcMutation({contract:settingsContract,method:"settingsUndo"});
  const [open,setOpen] = useRemembered("settings-history:open",false,(v):v is boolean=>typeof v==="boolean");
  const [all,setAll] = useState(false);
  const [error,setError] = useState<string | null>(null);
  const id=useId();
  return <Shell api={api}>{d => {
    const history=[...d.history].sort((a,b)=>b.at-a.at);
    return <SettingsCard title="Changes to settings" hint="Read what changed, why it changed and who changed it." glyph="undo">
      {error && <ReadState error={{message:error}} retry={()=>setError(null)} />}
      <button type="button" className="tv-history-toggle act" aria-expanded={open} aria-controls={open ? id : undefined} onClick={()=>setOpen(!open)}><ExpandsMark open={open} /><span>{plural(history.length,"change")}</span></button>
      {open && <div id={id}><SettingsAuthors history={all?history:history.slice(0,10)}>{names=><ul className="tv-settings-history">{(all?history:history.slice(0,10)).map(c=><li className="tv-settings-change" key={c.id}>
        <div><HistoryKeys changes={c.changes.slice(0,3)} classes={registry.data?.classes ?? []} providers={providers.providers} />{c.changes.length>3 && <details className="tv-history-more"><FoldSummary>{plural(c.changes.length-3,"more setting")}</FoldSummary><HistoryKeys changes={c.changes.slice(3)} classes={registry.data?.classes ?? []} providers={providers.providers} /></details>}
        <p>{c.reason}</p><p className="tv-history-author">By <SettingAuthor threadId={c.threadId} by={c.by} label={c.threadId?names(c.threadId,{mid:true}):undefined} /> <TimeAgo at={c.at} />{c.undoneAt && " (undone)"}</p></div>
        {c.undoable && <button type="button" className="lnk-btn act" disabled={undo.isPending} onClick={()=>void undo.mutate({id:c.id,revision:d.revision,why:"Undo settings change"}).then(()=>api.refetch()).catch(e=>setError(String(e)))}>Undo</button>}
      </li>)}</ul>}</SettingsAuthors>{!history.length && <p>No settings changes yet.</p>}{!all && history.length>10 && <button type="button" className="btn sm" onClick={()=>setAll(true)}>Show all</button>}</div>}
    </SettingsCard>;
  }}</Shell>;
}
const ALERT_HOLD_WORDS: Record<HoldReason, string> = {
  "mode-none": "Push alerts are off in Tavern.",
  "quiet-hours": "Quiet hours held this alert.",
  "closed-window": "Closing time held this alert.",
  "plugin-missing": "The bb Push Notifications plugin is not installed.",
  "plugin-disabled": "The bb Push Notifications plugin is turned off.",
};

function testAlertWords(test: AlertRouteView["lastTest"]) {
  if (!test) return "No test alert yet.";
  if (test.outcome === "held") return ALERT_HOLD_WORDS[test.reason];
  if (test.outcome === "failed") return `Tavern could not send the test: ${test.error}`;
  if (test.response === "arrived") return "You confirmed it arrived.";
  if (test.response === "not-arrived") return "You said it did not arrive.";
  return "Tavern sent the test. Did it arrive on your device?";
}

function AlertRouteCard() {
  const route = experimental_useRpcQuery({ contract: alertRouteContract, method: "alertRoute", input: null });
  const sendTest = experimental_useRpcMutation({ contract: alertRouteContract, method: "alertTestSend" });
  const confirm = experimental_useRpcMutation({ contract: alertRouteContract, method: "alertTestConfirm" });
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const run = async (act: () => Promise<AlertRouteView>) => {
    setProblem(null);
    setPending(true);
    try { await act(); }
    catch (error) { setProblem(error instanceof Error ? error.message : String(error)); }
    finally {
      try { await route.refetch(); }
      finally { setPending(false); }
    }
  };
  const test = route.data?.lastTest;
  const awaiting = test?.outcome === "sent" && test.response === null;
  const failure = route.data?.lastFailure;
  return <SettingsCard title="Test your alerts" hint="Send a test through bb and check your device. You can send a test even during quiet hours." glyph="you">
    {!route.data ? <ReadState error={route.error} retry={route.refetch} /> : <div className="tv-alert-route">
      <div role="status"><p>{test && <>Last test <TimeAgo at={test.at} />. </>}<span>{testAlertWords(test ?? null)}</span></p></div>
      {problem && <p className="tv-problem" role="alert">{problem}</p>}
      <div className="tv-alert-actions">
        {awaiting ? <>
          <button type="button" className="btn pri" disabled={pending} onClick={() => void run(() => confirm.mutate({ id: test.id, arrived: true }))}>It arrived</button>
          <button type="button" className="btn" disabled={pending} onClick={() => void run(() => confirm.mutate({ id: test.id, arrived: false }))}>It did not</button>
        </> : <button type="button" className="btn pri" disabled={pending} onClick={() => void run(() => sendTest.mutate({}))}>{pending ? "Sending…" : "Send a test alert"}</button>}
      </div>
      {failure ? <p className="m">Last real alert failure <TimeAgo at={failure.at} />: <span>{failure.error}</span></p> : <p className="m">No real alert failures recorded.</p>}
    </div>}
  </SettingsCard>;
}

export function AttentionSection() {
  const api = useTavernSettings();
  return <Shell api={api}>{(d) => { const a = d.effective.attention; const q = a.quietHours; return <><SettingsCard title="What reaches you" hint="Set your review capacity and when asks reach your devices." glyph="you" guardrail>
    <Row label="Review budget" setting="attention.reviewBudget" help="Items waiting on your review before Keepers stop opening new work." control={(id) => <NumberField id={id} value={a.reviewBudget} min={1} max={30} unit="items" disabled={api.pending} onSave={(v) => void api.save({ attention: { reviewBudget: v } })} />} />
    <Row label="Push to your devices" setting="attention.notify" help="Which asks send a notification." control={() => <SegFilter label="Push to your devices" value={a.notify} onChange={(v) => void api.save({ attention: { notify: v } })} options={[{ id: "consequential", label: "Consequential" }, { id: "all", label: "All" }, { id: "none", label: "None" }]} />} />
    <Row label="Quiet hours" setting="attention.quietHours" help="Ordinary pushes are not sent in this window; a test alert still is." control={(id) => <span className="tv-quiet">
      <Toggle id={id} checked={!!q} disabled={api.pending} onChange={(v) => void api.save({ attention: { quietHours: v ? { start: "22:00", end: "07:30", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } : null } })} />
      {q && <><label className="sr" htmlFor={`${id}-s`}>Quiet from</label><input id={`${id}-s`} type="time" className="tv-text tv-time" value={q.start} disabled={api.pending} onChange={(e) => e.target.value && void api.save({ attention: { quietHours: { ...q, start: e.target.value } } })} /><span className="m">to</span><label className="sr" htmlFor={`${id}-e`}>Quiet until</label><input id={`${id}-e`} type="time" className="tv-text tv-time" value={q.end} disabled={api.pending} onChange={(e) => e.target.value && void api.save({ attention: { quietHours: { ...q, end: e.target.value } } })} /><span className="m small">{q.timeZone}</span></>}
    </span>} />
  </SettingsCard><AlertRouteCard /></>; }}</Shell>;
}

const ALWAYS_WORDS: Record<typeof ALWAYS_ASK_KINDS[number], string> = { production: "Production", merge: "Merge", credential: "Credentials", "sends-as-you": "Pull request edits and closes", destructive: "Delete what the quest did not make" };
export function KeepersSection() {
  const api = useTavernSettings();
  return <Shell api={api}>{(d) => { const k = d.effective.keepers; return <><SettingsCard title="Delegated decisions" hint="Set the decisions and staffing a Keeper may handle." glyph="you" guardrail>
    <Row label="Greenlight" setting="keepers.greenlight" help={k.greenlight === "explicit" ? "You approve every quest map before work starts." : "Plans with one member and only reversible steps start and tell you; bigger ones wait for you."} control={() => <SegFilter label="Greenlight" value={k.greenlight} onChange={(v) => void api.save({ keepers: { greenlight: v } })} options={[{ id: "explicit", label: "Always ask me" }, { id: "by-size", label: "By size" }]} />} />
    <Row label="Longest decision timer" setting="keepers.decisionTimerMax" help={`The longest a Keeper may wait before a reversible decision applies its recommendation: now ${formatValue(k.decisionTimerMax * 60, "s")}. Timers stay opt-in per ask.`} control={(id) => <NumberField id={id} value={k.decisionTimerMax} min={1} max={10080} unit="min" disabled={api.pending} onSave={(v) => void api.save({ keepers: { decisionTimerMax: v } })} />} />
    <Row label="Party ceiling" setting="keepers.partyMax" help="Most live party members across all of a Keeper's quests at once, not a per-quest limit. A quest map still holds at most 8, and class files set per-class budgets beneath it." control={(id) => <NumberField id={id} value={k.partyMax} min={1} max={1000} unit="members" disabled={api.pending} onSave={(v) => void api.save({ keepers: { partyMax: v } })} />} />
    <Row label="Lead chain depth" setting="keepers.chainDepth" help="How many layers of leads a Keeper can hire below the root. One layer lets the root hire leads, but those leads cannot hire another layer." control={(id) => <NumberField id={id} value={k.chainDepth} min={1} max={3} unit="layers" disabled={api.pending} onSave={(v) => void api.save({ keepers: { chainDepth: v } })} />} />
    <Row label="Lead chain ceiling" setting="keepers.chainMembers" help="Most seats in the entire linked party, including leads and reserved hires but not the root Keeper. Changes apply to new hires." control={(id) => <NumberField id={id} value={k.chainMembers} min={1} max={1000} unit="members" disabled={api.pending} onSave={(v) => void api.save({ keepers: { chainMembers: v } })} />} />
    <Row label="Ranger check-in interval" setting="knobs.rangerTimeboxMaxMinutes" help="How long a Ranger scouts before it reports to its Keeper, who continues it or accepts the work." control={(id) => <NumberField id={id} value={d.effective.knobs.rangerTimeboxMaxMinutes} min={3} max={30} unit="min" disabled={api.pending} onSave={(v) => void api.save({ knobs: { rangerTimeboxMaxMinutes: v } })} />} />
    <div className="tv-set-row tv-set-ro" data-setting-keys="keepers.alwaysAsk">
      <fieldset className="tv-grpbox tv-away-stops" disabled={api.pending}><legend>Always ask</legend>
        <p className="m small">Unchecked kinds go to the Keeper on every quest. It decides and records each one, or asks you when unsure. A merge or production change still needs a Warden’s check of the exact commit or command.</p>
        <p className="m small">Cluster writes always ask you and cannot be delegated.</p>
        {ALWAYS_ASK_KINDS.map(kind => <label key={kind} className="tv-chk"><input type="checkbox" checked={k.alwaysAsk.includes(kind)}
          onChange={e => void api.save({ keepers: { alwaysAsk: ALWAYS_ASK_KINDS.filter(item => item === kind ? e.target.checked : k.alwaysAsk.includes(item)) } })} /><span>{ALWAYS_WORDS[kind]}</span></label>)}
      </fieldset><SettingDefault setting="keepers.alwaysAsk" />
    </div>
    </SettingsCard><SettingsCard title="Check-ins and memory" hint="Set reminders and open the advanced limits to adjust Keeper pacing and memory." glyph="file">
    <Row label="Rest before reminder" setting="keepers.restMinutes" help="Remind the Keeper once after this much settled rest. The Keeper decides whether to release or keep the member; Tavern never releases on a timer." control={(id) => <NumberField id={id} value={k.restMinutes} min={1} max={10080} unit="min" disabled={api.pending} onSave={(v) => void api.save({ keepers: { restMinutes: v } })} />} />
    <Row label="Strikes before release advice" setting="keepers.staleStrikes" help="Missed check-ins before Tavern advises releasing a quiet member. Yours to set; the tuner never changes this safety threshold." control={(id) => <NumberField id={id} value={k.staleStrikes} min={1} max={4} unit="strikes" disabled={api.pending} onSave={(v) => void api.save({ keepers: { staleStrikes: v } })} />} />


    <AgentLimits title="Keeper pacing and memory" hint="These limits guide Keepers and Tavern. They are not auto-tuned." groups={["keepers"]} />
  </SettingsCard></>; }}</Shell>;
}

/** reasoning: null is the model's own default thinking; left out, the class file's level applies. */
type ClassOverride = { provider?: string; model?: string; reasoning?: string | null };
type ClassDefaults = { provider: string | null; model: string | null; reasoning: string | null };
const describeExecution = (e: ClassDefaults | ClassOverride, providers: DisplayProviders, chosen = false) => <>{e.model ? <ModelName value={e.model} /> : "the agent's default model"}{e.reasoning ? `, ${e.reasoning} thinking` : chosen && e.reasoning === null ? ", the model's default thinking" : null}{e.provider && `, on ${providers.find(p => p.id === e.provider)?.displayName ?? e.provider}`}</>;

/** bb's own agent, model and thinking picker for one class; until one is chosen, the class file decides. */
function ClassExecution({ label, defaults, override, onSave }: { label: string; defaults: ClassDefaults; override: ClassOverride; onSave: (next: ClassOverride | null) => void | Promise<void> }) {
  const providers = experimental_useProviders();
  const [seed, setSeed] = useState<ExperimentalProviderModelPickerValue | null>(null);
  const [draft, setDraft] = useState<ExperimentalProviderModelPickerValue | null>(null);
  const [saving, setSaving] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const pending = useRef<ExperimentalProviderModelPickerValue | null>(null);
  const save = useRef(onSave);
  save.current = onSave;
  const touched = useRef(false);
  const touch = () => { touched.current = true; };
  const firstAvailable = providers.providers.find((p) => p.available)?.id ?? null;
  const chosen = override.model !== undefined || override.provider !== undefined || override.reasoning !== undefined;
  const providerId = override.provider ?? defaults.provider ?? firstAvailable;
  const persist = useCallback(async (next: ExperimentalProviderModelPickerValue | null) => {
    pending.current = null;
    touched.current = false;
    setSaving(n => n + 1);
    setError(null);
    try {
      await save.current(next ? { provider: next.providerId, ...(next.model ? { model: next.model } : {}), reasoning: next.reasoningLevel || null } : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(n => n - 1);
    }
  }, []);
  const commit = useCallback(() => {
    if (!touched.current || !pending.current || root.current?.querySelector('[aria-expanded="true"]')) return;
    void persist(pending.current);
  }, [persist]);
  const change = useCallback((next: ExperimentalProviderModelPickerValue) => {
    setDraft(next);
    if (!touched.current) return;
    pending.current = next;
    commit();
  }, [commit]);
  useEffect(() => {
    if (!root.current) return;
    commit();
    // The host picker exposes its open state through its trigger, but has no onOpenChange prop.
    const observer = new MutationObserver(commit);
    observer.observe(root.current, { subtree: true, attributes: true, attributeFilter: ["aria-expanded"], childList: true });
    return () => observer.disconnect();
  });
  useEffect(() => { if (!touched.current && !pending.current) setDraft(null); }, [override.provider, override.model, override.reasoning]);
  const fileLine = <span className="tv-exec-d">Class file: {describeExecution(defaults, providers.providers)}</span>;
  const editing = chosen || seed !== null;
  const value = draft ?? (chosen ? { providerId: providerId ?? "", model: override.model ?? "", reasoningLevel: override.reasoning ?? "" } : seed!);
  return <div ref={root} className={`tv-exec${!chosen && seed ? " tv-exec-draft" : ""}`}
    onPointerDownCapture={touch} onClickCapture={touch} onKeyDownCapture={(e) => { if (e.key !== "Tab" && e.key !== "Shift" && e.key !== "Escape") touch(); }}>
    {!chosen && fileLine}
    {chosen && !providerId && <span className="tv-exec-d">Set here: {describeExecution(override, providers.providers, true)}{providers.status === "loading" ? " (loading agents)" : ""}</span>}
    {editing && providerId && <ProviderModelPicker key="picker" value={value} onChange={chosen ? change : setSeed} align="end" />}
    {saving > 0 && <span role="status">Saving {label}…</span>}
    {error && <span role="alert">{error}</span>}
    {chosen ? <button type="button" className="lnk-btn act" disabled={saving > 0} onClick={() => { setDraft(null); setSeed(null); void persist(null); }} aria-label={`Use the class file for ${label}`}><span>Use the class file</span></button>
      : seed ? <>
        <button type="button" className="btn sm pri" disabled={saving > 0 || !seed.model} aria-label={`Save model and thinking for ${label}`} title={!seed.model ? "Pick a model first" : undefined} onClick={() => { setDraft(seed); void persist(seed); }}><span>Save</span></button>
        <button type="button" className="lnk-btn act" onClick={() => { touched.current = false; pending.current = null; setSeed(null); setDraft(null); }} aria-label={`Cancel choosing for ${label}`}><span>Cancel</span></button>
      </> : <button type="button" className="btn sm" disabled={!providerId} aria-label={`Choose model and thinking for ${label}`}
        title={!providerId ? (providers.status === "loading" ? "Loading agents" : "No agent is available") : undefined}
        onClick={() => { touched.current = false; if (providerId) setSeed({ providerId, model: defaults.model ?? "", reasoningLevel: defaults.reasoning ?? "" }); }}><span>Choose model and thinking</span></button>}
  </div>;
}

function WardenQualitySetting() {
  const quality = experimental_useRpcQuery({ contract: insightsContract, method: "wardenQuality", input: null });
  return <div className="tv-set-warden-quality">{quality.data ? <WardenQualitySection data={quality.data} settings />
    : quality.error ? <div className="tv-problem" role="alert"><span>Could not load Warden quality.</span><button type="button" className="btn sm" onClick={() => void quality.refetch()}>Try again</button></div>
      : <p className="tv-isec-cap" role="status">Loading Warden quality…</p>}</div>;
}

export function ClassesSection() {
  const api = useTavernSettings();
  const registry = useRegistry();
  const navigate = useBbNavigate();
  return <Shell api={api}>{(d) => <SettingsCard title="Class execution" hint="Choose models and thinking without changing class files." glyph="file">
    <p className="tv-set-intro">A class with no choice here uses its class file, which stays the source of everything else.</p>
    <div className="tv-set-links"><button type="button" className="tv-ilink act" onClick={() => navigate.toPluginPanel("tavern", { subPath: "classes" })}><span>Classes</span><OpensMark /></button><button type="button" className="tv-ilink act" onClick={() => navigate.toPluginPanel("tavern", { subPath: "characters" })}><span>Character sheets</span><OpensMark /></button></div>
    {!registry.data ? <ReadState error={registry.error} retry={registry.refetch} /> : registry.data.classes.map((c) => {
      const override: ClassOverride = { ...d.effective.classes[c.id] };
      return <div key={c.id} className="tv-set-row tv-set-class">
        <div className="tv-set-l"><span className="tv-set-lbl">{c.label} <span className="anc">{c.plain}</span></span></div>
        <div className="tv-set-c"><ClassExecution label={c.label} defaults={{ provider: c.provider, model: c.model, reasoning: c.reasoning }} override={override}
          onSave={async (next) => { const entry: ClassOverride = next ?? {}; await api.save({ classes: { [c.id]: entry } }); }} /></div>
        {c.id === "warden" && <WardenQualitySetting />}
      </div>;
    })}
  </SettingsCard>}</Shell>;
}

function SendToolsEditor({ rules, api }: { rules: SendTools; api: Api }) {
  const [edit, setEdit] = useState<SendTools | null>(null);
  const [error, setError] = useState<string>();
  const draft = edit ?? rules;
  function update(index: number, change: Partial<SendTools[number]>) {
    setEdit(draft.map((rule, i) => i === index ? { ...rule, ...change } : rule));
    setError(undefined);
  }
  async function save() {
    const checked = sendToolsSchema.safeParse(draft.map(({ pattern, shell, act, targetKey }) => shell !== undefined ? { shell: shell.trim(), act } : { pattern: pattern?.trim(), act, ...(targetKey?.trim() ? { targetKey: targetKey.trim() } : {}) }));
    if (!checked.success) { setError("Use a tool name with a literal part, or a shell prefix with literal words."); return; }
    setError(undefined);
    try { if (await api.save({ scopes: { sendTools: checked.data } })) setEdit(null); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  return <div className="tv-message-settings" data-setting-keys="scopes.sendTools">
    <p className="m">Default: none</p>
    {rules.length > 0 && <button type="button" className="btn" disabled={api.pending} onClick={() => void api.reset("scopes.sendTools")}>Reset to default</button>}
    {!draft.length && <p>No send or draft rules are listed.</p>}
    {draft.map((rule, index) => <fieldset key={index} className="tv-message-rule">
      <legend>Tool rule {index + 1}</legend>
      <label>{rule.shell === undefined ? "Tool name pattern" : "Shell command prefix"}<input className="tv-text" value={rule.shell ?? rule.pattern ?? ""} maxLength={200} disabled={api.pending} onChange={e => update(index, rule.shell === undefined ? { pattern: e.target.value } : { shell: e.target.value })} /></label>
      <label>Act<select className="tv-select" value={rule.act} disabled={api.pending} onChange={e => update(index, { act: e.target.value === "draft" ? "draft" : "send" })}><option value="send">Send</option><option value="draft">Draft</option></select></label>
      {rule.shell === undefined && <label>Target key<input className="tv-text" value={rule.targetKey ?? ""} maxLength={120} disabled={api.pending} onChange={e => update(index, { targetKey: e.target.value })} /></label>}
      <button type="button" className="btn" aria-label={`Remove tool rule ${index + 1}`} disabled={api.pending} onClick={() => setEdit(draft.filter((_, i) => i !== index))}>Remove</button>
    </fieldset>)}
    {error && <p role="alert" className="tv-problem">{error}</p>}
    <div className="tv-message-actions"><button type="button" className="btn" disabled={api.pending || draft.length >= 100} onClick={() => setEdit([...draft, { pattern: "", act: "send" }])}>Add tool rule</button><button type="button" className="btn" disabled={api.pending || draft.length >= 100} onClick={() => setEdit([...draft, { shell: "", act: "send" }])}>Add shell rule</button>
      {edit && <><button type="button" className="btn pri" disabled={api.pending} onClick={() => void save()}>Save tool rules</button><button type="button" className="btn" disabled={api.pending} onClick={() => { setEdit(null); setError(undefined); }}>Cancel</button></>}
    </div>
  </div>;
}

export function ScopesSection() {
  const api = useTavernSettings();
  return <Shell api={api}>{(d) => <><SettingsCard title="Member guardrails" hint="Choose whether ordinary scope rules stop actions or only record them." glyph="lock" guardrail>
    <Row label="Scopes" setting="scopes.mode" help={d.effective.scopes.mode === "enforce" ? "A turn that breaks its scope rules is stopped." : d.effective.scopes.mode === "watch" ? "Ordinary violations are recorded, not stopped." : "Ordinary scope rules are off."} control={() => <SegFilter label="Scopes" value={d.effective.scopes.mode} onChange={(v) => void api.save({ scopes: { mode: v } })} options={[{ id: "enforce", label: "Enforce" }, { id: "watch", label: "Watch" }, { id: "off", label: "Off" }]} />} />
    <p className="tv-set-intro">Keepers and hired Wanderers use the open preset. Rangers read, Wardens check, and Smiths build in their worktree. Settings guardrails and user approvals still apply.</p>
    <p className="tv-set-intro">Restart an older session to clear its old Git and GitHub environment blocks. Policy files live in <code>~/.agents/tavern/scopes.yml</code> and each project's <code>.agents/tavern/</code>.</p>
  </SettingsCard><SettingsCard title="Sending and drafting" hint="Match a tool name with an asterisk, or enter the literal first words of a shell command. A tool rule can name the input key for its target." glyph="lock" guardrail>
    <p className="tv-set-intro">Guarded agents cannot use listed send tools or commands, even in Watch or Off. Draft tools ask first. Restart sessions that still run an older guard; sessions without a working guard are not prevented.</p>
    <SendToolsEditor key={d.revision} rules={d.effective.scopes.sendTools} api={api} />
  </SettingsCard></>}</Shell>;
}

export function JournalSection() {
  const api = useTavernSettings();
  return <Shell api={api}>{(d) => { const j = d.effective.journal; return <SettingsCard title="Journal reminders" hint="Choose when a quiet journal gets a reminder." glyph="file">
    <Row label="Journal reminders" setting="journal.journalReminders" help="Nudge a thread that has worked a while without updating its journal." control={(id) => <Toggle id={id} checked={j.journalReminders} disabled={api.pending} onChange={(v) => void api.save({ journal: { journalReminders: v } })} />} />
    <Row label="Quiet before a reminder" setting="journal.journalQuietMinutes" control={(id) => <NumberField id={id} value={j.journalQuietMinutes} min={1} max={120} unit="min" disabled={api.pending || !j.journalReminders} onSave={(v) => void api.save({ journal: { journalQuietMinutes: v } })} />} />
    <NumberKnobRows group="journal" />
    <p className="tv-set-intro">Old pi-quests logs are imported on first touch, and the originals are kept. Turn pi-quests off when you adopt Tavern, so only one plugin owns the journal tool.</p>
  </SettingsCard>; }}</Shell>;
}

export function DataSection() {
  const api = useTavernSettings();
  return <Shell api={api}>{(d) => { const x = d.effective.data; return <SettingsCard title="Retention" hint="Choose how long records stay and when quests leave the board." glyph="archive">
    <Row label="Keep history" setting="data.historyDays" help={x.historyDays === 0 ? "0 keeps everything, as today." : `Events older than ${x.historyDays} days are removed.`} control={(id) => <NumberField id={id} value={x.historyDays} min={0} max={3650} unit="days" disabled={api.pending} onSave={(v) => void api.save({ data: { historyDays: v } })} />} />
    <Row label="Send returned quests to the cellar after" setting="data.autoArchiveDays" help={x.autoArchiveDays === 0 ? "0 = never. Sending a quest to the cellar marks it done, so by default only you do it." : `Returned quests go to the cellar after ${plural(x.autoArchiveDays, "day")}. 0 = never.`} control={(id) => <NumberField id={id} value={x.autoArchiveDays} min={0} max={3650} unit="days" disabled={api.pending} onSave={(v) => void api.save({ data: { autoArchiveDays: v } })} />} />
  </SettingsCard>; }}</Shell>;
}

const TUNING_HELP = { apply: "Tavern changes the settings below within their bounds and records each change in Decided for you, with Undo.", suggest: "Insights shows each change with an Apply button; nothing changes on its own.", off: "Defaults and your own values only." } as const;
export function TuningSection() {
  const api = useTavernSettings();
  return <Shell api={api}>{(d) => <Row label="Tuning" setting="tuning.mode" help={TUNING_HELP[d.effective.tuning.mode]} control={() => <SegFilter label="Tuning" value={d.effective.tuning.mode} onChange={(v) => void api.save({ tuning: { mode: v } })} options={[{ id: "apply", label: "Apply" }, { id: "suggest", label: "Suggest" }, { id: "off", label: "Off" }]} />} />}</Shell>;
}

const WHO: Record<SettingsView["rows"][number]["source"], string> = { default: "Default", user: "You", tavern: "Tavern", keeper: "A Keeper" };
/** The settings Tavern tunes from its own records: value, default, bounds, who set it and why, with Undo and Pin. */
const TUNED_HELP: Record<TunableKey, string> = {
  tickSeconds: "Sets the shortest gap between a Keeper's routine checks. Lower allows quicker checks and more model turns; higher spaces them out.",
  typingHoldSeconds: "Holds routine checks after your last typing update in the Keeper's thread. Higher gives you more space to finish; lower resumes checks sooner.",
  afterMessageHoldSeconds: "Holds routine checks after your latest message. Higher leaves more time for the conversation; lower lets checks resume sooner.",
  staleMinutes: "Counts a member as quiet after this long without activity, a report or journal progress, then alerts its Keeper. Higher waits longer before checking in; lower catches quiet members sooner.",
  reportBatchSeconds: "After the first report is handed over, delays another report-only handoff until this interval has passed. Higher can group more reports into fewer Keeper turns; lower hands them over sooner.",
};
const TUNING_MODE_WORDS = {
  off: "Tavern doesn't tune these; they keep their values.",
  suggest: "Tavern suggests changes from its records; you apply them.",
  apply: "Tavern changes these from its records; pinned values are never changed.",
};
export function TunedSection() {
  const api = useTavernSettings();
  const navigate = useBbNavigate();
  const undo = experimental_useRpcMutation({ contract: settingsContract, method: "settingsUndo" });
  const apply = experimental_useRpcMutation({ contract: settingsContract, method: "settingsApplySuggestion" });
  const end = experimental_useRpcMutation({ contract: settingsContract, method: "settingsEndOverride" });
  const [problem, setProblem] = useState<string | null>(null);
  const run = async (p: Promise<{code: string; problems: Problem[]}>) => {
    setProblem(null);
    try {
      const out = await p;
      if (out.code === "stale") setProblem("Settings changed. Review the latest values and try again.");
      else if (out.code === "invalid") setProblem(out.problems.map(p => p.message).join(" "));
    } catch(e) { setProblem(e instanceof Error ? e.message : String(e)); }
    void api.refetch();
  };
  const id = useId();
  return <Shell api={api}>{(d) => <SettingsAuthors history={d.history}>{names => <>
    <p className="tv-set-intro">{TUNING_MODE_WORDS[d.effective.tuning.mode]}</p>
    <ul className="tv-tuned">{d.rows.filter((r) => !isUserKnob(r.key)).map((r) => {
      const suggestion = d.suggestions.find((s) => s.key === r.key);
      const c = r.lastChange;
      return <li key={r.key} data-setting-keys={`knobs.${r.key}`} className={`tv-tuned-row ${r.pinned ? "pinned" : ""}`}>
        <div className="tv-tuned-h"><label htmlFor={`${id}-${r.key}`}><b>{r.label}</b></label><NumberField id={`${id}-${r.key}`} value={r.value} min={r.min} max={r.max} unit={r.unit} disabled={api.pending} onSave={value=>void api.save({knobs:{[r.key]:value}})} />{r.pinned && <span className="tag"><PageGlyph name="pin" size={11} /><span>pinned</span></span>}</div>
        <p className="tv-tuned-help">{TUNED_HELP[r.key]}{isGuardrailSetting(`knobs.${r.key}`) && " Agents in Tavern threads can't change these; only you can."}</p>
        <div className="tv-tuned-f"><span data-setting-changed={r.value !== r.default || undefined}>{r.value === r.default ? "default " : "Changed from "}<b className="num">{formatValue(r.default, r.unit)}</b></span><span>bounds <b className="num">{formatValue(r.min, r.unit)} to {formatValue(r.max, r.unit)}</b></span><span>{r.source === "default" ? "using the default" : <>set by <b>{r.source === "user" ? "you" : WHO[r.source]}</b>{c && <> <TimeAgo at={c.at} /></>}</>}</span></div>
        {c && <p className="tv-tuned-c"><span><SettingAuthor threadId={d.history.find(h => h.id === c.id)?.threadId} by={c.by} label={names(d.history.find(h => h.id === c.id)?.threadId ?? null, {mid:true})} sentenceStart /> changed it from <b className="num">{c.from === null ? "default" : formatValue(c.from, r.unit)}</b> to <b className="num">{c.to === null ? "default" : formatValue(c.to, r.unit)}</b> <TimeAgo at={c.at} />: {c.reason}</span>{c.evidence && <> <button type="button" className="tv-ilink act" onClick={() => navigate.toPluginPanel("tavern", { subPath: "insights" })}>See it in Insights</button></>}</p>}
        {suggestion && <p className="tv-tuned-s"><PageGlyph name="you" size={12} className="tv-mn-you" /><span>Suggested: <b className="num">{formatValue(suggestion.value, r.unit)}</b>. {suggestion.reason}</span></p>}
        <div className="tv-tuned-a">
          {suggestion && <button type="button" className="btn pri sm" disabled={apply.isPending || r.pinned} onClick={() => void run(apply.mutate({ key: r.key, revision: d.revision }))}><span>Apply {formatValue(suggestion.value, r.unit)}</span></button>}
          {c?.undoable && <button type="button" className="lnk-btn act" disabled={undo.isPending} onClick={() => void run(undo.mutate({ id: c.id, revision: d.revision, why: WHY }))}><PageGlyph name="undo" size={12} /><span>Undo</span></button>}
          {r.value !== r.default && <button type="button" className="lnk-btn act" aria-label={`Reset ${r.label} to default`} disabled={api.pending}
            title={r.pinned ? "Resetting also removes the pin." : undefined} onClick={() => void api.reset(`knobs.${r.key}`)}>Reset to default</button>}
          <button type="button" className="lnk-btn act" aria-pressed={r.pinned} disabled={api.pending} onClick={() => void api.save({}, { [r.key]: r.pinned ? null : r.value })}><PageGlyph name="pin" size={12} /><span>{r.pinned ? "Unpin" : "Pin"}</span></button>
        </div>
      </li>;
    })}</ul>
    <AgentLimits title="Ledger and tuner limits" hint="These limits control ledger refresh and the tuner’s evidence. They are not auto-tuned." groups={["knobs", "tuning"]} />
    <h4>Live quest overrides</h4>
    <p className="tv-set-intro">A Keeper’s override ends with its quest and is not exported to TOML.</p>
    {d.liveOverrides?.length ? <ul className="tv-settings-keys">{d.liveOverrides.map(o => <li className="tv-set-row" key={`${o.questId}:${o.key}`}>
      <div><b>{o.questTitle}</b><p>{knobLabel(`knobs.${o.key}`)}: {knobValue(`knobs.${o.key}`, o.value)}. {o.applied ? "Set by" : "Not applying; set by"} <button type="button" className="tv-ilink act" onClick={() => navigate.toThread(o.keeperThreadId)}>{o.keeperName}</button>.</p></div>
      <button type="button" className="btn sm" aria-label={`End ${knobLabel(`knobs.${o.key}`)} override for ${o.questTitle}`} disabled={end.isPending}
        onClick={() => void run(end.mutate({ revision: d.revision, boardQuestId: o.questId, key: o.key }))}>End now</button>
    </li>)}</ul> : <p className="tv-set-intro">No live quest overrides.</p>}
    {problem && <p className="tv-problem" role="alert">{problem}</p>}
  </>}</SettingsAuthors>}</Shell>;
}

export function ChangeList({ changes, problems }: { changes: Change[]; problems: Problem[] }) {
  return <div className="tv-preview">
    {problems.length > 0 && <ul className="tv-problem" role="alert">{problems.map((p) => <li key={`${p.key}${p.line}`}>Line {p.line}, <b>{p.key}</b>: {p.message}{p.allowed ? ` (allowed: ${p.allowed})` : ""}</li>)}</ul>}
    {changes.length === 0 && !problems.length ? <p className="m small">Nothing would change.</p> : <ul className="tv-changes">{changes.map((c) => <li key={c.key}><b title={c.key}>{settingLabel(c.key)}</b><span>{c.kind === "unset" ? "back to default" : <><b className="num">{knobValue(c.key, c.from)}</b> to <b className="num">{knobValue(c.key, c.to)}</b></>}{c.kind === "pin" ? " (pinned)" : c.kind === "unpin" ? " (unpinned)" : ""}</span></li>)}</ul>}
  </div>;
}

/** The preview's first line, shared with the CLI so the wording cannot drift. */
export { importSummary };


type Preview = { source: "paste" | "file"; changes: Change[]; problems: Problem[]; revision: number; toml?: string };
/** Settings as TOML: copy, paste in with a preview, or save and load the dotfiles file. Previews show in place; nothing applies without a second click. */
export function TransferSection() {
  const api = useTavernSettings();
  const exporter = experimental_useRpcMutation({ contract: settingsContract, method: "settingsExport" });
  const importer = experimental_useRpcMutation({ contract: settingsContract, method: "settingsImport" });
  const filer = experimental_useRpcMutation({ contract: settingsContract, method: "settingsFile" });
  const [pasting, setPasting] = useState(false);
  const [toml, setToml] = useState("");
  const [withTuned, setWithTuned] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const guard = async (fn: () => Promise<void>) => { setError(null); setReceipt(null); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const copy = () => guard(async () => { const out = await exporter.mutate({ withTuned }); setReceipt(await experimental_copyToClipboard({ text: out.toml }) ? "Copied Tavern's settings as TOML." : "Could not copy to the clipboard."); });
  const check = () => guard(async () => { const out = await importer.mutate({ toml, apply: false }); setPreview({ source: "paste", changes: out.changes, problems: out.problems, revision: out.revision, toml }); });
  const loadPreview = () => guard(async () => { const out = await filer.mutate({ action: "load", apply: false }); if (out.preview) setPreview({ source: "file", changes: out.preview.changes, problems: out.preview.problems, revision: out.preview.revision }); else setError(out.file.error ?? "The file could not be read."); });
  const confirm = (d: SettingsView) => guard(async () => {
    if (!preview) return;
    const out = preview.source === "paste"
      ? await importer.mutate({ toml: preview.toml!, apply: true, revision: preview.revision, why: "Imported TOML on the settings page" })
      : (await filer.mutate({ action: "load", apply: true, revision: preview.revision, expectedHash: d.file.hash ?? null, why: "Loaded the settings file" })).preview;
    if (!out || out.code === "stale") { setError("The settings or the file changed after the preview. Check again."); setPreview(null); return; }
    if (out.code === "invalid") { setPreview({ ...preview, problems: out.problems }); return; }
    setReceipt(`Applied ${out.changes.length} change${out.changes.length === 1 ? "" : "s"}.`); setPreview(null); setToml(""); setPasting(false); void api.refetch();
  });
  const saveFile = (d: SettingsView) => guard(async () => { const out = await filer.mutate({ action: "save", revision: d.revision, expectedHash: d.file.exists ? d.file.hash ?? null : null, withTuned, why: "Saved the settings file" }); setReceipt(out.file.error ? `Not saved: ${out.file.error}` : `Saved to ${out.file.path}.`); void api.refetch(); });
  const busy = exporter.isPending || importer.isPending || filer.isPending;
  return <Shell api={api}>{(d) => <>
    {d.file.differs && <div className="tv-filediff" role="status"><PageGlyph name="file" /><div><b>Settings file differs</b><p><code>{d.file.path}</code> differs from the current settings{d.file.changedKeys.length ? `: ${d.file.changedKeys.map(settingLabel).join(", ")}` : ""}. Tavern never applies it on its own.</p></div><div className="tv-filediff-a"><button type="button" className="btn sm" disabled={busy} onClick={() => void loadPreview()}><span>Preview load</span></button><button type="button" className="btn sm" disabled={busy} onClick={() => void saveFile(d)}><span>Overwrite the file</span></button></div></div>}
    {d.file.error && <p className="tv-problem" role="alert">The settings file could not be read: {d.file.error}</p>}
    <div className="tv-set-acts">
      <button type="button" className="btn sm" disabled={busy} onClick={() => void copy()}><Glyph name="report" size={13} /><span>Copy as TOML</span></button>
      <button type="button" className="btn sm" aria-expanded={pasting} onClick={() => { setPasting(!pasting); setPreview(null); }}><PageGlyph name="file" size={13} /><span>Import TOML</span></button>
      <button type="button" className="btn sm" disabled={busy} onClick={() => void saveFile(d)}><span>Save to file</span></button>
      <button type="button" className="btn sm" disabled={busy || !d.file.exists} onClick={() => void loadPreview()}><span>Load from file</span></button>
      <label className="tv-set-check"><input type="checkbox" checked={withTuned} onChange={(e) => setWithTuned(e.target.checked)} /><span>Include tuned values</span></label>
    </div>
    <p className="m small">File: <code>{d.file.path}</code>{d.file.exists ? "" : " (not created yet)"}</p>
    {pasting && <div className="tv-paste"><label htmlFor="tv-toml">Paste TOML</label><textarea id="tv-toml" className="tv-text tv-toml" rows={8} value={toml} spellCheck={false} onChange={(e) => { setToml(e.target.value); if (preview?.source === "paste") setPreview(null); }} /><div className="tv-set-acts"><button type="button" className="btn sm" disabled={busy || !toml.trim()} onClick={() => void check()}><span>Preview changes</span></button></div></div>}
    {preview && <div className="tv-preview-box" aria-live="polite"><b className="tv-import-sum">{importSummary(preview.changes)}</b><ChangeList changes={preview.changes} problems={preview.problems} /><div className="tv-set-acts"><button type="button" className="btn pri sm" disabled={busy || preview.problems.length > 0 || !preview.changes.length} onClick={() => void confirm(d)}><span>{preview.source === "paste" ? "Apply these changes" : "Load the file"}</span></button><button type="button" className="lnk-btn act" onClick={() => setPreview(null)}><span>Cancel</span></button></div></div>}
    {receipt && <p className="tv-receipt" role="status"><PageGlyph name="done" /><span>{receipt}</span></p>}
    {error && <p className="tv-problem" role="alert">{error}</p>}
  </>}</Shell>;
}

// Host descriptions miss text contrast; draw the intro inside Tavern instead (docs/host-asks.md, entry 6).
export function settingsSection<P extends object>({ intro, component: Body, ...rest }: { id: string; title: string; intro: string; component: ComponentType<P> }) {
  const atmosphere = rest.id === "atmosphere";
  function component(props: P) {
    const introRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      if (!atmosphere || ![`#${ATMOSPHERE_ANCHOR}`, "#motion"].includes(window.location.hash)) return;
      const frame = requestAnimationFrame(() => introRef.current?.scrollIntoView({ block: "start" }));
      return () => cancelAnimationFrame(frame);
    }, []);
    return <><div ref={introRef} id={atmosphere ? ATMOSPHERE_ANCHOR : undefined} className="tavern tv-page tv-set-introwrap"><p id={atmosphere ? "motion" : undefined} className="tv-set-intro">{intro}</p></div><Body {...props} /></>;
  }
  return { ...rest, component };
}

function TuningCards() {
  return <><div className="tavern tv-page"><SettingsCard title="Automatic tuning" hint="Choose whether Tavern applies measured changes or suggests them." glyph="rule" guardrail><TuningSection /></SettingsCard><SettingsCard title="Tuned by Tavern" hint="Set a value, undo a change, or pin it so Tavern stops tuning it." glyph="pin"><TunedSection /></SettingsCard></div></>;
}
function DataCards() {
  return <><DataSection /><div className="tavern tv-page"><SettingsCard title="Import and export" hint="Move settings as TOML through ~/.agents/tavern/settings.toml, with a preview before applying." glyph="file"><TransferSection /></SettingsCard><SettingsCard title="Backups" hint={BACKUP_INTRO} glyph="archive" guardrail><BackupSection /></SettingsCard></div></>;
}
function MachineCard() {
  const api = useTavernSettings();
  return <Shell api={api}>{d => <SettingsCard title="Work placement" hint="Choose where members may run and how many a Keeper can place at once." glyph="machine" guardrail>
    <MachinesSettingsRow />
    {([["maxMakers","Makers per Keeper"],["maxCheckers","Checkers per Keeper"]] as const).map(([key,label]) => <Row key={key} setting={`machines.${key}`} label={label}
      control={id => <NumberField id={id} value={d.effective.machines[key]} min={1} max={1000} unit="at once" disabled={api.pending} onSave={v => void api.save({ machines: { [key]: v } })} />} />)}
  </SettingsCard>}</Shell>;
}

export const SETTINGS_SECTIONS = [
  { id: "setup", title: "Setup", intro: `Open the bb composer with your request. The agent proposes changes for you to review. ${SETUP_CALLER_NOTICE}`, component: SetupSettings },
  { id: "tavern", title: "Tavern", intro: "Pause work and choose how new threads start.", component: TavernSection },
  { id: "attention", title: "Your attention", intro: "Choose your review budget, notifications and quiet hours.", component: AttentionSection },
  { id: "keepers", title: "Keepers and decisions", intro: "Set what Keepers may decide and how they check in.", component: KeepersSection },
  { id: "classes", title: "Classes and models", intro: "Choose the agent, model and thinking each class uses.", component: ClassesSection },
  { id: "scopes", title: "Scopes", intro: "Set the guardrails on what members may touch.", component: ScopesSection },
  ...(PLACEMENT_RPC_LIVE ? [{ id: "machines", title: "Where work runs", intro: "Choose the machines and environments that may host work.", component: MachineCard }] as const : []),
  { id: "memory-profiles", title: "Memory profiles", intro: "Choose where Tavern classes save and find durable notes.", component: MemorySettings },
  { id: "atmosphere", title: "Atmosphere", intro: "How the tavern looks and feels: its characters, their speech and its motion.", component: AtmosphereSection },
  { id: "away", title: "Closing time", intro: "Choose what the next window starts with.", component: AwaySettingsSection },
  { id: "journal", title: "Journal", intro: "Choose reminders for each thread's checklist.", component: JournalSection },
  { id: "tuning", title: "Tuning", intro: "Control automatic tuning and inspect the values Tavern tunes.", component: TuningCards },
  { id: "data", title: "Data and backups", intro: "Manage record retention, settings files and backups.", component: DataCards },
  { id: "settings-history", title: "Settings history", intro: "Read what changed and undo changes you do not want.", component: SettingsHistorySection },
] as const;
