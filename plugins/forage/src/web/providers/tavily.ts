import { providerJson, type ProviderTransport } from "./http.ts";
import type { ProviderSearchResult, SearchProviderAdapter } from "./types.ts";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";
const TAVILY_ORIGINS = ["https://api.tavily.com"];

interface TavilySearchPayload {
	results?: Array<{ title?: string; url?: string; content?: string; score?: number; published_date?: string }>;
}

export function parseTavilySearch(payload: unknown): ProviderSearchResult[] {
	return ((payload as TavilySearchPayload).results ?? []).flatMap((result) => result.url ? [{
		title: result.title?.trim() || result.url,
		url: result.url,
		snippet: result.content?.replace(/\s+/g, " ").trim() ?? "",
		score: result.score,
		publishedDate: result.published_date,
	}] : []);
}

export interface TavilyExtractResult {
	results: Array<{ url: string; content: string }>;
	failures: Array<{ url: string; error: string }>;
}

export function parseTavilyExtract(payload: unknown): TavilyExtractResult {
	const data = payload as { results?: Array<{ url?: string; raw_content?: string }>; failed_results?: Array<{ url?: string; error?: string }> };
	return {
		results: (data.results ?? []).flatMap((result) => result.url && typeof result.raw_content === "string" ? [{ url: result.url, content: result.raw_content }] : []),
		failures: (data.failed_results ?? []).flatMap((result) => result.url ? [{ url: result.url, error: result.error ?? "extraction failed" }] : []),
	};
}

export function normalizeTavilyCountry(country: string | undefined): string | undefined {
	if (!country) return undefined;
	const normalized = country.trim();
	if (!normalized) return undefined;
	if (/^[A-Za-z]{2}$/.test(normalized)) {
		try {
			const name = new Intl.DisplayNames(["en"], { type: "region" }).of(normalized.toUpperCase());
			if (name && name.toUpperCase() !== normalized.toUpperCase()) return name.toLowerCase();
		} catch {
			return undefined;
		}
	}
	return normalized.toLowerCase();
}

export async function tavilyExtract(
	urls: string[],
	input: {
		query?: string;
		context: Parameters<SearchProviderAdapter["search"]>[0]["context"];
		config: Parameters<SearchProviderAdapter["search"]>[0]["config"];
		transport?: ProviderTransport;
	},
): Promise<TavilyExtractResult> {
	if (!input.config.tavilyApiKey) throw new Error("Tavily is not configured");
	const { data } = await providerJson<unknown>({
		provider: "tavily",
		url: TAVILY_EXTRACT_URL,
		method: "POST",
		headers: { Authorization: `Bearer ${input.config.tavilyApiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({ urls, query: input.query, chunks_per_source: input.query ? 3 : undefined, extract_depth: "basic", format: "markdown", include_images: false }),
		context: input.context,
		config: input.config,
		allowedRedirectOrigins: TAVILY_ORIGINS,
	}, input.transport);
	return parseTavilyExtract(data);
}

export const tavilyProvider: SearchProviderAdapter = {
	id: "tavily",
	capabilities: { recency: true, domains: true, language: false, country: true, category: true, chunks: true },
	async search(request) {
		if (!request.config.tavilyApiKey) throw new Error("Tavily is not configured");
		const topic = request.category === "news" ? "news" : "general";
		const country = topic === "general" ? normalizeTavilyCountry(request.country) : undefined;
		const { data } = await providerJson<unknown>({
			provider: "tavily",
			url: TAVILY_SEARCH_URL,
			method: "POST",
			headers: { Authorization: `Bearer ${request.config.tavilyApiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				query: request.query,
				search_depth: request.content === "chunks" ? "advanced" : "basic",
				chunks_per_source: request.content === "chunks" ? 3 : undefined,
				max_results: Math.min(20, request.numResults),
				topic,
				include_domains: request.domains.allow.length ? request.domains.allow : undefined,
				exclude_domains: request.domains.deny.length ? request.domains.deny : undefined,
				country,
				time_range: request.recency,
			}),
			context: request.context,
			config: request.config,
			allowedRedirectOrigins: TAVILY_ORIGINS,
		}, request.transport);
		const results = parseTavilySearch(data);
		return {
			results,
			rawCount: results.length,
			appliedControls: [
				...(request.recency ? ["recency" as const] : []),
				...(request.domains.allow.length || request.domains.deny.length ? ["domains" as const] : []),
				...(country ? ["country" as const] : []),
				...(request.category === "news" ? ["category" as const] : []),
				...(request.content === "chunks" ? ["chunks" as const] : []),
			],
			unsupportedControls: [
				...(request.language ? ["language" as const] : []),
				...(request.country && !country ? ["country" as const] : []),
				...(request.category && request.category !== "news" ? ["category" as const] : []),
			],
			notices: [],
		};
	},
};
