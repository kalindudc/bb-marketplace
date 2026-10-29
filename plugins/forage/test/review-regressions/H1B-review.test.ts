import { fixtureRuntime } from "../runtime-helper.ts";
import assert from "node:assert/strict";
import { afterAll, beforeAll, beforeEach, describe, it, vi } from "vitest";
import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { CONFIG_DEFAULTS, type WebConfig } from "../../src/web/config.ts";
import { type TestServer, startServer } from "../_server.ts";

const fixture = vi.hoisted(() => ({
	calls: [] as Array<{ url: string; headers: Record<string, string>; credentialed: boolean }>,
	mode: "complete" as "complete" | "transient" | "cancel" | "deadline",
	acceptedBytes: 0,
	searchBase: "",
}));

vi.mock("../../src/web/net.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/web/net.ts")>();
	return {
		...actual,
		safeFetch: async (url: string, options: Parameters<typeof actual.safeFetch>[1]) => {
			const parsed = new URL(url);
			if (parsed.hostname !== "api.github.com" && parsed.hostname !== "github.com") return actual.safeFetch(url, options);
			fixture.calls.push({ url, headers: { ...options.headers }, credentialed: options.credentialed === true });
			const response = (payload: unknown, status = 200, headers: Record<string, string> = {}) => {
				const body = typeof payload === "string" ? payload : JSON.stringify(payload);
				fixture.acceptedBytes += Buffer.byteLength(body);
				return {
					response: new Response(body, { status, headers }),
					finalUrl: url,
					redirects: 0,
					access: { network: "public" as const, credentialed: options.credentialed === true, requestScopeKey: options.requestScopeKey ?? null },
					acceptedRedirectBytes: 0,
				};
			};
			if (parsed.hostname === "github.com") {
				return response("<!doctype html><html><body>direct github page</body></html>", 200, { "content-type": "text/html" });
			}
			const page = Number(parsed.searchParams.get("page") ?? "1");
			if (parsed.pathname === "/repos/o/r/pulls/5") {
				return response({
					number: 5,
					title: "Complete pull request",
					state: "open",
					html_url: "https://github.com/o/r/pull/5",
					created_at: "2026-01-01T00:00:00Z",
					body: "Pull request body",
					comments: 150,
					review_comments: 2,
				});
			}
			if (parsed.pathname === "/repos/o/r/issues/6") {
				return response({
					number: 6,
					title: "Complete issue",
					state: "open",
					html_url: "https://github.com/o/r/issues/6",
					created_at: "2026-01-01T00:00:00Z",
					body: "Issue body",
					comments: 1,
				});
			}
			if (parsed.pathname === "/repos/o/r/issues/5/comments") {
				if (page === 2 && fixture.mode === "transient") return response({ message: "temporary failure" }, 502);
				if (page === 2 && (fixture.mode === "cancel" || fixture.mode === "deadline")) {
					await new Promise<never>((_resolve, reject) => {
						const rejectCancelled = () => reject(new actual.NetError("Request cancelled", "aborted"));
						if (options.signal?.aborted) rejectCancelled();
						else options.signal?.addEventListener("abort", rejectCancelled, { once: true });
					});
				}
				const count = page === 1 ? 100 : 50;
				return response(
					Array.from({ length: count }, (_, index) => ({ user: { login: "commenter" }, created_at: "2026-01-02T00:00:00Z", body: `comment-${page}-${index}` })),
					200,
					page === 1 ? { link: "<https://api.github.com/next>; rel=\"next\"" } : {},
				);
			}
			if (parsed.pathname === "/repos/o/r/issues/6/comments") {
				return response([{ user: { login: "issue-commenter" }, created_at: "2026-01-02T00:00:00Z", body: "issue comment" }]);
			}
			if (parsed.pathname === "/repos/o/r/pulls/5/reviews") {
				return response([{ user: { login: "reviewer" }, submitted_at: "2026-01-03T00:00:00Z", state: "APPROVED", body: "review body" }]);
			}
			if (parsed.pathname === "/repos/o/r/pulls/5/comments") {
				return response([
					{ user: { login: "inline" }, created_at: "2026-01-04T00:00:00Z", body: "inline one", path: "src/a.ts", line: 3 },
					{ user: { login: "inline" }, created_at: "2026-01-04T00:00:00Z", body: "inline two", path: "src/b.ts", line: 4 },
				]);
			}
			return response({ message: "not found" }, 404);
		},
	};
});

