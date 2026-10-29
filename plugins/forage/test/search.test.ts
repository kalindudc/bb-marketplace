import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { CONFIG_DEFAULTS, type WebConfig } from "../src/web/config.ts";
import { ProviderHttpError } from "../src/web/providers/http.ts";
import type { SearchProviderAdapter } from "../src/web/providers/types.ts";
import {
	clearSearchCache,
	decodeDuckDuckGoUrl,
	finalizeResults,
	isProviderConfigured,
	matchesDomainFilters,
	parseBraveResponse,
	parseDomainFilters,
	parseDuckDuckGoHtml,
	parseDuckDuckGoLite,
	parseExaText,
	parseJsonRpcBody,
	parseSearxngResponse,
	resolveProviderChain,
	search,
	searchCacheStats,
} from "../src/web/search.ts";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

function config(overrides: Partial<WebConfig> = {}): WebConfig {
	return { ...CONFIG_DEFAULTS, warnings: [], ...overrides };
}

describe("domain filters", () => {
	it("parses allow/deny lists and normalizes hosts", () => {
		assert.deepEqual(parseDomainFilters(["github.com", "-www.Reddit.com", "https://docs.python.org/3/", "*.example.org", " ", "-github.com/x"]), {
			allow: ["github.com", "docs.python.org", "example.org"],
			deny: ["reddit.com", "github.com"],
		});
	});
	it("matches subdomains and applies deny after allow", () => {
		const f = parseDomainFilters(["github.com", "-gist.github.com"]);
		assert.equal(matchesDomainFilters("https://github.com/a/b", f), true);
		assert.equal(matchesDomainFilters("https://www.github.com/a/b", f), true);
		assert.equal(matchesDomainFilters("https://docs.github.com/x", f), true);
		assert.equal(matchesDomainFilters("https://gist.github.com/x", f), false);
		assert.equal(matchesDomainFilters("https://notgithub.com/x", f), false);
		assert.equal(matchesDomainFilters("garbage", f), false);
		assert.equal(matchesDomainFilters("https://anything.example/", parseDomainFilters(undefined)), true);
	});
});

