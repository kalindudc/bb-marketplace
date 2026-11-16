import { experimental_ProviderModelPicker as ProviderModelPicker, experimental_copyToClipboard, experimental_useProviders, experimental_useRpcMutation, experimental_useRpcQuery, useBbNavigate, type ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from "react";
import { importSummary, isGuardrailSetting, settingsContract, type SettingsChange, type SettingsPatch, type SettingsView, type TunableKey } from "../../shared/settings";
import { Glyph, OpensMark, TimeAgo, plural, useRegistry, useActorNames, useRemembered, ExpandsMark } from "../kit";
import { ReadState, SegFilter } from "./common";
import { BACKUP_INTRO, BackupSection } from "./backup";
import { PageGlyph, type PageGlyphName } from "./glyphs";
import { MachinesSettingsRow } from "./machines-row";
import { PLACEMENT_RPC_LIVE } from "./machines-contract";
import { formatValue, isUserKnob, knobLabel, knobValue } from "./insights";

const WHY = "Changed on the settings page";
/** Character voice, in the server's terms: what agents may write in a character's voice. Trouble reads plain in every mode. */
export const VOICE_HELP = {
  full: "Each character may open or wrap a reply with one short line in its voice. Asks, blockers and evidence stay plain.",
  light: "One short line at most, only when a character finishes successfully; no greetings or progress lines. Asks, blockers and evidence stay plain.",
  off: "Plain replies only. New reports carry no voice line, and the page hides the ones already stored.",
} as const;
const LABELS: Record<string, string> = {
  "tavern.ambientMotion": "Ambient motion", "tavern.repeatSeconds": "Repeat every", "tavern.agentsMayChangeSettings": "Agents may change settings", "tavern.paused": "Pause every Keeper", "tavern.defaultClass": "New threads start as", "tavern.voice": "Character voice", "tavern.widgetRow": "Widget row", "tavern.batchWakeEvents": "Batch wake events", "tavern.levels": "Character levels", "tavern.characters": "Characters", "tavern.hearthFlicker": "Hearth flicker while work runs",
  "attention.reviewBudget": "Review budget", "attention.notify": "Push to your devices", "attention.quietHours": "Quiet hours",
  "keepers.greenlight": "Greenlight", "keepers.decisionTimerMax": "Longest decision timer", "keepers.partyMax": "Party ceiling", "keepers.staleStrikes": "Strikes before release advice", "keepers.restatementBytes": "Keeper restatement limit", "keepers.tickFactChars": "Tick facts limit",
  "scopes.mode": "Scopes", "journal.journalReminders": "Journal reminders", "journal.journalQuietMinutes": "Quiet before a reminder",
  "data.historyDays": "Keep history", "data.autoArchiveDays": "Send returned quests to the cellar after", "tuning.mode": "Tuning",
};
/** A settings path in words: TOML's snake_case and the RPC's camelCase both map to the label the row uses. */
export function settingLabel(key: string) {
  const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/^(?:tuning\.pinned|tuned)\./, "knobs.");
  if (camel.startsWith("knobs.")) return knobLabel(camel);
  const cls = camel.match(/^classes\.([^.]+)\.(provider|model|reasoning)$/);
  const words = (word: string) => word.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ");
  const label = LABELS[camel] ?? (cls ? `${cls[1]} ${cls[2]}` : words(camel.split(".").at(-1)!));
  return label.charAt(0).toUpperCase() + label.slice(1);
}
type Problem = { line: number; key: string; message: string; allowed?: string };
type Change = SettingsChange;