vi.mock("../../src/web/search.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/web/search.ts")>();
	return {
		...actual,
		search: async (query: string) => ({
			provider: "fixture",
			rawCount: 2,
			durationMs: 1,
			attempts: [],
			results: [0, 1].map((index) => ({
				title: `${query} result ${index}`,
				url: `${fixture.searchBase}/search-${encodeURIComponent(query)}-${index}`,
				snippet: `${query} snippet ${index}`,
			})),
		}),
	};
});

const { cacheClear, fetchContent } = await import("../../src/web/fetch.ts");
const { registerTools } = await import("../../src/tools.ts");

function config(overrides: Partial<WebConfig> = {}): WebConfig {
	return { ...CONFIG_DEFAULTS, allowPrivateNetwork: true, warnings: [], timeoutMs: 1_000, concurrency: 2, ...overrides };
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

function host(overrides: Partial<WebConfig> = {}) {
	const fake = createFakePluginHost({ pluginId: "forage", experimental_declaredIconNames: ["search", "fetch", "map", "extract", "crawl", "diff"] });
	registerTools(fake.bb, fixtureRuntime(fake.bb, async () => config(overrides)));
	return fake;
}

function resetFixture(mode: typeof fixture.mode = "complete"): void {
	cacheClear();
	fixture.calls.length = 0;
	fixture.acceptedBytes = 0;
	fixture.mode = mode;
}

describe.sequential("H1B review regressions: GitHub fetch integration", () => {
	beforeEach(() => resetFixture());

	it("collects every pull-request collection through fetchContent with truthful counts and bytes", async () => {
		const result = await fetchContent("https://github.com/o/r/pull/5", {
			mode: "readable",
			resolve: "smart",
			config: config(),
			requestScopeKey: "thread:test",
			noCache: true,
		});

		assert.equal(result.error, undefined);
		assert.equal(result.completeness?.state, "complete");
		assert.deepEqual(result.completeness?.parts, [
			{ name: "issue", state: "complete", fetched: 1, expected: 1 },
			{ name: "comments", state: "complete", fetched: 150, expected: 150 },
			{ name: "reviews", state: "complete", fetched: 1 },
			{ name: "review-comments", state: "complete", fetched: 2, expected: 2 },
		]);
		assert.equal(result.bytes, fixture.acceptedBytes);
		assert.equal(result.acceptedBytes, fixture.acceptedBytes);
		assert.equal(result.artifact?.bytes, fixture.acceptedBytes);
		assert.equal(result.artifact?.completeness.state, "complete");
		assert.match(result.content, /comment-2-49/);
		assert.match(result.content, /review body/);
		assert.match(result.content, /inline two/);
		assert.deepEqual(fixture.calls.map((call) => call.url), [
			"https://api.github.com/repos/o/r/pulls/5",
			"https://api.github.com/repos/o/r/issues/5/comments?per_page=100&page=1",
			"https://api.github.com/repos/o/r/issues/5/comments?per_page=100&page=2",
			"https://api.github.com/repos/o/r/pulls/5/reviews?per_page=100&page=1",
			"https://api.github.com/repos/o/r/pulls/5/comments?per_page=100&page=1",
		]);
	});

	it("uses the issue endpoint and omits pull-only collections for issue URLs", async () => {
		const result = await fetchContent("https://github.com/o/r/issues/6", {
			mode: "readable",
			resolve: "smart",
			config: config(),
			requestScopeKey: "thread:test",
			noCache: true,
		});

		assert.equal(result.completeness?.state, "complete");
		assert.deepEqual(result.completeness?.parts, [
			{ name: "issue", state: "complete", fetched: 1, expected: 1 },
			{ name: "comments", state: "complete", fetched: 1, expected: 1 },
		]);
		assert.deepEqual(fixture.calls.map((call) => call.url), [
			"https://api.github.com/repos/o/r/issues/6",
			"https://api.github.com/repos/o/r/issues/6/comments?per_page=100&page=1",
		]);
		assert.doesNotMatch(result.content, /## Reviews|## Inline review comments/);
	});

	it("propagates cancellation and does not leave a partial GitHub cache entry", async () => {
		resetFixture("cancel");
		const controller = new AbortController();
		const firstPromise = fetchContent("https://github.com/o/r/pull/5", {
			mode: "readable",
			resolve: "smart",
			config: config(),
			requestScopeKey: "thread:cancel",
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(new Error("cancel test fetch")), 20);
		const first = await firstPromise;
		assert.equal(first.errorCode, "aborted");
		assert.match(first.error ?? "", /cancel/i);
		await new Promise((resolve) => setTimeout(resolve, 50));

		fixture.mode = "complete";
		const callsBeforeRetry = fixture.calls.length;
		const retry = await fetchContent("https://github.com/o/r/pull/5", {
			mode: "readable",
			resolve: "smart",
			config: config(),
			requestScopeKey: "thread:cancel",
		});
		assert.equal(retry.cached, false);
		assert.equal(retry.completeness?.state, "complete");
		assert.ok(fixture.calls.length > callsBeforeRetry);
	});

	it("propagates deadline expiry and does not cache the interrupted collection", async () => {
		resetFixture("deadline");
		const first = await fetchContent("https://github.com/o/r/pull/5", {
			mode: "readable",
			resolve: "smart",
			config: config({ timeoutMs: 30 }),
			requestScopeKey: "thread:deadline",
		});
		assert.equal(first.errorCode, "timeout");
		assert.match(first.error ?? "", /timed out/i);
		await new Promise((resolve) => setTimeout(resolve, 50));

		fixture.mode = "complete";
		const callsBeforeRetry = fixture.calls.length;
		const retry = await fetchContent("https://github.com/o/r/pull/5", {
			mode: "readable",
			resolve: "smart",
			config: config(),
			requestScopeKey: "thread:deadline",
		});
		assert.equal(retry.cached, false);
		assert.equal(retry.completeness?.state, "complete");
		assert.ok(fixture.calls.length > callsBeforeRetry);
	});

	it("returns a transient collection gap as partial but never caches it", async () => {
		resetFixture("transient");
		const partial = await fetchContent("https://github.com/o/r/pull/5", {
			mode: "readable",
			resolve: "smart",
			config: config(),
			requestScopeKey: "thread:transient",
		});
		assert.equal(partial.completeness?.state, "partial");
		assert.match(partial.warning ?? "", /comments partial: HTTP 502 on page 2/);

		fixture.mode = "complete";
		const callsBeforeRetry = fixture.calls.length;
		const retry = await fetchContent("https://github.com/o/r/pull/5", {
			mode: "readable",
			resolve: "smart",
			config: config(),
			requestScopeKey: "thread:transient",
		});
		assert.equal(retry.cached, false);
		assert.equal(retry.completeness?.state, "complete");
		assert.ok(fixture.calls.length > callsBeforeRetry);
	});
});

describe.sequential("H1B review regressions: SDK tool boundary", () => {
	let server: TestServer;

	beforeAll(async () => {
		const routes: Parameters<typeof startServer>[0] = {
			"/long": (_req, res) => {
				res.writeHead(200, { "content-type": "text/plain" });
				res.end(Array.from({ length: 1_000 }, (_, index) => `line-${index}`).join("\n"));
			},
		};
		for (const query of ["alpha", "beta"]) {
			for (const index of [0, 1]) {
				routes[`/search-${query}-${index}`] = (_req, res) => {
					res.writeHead(200, { "content-type": "text/plain" });
					res.end(`${query} fetched content ${index}\n${"body ".repeat(2_000)}`);
				};
			}
		}
		server = await startServer(routes);
		fixture.searchBase = server.url;
	});

	afterAll(async () => server.close());
	beforeEach(() => resetFixture());

	it("accepts an uppercase continuation hash and warns when an offset is not hash-bound", async () => {
		const fake = host();
		const first = await fake.harness.callAgentTool("web_fetch", { url: `${server.url}/long`, maxChars: 300, refresh: true });
		const cursor = /Continue with offset=(\d+) and contentHash=([0-9a-f]{64})/.exec(toolText(first));
		assert.ok(cursor);

		const bound = await fake.harness.callAgentTool("web_fetch", {
			url: `${server.url}/long`,
			offset: Number(cursor[1]),
			maxChars: 300,
			contentHash: cursor[2]!.toUpperCase(),
		});
		assert.equal(structuredResult(bound).isError, undefined);
		assert.doesNotMatch(toolText(bound), /STALE_CONTENT/);
		assert.doesNotMatch(toolText(bound), /legacy offset is not bound/);

		const unbound = await fake.harness.callAgentTool("web_fetch", { url: `${server.url}/long`, offset: Number(cursor[1]), maxChars: 300 });
		assert.equal(structuredResult(unbound).isError, undefined);
		assert.match(toolText(unbound), /legacy offset is not bound to an immutable content hash/i);
	});

	it("warns for every multi-URL offset because one content hash cannot bind the batch", async () => {
		const fake = host();
		const result = await fake.harness.callAgentTool("web_fetch", {
			urls: [`${server.url}/long?a=1`, `${server.url}/long?a=2`],
			offset: 10,
			maxChars: 300,
			refresh: true,
		});
		assert.equal(structuredResult(result).isError, undefined);
		assert.equal(toolText(result).match(/legacy offset is not bound to an immutable content hash/gi)?.length, 2);
	});

	it("keeps direct GitHub resolution free of credentials while smart resolution uses the configured token", async () => {
		const previousGithub = process.env.GITHUB_TOKEN;
		const previousGh = process.env.GH_TOKEN;
		process.env.GITHUB_TOKEN = "test-token-not-sent-to-direct";
		delete process.env.GH_TOKEN;
		try {
			const fake = host();
			const direct = await fake.harness.callAgentTool("web_fetch", {
				url: "https://github.com/o/r/pull/5",
				mode: "raw",
				resolve: "direct",
				refresh: true,
			});
			assert.equal(structuredResult(direct).isError, undefined);
			const directCall = fixture.calls.find((call) => call.url === "https://github.com/o/r/pull/5");
			assert.ok(directCall);
			assert.equal(directCall.credentialed, false);
			assert.equal(directCall.headers.Authorization, undefined);

			fixture.calls.length = 0;
			const smart = await fake.harness.callAgentTool("web_fetch", {
				url: "https://github.com/o/r/pull/5",
				mode: "readable",
				resolve: "smart",
				refresh: true,
			});
			assert.equal(structuredResult(smart).isError, undefined);
			assert.ok(fixture.calls.length > 0);
			for (const call of fixture.calls) {
				assert.equal(call.credentialed, true);
				assert.equal(call.headers.Authorization, "Bearer test-token-not-sent-to-direct");
			}
		} finally {
			if (previousGithub === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = previousGithub;
			if (previousGh === undefined) delete process.env.GH_TOKEN;
			else process.env.GH_TOKEN = previousGh;
		}
	});

	it("runs search includeContent through the SDK host within one bounded output", async () => {
		const fake = host({ maxChars: 200_000 });
		const requestCount = server.requests.length;
		const result = await fake.harness.callAgentTool("web_search", {
			queries: ["alpha", "beta"],
			includeContent: true,
			numResults: 2,
		});
		const text = toolText(result);
		assert.equal(structuredResult(result).isError, undefined);
		assert.ok(text.length <= 32_000, `tool output used ${text.length} characters`);
		assert.match(text, /1\. "alpha"/);
		assert.match(text, /2\. "beta"/);
		assert.match(text, /Content fetches: selected 3 of 4 unique search results/);
		assert.match(text, /alpha fetched content 0/);
		assert.match(text, /beta fetched content 0/);
		assert.doesNotMatch(text, /\[Output truncated at/);
		assert.equal(server.requests.slice(requestCount).filter((request) => request.path.startsWith("/search-")).length, 3);
	});
});
