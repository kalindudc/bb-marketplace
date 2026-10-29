import { fixtureRuntime } from "../runtime-helper.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { CONFIG_DEFAULTS, type WebConfig } from "../../src/web/config.ts";
import { createByteBudget, createDeadline } from "../../src/web/deadline.ts";
import {
	cacheClear,
	cacheGet,
	cacheSet,
	fetchContent,
	findPassages,
	type FetchedContent,
} from "../../src/web/fetch.ts";
import { mergeNetworkAccess, readBodyLimited, safeFetch } from "../../src/web/net.ts";
import { registerTools, runDispatchedBatch } from "../../src/tools.ts";
import { type TestServer, startServer } from "../_server.ts";

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

function fetchedValue(url: string, access: NonNullable<FetchedContent["access"]>, content = "cached"): FetchedContent {
	return {
		url,
		finalUrl: url,
		title: "cached",
		content,
		kind: "text",
		contentType: "text/plain",
		status: 200,
		bytes: Buffer.byteLength(content),
		durationMs: 1,
		redirects: 0,
		cached: false,
		access,
		cacheControl: "max-age=60",
	};
}

describe.sequential("H1A review regressions: transport and cache policy", () => {
	let server: TestServer;
	let noCacheHits = 0;
	let revalidateHits = 0;
	let cancelRefetchHits = 0;
	beforeAll(async () => {
		server = await startServer({
			"/ok": (_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); },
			"/redirect": (_req, res) => { res.writeHead(302, { location: "/ok" }); res.end(); },
			"/budget": (_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("x".repeat(256)); },
			"/artifact": (_req, res) => { res.writeHead(200, { "content-type": "text/plain", "cache-control": "max-age=60" }); res.end("artifact body"); },
			"/revalidate": (req, res) => {
				revalidateHits++;
				if (req.headers["if-none-match"] === '"review"') {
					res.writeHead(304, { etag: '"review"', "cache-control": "max-age=0" });
					res.end();
					return;
				}
				res.writeHead(200, { "content-type": "text/plain", etag: '"review"', "cache-control": "max-age=0" });
				res.end("revalidated body");
			},
			"/no-cache": (req, res) => {
				noCacheHits++;
				if (req.headers["if-none-match"] === '"no-cache"') {
					res.writeHead(304, { etag: '"no-cache"', "cache-control": "no-cache" });
					res.end();
					return;
				}
				res.writeHead(200, { "content-type": "text/plain", etag: '"no-cache"', "cache-control": "no-cache" });
				res.end("must revalidate");
			},
			"/failed": (_req, res) => { res.writeHead(503, { "content-type": "text/plain" }); res.end("unavailable"); },
			"/cancel-refetch": async (_req, res) => {
				cancelRefetchHits++;
				await new Promise((resolve) => setTimeout(resolve, 100));
				res.writeHead(200, { "content-type": "text/plain" });
				res.end("fresh transport");
			},
		});
	});
	afterAll(async () => server.close());

	it("treats credential headers as credentialed even when the caller passes false", async () => {
		const fetched = await safeFetch(`${server.url}/ok`, {
			timeoutMs: 1_000,
			maxBytes: 1_024,
			allowPrivateNetwork: true,
			headers: { Authorization: "Bearer placeholder" },
			credentialed: false,
		});
		assert.equal(fetched.access.credentialed, true);
		await readBodyLimited(fetched.response, 1_024);
	});

	it("rejects credentialed HTTPS-to-HTTP redirects even when credentialed:false was passed", async () => {
		const key = readFileSync(new URL("../fixtures/localhost-key.pem", import.meta.url));
		const cert = readFileSync(new URL("../fixtures/localhost-cert.pem", import.meta.url));
		const https = createHttpsServer({ key, cert }, (_req, res) => {
			res.writeHead(302, { location: `${server.url}/ok` });
			res.end();
		});
		await new Promise<void>((resolve) => https.listen(0, "127.0.0.1", resolve));
		const port = (https.address() as AddressInfo).port;
		const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
		try {
			await assert.rejects(
				safeFetch(`https://credential.test:${port}/`, {
					timeoutMs: 1_000,
					maxBytes: 1_024,
					allowPrivateNetwork: true,
					headers: { Authorization: "Bearer placeholder" },
					credentialed: false,
					resolver: async () => [{ address: "127.0.0.1", family: 4 }],
				}),
				/credentialed HTTPS requests cannot redirect to HTTP/i,
			);
		} finally {
			if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
			else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
			await new Promise<void>((resolve, reject) => https.close((error) => error ? reject(error) : resolve()));
		}
	});

	it("surfaces shared byte-budget exhaustion with a stable budget classification", async () => {
		const fetched = await safeFetch(`${server.url}/budget`, { timeoutMs: 1_000, maxBytes: 1_024, allowPrivateNetwork: true });
		await assert.rejects(
			readBodyLimited(fetched.response, 1_024, undefined, createByteBudget(10)),
			(error: unknown) => error instanceof Error && "kind" in error && error.kind === "budget",
		);
		const result = await fetchContent(`${server.url}/budget`, {
			mode: "readable",
			config: config(),
			byteBudget: createByteBudget(10),
			noCache: true,
		});
		assert.equal(result.errorCode, "budget");
		assert.match(result.error ?? "", /byte budget exceeded/i);
	});

	it("classifies cache-hit and 304 byte-budget exhaustion as budget errors", async () => {
		cacheClear();
		await fetchContent(`${server.url}/artifact`, { mode: "readable", config: config(), requestScopeKey: "thread:budget-hit" });
		const cacheHit = await fetchContent(`${server.url}/artifact`, {
			mode: "readable",
			config: config(),
			requestScopeKey: "thread:budget-hit",
			byteBudget: createByteBudget(1),
		});
		assert.equal(cacheHit.errorCode, "budget");
		assert.match(cacheHit.error ?? "", /byte budget exceeded/i);

		cacheClear();
		await fetchContent(`${server.url}/revalidate`, { mode: "readable", config: config(), requestScopeKey: "thread:budget-304" });
		const revalidated = await fetchContent(`${server.url}/revalidate`, {
			mode: "readable",
			config: config(),
			requestScopeKey: "thread:budget-304",
			byteBudget: createByteBudget(1),
		});
		assert.equal(revalidated.errorCode, "budget");
		assert.match(revalidated.error ?? "", /byte budget exceeded/i);
	});

	it("starts a fresh transport when the last waiter cancels and an immediate refetch arrives", async () => {
		cacheClear();
		cancelRefetchHits = 0;
		const cancelled = new AbortController();
		const first = fetchContent(`${server.url}/cancel-refetch`, {
			mode: "readable",
			config: config(),
			requestScopeKey: "thread:cancel-refetch",
			signal: cancelled.signal,
			noCache: true,
		});
		cancelled.abort(new Error("cancel first waiter"));
		const second = fetchContent(`${server.url}/cancel-refetch`, {
			mode: "readable",
			config: config(),
			requestScopeKey: "thread:cancel-refetch",
			noCache: true,
		});
		const [cancelledResult, freshResult] = await Promise.all([first, second]);
		assert.equal(cancelledResult.errorCode, "aborted");
		assert.equal(freshResult.content, "fresh transport");
		assert.equal(freshResult.error, undefined);
		assert.ok(cancelRefetchHits >= 1);
	});

	it("treats Cache-Control: no-cache as immediately stale and revalidates", async () => {
		cacheClear();
		noCacheHits = 0;
		const first = await fetchContent(`${server.url}/no-cache`, { mode: "readable", config: config(), requestScopeKey: "thread:no-cache" });
		const second = await fetchContent(`${server.url}/no-cache`, { mode: "readable", config: config(), requestScopeKey: "thread:no-cache" });
		assert.equal(noCacheHits, 2);
		assert.equal(first.cache, "miss");
		assert.equal(second.cache, "revalidated");
		assert.equal(second.attempt?.httpStatus, 304);
	});

	it("supplies artifacts on misses and preserves them unchanged on hits and revalidation", async () => {
		cacheClear();
		const miss = await fetchContent(`${server.url}/artifact`, { mode: "readable", config: config(), requestScopeKey: "thread:artifact" });
		assert.equal(miss.cache, "miss");
		assert.ok(miss.artifact);
		assert.equal(miss.artifact.content, miss.content);
		assert.equal(miss.artifact.contentHash, miss.contentHash);
		assert.equal(miss.artifact.representation, "readable");
		assert.equal(miss.artifact.access, miss.access);
		assert.equal(miss.artifact.completeness.state, "complete");
		assert.ok(miss.artifact.diagnostics.stageMs.total >= 0);

		const hit = await fetchContent(`${server.url}/artifact`, { mode: "readable", config: config(), requestScopeKey: "thread:artifact" });
		assert.equal(hit.cache, "hit");
		assert.strictEqual(hit.artifact, miss.artifact);
		assert.notDeepEqual(hit.attempt, miss.attempt);

		cacheClear();
		revalidateHits = 0;
		const original = await fetchContent(`${server.url}/revalidate`, { mode: "readable", config: config(), requestScopeKey: "thread:artifact" });
		const revalidated = await fetchContent(`${server.url}/revalidate`, { mode: "readable", config: config(), requestScopeKey: "thread:artifact" });
		assert.equal(revalidateHits, 2);
		assert.equal(revalidated.cache, "revalidated");
		assert.strictEqual(revalidated.artifact, original.artifact);
		assert.equal(revalidated.attempt?.httpStatus, 304);

		const failed = await fetchContent(`${server.url}/failed`, { mode: "readable", config: config(), noCache: true });
		assert.equal(failed.artifact, undefined);
	});

	it("keeps a public-to-private redirect landing out of the public cache namespace", async () => {
		cacheClear();
		const fetched = await safeFetch(`${server.url}/redirect`, { timeoutMs: 1_000, maxBytes: 1_024, allowPrivateNetwork: true, requestScopeKey: "thread:redirect" });
		assert.equal(fetched.redirects, 1);
		assert.equal(fetched.access.network, "private");
		await readBodyLimited(fetched.response, 1_024);
		const access = { ...fetched.access, network: mergeNetworkAccess("public", fetched.access.network) };
		assert.equal(access.network, "private");
		const value = fetchedValue(`${server.url}/redirect`, access);
		cacheSet(value.url, "readable", value);
		assert.equal(cacheGet(value.url, "readable"), undefined);
		assert.equal(cacheGet(value.url, "readable", { allowPrivateNetwork: true, requestScopeKey: "thread:redirect" })?.content, "cached");
	});

	it("treats a token-bearing GitHub smart request as credentialed despite credentialed:false", async () => {
		cacheClear();
		const url = "https://github.com/example/repository/issues/1";
		cacheSet(url, "readable", fetchedValue(url, { network: "public", credentialed: true, requestScopeKey: "thread:github" }, "credentialed cache"));
		const previous = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = "placeholder-not-sent";
		const cancelled = new AbortController();
		cancelled.abort(new Error("network must not run"));
		try {
			const result = await fetchContent(url, {
				mode: "readable",
				config: config({ allowPrivateNetwork: false }),
				requestScopeKey: "thread:github",
				credentialed: false,
				signal: cancelled.signal,
			});
			assert.equal(result.cache, "hit");
			assert.equal(result.content, "credentialed cache");
		} finally {
			if (previous === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = previous;
		}
	});
});

