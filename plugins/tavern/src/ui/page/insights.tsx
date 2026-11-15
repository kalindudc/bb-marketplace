import { UrlLink, experimental_usePluginId, experimental_useRpcMutation, experimental_useRpcQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { createContext, useContext, useMemo, useState } from "react";
import { insightsContract, type InsightSection, type InsightsView } from "../../shared/insights";
import { TUNABLES, settingsContract, type SettingDecision, type TunableKey } from "../../shared/settings";
import { Chart, Glyph, Kpi, OpensMark, TimeAgo, formatValue, glowVars, levelsShown, plural, useRegistry } from "../kit";
import { SegFilter } from "./common";
import { InsightsSkeleton, PageLoad } from "./skeletons";
import { PageGlyph } from "./glyphs";
import { usePanelState } from "./panel-state";

type Range = InsightsView["range"];
const RANGE_IDS: readonly Range[] = ["7d", "30d", "90d"];
type Series = InsightSection["series"][number];
type ChartSeries = Extract<Series, { points: unknown }>;
type NameOf = (x: string) => string | undefined;
const PointNames = createContext<NameOf>(() => undefined);

/** Shows each point by its label, a known quest title, class or character name, else its id; repeated names get the id's tail so rows stay apart. */
function named(series: ChartSeries, nameOf: NameOf): ChartSeries {
  const names = series.points.map((p) => p.label ?? nameOf(p.x) ?? p.x);
  const seen = new Map<string, number>();
  for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
  return { ...series, points: series.points.map((p, i) => ({ x: seen.get(names[i]!)! > 1 ? `${names[i]} · ${p.x.slice(-6)}` : names[i]!, y: p.y })) };
}
type Idea = InsightsView["ideas"][number];
export const settingsHref = (pluginId: string) => `/settings/plugins/${encodeURIComponent(pluginId)}`;

export { formatValue };
/** Knob labels the tuner does not own: user budgets kept under knobs for the file format. */
const USER_KNOB_LABELS: Record<string, string> = { rangerTimeboxMaxMinutes: "Ranger time-box ceiling" };
export const isUserKnob = (key: string) => key.replace(/^knobs\./, "") in USER_KNOB_LABELS;
export const knobLabel = (path: string) => { const key = path.replace(/^knobs\./, "") as TunableKey; return TUNABLES[key]?.label ?? USER_KNOB_LABELS[key] ?? path; };
export const knobValue = (path: string, value: unknown) => { const key = path.replace(/^knobs\./, "") as TunableKey; return typeof value === "number" && TUNABLES[key] ? formatValue(value, TUNABLES[key].unit) : value === null || value === undefined ? "default" : String(value); };
const isDay = (x: string) => /^\d{4}-\d{2}-\d{2}$/.test(x);
const scrollTo = (section: string) => document.getElementById(`tv-ins-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

function Facts({ series }: { series: Extract<Series, { value: unknown }>[] }) {
  if (!series.length) return null;
  return <dl className="tv-ifacts">{series.map((s) => <div key={s.id}><dt>{s.label}</dt><dd className="num">{formatValue(s.value, s.unit)}</dd></div>)}</dl>;
}

/** The server's chart of character levels. With levels off in Settings it isn't drawn, or drawn while the setting is still loading. */
const LEVELS_SERIES = "character-levels";
const withoutLevels = (section: InsightSection): InsightSection => ({ ...section, series: section.series.filter((s) => s.id !== LEVELS_SERIES) });

function Section({ id, title, section, children, limitFor }: { id: string; title: string; section: InsightSection; children?: React.ReactNode; limitFor?: (s: Series) => number | undefined }) {
  const values = section.series.filter((s): s is Extract<Series, { value: unknown }> => "value" in s);
  const charts = section.series.filter((s): s is ChartSeries => "points" in s);
  const nameOf = useContext(PointNames);
  return <section className="tv-card tv-isec" id={`tv-ins-${id}`} aria-labelledby={`tv-ins-${id}-h`}>
    <header className="tv-isec-h"><h2 id={`tv-ins-${id}-h`}>{title}</h2></header>
    <p className="tv-isec-cap">{section.caption}</p>
    {!section.series.length && <p className="tv-empty" data-empty>No data in this range yet.</p>}
    <Facts series={values} />
    {charts.length > 0 && <div className="tv-icharts">{charts.map((s) => { const trend = s.points.length > 0 && s.points.every((p) => isDay(p.x)); return <Chart key={s.id} type={trend ? "trend" : "bars"} series={trend ? s : named(s, nameOf)} limit={limitFor?.(s)} />; })}</div>}
    {children}
  </section>;
}

function IdeaCard({ idea, onApply, pending }: { idea: Idea; onApply: (key: TunableKey, value: number) => void; pending: boolean }) {
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const act = idea.severity === "act";
  const a = idea.action;
  const button = a.kind === "apply-tuned"
    ? <button type="button" className="btn pri sm" disabled={pending} onClick={() => onApply(a.key, a.value)}><span>Set {TUNABLES[a.key].label.toLowerCase()} to {formatValue(a.value, TUNABLES[a.key].unit)}</span></button>
    : a.kind === "open-setting" ? <UrlLink href={settingsHref(pluginId)} className="btn sm"><span>Open the setting</span><OpensMark /></UrlLink>
    : a.kind === "open-quest" ? <button type="button" className="btn sm" onClick={() => navigate.toPluginPanel("tavern", { subPath: `quest/${a.questId}` })}><span>Open the quest</span><OpensMark /></button>
    : <button type="button" className="btn sm" onClick={() => scrollTo(a.section)}><span>See the section</span></button>;
  return <li className={`tv-idea ${act ? "act lit" : ""}`} style={act ? glowVars(`idea:${idea.id}`) : undefined}>
    <PageGlyph name={act ? "you" : "note"} className={act ? "tv-mn-you" : ""} />
    <div className="tv-idea-b"><b>{idea.title}</b><p>{idea.detail}</p>{idea.evidence && <button type="button" className="tv-ilink act" onClick={() => scrollTo(idea.evidence!.section)}>See the evidence</button>}</div>
    <div className="tv-idea-a">{button}</div>
  </li>;
}

const BY: Record<SettingDecision["by"], string> = { user: "You", tavern: "Tavern", keeper: "A Keeper" };
export function TuningHistory({ history, onUndo, pending }: { history: SettingDecision[]; onUndo?: (id: string) => void; pending?: boolean }) {
  if (!history.length) return <p className="tv-empty" data-empty>No tuning changes in this range.</p>;
  return <ul className="tv-thist">{history.map((d) => <li key={d.id} className={d.undoneAt ? "undone" : ""}>
    <span className="tv-thist-w"><b>{BY[d.by]}</b> <TimeAgo at={d.at} /></span>
    <span className="tv-thist-c">{d.changes.map((c) => <span key={c.key}>{knobLabel(c.key)}: <b className="num">{knobValue(c.key, c.from)}</b> to <b className="num">{knobValue(c.key, c.to)}</b>{c.kind === "pin" ? " (pinned)" : c.kind === "unpin" ? " (unpinned)" : ""}</span>)}</span>
    <span className="tv-thist-r">{d.reason}{d.evidence && <> <button type="button" className="tv-ilink act" onClick={() => scrollTo(d.evidence!.section)}>See the evidence</button></>}</span>
    <span className="tv-thist-a">{d.undoneAt ? <span className="m small">undone <TimeAgo at={d.undoneAt} /></span> : d.undoable && onUndo ? <button type="button" className="lnk-btn act" disabled={pending} onClick={() => onUndo(d.id)}><PageGlyph name="undo" size={12} /><span>Undo</span></button> : null}</span>
  </li>)}</ul>;
}

const LOWER_IS_BETTER = new Set(["goal-to-return", "ask-wait"]);
export function InsightsPage() {
  const pluginId = experimental_usePluginId();
  const [range, setRange] = usePanelState<Range>("insights.range", "30d", (v) => RANGE_IDS.includes(v as Range));
  const insights = experimental_useRpcQuery({ contract: insightsContract, method: "insights", input: { range } });
  const settings = experimental_useRpcQuery({ contract: settingsContract, method: "settings", input: null });
  const apply = experimental_useRpcMutation({ contract: settingsContract, method: "settingsApplySuggestion" });
  const undo = experimental_useRpcMutation({ contract: settingsContract, method: "settingsUndo" });
  const [receipt, setReceipt] = useState<string | null>(null);
  const data = insights.data;
  const registry = useRegistry();
  const nameOf = useMemo<NameOf>(() => {
    const names = new Map<string, string>();
    for (const c of registry.data?.classes ?? []) names.set(c.id, c.label);
    for (const c of registry.data?.characters ?? []) names.set(c.id, c.name);
    for (const q of data?.cost?.quests ?? []) names.set(q.questId, q.title);
    return (x) => names.get(x);
  }, [registry.data, data]);
  const revision = settings.data?.revision;
  const onApply = async (key: TunableKey, value: number) => {
    if (revision === undefined) return;
    const out = await apply.mutate({ key, revision });
    setReceipt(out.code === "ok" ? `${TUNABLES[key].label} is now ${formatValue(value, TUNABLES[key].unit)}. It is in Tuning history below, with Undo.` : out.code === "stale" ? "Settings changed in the meantime; reload the page and try again." : `Not applied: ${out.problems.map((p) => p.message).join("; ")}`);
    void settings.refetch(); void insights.refetch();
  };
  const onUndo = async (id: string) => {
    if (revision === undefined) return;
    const out = await undo.mutate({ id, revision, why: "Undone from Insights" });
    setReceipt(out.code === "ok" ? "Undone. The setting is back to its earlier value." : out.code === "stale" ? "Settings changed in the meantime; reload the page and try again." : `Not undone: ${out.problems.map((p) => p.message).join("; ")}`);
    void settings.refetch(); void insights.refetch();
  };
  const restatementLimit = settings.data?.effective.keepers.restatementBytes;
  return <PointNames.Provider value={nameOf}><div className="tv-insights">
    <div className="tv-ihead">
      <h1>Insights</h1>
      <SegFilter label="Range" value={range} onChange={setRange} options={[{ id: "7d", label: "7 days" }, { id: "30d", label: "30 days" }, { id: "90d", label: "90 days" }]} />
      <span className="tv-sp" />
      {data && <span className="m small">collecting since {new Date(data.collectingSince).toLocaleDateString("en", { month: "short", day: "numeric" })}</span>}
      <UrlLink href={settingsHref(pluginId)} className="tv-ilink act"><span>Settings</span><OpensMark /></UrlLink>
    </div>
    <p className="tv-ilead">Everything Tavern records about your Keepers, their parties and the plugin itself, in one place. It is what Tavern tunes from, and what you can check it against.</p>
    {!data ? <PageLoad error={insights.error} retry={insights.refetch} skeleton={<InsightsSkeleton />} label="Insights" /> : <>
      <div className="tkpis">{data.headline.map((h) => <Kpi key={h.id} label={h.label} value={formatValue(h.value, h.unit)} delta={{ value: h.value, previous: h.previous, unit: h.unit, lowerIsBetter: LOWER_IS_BETTER.has(h.id) }} />)}</div>
      {receipt && <p className="tv-receipt" role="status"><PageGlyph name="done" /><span>{receipt}</span><span className="tv-sp" /><button type="button" className="tv-qbtn act" aria-label="Dismiss" title="Dismiss" onClick={() => setReceipt(null)}><Glyph name="close" size={12} /></button></p>}
      <section className="tv-isec tv-ideas-sec" aria-labelledby="tv-ins-ideas-h">
        <header className="tv-isec-h"><h2 id="tv-ins-ideas-h">Ideas</h2><span className="tv-count">{plural(data.ideas.length, "idea")}</span></header>
        {data.ideas.length ? <ul className="tv-ideas">{data.ideas.map((idea) => <IdeaCard key={idea.id} idea={idea} onApply={(k, v) => void onApply(k, v)} pending={apply.isPending || revision === undefined} />)}</ul> : <p className="tv-empty" data-empty>No ideas yet. They come from the numbers below once there are enough of them.</p>}
      </section>
      <Section id="reliability" title="Keeper reliability" section={data.reliability} limitFor={(s) => s.id === "restatement" ? restatementLimit : undefined} />
      <Section id="phases" title="Where quests spend their time" section={data.phases} />
      <Section id="attention" title="Your attention" section={data.attention} />
      <Section id="party" title="The party" section={registry.data && levelsShown(registry.data) ? data.party : withoutLevels(data.party)} />
      <Section id="guardrails" title="Guardrails" section={data.guardrails} />
      <section className="tv-card tv-isec" id="tv-ins-tuning" aria-labelledby="tv-ins-tuning-h">
        <header className="tv-isec-h"><h2 id="tv-ins-tuning-h">Tuning history</h2><span className="tv-count">{plural(data.tuningHistory.length, "change")}</span></header>
        <p className="tv-isec-cap">Each change to a tuned setting, who made it and why, with Undo while it can still be undone.</p>
        <TuningHistory history={data.tuningHistory} onUndo={(id) => void onUndo(id)} pending={undo.isPending || revision === undefined} />
      </section>
      {data.cost && <Section id="cost" title="Cost and time per quest" section={data.cost}>
        <p className="m small">{data.cost.estimated ? "Estimated" : "Measured"} from {data.cost.threadsKnown} of {plural(data.cost.threadsTotal, "thread")}.</p>
        <table className="tv-itable"><thead><tr><th scope="col">Quest</th><th scope="col">Cost</th><th scope="col">Tokens</th><th scope="col">Time</th></tr></thead>
          <tbody>{data.cost.quests.map((q) => <tr key={q.questId}><th scope="row">{q.title}{!q.complete && <span className="m small"> · partial</span>}</th><td className="num">{formatValue(q.cost, "usd")}</td><td className="num">{formatValue(q.tokens, "tokens")}</td><td className="num">{formatValue(q.seconds, "s")}</td></tr>)}</tbody></table>
      </Section>}
    </>}
  </div></PointNames.Provider>;
}
