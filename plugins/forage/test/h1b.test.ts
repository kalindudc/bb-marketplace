import { fixtureRuntime } from "./runtime-helper.ts";
import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { formatSearchText, renderFetchedPage, type SearchDetails, type SearchQueryDetail } from "../src/format.ts";
import { collectGithubCollection, formatGithubIssueDocument, type GithubIssue } from "../src/web/github.ts";
import { CONFIG_DEFAULTS, type WebConfig } from "../src/web/config.ts";
import { createDeadline } from "../src/web/deadline.ts";
import { cacheClear, fetchContent, type FetchedContent, resolveFetchTarget, sliceContent } from "../src/web/fetch.ts";
import { registerTools, selectContentTargets } from "../src/tools.ts";
import { type TestServer, startServer } from "./_server.ts";

function config(overrides: Partial<WebConfig> = {}): WebConfig {
	return { ...CONFIG_DEFAULTS, allowPrivateNetwork: true, warnings: [], ...overrides };
}

type StructuredToolResult = Exclude<PluginAgentToolResult, string>;

function structuredResult(result: PluginAgentToolResult): StructuredToolResult {
	assert.notEqual(typeof result, "string");
	return result as StructuredToolResult;
}

function toolText(result: PluginAgentToolResult): string {
	return structuredResult(result).content
		.filter((part): part is Extract<StructuredToolResult["content"][number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function fetched(content: string, title = "Document"): FetchedContent {
	return {
		url: "https://example.com/document",
		finalUrl: "https://example.com/document",
		title,
		content,
		kind: "text",
		contentType: "text/plain",
		status: 200,
		bytes: Buffer.byteLength(content),
		durationMs: 10,
		redirects: 0,
		cached: false,
		contentHash: "a".repeat(64),
	};
}

describe("H1B resolution and GitHub completeness", () => {
	it("keeps raw auto resolution direct while allowing explicit smart resolution", () => {
		const url = "https://github.com/acme/widgets/pull/42";
		assert.deepEqual(resolveFetchTarget(url, "raw", "auto"), { target: url, rewrite: undefined, resolution: "direct" });
		assert.equal(resolveFetchTarget(url, "readable", "auto").target, "https://api.github.com/repos/acme/widgets/pulls/42");
		assert.equal(resolveFetchTarget(url, "raw", "smart").target, "https://api.github.com/repos/acme/widgets/pulls/42");
		assert.deepEqual(resolveFetchTarget(url, "readable", "direct"), { target: url, rewrite: undefined, resolution: "direct" });
	});

	it("paginates a collection under one deadline and reports a max-page partial", async () => {
		const deadline = createDeadline(1_000);
		const requested: number[] = [];
		try {
			const result = await collectGithubCollection({
				name: "comments",
				expected: 1_500,
				deadline,
				loadPage: async (page) => {
					requested.push(page);
					return { items: Array.from({ length: 100 }, (_, index) => ({ id: (page - 1) * 100 + index })), hasNext: true, acceptedBytes: 10 };
				},
			});
			assert.equal(result.items.length, 1_000);
			assert.deepEqual(requested, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
			assert.equal(result.part.state, "partial");
			assert.match(result.part.reason ?? "", /10-page|1,000-item/i);
			assert.equal(result.acceptedBytes, 100);
		} finally {
			deadline.dispose();
		}
	});

	it("surfaces a failed later collection page as partial while preserving fetched items", async () => {
		const deadline = createDeadline(1_000);
		try {
			const result = await collectGithubCollection({
				name: "reviews",
				deadline,
				loadPage: async (page) => {
					if (page === 2) throw new Error("HTTP 502 on page 2");
					return { items: [{ id: 1 }], hasNext: true, acceptedBytes: 25 };
				},
			});
			assert.deepEqual(result.items, [{ id: 1 }]);
			assert.equal(result.part.state, "partial");
			assert.equal(result.part.reason, "HTTP 502 on page 2");
			assert.match(result.warnings[0]?.message ?? "", /reviews partial/);
		} finally {
			deadline.dispose();
		}
	});

	it("formats issue comments, reviews and inline review comments with explicit partial warnings", () => {
		const issue: GithubIssue = {
			number: 7,
			title: "Keep every review",
			state: "open",
			html_url: "https://github.com/acme/widgets/pull/7",
			created_at: "2026-01-01T00:00:00Z",
			body: "Description",
			comments: 2,
			pull_request: {},
		};
		const formatted = formatGithubIssueDocument({
			issue,
			meta: { owner: "acme", repo: "widgets", number: "7", type: "pull" },
			comments: [{ user: { login: "commenter" }, created_at: "2026-01-02T00:00:00Z", body: "Issue comment" }],
			reviews: [{ user: { login: "reviewer" }, submitted_at: "2026-01-03T00:00:00Z", state: "CHANGES_REQUESTED", body: "Review summary" }],
			reviewComments: [{ user: { login: "inline" }, created_at: "2026-01-04T00:00:00Z", body: "Inline note", path: "src/a.ts", line: 12 }],
			warnings: ["comments partial: HTTP 502 on page 2"],
		});
		assert.match(formatted.content, /Issue comment/);
		assert.match(formatted.content, /Review summary/);
		assert.match(formatted.content, /Inline note/);
		assert.match(formatted.content, /comments partial: HTTP 502 on page 2/);
	});
});

describe("H1B rendering and paging", () => {
	it("fits metadata and body before output, advertises a hash-bound cursor, and leaves no gap", async () => {
		const content = Array.from({ length: 2_000 }, (_, index) => `row-${String(index).padStart(4, "0")}`).join("\n");
		const page = fetched(content, "T".repeat(12_000));
		const first = await renderFetchedPage(page, { offset: 0, maxChars: 100_000, maxOutputChars: 2_500, showTitle: true });
		assert.ok(first.text.length <= 2_500, `first page used ${first.text.length} characters`);
		assert.match(first.text, new RegExp(`Continue with offset=${first.detail.offset + first.detail.shown} and contentHash=${page.contentHash}`));
		assert.ok(first.detail.shown > 0);
		assert.ok(first.text.endsWith(content.slice(0, first.detail.shown)));

		const second = await renderFetchedPage(page, {
			offset: first.detail.offset + first.detail.shown,
			maxChars: 100_000,
			maxOutputChars: 2_500,
			showTitle: true,
		});
		assert.ok(second.text.length <= 2_500, `second page used ${second.text.length} characters`);
		assert.ok(second.text.endsWith(content.slice(second.detail.offset, second.detail.offset + second.detail.shown)));
		assert.equal(content.slice(0, first.detail.shown) + content.slice(second.detail.offset, second.detail.offset + second.detail.shown), content.slice(0, second.detail.offset + second.detail.shown));
	});

	it("never splits a UTF-16 surrogate pair at either paging boundary", () => {
		const content = `ab😀cd😀ef`;
		const first = sliceContent(content, 0, 3);
		assert.equal(first.text, "ab");
		const second = sliceContent(content, first.end, 4);
		assert.equal(first.text + second.text, content.slice(0, second.end));
		assert.doesNotMatch(first.text, /[\uD800-\uDBFF]$/);
		assert.doesNotMatch(second.text, /^[\uDC00-\uDFFF]/);
	});
});

describe.sequential("H1B existing tool boundary", () => {
	let server: TestServer;
	beforeAll(async () => {
		server = await startServer({
			"/compact.json": (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"exact":true}\r\n'); },
			"/page.html": (_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end('<!doctype html><html lang="en"><head><title>JSON encoder</title><link rel="canonical" href="https://docs.example/json"></head><body><main><h1>json</h1><h2>Basic usage</h2><p>Encode and decode JSON with the standard library, in a paragraph long enough to count as readable text for the extractor.</p></main></body></html>'); },
			"/long": (_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(`# ${"L".repeat(10_000)}\n\n${"body line\n".repeat(8_000)}`); },
			"/a": (_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(`# ${"A".repeat(8_000)}\n\nalpha`); },
			"/b": (_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(`# ${"B".repeat(8_000)}\n\nbeta`); },
		});
	});
	afterAll(async () => server.close());

	function host() {
		const fake = createFakePluginHost({ pluginId: "forage", experimental_declaredIconNames: ["search", "fetch", "map", "extract", "crawl", "diff"] });
		registerTools(fake.bb, fixtureRuntime(fake.bb, async () => config({ timeoutMs: 1_000, concurrency: 2 })));
		return fake;
	}

	it("returns exact textual bytes in raw auto mode", async () => {
		cacheClear();
		const result = await fetchContent(`${server.url}/compact.json`, { mode: "raw", resolve: "auto", config: config(), noCache: true });
		assert.equal(result.content, '{"exact":true}\r\n');
		assert.equal(result.artifact?.transport, "direct");
	});

	it("reads structured fields from raw HTML as readable mode does", async () => {
		cacheClear();
		for (const mode of ["raw", "readable"] as const) {
			const result = await fetchContent(`${server.url}/page.html`, { mode, resolve: "auto", config: config(), noCache: true });
			assert.equal(result.kind, "html", mode);
			assert.equal(result.artifact?.structured?.title, "JSON encoder", mode);
			assert.equal(result.artifact?.structured?.canonicalUrl, "https://docs.example/json", mode);
			assert.deepEqual(result.artifact?.structured?.headings.map((heading) => heading.text), ["json", "Basic usage"], mode);
		}
		const raw = await fetchContent(`${server.url}/page.html`, { mode: "raw", resolve: "auto", config: config(), noCache: true });
		assert.match(raw.content, /^<!doctype html>/u);
		assert.equal(raw.title, "JSON encoder");
	});

	it("rejects oversized combined query and URL inputs instead of silently truncating them", async () => {
		const fake = host();
		const search = await fake.harness.callAgentTool("web_search", { query: "extra", queries: Array.from({ length: 8 }, (_, index) => `q${index}`) });
		assert.equal(structuredResult(search).isError, true);
		assert.match(toolText(search), /at most 8/i);

		const fetch = await fake.harness.callAgentTool("web_fetch", { url: `${server.url}/a`, urls: Array.from({ length: 10 }, (_, index) => `${server.url}/item-${index}`) });
		assert.equal(structuredResult(fetch).isError, true);
		assert.match(toolText(fetch), /at most 10/i);
	});

	it("keeps every batch outcome visible and stays inside the host output limit", async () => {
		cacheClear();
		const fake = host();
		const result = await fake.harness.callAgentTool("web_fetch", { urls: [`${server.url}/a`, `${server.url}/missing`, `${server.url}/b`], maxChars: 200_000, refresh: true });
		const text = toolText(result);
		assert.equal(structuredResult(result).isError, undefined);
		assert.ok(text.length <= 32_000, `tool output used ${text.length} characters`);
		assert.match(text, /Fetched 2\/3 URLs/);
		assert.match(text, new RegExp(`${server.url}/a`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(text, new RegExp(`${server.url}/missing`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(text, new RegExp(`${server.url}/b`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.doesNotMatch(text, /\[Output truncated at/);
	});

	it("binds continuation to the fetched content hash and rejects stale hashes", async () => {
		cacheClear();
		const fake = host();
		const first = await fake.harness.callAgentTool("web_fetch", { url: `${server.url}/long`, maxChars: 200_000, refresh: true });
		const firstText = toolText(first);
		const cursor = /Continue with offset=(\d+) and contentHash=([0-9a-f]{64})/.exec(firstText);
		assert.ok(cursor, firstText.slice(-500));
		const stale = await fake.harness.callAgentTool("web_fetch", { url: `${server.url}/long`, offset: Number(cursor[1]), contentHash: "0".repeat(64) });
		assert.equal(structuredResult(stale).isError, true);
		assert.match(toolText(stale), /STALE_CONTENT|content hash/i);
	});

	it("preserves all eight query outcomes when result details exceed the output budget", () => {
		const queries: SearchQueryDetail[] = Array.from({ length: 8 }, (_, queryIndex) => ({
			query: `query-${queryIndex}`,
			provider: "fixture",
			results: Array.from({ length: 20 }, (_, resultIndex) => ({
				title: `result-${queryIndex}-${resultIndex}-${"x".repeat(200)}`,
				url: `https://host-${queryIndex}.example/path/${resultIndex}`,
				snippet: "s".repeat(500),
			})),
			rawCount: 20,
			durationMs: 1,
			attempts: [],
		}));
		const details: SearchDetails = { queries, totalResults: 160, durationMs: 10 };
		const text = formatSearchText(details, "fixture");
		assert.ok(text.length <= 32_000);
		for (let index = 0; index < 8; index++) assert.match(text, new RegExp(`${index + 1}\\. \\"query-${index}\\"`));
		assert.match(text, /result details omitted by the output budget/);
	});

	it("selects include-content targets round-robin with host diversity", () => {
		const outcome = (query: string, urls: string[]): SearchQueryDetail => ({
			query,
			provider: "fixture",
			results: urls.map((url, index) => ({ title: `${query}-${index}`, url, snippet: "" })),
			rawCount: urls.length,
			durationMs: 1,
			attempts: [],
		});
		const selected = selectContentTargets([
			outcome("q1", ["https://a.example/one", "https://c.example/one"]),
			outcome("q2", ["https://a.example/two", "https://b.example/two"]),
		], 3);
		assert.deepEqual(selected.map((target) => target.url), ["https://a.example/one", "https://b.example/two", "https://c.example/one"]);
	});
});