/** One read and one writer for every section, so a change in one shows in all and a stale revision is caught. */
export function useTavernSettings() {
  const query = experimental_useRpcQuery({ contract: settingsContract, method: "settings", input: null });
  const update = experimental_useRpcMutation({ contract: settingsContract, method: "settingsUpdate" });
  const [problems, setProblems] = useState<Problem[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const save = async (patch: SettingsPatch, pins?: Partial<Record<TunableKey, number | null>>) => {
    if (!query.data) return;
    setProblems([]); setNote(null);
    const out = await update.mutate({ revision: query.data.revision, patch, ...(pins ? { pins } : {}), why: WHY });
    if (out.code === "stale") setNote("Settings changed somewhere else, so nothing was saved. The latest values are shown; make the change again.");
    if (out.code === "invalid") setProblems(out.problems);
    void query.refetch();
  };
  return { data: query.data, error: query.error, refetch: query.refetch, save, pending: update.isPending, problems, note };
}
type Api = ReturnType<typeof useTavernSettings>;

function Shell({ api, children }: { api: Api; children: (data: SettingsView) => ReactNode }) {
  return <div className="tavern tv-page tv-set">
    {api.note && <p className="tv-problem" role="alert">{api.note}</p>}
    {api.problems.length > 0 && <ul className="tv-problem" role="alert">{api.problems.map((p) => <li key={`${p.key}${p.line}`}><b>{p.key}</b>: {p.message}{p.allowed ? ` (allowed: ${p.allowed})` : ""}</li>)}</ul>}
    {api.data ? children(api.data) : <ReadState error={api.error} retry={api.refetch} />}
  </div>;
}

export function SettingsCard({ title, hint, glyph, guardrail = false, children }: { title: string; hint: string; glyph: PageGlyphName; guardrail?: boolean; children: ReactNode }) {
  const id = useId();
  return <section className="tv-card tv-settings-card" aria-labelledby={id}><header className="tv-settings-head"><PageGlyph name={glyph} size={18} /><div><h3 id={id}>{title}</h3><p className="tv-settings-hint">{hint}{guardrail && " Agents in Tavern threads can't change these; only you can."}</p></div></header><div className="tv-settings-body">{children}</div></section>;
}

function Row({ label, help, children, control }: { label: string; help?: ReactNode; children?: ReactNode; control: (id: string) => ReactNode }) {
  const id = useId();
  return <div className="tv-set-row"><div className="tv-set-l"><label htmlFor={id}>{label}</label>{help && <p>{help}</p>}{children}</div><div className="tv-set-c">{control(id)}</div></div>;
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
    <span id={`${id}-b`} className={`tv-num-b ${valid ? "" : "bad"}`}>{min} to {max.toLocaleString("en")}</span>
  </span>;
}


export function TavernSection() {
  const api = useTavernSettings();
  const registry = useRegistry();
  return <Shell api={api}>{(d) => { const t = d.effective.tavern; return <>
<SettingsCard title="Control of Tavern" hint="Pause work or choose whether agents can change settings." glyph="lock" guardrail>
    <Row label="Pause every Keeper" help="No ticks, hires or timers while paused. Asks stay answerable." control={(id) => <Toggle id={id} checked={t.paused} disabled={api.pending} onChange={(v) => void api.save({ tavern: { paused: v } })} />} />
    <Row label="Agents may change settings" help="Agent CLI changes are recorded with their thread and can be undone below." control={(id) => <Toggle id={id} checked={t.agentsMayChangeSettings} disabled={api.pending} onChange={(v) => void api.save({ tavern: { agentsMayChangeSettings: v } })} />} />
</SettingsCard>
<SettingsCard title="New threads" hint="Choose how a thread starts and where Tavern appears." glyph="file">
    <Row label="New threads start as" help="The class a new thread starts with. None is an ordinary thread." control={(id) => <select id={id} className="tv-select" value={t.defaultClass} disabled={api.pending} onChange={(e) => void api.save({ tavern: { defaultClass: e.target.value } })}><option value="none">None (an ordinary thread)</option>{registry.data?.classes.map((c) => <option key={c.id} value={c.id}>{c.label} ({c.plain})</option>)}</select>} />
    <Row label="Widget row" help="Shows Tavern's row above the message box on every thread. Off hides it everywhere; when on, each thread can still hide its own." control={(id) => <Toggle id={id} checked={t.widgetRow} disabled={api.pending} onChange={(v) => void api.save({ tavern: { widgetRow: v } })} />} />
    <Row label="Batch wake events" help="Off by default. When on, a wake the Keeper gets from a new event waits a short window so a burst gathers into one turn. Regular sweep ticks ignore this and always carry every unread event." control={(id) => <Toggle id={id} checked={t.batchWakeEvents} disabled={api.pending} onChange={(v) => void api.save({ tavern: { batchWakeEvents: v } })} />} />
</SettingsCard>
<SettingsCard title="Character" hint="Choose how much character shows in reports and records." glyph="shield">
    <Row label="Character voice" help={VOICE_HELP[t.voice]} control={() => <SegFilter label="Character voice" value={t.voice} onChange={(v) => void api.save({ tavern: { voice: v } })} options={[{ id: "full", label: "Full" }, { id: "light", label: "Light" }, { id: "off", label: "Off" }]} />} />
    <Row label="Character levels" help="Shows each character's level and crest notches, earned from verified work. Agents never see levels. Off hides them everywhere." control={(id) => <Toggle id={id} checked={t.levels} disabled={api.pending} onChange={(v) => void api.save({ tavern: { levels: v } })} />} />
</SettingsCard>
  </>; }}</Shell>;
}
export function MotionSection() {
  const api = useTavernSettings();
  return <Shell api={api}>{d => { const t = d.effective.tavern; return <SettingsCard title="Ambient cues" hint="Choose how Tavern moves while work runs." glyph="lantern">
    <Row label="Characters" help="Draws the animated pixel-art characters: the walking strip at the top of the composer. Off leaves the class crest in the widget row, with no sprite, no canvas and no animation." control={id => <Toggle id={id} checked={t.characters} disabled={api.pending} onChange={v => void api.save({ tavern: { characters: v } })} />} />
    <Row label="Ambient motion" help="Calm uses brief, budgeted cues. Lively repeats while work runs. Off keeps the hearth still and stops ambient repeats." control={() => <SegFilter label="Ambient motion" value={t.hearthFlicker ? t.ambientMotion : "off"} onChange={v => void api.save({ tavern: { ambientMotion: v, hearthFlicker: v !== "off" } })} options={[{id:"calm",label:"Calm"},{id:"lively",label:"Lively"},{id:"off",label:"Off"}]} />} />
    <Row label="Repeat every" help="The repeat interval in Lively. Reduced motion, hidden pages, typing and trouble in view still hold animations." control={id => <NumberField id={id} value={t.repeatSeconds} min={3} max={60} unit="seconds" disabled={api.pending} onSave={v => void api.save({tavern:{repeatSeconds:v}})} />} />
  </SettingsCard>; }}</Shell>;
}

function SettingsAuthors({ history, children }: { history: SettingsView["history"]; children: (names: ReturnType<typeof useActorNames>) => ReactNode }) {
  const names = useActorNames(history.flatMap(c => c.threadId ? [c.threadId] : []));
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
  if (/^tavern\.(ambientMotion|repeatSeconds|hearthFlicker|characters)/.test(path)) return "Motion";
  if (/^(knobs|tuned|tuning\.pinned)\./.test(path)) return "Tuning";
  return ({tavern:"Tavern",attention:"Your attention",keepers:"Keepers and decisions",classes:"Classes and models",scopes:"Scopes",machines:"Where work runs",journal:"Journal",tuning:"Tuning",data:"Data and backups",backup:"Data and backups"} as Record<string,string>)[path.split(".")[0]!] ?? "Settings";
}

function historyValue(key: string, value: unknown): string {
  if (value === null) return "Default";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "object") return Object.entries(value).map(([k,v]) => `${settingLabel(`${key}.${k}`)}: ${historyValue(`${key}.${k}`,v)}`).join(", ");
  if (key === "knobs.rangerTimeboxMaxMinutes") return `${value} min`;
  if (key === "tavern.repeatSeconds") return `${value} s`;
  if (key.startsWith("data.") || key === "backup.keep") return `${value} ${key === "backup.keep" ? "backups" : "days"}`;
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
        <div><HistoryKeys changes={c.changes.slice(0,3)} classes={registry.data?.classes ?? []} providers={providers.providers} />{c.changes.length>3 && <details className="tv-history-more"><summary>{plural(c.changes.length-3,"more setting")}</summary><HistoryKeys changes={c.changes.slice(3)} classes={registry.data?.classes ?? []} providers={providers.providers} /></details>}
        <p>{c.reason}</p><p className="tv-history-author">By <SettingAuthor threadId={c.threadId} by={c.by} label={c.threadId?names(c.threadId,{mid:true}):undefined} /> <TimeAgo at={c.at} />{c.undoneAt && " (undone)"}</p></div>
        {c.undoable && <button type="button" className="lnk-btn act" disabled={undo.isPending} onClick={()=>void undo.mutate({id:c.id,revision:d.revision,why:"Undo settings change"}).then(()=>api.refetch()).catch(e=>setError(String(e)))}>Undo</button>}
      </li>)}</ul>}</SettingsAuthors>{!history.length && <p>No settings changes yet.</p>}{!all && history.length>10 && <button type="button" className="btn sm" onClick={()=>setAll(true)}>Show all</button>}</div>}
    </SettingsCard>;
  }}</Shell>;
}
export function AttentionSection() {
  const api = useTavernSettings();
  return <Shell api={api}>{(d) => { const a = d.effective.attention; const q = a.quietHours; return <SettingsCard title="What reaches you" hint="Set your review capacity and when asks reach your devices." glyph="you" guardrail>
    <Row label="Review budget" help="Items waiting on your review before Keepers stop opening new work." control={(id) => <NumberField id={id} value={a.reviewBudget} min={1} max={30} unit="items" disabled={api.pending} onSave={(v) => void api.save({ attention: { reviewBudget: v } })} />} />
    <Row label="Push to your devices" help="Which asks send a notification." control={() => <SegFilter label="Push to your devices" value={a.notify} onChange={(v) => void api.save({ attention: { notify: v } })} options={[{ id: "consequential", label: "Consequential" }, { id: "all", label: "All" }, { id: "none", label: "None" }]} />} />
    <Row label="Quiet hours" help="No pushes in this window. Keepers keep working and timers still run." control={(id) => <span className="tv-quiet">
      <Toggle id={id} checked={!!q} disabled={api.pending} onChange={(v) => void api.save({ attention: { quietHours: v ? { start: "22:00", end: "07:30", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } : null } })} />
      {q && <><label className="sr" htmlFor={`${id}-s`}>Quiet from</label><input id={`${id}-s`} type="time" className="tv-text tv-time" value={q.start} disabled={api.pending} onChange={(e) => e.target.value && void api.save({ attention: { quietHours: { ...q, start: e.target.value } } })} /><span className="m">to</span><label className="sr" htmlFor={`${id}-e`}>Quiet until</label><input id={`${id}-e`} type="time" className="tv-text tv-time" value={q.end} disabled={api.pending} onChange={(e) => e.target.value && void api.save({ attention: { quietHours: { ...q, end: e.target.value } } })} /><span className="m small">{q.timeZone}</span></>}
    </span>} />
  </SettingsCard>; }}</Shell>;
}

