import { useRef } from "react";
import type { PrView } from "../contract";
import { ErrorNote, PAGE, PageHeading } from "./common";
import type { Group } from "./constants";
import { messageOf, useShuttleQuery, type Output } from "./data";
import { plural } from "./format";
import { isLive } from "./pills";
import { GroupList, MineRow, ReviewRow, type RowLayout } from "./row";

const GROUPS: readonly (Group & { has(pr: PrView): boolean })[] = [
  { title: "Your open PRs", kinds: [], description: "", has: (pr) => pr.mine && isLive(pr) },
  { title: "Other people's open PRs", kinds: [], description: "", has: (pr) => !pr.mine && isLive(pr) },
  { title: "Merged and closed", kinds: [], description: "", has: (pr) => !isLive(pr) },
];

const DESCRIPTION = "Finds the PRs Shuttle already has by their title, repository, number, author, branches or labels. Every word must match; #123 is a PR number. Paste a link instead to look up a PR Shuttle has not seen.";

/** The PRs Shuttle has that match the header's search words, open ones first. */
export function SearchView({ query, layout }: { query: string; layout: RowLayout }) {
  const words = query.trim();
  const search = useShuttleQuery("search", { query: words }, words !== "");
  // While the next words load, the last results stay instead of a flash of "Loading…".
  const last = useRef<Output<"search"> | undefined>(undefined);
  if (search.data !== undefined) last.current = search.data;
  const data = words === "" ? undefined : search.data ?? last.current;
  const row = (pr: PrView) => (pr.mine ? <MineRow key={pr.key} pr={pr} layout={layout} /> : <ReviewRow key={pr.key} pr={pr} layout={layout} />);
  return (
    <div className={PAGE}>
      <PageHeading title={words === "" ? "Search" : `Search: \u201c${words}\u201d`} description={DESCRIPTION} />
      {words === "" && <div className="py-10 text-center text-sm text-muted-foreground">Type in the search box to find a PR.</div>}
      {search.error !== null && <ErrorNote>Could not search: {messageOf(search.error)}</ErrorNote>}
      {words !== "" && data === undefined && search.error === null && <div className="py-6 text-sm text-muted-foreground">Searching…</div>}
      {data !== undefined && data.total === 0 && <div className="py-10 text-center text-sm text-muted-foreground">No PR Shuttle has matches {`\u201c${words}\u201d`}.</div>}
      {data !== undefined && data.total > 0 && (
        <>
          <p data-search-count className="text-xs text-muted-foreground">
            {data.total > data.prs.length ? `The ${data.prs.length} best of ${data.total} matches. Add a word to narrow it down.` : plural(data.total, "match", "matches")}
          </p>
          {GROUPS.map((group) => <GroupList key={group.title} group={group} prs={data.prs.filter(group.has)} layout={layout} row={row} />)}
        </>
      )}
    </div>
  );
}
