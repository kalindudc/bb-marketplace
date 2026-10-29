import type { OperationContext } from "../contracts.ts";
import type { WebConfig } from "../config.ts";
import { createDeadline } from "../deadline.ts";
import type { Resolver } from "../net.ts";
import { assertRemoteForwardableUrl } from "../readers/policy.ts";
import { ProviderHttpError, providerJson, type ProviderTransport } from "./http.ts";

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";
const FIRECRAWL_ORIGINS = ["https://api.firecrawl.dev"];

function auth(config: WebConfig): Record<string, string> {
	if (!config.firecrawlApiKey) throw new Error("Firecrawl is not configured");
	return { Authorization: `Bearer ${config.firecrawlApiKey}`, "Content-Type": "application/json" };
}

export interface FirecrawlMapEntry { url: string; title: string; description: string }

export function parseFirecrawlMap(payload: unknown): FirecrawlMapEntry[] {
	const links = (payload as { links?: Array<string | { url?: string; title?: string; description?: string }> }).links ?? [];
	return links.flatMap((entry) => {
		if (typeof entry === "string") return [{ url: entry, title: "", description: "" }];
		return entry.url ? [{ url: entry.url, title: entry.title ?? "", description: entry.description ?? "" }] : [];
	});
}

export interface FirecrawlDocument {
	markdown: string;
	title: string;
	statusCode: number;
	finalUrl: string;
}

function parseFirecrawlDocument(data: unknown): FirecrawlDocument | null {
	const document = data as { markdown?: string; metadata?: { title?: string; statusCode?: number; url?: string; sourceURL?: string } };
	if (typeof document.markdown !== "string") return null;
	return {
		markdown: document.markdown,
		title: document.metadata?.title ?? "",
		statusCode: document.metadata?.statusCode ?? 200,
		finalUrl: document.metadata?.url ?? document.metadata?.sourceURL ?? "",
	};
}

export function parseFirecrawlScrape(payload: unknown): FirecrawlDocument {
	const document = parseFirecrawlDocument((payload as { data?: unknown }).data);
	if (!document) throw new Error("Firecrawl scrape response did not include markdown");
	return document;
}

export interface FirecrawlCrawlView {
	id: string;
	status: string;
	completed: number;
	total: number;
	next?: string;
	pages: FirecrawlDocument[];
}

export function parseFirecrawlCrawl(payload: unknown): FirecrawlCrawlView {
	const data = payload as { id?: string; status?: string; completed?: number; total?: number; next?: string; data?: unknown[] };
	if (!data.id) throw new Error("Firecrawl crawl response did not include a job id");
	return {
		id: data.id,
		status: data.status ?? "queued",
		completed: data.completed ?? 0,
		total: data.total ?? 0,
		...(data.next ? { next: data.next } : {}),
		pages: (data.data ?? []).map(parseFirecrawlDocument).filter((page): page is FirecrawlDocument => page !== null),
	};
}

export async function firecrawlMap(input: {
	url: string;
	query?: string;
	limit?: number;
	includeSubdomains?: boolean;
	context: OperationContext;
	config: WebConfig;
	resolver?: Resolver;
	transport?: ProviderTransport;
}): Promise<FirecrawlMapEntry[]> {
	const url = await assertRemoteForwardableUrl(input.url, { resolver: input.resolver, signal: input.context.deadline.signal, deadline: input.context.deadline });
	const { data } = await providerJson<unknown>({
		provider: "firecrawl",
		url: `${FIRECRAWL_BASE}/map`,
		method: "POST",
		headers: auth(input.config),
		body: JSON.stringify({ url: url.href, search: input.query, limit: input.limit ?? 200, includeSubdomains: input.includeSubdomains ?? false, sitemap: "include", ignoreQueryParameters: false }),
		context: input.context,
		config: input.config,
		allowedRedirectOrigins: FIRECRAWL_ORIGINS,
	}, input.transport);
	return parseFirecrawlMap(data);
}