describe("DuckDuckGo", () => {
	it("decodes redirect links and drops ad trackers", () => {
		assert.equal(decodeDuckDuckGoUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=x"), "https://example.com/a?b=1");
		assert.equal(decodeDuckDuckGoUrl("https://direct.example/page"), "https://direct.example/page");
		assert.equal(decodeDuckDuckGoUrl("https://duckduckgo.com/y.js?ad_domain=x"), null);
		assert.equal(decodeDuckDuckGoUrl("//duckduckgo.com/l/?uddg=javascript%3Aalert(1)"), null);
	});
	it("parses the html endpoint fixture, skipping ads and decoding entities", () => {
		const results = parseDuckDuckGoHtml(fixture("ddg-html.html"));
		assert.equal(results.length, 4, "ad excluded; duplicate kept at parse stage");
		assert.deepEqual(results[0], {
			title: "Markdown Guide",
			url: "https://www.markdownguide.org/",
			snippet: "The Markdown Guide is a free and open-source reference guide that explains how to use Markdown, the simple and easy-to-use markup language.",
		});
		assert.equal(results[1]?.url, "https://www.markdownguide.org/basic-syntax/");
		assert.match(results[1]?.snippet ?? "", /design document & more\.$/);
		assert.equal(results[2]?.title, "Writing on GitHub - GitHub Docs");
	});
	it("returns nothing for the bot-check page (detected upstream as a block)", () => {
		const blocked = fixture("ddg-blocked.html");
		assert.match(blocked, /anomaly-modal/);
		assert.deepEqual(parseDuckDuckGoHtml(blocked), []);
	});
	it("parses the lite endpoint layout and pairs snippets with links", () => {
		const lite = `<table>
<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2F" class='result-link'>A Title</a></td></tr>
<tr><td class='result-snippet'>Snippet A</td></tr>
<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.example%2F" class='result-link'>B Title</a></td></tr>
<tr><td class='result-snippet'>Snippet <b>B</b></td></tr>
</table>`;
		assert.deepEqual(parseDuckDuckGoLite(lite), [
			{ title: "A Title", url: "https://a.example/", snippet: "Snippet A" },
			{ title: "B Title", url: "https://b.example/", snippet: "Snippet B" },
		]);
	});
});

describe("Exa", () => {
	it("extracts JSON-RPC payloads from SSE or plain JSON bodies", () => {
		assert.deepEqual(parseJsonRpcBody('event: message\ndata: {"result":{"content":[]}}\n\n'), { result: { content: [] } });
		assert.deepEqual(parseJsonRpcBody('{"error":{"code":-32000,"message":"bad"}}'), { error: { code: -32000, message: "bad" } });
		assert.equal(parseJsonRpcBody("garbage"), null);
	});
	it("parses Title/URL/Published/Highlights blocks", () => {
		const text = `Title: First Page
URL: https://one.example/a
Published: 2024-05-01T00:00:00.000Z
Author: N/A
Highlights:
> First highlight sentence.
...
Second highlight sentence.
---
Title: Second Page
URL: https://two.example/b
Published: N/A
Author: Someone
Text: Full text body here.
`;
		const results = parseExaText(text);
		assert.equal(results.length, 2);
		assert.deepEqual(results[0], { title: "First Page", url: "https://one.example/a", snippet: "First highlight sentence. Second highlight sentence.", age: "2024-05-01" });
		assert.deepEqual(results[1], { title: "Second Page", url: "https://two.example/b", snippet: "Full text body here.", age: undefined });
	});
	it("ignores blocks without an http(s) URL", () => {
		assert.deepEqual(parseExaText("Title: X\nURL: ftp://nope\n"), []);
	});
});

describe("Brave / SearXNG parsers", () => {
	it("maps Brave web and news results", () => {
		const results = parseBraveResponse({
			web: { results: [{ title: "T <b>1</b>", url: "https://a.example/", description: "D &amp; 1", age: "2 days ago" }, { title: "no url" }] },
			news: { results: [{ title: "N", url: "https://n.example/", description: "nd", age: "1 hour ago" }] },
		});
		assert.deepEqual(results, [
			{ title: "T 1", url: "https://a.example/", snippet: "D & 1", age: "2 days ago" },
			{ title: "N", url: "https://n.example/", snippet: "nd", age: "1 hour ago" },
		]);
	});
	it("maps SearXNG results", () => {
		const results = parseSearxngResponse({ results: [{ title: "S", url: "https://s.example/", content: "c", publishedDate: "2024-01-02T03:04:05", engine: "google" }] });
		assert.deepEqual(results, [{ title: "S", url: "https://s.example/", snippet: "c", age: "2024-01-02" }]);
	});
});

describe("routing", () => {
	it("auto chain never enables billable fallback from key presence alone", () => {
		assert.deepEqual(resolveProviderChain(undefined, config()), ["duckduckgo", "exa"]);
		assert.deepEqual(resolveProviderChain(undefined, config({ privacyProfile: "private", searxngUrl: "https://search.example" })), ["searxng"]);
		assert.deepEqual(resolveProviderChain(undefined, config({ braveApiKey: "k" })), ["duckduckgo", "exa"]);
		assert.deepEqual(resolveProviderChain(undefined, config({ braveApiKey: "k", searxngUrl: "http://sx" })), ["searxng", "duckduckgo", "exa"]);
		assert.deepEqual(resolveProviderChain("exa", config()), ["exa"]);
		assert.deepEqual(resolveProviderChain(undefined, config({ provider: "brave" })), ["brave"]);
	});
	it("filters unconfigured fallback providers after an explicit provider", () => {
		assert.deepEqual(resolveProviderChain("exa", config({ searxngUrl: undefined })), ["exa"]);
		assert.deepEqual(resolveProviderChain("exa", config({ searxngUrl: "https://search.example" })), ["exa"]);
	});
	it("reports configuration state per provider", () => {
		assert.equal(isProviderConfigured("brave", config()), false);
		assert.equal(isProviderConfigured("brave", config({ braveApiKey: "k" })), true);
		assert.equal(isProviderConfigured("searxng", config()), false);
		assert.equal(isProviderConfigured("tavily", config()), false);
		assert.equal(isProviderConfigured("tavily", config({ tavilyApiKey: "k" })), true);
		assert.equal(isProviderConfigured("duckduckgo", config()), true);
		assert.equal(isProviderConfigured("exa", config()), true);
	});
});

const CAPABILITIES = {
	recency: true,
	domains: true,
	language: false,
	country: false,
	category: false,
	chunks: false,
} as const;

function adapter(id: "duckduckgo" | "exa" | "brave" | "searxng" | "tavily", run: SearchProviderAdapter["search"]): SearchProviderAdapter {
	return { id, capabilities: CAPABILITIES, search: run };
}

describe("search policy, cache and result identity", () => {
	it("preserves path and query case while deduplicating canonical URL equivalents", () => {
		const finalized = finalizeResults([
			{ title: "upper", url: "HTTPS://Example.COM:443/Docs/Case?Q=A#one", snippet: "" },
			{ title: "duplicate", url: "https://example.com/Docs/Case?Q=A#two", snippet: "" },
			{ title: "lower", url: "https://example.com/docs/case?q=a", snippet: "" },
		], { numResults: 10 });
		assert.deepEqual(finalized.results.map((result) => result.title), ["upper", "lower"]);
	});

	it("caches by query, filters, provider and policy while exposing cache age and lookup latency", async () => {
		clearSearchCache();
		let calls = 0;
		let now = 1_000;
		const mock = adapter("duckduckgo", async () => {
			calls += 1;
			now += 25;
			return { results: [{ title: "A", url: "https://a.example/", snippet: "one" }], rawCount: 1, appliedControls: ["domains"], unsupportedControls: [], notices: [] };
		});
		const deps = { providers: { duckduckgo: mock }, now: () => now };
		const first = await search("same", { numResults: 5, domains: ["a.example"] }, config({ searchCacheTtlMs: 10_000 }), "duckduckgo", deps);
		now = 1_750;
		const second = await search("same", { numResults: 5, domains: ["a.example"] }, config({ searchCacheTtlMs: 10_000 }), "duckduckgo", deps);
		assert.equal(first.cached, false);
		assert.equal(first.durationMs, 25);
		assert.equal(second.cached, true);
		assert.equal(second.cacheAgeMs, 725);
		assert.equal(second.durationMs, 0);
		assert.equal(calls, 1);
		assert.equal(searchCacheStats().entries, 1);
		await search("same", { numResults: 5, domains: ["b.example"] }, config({ searchCacheTtlMs: 10_000 }), "duckduckgo", deps);
		assert.equal(calls, 2);
	});

	it("expires cache entries by TTL and evicts the least recently used entry", async () => {
		clearSearchCache();
		let calls = 0;
		let now = 10_000;
		const mock = adapter("duckduckgo", async (request) => {
			calls += 1;
			return { results: [{ title: request.query, url: `https://${request.query}.example/`, snippet: "" }], rawCount: 1, appliedControls: [], unsupportedControls: [], notices: [] };
		});
		const cfg = config({ searchCacheTtlMs: 1_000, searchCacheMaxEntries: 2 });
		const deps = { providers: { duckduckgo: mock }, now: () => now };
		await search("one", { numResults: 1 }, cfg, "duckduckgo", deps);
		await search("two", { numResults: 1 }, cfg, "duckduckgo", deps);
		await search("one", { numResults: 1 }, cfg, "duckduckgo", deps);
		await search("three", { numResults: 1 }, cfg, "duckduckgo", deps);
		await search("two", { numResults: 1 }, cfg, "duckduckgo", deps);
		assert.equal(calls, 4, "two was evicted after one was refreshed");
		now += 1_000;
		await search("one", { numResults: 1 }, cfg, "duckduckgo", deps);
		assert.equal(calls, 5, "one expired at the TTL boundary");
	});

	it("searches under a private ceiling with the default auto profile", async () => {
		clearSearchCache();
		let calls = 0;
		const searxng = adapter("searxng", async () => {
			calls += 1;
			return { results: [{ title: "Private", url: "https://private.example/", snippet: "" }], rawCount: 1, appliedControls: [], unsupportedControls: [], notices: [] };
		});
		const cfg = config({ privacyProfile: "private", allowedProviders: ["searxng"], searxngUrl: "https://search.example" });
		const response = await search("private", { numResults: 1 }, cfg, undefined, { providers: { searxng } });
		assert.equal(response.provider, "searxng");
		assert.equal(calls, 1);
		await assert.rejects(() => search("widen", { numResults: 1, profile: "deep" }, cfg, undefined, { providers: { searxng } }), /POLICY_BLOCKED/);
		assert.equal(calls, 1);
	});

	it("fails strict controls before dispatch when the selected provider cannot apply them", async () => {
		let calls = 0;
		const mock = adapter("duckduckgo", async () => {
			calls += 1;
			return { results: [], rawCount: 0, appliedControls: [], unsupportedControls: [], notices: [] };
		});
		await assert.rejects(
			() => search("strict", { numResults: 5, language: "fr", strictFilters: true }, config(), "duckduckgo", { providers: { duckduckgo: mock } }),
			/language.*not supported/i,
		);
		assert.equal(calls, 0);
	});

	it("fails strict controls when an adapter reports a request-specific unsupported control", async () => {
		const mock = adapter("exa", async () => ({
			results: [],
			rawCount: 0,
			appliedControls: [],
			unsupportedControls: ["category"],
			notices: [],
		}));
		await assert.rejects(
			() => search("strict", { numResults: 5, category: "research", strictFilters: true }, config(), "exa", { providers: { exa: mock } }),
			/category.*not supported/i,
		);
	});

	it("honors bounded Retry-After cooldowns across calls", async () => {
		clearSearchCache();
		let calls = 0;
		let now = 10_000;
		const mock = adapter("brave", async () => {
			calls += 1;
			throw new ProviderHttpError("brave", 429, "rate limited", Number.MAX_SAFE_INTEGER);
		});
		const cfg = config({ braveApiKey: "key" });
		await assert.rejects(() => search("cooldown", { numResults: 5, fallback: false }, cfg, "brave", { providers: { brave: mock }, now: () => now }), /rate limited/i);
		now += 1_000;
		await assert.rejects(() => search("cooldown", { numResults: 5, fallback: false }, cfg, "brave", { providers: { brave: mock }, now: () => now }), /cooldown/i);
		now += 10 * 60_000;
		await assert.rejects(() => search("cooldown", { numResults: 5, fallback: false }, cfg, "brave", { providers: { brave: mock }, now: () => now }), /rate limited/i);
		assert.equal(calls, 2);
	});
});
