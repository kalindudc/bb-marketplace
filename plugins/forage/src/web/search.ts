/**
 * Web search providers and routing.
 *
 *   duckduckgo  keyless HTML endpoint (lite endpoint as fallback); fast, keyword-style
 *   exa         advanced keyless MCP, or direct account API when explicitly selected
 *   brave       Web Search and LLM Context with an explicit account key
 *   searxng     self-hosted SearXNG with JSON format
 *   tavily      search with an explicit account key
 *
 * Profiles and setting ceilings choose the chain. Keys alone never enable a
 * billable fallback, and private routing permits only configured SearXNG.
 * Keyless providers get a small per-process concurrency cap so batch queries
 * do not trip their rate limits. Every response records which provider
 * answered and any attempts that failed, so the agent can see what happened.
 */

import { resolvePolicy, type SearchProfileName } from "../profiles.ts";
import type { OperationContext } from "./contracts.ts";
import type { ConcreteSearchProvider, WebConfig, SearchProviderName } from "./config.ts";
import { createDeadline } from "./deadline.ts";
import { decodeEntities, htmlToText } from "./html.ts";
import { NetError, createLimiter, readBodyLimited, safeFetch } from "./net.ts";
import { braveProvider } from "./providers/brave.ts";
import { exaProvider } from "./providers/exa.ts";
import { MAX_RETRY_AFTER_MS, ProviderHttpError, type ProviderTransport } from "./providers/http.ts";
import { tavilyProvider } from "./providers/tavily.ts";
import type { ProviderCapabilities, ProviderSearchResponse, SearchControl, SearchProviderAdapter } from "./providers/types.ts";
import { canonicalUrlKey } from "./url.ts";

export type Recency = "day" | "week" | "month" | "year";
export const RECENCY_VALUES = ["day", "week", "month", "year"] as const;

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	/** Provider-supplied age/date hint, when available. */
	age?: string;
}

export interface SearchOptions {
	numResults: number;
	recency?: Recency;
	domains?: string[];
	signal?: AbortSignal;
	context?: OperationContext;
	profile?: SearchProfileName;
	fallback?: boolean;
	strictFilters?: boolean;
	language?: string;
	country?: string;
	category?: string;
	content?: "snippets" | "chunks";
	maxPerHost?: number;
}

export interface SearchAttempt {
	provider: Exclude<SearchProviderName, "auto">;
	error: string;
	durationMs: number;
}

export interface SearchResponse {
	query: string;
	provider: ConcreteSearchProvider;
	providers?: ConcreteSearchProvider[];
	results: SearchResult[];
	durationMs: number;
	attempts: SearchAttempt[];
	rawCount: number;
	note?: string;
	appliedControls: SearchControl[];
	unsupportedControls: SearchControl[];
	cached: boolean;
	cacheAgeMs?: number;
}

type ConcreteProvider = ConcreteSearchProvider;

// ---------------------------------------------------------------------------
// Domain filtering
// ---------------------------------------------------------------------------

export interface DomainFilters {
	allow: string[];
	deny: string[];
}

export function parseDomainFilters(domains: string[] | undefined): DomainFilters {
	const filters: DomainFilters = { allow: [], deny: [] };
	for (const raw of domains ?? []) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const deny = trimmed.startsWith("-");
		let host = trimmed.replace(/^-/, "").replace(/^https?:\/\//i, "").replace(/^\*\./, "").replace(/^www\./i, "");
		host = host.split("/")[0]!.toLowerCase();
		if (!host) continue;
		const target = deny ? filters.deny : filters.allow;
		if (!target.includes(host)) target.push(host);
	}
	return filters;
}

function hostMatches(hostname: string, domain: string): boolean {
	return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function matchesDomainFilters(url: string, filters: DomainFilters): boolean {
	if (filters.allow.length === 0 && filters.deny.length === 0) return true;
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return false;
	}
	if (filters.allow.length > 0 && !filters.allow.some((d) => hostMatches(hostname, d))) return false;
	return !filters.deny.some((d) => hostMatches(hostname, d));
}

