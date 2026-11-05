// Keyword search over the PRs Shuttle already has. Nothing is fetched: a link or a key goes to look-up instead.
import type { Config } from "./config";
import type { PrView } from "./contract";
import type { Ctx } from "./ctx";
import type { PrRow, Store } from "./db/store";
import { parseLabels } from "./edit";
import { compareRanks, matchText, needsDescription, rankOf, searchTerms, type MatchText, type Rank, type SearchTerm } from "./match";
import { allViews, enabledServerIds, toView } from "./views";

export { searchTerms, type SearchTerm };

export const SEARCH_LIMIT = 50;

interface Entry {
  /** Without its description, which only `text` keeps, lowercased. */
  pr: PrRow;
  text: MatchText;
}
interface SearchIndex {
  version: number;
  config: Config;
  entries: readonly Entry[];
}
/** What every PR of the enabled servers is matched on, newest first, kept until the store or the config changes. */
const indexes = new WeakMap<Store, SearchIndex>();

export function searchIndex(ctx: Ctx): readonly Entry[] {
  const config = ctx.config();
  const index = indexes.get(ctx.store);
  if (index && index.version === ctx.store.version && index.config === config) return index.entries;
  const enabled = enabledServerIds(ctx);
  const servers = new Map(config.servers.map((server) => [server.id, server]));
  const entries = ctx.store.allPrs({ bodies: true }).flatMap((pr): Entry[] => {
    if (!enabled.has(pr.server)) return [];
    const server = servers.get(pr.server);
    const text = matchText({
      key: pr.key, title: pr.title, repo: pr.repo, number: pr.number, sep: server?.sep ?? "#", author: pr.author,
      headRef: pr.head_ref, base: pr.base, serverName: server?.name ?? pr.server, labels: parseLabels(pr.labels), body: pr.body,
    });
    return [{ pr: { ...pr, body: null }, text }];
  });
  indexes.set(ctx.store, { version: ctx.store.version, config, entries });
  return entries;
}

/** The PRs of the enabled servers that hold every word, with their ranks, newest first. */
function matching(ctx: Ctx, query: string): { pr: PrRow; rank: Rank }[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  return searchIndex(ctx).flatMap((entry) => {
    const rank = rankOf(terms, entry.text);
    return rank === null ? [] : [{ pr: entry.pr, rank }];
  });
}

const isLive = (pr: PrRow) => pr.state === "open" || pr.state === "draft";

/**
 * Every PR of the enabled servers whose title, repository, author, number, branches, server, labels or description hold
 * every word. Open PRs come first, so merged ones never crowd them out of the limit; then the most words in the title,
 * then in the repository, then in the author, branches and labels, then in the description; then the most recently updated.
 */
export function searchPrs(ctx: Ctx, query: string): { prs: PrView[]; total: number } {
  const hits = matching(ctx, query);
  // The index is newest first and sort is stable, so ties stay newest first.
  const ranked = hits.sort((a, b) => Number(isLive(b.pr)) - Number(isLive(a.pr)) || compareRanks(a.rank, b.rank));
  const top = ranked.slice(0, SEARCH_LIMIT);
  const views = top.length === 0 ? new Map<string, PrView>() : new Map(allViews(ctx).map((view) => [view.key, view]));
  return { prs: top.map((hit) => views.get(hit.pr.key) ?? toView(ctx, hit.pr)), total: hits.length };
}

/**
 * The keys of the PRs that hold some word only in their description. A list in the page ranks every other PR itself,
 * from what each PR it shows carries; it has no descriptions, so it asks for these.
 */
export function descriptionMatches(ctx: Ctx, query: string): string[] {
  return matching(ctx, query).filter((hit) => needsDescription(hit.rank)).map((hit) => hit.pr.key);
}