const ALWAYS_WORDS: Record<SettingsView["alwaysAsk"][number], string> = { production: "production", merge: "merge", delete: "delete", "sends-as-you": "sends as you", credentials: "credentials", "scope-widening": "scope widening" };
export function KeepersSection() {
  const api = useTavernSettings();
  return <Shell api={api}>{(d) => { const k = d.effective.keepers; return <><SettingsCard title="Delegated decisions" hint="Set the decisions and staffing a Keeper may handle." glyph="you" guardrail>
    <Row label="Greenlight" help={k.greenlight === "explicit" ? "You approve every quest map before work starts." : "Plans with one member and only reversible steps start and tell you; bigger ones wait for you."} control={() => <SegFilter label="Greenlight" value={k.greenlight} onChange={(v) => void api.save({ keepers: { greenlight: v } })} options={[{ id: "explicit", label: "Always ask me" }, { id: "by-size", label: "By size" }]} />} />
    <Row label="Longest decision timer" help={`The longest a Keeper may wait before a reversible decision applies its recommendation: now ${formatValue(k.decisionTimerMax * 60, "s")}. Timers stay opt-in per ask.`} control={(id) => <NumberField id={id} value={k.decisionTimerMax} min={1} max={10080} unit="min" disabled={api.pending} onSave={(v) => void api.save({ keepers: { decisionTimerMax: v } })} />} />
    <Row label="Party ceiling" help="Most live party members across all of a Keeper's quests at once, not a per-quest limit. A quest map still holds at most 8, and class files set per-class budgets beneath it." control={(id) => <NumberField id={id} value={k.partyMax} min={1} max={1000} unit="members" disabled={api.pending} onSave={(v) => void api.save({ keepers: { partyMax: v } })} />} />
    <Row label="Ranger time-box ceiling" help="The longest a Ranger may scout before it must report. A budget that is yours to set; the tuner never changes it." control={(id) => <NumberField id={id} value={d.effective.knobs.rangerTimeboxMaxMinutes} min={3} max={30} unit="min" disabled={api.pending} onSave={(v) => void api.save({ knobs: { rangerTimeboxMaxMinutes: v } })} />} />
    </SettingsCard><SettingsCard title="Check-ins and memory" hint="Keep members accountable and preserve what you told the Keeper." glyph="file">
    <Row label="Strikes before release advice" help="Missed check-ins before Tavern advises releasing a quiet member. Yours to set; the tuner never changes this safety threshold." control={(id) => <NumberField id={id} value={k.staleStrikes} min={1} max={4} unit="strikes" disabled={api.pending} onSave={(v) => void api.save({ keepers: { staleStrikes: v } })} />} />
    <div className="tv-set-row tv-set-ro"><div className="tv-set-l"><span className="tv-set-lbl">Memory limits</span><p>Fixed, not tunable: lowering them would make Keepers forget what you told them.</p></div><div className="tv-set-c"><dl className="tv-limits">{(d.readOnlyLimits ?? [{ key: "restatementBytes" as const, label: "Keeper restatement limit", value: k.restatementBytes, unit: "bytes" as const, reason: "" }, { key: "tickFactChars" as const, label: "Tick facts limit", value: k.tickFactChars, unit: "chars" as const, reason: "" }]).map((l) => <div key={l.key}><dt>{l.label}</dt><dd className="num">{formatValue(l.value, l.unit)}</dd>{l.reason && <dd className="m small">{l.reason}</dd>}</div>)}</dl></div></div>
    <div className="tv-set-row tv-set-ro"><div className="tv-set-l"><span className="tv-set-lbl">Always ask</span><p>These always wait for you and cannot be tuned.</p></div><div className="tv-set-c"><ul className="tv-chips">{d.alwaysAsk.map((a) => <li key={a} className="tag"><PageGlyph name="lock" size={11} /><span>{ALWAYS_WORDS[a]}</span></li>)}</ul></div></div>
  </SettingsCard></>; }}</Shell>;
}

