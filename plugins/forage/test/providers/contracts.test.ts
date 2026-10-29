import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { CONFIG_DEFAULTS, type WebConfig } from "../../src/web/config.ts";
import type { OperationContext } from "../../src/web/contracts.ts";
import { createByteBudget, createDeadline } from "../../src/web/deadline.ts";
import { braveProvider, parseBraveContextResponse } from "../../src/web/providers/brave.ts";
import {
	buildExaDirectRequest,
	buildExaMcpArguments,
	exaProvider,
	parseExaDirectResponse,
	parseExaMcpResponse,
} from "../../src/web/providers/exa.ts";
import {
	firecrawlCancelCrawl,
	firecrawlCrawlNext,
	firecrawlCrawlStatus,
	firecrawlStartCrawl,
	parseFirecrawlCrawl,
	parseFirecrawlMap,
	parseFirecrawlScrape,
} from "../../src/web/providers/firecrawl.ts";
import {
	MAX_RETRY_AFTER_MS,
	ProviderHttpError,
	parseRetryAfterMs,
	type ProviderTransport,
} from "../../src/web/providers/http.ts";
import { parseTavilyExtract, parseTavilySearch, tavilyProvider } from "../../src/web/providers/tavily.ts";
import type { ProviderSearchRequest } from "../../src/web/providers/types.ts";

const fixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/providers/${name}`, import.meta.url)), "utf8")) as unknown;

function config(overrides: Partial<WebConfig> = {}): WebConfig {
	return { ...CONFIG_DEFAULTS, warnings: [], ...overrides };
}

function context(timeoutMs = 1_000): OperationContext {
	return { deadline: createDeadline(timeoutMs) };
}

function request(overrides: Partial<ProviderSearchRequest> = {}): ProviderSearchRequest {
	return {
		query: "runtime schemas",
		numResults: 8,
		domains: { allow: [], deny: [] },
		context: context(),
		config: config(),
		explicitAccountApi: false,
		...overrides,
	};
}

function jsonTransport(payload: unknown, calls: Array<{ url: string; options: Parameters<ProviderTransport>[1] }>, status = 200): ProviderTransport {
	return async (url, options) => {
		calls.push({ url, options });
		return {
			response: new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }),
			finalUrl: url,
			redirects: 0,
			access: { network: "public", credentialed: false, requestScopeKey: null },
			acceptedRedirectBytes: 0,
		};
	};
}

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 as const }];

describe("documented provider contracts", () => {
	it("builds separate Exa MCP and direct API bodies", () => {
		const input = {
			query: "runtime schemas",
			numResults: 8,
			domains: { allow: ["example.com/docs"], deny: ["spam.example"] },
			startPublishedDate: "2026-01-01T00:00:00.000Z",
			endPublishedDate: "2026-02-01T00:00:00.000Z",
			category: "research",
			content: "chunks" as const,
		};
		assert.deepEqual(buildExaMcpArguments(input), {
			query: "runtime schemas",
			numResults: 8,
			includeDomains: ["example.com/docs"],
			excludeDomains: ["spam.example"],
			startPublishedDate: "2026-01-01T00:00:00.000Z",
			endPublishedDate: "2026-02-01T00:00:00.000Z",
			enableHighlights: true,
			highlightsMaxCharacters: 6000,
		});
		assert.deepEqual(buildExaDirectRequest(input), {
			query: "runtime schemas",
			numResults: 8,
			includeDomains: ["example.com/docs"],
			excludeDomains: ["spam.example"],
			startPublishedDate: "2026-01-01T00:00:00.000Z",
			endPublishedDate: "2026-02-01T00:00:00.000Z",
			category: "research paper",
			contents: { text: true, highlights: { maxCharacters: 6000 } },
		});
	});

	it("serializes Exa MCP arguments using the current flat schema", async () => {
		const calls: Array<{ url: string; options: Parameters<ProviderTransport>[1] }> = [];
		const transport = jsonTransport(fixture("exa-mcp.json"), calls);
		const response = await exaProvider.search(request({
			category: "research",
			content: "chunks",
			transport,
		}));
		const body = JSON.parse(calls[0]!.options.body!) as { params: { arguments: Record<string, unknown> } };
		assert.equal(body.params.arguments.enableHighlights, true);
		assert.equal(body.params.arguments.highlightsMaxCharacters, 6000);
		assert.equal("contents" in body.params.arguments, false);
		assert.equal("category" in body.params.arguments, false);
		assert.deepEqual(response.unsupportedControls, ["category"]);
		assert.deepEqual(calls[0]!.options.allowedRedirectOrigins, ["https://mcp.exa.ai", "https://api.exa.ai"]);
	});

	it("serializes Exa direct API content controls separately", async () => {
		const calls: Array<{ url: string; options: Parameters<ProviderTransport>[1] }> = [];
		const transport = jsonTransport(fixture("exa-direct.json"), calls);
		await exaProvider.search(request({
			category: "research",
			content: "chunks",
			explicitAccountApi: true,
			config: config({ exaApiKey: "exa-key" }),
			transport,
		}));
		const body = JSON.parse(calls[0]!.options.body!) as Record<string, unknown>;
		assert.equal(body.category, "research paper");
		assert.deepEqual(body.contents, { text: true, highlights: { maxCharacters: 6000 } });
		assert.equal(calls[0]!.options.headers?.["x-api-key"], "exa-key");
	});

	it("parses structured Exa MCP JSON and preserves provider notices", () => {
		const parsed = parseExaMcpResponse(fixture("exa-mcp.json"));
		assert.equal(parsed.results.length, 2);
		assert.equal(parsed.results[0]?.url, "https://Example.com/Docs/Case?Q=A");
		assert.equal(parsed.results[0]?.snippet, "First relevant chunk. Second chunk.");
		assert.deepEqual(parsed.notices, ["Date bounds were relaxed because too few results matched."]);
	});

	it("parses direct Exa account API results", () => {
		const parsed = parseExaDirectResponse(fixture("exa-direct.json"));
		assert.equal(parsed.results[0]?.publishedDate, "2026-02-03T04:05:06.000Z");
		assert.deepEqual(parsed.results[0]?.highlights, ["Direct API highlight"]);
	});

	it("sends Brave Context freshness and reads source ages", async () => {
		const calls: Array<{ url: string; options: Parameters<ProviderTransport>[1] }> = [];
		const response = await braveProvider.search(request({
			recency: "month",
			domains: { allow: ["one.example", "two.example"], deny: ["spam.example"] },
			content: "chunks",
			config: config({ braveApiKey: "brave-key" }),
			transport: jsonTransport(fixture("brave-context.json"), calls),
		}));
		const url = new URL(calls[0]!.url);
		assert.equal(url.searchParams.get("freshness"), "pm");
		assert.match(url.searchParams.get("q") ?? "", /-site:spam\.example/);
		assert.doesNotMatch(url.searchParams.get("q") ?? "", /site:one\.example/);
		assert.equal(response.results[0]?.age, "2 days ago");
		assert.equal(response.appliedControls.includes("recency"), true);
		assert.equal(response.appliedControls.includes("domains"), false);
		assert.equal(response.unsupportedControls.includes("domains"), true);
		assert.equal(calls[0]!.options.headers?.["X-Subscription-Token"], "brave-key");
		assert.deepEqual(calls[0]!.options.allowedRedirectOrigins, ["https://api.search.brave.com"]);
	});

	it("parses Brave LLM Context without invented result fields", () => {
		const parsed = parseBraveContextResponse(fixture("brave-context.json"));
		assert.equal(parsed.length, 2);
		assert.deepEqual(parsed[0], { title: "Brave source", url: "https://brave.example/a", snippet: "Relevant context A", age: "2 days ago" });
	});

	it("normalizes Tavily countries and reports only forwarded controls", async () => {
		const generalCalls: Array<{ url: string; options: Parameters<ProviderTransport>[1] }> = [];
		const general = await tavilyProvider.search(request({
			country: "US",
			category: "documentation",
			config: config({ tavilyApiKey: "tavily-key" }),
			transport: jsonTransport(fixture("tavily-search.json"), generalCalls),
		}));
		const generalBody = JSON.parse(generalCalls[0]!.options.body!) as Record<string, unknown>;
		assert.equal(generalBody.country, "united states");
		assert.equal(generalBody.topic, "general");
		assert.equal(general.appliedControls.includes("country"), true);
		assert.equal(general.appliedControls.includes("category"), false);
		assert.equal(general.unsupportedControls.includes("category"), true);
		assert.equal(generalCalls[0]!.options.headers?.Authorization, "Bearer tavily-key");
		assert.deepEqual(generalCalls[0]!.options.allowedRedirectOrigins, ["https://api.tavily.com"]);

		const newsCalls: Array<{ url: string; options: Parameters<ProviderTransport>[1] }> = [];
		const news = await tavilyProvider.search(request({
			country: "US",
			category: "news",
			config: config({ tavilyApiKey: "tavily-key" }),
			transport: jsonTransport(fixture("tavily-search.json"), newsCalls),
		}));
		const newsBody = JSON.parse(newsCalls[0]!.options.body!) as Record<string, unknown>;
		assert.equal(newsBody.topic, "news");
		assert.equal("country" in newsBody, false);
		assert.equal(news.appliedControls.includes("category"), true);
		assert.equal(news.unsupportedControls.includes("country"), true);
	});

	it("parses Tavily search and extract including per-URL failures", () => {
		const search = parseTavilySearch(fixture("tavily-search.json"));
		assert.equal(search[0]?.score, 0.91);
		const extract = parseTavilyExtract(fixture("tavily-extract.json"));
		assert.equal(extract.results[0]?.content, "# Extracted");
		assert.deepEqual(extract.failures, [{ url: "https://bad.example/", error: "blocked" }]);
	});

	it("parses Firecrawl managed crawl pages", () => {
		assert.deepEqual(parseFirecrawlMap(fixture("firecrawl-map.json")), [
			{ url: "https://docs.example/a", title: "A", description: "Page A" },
			{ url: "https://docs.example/B?Case=1", title: "B", description: "" },
		]);
		assert.deepEqual(parseFirecrawlScrape(fixture("firecrawl-scrape.json")), {
			markdown: "# Page",
			title: "Page",
			statusCode: 200,
			finalUrl: "https://docs.example/page",
		});
		assert.deepEqual(parseFirecrawlCrawl(fixture("firecrawl-crawl.json")), {
			id: "crawl_123",
			status: "scraping",
			completed: 3,
			total: 8,
			next: "https://api.firecrawl.dev/v2/crawl/crawl_123?skip=3",
			pages: [{ markdown: "# Crawled page", title: "Crawled page", statusCode: 200, finalUrl: "https://docs.example/crawled" }],
		});
	});

	it("covers Firecrawl start, status, pagination and cancel through the provider transport", async () => {
		const calls: Array<{ url: string; options: Parameters<ProviderTransport>[1] }> = [];
		const transport: ProviderTransport = async (url, options) => {
			calls.push({ url, options });
			const payload = options.method === "DELETE"
				? { status: "cancelled" }
				: url.endsWith("/crawl")
					? { id: "crawl_123", status: "scraping", completed: 0, total: 1 }
					: fixture("firecrawl-crawl.json");
			return {
				response: new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } }),
				finalUrl: url,
				redirects: 0,
				access: { network: "public", credentialed: true, requestScopeKey: null },
				acceptedRedirectBytes: 0,
			};
		};
		const cfg = config({ firecrawlApiKey: "firecrawl-key" });
		const startContext = context();
		const started = await firecrawlStartCrawl({ url: "https://docs.example/#token=secret", limit: 10, maxDepth: 2, context: startContext, config: cfg, resolver: publicResolver, transport });
		assert.equal(started.id, "crawl_123");
		assert.equal(JSON.parse(calls[0]!.options.body!).url, "https://docs.example/");
		assert.equal(calls[0]!.options.headers?.Authorization, "Bearer firecrawl-key");
		assert.deepEqual(calls[0]!.options.allowedRedirectOrigins, ["https://api.firecrawl.dev"]);
		startContext.deadline.dispose();

		const statusContext = context();
		const status = await firecrawlCrawlStatus("crawl_123", statusContext, cfg, transport);
		assert.equal(status.pages.length, 1);
		const next = await firecrawlCrawlNext(status.next!, statusContext, cfg, transport);
		assert.equal(next.pages[0]?.title, "Crawled page");
		await assert.rejects(() => firecrawlCrawlNext("https://evil.example/crawl/crawl_123", statusContext, cfg, transport), /origin/i);
		statusContext.deadline.dispose();

		const expiredContext = context(1);
		await new Promise((resolve) => setTimeout(resolve, 5));
		const cancelled = await firecrawlCancelCrawl("crawl_123", expiredContext, cfg, transport);
		assert.equal(cancelled.status, "cancelled");
		assert.equal(calls.at(-1)?.options.method, "DELETE");
		expiredContext.deadline.dispose();
	});

	it("bounds Firecrawl crawl pages with the shared byte budget", async () => {
		const transport = jsonTransport(fixture("firecrawl-crawl.json"), []);
		const limitedContext: OperationContext = { deadline: createDeadline(1_000), byteBudget: createByteBudget(10) };
		await assert.rejects(
			() => firecrawlCrawlStatus("crawl_123", limitedContext, config({ firecrawlApiKey: "key" }), transport),
			/Byte budget exceeded/,
		);
		limitedContext.deadline.dispose();
	});

	it("guards non-JSON Firecrawl cancel responses", async () => {
		const transport: ProviderTransport = async (url) => ({
			response: new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
			finalUrl: url,
			redirects: 0,
			access: { network: "public", credentialed: true, requestScopeKey: null },
			acceptedRedirectBytes: 0,
		});
		const expiredContext = context(1);
		await new Promise((resolve) => setTimeout(resolve, 5));
		await assert.rejects(() => firecrawlCancelCrawl("crawl_123", expiredContext, config({ firecrawlApiKey: "key" }), transport), ProviderHttpError);
		expiredContext.deadline.dispose();
	});
});

describe("Retry-After and provider cooldown errors", () => {
	it("parses delta seconds and HTTP dates with a bounded cap", () => {
		assert.equal(parseRetryAfterMs("7", 0), 7_000);
		assert.equal(parseRetryAfterMs("Thu, 01 Jan 1970 00:00:09 GMT", 1_000), 8_000);
		assert.equal(parseRetryAfterMs("99999999999", 0), MAX_RETRY_AFTER_MS);
		assert.equal(parseRetryAfterMs("Wed, 21 Oct 2099 07:28:00 GMT", 0), MAX_RETRY_AFTER_MS);
		assert.equal(parseRetryAfterMs("garbage", 0), undefined);
	});

	it("carries retry timing without exposing credentials", () => {
		const error = new ProviderHttpError("tavily", 429, "rate limited", 12_000);
		assert.equal(error.retryAfterMs, 12_000);
		assert.equal(error.status, 429);
	});
});
