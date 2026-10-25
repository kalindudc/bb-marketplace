// Keyword search over the PRs Shuttle already has. Nothing is fetched: a link or a key goes to look-up instead.
import type { PrView } from "./contract";
import type { Ctx } from "./ctx";
import type { PrRow } from "./db/store";
import { parseLabels } from "./edit";
import { enabledServerIds, toView } from "./views";

export const SEARCH_LIMIT = 50;

/** A word, or a PR number written "#2213" or "!77", which matches numbers that start with it. */
export type SearchTerm = { text: string } | { number: string };

export function searchTerms(query: string): SearchTerm[] {
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word !== "")
    .map((word) => (/^[#!]\d+$/u.test(word) ? { number: word.slice(1) } : { text: word }));
}

function fields(ctx: Ctx, pr: PrRow): string {
  const server = ctx.server(pr.server);
  const sep = server?.sep ?? "#";
  const labels = (parseLabels(pr.labels) ?? []).map((label) => label.name);
  return [pr.title, pr.repo, `${pr.repo}${sep}${pr.number}`, pr.key, pr.author, pr.head_ref ?? "", pr.base ?? "", server?.name ?? pr.server, ...labels].join("\n").toLowerCase();
}

const isLive = (pr: PrRow) => pr.state === "open" || pr.state === "draft";

/**
 * Every PR of the enabled servers whose title, repository, number, author, branches, server or
 * labels hold every word. Open PRs come first, then the ones whose title holds every word, then the
 * most recently updated.
 */
export function searchPrs(ctx: Ctx, query: string): { prs: PrView[]; total: number } {
  const terms = searchTerms(query);
  if (terms.length === 0) return { prs: [], total: 0 };
  const enabled = enabledServerIds(ctx);
  const words = terms.flatMap((term) => ("text" in term ? [term.text] : []));
  const numbers = terms.flatMap((term) => ("number" in term ? [term.number] : []));
  const hits = ctx.store.allPrs().filter((pr) => {
    if (!enabled.has(pr.server)) return false;
    if (!numbers.every((prefix) => String(pr.number).startsWith(prefix))) return false;
    const text = fields(ctx, pr);
    return words.every((word) => text.includes(word));
  });
  const inTitle = (pr: PrRow) => words.every((word) => pr.title.toLowerCase().includes(word));
  const rank = (pr: PrRow) => (isLive(pr) ? 0 : 2) + (inTitle(pr) ? 0 : 1);
  // allPrs is newest first and sort is stable, so ties stay newest first.
  const ranked = hits.sort((a, b) => rank(a) - rank(b));
  return { prs: ranked.slice(0, SEARCH_LIMIT).map((pr) => toView(ctx, pr)), total: hits.length };
}
