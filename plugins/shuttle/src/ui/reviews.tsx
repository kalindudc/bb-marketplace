import { useEffect, useMemo, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { PrView } from "../contract";
import { ErrorNote, FIELD_SMALL, PAGE, PageHeading, Segmented } from "./common";
import { REVIEW_GROUPS, SOURCE_META, type Group } from "./constants";
import { messageOf, useShuttleQuery } from "./data";
import { BoardChooserDialog, BoardFormDialog, BoardSelectionToolbar, useBoardSelection } from "./boards";
import { useFolding, type ReviewFilter } from "./prefs";
import { SOURCES, type Route, type Source } from "./route";
import { KeywordField, NoMatches, useKeywordFilter, useKeywordQuery } from "./keywords";
import { FoldAllButton, GroupList, ReviewRow, type RowLayout } from "./row";
import { PrListSkeleton } from "./skeleton";

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
    <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border py-0.5 pl-1.5 pr-2.5 text-xs ${on ? "border-input bg-state-active text-foreground" : "border-border text-muted-foreground"}`}>
      <input type="checkbox" checked={on} onChange={(event) => onChange(event.target.checked)} className="size-3.5 cursor-pointer accent-foreground" />
      {label} <span data-hidden-count className="text-muted-foreground">{count}</span>
    </label>
  );
}

/** Reviews' two lists: the PRs that wait on your review, and the ones you reviewed. */
export function ReviewsTabs({ value, onGo }: { value: "reviews" | "reviewed"; onGo(route: Route): void }) {
  return (
    <Segmented label="Reviews" value={value} onChange={(view) => onGo(view === "reviews" ? { view, source: "all", key: null } : { view, key: null })}
      options={[{ value: "reviews" as const, label: "To review" }, { value: "reviewed" as const, label: "Reviewed" }]} />
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
  const [query, setQuery] = useKeywordQuery("reviews");
  const keyword = useKeywordFilter(query);
  const boardSelection = useBoardSelection();
  const [boardDialog, setBoardDialog] = useState<null | "create" | "choose">(null);
  useEffect(() => boardSelection.clear(), [source]);
  const prs = list.data?.prs;
  const counts = prs === undefined ? null : sourceCounts(prs);
  const teamPrs = (prs ?? []).filter((pr) => inSource(pr, "team"));
  const teams = teamsOf(teamPrs);
  const team = source === "team" && teams.some(([name]) => name === filter.team) ? filter.team : "all";
  const inScope = (prs ?? []).filter((pr) => inSource(pr, source) && (source !== "team" || team === "all" || pr.teams.includes(team)));
  const bots = inScope.filter((pr) => pr.bot).length;
  const quiet = inScope.filter((pr) => pr.quiet && !pr.bot).length;
  const unfiltered = inScope.filter((pr) => !(filter.hideBots && pr.bot) && !(filter.hideQuiet && pr.quiet));
  const shown = keyword.active ? unfiltered.filter((pr) => keyword.rank(pr) !== null) : unfiltered;
  // What the words match among the PRs Hide bots and Hide quiet keep out.
  const kept = new Set(unfiltered);
  const hiddenMatches = keyword.active ? inScope.filter((pr) => !kept.has(pr) && keyword.rank(pr) !== null).length : 0;
  const chip = (on: boolean) => `inline-flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs ${on ? "border-input bg-state-active text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`;
  const selectedSet = useMemo(() => new Set(boardSelection.selected), [boardSelection.selected]);
  const row = (pr: PrView) => <ReviewRow key={pr.key} pr={pr} layout={{ ...layout, selection: { checked: selectedSet.has(pr.key), onToggle: () => boardSelection.toggle(pr.key) } }} />;
  const grouped = new Set(REVIEW_GROUPS.flatMap((group) => group.kinds));
  const oldestFirst = (items: PrView[]) => [...items].sort((a, b) => (a.requestedAt ?? Number.POSITIVE_INFINITY) - (b.requestedAt ?? Number.POSITIVE_INFINITY));
  const folding = useFolding("reviews");
  const sections = [...REVIEW_GROUPS, OTHER].map((group) => {
    const members = group === OTHER ? shown.filter((pr) => !grouped.has(pr.next.kind)) : shown.filter((pr) => group.kinds.includes(pr.next.kind));
    // The best keyword matches first; the group's own order sorts equals.
    return { group, prs: keyword.apply(group.title === "Not reviewed yet" ? oldestFirst(members) : members) };
  }).filter((section) => section.prs.length > 0);

  return (
    <div className={PAGE}>
      <PageHeading title="Reviews" description="Other people's PRs: ones that ask you or your teams, mention you, or that you track. Grouped by where your review stands.">
        <ReviewsTabs value="reviews" onGo={onGo} />
      </PageHeading>
      <div role="group" aria-label="Source" className="mb-2 flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
        {SOURCES.map((item) => (
          <button key={item} type="button" aria-pressed={item === source} className={chip(item === source)} onClick={() => onGo({ view: "reviews", source: item, key: null })}>
            {SOURCE_META[item].chip}{counts !== null && <b className="font-semibold text-foreground">{counts[item]}</b>}
          </button>
        ))}
      </div>
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        {prs !== undefined && prs.length > 0 && (
          <KeywordField value={query} onChange={setQuery} label="Filter the PRs to review" count={{ shown: shown.length, total: unfiltered.length }} unavailable={keyword.unavailable} phone={layout.phone} className="w-72 @max-[560px]:w-full" />
        )}
        {source === "team" && (
          <select aria-label="Team" className={FIELD_SMALL} value={team} onChange={(event) => onFilter({ ...filter, team: event.target.value })}>
            <option value="all">All my teams · {teamPrs.length}</option>
            {teams.map(([name, count]) => <option key={name} value={name}>{name} · {count}</option>)}
          </select>
        )}
        <Toggle on={filter.hideBots} label="Hide bots" count={bots} onChange={(hideBots) => onFilter({ ...filter, hideBots })} />
        <Toggle on={filter.hideQuiet} label="Hide quiet for 30+ days" count={quiet} onChange={(hideQuiet) => onFilter({ ...filter, hideQuiet })} />
        <span className="ml-auto"><FoldAllButton titles={sections.map((section) => section.group.title)} folding={folding} /></span>
      </div>
      {(shown.length > 0 || boardSelection.selected.length > 0) && <BoardSelectionToolbar selected={boardSelection.selected} onCreate={() => setBoardDialog("create")} onAdd={() => setBoardDialog("choose")} onClear={boardSelection.clear} />}
      {list.error !== null && <ErrorNote>{messageOf(list.error)}</ErrorNote>}
      {prs === undefined && list.error === null && <PrListSkeleton label="Loading the PRs to review" />}
      {prs !== undefined && source === "tracked" && inScope.length === 0 && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          <Icon name="Pin" className="size-3.5" aria-hidden />Nothing tracked. Paste any PR link in the look-up field, then press Track.
        </div>
      )}
      {prs !== undefined && keyword.active && unfiltered.length > 0 && shown.length === 0 && <NoMatches query={keyword.query} onClear={() => setQuery("")} hidden={hiddenMatches} />}
      {prs !== undefined && keyword.active && shown.length > 0 && hiddenMatches > 0 && (
        <p data-hidden-matches className="mb-1 text-xs text-muted-foreground">{hiddenMatches === 1 ? "1 more PR matches" : `${hiddenMatches} more PRs match`}, hidden by the filters above.</p>
      )}
      {prs !== undefined && source !== "tracked" && unfiltered.length === 0 && (
        <div className="py-10 text-center text-sm text-muted-foreground">{inScope.length === 0 ? "Nothing here." : "Everything here is hidden by the filters above."}</div>
      )}
      {sections.map((section) => <GroupList key={section.group.title} group={section.group} prs={section.prs} layout={layout} row={row} folding={folding} />)}
      {boardDialog === "choose" && <BoardChooserDialog prs={boardSelection.selected} onClose={() => setBoardDialog(null)} onCreateBoard={() => setBoardDialog("create")} />}
      {boardDialog === "create" && <BoardFormDialog mode="create" prs={boardSelection.selected} onClose={() => setBoardDialog(null)} />}
    </div>
  );
}