/** reasoning: null is the model's own default thinking; left out, the class file's level applies. */
type ClassOverride = { provider?: string; model?: string; reasoning?: string | null };
type ClassDefaults = { provider: string | null; model: string | null; reasoning: string | null };
const describeExecution = (e: ClassDefaults | ClassOverride, providers: DisplayProviders, chosen = false) => <>{e.model ? <ModelName value={e.model} /> : "the agent's default model"}{e.reasoning ? `, ${e.reasoning} thinking` : chosen && e.reasoning === null ? ", the model's default thinking" : null}{e.provider && `, on ${providers.find(p => p.id === e.provider)?.displayName ?? e.provider}`}</>;

/** bb's own agent, model and thinking picker for one class; until one is chosen, the class file decides. */
function ClassExecution({ label, defaults, override, onSave, disabled }: { label: string; defaults: ClassDefaults; override: ClassOverride; onSave: (next: ClassOverride | null) => void; disabled?: boolean }) {
  const providers = experimental_useProviders();
  const [seed, setSeed] = useState<ExperimentalProviderModelPickerValue | null>(null);
  // bb's picker reports its own correction of the starting value through onChange as it appears; only a person's input may save.
  const touched = useRef(false);
  const touch = () => { touched.current = true; };
  const firstAvailable = providers.providers.find((p) => p.available)?.id ?? null;
  const chosen = override.model !== undefined || override.provider !== undefined || override.reasoning !== undefined;
  const providerId = override.provider ?? defaults.provider ?? firstAvailable;
  const toOverride = (next: ExperimentalProviderModelPickerValue): ClassOverride => ({ provider: next.providerId, ...(next.model ? { model: next.model } : {}), reasoning: next.reasoningLevel || null });
  if (chosen && !providerId) return <div className="tv-exec"><span className="tv-exec-d">Set here: {describeExecution(override, providers.providers, true)}{providers.status === "loading" ? " (loading agents)" : ""}</span><button type="button" className="lnk-btn act" disabled={disabled} onClick={() => onSave(null)} aria-label={`Use the class file for ${label}`}><span>Use the class file</span></button></div>;
  if (chosen && providerId) {
    const value = { providerId, model: override.model ?? "", reasoningLevel: override.reasoning ?? "" };
    return <div className="tv-exec" onPointerDownCapture={touch} onClickCapture={touch} onKeyDownCapture={(e) => { if (e.key !== "Tab" && e.key !== "Shift" && e.key !== "Escape") touch(); }}>
      <ProviderModelPicker value={value} onChange={(next) => { if (touched.current) onSave(toOverride(next)); }} disabled={disabled} align="end" />
      <button type="button" className="lnk-btn act" disabled={disabled} onClick={() => { touched.current = false; onSave(null); }} aria-label={`Use the class file for ${label}`}><span>Use the class file</span></button>
    </div>;
  }
  const fileLine = <span className="tv-exec-d">Class file: {describeExecution(defaults, providers.providers)}</span>;
  if (!seed) {
    const start = defaults.provider ?? firstAvailable;
    return <div className="tv-exec">
      {fileLine}
      <button type="button" className="btn sm" disabled={disabled || !start} aria-label={`Choose model and thinking for ${label}`}
        title={!start ? (providers.status === "loading" ? "Loading agents" : "No agent is available") : undefined}
        onClick={() => start && setSeed({ providerId: start, model: defaults.model ?? "", reasoningLevel: defaults.reasoning ?? "" })}><span>Choose model and thinking</span></button>
    </div>;
  }
  // A draft: picking only changes what is shown; nothing is stored until Save.
  return <div className="tv-exec tv-exec-draft">
    {fileLine}
    <ProviderModelPicker value={seed} onChange={setSeed} disabled={disabled} align="end" />
    <button type="button" className="btn sm pri" disabled={disabled || !seed.model} aria-label={`Save model and thinking for ${label}`} title={!seed.model ? "Pick a model first" : undefined} onClick={() => { const next = seed; setSeed(null); onSave(toOverride(next)); }}><span>Save</span></button>
    <button type="button" className="lnk-btn act" onClick={() => setSeed(null)} aria-label={`Cancel choosing for ${label}`}><span>Cancel</span></button>
  </div>;
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
        <div className="tv-set-c"><ClassExecution label={c.label} defaults={{ provider: c.provider, model: c.model, reasoning: c.reasoning }} override={override} disabled={api.pending}
          onSave={(next) => { const entry: ClassOverride = next ?? {}; void api.save({ classes: { [c.id]: entry } }); }} /></div>
      </div>;
    })}
  </SettingsCard>}</Shell>;
}