export async function firecrawlScrape(input: {
	url: string;
	context: OperationContext;
	config: WebConfig;
	resolver?: Resolver;
	transport?: ProviderTransport;
}): Promise<FirecrawlDocument> {
	const url = await assertRemoteForwardableUrl(input.url, { resolver: input.resolver, signal: input.context.deadline.signal, deadline: input.context.deadline });
	const { data } = await providerJson<unknown>({
		provider: "firecrawl",
		url: `${FIRECRAWL_BASE}/scrape`,
		method: "POST",
		headers: auth(input.config),
		body: JSON.stringify({ url: url.href, formats: ["markdown"], onlyMainContent: true }),
		context: input.context,
		config: input.config,
		allowedRedirectOrigins: FIRECRAWL_ORIGINS,
	}, input.transport);
	return parseFirecrawlScrape(data);
}

function literalPathPattern(prefix: string): string {
	return `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
}

export async function firecrawlStartCrawl(input: {
	url: string;
	includePaths?: string[];
	excludePaths?: string[];
	limit: number;
	maxDepth: number;
	context: OperationContext;
	config: WebConfig;
	resolver?: Resolver;
	transport?: ProviderTransport;
}): Promise<FirecrawlCrawlView> {
	const url = await assertRemoteForwardableUrl(input.url, { resolver: input.resolver, signal: input.context.deadline.signal, deadline: input.context.deadline });
	const { data } = await providerJson<unknown>({
		provider: "firecrawl",
		url: `${FIRECRAWL_BASE}/crawl`,
		method: "POST",
		headers: auth(input.config),
		body: JSON.stringify({
			url: url.href,
			includePaths: input.includePaths?.map(literalPathPattern),
			excludePaths: input.excludePaths?.map(literalPathPattern),
			limit: input.limit,
			maxDiscoveryDepth: input.maxDepth,
			scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
		}),
		context: input.context,
		config: input.config,
		allowedRedirectOrigins: FIRECRAWL_ORIGINS,
	}, input.transport);
	return parseFirecrawlCrawl(data);
}

export async function firecrawlCrawlStatus(
	id: string,
	context: OperationContext,
	config: WebConfig,
	transport?: ProviderTransport,
): Promise<FirecrawlCrawlView> {
	const { data } = await providerJson<unknown>({
		provider: "firecrawl",
		url: `${FIRECRAWL_BASE}/crawl/${encodeURIComponent(id)}`,
		headers: auth(config),
		context,
		config,
		allowedRedirectOrigins: FIRECRAWL_ORIGINS,
	}, transport);
	return parseFirecrawlCrawl({ ...(data as object), id });
}

function assertFirecrawlNext(next: string): string {
	let url: URL;
	try {
		url = new URL(next);
	} catch {
		throw new ProviderHttpError("firecrawl", 0, "Firecrawl pagination returned an invalid next URL");
	}
	if (!FIRECRAWL_ORIGINS.includes(url.origin)) {
		throw new ProviderHttpError("firecrawl", 0, `Firecrawl pagination origin ${url.origin} is outside the allowed API origin ceiling`);
	}
	return url.href;
}

export async function firecrawlCrawlNext(
	next: string,
	context: OperationContext,
	config: WebConfig,
	transport?: ProviderTransport,
): Promise<FirecrawlCrawlView> {
	const url = assertFirecrawlNext(next);
	const { data } = await providerJson<unknown>({
		provider: "firecrawl",
		url,
		headers: auth(config),
		context,
		config,
		allowedRedirectOrigins: FIRECRAWL_ORIGINS,
	}, transport);
	const id = /\/crawl\/([^/?]+)/.exec(new URL(url).pathname)?.[1];
	return parseFirecrawlCrawl({ ...(data as object), ...(id ? { id: decodeURIComponent(id) } : {}) });
}

export async function firecrawlCancelCrawl(
	id: string,
	expiredContext: OperationContext,
	config: WebConfig,
	transport?: ProviderTransport,
): Promise<{ status: string }> {
	const deadline = createDeadline(Math.min(5_000, config.timeoutMs));
	const context: OperationContext = { deadline, byteBudget: expiredContext.byteBudget };
	try {
		const { data } = await providerJson<{ status?: string }>({
			provider: "firecrawl",
			url: `${FIRECRAWL_BASE}/crawl/${encodeURIComponent(id)}`,
			method: "DELETE",
			headers: auth(config),
			context,
			config,
			allowedRedirectOrigins: FIRECRAWL_ORIGINS,
		}, transport);
		return { status: data.status ?? "cancelled" };
	} finally {
		deadline.dispose();
	}
}
