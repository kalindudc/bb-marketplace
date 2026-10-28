/**
 * Output formatting for bb's timeline body.
 *
 * bb draws a plugin tool's output inside a monospace `<pre>` block, so the
 * search results are written as aligned plain text rather than the markdown
 * the pi extension returns to the terminal. Fetched page content keeps its
 * markdown, because the model needs the headings, links and code structure.
 */

import { type FetchedContent, type FetchMode, findPassages, sliceContent } from "./web/fetch.ts";
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

export function toList(single: unknown, many: unknown, max: number): string[] {
	const raw: unknown[] = Array.isArray(many) ? many : [];
	if (typeof single === "string") raw.unshift(single);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
		if (out.length >= max) break;
	}
	return out;
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

export function formatSearchText(details: SearchDetails, providerLabel: string): string {
	const queries = details.queries;
	const okCount = queries.filter((d) => !d.error).length;
	const lines: string[] = [];
	lines.push(
		`Web search · ${queries.length} ${queries.length === 1 ? "query" : "queries"} · ${details.totalResults} ${details.totalResults === 1 ? "result" : "results"} · ${providerLabel} · ${seconds(details.durationMs)}${okCount < queries.length ? ` · ${queries.length - okCount} failed` : ""}`,
	);

	queries.forEach((detail, index) => {
		lines.push("");
		const meta: string[] = [];
		if (detail.provider) meta.push(detail.provider);
		meta.push(seconds(detail.durationMs));
		for (const attempt of detail.attempts) meta.push(`${attempt.provider} failed: ${clip(attempt.error, 80)}`);
		const heading = `"${detail.query}"`;
		lines.push(
			`${queries.length > 1 ? `${index + 1}. ` : ""}${heading} — ${detail.error ? "failed" : `${detail.results.length} ${detail.results.length === 1 ? "result" : "results"}`} (${meta.join(" · ")})`,
		);
		if (detail.error) {
			lines.push(`   Error: ${detail.error}`);
			return;
		}
		if (detail.note) lines.push(`   Note: ${detail.note}`);
		if (detail.results.length === 0) {
			lines.push(
				detail.rawCount > 0
					? `   No results matched the domain filter (${detail.rawCount} unfiltered).`
					: "   No results. Try broader or different terms.",
			);
			return;
		}
		detail.results.forEach((result, i) => {
			lines.push("");
			lines.push(`   ${i + 1}. ${result.title} — ${domainOf(result.url)}${result.age ? ` · ${result.age}` : ""}`);
			lines.push(`      ${result.url}`);
			if (result.snippet) lines.push(`      ${result.snippet}`);
		});
	});

	if (details.fetched?.length) {
		lines.push("", "---", "", `Content from the top ${details.fetched.length} ${details.fetched.length === 1 ? "result" : "results"}:`);
	}
	return lines.join("\n");
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
	if (showTitle && page.title) lines.push(`# ${page.title}`);
	const meta = [
		`HTTP ${page.status}`,
		page.contentType || page.kind,
		`${num(page.content.length)} chars`,
		`${seconds(page.durationMs)}${page.cached ? " (cached)" : ""}`,
	];
	if (page.redirects) meta.push(`${page.redirects} redirect${page.redirects === 1 ? "" : "s"}`);
	if (page.contentRoot && page.contentRoot !== "body") meta.push(`content: <${page.contentRoot}>`);
	lines.push(`Source: ${page.finalUrl} (${meta.join(" · ")})`);
	if (page.rewrittenFrom) lines.push(`Resolved from: ${page.rewrittenFrom}`);
	if (page.description && !page.content.includes(page.description.slice(0, 60))) lines.push(`Description: ${page.description}`);
	if (page.warning) lines.push(`Note: ${page.warning}`);
	return lines;
}

export function renderFetchedPage(
	page: FetchedContent,
	options: { offset: number; maxChars: number; find?: string; showTitle: boolean },
): { text: string; detail: FetchResultDetail } {
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
	};
	if (page.error) {
		return { text: `Source: ${page.finalUrl || page.url}\nError: ${page.error}`, detail: { ...base, error: page.error } };
	}
	const header = formatFetchHeader(page, options.showTitle);

	if (options.find) {
		const passages = findPassages(page.content, options.find, { context: 300, max: 20 });
		let body = passages.length
			? passages.map((passage) => `[L${passage.line} · char ${num(passage.index)}]\n${passage.excerpt}`).join("\n\n")
			: "No matches. Try a different term, or read the page with offset/maxChars.";
		if (body.length > options.maxChars) {
			body = `${body.slice(0, options.maxChars)}…\n\n[find output truncated to maxChars=${num(options.maxChars)}; narrow the pattern or raise maxChars]`;
		}
		const title = `Found ${passages.length}${passages.length === 20 ? "+" : ""} match${passages.length === 1 ? "" : "es"} for "${options.find}"${passages.length ? " (offsets can be used with `offset` to read around a match)" : ""}:`;
		return { text: `${header.join("\n")}\n\n${title}\n\n${body}`, detail: { ...base, matches: passages.length, shown: body.length } };
	}

	const slice = sliceContent(page.content, options.offset, options.maxChars);
	const range: string[] = [];
	if (slice.offset > 0 || slice.truncated) {
		range.push(
			`Showing chars ${num(slice.offset)}–${num(slice.end)} of ${num(slice.total)}.${slice.truncated ? ` Continue with offset=${slice.end}${options.maxChars < slice.total ? ` (or raise maxChars, or use find="…" to jump to a section)` : ""}.` : " (end of document)"}`,
		);
	}
	if (slice.offset >= slice.total && slice.total > 0) range.push("Offset is past the end of the document.");
	const text = `${header.join("\n")}${range.length ? `\n${range.join("\n")}` : ""}\n\n${slice.text}`;
	return { text, detail: { ...base, shown: slice.end - slice.offset, truncated: slice.truncated } };
}