export function ScopesSection() {
  const api = useTavernSettings();
  return <Shell api={api}>{(d) => <SettingsCard title="Member guardrails" hint="Choose whether scope rules stop actions or only record them." glyph="lock" guardrail>
    <Row label="Scopes" help={d.effective.scopes.mode === "enforce" ? "A turn that breaks its scope rules is stopped." : d.effective.scopes.mode === "watch" ? "Violations are recorded, not stopped." : "No guardrail."} control={() => <SegFilter label="Scopes" value={d.effective.scopes.mode} onChange={(v) => void api.save({ scopes: { mode: v } })} options={[{ id: "enforce", label: "Enforce" }, { id: "watch", label: "Watch" }, { id: "off", label: "Off" }]} />} />
    <p className="tv-set-intro">Keepers and hired Wanderers use open access; only protected files are guarded. Rangers read, Wardens check, and Smiths build in their worktree. Settings guardrails and user approvals still apply.</p>
    <p className="tv-set-intro">Running agents pick up the environment speed bumps (no GH_TOKEN, the git push block) only after their session restarts. Policy files live in <code>~/.agents/tavern/scopes.yml</code> and each project's <code>.agents/tavern/</code>.</p>
  </SettingsCard>}</Shell>;
}

export function JournalSection() {
  const api = useTavernSettings();
  return <Shell api={api}>{(d) => { const j = d.effective.journal; return <SettingsCard title="Journal reminders" hint="Choose when a quiet journal gets a reminder." glyph="file">
    <Row label="Journal reminders" help="Nudge a thread that has worked a while without updating its journal." control={(id) => <Toggle id={id} checked={j.journalReminders} disabled={api.pending} onChange={(v) => void api.save({ journal: { journalReminders: v } })} />} />
    <Row label="Quiet before a reminder" control={(id) => <NumberField id={id} value={j.journalQuietMinutes} min={1} max={120} unit="min" disabled={api.pending || !j.journalReminders} onSave={(v) => void api.save({ journal: { journalQuietMinutes: v } })} />} />
    <p className="tv-set-intro">Old pi-quests logs are imported on first touch, and the originals are kept. Turn pi-quests off when you adopt Tavern, so only one plugin owns the journal tool.</p>
  </SettingsCard>; }}</Shell>;
}

