import type Database from "better-sqlite3";
import { sourceScopeKey, type SourceScope } from "../web/contracts.ts";
import type { Visibility } from "./queries.ts";

const STOPWORDS = new Set("a an and are as at be been but by can could did do does for from had has have how if in into is it its may might more most must no not of on or our over so such than that the their them then there these they this those to too under up very was we were what when where which while who why will with would you your also only just should about after before because between both each other same some".split(" "));
const MAX_TERMS = 12;
const MAX_SNAPSHOTS = 300;
const MAX_SCAN_BYTES = 40 * 1024 * 1024;
const WINDOW = 3;
const MAX_SCAN_MS = 3000;

export interface SourceMatch {
 sourceId: string;
 snapshotId: string;
 title: string;
 url: string;
 startLine: number;
 endLine: number;
 lines: string[];
 matched: string[];
 score: number;
 latest: boolean;
 fetchedAt: number;
}

// A reply paraphrases its source, so terms are word stems ("retries" finds "retry") and numbers like "30s" are left out.
const stem = (word: string): string => {
 const cut = word.replace(/(?:ies|es|s|ed|ing|ly)$/u, "");
 return cut.length >= 4 && cut !== word ? cut : word;
};
export function searchTerms(text: string): string[] {
 const words = text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) ?? [];
 const out: string[] = [];
 for (const raw of words) {
  if (raw.length < 3 || STOPWORDS.has(raw) || /^\p{N}/u.test(raw)) continue;
  const word = stem(raw);
  if (out.includes(word)) continue;
  out.push(word);
  if (out.length >= MAX_TERMS) break;
 }
 return out;
}

const escape = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
// A term counts at the start of a word, so "redis" matches "Redis" and "redis-cli" but not "IORedis".
const wordStart = (terms: readonly string[]) => terms.map((term) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}`, "u"));
function bestWindow(lines: readonly string[], terms: readonly string[]): { start: number; matched: string[] } | null {
 const lower = lines.map((line) => line.toLowerCase());
 const patterns = wordStart(terms);
 let best: { start: number; matched: string[] } | null = null;
 for (let i = 0; i < lower.length; i++) {
  if (!patterns.some((pattern) => pattern.test(lower[i]!))) continue;
  const text = lower.slice(i, i + WINDOW).join(" ");
  const matched = terms.filter((_, t) => patterns[t]!.test(text));
  if (!best || matched.length > best.matched.length) best = { start: i, matched };
  if (best.matched.length === terms.length) break;
 }
 return best;
}

export function findInSources(db: Database.Database, scope: SourceScope, text: string, visibility: Visibility, signal?: AbortSignal): { terms: string[]; scanned: number; matches: SourceMatch[] } {
 const terms = searchTerms(text);
 if (terms.length === 0) return { terms, scanned: 0, matches: [] };
 const needed = terms.length <= 2 ? terms.length : Math.max(2, Math.ceil(terms.length * 0.35));
 const clauses = [!visibility.allowPrivate ? "src.access_network = 'public'" : "", scope.kind === "project" || !visibility.allowRestricted ? "src.access_network = 'public' AND src.access_credentialed = 0" : ""].filter(Boolean);
 // Sizes first, then one page's text at a time, so the byte cap holds before any content is read.
 const rows = db.prepare(`SELECT s.id, s.source_id, s.fetched_at, s.content_bytes, s.content_hash, src.title, src.display_url,
  (SELECT l.content_hash FROM forage_snapshots l WHERE l.id = src.latest_snapshot_id) AS latest_hash FROM forage_snapshots s
  JOIN forage_sources src ON src.id = s.source_id WHERE src.scope_key = ? AND src.deleting = 0${clauses.length ? ` AND ${clauses.join(" AND ")}` : ""}
  ORDER BY s.fetched_at DESC, s.id DESC LIMIT ?`).all(sourceScopeKey(scope), MAX_SNAPSHOTS) as Array<{ id: string; source_id: string; fetched_at: number; content_bytes: number; content_hash: string; title: string; display_url: string; latest_hash: string | null }>;
 const content = db.prepare("SELECT content FROM forage_snapshots WHERE id = ?");
 const deadline = Date.now() + MAX_SCAN_MS;
 const bySource = new Map<string, SourceMatch>();
 let scanned = 0;
 let bytes = 0;
 for (const row of rows) {
  signal?.throwIfAborted();
  if (Date.now() > deadline) break;
  bytes += row.content_bytes;
  if (bytes > MAX_SCAN_BYTES) break;
  scanned++;
  const latest = row.content_hash === row.latest_hash;
  const previous = bySource.get(row.source_id);
  // The newest version wins; an older one is reported only when the newest no longer says it.
  if (previous && previous.latest) continue;
  const lines = (content.get(row.id) as { content: string } | undefined)?.content.split("\n") ?? [];
  const window = bestWindow(lines, terms);
  if (!window || window.matched.length < needed) continue;
  if (previous && !latest && previous.score >= window.matched.length) continue;
  bySource.set(row.source_id, {
   sourceId: row.source_id, snapshotId: row.id, title: row.title, url: row.display_url, startLine: window.start + 1, endLine: Math.min(lines.length, window.start + WINDOW),
   lines: lines.slice(window.start, window.start + WINDOW).map((line) => (line.length > 400 ? `${line.slice(0, 399)}…` : line)), matched: window.matched, score: window.matched.length, latest, fetchedAt: row.fetched_at,
  });
 }
 // The same passage often lives at several addresses (a page and its crawled copy); show it once.
 const seen = new Set<string>();
 const matches = [...bySource.values()].sort((a, b) => b.score - a.score || Number(b.latest) - Number(a.latest) || b.fetchedAt - a.fetchedAt)
  .filter((match) => { const key = match.lines.join(" ").replace(/\]\([^)]*\)/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""); if (seen.has(key)) return false; seen.add(key); return true; })
  .slice(0, 8);
 return { terms, scanned, matches };
}
