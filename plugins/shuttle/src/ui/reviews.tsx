import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { PrView } from "../contract";
import { ErrorNote, FIELD, PAGE, PageHeading } from "./common";
import { REVIEW_GROUPS, SOURCE_META, type Group } from "./constants";
import { messageOf, useShuttleQuery } from "./data";
import { SOURCES, type Route, type Source } from "./route";
import { GroupList, ReviewRow, type RowLayout } from "./row";

export interface ReviewFilter {
  team: string;
  hideBots: boolean;
  hideQuiet: boolean;
}

export const DEFAULT_FILTER: ReviewFilter = { team: "all", hideBots: true, hideQuiet: true };
const OTHER: Group = { title: "Other", kinds: [], description: "" };

const has = (pr: PrView, reason: string) => pr.reasons.some((item) => item.reason === reason);

export function inSource(pr: PrView, source: Source): boolean {
  switch (source) {
    case "all": return true;
    case "asked": return has(pr, "requested");
    case "team": return has(pr, "team");
    case "mentioned": return has(pr, "mentioned");
    case "tracked": return pr.tracked;
  }
}

export const sourceCounts = (prs: readonly PrView[]) =>
  Object.fromEntries(SOURCES.map((source) => [source, prs.filter((pr) => inSource(pr, source)).length])) as Record<Source, number>;

/** Each team that asks, with how many PRs ask it, the busiest first. */
function teamsOf(prs: readonly PrView[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const pr of prs) for (const team of new Set(pr.teams)) counts.set(team, (counts.get(team) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function Toggle({ on, label, count, onChange }: { on: boolean; label: string; count: number; onChange(next: boolean): void }) {
  return (
    <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border py-0.5 pl-1.5 pr-2.5 text-xs ${on ? "border-primary/45 text-foreground" : "border-border text-muted-foreground"}`}>
      <input type="checkbox" checked={on} onChange={(event) => onChange(event.target.checked)} className="size-3.5 cursor-pointer accent-primary" />
      {label} <span data-hidden-count className="text-muted-foreground">{count}</span>
    </label>
  );
}

/** Other people's PRs in one list: pick a source, hide bots and quiet ones, grouped by where your review stands. */
export function ReviewsView({ source, filter, layout, onFilter, onGo }: {
  source: Source;
  filter: ReviewFilter;
  layout: RowLayout;
  onFilter(next: ReviewFilter): void;
  onGo(route: Route): void;
}) {
  const list = useShuttleQuery("list", { area: "reviews" });
  const prs = list.data?.prs;
  const counts = prs === undefined ? null : sourceCounts(prs);
  const teamPrs = (prs ?? []).filter((pr) => inSource(pr, "team"));
  const teams = teamsOf(teamPrs);
  const team = source === "team" && teams.some(([name]) => name === filter.team) ? filter.team : "all";
  const inScope = (prs ?? []).filter((pr) => inSource(pr, source) && (source !== "team" || team === "all" || pr.teams.includes(team)));
  const bots = inScope.filter((pr) => pr.bot).length;
  const quiet = inScope.filter((pr) => pr.quiet && !pr.bot).length;
  const shown = inScope.filter((pr) => !(filter.hideBots && pr.bot) && !(filter.hideQuiet && pr.quiet));
  const chip = (on: boolean) => `inline-flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs ${on ? "border-primary/45 bg-accent text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`;
  const row = (pr: PrView) => <ReviewRow key={pr.key} pr={pr} layout={layout} />;
  const grouped = new Set(REVIEW_GROUPS.flatMap((group) => group.kinds));
  const oldestFirst = (items: PrView[]) => [...items].sort((a, b) => (a.requestedAt ?? Number.POSITIVE_INFINITY) - (b.requestedAt ?? Number.POSITIVE_INFINITY));

  return (
    <div className={PAGE}>
      <PageHeading title="Reviews" description="Other people's PRs: ones that ask you or your teams, mention you, or that you track. Grouped by where your review stands." />
      <div role="group" aria-label="Source" className="mb-2 flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
        {SOURCES.map((item) => (
          <button key={item} type="button" aria-pressed={item === source} className={chip(item === source)} onClick={() => onGo({ view: "reviews", source: item, key: null })}>
            {SOURCE_META[item].chip}{counts !== null && <b className="font-semibold text-foreground">{counts[item]}</b>}
          </button>
        ))}
      </div>
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        {source === "team" && (
          <select aria-label="Team" className={`${FIELD} h-7 py-0 text-xs`} value={team} onChange={(event) => onFilter({ ...filter, team: event.target.value })}>
            <option value="all">All my teams · {teamPrs.length}</option>
            {teams.map(([name, count]) => <option key={name} value={name}>{name} · {count}</option>)}
          </select>
        )}
        <Toggle on={filter.hideBots} label="Hide bots" count={bots} onChange={(hideBots) => onFilter({ ...filter, hideBots })} />
        <Toggle on={filter.hideQuiet} label="Hide quiet for 30+ days" count={quiet} onChange={(hideQuiet) => onFilter({ ...filter, hideQuiet })} />
      </div>
      {list.error !== null && <ErrorNote>{messageOf(list.error)}</ErrorNote>}
      {prs === undefined && list.error === null && <div className="py-6 text-sm text-muted-foreground">Loading…</div>}
      {prs !== undefined && source === "tracked" && inScope.length === 0 && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          <Icon name="Pin" className="size-3.5" aria-hidden />Nothing tracked. Paste any PR link in the look-up field, then press Track.
        </div>
      )}
      {prs !== undefined && source !== "tracked" && shown.length === 0 && (
        <div className="py-10 text-center text-sm text-muted-foreground">{inScope.length === 0 ? "Nothing here." : "Everything here is hidden by the filters above."}</div>
      )}
      {REVIEW_GROUPS.map((group) => {
        const members = shown.filter((pr) => group.kinds.includes(pr.next.kind));
        return <GroupList key={group.title} group={group} prs={group.title === "Not reviewed yet" ? oldestFirst(members) : members} layout={layout} row={row} />;
      })}
      <GroupList group={OTHER} prs={shown.filter((pr) => !grouped.has(pr.next.kind))} layout={layout} row={row} />
    </div>
  );
}
