import { useState, type ReactNode } from "react";
import { experimental_Icon as Icon, experimental_usePluginId, UrlLink } from "@get-bb/plugin-sdk/app";
import type { InsightsView as Insights } from "../contract";
import { useActions } from "./actions";
import { ActivityView, TONE_ICON } from "./activity";
import { BUTTON, ErrorNote, PAGE, PageHeading, Segmented } from "./common";
import { messageOf, useShuttleQuery } from "./data";
import { duration, percent, settingsHref } from "./format";
import { INSIGHTS_TABS, type InsightsTab } from "./route";
import { INSIGHTS_TAB_LABELS } from "./constants";
import { SyncView } from "./sync";

type Range = Insights["range"];
type Idea = Insights["ideas"][number];
export type IdeaAction = NonNullable<Idea["action"]>;

const RANGES = (["7d", "30d", "90d"] as const).map((value) => ({ value, label: value }));
// bb defines no chart colours inside a plugin's page; every theme defines a terminal palette, so a series takes one of its colours.
const FALLBACKS = ["var(--ansi-4)", "var(--ansi-3)", "var(--ansi-2)", "var(--ansi-5)", "var(--ansi-6)", "var(--ansi-1)"];
const color = (n: number) => `var(--chart-${n}, ${FALLBACKS[(n - 1) % FALLBACKS.length]})`;