export function DataSection() {
  const api = useTavernSettings();
  return <Shell api={api}>{(d) => { const x = d.effective.data; return <SettingsCard title="Retention" hint="Choose how long records stay and when quests leave the board." glyph="archive">
    <Row label="Keep history" help={x.historyDays === 0 ? "0 keeps everything, as today." : `Events older than ${x.historyDays} days are removed.`} control={(id) => <NumberField id={id} value={x.historyDays} min={0} max={3650} unit="days" disabled={api.pending} onSave={(v) => void api.save({ data: { historyDays: v } })} />} />
    <Row label="Send returned quests to the cellar after" help={x.autoArchiveDays === 0 ? "0 = never. Sending a quest to the cellar marks it done, so by default only you do it." : `Returned quests go to the cellar after ${plural(x.autoArchiveDays, "day")}. 0 = never.`} control={(id) => <NumberField id={id} value={x.autoArchiveDays} min={0} max={3650} unit="days" disabled={api.pending} onSave={(v) => void api.save({ data: { autoArchiveDays: v } })} />} />
  </SettingsCard>; }}</Shell>;
}

const TUNING_HELP = { apply: "Tavern changes the settings below within their bounds and records each change in Decided for you, with Undo.", suggest: "Insights shows each change with an Apply button; nothing changes on its own.", off: "Defaults and your own values only." } as const;
export function TuningSection() {
  const api = useTavernSettings();
  return <Shell api={api}>{(d) => <Row label="Tuning" help={TUNING_HELP[d.effective.tuning.mode]} control={() => <SegFilter label="Tuning" value={d.effective.tuning.mode} onChange={(v) => void api.save({ tuning: { mode: v } })} options={[{ id: "apply", label: "Apply" }, { id: "suggest", label: "Suggest" }, { id: "off", label: "Off" }]} />} />}</Shell>;
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
  const run = async (p: Promise<unknown>) => { await p; void api.refetch(); };
  const id = useId();
  return <Shell api={api}>{(d) => <SettingsAuthors history={d.history}>{names => <>
    <p className="tv-set-intro">{TUNING_MODE_WORDS[d.effective.tuning.mode]}</p>
    <ul className="tv-tuned">{d.rows.filter((r) => !isUserKnob(r.key)).map((r) => {
      const suggestion = d.suggestions.find((s) => s.key === r.key);
      const c = r.lastChange;
      return <li key={r.key} className={`tv-tuned-row ${r.pinned ? "pinned" : ""}`}>
        <div className="tv-tuned-h"><label htmlFor={`${id}-${r.key}`}><b>{r.label}</b></label><NumberField id={`${id}-${r.key}`} value={r.value} min={r.min} max={r.max} unit={r.unit} disabled={api.pending} onSave={value=>void api.save({knobs:{[r.key]:value}})} />{r.pinned && <span className="tag"><PageGlyph name="pin" size={11} /><span>pinned</span></span>}</div>
        <p className="tv-tuned-help">{TUNED_HELP[r.key]}{isGuardrailSetting(`knobs.${r.key}`) && " Agents in Tavern threads can't change these; only you can."}</p>
        <div className="tv-tuned-f"><span>default <b className="num">{formatValue(r.default, r.unit)}</b></span><span>bounds <b className="num">{formatValue(r.min, r.unit)} to {formatValue(r.max, r.unit)}</b></span><span>{r.source === "default" ? "using the default" : <>set by <b>{r.source === "user" ? "you" : WHO[r.source]}</b>{c && <> <TimeAgo at={c.at} /></>}</>}</span></div>
        {c && <p className="tv-tuned-c"><span><SettingAuthor threadId={d.history.find(h => h.id === c.id)?.threadId} by={c.by} label={names(d.history.find(h => h.id === c.id)?.threadId ?? null, {mid:true})} sentenceStart /> changed it from <b className="num">{c.from === null ? "default" : formatValue(c.from, r.unit)}</b> to <b className="num">{c.to === null ? "default" : formatValue(c.to, r.unit)}</b> <TimeAgo at={c.at} />: {c.reason}</span>{c.evidence && <> <button type="button" className="tv-ilink act" onClick={() => navigate.toPluginPanel("tavern", { subPath: "insights" })}>See it in Insights</button></>}</p>}
        {suggestion && <p className="tv-tuned-s"><PageGlyph name="you" size={12} className="tv-mn-you" /><span>Suggested: <b className="num">{formatValue(suggestion.value, r.unit)}</b>. {suggestion.reason}</span></p>}
        <div className="tv-tuned-a">
          {suggestion && <button type="button" className="btn pri sm" disabled={apply.isPending || r.pinned} onClick={() => void run(apply.mutate({ key: r.key, revision: d.revision }))}><span>Apply {formatValue(suggestion.value, r.unit)}</span></button>}
          {c?.undoable && <button type="button" className="lnk-btn act" disabled={undo.isPending} onClick={() => void run(undo.mutate({ id: c.id, revision: d.revision, why: WHY }))}><PageGlyph name="undo" size={12} /><span>Undo</span></button>}
          <button type="button" className="lnk-btn act" aria-pressed={r.pinned} disabled={api.pending} onClick={() => void api.save({}, { [r.key]: r.pinned ? null : r.value })}><PageGlyph name="pin" size={12} /><span>{r.pinned ? "Unpin" : "Pin"}</span></button>
        </div>
      </li>;
    })}</ul>
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
  const component = (props: P) => <><div className="tavern tv-page tv-set-introwrap"><p className="tv-set-intro">{intro}</p></div><Body {...props} /></>;
  return { ...rest, component };
}

function TuningCards() {
  return <><div className="tavern tv-page"><SettingsCard title="Automatic tuning" hint="Choose whether Tavern applies measured changes or suggests them." glyph="rule" guardrail><TuningSection /></SettingsCard><SettingsCard title="Tavern tunes these" hint="Set a value, undo a change, or pin it so Tavern stops tuning it." glyph="pin"><TunedSection /></SettingsCard></div></>;
}
function DataCards() {
  return <><DataSection /><div className="tavern tv-page"><SettingsCard title="Import and export" hint="Move settings as TOML through ~/.agents/tavern/settings.toml, with a preview before applying." glyph="file"><TransferSection /></SettingsCard><SettingsCard title="Backups" hint={BACKUP_INTRO} glyph="archive" guardrail><BackupSection /></SettingsCard></div></>;
}
function MachineCard() { return <div className="tavern tv-page"><SettingsCard title="Work placement" hint="Choose where members may run." glyph="machine" guardrail><MachinesSettingsRow /></SettingsCard></div>; }

export const SETTINGS_SECTIONS = [
  { id: "tavern", title: "Tavern", intro: "Pause work and choose how new threads and characters behave.", component: TavernSection },
  { id: "attention", title: "Your attention", intro: "Choose your review budget, notifications and quiet hours.", component: AttentionSection },
  { id: "keepers", title: "Keepers and decisions", intro: "Set what Keepers may decide and how they check in.", component: KeepersSection },
  { id: "classes", title: "Classes and models", intro: "Choose the agent, model and thinking each class uses.", component: ClassesSection },
  { id: "scopes", title: "Scopes", intro: "Set the guardrails on what members may touch.", component: ScopesSection },
  ...(PLACEMENT_RPC_LIVE ? [{ id: "machines", title: "Where work runs", intro: "Choose the machines and environments that may host work.", component: MachineCard }] as const : []),
  { id: "motion", title: "Motion", intro: "Choose ambient cues and their repeat interval.", component: MotionSection },
  { id: "journal", title: "Journal", intro: "Choose reminders for each thread's checklist.", component: JournalSection },
  { id: "tuning", title: "Tuning", intro: "Control automatic tuning and inspect the values Tavern tunes.", component: TuningCards },
  { id: "data", title: "Data and backups", intro: "Manage record retention, settings files and backups.", component: DataCards },
  { id: "settings-history", title: "Settings history", intro: "Read what changed and undo changes you do not want.", component: SettingsHistorySection },
] as const;