/** Append `site:` operators when the filter is a single allow-list domain (well supported everywhere). */
function applySiteOperator(query: string, filters: DomainFilters): string {
	if (/\bsite:/i.test(query)) return query;
	const parts: string[] = [];
	if (filters.allow.length === 1) parts.push(`site:${filters.allow[0]}`);
	for (const d of filters.deny.slice(0, 3)) parts.push(`-site:${d}`);
	return parts.length ? `${query} ${parts.join(" ")}` : query;
}

export function finalizeResults(results: SearchResult[], options: SearchOptions): { results: SearchResult[]; rawCount: number } {
	const filters = parseDomainFilters(options.domains);
	const seen = new Set<string>();
	const perHost = new Map<string, number>();
	const out: SearchResult[] = [];
	for (const r of results) {
		let key: string;
		let host: string;
		try {
			key = canonicalUrlKey(r.url);
			host = new URL(r.url).hostname.toLowerCase();
		} catch {
			continue;
		}
		if (seen.has(key)) continue;
		seen.add(key);
		if (!matchesDomainFilters(r.url, filters)) continue;
		const hostCount = perHost.get(host) ?? 0;
		if (options.maxPerHost && hostCount >= options.maxPerHost) continue;
		perHost.set(host, hostCount + 1);
		out.push(r);
		if (out.length >= options.numResults) break;
	}
	return { results: out, rawCount: results.length };
}

// ---------------------------------------------------------------------------
// DuckDuckGo
// ---------------------------------------------------------------------------

const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const DDG_LITE_URL = "https://lite.duckduckgo.com/lite/";
const DDG_RECENCY: Record<Recency, string> = { day: "d", week: "w", month: "m", year: "y" };

/** Decode DuckDuckGo redirect links (//duckduckgo.com/l/?uddg=<encoded>) to the destination URL. */
export function decodeDuckDuckGoUrl(href: string): string | null {
	try {
		const link = new URL(href, DDG_HTML_URL);
		const target = link.searchParams.get("uddg");
		const url = new URL(target ?? link.href);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (/(^|\.)duckduckgo\.com$/.test(url.hostname) && url.pathname.startsWith("/y.js")) return null; // ad tracker
		return url.href;
	} catch {
		return null;
	}
}

function detectDuckDuckGoBlock(html: string, status: number): string | null {
	if (status === 202 || /anomaly-modal|class="anomaly|bots use DuckDuckGo too|If this error persists/i.test(html)) {
		return "DuckDuckGo is rate-limiting this client (bot check). Wait a moment and retry, or configure Brave/SearXNG.";
	}
	if (status === 403) return "DuckDuckGo returned 403 Forbidden (blocked).";
	return null;
}

/** Parse the html.duckduckgo.com results page. */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
	const results: SearchResult[] = [];
	// Split on result containers. Each block runs until the next one.
	const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*results_links[^"]*"/i).slice(1);
	for (const block of blocks) {
		if (/\bresult--ad\b|\bresult__sponsored\b/i.test(block.slice(0, 400))) continue;
		const anchor = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
			?? /<a[^>]+href="([^"]+)"[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
		if (!anchor) continue;
		const url = decodeDuckDuckGoUrl(decodeEntities(anchor[1] ?? ""));
		const title = htmlToText(anchor[2] ?? "");
		if (!url || !title) continue;
		const snippetMatch = /<(?:a|div)[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i.exec(block);
		const snippet = snippetMatch ? htmlToText(snippetMatch[1] ?? "") : "";
		results.push({ title, url, snippet });
	}
	return results;
}