function Kpi({ label, value, sub, warn = false }: { label: string; value: string; sub: string; warn?: boolean }) {
  return (
    <div data-kpi={label} className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`mt-px text-xl font-bold ${warn ? "text-warning-text" : ""}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{sub}</div>
    </div>
  );
}

function Panel({ title, sub, children }: { title: ReactNode; sub: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border border-border bg-card px-3.5 py-3">
      <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">{title}</h3>
      <div className="mb-2.5 mt-0.5 text-[11.5px] text-muted-foreground">{sub}</div>
      {children}
    </section>
  );
}

/** Shares as one bar with a legend; each part's share is of the parts' total. */
function SegBar({ label, parts }: { label: string; parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  const shown = parts.filter((part) => part.value > 0);
  return (
    <div data-segbar={label}>
      <div role="img" aria-label={`${label}: ${parts.map((part) => `${part.label} ${total === 0 ? "0%" : percent(part.value / total)}`).join(", ")}`} className="flex h-3.5 gap-0.5 overflow-hidden rounded-full bg-background">
        {shown.map((part) => <div key={part.label} title={`${part.label}: ${percent(part.value / total)}`} style={{ flex: part.value, background: part.color }} />)}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1.5 text-[11.5px] text-muted-foreground">
        {parts.map((part) => (
          <span key={part.label} className="inline-flex items-center gap-1.5">
            <i aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: part.color }} />
            {part.label} <b className="text-foreground">{total === 0 ? "0%" : percent(part.value / total)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

const W = 440;
const H = 150;

function Bars({ labels, series }: { labels: string[]; series: { name: string; color: string; values: number[] }[] }) {
  const max = Math.max(1, ...series.flatMap((item) => item.values)) * 1.15;
  const pad = 22;
  const group = (W - pad) / Math.max(1, labels.length);
  const bar = Math.min(14, (group - 6) / series.length);
  return (
    <svg data-chart="bars" viewBox={`0 0 ${W} ${H}`} width="100%" className="block text-muted-foreground">
      {[0, 0.5, 1].map((t) => {
        const y = H - 18 - (H - 28) * t;
        return <g key={t}><line x1={pad} x2={W} y1={y} y2={y} stroke="currentColor" opacity={0.12} /><text x={0} y={y + 3} fontSize={9} fill="currentColor" opacity={0.5}>{Math.round(max * t)}</text></g>;
      })}
      {labels.map((label, i) => (
        <g key={label}>
          {series.map((item, j) => {
            const value = item.values[i] ?? 0;
            const height = ((H - 28) * value) / max;
            return <rect key={item.name} x={pad + i * group + (group - bar * series.length) / 2 + j * bar} y={H - 18 - height} width={Math.max(1, bar - 2)} height={height} rx={2} fill={item.color}><title>{`${item.name}, week of ${label}: ${value}`}</title></rect>;
          })}
          {(labels.length <= 8 || i % 2 === 0) && <text x={pad + i * group + group / 2} y={H - 4} fontSize={9.5} textAnchor="middle" fill="currentColor" opacity={0.55}>{label}</text>}
        </g>
      ))}
    </svg>
  );
}

function Line({ labels, values }: { labels: string[]; values: number[] }) {
  if (values.length === 0) return <div className="text-sm text-muted-foreground">No days yet.</div>;
  const min = Math.min(...values) * 0.9;
  const max = Math.max(min + 1, Math.max(...values) * 1.05);
  const pad = 26;
  const step = values.length > 1 ? (W - pad - 6) / (values.length - 1) : 0;
  const y = (value: number) => H - 18 - ((H - 28) * (value - min)) / (max - min);
  const every = Math.max(1, Math.ceil(labels.length / 8));
  return (
    <svg data-chart="line" viewBox={`0 0 ${W} ${H}`} width="100%" className="block text-muted-foreground">
      {[min, (min + max) / 2, max].map((value) => <g key={value}><line x1={pad} x2={W} y1={y(value)} y2={y(value)} stroke="currentColor" opacity={0.12} /><text x={0} y={y(value) + 3} fontSize={9} fill="currentColor" opacity={0.5}>{Math.round(value)}</text></g>)}
      {labels.map((label, i) => i % every === 0 && <text key={label} x={pad + i * step} y={H - 4} fontSize={9.5} textAnchor="middle" fill="currentColor" opacity={0.55}>{label}</text>)}
      <polyline points={values.map((value, i) => `${pad + i * step},${y(value)}`).join(" ")} fill="none" stroke={color(2)} strokeWidth={2} />
      {values.map((value, i) => <circle key={i} cx={pad + i * step} cy={y(value)} r={2.5} fill={color(2)}><title>{`${labels[i]}: ${value}`}</title></circle>)}
    </svg>
  );
}

const IDEA_ICONS: Record<IdeaAction["id"], string> = { nudge: "Clock", auto_agent: "Bot", hide_bots: "UserRound", show_quiet: "Clock", edit_preset: "SlidersHorizontal" };

function IdeaRow({ idea, phone, onAction }: { idea: Idea; phone: boolean; onAction(action: IdeaAction): void }) {
  const pluginId = experimental_usePluginId();
  const action = idea.action;
  const tone = TONE_ICON[idea.tone === "neutral" ? "neutral" : idea.tone];
  return (
    <li data-idea={idea.id} className={`flex items-start gap-2.5 border-t border-border py-2.5 first:border-t-0 ${phone ? "flex-wrap" : ""}`}>
      <Icon name={action === null ? "Info" : IDEA_ICONS[action.id]} fallback="Info" className={`mt-0.5 size-4 shrink-0 ${tone}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <b className="text-[13px]">{idea.title}</b>
        <div className="text-xs text-muted-foreground">{idea.detail}</div>
      </div>
      {action !== null && (action.id === "edit_preset"
        ? <UrlLink href={settingsHref(pluginId)} className={`${BUTTON} ${phone ? "ml-6" : ""}`}>{action.label}</UrlLink>
        : <button type="button" className={`${BUTTON} ${phone ? "ml-6" : ""}`} onClick={() => onAction(action)}>{action.label}</button>)}
    </li>
  );
}

