import { useEffect, useMemo, useState } from "react";
import { experimental_Icon as Icon, useSettings } from "@get-bb/plugin-sdk/app";
import type { Overview, PrView } from "../contract";
import { useActions } from "./actions";
import { BUTTON_PRIMARY, ErrorNote, FIELD_SMALL, PAGE, PageHeading, STRIP, Segmented } from "./common";
import { MINE_GROUPS, type Group } from "./constants";
import { messageOf, useShuttleQuery } from "./data";
import { BoardChooserDialog, BoardFormDialog, BoardSelectionToolbar, useBoardSelection } from "./boards";
import { plural } from "./format";
import { isLive } from "./pills";
import { doneSort, mineLayout, mineSort, useFolding } from "./prefs";
import { useStored } from "./remember";
import type { Route } from "./route";
import { FoldAllButton, GroupList, MineRow, type RowLayout } from "./row";
import { DONE_SORTS, MINE_SORTS, rowTime, SORT_LABELS, sortPrs, type SortKey } from "./sort";

const OTHER: Group = { title: "Other", kinds: [], description: "" };

function AutoAgent({ prs, overview }: { prs: readonly PrView[]; overview: Overview | undefined }) {
  const { writes } = useActions();
  if (overview === undefined) return null;
  if (overview.autoAgent) {
    return (
      <div data-auto-agent="on" className={STRIP}>
        <Icon name="Bot" className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1"><b>Auto agent is on.</b> The thread that opens a PR becomes its agent and fixes new reviews and failed checks.</span>
        <button type="button" className="cursor-pointer text-muted-foreground hover:text-foreground hover:underline" onClick={() => void writes.setAutoAgent(false)}>Turn off</button>
      </div>
    );
  }
  const open = prs.filter(isLive);
  const none = open.filter((pr) => pr.agent === null);
  if (none.length === 0) return null;
  const opened = none.filter((pr) => pr.suggestedAgent !== null).length;
  return (
    <div data-auto-agent="off" className="mb-1.5 rounded-lg border border-border bg-surface-raised px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-sm font-bold text-foreground">
        <Icon name="Bot" className="size-3.5" aria-hidden />{none.length} of your {plural(open.length, "open PR")} {none.length === 1 ? "has" : "have"} no agent
      </div>
      <div className="mb-2 mt-0.5 text-[13px]">
        Their reviews and failed checks go nowhere until you see them.
        {opened > 0 && ` ${opened} of them ${opened === 1 ? "was" : "were"} opened by a bb thread (its id is in the branch name).`} Auto agent makes that thread the PR's agent.
      </div>
      <button type="button" className={BUTTON_PRIMARY} onClick={() => void writes.setAutoAgent(true)}>
        <Icon name="Bot" className="size-3.5" aria-hidden />Turn on auto agent
      </button>
    </div>
  );
}

const LAYOUTS = [
  { value: "grouped" as const, label: "Grouped", icon: "Layers" },
  { value: "list" as const, label: "List", icon: "ListView" },
];

function SortSelect({ value, options, onChange }: { value: SortKey; options: readonly SortKey[]; onChange(next: SortKey): void }) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon name="Sort" fallback="ChevronDown" className="size-3.5" aria-hidden />
      <select aria-label="Sort by" className={FIELD_SMALL} value={value} onChange={(event) => onChange(event.target.value as SortKey)}>
        {options.map((key) => <option key={key} value={key}>{SORT_LABELS[key]}</option>)}
      </select>
    </label>
  );
}

const groupOf = (pr: PrView): Group => MINE_GROUPS.find((group) => group.kinds.includes(pr.next.kind)) ?? OTHER;

