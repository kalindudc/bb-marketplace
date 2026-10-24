import { experimental_Icon as Icon, useSettings } from "@get-bb/plugin-sdk/app";
import type { Overview, PrView } from "../contract";
import { useActions } from "./actions";
import { BUTTON_PRIMARY, ErrorNote, PAGE, PageHeading, Segmented, STRIP } from "./common";
import { MINE_GROUPS, type Group } from "./constants";
import { messageOf, useShuttleQuery } from "./data";
import { plural } from "./format";
import { isLive } from "./pills";
import type { Route } from "./route";
import { GroupList, MineRow, type RowLayout } from "./row";

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
    <div data-auto-agent="off" className="mb-1.5 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-sm font-bold text-primary">
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

/** Your open PRs grouped by what happens next, or your merged and closed ones. */
export function MineView({ done, layout, overview, onGo }: { done: boolean; layout: RowLayout; overview: Overview | undefined; onGo(route: Route): void }) {
  const list = useShuttleQuery("list", { area: done ? "done" : "mine" });
  const days = useSettings().values?.doneDays;
  const prs = list.data?.prs;
  const tabs = (
    <Segmented label="My PRs" value={done ? "done" : "mine"} onChange={(view) => onGo({ view, key: null })}
      options={[{ value: "mine" as const, label: "Open" }, { value: "done" as const, label: "Merged" }]} />
  );
  const grouped = new Set(MINE_GROUPS.flatMap((group) => group.kinds));
  const row = (pr: PrView) => <MineRow key={pr.key} pr={pr} layout={layout} />;
  return (
    <div className={PAGE}>
      {done
        ? <PageHeading title="Merged and closed" description={`Your PRs from the last ${plural(typeof days === "number" ? days : 14, "day")}.`}>{tabs}</PageHeading>
        : <PageHeading title="My PRs" description="Grouped by what happens next. Each row shows its checks, its reviews and its agent.">{tabs}</PageHeading>}
      {list.error !== null && <ErrorNote>{messageOf(list.error)}</ErrorNote>}
      {prs === undefined && list.error === null && <div className="py-6 text-sm text-muted-foreground">Loading…</div>}
      {prs !== undefined && prs.length === 0 && <div className="py-10 text-center text-sm text-muted-foreground">Nothing here.</div>}
      {prs !== undefined && done && prs.length > 0 && <ul aria-label="Pull requests" className="overflow-hidden rounded-lg border border-border bg-card">{prs.map(row)}</ul>}
      {prs !== undefined && !done && (
        <>
          <AutoAgent prs={prs} overview={overview} />
          {MINE_GROUPS.map((group) => <GroupList key={group.title} group={group} prs={prs.filter((pr) => group.kinds.includes(pr.next.kind))} layout={layout} row={row} />)}
          <GroupList group={OTHER} prs={prs.filter((pr) => !grouped.has(pr.next.kind))} layout={layout} row={row} />
        </>
      )}
    </div>
  );
}
