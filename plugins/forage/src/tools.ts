// Agent tools. Named web_search / web_fetch so the model sees the same tools
// the pi extension exposes, and so the pi extension can stand down by name.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
	boundOutput,
	type FetchDetails,
	formatSearchText,
	num,
	OUTPUT_BUDGET,
	renderFetchedPage,
	seconds,
	type SearchDetails,
	type SearchQueryDetail,
	toList,
} from "./format.ts";
import { SEARCH_PROVIDERS, type SearchProviderName, type WebConfig } from "./web/config.ts";
import { fetchContent, sliceContent } from "./web/fetch.ts";
import { createLimiter } from "./web/net.ts";
import {
	isProviderConfigured,
	RECENCY_VALUES,
	type Recency,
	resolveProviderChain,
	search,
	type SearchResponse,
} from "./web/search.ts";

const MAX_QUERIES = 8;
const MAX_URLS = 10;

export interface ToolDeps {
	getConfig: () => Promise<WebConfig>;
}

function errText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
	return { content: [{ type: "text" as const, text }], isError: true };
}

const searchParams = z.object({
	query: z.string().optional().describe("A single search query. For research, prefer `queries` with 2-4 varied angles."),
	queries: z
		.array(z.string())
		.optional()
		.describe(
			`Multiple queries run concurrently (max ${MAX_QUERIES}). Vary phrasing and scope for coverage, e.g. ["X vs Y benchmarks 2025", "X migration guide", "X known issues"].`,
		),
	numResults: z.number().int().min(1).max(20).optional().describe("Results per query (default 5, max 20)."),
	recency: z.enum(RECENCY_VALUES).optional().describe("Only results from the last day, week, month or year."),
	domains: z
		.array(z.string())
		.optional()
		.describe('Restrict to domains, e.g. ["docs.python.org"]. Prefix with "-" to exclude, e.g. ["-pinterest.com"].'),
	provider: z
		.enum(SEARCH_PROVIDERS)
		.optional()
		.describe(
			"Search backend. Omit for the configured default (auto = brave → searxng → duckduckgo → exa, skipping anything unconfigured and falling through on errors).",
		),
	includeContent: z.boolean().optional().describe("Also fetch and include the readable content of the top results (bounded). Slower; use when snippets are not enough."),
});

const fetchParams = z.object({
	url: z.string().optional().describe("URL to fetch (http/https; scheme optional)."),
	urls: z.array(z.string()).optional().describe(`Multiple URLs fetched concurrently (max ${MAX_URLS}); each gets a share of the output budget.`),
	mode: z.enum(["readable", "raw"]).optional().describe("readable (default): main content as markdown. raw: the exact response body (HTML source, JSON, text)."),
	maxChars: z.number().int().min(200).max(200_000).optional().describe("Max characters of content to return per URL (default from settings, 30000)."),
	offset: z.number().int().min(0).optional().describe("Character offset to continue from (for paging long documents). Served from cache — no re-download."),
	find: z
		.string()
		.optional()
		.describe(
			'Return only matching passages (up to 20, ~300 characters of context each) instead of the whole page. Plain text matches case-insensitively; use /pattern/flags for a regex (g and m are always on, so ^ and $ anchor to lines; add i for case-insensitive), e.g. find: "/^## Install/".',
		),
	refresh: z.boolean().optional().describe("Bypass the 15-minute cache and re-download."),
});

