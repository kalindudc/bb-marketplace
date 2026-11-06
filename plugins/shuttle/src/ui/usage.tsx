import { useRef, useState } from "react";
import { experimental_Icon as Icon, UrlLink } from "@get-bb/plugin-sdk/app";
import { change, dollars, tokenCount } from "../amounts";
import type { UsageOutcome, UsageRange, UsageView as Usage } from "../contract";
import { addDays, isDay, periodLabel, previousText, RANGE_DAYS, stepEnd } from "../period";
import { BUTTON, BUTTON_GHOST, ErrorNote, ICON_OUTLINE, Segmented } from "./common";
import { messageOf, useShuttleQuery } from "./data";
import { percent, plural } from "./format";
import { color, Kpi, Panel, SegBar } from "./insight-parts";
import type { UsagePeriod } from "./route";
import { InsightsSkeleton } from "./skeleton";

const RANGES: Array<{ value: UsageRange; label: string }> = [
  { value: "today", label: "Day" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];
/** "in the 7 days before", "in the day before" or "yesterday by now", to follow a number. */
const inBefore = (data: Usage) => (data.range === "today" && data.latest ? previousText(data.range, true) : `in ${previousText(data.range, data.latest)}`);
const OUTCOME: Record<UsageOutcome, { label: string; color: string }> = {
  posted: { label: "Posted", color: color(3) },
  waiting: { label: "Draft waiting", color: color(1) },
  discarded: { label: "Discarded by you", color: color(6) },
  replaced: { label: "Replaced by a newer review", color: color(5) },
  no_draft: { label: "No draft", color: color(4) },
  failed: { label: "Failed", color: color(2) },
  running: { label: "Running", color: "var(--muted-foreground)" },
};
/** What became of a review that left you nothing to post. */
const WASTED: ReadonlySet<UsageOutcome> = new Set(["discarded", "no_draft", "failed"]);
const BURN_URL = "https://github.com/kalindudc/burn";
const SHOWN = 10;
const table = "w-full border-collapse text-xs [&_td]:border-t [&_td]:border-border [&_td]:px-1 [&_td]:py-1.5 [&_th]:px-1 [&_th]:pb-1 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-medium [&_th]:text-muted-foreground";

function Trend({ now, before, data }: { now: number; before: number; data: Usage }) {
  const delta = change(now, before);
  if (delta === null) return <>nothing {inBefore(data)}</>;
  return <>{delta >= 0 ? "\u25b2" : "\u25bc"} {percent(Math.abs(delta))} from {previousText(data.range, data.latest)}</>;
}

const W = 440;
const H = 150;

/** Tokens per hour or day, the critics' part darker at the foot of each bar. */
function SpendBars({ data }: { data: Usage }) {
  const money = (n: number) => dollars(n, data.totals.estimated);
  const label = (start: number) => (data.bucket === "hour" ? new Date(start).toLocaleTimeString(undefined, { hour: "numeric" }) : new Date(start).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  const max = Math.max(1, ...data.series.map((row) => row.tokens)) * 1.1;
  const pad = 34;
  const group = (W - pad) / Math.max(1, data.series.length);
  const bar = Math.max(1, Math.min(18, group - 2));
  const every = Math.max(1, Math.ceil(data.series.length / 8));
  const y = (value: number) => ((H - 28) * value) / max;
  return (
    <svg data-chart="usage" viewBox={`0 0 ${W} ${H}`} width="100%" className="block text-muted-foreground">
      {[0, 0.5, 1].map((t) => {
        const at = H - 18 - (H - 28) * t;
        return <g key={t}><line x1={pad} x2={W} y1={at} y2={at} stroke="currentColor" opacity={0.12} /><text x={0} y={at + 3} fontSize={9} fill="currentColor" opacity={0.5}>{tokenCount(max * t)}</text></g>;
      })}
      {data.series.map((row, i) => {
        const x = pad + i * group + (group - bar) / 2;
        const own = row.tokens - row.critics;
        return (
          <g key={row.start}>
            <title>{`${label(row.start)}: ${tokenCount(row.tokens)} tokens, ${money(row.cost)}; ${plural(row.reviews, "review")} started`}</title>
            <rect x={x} y={H - 18 - y(row.critics)} width={bar} height={y(row.critics)} fill={color(5)} />
            <rect x={x} y={H - 18 - y(row.tokens)} width={bar} height={y(own)} rx={2} fill={color(1)} />
            {i % every === 0 && <text x={pad + i * group + group / 2} y={H - 4} fontSize={9.5} textAnchor="middle" fill="currentColor" opacity={0.55}>{label(row.start)}</text>}
          </g>
        );
      })}
    </svg>
  );
}

function Source({ data }: { data: Usage }) {
  const { source } = data;
  if (source.state === "missing") {
    return (
      <div data-usage-source="missing" className="mb-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground">
        <b className="block text-[13px] text-foreground">Token usage comes from the Burn plugin</b>
        Burn reads what every thread used, whatever harness runs it, and Shuttle splits it between your reviews. bb says it is not there: {source.message}.{" "}
        <UrlLink href={BURN_URL} className="text-primary hover:underline">Install Burn</UrlLink>, and Shuttle reads your reviews of the last 90 days within a few minutes.
      </div>
    );
  }
  const notes = [
    source.state === "error" ? `Shuttle's last read from Burn failed: ${source.message}` : null,
    source.unread > 0 ? `Reading ${plural(source.unread, "review thread")} from Burn; until then the figures may leave out some of what ${source.unread === 1 ? "it" : "they"} used.` : null,
    data.unmeasured > 0 ? `${plural(data.unmeasured, "review")} started in this period ${data.unmeasured === 1 ? "has" : "have"} no figures in Burn.` : null,
  ].filter((note): note is string => note !== null);
  if (notes.length === 0) return null;
  return <div data-usage-source={source.state} className="mb-2.5 flex flex-col gap-0.5 text-xs text-muted-foreground">{notes.map((note) => <span key={note}>{note}</span>)}</div>;
}

function Body({ data, onOpenPr, onOpenThread }: { data: Usage; onOpenPr(key: string): void; onOpenThread(threadId: string): void }) {
  const [all, setAll] = useState(false);
  const { totals, perReview, critics } = data;
  const money = (n: number | null) => (n === null ? "\u2014" : dollars(n, totals.estimated));
  if (totals.reviews === 0) {
    return <div className="rounded-lg border border-border bg-card px-3.5 py-3 text-sm text-muted-foreground">{data.range === "today" ? "No AI review used anything on this day." : "No AI review used anything in these days."}</div>;
  }
  const wasted = data.outcomes.filter((o) => WASTED.has(o.outcome));
  const wastedCost = wasted.reduce((sum, o) => sum + o.cost, 0);
  const wastedReviews = wasted.reduce((sum, o) => sum + o.reviews, 0);
  const cacheHit = totals.mix.cacheRead + totals.mix.cacheWrite + totals.mix.input > 0 ? totals.mix.cacheRead / (totals.mix.cacheRead + totals.mix.cacheWrite + totals.mix.input) : null;
  const reviews = all ? data.reviews : data.reviews.slice(0, SHOWN);
  return (
    <>
      <div className="grid grid-cols-2 gap-2.5 @3xl:grid-cols-4">
        <Kpi label="Tokens" value={tokenCount(totals.tokens)} sub={<Trend now={totals.tokens} before={data.previous.tokens} data={data} />} />
        <Kpi label="Cost" value={money(totals.cost)} sub={<Trend now={totals.cost} before={data.previous.cost} data={data} />} />
        <Kpi label="Reviews" value={String(totals.reviews)} sub={`${totals.calls.toLocaleString("en-US")} model call${totals.calls === 1 ? "" : "s"}; ${data.previous.reviews} ${inBefore(data)}`} />
        <Kpi label="Median per review" value={money(perReview.medianCost)} sub={`${tokenCount(perReview.medianTokens ?? 0)} tokens; 90th percentile ${money(perReview.p90Cost)}`} />
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 @4xl:grid-cols-2 @[110rem]:grid-cols-3">
        <Panel title={data.bucket === "hour" ? "Tokens by hour" : "Tokens by day"} sub="Review threads, with their critics and other threads under them at the foot of each bar">
          <SpendBars data={data} />
          <div className="mt-2 flex flex-wrap gap-x-3.5 text-[11.5px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: color(1) }} />Review threads</span>
            <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: color(5) }} />Critics {tokenCount(critics.tokens)}, {money(critics.cost)}, {plural(critics.threads, "thread")}</span>
          </div>
        </Panel>
        <Panel title="What the tokens were" sub={cacheHit === null ? "By kind" : `By kind; ${percent(cacheHit)} of input read from the cache`}>
          <SegBar label="Token mix" parts={[
            { label: "Cache read", value: totals.mix.cacheRead, color: color(1) },
            { label: "Cache write", value: totals.mix.cacheWrite, color: color(4) },
            { label: "Output", value: totals.mix.output, color: color(3) },
            { label: "Input", value: totals.mix.input, color: color(2) },
          ]} />
        </Panel>
        <Panel title="What it bought" sub={wastedReviews ? `${money(wastedCost)} went to ${plural(wastedReviews, "review")} that left you nothing to post` : "Cost by what became of each review"}>
          <SegBar label="Outcomes" parts={data.outcomes.map((o) => ({ label: `${OUTCOME[o.outcome].label} (${o.reviews})`, value: o.cost, color: OUTCOME[o.outcome].color }))} />
        </Panel>
        <Panel title="By preset" sub="A preset's median is per review; posted counts reviews whose draft you posted">
          <table className={table}>
            <thead><tr><th>Preset</th><th className="!text-right">Reviews</th><th className="!text-right">Tokens</th><th className="!text-right">Cost</th><th className="!text-right">Median</th><th className="!text-right">Posted</th></tr></thead>
            <tbody>{data.presets.map((row) => <tr key={row.preset}><td>{row.preset}</td><td className="text-right">{row.reviews}</td><td className="text-right">{tokenCount(row.tokens)}</td><td className="text-right">{money(row.cost)}</td><td className="text-right">{money(row.medianCost)}</td><td className="text-right">{row.posted}</td></tr>)}</tbody>
          </table>
        </Panel>
        <Panel title="By model" sub="Review threads and critics together">
          <table className={table}>
            <thead><tr><th>Model</th><th className="!text-right">Calls</th><th className="!text-right">Tokens</th><th className="!text-right">Cost</th></tr></thead>
            <tbody>{data.models.map((row) => <tr key={row.model}><td className="break-all">{row.model}</td><td className="text-right">{row.calls}</td><td className="text-right">{tokenCount(row.tokens)}</td><td className="text-right">{money(row.cost)}</td></tr>)}</tbody>
          </table>
        </Panel>
        <Panel title="By repository" sub={data.triggers.map((t) => `${t.trigger === "auto" ? "Auto" : "Started by you"}: ${money(t.cost)} in ${plural(t.reviews, "review")}`).join(" \u00b7 ")}>
          <table className={table}>
            <thead><tr><th>Repository</th><th className="!text-right">Reviews</th><th className="!text-right">Tokens</th><th className="!text-right">Cost</th></tr></thead>
            <tbody>{data.repos.slice(0, 8).map((row) => <tr key={row.repo}><td className="break-all">{row.repo}</td><td className="text-right">{row.reviews}</td><td className="text-right">{tokenCount(row.tokens)}</td><td className="text-right">{money(row.cost)}</td></tr>)}</tbody>
          </table>
        </Panel>
      </div>
      <div className="mt-3">
        <Panel title="Reviews" sub={`Costliest first: what each used in ${data.range === "today" ? "this day" : "these days"}, with its critics`}>
          <table className={table} data-usage-reviews>
            <thead><tr><th>PR</th><th>Preset</th><th>Started</th><th>Outcome</th><th className="!text-right">Critics</th><th className="!text-right">Tokens</th><th className="!text-right">Cost</th><th /></tr></thead>
            <tbody>
              {reviews.map((row) => (
                <tr key={row.runId} data-usage-review={row.runId}>
                  <td className="max-w-[22rem]">
                    {row.key ? <button type="button" className="text-left text-primary hover:underline" onClick={() => onOpenPr(row.key)}>{row.display}</button> : row.display}
                    {row.title && <div className="truncate text-[11px] text-muted-foreground" title={row.title}>{row.title}</div>}
                  </td>
                  <td>{row.preset}{row.trigger === "auto" && <span className="text-muted-foreground"> (auto)</span>}</td>
                  <td>{new Date(row.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                  <td>{OUTCOME[row.outcome].label}</td>
                  <td className="text-right">{row.critics}</td>
                  <td className="text-right">{tokenCount(row.tokens)}</td>
                  <td className="text-right font-medium">{money(row.cost)}</td>
                  <td className="text-right"><button type="button" className={BUTTON_GHOST} aria-label="Open the review thread" title="Open the review thread" onClick={() => onOpenThread(row.threadId)}><Icon name="MessageSquare" fallback="ExternalLink" className="size-3.5" aria-hidden /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.reviews.length > SHOWN && <button type="button" className={`${BUTTON_GHOST} mt-1.5`} onClick={() => setAll(!all)}>{all ? "Show the costliest 10" : `Show all ${data.reviews.length}`}</button>}
        </Panel>
      </div>
    </>
  );
}

/**
 * Today, a step back or forward by the period's length, and the days shown over the browser's own date picker, which
 * opens from a click anywhere on them. `today` and `firstDay` come from the server's answer; until the first one, the
 * buttons are disabled.
 */
function PeriodNav({ period, data, onPeriod }: { period: UsagePeriod; data: Usage | undefined; onPeriod(period: UsagePeriod): void }) {
  const today = data?.today ?? null;
  const last = today === null ? null : period.end !== null && period.end < today ? period.end : today;
  const unit = period.range === "today" ? "day" : `${RANGE_DAYS[period.range]} days`;
  // Nothing is to be found before Shuttle's first review.
  const earliest = last === null || data?.firstDay == null || addDays(last, 1 - RANGE_DAYS[period.range]) <= data.firstDay;
  const step = (by: -1 | 1) => {
    if (today !== null && last !== null) onPeriod({ range: period.range, end: stepEnd(period.range, last, by, today) });
  };
  return (
    <div data-usage-period className="flex flex-wrap items-center gap-1.5">
      <button type="button" className={BUTTON} title={`Back to the newest ${unit}`} disabled={last === null || last === today} onClick={() => onPeriod({ range: period.range, end: null })}>Today</button>
      <button type="button" className={ICON_OUTLINE} aria-label="Earlier" title={`The ${unit} before`} disabled={earliest} onClick={() => step(-1)}>
        <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
      </button>
      <button type="button" className={ICON_OUTLINE} aria-label="Later" title={`The ${unit} after`} disabled={last === null || last === today} onClick={() => step(1)}>
        <Icon name="ChevronRight" className="size-3.5" aria-hidden />
      </button>
      {today !== null && last !== null && (
        <span className="relative inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 hover:bg-state-hover focus-within:ring-1 focus-within:ring-ring">
          <Icon name="Calendar" className="size-3.5 text-muted-foreground" aria-hidden />
          <span data-usage-label className="whitespace-nowrap text-[13px] font-semibold">{periodLabel(period.range, last, today)}</span>
          <Icon name="ChevronDown" className="size-3.5 text-muted-foreground" aria-hidden />
          <input
            type="date"
            aria-label="Pick a day"
            title="Pick a day"
            value={last}
            min={data?.firstDay ?? undefined}
            max={today}
            onClick={(event) => {
              try {
                event.currentTarget.showPicker();
              } catch {
                // Without showPicker, or where it is refused, the click still reaches the browser's own picker.
              }
            }}
            // Typing a year digit by digit passes through years such as 0002, which name no period.
            onChange={(event) => {
              const day = event.target.value;
              if (isDay(day) && day <= today) onPeriod({ range: period.range, end: day >= today ? null : day });
            }}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </span>
      )}
    </div>
  );
}

/** What AI reviews used in tokens and dollars, as Burn read it, for a day or 7, 30 or 90 days, ending today or earlier. */
export function UsageView({ period, onPeriod, onOpenPr, onOpenThread }: {
  period: UsagePeriod;
  onPeriod(period: UsagePeriod): void;
  onOpenPr(key: string): void;
  onOpenThread(threadId: string): void;
}) {
  const usage = useShuttleQuery("usage", period.end === null ? { range: period.range } : { range: period.range, end: period.end });
  // The last answer stays on screen, dimmed, while the next period loads, so stepping through days does not flash.
  const held = useRef<Usage | undefined>(undefined);
  if (usage.data !== undefined) held.current = usage.data;
  const data = usage.data ?? held.current;
  const reading = usage.data === undefined && data !== undefined;
  return (
    <>
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <Segmented label="Range" value={period.range} onChange={(range) => onPeriod({ range, end: period.end })} options={RANGES} />
        <PeriodNav period={period} data={data} onPeriod={onPeriod} />
        {data?.totals.estimated === true && <span className="text-[11px] text-muted-foreground">~ marks list-price estimates</span>}
      </div>
      {usage.error !== null && <ErrorNote>Could not load usage: {messageOf(usage.error)}</ErrorNote>}
      {data === undefined && usage.error === null && <InsightsSkeleton label="Loading usage" />}
      {data !== undefined && (
        <div data-usage-body aria-busy={reading} className={reading ? "opacity-60 transition-opacity" : undefined}>
          <Source data={data} />
          {data.source.state !== "missing" && <Body data={data} onOpenPr={onOpenPr} onOpenThread={onOpenThread} />}
        </div>
      )}
    </>
  );
}