function Overview({ data, phone, onAction }: { data: Insights; phone: boolean; onAction(action: IdeaAction): void }) {
  const { kpis, phases, feedback } = data;
  const received = data.requests.reduce((sum, week) => sum + week.asked + week.team, 0);
  const reviewed = data.requests.reduce((sum, week) => sum + week.reviewed, 0);
  const last = data.openRequests.at(-1);
  const drafts = data.ai.reduce((sum, row) => sum + row.drafts, 0);
  const posted = data.ai.reduce((sum, row) => sum + row.posted, 0);
  const reviewers = [...data.reviewers].sort((a, b) => Number(a.bot) - Number(b.bot) || b.reviews - a.reviews);
  const table = "w-full border-collapse text-xs [&_td]:border-t [&_td]:border-border [&_td]:px-1 [&_td]:py-1.5 [&_th]:px-1 [&_th]:pb-1 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-medium [&_th]:text-muted-foreground";
  return (
    <>
      <div className="grid grid-cols-2 gap-2.5 @3xl:grid-cols-4">
        <Kpi label="Your PRs merged" value={String(kpis.merged)} sub={`of ${kpis.opened} opened`} />
        <Kpi label="Median time to merge" value={duration(kpis.timeToMerge)} sub="from open to merge" />
        <Kpi label="Median wait for a review" value={duration(kpis.firstReviewWait)} sub="to the first review" warn={kpis.firstReviewWait !== null} />
        <Kpi label="Your review response" value={duration(kpis.reviewResponse)} sub="from request to your review" />
      </div>
      {data.ideas.length > 0 && (
        <div className="mt-3">
          <Panel title={<><Icon name="Info" className="size-3.5" aria-hidden />Ideas</>} sub="Each one comes from the numbers below, with the change that would help.">
            <ul>{data.ideas.map((idea) => <IdeaRow key={idea.id} idea={idea} phone={phone} onAction={onAction} />)}</ul>
          </Panel>
        </div>
      )}
      <div className="mt-3 grid grid-cols-1 gap-3 @4xl:grid-cols-2 @[110rem]:grid-cols-3">
        <Panel title="Where your PRs spend their time" sub={`Share of open time, merged PRs, ${data.range}`}>
          {phases === null ? <div className="text-sm text-muted-foreground">Not enough data yet: Shuttle has not seen one of your PRs through.</div> : (
            <SegBar label="Phases" parts={[
              { label: "Draft", value: phases.draft, color: color(2) },
              { label: "Waiting for first review", value: phases.waiting, color: color(4) },
              { label: "Fixing feedback", value: phases.fixing, color: color(5) },
              { label: "Approved, not merged", value: phases.approved, color: color(3) },
            ]} />
          )}
        </Panel>
        <Panel title="Feedback on your PRs" sub={`${feedback.total} review comments and failed checks, ${data.range}`}>
          {feedback.total === 0 ? <div className="text-sm text-muted-foreground">No feedback in this range.</div> : (
            <SegBar label="Feedback" parts={[
              { label: "Agent fixed", value: feedback.fixed, color: color(1) },
              { label: "Agent replied", value: feedback.replied, color: color(2) },
              { label: "Declined", value: feedback.declined, color: color(3) },
              { label: "You handled", value: feedback.you, color: color(4) },
              { label: "Open", value: feedback.open, color: color(5) },
            ]} />
          )}
          <div className="mt-2.5 text-xs text-muted-foreground"><b className="block text-[17px] text-foreground">{duration(feedback.agentMedianMs)}</b>median to fix, agent</div>
        </Panel>
        <Panel title="Review requests and your reviews" sub={`A week at a time: ${received} received and ${reviewed} reviewed in ${data.range}`}>
          {data.requests.length === 0 ? <div className="text-sm text-muted-foreground">No weeks yet.</div> : (
            <>
              <Bars labels={data.requests.map((week) => week.week)} series={[
                { name: "Asked you", color: color(1), values: data.requests.map((week) => week.asked) },
                { name: "Asked your team", color: color(2), values: data.requests.map((week) => week.team) },
                { name: "You reviewed", color: color(3), values: data.requests.map((week) => week.reviewed) },
              ]} />
              <div className="mt-2 flex flex-wrap gap-x-3.5 text-[11.5px] text-muted-foreground">
                {["Asked you", "Asked your team", "You reviewed"].map((name, i) => <span key={name} className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: color(i + 1) }} />{name}</span>)}
              </div>
            </>
          )}
        </Panel>
        <Panel title="Open requests waiting on you" sub="By name and by team, at the end of each day Shuttle synced">
          <Line labels={data.openRequests.map((day) => day.day)} values={data.openRequests.map((day) => day.total)} />
          {last !== undefined && <div className="mt-2 text-[11.5px] text-muted-foreground">{last.total} open now. {last.bots} are bots and {last.quiet} are quiet for 30+ days.</div>}
        </Panel>
        <Panel title="AI reviews" sub={`${drafts} drafted, ${posted} posted, ${data.range}`}>
          {data.ai.length === 0 ? <div className="text-sm text-muted-foreground">No AI reviews in this range.</div> : (
            <table className={table}>
              <thead><tr><th>Preset</th><th className="!text-right">Drafts</th><th className="!text-right">Posted</th><th className="!text-right">Findings kept</th></tr></thead>
              <tbody>{data.ai.map((row) => <tr key={row.preset}><td>{row.preset}</td><td className="text-right">{row.drafts}</td><td className="text-right">{row.posted}</td><td className="text-right">{row.kept === null ? "—" : percent(row.kept)}</td></tr>)}</tbody>
            </table>
          )}
        </Panel>
        <Panel title="Who reviews your PRs" sub={`People, ${data.range}; bots apart`}>
          {reviewers.length === 0 ? <div className="text-sm text-muted-foreground">Nobody reviewed your PRs in this range.</div> : (
            <table className={table}>
              <thead><tr><th>Reviewer</th><th className="!text-right">Reviews</th><th className="!text-right">Median response</th></tr></thead>
              <tbody>{reviewers.map((row) => <tr key={row.login}><td>{row.login}{row.bot && <span className="text-muted-foreground"> (bot)</span>}</td><td className="text-right">{row.reviews}</td><td className="text-right">{duration(row.medianMs)}</td></tr>)}</tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}

/** How your PRs and reviews flow, with ideas that act on it; and the Automation log. */
export function InsightsView({ tab, onTab, onAction, onOpenPr }: { tab: InsightsTab; onTab(tab: InsightsTab): void; onAction(action: IdeaAction): void; onOpenPr(key: string): void }) {
  const actions = useActions();
  const [range, setRange] = useState<Range>("30d");
  const insights = useShuttleQuery("insights", { range }, tab === "overview");
  const data = insights.data;
  const servers = useShuttleQuery("overview", {}).data?.servers.filter((server) => server.enabled).map((server) => server.name) ?? [];
  const tabs = <Segmented label="Insights" value={tab} onChange={onTab} options={INSIGHTS_TABS.map((value) => ({ value, label: INSIGHTS_TAB_LABELS[value] }))} />;
  if (tab === "sync") {
    return (
      <div className={PAGE}>
        <PageHeading title="Insights" description="How each server syncs, and why a sync failed.">{tabs}</PageHeading>
        <SyncView />
      </div>
    );
  }
  if (tab === "log") {
    return (
      <div className={PAGE}>
        <PageHeading title="Insights" description="Everything Shuttle did by itself, newest first.">{tabs}</PageHeading>
        <ActivityView onOpenPr={onOpenPr} onOpenThread={actions.openThread} />
      </div>
    );
  }
  return (
    <div className={PAGE}>
      <PageHeading title="Insights" description="How your PRs and reviews flow, and where time goes.">{!actions.phone && tabs}</PageHeading>
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        {actions.phone && tabs}
        <Segmented label="Range" value={range} onChange={setRange} options={RANGES} />
        {servers.length > 0 && <span className="text-[11px] text-muted-foreground">{new Intl.ListFormat("en", { type: "conjunction" }).format(servers)}</span>}
      </div>
      {data?.collectingSince != null && (
        <div data-collecting className="mb-2.5 text-xs text-muted-foreground">
          Shuttle started keeping some of these on {new Date(data.collectingSince).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}.
        </div>
      )}
      {insights.error !== null && <ErrorNote>Could not load Insights: {messageOf(insights.error)}</ErrorNote>}
      {data === undefined && insights.error === null && <div className="py-6 text-sm text-muted-foreground">Loading…</div>}
      {data !== undefined && <Overview data={data} phone={actions.phone} onAction={onAction} />}
    </div>
  );
}
