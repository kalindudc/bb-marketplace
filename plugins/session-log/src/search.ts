export const MATCH_HIGHLIGHT = "sl-search-match";
export const CURRENT_HIGHLIGHT = "sl-search-current";
// Row parts that are not the row's content (time, badges, actions); search skips them.
export const NO_SEARCH_ATTRIBUTE = "data-sl-nosearch";

export interface SearchMatch {
  entryId: string;
  // Null when the row matched on text it does not render as plain DOM, such as bb's diff viewer.
  range: Range | null;
}

export interface MatchPosition {
  entryId: string;
  ordinal: number;
}

export function findMatches(root: ParentNode, needle: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  if (!needle) return matches;
  for (const row of root.querySelectorAll<HTMLElement>("[data-entry-id]")) {
    const entryId = row.dataset.entryId!;
    const ranges = rowMatches(row, needle);
    if (ranges.length === 0) matches.push({ entryId, range: null });
    for (const range of ranges) matches.push({ entryId, range });
  }
  return matches;
}

function rowMatches(row: HTMLElement, needle: string): Range[] {
  const doc = row.ownerDocument;
  const walker = doc.createTreeWalker(row, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT
      : (node as Element).hasAttribute(NO_SEARCH_ATTRIBUTE) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP,
  });
  // One string per row, so a match split across elements (syntax-highlighted tokens, bold text) still counts.
  const nodes: Text[] = [];
  const starts: number[] = [];
  let haystack = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const lower = text.data.toLowerCase();
    nodes.push(text);
    starts.push(haystack.length);
    // Lowercasing a few characters (İ) changes their length, which would shift every later offset.
    haystack += lower.length === text.data.length ? lower : text.data;
  }
  const ranges: Range[] = [];
  let first = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
    const end = at + needle.length;
    while (first + 1 < nodes.length && starts[first + 1]! <= at) first++;
    let last = first;
    while (last + 1 < nodes.length && starts[last + 1]! < end) last++;
    const range = doc.createRange();
    range.setStart(nodes[first]!, at - starts[first]!);
    range.setEnd(nodes[last]!, end - starts[last]!);
    ranges.push(range);
  }
  return ranges;
}

export function indexOfMatch(matches: readonly SearchMatch[], position: MatchPosition | null): number | null {
  if (!position) return null;
  let ordinal = 0;
  for (const [index, match] of matches.entries()) {
    if (match.entryId !== position.entryId) continue;
    if (ordinal === position.ordinal) return index;
    ordinal++;
  }
  return null;
}

export function positionOf(matches: readonly SearchMatch[], index: number): MatchPosition {
  const { entryId } = matches[index]!;
  let ordinal = 0;
  for (let before = 0; before < index; before++) if (matches[before]!.entryId === entryId) ordinal++;
  return { entryId, ordinal };
}

// Every open Session Log panel shares the document's highlight registry, so each one publishes its
// ranges here and one panel never replaces another's.
const published = new Map<object, { ranges: readonly Range[]; current: Range | null }>();

export function publishHighlights(owner: object, matches: readonly SearchMatch[], current: Range | null): void {
  const ranges = matches.flatMap((match) => match.range ? [match.range] : []);
  if (ranges.length === 0) published.delete(owner);
  else published.set(owner, { ranges, current });
  paint();
}

function paint(): void {
  const registry = globalThis.CSS?.highlights;
  if (!registry) return;
  const all = new Highlight();
  const current = new Highlight();
  for (const panel of published.values()) {
    for (const range of panel.ranges) if (range !== panel.current) all.add(range);
    if (panel.current) current.add(panel.current);
  }
  for (const [name, highlight] of [[MATCH_HIGHLIGHT, all], [CURRENT_HIGHLIGHT, current]] as const) {
    if (highlight.size > 0) registry.set(name, highlight);
    else registry.delete(name);
  }
}