describe.sequential("H1A review regressions: passage matching", () => {
	it("keeps literal match offsets and excerpts exact when earlier Unicode lowercasing changes length", async () => {
		const content = `${"İ".repeat(10)}needle here`;
		const passages = await findPassages(content, "needle", { context: 0 });
		assert.deepEqual(passages, [{ index: 10, line: 1, excerpt: "…needle…" }]);
	});
});

describe.sequential("H1A review regressions: isolated extraction", () => {
	let server: TestServer;
	let binDir: string;
	let previousPath: string | undefined;
	beforeAll(async () => {
		server = await startServer({
			"/pdf-large": (_req, res) => { res.writeHead(200, { "content-type": "application/pdf" }); res.end("%PDF-large"); },
			"/pdf-slow": (_req, res) => { res.writeHead(200, { "content-type": "application/pdf" }); res.end("%PDF-slow"); },
		});
		binDir = mkdtempSync(join(tmpdir(), "forage-pdftotext-"));
		const executable = join(binDir, "pdftotext");
		writeFileSync(executable, `#!/bin/sh\nif [ "$FORAGE_TEST_PDF_MODE" = "large" ]; then\n  i=0\n  while [ $i -lt 256 ]; do printf '0123456789abcdef'; i=$((i + 1)); done\nelif [ "$FORAGE_TEST_PDF_MODE" = "slow" ]; then\n  sleep 1\n  printf 'late'\nelse\n  printf 'page one\\fpage two'\nfi\n`);
		chmodSync(executable, 0o755);
		previousPath = process.env.PATH;
		process.env.PATH = `${binDir}:${previousPath ?? ""}`;
	});
	afterAll(async () => {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		delete process.env.FORAGE_TEST_PDF_MODE;
		rmSync(binDir, { recursive: true, force: true });
		await server.close();
	});

	it("enforces regex output caps", async () => {
		const content = Array.from({ length: 100 }, () => `${"x".repeat(15_000)}MATCH`).join("\n");
		await assert.rejects(findPassages(content, "/MATCH/", { context: 6_000, max: 100, timeoutMs: 2_000 }), /output exceeded 1 MiB/i);
	});

	it("enforces PDF output and time bounds through fetchContent", async () => {
		process.env.FORAGE_TEST_PDF_MODE = "large";
		const large = await fetchContent(`${server.url}/pdf-large`, {
			mode: "readable",
			config: config({ maxResponseBytes: 512, timeoutMs: 1_000 }),
			noCache: true,
		});
		assert.match(large.error ?? "", /stdout exceeded limit/i);
		assert.equal(large.artifact, undefined);

		process.env.FORAGE_TEST_PDF_MODE = "slow";
		const slow = await fetchContent(`${server.url}/pdf-slow`, {
			mode: "readable",
			config: config({ maxResponseBytes: 1_024, timeoutMs: 50 }),
			noCache: true,
		});
		assert.match(slow.error ?? "", /timed out/i);
		assert.equal(slow.errorCode, "timeout");
		assert.equal(slow.artifact, undefined);
	});
});