/** Parse the lite.duckduckgo.com results page (table layout). */
export function parseDuckDuckGoLite(html: string): SearchResult[] {
	const results: SearchResult[] = [];
	const linkRe = /<a[^>]+class=['"]result-link['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>|<a[^>]+href=['"]([^'"]+)['"][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
	const snippetRe = /<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;
	const links: Array<{ url: string; title: string; index: number }> = [];
	let m: RegExpExecArray | null;
	while ((m = linkRe.exec(html)) !== null) {
		const url = decodeDuckDuckGoUrl(decodeEntities(m[1] ?? m[3] ?? ""));
		const title = htmlToText(m[2] ?? m[4] ?? "");
		if (url && title) links.push({ url, title, index: m.index });
	}
	const snippets: Array<{ text: string; index: number }> = [];
	while ((m = snippetRe.exec(html)) !== null) snippets.push({ text: htmlToText(m[1] ?? ""), index: m.index });
	for (let i = 0; i < links.length; i++) {
		const link = links[i]!;
		const next = links[i + 1]?.index ?? Number.POSITIVE_INFINITY;
		const snippet = snippets.find((s) => s.index > link.index && s.index < next)?.text ?? "";
		results.push({ title: link.title, url: link.url, snippet });
	}
	return results;
}

async function fetchText(
	url: string,
	config: WebConfig,
	signal: AbortSignal | undefined,
	headers: Record<string, string>,
	init: { method?: "GET" | "POST"; body?: string } = {},
	context?: OperationContext,
): Promise<{ status: number; text: string; contentType: string }> {
	const { response } = await safeFetch(url, {
		signal,
		timeoutMs: config.timeoutMs,
		maxBytes: config.maxResponseBytes,
		headers: { "User-Agent": config.userAgent, "Accept-Language": "en-US,en;q=0.9", ...headers },
		method: init.method,
		body: init.body,
		deadline: context?.deadline,
		byteBudget: context?.byteBudget,
	});
	const bytes = await readBodyLimited(response, config.maxResponseBytes, signal, context?.byteBudget);
	return { status: response.status, text: new TextDecoder().decode(bytes), contentType: response.headers.get("content-type") ?? "" };
}

async function searchDuckDuckGo(query: string, options: SearchOptions, config: WebConfig): Promise<SearchResult[]> {
	const q = applySiteOperator(query, parseDomainFilters(options.domains));
	const htmlUrl = new URL(DDG_HTML_URL);
	htmlUrl.searchParams.set("q", q);
	htmlUrl.searchParams.set("kl", "wt-wt");
	if (options.recency) htmlUrl.searchParams.set("df", DDG_RECENCY[options.recency]);

	const primary = await fetchText(htmlUrl.href, config, options.signal, { Accept: "text/html" }, {}, options.context);
	const blocked = detectDuckDuckGoBlock(primary.text, primary.status);
	let results = primary.status === 200 && !blocked ? parseDuckDuckGoHtml(primary.text) : [];
	if (results.length > 0) return results;

	// Fallback: lite endpoint (different backend path, sometimes not rate-limited when html is)
	const liteUrl = new URL(DDG_LITE_URL);
	liteUrl.searchParams.set("q", q);
	liteUrl.searchParams.set("kl", "wt-wt");
	if (options.recency) liteUrl.searchParams.set("df", DDG_RECENCY[options.recency]);
	const lite = await fetchText(liteUrl.href, config, options.signal, { Accept: "text/html" }, {}, options.context);
	const liteBlocked = detectDuckDuckGoBlock(lite.text, lite.status);
	results = lite.status === 200 && !liteBlocked ? parseDuckDuckGoLite(lite.text) : [];
	if (results.length > 0) return results;

	if (blocked || liteBlocked) throw new Error(blocked ?? liteBlocked ?? "blocked");
	if (primary.status !== 200) throw new Error(`DuckDuckGo returned HTTP ${primary.status}`);
	if (/no results\.?<\/|No results found|did not match any/i.test(primary.text + lite.text)) return [];
	if (!/result__a|result-link/i.test(primary.text + lite.text)) {
		throw new Error("DuckDuckGo returned an unrecognized page (layout may have changed)");
	}
	return [];
}

// ---------------------------------------------------------------------------
// Exa (keyless MCP endpoint)
// ---------------------------------------------------------------------------

interface JsonRpcResponse {
	result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
	error?: { code?: number; message?: string };
}

/** Extract the JSON-RPC payload from a plain JSON or SSE (`data:` lines) body. */
export function parseJsonRpcBody(body: string): JsonRpcResponse | null {
	for (const line of body.split("\n")) {
		if (!line.startsWith("data:")) continue;
		try {
			const candidate = JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
			if (candidate.result || candidate.error) return candidate;
		} catch {
			/* keep scanning */
		}
	}
	try {
		const candidate = JSON.parse(body) as JsonRpcResponse;
		if (candidate.result || candidate.error) return candidate;
	} catch {
		/* not JSON */
	}
	return null;
}

/**
 * Parse Exa's text blocks:
 *   Title: ...\nURL: ...\nPublished: ...\nAuthor: ...\nHighlights:\n> ...\n...\n(or Text: ...)
 */
export function parseExaText(text: string): SearchResult[] {
	const results: SearchResult[] = [];
	for (const block of text.split(/(?=^Title: )/m)) {
		const title = /^Title:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
		const url = /^URL:\s*(\S+)/m.exec(block)?.[1]?.trim() ?? "";
		if (!url || !/^https?:\/\//i.test(url)) continue;
		const published = /^Published:\s*(.+)$/m.exec(block)?.[1]?.trim();
		let bodyText = "";
		const hl = /^Highlights:\s*\n([\s\S]*)$/m.exec(block);
		const tx = /^Text:\s*([\s\S]*)$/m.exec(block);
		if (hl?.[1]) bodyText = hl[1];
		else if (tx?.[1]) bodyText = tx[1];
		const snippet = bodyText
			.split("\n")
			.map((l) => l.replace(/^>\s?/, "").trim())
			.filter((l) => l && l !== "..." && l !== "---")
			.join(" ")
			.replace(/\s+/g, " ")
			.slice(0, 600);
		results.push({
			title: title || url,
			url,
			snippet,
			age: published && !/^n\/a$/i.test(published) ? published.slice(0, 10) : undefined,
		});
	}
	return results;
}

// ---------------------------------------------------------------------------
// Brave
// ---------------------------------------------------------------------------

interface BraveResponse {
	web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string; page_age?: string }> };
	news?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> };
}

