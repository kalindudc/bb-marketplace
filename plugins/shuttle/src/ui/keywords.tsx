import { useDeferredValue, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { PrView } from "../contract";
import { compareRanks, describedWords, matchText, rankOf, searchTerms, textWords, type Rank } from "../match";
import { ICON_GHOST_SMALL } from "./common";
import { useShuttleQuery } from "./data";
import { plural } from "./format";
import { keywordFilters } from "./prefs";
import { useStored } from "./remember";

/** Typing pauses this long before the server is asked for description matches; titles and the rest match at once. */
const SERVER_DELAY_MS = 150;
const KBD = "rounded border border-b-2 border-border bg-background px-1 font-mono text-[10.5px] leading-[15px] text-muted-foreground";
const EVERY: Rank = { title: 0, repo: 0, details: 0, description: 0 };

/** The server's answer: the PRs that held words of `words` only in their descriptions. */
interface Described {
  words: readonly string[];
  keys: ReadonlySet<string>;
}
const NONE: Described = { words: [], keys: new Set() };

/** One list's keyword filter, kept for this session: "inbox", "mine", "done", "reviews", "reviewed" or "board/<id>". */
export function useKeywordQuery(list: string): [string, (next: string) => void] {
  const query = useStored(keywordFilters)[list] ?? "";
  const set = (next: string) => {
    const { [list]: _old, ...rest } = keywordFilters.get();
    keywordFilters.set(next === "" ? rest : { ...rest, [list]: next });
  };
  return [query, set];
}

/**
 * A list's words and their filter. The filter lags the words by a render, so a keystroke repaints the field at once
 * and the rows after it, in a render a later keystroke can drop. A list built in a `useMemo` on `filter` is then
 * reused while you type, and so is it while description matches arrive.
 */
export function useListFilter(list: string): { query: string; setQuery(next: string): void; filter: KeywordFilter } {
  const [query, setQuery] = useKeywordQuery(list);
  const filter = useDeferredValue(useKeywordFilter(query));
  return { query, setQuery, filter };
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export interface KeywordFilter {
  /** The words, trimmed; "" when the filter is off. */
  query: string;
  active: boolean;
  /** The server could not say which descriptions hold the words, so only the rest of each PR is matched. */
  unavailable: boolean;
  /** Null when the PR does not match. */
  rank(pr: PrView): Rank | null;
  /** The best match first; 0 between equals, and always while the filter is off. */
  compare(a: PrView, b: PrView): number;
  /** The PRs that match, the best first, in the order given among equals. */
  apply(prs: readonly PrView[]): PrView[];
}

/**
 * Matches PRs on the words of `query`: every word must be in the title, repository, author, number, branches,
 * labels or description, and the most words in the title rank first, then in the repository, then the rest.
 * PRs in the page carry no description, so the server names the PRs that match only through theirs. Its answer
 * for earlier words says which words those descriptions hold, so while the next answer loads, a PR stays only
 * when those words prove it still matches, as when you delete letters; nothing that fails a word ever shows.
 */
export function useKeywordFilter(query: string): KeywordFilter {
  const trimmed = query.trim().replace(/\s+/gu, " ");
  const terms = useMemo(() => searchTerms(trimmed), [trimmed]);
  // Numbers alone never need a description.
  const words = terms.some((term) => "text" in term);
  // The server reads at most 200 characters; what it was asked is checked against every word anyway.
  const asked = useDebounced(words ? trimmed.toLowerCase().slice(0, 200) : "", SERVER_DELAY_MS);
  const remote = useShuttleQuery("descriptionMatches", { query: asked }, asked !== "");
  const last = useRef(NONE);
  const fresh = useMemo<Described | null>(() => (remote.data === undefined ? null : { words: textWords(searchTerms(asked)), keys: new Set(remote.data.keys) }), [remote.data, asked]);
  if (fresh !== null) last.current = fresh;
  // Without words, or when the server cannot say, only what the page carries matches.
  if (!words || remote.error !== null) last.current = NONE;
  const described = words && remote.error === null ? fresh ?? last.current : NONE;
  return useMemo(() => {
    const ranks = new WeakMap<PrView, Rank | null>();
    const rank = (pr: PrView): Rank | null => {
      if (terms.length === 0) return EVERY;
      if (ranks.has(pr)) return ranks.get(pr)!;
      const text = matchText({ ...pr, body: null });
      const found = rankOf(terms, text, described.keys.has(pr.key) ? describedWords(described.words, text) : []);
      ranks.set(pr, found);
      return found;
    };
    const compare = (a: PrView, b: PrView) => {
      if (terms.length === 0) return 0;
      const ra = rank(a);
      const rb = rank(b);
      if (ra === null || rb === null) return (ra === null ? 1 : 0) - (rb === null ? 1 : 0);
      return compareRanks(ra, rb);
    };
    const apply = (prs: readonly PrView[]) => (terms.length === 0 ? [...prs] : prs.filter((pr) => rank(pr) !== null).sort(compare));
    return { query: trimmed, active: terms.length > 0, unavailable: words && remote.error !== null, rank, compare, apply };
  }, [terms, trimmed, described, words, remote.error]);
}

/**
 * A list's keyword field. Escape clears it; "/" puts the cursor in it unless you are typing elsewhere or a menu or
 * dialog is open. `count` says how many of the list's PRs match while it holds words.
 */
export function KeywordField({ value, onChange, label, placeholder = "Filter by title, repo or description", count, unavailable = false, inputRef, phone = false, className = "" }: {
  value: string;
  onChange(next: string): void;
  label: string;
  placeholder?: string;
  count?: { shown: number; total: number };
  /** Descriptions could not be searched; the field says so. */
  unavailable?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  phone?: boolean;
  className?: string;
}) {
  const own = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? own;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target !== null && (target.isContentEditable || target.matches("textarea, select, input:not([type=checkbox]):not([type=radio])"))) return;
      if (document.querySelector("[role=menu], [role=dialog]") !== null) return;
      event.preventDefault();
      ref.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ref]);
  const filled = value.trim() !== "";
  return (
    <label data-keyword-field className={`flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-input bg-background px-2 text-muted-foreground focus-within:ring-1 focus-within:ring-ring ${className}`}>
      <Icon name="Search" className="size-3.5 shrink-0" aria-hidden />
      <input ref={ref} type="search" aria-label={label} placeholder={placeholder} value={value} autoComplete="off" spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || value === "") return;
          // bb's "Back to app" also listens for Escape; a field with words only clears.
          event.preventDefault();
          event.stopPropagation();
          onChange("");
        }}
        className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden" />
      {filled && unavailable && (
        <span data-keyword-unavailable title="Descriptions could not be searched just now; titles and the rest still match" className="inline-flex shrink-0">
          <Icon name="AlertTriangle" className="size-3.5 text-warning-text" aria-label="Descriptions could not be searched" />
        </span>
      )}
      {/* Mounted while empty, so a screen reader hears the count change. */}
      {count !== undefined && (
        <span data-keyword-count className="shrink-0 whitespace-nowrap text-[11px] empty:hidden" aria-live="polite">
          {filled ? count.shown === count.total ? plural(count.shown, "match", "matches") : `${count.shown} of ${count.total}` : ""}
        </span>
      )}
      {filled ? (
        <button type="button" aria-label="Clear the filter" title="Clear the filter" className={ICON_GHOST_SMALL} onClick={() => { onChange(""); ref.current?.focus(); }}>
          <Icon name="X" className="size-3" aria-hidden />
        </button>
      ) : !phone && <kbd aria-hidden className={KBD}>/</kbd>}
    </label>
  );
}

/** What a list shows when its PRs are there but none matches the words. */
export function NoMatches({ query, onClear, hidden = 0 }: { query: string; onClear(): void; hidden?: number }) {
  return (
    <div data-no-matches className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-3 text-[13px] text-muted-foreground">
      <span>Nothing here matches {`\u201c${query}\u201d`}{hidden > 0 ? `, but ${plural(hidden, "PR")} the filters above hide ${hidden === 1 ? "does" : "do"}` : ""}.</span>
      <button type="button" className="cursor-pointer text-primary hover:underline" onClick={onClear}>Clear</button>
    </div>
  );
}
