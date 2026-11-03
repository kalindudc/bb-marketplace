import { useState } from "react";
import { experimental_Icon as Icon, experimental_usePluginId, UrlLink } from "@get-bb/plugin-sdk/app";
import type { AutoPostInsights, ShadowLabel } from "../contract";
import { ErrorNote, Pill, Segmented } from "./common";
import { messageOf, useShuttleQuery } from "./data";
import { ago, percent, plural, seconds, settingsHref } from "./format";
import { color, Kpi, Panel } from "./insight-parts";
import { InsightsSkeleton } from "./skeleton";

type Range = AutoPostInsights["range"];
type Repo = AutoPostInsights["repos"][number];

const RANGES = (["7d", "30d", "90d"] as const).map((value) => ({ value, label: value }));
const LABEL_TEXT: Record<ShadowLabel, string> = {
  agreed: "Would post, you posted",
  against: "Would post, you dropped",
  pending: "Would post, not decided yet",
  missed: "Held, you posted",
  held: "Held, you dropped",
};
const LABEL_COLOR: Record<ShadowLabel, string> = { agreed: color(3), against: color(6), pending: color(1), missed: color(5), held: color(2) };
const OUTCOME_TEXT = { posted: "You posted it", discarded: "You discarded it", superseded: "Replaced by a newer review", pending: "Not decided yet" } as const;
const table = "w-full border-collapse text-xs [&_td]:border-t [&_td]:border-border [&_td]:px-1 [&_td]:py-1.5 [&_th]:px-1 [&_th]:pb-1 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-medium [&_th]:text-muted-foreground";

const ratio = (value: number | null) => (value === null ? "\u2014" : percent(value));
const oneIn = (precision: number) => (precision >= 1 ? "none" : `1 in ${Math.round(1 / (1 - precision))}`);