describe.sequential("H1A review regressions: tool batches", () => {
	let server: TestServer;
	let fetchStarts = 0;
	let abortStarts = 0;
	beforeAll(async () => {
		const routes: Parameters<typeof startServer>[0] = {
			"/hostile": (_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(`${"a".repeat(200_000)}!`); },
			"/healthy": (_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("healthy page"); },
			"/search": async (_req, res, url) => {
				const query = url.searchParams.get("q") ?? "query";
				if (query.startsWith("slow-query-")) await new Promise((resolve) => setTimeout(resolve, 900));
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ results: [{ title: query, url: `${server.url}/content-${encodeURIComponent(query)}`, content: `snippet ${query}` }] }));
			},
		};
		for (let index = 0; index < 6; index++) {
			routes[`/fetch-${index}`] = async (_req, res) => {
				fetchStarts++;
				await new Promise((resolve) => setTimeout(resolve, 600));
				res.writeHead(200, { "content-type": "text/plain" });
				res.end(`fetch ${index}`);
			};
			routes[`/abort-${index}`] = async (_req, res) => {
				abortStarts++;
				await new Promise((resolve) => setTimeout(resolve, 600));
				res.writeHead(200, { "content-type": "text/plain" });
				res.end(`abort ${index}`);
			};
		}
		for (let index = 0; index < 8; index++) {
			routes[`/content-slow-query-${index}`] = async (_req, res) => {
				await new Promise((resolve) => setTimeout(resolve, 600));
				res.writeHead(200, { "content-type": "text/plain" });
				res.end(`content ${index}`);
			};
			routes[`/content-fast-query-${index}`] = async (_req, res) => {
				await new Promise((resolve) => setTimeout(resolve, 600));
				res.writeHead(200, { "content-type": "text/plain" });
				res.end(`content ${index}`);
			};
		}
		server = await startServer(routes);
	});
	afterAll(async () => server.close());

	function host(overrides: Partial<WebConfig> = {}) {
		const fake = createFakePluginHost({
			pluginId: "forage",
			experimental_declaredIconNames: ["search", "fetch", "map", "extract", "crawl", "diff"],
		});
		registerTools(fake.bb, fixtureRuntime(fake.bb, async () => config({ timeoutMs: 1_000, concurrency: 2, searxngUrl: server.url, provider: "searxng", ...overrides })));
		return fake;
	}

	it("starts fetch deadlines at worker dispatch so six queued URLs all complete within the derived outer cap", async () => {
		cacheClear();
		fetchStarts = 0;
		const fake = host();
		const started = Date.now();
		const result = await fake.harness.callAgentTool("web_fetch", {
			urls: Array.from({ length: 6 }, (_, index) => `${server.url}/fetch-${index}`),
			refresh: true,
		});
		const elapsed = Date.now() - started;
		assert.equal(structuredResult(result).isError, undefined);
		assert.match(toolText(result), /Fetched 6\/6 URLs/);
		assert.equal(fetchStarts, 6);
		assert.ok(elapsed < 3_500, `elapsed ${elapsed}ms exceeded the outer cap`);
	});

	it("does not start queued work after caller cancellation expires the batch", async () => {
		cacheClear();
		abortStarts = 0;
		const fake = host({ concurrency: 1 });
		const controller = new AbortController();
		setTimeout(() => controller.abort(new Error("stop batch")), 50);
		await fake.harness.callAgentTool(
			"web_fetch",
			{ urls: Array.from({ length: 6 }, (_, index) => `${server.url}/abort-${index}`), refresh: true },
			{ signal: controller.signal },
		);
		assert.equal(abortStarts, 1);
	});

	it("does not start queued work after the outer deadline expires", async () => {
		const outer = createDeadline(40);
		const started: number[] = [];
		try {
			const results = await runDispatchedBatch(
				[0, 1, 2],
				1,
				1_000,
				outer,
				new AbortController().signal,
				async (item) => {
					started.push(item);
					await new Promise((resolve) => setTimeout(resolve, 80));
					return `done:${item}`;
				},
				(item, error) => `expired:${item}:${error instanceof Error ? error.message : String(error)}`,
			);
			assert.deepEqual(started, [0]);
			assert.equal(results[0], "done:0");
			assert.match(results[1] ?? "", /expired:1:Batch deadline expired before dispatch/);
			assert.match(results[2] ?? "", /expired:2:Batch deadline expired before dispatch/);
		} finally {
			outer.dispose();
		}
	});

	it("keeps a hostile find failure local to one fetched page", async () => {
		cacheClear();
		const fake = host();
		const result = await fake.harness.callAgentTool("web_fetch", {
			urls: [`${server.url}/hostile`, `${server.url}/healthy`],
			find: "/(a+)+$/",
			refresh: true,
		});
		const text = toolText(result);
		assert.equal(structuredResult(result).isError, undefined);
		assert.match(text, /Fetched 1\/2 URLs/);
		assert.match(text, /Find failed: Regular expression timed out/i);
		assert.match(text, /healthy page|No matches/);
	});

	it("starts search query deadlines at dispatch instead of map time", async () => {
		const fake = host();
		const result = await fake.harness.callAgentTool("web_search", {
			queries: Array.from({ length: 6 }, (_, index) => `slow-query-${index}`),
			provider: "searxng",
			numResults: 1,
		});
		const text = toolText(result);
		assert.equal(structuredResult(result).isError, undefined);
		assert.doesNotMatch(text, /failed/i);
		assert.match(text, /6 queries · 6 results/);
	});

	it("gives mixed fast and nearly-expired slow queries fresh include-content deadlines under the outer cap", async () => {
		cacheClear();
		const fake = host();
		const started = Date.now();
		const result = await fake.harness.callAgentTool("web_search", {
			queries: ["fast-query-0", "slow-query-0"],
			provider: "searxng",
			numResults: 1,
			includeContent: true,
		});
		const elapsed = Date.now() - started;
		const text = toolText(result);
		assert.equal(structuredResult(result).isError, undefined);
		assert.match(text, /### content-fast-query-0/);
		assert.match(text, /### content-slow-query-0/);
		assert.doesNotMatch(text, /Could not fetch/);
		assert.ok(elapsed >= 1_300, `elapsed ${elapsed}ms did not exercise the slow query plus content phase`);
		assert.ok(elapsed < 3_500, `elapsed ${elapsed}ms exceeded the derived two-phase outer cap`);
	});

	it("gives include-content targets fresh dispatch deadlines under the shared outer cap", async () => {
		cacheClear();
		const fake = host();
		const started = Date.now();
		const result = await fake.harness.callAgentTool("web_search", {
			queries: ["fast-query-0", "fast-query-1", "fast-query-2"],
			provider: "searxng",
			numResults: 1,
			includeContent: true,
		});
		const elapsed = Date.now() - started;
		const text = toolText(result);
		assert.equal(structuredResult(result).isError, undefined);
		assert.match(text, /### content-fast-query-2/);
		assert.match(text, /content 2/);
		assert.doesNotMatch(text, /Could not fetch/);
		assert.ok(elapsed < 4_500, `elapsed ${elapsed}ms exceeded the two-phase outer cap`);
	});
});