export function parseBraveResponse(payload: unknown): SearchResult[] {
	const data = payload as BraveResponse;
	const out: SearchResult[] = [];
	for (const r of data.web?.results ?? []) {
		if (!r.url || !r.title) continue;
		out.push({ title: htmlToText(r.title), url: r.url, snippet: htmlToText(r.description ?? ""), age: r.age ?? r.page_age?.slice(0, 10) });
	}
	for (const r of data.news?.results ?? []) {
		if (!r.url || !r.title) continue;
		out.push({ title: htmlToText(r.title), url: r.url, snippet: htmlToText(r.description ?? ""), age: r.age });
	}
	return out;
}

// ---------------------------------------------------------------------------
// SearXNG
// ---------------------------------------------------------------------------

interface SearxngResponse {
	results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string | null; engine?: string }>;
}

export function parseSearxngResponse(payload: unknown): SearchResult[] {
	const data = payload as SearxngResponse;
	const out: SearchResult[] = [];
	for (const r of data.results ?? []) {
		if (!r.url || !r.title) continue;
		out.push({ title: htmlToText(r.title), url: r.url, snippet: htmlToText(r.content ?? ""), age: r.publishedDate?.slice(0, 10) ?? undefined });
	}
	return out;
}

async function searchSearxng(query: string, options: SearchOptions, config: WebConfig): Promise<SearchResult[]> {
	if (!config.searxngUrl) throw new Error("SearXNG is not configured (set SEARXNG_URL or searxngUrl in pi-web.json)");
	const url = new URL(`${config.searxngUrl}/search`);
	url.searchParams.set("q", applySiteOperator(query, parseDomainFilters(options.domains)));
	url.searchParams.set("format", "json");
	if (options.recency) url.searchParams.set("time_range", options.recency);
	if (options.language) url.searchParams.set("language", options.language);
	if (options.category) url.searchParams.set("categories", options.category);

	const { response } = await safeFetch(url.href, {
		signal: options.signal,
		timeoutMs: config.timeoutMs,
		maxBytes: config.maxResponseBytes,
		headers: { "User-Agent": config.userAgent, Accept: "application/json" },
		allowPrivateNetwork: true,
		deadline: options.context?.deadline,
		byteBudget: options.context?.byteBudget,
	});
	const text = new TextDecoder().decode(await readBodyLimited(response, config.maxResponseBytes, options.signal, options.context?.byteBudget));
	if (response.status === 403) throw new Error("SearXNG returned 403 — enable `json` in the instance's `search.formats` setting");
	if (response.status !== 200) throw new Error(`SearXNG returned HTTP ${response.status}: ${text.slice(0, 200)}`);
	return parseSearxngResponse(JSON.parse(text));
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const SIMPLE_CAPABILITIES: Record<"duckduckgo" | "searxng", ProviderCapabilities> = {
	duckduckgo: { recency: true, domains: true, language: false, country: false, category: false, chunks: false },
	searxng: { recency: true, domains: true, language: true, country: false, category: true, chunks: false },
};

function simpleAdapter(id: "duckduckgo" | "searxng", run: (query: string, options: SearchOptions, config: WebConfig) => Promise<SearchResult[]>): SearchProviderAdapter {
	return {
		id,
		capabilities: SIMPLE_CAPABILITIES[id],
		async search(request) {
			const options: SearchOptions = {
				numResults: request.numResults,
				recency: request.recency,
				domains: [...request.domains.allow, ...request.domains.deny.map((domain) => `-${domain}`)],
				signal: request.context.deadline.signal,
				context: request.context,
				language: request.language,
				category: request.category,
			};
			const results = await run(request.query, options, request.config);
			return {
				results: results.map((result) => ({ ...result, publishedDate: result.age })),
				rawCount: results.length,
				appliedControls: [
					...(request.recency ? ["recency" as const] : []),
					...(request.domains.allow.length || request.domains.deny.length ? ["domains" as const] : []),
					...(id === "searxng" && request.language ? ["language" as const] : []),
					...(id === "searxng" && request.category ? ["category" as const] : []),
				],
				unsupportedControls: [],
				notices: [],
			};
		},
	};
}

const DEFAULT_PROVIDERS: Record<ConcreteProvider, SearchProviderAdapter> = {
	duckduckgo: simpleAdapter("duckduckgo", searchDuckDuckGo),
	exa: exaProvider,
	brave: braveProvider,
	searxng: simpleAdapter("searxng", searchSearxng),
	tavily: tavilyProvider,
};

const PROVIDER_LIMITERS: Record<ConcreteProvider, ReturnType<typeof createLimiter>> = {
	duckduckgo: createLimiter(2),
	exa: createLimiter(2),
	brave: createLimiter(1),
	searxng: createLimiter(4),
	tavily: createLimiter(2),
};

interface CacheEntry { createdAt: number; response: SearchResponse }
const SEARCH_CACHE = new Map<string, CacheEntry>();
const COOLDOWNS = new Map<ConcreteProvider, number>();

export interface SearchDependencies {
	providers?: Partial<Record<ConcreteProvider, SearchProviderAdapter>>;
	now?: () => number;
	transport?: ProviderTransport;
}

export function clearSearchCache(): void {
	SEARCH_CACHE.clear();
	COOLDOWNS.clear();
}

export function searchCacheStats(): { entries: number; cooldowns: number } {
	return { entries: SEARCH_CACHE.size, cooldowns: COOLDOWNS.size };
}

export function isProviderConfigured(provider: ConcreteProvider, config: WebConfig): boolean {
	if (provider === "brave") return Boolean(config.braveApiKey);
	if (provider === "tavily") return Boolean(config.tavilyApiKey);
	if (provider === "searxng") return Boolean(config.searxngUrl);
	return true;
}

export function resolveProviderChain(requested: SearchProviderName | undefined, config: WebConfig): ConcreteProvider[] {
	return resolvePolicy(config, { provider: requested }).providers;
}

function requestedControls(options: SearchOptions): SearchControl[] {
	return [
		...(options.recency ? ["recency" as const] : []),
		...(options.domains?.length ? ["domains" as const] : []),
		...(options.language ? ["language" as const] : []),
		...(options.country ? ["country" as const] : []),
		...(options.category ? ["category" as const] : []),
		...(options.content === "chunks" ? ["chunks" as const] : []),
	];
}

function unsupportedBy(adapter: SearchProviderAdapter, controls: readonly SearchControl[]): SearchControl[] {
	return controls.filter((control) => !adapter.capabilities[control]);
}

function recencyStart(recency: Recency | undefined, now: number): string | undefined {
	if (!recency) return undefined;
	const days = recency === "day" ? 1 : recency === "week" ? 7 : recency === "month" ? 31 : 366;
	return new Date(now - days * 86_400_000).toISOString();
}

function cacheKey(query: string, options: SearchOptions, policy: ReturnType<typeof resolvePolicy>, recency: Recency | undefined): string {
	return JSON.stringify({
		query: query.trim(),
		numResults: options.numResults,
		recency,
		domains: options.domains ?? [],
		language: options.language ?? null,
		country: options.country ?? null,
		category: options.category ?? null,
		content: options.content ?? "snippets",
		maxPerHost: options.maxPerHost ?? null,
		strictFilters: options.strictFilters ?? false,
		profile: policy.profile,
		privacy: policy.privacy,
		providers: policy.providers,
		fallback: policy.fallback,
	});
}

function getCached(key: string, now: number, ttlMs: number, lookupDurationMs: number): SearchResponse | undefined {
	const entry = SEARCH_CACHE.get(key);
	if (!entry) return undefined;
	const age = now - entry.createdAt;
	if (age >= ttlMs) {
		SEARCH_CACHE.delete(key);
		return undefined;
	}
	SEARCH_CACHE.delete(key);
	SEARCH_CACHE.set(key, entry);
	return { ...entry.response, attempts: [...entry.response.attempts], results: [...entry.response.results], durationMs: lookupDurationMs, cached: true, cacheAgeMs: age };
}

function putCached(key: string, response: SearchResponse, now: number, maxEntries: number): void {
	SEARCH_CACHE.delete(key);
	SEARCH_CACHE.set(key, { createdAt: now, response: { ...response, cached: false, cacheAgeMs: undefined } });
	while (SEARCH_CACHE.size > maxEntries) SEARCH_CACHE.delete(SEARCH_CACHE.keys().next().value as string);
}

function toSearchResults(response: ProviderSearchResponse): SearchResult[] {
	return response.results.map((result) => ({
		title: result.title,
		url: result.url,
		snippet: result.snippet,
		age: result.age ?? result.publishedDate?.slice(0, 10),
	}));
}

export async function search(
	query: string,
	options: SearchOptions,
	config: WebConfig,
	requested?: SearchProviderName,
	dependencies: SearchDependencies = {},
): Promise<SearchResponse> {
	const now = dependencies.now ?? Date.now;
	const startedAt = now();
	const policy = resolvePolicy(config, { profile: options.profile, provider: requested, fallback: options.fallback });
	const effectiveRecency = options.recency ?? (policy.strictRecency ? "month" : undefined);
	const effectiveOptions = { ...options, recency: effectiveRecency };
	const key = cacheKey(query, effectiveOptions, policy, effectiveRecency);
	const cacheable = !policy.providers.includes("searxng");
	const cacheNow = now();
	const cached = cacheable ? getCached(key, cacheNow, config.searchCacheTtlMs, Math.max(0, cacheNow - startedAt)) : undefined;
	if (cached) return cached;
	const ownedDeadline = options.context ? undefined : createDeadline(config.timeoutMs, options.signal);
	const context = options.context ?? { deadline: ownedDeadline! };
	const attempts: SearchAttempt[] = [];
	const controls = requestedControls(effectiveOptions);
	const merged: SearchResult[] = [];
	const successfulProviders: ConcreteProvider[] = [];
	const notes: string[] = [];
	const applied = new Set<SearchControl>();
	const unsupported = new Set<SearchControl>();
	let rawCount = 0;

	try {
		for (const provider of policy.providers) {
			const attemptStart = now();
			const adapter = dependencies.providers?.[provider] ?? DEFAULT_PROVIDERS[provider];
			const unsupportedControls = unsupportedBy(adapter, controls);
			if (effectiveOptions.strictFilters && unsupportedControls.length > 0) {
				const message = `${provider}: ${unsupportedControls.join(", ")} ${unsupportedControls.length === 1 ? "is" : "are"} not supported`;
				attempts.push({ provider, error: message, durationMs: now() - attemptStart });
				if (policy.explicitProvider || !policy.fallback) throw new Error(message);
				continue;
			}
			const cooldownUntil = COOLDOWNS.get(provider) ?? 0;
			if (cooldownUntil > now()) {
				const message = `${provider} is in cooldown for ${cooldownUntil - now()}ms`;
				attempts.push({ provider, error: message, durationMs: 0 });
				if (policy.explicitProvider || !policy.fallback) throw new Error(message);
				continue;
			}
			try {
				const run = () => adapter.search({
					query,
					numResults: options.numResults,
					recency: effectiveRecency,
					domains: parseDomainFilters(options.domains),
					language: options.language,
					country: options.country,
					category: options.category,
					content: options.content,
					startPublishedDate: recencyStart(effectiveRecency, now()),
					endPublishedDate: effectiveRecency ? new Date(now()).toISOString() : undefined,
					context,
					config,
					explicitAccountApi: policy.explicitProvider && provider === "exa",
					transport: dependencies.transport,
				});
				const response = await PROVIDER_LIMITERS[provider](run, { deadline: context.deadline, signal: context.deadline.signal });
				if (effectiveOptions.strictFilters && response.unsupportedControls.length > 0) {
					throw new Error(`${provider}: ${response.unsupportedControls.join(", ")} ${response.unsupportedControls.length === 1 ? "is" : "are"} not supported for this request`);
				}
				rawCount += response.rawCount;
				merged.push(...toSearchResults(response));
				successfulProviders.push(provider);
				response.notices.forEach((notice) => notes.push(`${provider}: ${notice}`));
				response.appliedControls.forEach((control) => applied.add(control));
				[...unsupportedControls, ...response.unsupportedControls].forEach((control) => unsupported.add(control));
				if (policy.profile !== "deep") break;
			} catch (error) {
				if (error instanceof ProviderHttpError && error.status === 429) {
					COOLDOWNS.set(provider, now() + Math.min(MAX_RETRY_AFTER_MS, error.retryAfterMs ?? 60_000));
				}
				if (context.deadline.signal.aborted || (error instanceof NetError && error.kind === "aborted")) throw error;
				const message = error instanceof Error ? error.message : String(error);
				attempts.push({ provider, error: message, durationMs: now() - attemptStart });
				if (!policy.fallback) throw error;
			}
		}
		if (successfulProviders.length === 0) {
			const detail = attempts.map((attempt) => `${attempt.provider}: ${attempt.error}`).join("; ");
			throw new Error(`All search providers failed — ${detail}`);
		}
		const finalized = finalizeResults(merged, effectiveOptions);
		if (unsupported.size > 0) notes.push(`Unsupported controls: ${[...unsupported].join(", ")}`);
		const response: SearchResponse = {
			query,
			provider: successfulProviders[0]!,
			...(successfulProviders.length > 1 ? { providers: successfulProviders } : {}),
			results: finalized.results,
			durationMs: now() - startedAt,
			attempts,
			rawCount: Math.max(rawCount, finalized.rawCount),
			...(notes.length ? { note: notes.join("; ") } : {}),
			appliedControls: [...applied],
			unsupportedControls: [...unsupported],
			cached: false,
		};
		if (cacheable) putCached(key, response, now(), config.searchCacheMaxEntries);
		return response;
	} finally {
		ownedDeadline?.dispose();
	}
}