/** Your open PRs grouped by what happens next, or in one sorted list; or your merged and closed ones. */
export function MineView({ done, layout, overview, onGo }: { done: boolean; layout: RowLayout; overview: Overview | undefined; onGo(route: Route): void }) {
  const list = useShuttleQuery("list", { area: done ? "done" : "mine" });
  const days = useSettings().values?.doneDays;
  const shape = useStored(mineLayout);
  const sortStore = done ? doneSort : mineSort;
  const sort = useStored(sortStore);
  const folding = useFolding("mine");
  const boardSelection = useBoardSelection();
  const [boardDialog, setBoardDialog] = useState<null | "create" | "choose">(null);
  useEffect(() => boardSelection.clear(), [done]);
  const prs = list.data?.prs;
  const sorted = useMemo(() => (prs === undefined ? undefined : sortPrs(prs, sort)), [prs, sort]);
  const grouped = !done && shape === "grouped";
  const sections = grouped && sorted !== undefined
    ? [...MINE_GROUPS, OTHER].map((group) => ({ group, prs: sorted.filter((pr) => groupOf(pr) === group) })).filter((section) => section.prs.length > 0)
    : [];
  const tabs = (
    <Segmented label="My PRs" value={done ? "done" : "mine"} onChange={(view) => onGo({ view, key: null })}
      options={[{ value: "mine" as const, label: "Open" }, { value: "done" as const, label: "Merged" }]} />
  );
  const selectedSet = useMemo(() => new Set(boardSelection.selected), [boardSelection.selected]);
  const row = (pr: PrView) => <MineRow key={pr.key} pr={pr} layout={{ ...layout, selection: { checked: selectedSet.has(pr.key), onToggle: () => boardSelection.toggle(pr.key) } }} time={rowTime(pr, sort)} group={done || grouped ? undefined : groupOf(pr).title} />;
  const flat = (items: readonly PrView[]) => <ul aria-label="Pull requests" className="overflow-hidden rounded-lg border border-border bg-card">{items.map(row)}</ul>;
  const tools = sorted !== undefined && sorted.length > 0 && (
    <div data-list-tools className="mb-1 mt-2 flex flex-wrap items-center gap-1.5">
      {!done && <Segmented label="Show" value={shape} options={LAYOUTS} onChange={(next) => mineLayout.set(next)} />}
      <SortSelect value={sort} options={done ? DONE_SORTS : MINE_SORTS} onChange={(next) => sortStore.set(next)} />
      {grouped && <span className="ml-auto"><FoldAllButton titles={sections.map((section) => section.group.title)} folding={folding} /></span>}
    </div>
  );
  return (
    <div className={PAGE}>
      {done
        ? <PageHeading title="Merged and closed" description={`Your PRs from the last ${plural(typeof days === "number" ? days : 14, "day")}.`}>{tabs}</PageHeading>
        : <PageHeading title="My PRs" description={grouped ? "Grouped by what happens next. Each row shows its checks, its reviews and its agent." : "One list, in the order you pick. Each row shows what happens next, its checks, its reviews and its agent."}>{tabs}</PageHeading>}
      {list.error !== null && <ErrorNote>{messageOf(list.error)}</ErrorNote>}
      {prs === undefined && list.error === null && <div className="py-6 text-sm text-muted-foreground">Loading…</div>}
      {prs !== undefined && prs.length === 0 && <div className="py-10 text-center text-sm text-muted-foreground">Nothing here.</div>}
      {prs !== undefined && !done && <AutoAgent prs={prs} overview={overview} />}
      {((prs !== undefined && prs.length > 0) || boardSelection.selected.length > 0) && <BoardSelectionToolbar selected={boardSelection.selected} onCreate={() => setBoardDialog("create")} onAdd={() => setBoardDialog("choose")} onClear={boardSelection.clear} />}
      {tools}
      {sorted !== undefined && sorted.length > 0 && !grouped && flat(sorted)}
      {sections.map((section) => <GroupList key={section.group.title} group={section.group} prs={section.prs} layout={layout} row={row} folding={folding} />)}
      {boardDialog === "choose" && <BoardChooserDialog prs={boardSelection.selected} onClose={() => setBoardDialog(null)} onCreateBoard={() => setBoardDialog("create")} />}
      {boardDialog === "create" && <BoardFormDialog mode="create" prs={boardSelection.selected} onClose={() => setBoardDialog(null)} />}
    </div>
  );
}
