// Keyword matching, shared by the server's search and every list's filter in the page, so both rank a PR the same way.

/** A word, or a PR number written "#2213" or "!77", which matches numbers that start with it. */
export type SearchTerm = { text: string } | { number: string };

/** Words past this many cannot narrow a list any further in practice; they are ignored. */
const MAX_TERMS = 20;

/** "@dana" is a login: it matches as "dana". */
export function searchTerms(query: string): SearchTerm[] {
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word !== "")
    .slice(0, MAX_TERMS)
    .map((word) => (/^[#!]\d+$/u.test(word) ? { number: word.slice(1) } : { text: word.replace(/^@(?=.)/u, "") }));
}

/** What a PR is matched on, lowercased. */
export interface MatchText {
  title: string;
  repo: string;
  /** The author, `repo#123`, the key, both branches, the server's name and the labels. */
  details: string;
  /** "" while Shuttle has no description. */
  description: string;
  number: number;
}

/** The fields of a PR that matching reads, as the server's rows and the page's PRs both carry them. */
export interface Matchable {
  key: string;
  title: string;
  repo: string;
  number: number;
  sep: string;
  author: string;
  headRef: string | null;
  base: string | null;
  serverName: string;
  labels: readonly { name: string }[] | null;
  body: string | null;
}

export function matchText(pr: Matchable): MatchText {
  const labels = (pr.labels ?? []).map((label) => label.name);
  return {
    title: pr.title.toLowerCase(),
    repo: pr.repo.toLowerCase(),
    details: [pr.author, `${pr.repo}${pr.sep}${pr.number}`, pr.key, pr.headRef ?? "", pr.base ?? "", pr.serverName, ...labels].join("\n").toLowerCase(),
    // HTML comments are a template's instructions, not what the author wrote.
    description: (pr.body ?? "").replace(/<!--[\s\S]*?-->/gu, " ").toLowerCase(),
    number: pr.number,
  };
}

/** The fields in the order they rank: each word counts for the first one that holds it. */
const FIELDS = ["title", "repo", "details", "description"] as const;

/** How many words each field holds. */
export type Rank = Record<(typeof FIELDS)[number], number>;

/**
 * Null unless every word is somewhere and every number term starts the PR's number. `described` are words the
 * description is known to hold when the text has no description: a word inside one of them is in the description too.
 */
export function rankOf(terms: readonly SearchTerm[], text: MatchText, described: readonly string[] = []): Rank | null {
  const rank: Rank = { title: 0, repo: 0, details: 0, description: 0 };
  for (const term of terms) {
    if ("number" in term) {
      if (!String(text.number).startsWith(term.number)) return null;
      continue;
    }
    const field = FIELDS.find((name) => text[name].includes(term.text)) ?? (described.some((word) => word.includes(term.text)) ? "description" : undefined);
    if (field === undefined) return null;
    rank[field] += 1;
  }
  return rank;
}

/** The words of `words` that a PR's description must hold: those no other field of `text` holds. */
export function describedWords(words: readonly string[], text: MatchText): string[] {
  return words.filter((word) => !FIELDS.some((name) => name !== "description" && text[name].includes(word)));
}

export const textWords = (terms: readonly SearchTerm[]) => terms.flatMap((term) => ("text" in term ? [term.text] : []));

/** Negative when `a` ranks first: more words in the title, then in the repository, then in the details, then in the description. */
export function compareRanks(a: Rank, b: Rank): number {
  return b.title - a.title || b.repo - a.repo || b.details - a.details || b.description - a.description;
}

/** Whether a word has to be in the description for the PR to match: then only a reader of descriptions can find it. */
export const needsDescription = (rank: Rank) => rank.description > 0;
