import { useMemo, useState } from "react";
import { useSettings } from "@get-bb/plugin-sdk/app";
import type { PrView } from "../contract";
import { ErrorNote, FIELD_SMALL, PAGE, PageHeading } from "./common";
import { messageOf, useShuttleQuery } from "./data";
import { BoardChooserDialog, BoardFormDialog, BoardSelectionToolbar, useBoardSelection } from "./boards";
import { plural } from "./format";
import { SortSelect } from "./mine";
import { isLive } from "./pills";
import { REVIEWED_STATES, REVIEWED_VERDICTS, reviewedFilter, reviewedSort, type ReviewedState, type ReviewedVerdict } from "./prefs";
import { useStored } from "./remember";
import { ReviewsTabs } from "./reviews";
import type { Route } from "./route";
import { KeywordField, NoMatches, useListFilter } from "./keywords";
import { ProgressiveRows, ReviewedRow, type RowLayout } from "./row";
import { PrListSkeleton } from "./skeleton";
import { REVIEWED_SORTS, rowTime, sortPrs } from "./sort";

const STATE_LABELS: Record<ReviewedState, string> = { all: "All", open: "Open", merged: "Merged", closed: "Closed" };
const VERDICT_LABELS: Record<ReviewedVerdict, string> = { all: "Any verdict", approve: "Approved", changes: "Requested changes", comment: "Commented" };

export function inState(pr: PrView, state: ReviewedState): boolean {
  switch (state) {
    case "all": return true;
    case "open": return isLive(pr);
    case "merged": return pr.state === "merged";
    case "closed": return pr.state === "closed";
  }
}

/** A dismissed review counts only under Any verdict, as the server no longer counts it either. */
const hasVerdict = (pr: PrView, verdict: ReviewedVerdict) => verdict === "all" || pr.myReview?.verdict === verdict;

/** Every PR of someone else's that you reviewed, in the order you pick. */
export function ReviewedView({ layout, onGo }: { layout: RowLayout; onGo(route: Route): void }) {
  const list = useShuttleQuery("list", { area: "reviewed" });
  const days = useSettings().values?.reviewedDays;
  const sort = useStored(reviewedSort);
  const filter = useStored(reviewedFilter);
  const { query, setQuery, filter: keyword } = useListFilter("reviewed");
  const boardSelection = useBoardSelection();
  const [boardDialog, setBoardDialog] = useState<null | "create" | "choose">(null);
  const prs = list.data?.prs;
  const byVerdict = useMemo(() => (prs ?? []).filter((pr) => hasVerdict(pr, filter.verdict)), [prs, filter.verdict]);
  const filtered = useMemo(() => (prs === undefined ? undefined : sortPrs(byVerdict.filter((pr) => inState(pr, filter.state)), sort)), [prs, byVerdict, filter.state, sort]);
  // The best keyword matches first; the sort orders equals.
  const shown = useMemo(() => (filtered === undefined ? undefined : keyword.apply(filtered)), [filtered, keyword]);
  const counts = Object.fromEntries(REVIEWED_STATES.map((state) => [state, byVerdict.filter((pr) => inState(pr, state)).length])) as Record<ReviewedState, number>;
  const selectedSet = useMemo(() => new Set(boardSelection.selected), [boardSelection.selected]);
  const chip = (on: boolean) => `inline-flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs ${on ? "border-input bg-state-active text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`;
  const { toggle } = boardSelection;
  // Rebuilt only when what the rows show changes, not on every keystroke in the filter.
  const rows = useMemo(() => shown !== undefined && shown.length > 0 && (
    <ul aria-label="Pull requests" className="mt-2 overflow-hidden rounded-lg border border-border bg-card">
      <ProgressiveRows prs={shown} row={(pr) => <ReviewedRow key={pr.key} pr={pr} layout={{ ...layout, selection: { checked: selectedSet.has(pr.key), onToggle: () => toggle(pr.key) } }} time={rowTime(pr, sort)} />} />
    </ul>
  ), [shown, layout, selectedSet, toggle, sort]);
  const span = plural(typeof days === "number" ? days : 90, "day");
  return (
    <div className={PAGE}>
      <PageHeading title="Reviewed by me" description={`Other people's PRs you reviewed, open, merged and closed. Shuttle reads the merged and closed ones from the last ${span}, and keeps each one it has.`}>
        <ReviewsTabs value="reviewed" onGo={onGo} />
      </PageHeading>
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        {prs !== undefined && prs.length > 0 && (
          <KeywordField value={query} onChange={setQuery} label="Filter the PRs you reviewed" count={{ shown: shown!.length, total: filtered!.length }} unavailable={keyword.unavailable} phone={layout.phone} className="w-72 @max-[560px]:w-full" />
        )}
        <div role="group" aria-label="State" className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {REVIEWED_STATES.map((state) => (
            <button key={state} type="button" data-state-filter={state} aria-pressed={state === filter.state} className={chip(state === filter.state)} onClick={() => reviewedFilter.set({ ...filter, state })}>
              {STATE_LABELS[state]}{prs !== undefined && <b className="font-semibold text-foreground">{counts[state]}</b>}
            </button>
          ))}
        </div>
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <select aria-label="Verdict" className={FIELD_SMALL} value={filter.verdict} onChange={(event) => reviewedFilter.set({ ...filter, verdict: event.target.value as ReviewedVerdict })}>
            {REVIEWED_VERDICTS.map((verdict) => <option key={verdict} value={verdict}>{VERDICT_LABELS[verdict]}</option>)}
          </select>
          <SortSelect value={sort} options={REVIEWED_SORTS} onChange={(next) => reviewedSort.set(next)} />
        </span>
      </div>
      {((shown !== undefined && shown.length > 0) || boardSelection.selected.length > 0) && <BoardSelectionToolbar selected={boardSelection.selected} onCreate={() => setBoardDialog("create")} onAdd={() => setBoardDialog("choose")} onClear={boardSelection.clear} />}
      {list.error !== null && <ErrorNote>{messageOf(list.error)}</ErrorNote>}
      {prs === undefined && list.error === null && <PrListSkeleton label="Loading the PRs you reviewed" />}
      {filtered !== undefined && filtered.length > 0 && shown!.length === 0 && <NoMatches query={keyword.query} onClear={() => setQuery("")} />}
      {filtered !== undefined && filtered.length === 0 && (
        <div className="py-10 text-center text-sm text-muted-foreground">{prs!.length === 0 ? "No reviews yet. PRs you review show here, and stay after they merge." : "Nothing matches the filters above."}</div>
      )}
      {rows}
      {boardDialog === "choose" && <BoardChooserDialog prs={boardSelection.selected} onClose={() => setBoardDialog(null)} onCreateBoard={() => setBoardDialog("create")} />}
      {boardDialog === "create" && <BoardFormDialog mode="create" prs={boardSelection.selected} onClose={() => setBoardDialog(null)} />}
    </div>
  );
}
