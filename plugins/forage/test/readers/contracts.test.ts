import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { CONFIG_DEFAULTS, type WebConfig } from "../../src/web/config.ts";
import type { OperationContext } from "../../src/web/contracts.ts";
import { createDeadline } from "../../src/web/deadline.ts";
import type { ProviderTransport } from "../../src/web/providers/http.ts";
import { firecrawlReader, parseFirecrawlReaderResponse } from "../../src/web/readers/firecrawl.ts";
import { jinaReader, parseJinaReaderResponse } from "../../src/web/readers/jina.ts";
import { assertRemoteForwardableUrl, RemoteForwardingError } from "../../src/web/readers/policy.ts";
import { tavilyReader, parseTavilyReaderResponse } from "../../src/web/readers/tavily.ts";

function config(overrides: Partial<WebConfig> = {}): WebConfig {
	return { ...CONFIG_DEFAULTS, warnings: [], ...overrides };
}

function context(): OperationContext {
	return { deadline: createDeadline(1_000) };
}

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 as const }];

describe("remote reader forwarding policy", () => {
	it("rejects userinfo and exact sensitive query names before DNS", async () => {
		await assert.rejects(() => assertRemoteForwardableUrl("https://user:pass@example.com/page"), RemoteForwardingError);
		await assert.rejects(() => assertRemoteForwardableUrl("https://example.com/page?Access_Token=secret"), RemoteForwardingError);
		await assert.rejects(() => assertRemoteForwardableUrl("https://example.com/page?code=benign"), RemoteForwardingError);
	});

	it("strips URL fragments before remote forwarding", async () => {
		const url = await assertRemoteForwardableUrl("https://public.example/Case?Q=A#access_token=secret", { resolver: publicResolver });
		assert.equal(url.href, "https://public.example/Case?Q=A");
	});

	it("rejects private, loopback, link-local and local-suffix targets even when direct fetch policy is permissive", async () => {
		for (const url of ["http://127.0.0.1/", "http://169.254.169.254/", "http://service.internal/", "http://host.local/"]) {
			await assert.rejects(() => assertRemoteForwardableUrl(url), RemoteForwardingError, url);
		}
	});

	it("requires every DNS answer to be public", async () => {
		await assert.rejects(
			() => assertRemoteForwardableUrl("https://public.example/page", { resolver: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }] }),
			RemoteForwardingError,
		);
		await assert.doesNotReject(
			() => assertRemoteForwardableUrl("https://public.example/Case?Q=A", { resolver: publicResolver }),
		);
	});
});

describe("remote reader request boundaries", () => {
	it("performs pre-send and final-URL checks around Firecrawl", async () => {
		let calls = 0;
		let sentUrl = "";
		const transport: ProviderTransport = async (url, options) => {
			calls += 1;
			sentUrl = JSON.parse(options.body!).url as string;
			return {
				response: new Response(JSON.stringify({ success: true, data: { markdown: "# Firecrawl", metadata: { title: "Firecrawl", statusCode: 200, url: "https://final.example/page" } } }), { headers: { "content-type": "application/json" } }),
				finalUrl: url,
				redirects: 0,
				access: { network: "public", credentialed: true, requestScopeKey: null },
				acceptedRedirectBytes: 0,
			};
		};
		const ctx = context();
		const result = await firecrawlReader.read({
			url: "https://public.example/page#access_token=secret",
			context: ctx,
			config: config({ firecrawlApiKey: "key" }),
			resolver: publicResolver,
			transport,
		});
		assert.equal(result.finalUrl, "https://final.example/page");
		assert.equal(sentUrl, "https://public.example/page");
		assert.equal(calls, 1);
		ctx.deadline.dispose();

		const blockedContext = context();
		await assert.rejects(() => firecrawlReader.read({
			url: "http://127.0.0.1/private",
			context: blockedContext,
			config: config({ firecrawlApiKey: "key" }),
			resolver: publicResolver,
			transport,
		}), RemoteForwardingError);
		assert.equal(calls, 1);
		blockedContext.deadline.dispose();
	});

	it("rejects private final URLs returned by remote readers", async () => {
		const transport: ProviderTransport = async (url) => ({
			response: new Response(JSON.stringify({ results: [{ url: "http://127.0.0.1/private", raw_content: "secret" }], failed_results: [] }), { headers: { "content-type": "application/json" } }),
			finalUrl: url,
			redirects: 0,
			access: { network: "public", credentialed: true, requestScopeKey: null },
			acceptedRedirectBytes: 0,
		});
		const ctx = context();
		await assert.rejects(() => tavilyReader.read({
			url: "https://public.example/page",
			context: ctx,
			config: config({ tavilyApiKey: "key" }),
			resolver: publicResolver,
			transport,
		}), RemoteForwardingError);
		ctx.deadline.dispose();
	});

	it("sends a fragment-free target through Jina", async () => {
		let requested = "";
		const transport: ProviderTransport = async (url) => {
			requested = url;
			return {
				response: new Response(JSON.stringify({ code: 200, data: { title: "Jina", url: "https://public.example/page", content: "# Jina" } }), { headers: { "content-type": "application/json" } }),
				finalUrl: url,
				redirects: 0,
				access: { network: "public", credentialed: false, requestScopeKey: null },
				acceptedRedirectBytes: 0,
			};
		};
		const ctx = context();
		await jinaReader.read({ url: "https://public.example/page#token=secret", context: ctx, config: config(), resolver: publicResolver, transport });
		assert.equal(requested, "https://r.jina.ai/https://public.example/page");
		ctx.deadline.dispose();
	});
});

describe("remote reader response contracts", () => {
	it("parses Jina JSON reader output", () => {
		assert.deepEqual(parseJinaReaderResponse({ code: 200, data: { title: "Jina", url: "https://example.com/final", content: "# Jina" } }), {
			content: "# Jina",
			title: "Jina",
			finalUrl: "https://example.com/final",
			statusCode: 200,
		});
	});

	it("parses Tavily and Firecrawl reader output", () => {
		assert.deepEqual(parseTavilyReaderResponse({ results: [{ url: "https://example.com/final", raw_content: "# Tavily" }], failed_results: [] }, "https://example.com/start"), {
			content: "# Tavily",
			title: "",
			finalUrl: "https://example.com/final",
			statusCode: 200,
		});
		assert.deepEqual(parseFirecrawlReaderResponse({ success: true, data: { markdown: "# Firecrawl", metadata: { title: "Firecrawl", statusCode: 200, url: "https://example.com/final" } } }), {
			content: "# Firecrawl",
			title: "Firecrawl",
			finalUrl: "https://example.com/final",
			statusCode: 200,
		});
	});
});
