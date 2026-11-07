// What the docs, the code and the tests must not name: one company's servers, tools and accounts. The capitalized names
// are also ordinary words (a delta, the world), so only their capitalized form counts; the rest count in any case, inside
// a host name too, such as a forge at delta.shopify.io.
const CAPITALIZED = /\b(?:Delta|World)\b/gu;
const ANY_CASE = /shopify|\b(?:aquifer|binks|shipit)\b|\bshop\/world\b|\bdt pr\b/giu;

/** Each company name in `text`, in the order it appears; empty when there is none. */
export function companyNamesIn(text: string): string[] {
  return [...text.matchAll(CAPITALIZED), ...text.matchAll(ANY_CASE)].sort((a, b) => a.index - b.index).map((match) => match[0]);
}