async function runSearch(
	params: z.output<typeof searchParams>,
	config: WebConfig,
	signal: AbortSignal,
): Promise<{ text: string; details: SearchDetails }> {
	const queries = toList(params.query, params.queries, MAX_QUERIES);
	if (queries.length === 0) throw new Error("No query provided. Pass `query` or `queries`.");
	const numResults = params.numResults ?? 5;
	const recency = params.recency as Recency | undefined;
	const provider = params.provider as SearchProviderName | undefined;
	if (provider && provider !== "auto" && !isProviderConfigured(provider, config)) {
		throw new Error(
			provider === "brave"
				? "Brave is not configured. Set the Brave API key in the Forage plugin settings, or omit `provider`."
				: "SearXNG is not configured. Set the SearXNG URL in the Forage plugin settings, or omit `provider`.",
		);
	}
	const chain = resolveProviderChain(provider, config);
	const startedAt = Date.now();
	const limit = createLimiter(config.concurrency);

	const outcomes = await Promise.all(
		queries.map((query) =>
			limit(async (): Promise<SearchQueryDetail> => {
				const startedQueryAt = Date.now();
				try {
					const response: SearchResponse = await search(query, { numResults, recency, domains: params.domains, signal }, config, provider);
					return {
						query,
						provider: response.provider,
						results: response.results,
						rawCount: response.rawCount,
						durationMs: response.durationMs,
						attempts: response.attempts,
						note: response.note,
					};
				} catch (error) {
					if (signal.aborted) throw error;
					return { query, provider: null, results: [], rawCount: 0, durationMs: Date.now() - startedQueryAt, error: errText(error), attempts: [] };
				}
			}),
		),
	);

	const details: SearchDetails = {
		queries: outcomes,
		totalResults: outcomes.reduce((total, outcome) => total + outcome.results.length, 0),
		durationMs: Date.now() - startedAt,
	};

	if (outcomes.every((outcome) => outcome.error)) {
		const reasons = [...new Set(outcomes.map((outcome) => outcome.error))].join(" | ");
		throw new Error(`Search failed for all ${queries.length === 1 ? "query" : `${queries.length} queries`}: ${reasons}`);
	}

	const usedProviders = [...new Set(outcomes.map((outcome) => outcome.provider).filter((value): value is string => Boolean(value)))];
	const providerLabel = usedProviders.join("+") || chain.join("→");
	let text = formatSearchText(details, providerLabel);

	if (params.includeContent && details.totalResults > 0) {
		const seen = new Set<string>();
		const targets: Array<{ title: string; url: string }> = [];
		for (const outcome of outcomes) {
			for (const result of outcome.results) {
				const key = result.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
				if (seen.has(key)) continue;
				seen.add(key);
				targets.push({ title: result.title, url: result.url });
				if (targets.length >= Math.min(3, Math.max(1, numResults))) break;
			}
			if (targets.length >= 3) break;
		}
		const budget = Math.max(2_000, Math.floor((OUTPUT_BUDGET - text.length) / Math.max(1, targets.length)));
		const pages = await Promise.all(
			targets.map((target) => limit(() => fetchContent(target.url, { mode: "readable", signal, config }))),
		);
		details.fetched = [];
		for (const [index, page] of pages.entries()) {
			const target = targets[index]!;
			if (page.error) {
				details.fetched.push({ url: target.url, title: target.title, chars: 0, shown: 0, error: page.error });
				text += `\n\n### ${target.title}\n${target.url}\nCould not fetch: ${page.error}`;
				continue;
			}
			const slice = sliceContent(page.content, 0, budget);
			details.fetched.push({ url: target.url, title: page.title || target.title, chars: page.content.length, shown: slice.end });
			text += `\n\n### ${page.title || target.title}\n${page.finalUrl} · ${num(page.content.length)} chars${slice.truncated ? ` · showing first ${num(slice.end)} — use web_fetch with offset=${slice.end} for more` : ""}\n\n${slice.text}`;
		}
	}

	return { text, details };
}

