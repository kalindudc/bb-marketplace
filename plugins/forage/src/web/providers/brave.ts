import { htmlToText } from "../html.ts";
import { providerJson } from "./http.ts";
import type { ProviderSearchRequest, ProviderSearchResult, SearchProviderAdapter } from "./types.ts";

const BRAVE_WEB_URL = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_CONTEXT_URL = "https://api.search.brave.com/res/v1/llm/context";
const BRAVE_ORIGINS = ["https://api.search.brave.com"];
const RECENCY = { day: "pd", week: "pw", month: "pm", year: "py" } as const;

interface BraveWebPayload {
	web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string; page_age?: string }> };
	news?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> };
}

export function parseBraveWebResponse(payload: unknown): ProviderSearchResult[] {
	const data = payload as BraveWebPayload;
	const out: ProviderSearchResult[] = [];
	for (const result of data.web?.results ?? []) {
		if (!result.url || !result.title) continue;
		out.push({ title: htmlToText(result.title), url: result.url, snippet: htmlToText(result.description ?? ""), publishedDate: result.age ?? result.page_age });
	}
	for (const result of data.news?.results ?? []) {
		if (!result.url || !result.title) continue;
		out.push({ title: htmlToText(result.title), url: result.url, snippet: htmlToText(result.description ?? ""), publishedDate: result.age });
	}
	return out;
}

interface BraveContextRow {
	title?: string;
	url?: string;
	snippets?: string[];
}

interface BraveContextPayload {
	grounding?: { generic?: BraveContextRow[] };
	sources?: Record<string, { age?: string }>;
}

export function parseBraveContextResponse(payload: unknown): ProviderSearchResult[] {
	const data = payload as BraveContextPayload;
	return (data.grounding?.generic ?? []).flatMap((row) => {
		if (!row.url) return [];
		return [{
			title: row.title?.trim() || row.url,
			url: row.url,
			snippet: (row.snippets?.join(" ") ?? "").replace(/\s+/g, " ").trim(),
			age: data.sources?.[row.url]?.age,
		}];
	});
}

export const braveProvider: SearchProviderAdapter = {
	id: "brave",
	capabilities: { recency: true, domains: true, language: true, country: true, category: false, chunks: true },
	async search(request: ProviderSearchRequest) {
		if (!request.config.braveApiKey) throw new Error("Brave is not configured");
		const contextMode = request.content === "chunks";
		const url = new URL(contextMode ? BRAVE_CONTEXT_URL : BRAVE_WEB_URL);
		const canPushAllDomains = request.domains.allow.length <= 1;
		const domainTerms = [
			...(canPushAllDomains && request.domains.allow.length === 1 ? [`site:${request.domains.allow[0]}`] : []),
			...request.domains.deny.map((domain) => `-site:${domain}`),
		];
		url.searchParams.set("q", domainTerms.length ? `${request.query} ${domainTerms.join(" ")}` : request.query);
		url.searchParams.set("count", String(Math.min(contextMode ? 50 : 20, Math.max(request.numResults, 1))));
		if (request.country) url.searchParams.set("country", request.country.toUpperCase());
		if (request.language) url.searchParams.set("search_lang", request.language.toLowerCase());
		if (request.recency) url.searchParams.set("freshness", RECENCY[request.recency]);
		if (contextMode) {
			url.searchParams.set("maximum_number_of_urls", String(Math.min(50, request.numResults)));
			url.searchParams.set("maximum_number_of_tokens", "8192");
		} else {
			url.searchParams.set("text_decorations", "false");
			url.searchParams.set("safesearch", "moderate");
		}
		const { data } = await providerJson<unknown>({
			provider: "brave",
			url: url.href,
			headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": request.config.braveApiKey },
			context: request.context,
			config: request.config,
			allowedRedirectOrigins: BRAVE_ORIGINS,
		}, request.transport);
		const results = contextMode ? parseBraveContextResponse(data) : parseBraveWebResponse(data);
		const domainsRequested = request.domains.allow.length > 0 || request.domains.deny.length > 0;
		return {
			results,
			rawCount: results.length,
			appliedControls: [
				...(request.recency ? ["recency" as const] : []),
				...(domainsRequested && canPushAllDomains ? ["domains" as const] : []),
				...(request.language ? ["language" as const] : []),
				...(request.country ? ["country" as const] : []),
				...(contextMode ? ["chunks" as const] : []),
			],
			unsupportedControls: [
				...(domainsRequested && !canPushAllDomains ? ["domains" as const] : []),
				...(request.category ? ["category" as const] : []),
			],
			notices: [],
		};
	},
};
