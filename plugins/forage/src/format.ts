/**
 * Output formatting for bb's timeline body.
 *
 * bb draws a plugin tool's output inside a monospace `<pre>` block, so the
 * search results are written as aligned plain text rather than the markdown
 * the pi extension returns to the terminal. Fetched page content keeps its
 * markdown, because the model needs the headings, links and code structure.
 */

import { type FetchedContent, type FetchMode, findPassages, type Passage, sliceContent } from "./web/fetch.ts";
import type { SearchResult } from "./web/search.ts";

/**
 * bb keeps 32,000 characters of a tool row inline before it stores only a
 * head/tail preview, so that is the ceiling for one call's output.
 */
export const OUTPUT_BUDGET = 32_000;

export function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function num(n: number): string {
	return n.toLocaleString("en-US");
}

export function domainOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

export function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

export function toList(single: unknown, many: unknown, max: number, label = "items"): string[] {
	const raw: unknown[] = [...(Array.isArray(many) ? many : [])];
	if (typeof single === "string") raw.unshift(single);
	const normalized = raw
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
	if (normalized.length > max) throw new Error(`Pass at most ${max} ${label} across the single and batch inputs.`);
	return [...new Set(normalized)];
}

/** Enforce the output budget and tell the model when it bit. */
export function boundOutput(text: string, hint: string): { text: string; truncated: boolean } {
	if (text.length <= OUTPUT_BUDGET) return { text, truncated: false };
	return {
		text: `${text.slice(0, OUTPUT_BUDGET - 200)}\n\n[Output truncated at ${num(OUTPUT_BUDGET)} of ${num(text.length)} characters. ${hint}]`,
		truncated: true,
	};
}

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

export interface SearchQueryDetail {
	query: string;
	provider: string | null;
	results: SearchResult[];
	rawCount: number;
	durationMs: number;
	error?: string;
	note?: string;
	attempts: Array<{ provider: string; error: string }>;
}

export interface FetchedSummary {
	url: string;
	title: string;
	chars: number;
	shown: number;
	error?: string;
}

export interface SearchDetails {
	queries: SearchQueryDetail[];
	totalResults: number;
	durationMs: number;
	fetched?: FetchedSummary[];
	outputTruncated?: boolean;
}

function formatSearchQuery(detail: SearchQueryDetail, index: number, count: number, budget: number): string {
	const meta: string[] = [];
	if (detail.provider) meta.push(detail.provider);
	meta.push(seconds(detail.durationMs));
	for (const attempt of detail.attempts) meta.push(`${attempt.provider} failed: ${clip(attempt.error, 80)}`);
	const heading = `${count > 1 ? `${index + 1}. ` : ""}"${clip(detail.query, 500)}" — ${detail.error ? "failed" : `${detail.results.length} ${detail.results.length === 1 ? "result" : "results"}`} (${meta.join(" · ")})`;
	const lines = [heading];
	if (detail.error) lines.push(`   Error: ${clip(detail.error, 1_000)}`);
	else if (detail.results.length === 0) {
		lines.push(detail.rawCount > 0 ? `   No results matched the domain filter (${detail.rawCount} unfiltered).` : "   No results. Try broader or different terms.");
	} else {
		if (detail.note) lines.push(`   Note: ${clip(detail.note, 1_000)}`);
		let shown = 0;
		for (const [resultIndex, result] of detail.results.entries()) {
			const block = [
				"",
				`   ${resultIndex + 1}. ${clip(result.title, 500)} — ${domainOf(result.url)}${result.age ? ` · ${result.age}` : ""}`,
				`      ${clip(result.url, 1_000)}`,
				...(result.snippet ? [`      ${clip(result.snippet, 1_500)}`] : []),
			];
			const omitted = detail.results.length - shown - 1;
			const reserve = omitted > 0 ? `\n   [${omitted} result ${omitted === 1 ? "detail" : "details"} omitted by the output budget]`.length : 0;
			if (`${lines.join("\n")}\n${block.join("\n")}`.length + reserve > budget) break;
			lines.push(...block);
			shown++;
		}
		const omitted = detail.results.length - shown;
		if (omitted > 0) lines.push(`   [${omitted} result ${omitted === 1 ? "detail" : "details"} omitted by the output budget]`);
	}
	return clip(lines.join("\n"), budget);
}

export function formatSearchText(details: SearchDetails, providerLabel: string, maxChars = OUTPUT_BUDGET): string {
	const queries = details.queries;
	const okCount = queries.filter((detail) => !detail.error).length;
	const header = `Web search · ${queries.length} ${queries.length === 1 ? "query" : "queries"} · ${details.totalResults} ${details.totalResults === 1 ? "result" : "results"} · ${providerLabel} · ${seconds(details.durationMs)}${okCount < queries.length ? ` · ${queries.length - okCount} failed` : ""}`;
	if (queries.length === 0) return clip(header, maxChars);
	const separators = queries.length * 2;
	const perQuery = Math.max(120, Math.floor((maxChars - header.length - separators) / queries.length));
	const sections = queries.map((detail, index) => formatSearchQuery(detail, index, queries.length, perQuery));
	const text = [header, ...sections].join("\n\n");
	return text.length <= maxChars ? text : clip(text, maxChars);
}

// ---------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------

export interface FetchResultDetail {
	url: string;
	finalUrl: string;
	title: string;
	kind: string;
	status: number;
	contentType: string;
	chars: number;
	shown: number;
	offset: number;
	truncated: boolean;
	durationMs: number;
	cached: boolean;
	redirects: number;
	contentRoot?: string;
	rewrittenFrom?: string;
	warning?: string;
	error?: string;
	matches?: number;
	contentHash?: string;
}