async function runFetch(
	params: z.output<typeof fetchParams>,
	config: WebConfig,
	signal: AbortSignal,
): Promise<{ text: string; details: FetchDetails }> {
	const urls = toList(params.url, params.urls, MAX_URLS);
	if (urls.length === 0) throw new Error("No URL provided. Pass `url` or `urls`.");
	const mode = params.mode ?? "readable";
	const offset = params.offset ?? 0;
	const find = params.find?.trim() || undefined;
	const perUrlBudget = Math.max(200, Math.min(params.maxChars ?? config.maxChars, Math.floor((32_000 - 600 * urls.length) / urls.length)));
	const startedAt = Date.now();
	const limit = createLimiter(config.concurrency);

	const pages = await Promise.all(
		urls.map((url) =>
			limit(async () => {
				try {
					return await fetchContent(url, { mode, signal, config, noCache: params.refresh });
				} catch (error) {
					// fetchContent never throws by contract; keep one bad URL from sinking its siblings anyway.
					if (signal.aborted) throw error;
					return {
						url,
						finalUrl: url,
						title: "",
						content: "",
						kind: "error" as const,
						contentType: "",
						status: 0,
						bytes: 0,
						durationMs: 0,
						redirects: 0,
						cached: false,
						error: errText(error),
					};
				}
			}),
		),
	);

	const details: FetchDetails = { results: [], urlCount: urls.length, successful: 0, durationMs: Date.now() - startedAt, mode, find };
	const sections: string[] = [];
	for (const page of pages) {
		const { text, detail } = renderFetchedPage(page, { offset, maxChars: perUrlBudget, find, showTitle: true });
		details.results.push(detail);
		if (!detail.error) details.successful += 1;
		sections.push(text);
	}

	if (details.successful === 0) {
		const reasons = details.results.map((result) => `${result.url}: ${result.error}`).join("\n");
		throw new Error(urls.length === 1 ? (details.results[0]?.error ?? "Fetch failed") : `All ${urls.length} fetches failed:\n${reasons}`);
	}

	let text = sections.join("\n\n---\n\n");
	if (urls.length > 1) text = `Fetched ${details.successful}/${urls.length} URLs in ${seconds(details.durationMs)}.\n\n${text}`;
	return { text, details };
}

export function registerTools(bb: BbPluginApi, deps: ToolDeps): void {
	bb.agents.registerTool({
		name: "web_search",
		description:
			"Search the web and return ranked results with titles, URLs and snippets. Works with no API keys (DuckDuckGo, then Exa as fallback); Brave or SearXNG are used first when configured. Supports batch queries (run concurrently), recency filters (day/week/month/year) and domain include/exclude filters. Set includeContent to also read the top pages. Follow up with web_fetch to read any result in full.",
		instructions:
			"Use web_search to find current information, documentation or sources; for research prefer `queries` with 2-4 varied angles over one broad query. After web_search, use web_fetch on the most relevant URLs to read them in full rather than relying on snippets alone.",
		presentation: {
			label: { pending: "Searching the web", completed: "Searched the web" },
			icon: { glyph: "forage/search" },
			tint: { light: "#1f7a5c", dark: "#6fd3a8" },
		},
		parameters: searchParams,
		async execute(params, ctx) {
			try {
				const config = await deps.getConfig();
				const { text } = await runSearch(params, config, ctx.signal);
				const bounded = boundOutput(text, "Use web_fetch on specific URLs for full content.");
				return textResult(bounded.text);
			} catch (error) {
				return errorResult(`Forage: ${errText(error)}`);
			}
		},
	});

	bb.agents.registerTool({
		name: "web_fetch",
		description:
			"Fetch one or more URLs and return readable content as markdown (HTML pages with boilerplate removed), raw text or JSON, or PDF text (via pdftotext when installed). GitHub URLs are resolved smartly: blob to raw file, repo to README, tree to directory listing, issues and pull requests to the full thread. Long documents are paged: use `offset` to continue (served from cache) or `find` to jump to matching passages. Private and loopback addresses are blocked unless the plugin setting allows them.",
		instructions:
			"Use web_fetch to read documentation, articles, API responses, GitHub files or issues, or PDFs from a URL; use `find` to locate a section and `offset` to page rather than re-fetching.",
		presentation: {
			label: { pending: "Fetching page", completed: "Fetched page" },
			icon: { glyph: "forage/fetch" },
			tint: { light: "#2a5f9e", dark: "#8ab4f8" },
		},
		parameters: fetchParams,
		async execute(params, ctx) {
			try {
				const config = await deps.getConfig();
				const { text } = await runFetch(params, config, ctx.signal);
				const bounded = boundOutput(text, "Use offset, maxChars or find to read specific parts.");
				return textResult(bounded.text);
			} catch (error) {
				return errorResult(`Forage: ${errText(error)}`);
			}
		},
	});
}