/** How close a repository's record is to proving the target: its lower bound on a bar, with the target marked. */
function Proof({ repo, target }: { repo: Repo; target: number }) {
  const lower = repo.lowerBound ?? 0;
  const decided = repo.agreed + repo.against;
  const status = decided === 0
    ? "No decided findings yet."
    : repo.lowerBound !== null && repo.lowerBound >= target
      ? `The record proves the target: with 95% confidence, at most ${oneIn(target)} auto-posted findings would be ones you drop.`
      : repo.needed === null
        ? "Out of reach at this record: too many findings it would post were dropped."
        : `${plural(repo.needed, "more agreeing finding")} in a row would prove the target.`;
  return (
    <div data-proof={repo.repo}>
      <div role="img" aria-label={`Lower bound ${percent(lower)} of a ${percent(target)} target`} className="relative h-2.5 overflow-hidden rounded-full bg-background">
        <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(1, lower)) * 100}%`, background: lower >= target ? color(3) : color(1) }} />
        <div aria-hidden className="absolute inset-y-0 w-0.5 bg-foreground" style={{ left: `${target * 100}%` }} />
      </div>
      <div className="mt-1.5 text-[11.5px] text-muted-foreground">{status}</div>
    </div>
  );
}

function RepoCard({ repo, target }: { repo: Repo; target: number }) {
  const decided = repo.agreed + repo.against;
  return (
    <section data-auto-post-repo={repo.repo} className="min-w-0 rounded-lg border border-border bg-card px-3.5 py-3">
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 truncate font-mono text-[13px] font-semibold">{repo.repo}</h3>
        <Pill tone={repo.mode === "shadow" ? "info" : "neutral"} icon={repo.mode === "shadow" ? "Eye" : undefined}>{repo.mode === "shadow" ? "Shadow" : "Off"}</Pill>
        <span className="ml-auto text-[11.5px] text-muted-foreground">{plural(repo.drafts, "draft")} checked, {repo.wouldPost} would post</span>
      </div>
      <div className="grid grid-cols-2 gap-2.5 @3xl:grid-cols-4">
        <Kpi label="Precision" value={ratio(repo.precision)} sub={decided ? `${repo.agreed} of ${decided} decided findings` : "no decided findings"} />
        <Kpi label="Proven at least" value={ratio(repo.lowerBound)} sub={`95% lower bound, target ${percent(target)}`} warn={repo.lowerBound !== null && repo.lowerBound < target} />
        <Kpi label="Missed" value={String(repo.missed)} sub="held findings you posted" />
        <Kpi label="Waiting on you" value={String(repo.pending)} sub="findings it would post" />
      </div>
      <div className="mt-3"><Proof repo={repo} target={target} /></div>
      <table className={`${table} mt-3`} data-confusion={repo.repo}>
        <thead><tr><th>Auto post</th><th className="!text-right">You posted</th><th className="!text-right">You dropped</th><th className="!text-right">Not decided</th></tr></thead>
        <tbody>
          <tr><td>Would post</td><td className="text-right">{repo.agreed}{repo.edited ? <span className="text-muted-foreground"> ({repo.edited} edited)</span> : null}</td><td className="text-right">{repo.against}</td><td className="text-right">{repo.pending}</td></tr>
          <tr><td>Held</td><td className="text-right">{repo.missed}</td><td className="text-right">{repo.held}</td><td className="text-right text-muted-foreground">\u2014</td></tr>
        </tbody>
      </table>
      <div className="mt-2 text-[11.5px] text-muted-foreground">
        Approvals, for later: {plural(repo.approvals.drafts, "draft")} suggested approving; you posted {repo.approvals.posted} and discarded {repo.approvals.discarded}.
      </div>
    </section>
  );
}

const W = 300;
const H = 220;
const PAD = 28;

/** Each finding the verifier judged: how sure it was that the finding holds, and that it is worth posting. */
function Scatter({ points, floors }: { points: AutoPostInsights["points"]; floors: { holds: number; worth: number } | null }) {
  if (points.length === 0) return <div className="text-sm text-muted-foreground">The verifier has not judged a finding in this range.</div>;
  const x = (v: number) => PAD + v * (W - PAD - 8);
  const y = (v: number) => H - PAD - v * (H - PAD - 8);
  const shown = (Object.keys(LABEL_TEXT) as ShadowLabel[]).filter((label) => points.some((p) => p.label === label));
  return (
    <>
      <svg data-chart="scatter" viewBox={`0 0 ${W} ${H}`} width="100%" className="block max-w-md text-muted-foreground">
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={x(0)} x2={x(1)} y1={y(t)} y2={y(t)} stroke="currentColor" opacity={0.12} />
            <text x={2} y={y(t) + 3} fontSize={9} fill="currentColor" opacity={0.55}>{t}</text>
            <text x={x(t)} y={H - 12} fontSize={9} textAnchor="middle" fill="currentColor" opacity={0.55}>{t}</text>
          </g>
        ))}
        {floors && <line x1={x(floors.holds)} x2={x(floors.holds)} y1={y(0)} y2={y(1)} stroke="currentColor" strokeDasharray="3 3" opacity={0.5} />}
        {floors && <line x1={x(0)} x2={x(1)} y1={y(floors.worth)} y2={y(floors.worth)} stroke="currentColor" strokeDasharray="3 3" opacity={0.5} />}
        <text x={(x(0) + x(1)) / 2} y={H - 1} fontSize={9.5} textAnchor="middle" fill="currentColor" opacity={0.7}>holds</text>
        <text x={10} y={y(1) - 1} fontSize={9.5} fill="currentColor" opacity={0.7}>worth posting</text>
        {points.map((point, i) => (
          <circle key={i} cx={x(point.holds)} cy={y(point.worth)} r={4} fill={LABEL_COLOR[point.label]} opacity={0.85}>
            <title>{`${LABEL_TEXT[point.label]}: holds ${point.holds.toFixed(2)}, worth ${point.worth.toFixed(2)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-muted-foreground">
        {shown.map((label) => <span key={label} className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block size-2.5 rounded-full" style={{ background: LABEL_COLOR[label] }} />{LABEL_TEXT[label]}</span>)}
        {floors && <span>Dashed lines: your floors</span>}
      </div>
    </>
  );
}

function Reasons({ reasons }: { reasons: AutoPostInsights["reasons"] }) {
  if (reasons.length === 0) return <div className="text-sm text-muted-foreground">Nothing was held in this range.</div>;
  const max = Math.max(...reasons.map((r) => r.count));
  return (
    <ul className="flex flex-col gap-1.5" data-hold-reasons>
      {reasons.map((reason) => (
        <li key={`${reason.check}:${reason.reason}`} className="text-xs">
          <div className="flex items-baseline gap-2">
            <span className="w-16 shrink-0 text-[10.5px] uppercase tracking-wide text-muted-foreground">{reason.check === "draft" ? "Draft" : reason.check}</span>
            <span className="min-w-0 flex-1 truncate" title={reason.reason}>{reason.reason}</span>
            <b>{reason.count}</b>
          </div>
          <div className="ml-[4.5rem] mt-0.5 h-1.5 rounded-full bg-background"><div className="h-full rounded-full" style={{ width: `${(reason.count / max) * 100}%`, background: color(2) }} /></div>
        </li>
      ))}
    </ul>
  );
}

function Recent({ rows, onOpenPr }: { rows: AutoPostInsights["recent"]; onOpenPr(key: string): void }) {
  if (rows.length === 0) return <div className="text-sm text-muted-foreground">No drafts were checked in this range.</div>;
  return (
    <div className="overflow-x-auto">
      <table className={table} data-recent-decisions>
        <thead><tr><th>PR</th><th>Checked</th><th>Auto post</th><th>You</th><th>Why it held</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.draftId}>
              <td className="max-w-[18rem]">
                <button type="button" className="block max-w-full cursor-pointer truncate text-left text-primary hover:underline" title={row.title} onClick={() => onOpenPr(row.key)}>{row.display}</button>
                <div className="truncate text-[11px] text-muted-foreground">{row.title}</div>
              </td>
              <td className="whitespace-nowrap text-muted-foreground">{ago(row.at)}</td>
              <td className="whitespace-nowrap">
                {row.decision === "post"
                  ? <Pill tone="ok" icon="Check">Would post {row.posting} of {row.findings}</Pill>
                  : <Pill tone="neutral">Held</Pill>}
              </td>
              <td className="whitespace-nowrap">
                {OUTCOME_TEXT[row.outcome]}
                {row.decision === "post" && row.agreed + row.against > 0 && <div className="text-[11px] text-muted-foreground">{row.agreed} agreed, {row.against} not</div>}
              </td>
              <td className="max-w-[22rem] text-muted-foreground"><span className="line-clamp-2">{row.reason ?? "\u2014"}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Insights › Auto post: shadow mode's record, per repository, with what held drafts back and how the verifier scored. */
export function AutoPostView({ onOpenPr }: { onOpenPr(key: string): void }) {
  const pluginId = experimental_usePluginId();
  const [range, setRange] = useState<Range>("30d");
  const query = useShuttleQuery("autoPostInsights", { range });
  const config = useShuttleQuery("getConfig", {}).data;
  const data = query.data;
  const floors = config ? config.config.autoPost.floors : null;
  return (
    <div data-auto-post-insights>
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <Segmented label="Range" value={range} onChange={setRange} options={RANGES} />
        {data !== undefined && <span className="text-[11px] text-muted-foreground">Target {percent(data.target)}: at most {oneIn(data.target)} auto-posted findings you would drop</span>}
      </div>
      {query.error !== null && <ErrorNote>Could not load auto post's record: {messageOf(query.error)}</ErrorNote>}
      {data === undefined && query.error === null && <InsightsSkeleton label="Loading auto post's record" />}
      {data !== undefined && data.repos.length === 0 && (
        <div data-auto-post-empty className="rounded-lg border border-border bg-card px-3.5 py-3 text-sm">
          <div className="flex items-center gap-1.5 font-semibold"><Icon name="Eye" className="size-4" aria-hidden />Auto post is off</div>
          <div className="mt-1 text-muted-foreground">
            Add a repository in shadow mode under{" "}
            <UrlLink href={settingsHref(pluginId)} className="text-primary hover:underline">Settings › Automations › Auto post</UrlLink>. Shuttle then checks each AI review draft there, records what it would post, and this page compares that with what you post.
          </div>
        </div>
      )}
      {data !== undefined && data.repos.length > 0 && (
        <>
          <div className="grid grid-cols-1 gap-3 @[90rem]:grid-cols-2">
            {data.repos.map((repo, index) => <RepoCard key={`${index}:${repo.repo}`} repo={repo} target={data.target} />)}
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 @4xl:grid-cols-2">
            <Panel title="How the verifier scored each finding" sub={`${plural(data.verifier.runs, "finding")} judged, ${data.verifier.failures} failed; median ${data.verifier.medianMs === null ? "\u2014" : seconds(data.verifier.medianMs)} to check a draft`}>
              <Scatter points={data.points} floors={floors} />
            </Panel>
            <Panel title="Why drafts and findings were held" sub="Most frequent first; numbers in a reason are shown as N">
              <Reasons reasons={data.reasons} />
            </Panel>
          </div>
          <div className="mt-3">
            <Panel title="Recent decisions" sub={`The latest ${plural(data.recent.length, "draft")} auto post checked, ${data.range}`}>
              <Recent rows={data.recent} onOpenPr={onOpenPr} />
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