export interface FetchDetails {
	results: FetchResultDetail[];
	urlCount: number;
	successful: number;
	durationMs: number;
	mode: FetchMode;
	find?: string;
	outputTruncated?: boolean;
}

export function formatFetchHeader(page: FetchedContent, showTitle: boolean): string[] {
	const lines: string[] = [];
	if (showTitle && page.title) lines.push(`# ${clip(page.title, 300)}`);
	const meta = [
		`HTTP ${page.status}`,
		page.contentType || page.kind,
		`${num(page.content.length)} chars`,
		`${seconds(page.durationMs)}${page.cached ? " (cached)" : ""}`,
	];
	if (page.redirects) meta.push(`${page.redirects} redirect${page.redirects === 1 ? "" : "s"}`);
	if (page.contentRoot && page.contentRoot !== "body") meta.push(`content: <${page.contentRoot}>`);
	lines.push(`Source: ${clip(page.finalUrl, 600)} (${meta.join(" · ")})`);
	if (page.rewrittenFrom) lines.push(`Resolved from: ${clip(page.rewrittenFrom, 600)}`);
	if (page.description && !page.content.includes(page.description.slice(0, 60))) lines.push(`Description: ${clip(page.description, 300)}`);
	if (page.warning) lines.push(`Note: ${clip(page.warning, 500)}`);
	return lines;
}

export async function renderFetchedPage(
	page: FetchedContent,
	options: { offset: number; maxChars: number; maxOutputChars?: number; find?: string; showTitle: boolean; signal?: AbortSignal; hashBound?: boolean },
): Promise<{ text: string; detail: FetchResultDetail }> {
	const outputBudget = Math.max(500, options.maxOutputChars ?? Number.MAX_SAFE_INTEGER);
	const base: FetchResultDetail = {
		url: page.url,
		finalUrl: page.finalUrl,
		title: page.title,
		kind: page.kind,
		status: page.status,
		contentType: page.contentType,
		chars: page.content.length,
		shown: 0,
		offset: options.offset,
		truncated: false,
		durationMs: page.durationMs,
		cached: page.cached,
		redirects: page.redirects,
		contentRoot: page.contentRoot,
		rewrittenFrom: page.rewrittenFrom,
		warning: page.warning,
		contentHash: page.contentHash,
	};
	if (page.error) {
		const source = `Source: ${clip(page.finalUrl || page.url, 600)}`;
		const text = `${source}\nError: ${clip(page.error, Math.max(100, outputBudget - source.length - 8))}`;
		return { text, detail: { ...base, error: page.error } };
	}
	const header = clip(formatFetchHeader(page, options.showTitle).join("\n"), Math.max(100, outputBudget - 400));

	if (options.find) {
		let passages: Passage[];
		try {
			passages = await findPassages(page.content, options.find, { context: 300, max: 20, signal: options.signal });
		} catch (error) {
			if (options.signal?.aborted) throw error;
			const message = `Find failed: ${error instanceof Error ? error.message : String(error)}`;
			return { text: clip(`${header}\n\nError: ${message}`, outputBudget), detail: { ...base, error: message } };
		}
		let body = passages.length
			? passages.map((passage) => `[L${passage.line} · char ${num(passage.index)}]\n${passage.excerpt}`).join("\n\n")
			: "No matches. Try a different term, or read the page with offset/maxChars.";
		if (body.length > options.maxChars) body = `${body.slice(0, options.maxChars)}…\n\n[find output truncated to maxChars=${num(options.maxChars)}; narrow the pattern or raise maxChars]`;
		const title = `Found ${passages.length}${passages.length === 20 ? "+" : ""} match${passages.length === 1 ? "" : "es"} for "${clip(options.find, 500)}"${passages.length ? " (offsets can be used with `offset` to read around a match)" : ""}:`;
		const text = clip(`${header}\n\n${title}\n\n${body}`, outputBudget);
		return { text, detail: { ...base, matches: passages.length, shown: Math.min(body.length, text.length) } };
	}

	let bodyLimit = Math.min(options.maxChars, Math.max(1, outputBudget - header.length - 300));
	let slice = sliceContent(page.content, options.offset, bodyLimit);
	let text = "";
	for (let attempt = 0; attempt < 12; attempt++) {
		const range: string[] = [];
		if (slice.offset > 0 || slice.truncated) {
			const hash = page.contentHash ? ` and contentHash=${page.contentHash}` : "";
			range.push(`Showing chars ${num(slice.offset)}–${num(slice.end)} of ${num(slice.total)}.${slice.truncated ? ` Continue with offset=${slice.end}${hash}${options.maxChars < slice.total ? ` (or raise maxChars, or use find="…" to jump to a section)` : ""}.` : " (end of document)"}`);
			if (slice.offset > 0 && !options.hashBound) range.push("Note: this legacy offset is not bound to an immutable content hash.");
		}
		if (slice.offset >= slice.total && slice.total > 0) range.push("Offset is past the end of the document.");
		text = `${header}${range.length ? `\n${range.join("\n")}` : ""}\n\n${slice.text}`;
		if (text.length <= outputBudget || bodyLimit <= 1) break;
		bodyLimit = Math.max(1, bodyLimit - (text.length - outputBudget) - 16);
		slice = sliceContent(page.content, options.offset, bodyLimit);
	}
	if (text.length > outputBudget) text = clip(text, outputBudget);
	return {
		text,
		detail: { ...base, offset: slice.offset, shown: slice.end - slice.offset, truncated: slice.truncated },
	};
}
