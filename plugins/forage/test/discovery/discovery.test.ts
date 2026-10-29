import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, vi } from "vitest";
import { createByteBudget, createDeadline } from "../../src/web/deadline.ts";
import { discoverSite, type DiscoveryFetchResult } from "../../src/web/discovery.ts";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/discovery/${name}`, import.meta.url), "utf8");

function response(url: string, content: string, contentType: string, status = 200): DiscoveryFetchResult {
	return { requestedUrl: url, finalUrl: url, status, contentType, content, bytes: Buffer.byteLength(content) };
}

describe("discoverSite", () => {
	it("discovers explicit/nested, robots, conventional, and llms indexes in deterministic order", async () => {
		const root = "https://docs.example/";
		const documents = new Map<string, DiscoveryFetchResult>([
			[`${root}explicit-index.xml`, response(`${root}explicit-index.xml`, fixture("explicit-index.xml"), "application/xml")],
			[`${root}nested.xml`, response(`${root}nested.xml`, fixture("nested.xml"), "application/xml")],
			[`${root}robots.txt`, response(`${root}robots.txt`, fixture("robots.txt"), "text/plain")],
			[`${root}robots-map.xml`, response(`${root}robots-map.xml`, fixture("robots-map.xml"), "application/xml")],
			[`${root}sitemap.xml`, response(`${root}sitemap.xml`, fixture("sitemap.xml"), "application/xml")],
			[`${root}llms.txt`, response(`${root}llms.txt`, fixture("llms.txt"), "text/markdown")],
		]);
		const calls: Array<{ url: string; operation: unknown }> = [];
		const deadline = createDeadline(5_000);
		const operation = { deadline, byteBudget: createByteBudget(100_000) };
		try {
			const result = await discoverSite({
				rootUrl: root,
				sitemapUrl: "/explicit-index.xml",
				includePaths: ["/docs/"],
				excludePaths: ["/docs/private/"],
				maxUrls: 20,
				maxIndexDocuments: 12,
				maxBytes: 100_000,
				signal: deadline.signal,
				operation,
			}, {
				fetch: async (url, options) => {
					calls.push({ url, operation: options.operation });
					return documents.get(url) ?? response(url, "not found", "text/plain", 404);
				},
			});

			assert.deepEqual(result.urls, [
				{ url: `${root}docs/A`, method: "sitemap-index", parentUrl: `${root}nested.xml`, title: null, lastModified: "2026-10-02" },
				{ url: `${root}docs/B?Case=X`, method: "sitemap-index", parentUrl: `${root}nested.xml`, title: null, lastModified: null },
				{ url: `${root}docs/from-robots`, method: "robots", parentUrl: `${root}robots-map.xml`, title: null, lastModified: "2026-10-03" },
				{ url: `${root}docs/conventional`, method: "sitemap", parentUrl: `${root}sitemap.xml`, title: null, lastModified: null },
				{ url: `${root}docs/llm-guide`, method: "llms", parentUrl: `${root}llms.txt`, title: "LLM guide", lastModified: null },
			]);
			assert.equal(result.truncated, false);
			assert.ok(calls.length >= 6);
			assert.ok(calls.every((call) => call.operation === operation), "one operation budget/deadline is shared with every fetch");
			assert.ok(!calls.some((call) => call.url.startsWith("https://outside.example/")), "external indexes are filtered before fetch");
		} finally {
			deadline.dispose();
		}
	});

	it("rejects DTD/external entities without expanding them", async () => {
		const deadline = createDeadline(5_000);
		try {
			const result = await discoverSite({
				rootUrl: "https://docs.example/",
				sitemapUrl: "/evil.xml",
				maxUrls: 10,
				maxIndexDocuments: 1,
				maxBytes: 10_000,
				signal: deadline.signal,
			}, {
				fetch: async (url) => response(url, fixture("evil-dtd.xml"), "application/xml"),
			});
			assert.deepEqual(result.urls, []);
			assert.equal(result.truncated, true);
			assert.ok(result.warnings.some((warning) => warning.includes("DTD")));
		} finally {
			deadline.dispose();
		}
	});

	it("reports malformed sitemap XML as truncated", async () => {
		const deadline = createDeadline(5_000);
		try {
			const result = await discoverSite({
				rootUrl: "https://docs.example/",
				sitemapUrl: "/broken.xml",
				maxUrls: 10,
				maxIndexDocuments: 1,
				maxBytes: 10_000,
				signal: deadline.signal,
			}, {
				fetch: async (url) => response(url, "<urlset><url><loc>/docs/incomplete", "application/xml"),
			});
			assert.equal(result.truncated, true);
			assert.ok(result.warnings.some((warning) => warning.includes("malformed")));
		} finally {
			deadline.dispose();
		}
	});

	it("detects cyclic nested sitemap indexes without refetching them", async () => {
		const root = "https://docs.example/";
		const a = `<sitemapindex><sitemap><loc>/b.xml</loc></sitemap></sitemapindex>`;
		const b = `<sitemapindex><sitemap><loc>/a.xml</loc></sitemap></sitemapindex>`;
		const calls: string[] = [];
		const deadline = createDeadline(5_000);
		try {
			const result = await discoverSite({
				rootUrl: root,
				sitemapUrl: "/a.xml",
				maxUrls: 10,
				maxIndexDocuments: 10,
				maxBytes: 10_000,
				signal: deadline.signal,
			}, {
				fetch: async (url) => {
					calls.push(url);
					if (url === `${root}a.xml`) return response(url, a, "application/xml");
					if (url === `${root}b.xml`) return response(url, b, "application/xml");
					return response(url, "not found", "text/plain", 404);
				},
			});
			assert.equal(calls.filter((url) => url === `${root}a.xml`).length, 1);
			assert.equal(calls.filter((url) => url === `${root}b.xml`).length, 1);
			assert.equal(result.truncated, true);
			assert.ok(result.warnings.some((warning) => warning.includes("Cyclic sitemap")));
		} finally {
			deadline.dispose();
		}
	});

	it("uses root HTML links only as a fallback and applies URL policy before output", async () => {
		const root = "https://docs.example/";
		const deadline = createDeadline(5_000);
		try {
			const result = await discoverSite({
				rootUrl: root,
				includePaths: ["/docs/"],
				maxUrls: 10,
				maxIndexDocuments: 10,
				maxBytes: 100_000,
				signal: deadline.signal,
			}, {
				fetch: async (url) => url === root
					? response(url, fixture("root.html"), "text/html")
					: response(url, "not found", "text/plain", 404),
			});
			assert.deepEqual(result.urls, [
				{ url: `${root}docs/root-one`, method: "html-link", parentUrl: root, title: "Root one", lastModified: null },
				{ url: `${root}docs/root-two`, method: "html-link", parentUrl: root, title: "Root two", lastModified: null },
			]);
		} finally {
			deadline.dispose();
		}
	});

	it("stops explicitly at the expanded-byte limit", async () => {
		const deadline = createDeadline(5_000);
		try {
			const result = await discoverSite({
				rootUrl: "https://docs.example/",
				sitemapUrl: "/large.xml",
				maxUrls: 10,
				maxIndexDocuments: 10,
				maxBytes: 20,
				signal: deadline.signal,
			}, {
				fetch: async (url) => response(url, `<urlset>${"x".repeat(100)}</urlset>`, "application/xml"),
			});
			assert.equal(result.truncated, true);
			assert.ok(result.warnings.some((warning) => warning.includes("byte limit")));
			assert.equal(result.bytes, 0);
		} finally {
			deadline.dispose();
		}
	});

	it("parses unclosed sitemap openers in bounded time", async () => {
		const deadline = createDeadline(5_000);
		try {
			const body = `<urlset>${"<url>".repeat(40_000)}</urlset>`;
			const started = performance.now();
			await discoverSite({
				rootUrl: "https://docs.example/",
				sitemapUrl: "/hostile.xml",
				maxIndexDocuments: 1,
				maxBytes: 500_000,
				includeRootLinks: false,
				signal: deadline.signal,
			}, { fetch: async (url) => response(url, body, "application/xml") });
			assert.ok(performance.now() - started < 250, "sitemap scanning must remain linear");
		} finally {
			deadline.dispose();
		}
	});

	it("ignores XML comments and rejects redirected documents outside the boundary", async () => {
		const root = "https://docs.example/";
		const deadline = createDeadline(5_000);
		try {
			const commented = await discoverSite({
				rootUrl: root,
				sitemapUrl: "/commented.xml",
				maxIndexDocuments: 1,
				includeRootLinks: false,
				signal: deadline.signal,
			}, {
				fetch: async (url) => response(url, "<urlset><!-- <url><loc>/commented</loc></url> --><url><loc>/visible</loc></url></urlset>", "application/xml"),
			});
			assert.deepEqual(commented.urls.map((item) => item.url), [`${root}visible`]);

			const redirected = await discoverSite({
				rootUrl: root,
				sitemapUrl: "/redirected.xml",
				maxIndexDocuments: 1,
				includeRootLinks: false,
				signal: deadline.signal,
			}, {
				fetch: async (url) => ({ ...response(url, "<urlset><url><loc>/visible</loc></url></urlset>", "application/xml"), finalUrl: "https://outside.example/map.xml" }),
			});
			assert.deepEqual(redirected.urls, []);
			assert.ok(redirected.warnings.some((warning) => warning.includes("outside the permitted site boundary")));
		} finally {
			deadline.dispose();
		}
	});

	it("scans hostile llms markdown links in bounded time", async () => {
		const root = "https://docs.example/";
		const hostile = "[a](<".repeat(200_000);
		const deadline = createDeadline(10_000);
		try {
			const started = performance.now();
			const result = await discoverSite({
				rootUrl: root,
				maxBytes: 2_000_000,
				includeRootLinks: false,
				signal: deadline.signal,
			}, {
				fetch: async (url) => url === `${root}llms.txt`
					? response(url, hostile, "text/markdown")
					: response(url, "not found", "text/plain", 404),
			});
			assert.deepEqual(result.urls, []);
			assert.ok(performance.now() - started < 750, "llms markdown scanning must remain linear");
		} finally {
			deadline.dispose();
		}
	});

	it("bounds sitemap-index children to the remaining document allowance", async () => {
		const NativeURL = URL;
		let constructedUrls = 0;
		vi.stubGlobal("URL", class extends NativeURL {
			constructor(input: string | URL, base?: string | URL) {
				super(input, base);
				constructedUrls++;
			}
		});
		const calls: string[] = [];
		const index = `<sitemapindex>${Array.from({ length: 20_000 }, (_, i) => `<sitemap><loc>/child-${i}.xml</loc></sitemap>`).join("")}</sitemapindex>`;
		try {
			const result = await discoverSite({
				rootUrl: "https://docs.example/", sitemapUrl: "/wide.xml", maxIndexDocuments: 4,
				includeRootLinks: false, signal: new AbortController().signal,
			}, {
				fetch: async (url) => {
					calls.push(url);
					return response(url, url.endsWith("/wide.xml") ? index : "<urlset><url><loc>/page</loc></url></urlset>", "application/xml");
				},
			});
			assert.deepEqual(calls, ["wide.xml", "child-0.xml", "child-1.xml", "child-2.xml"].map((path) => `https://docs.example/${path}`));
			assert.ok(constructedUrls < 100, `only fetchable children should be normalized, got ${constructedUrls}`);
			assert.equal(result.truncated, true);
			assert.ok(result.warnings.some((warning) => warning.includes("document limit")));
			assert.equal(result.urls[0]?.url, "https://docs.example/page");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("passes the remaining expanded-byte allowance to every dependency fetch", async () => {
		const root = "https://docs.example/";
		const limits: number[] = [];
		const deadline = createDeadline(5_000);
		try {
			await discoverSite({
				rootUrl: root,
				sitemapUrl: "/index.xml",
				maxIndexDocuments: 2,
				maxBytes: 1_000,
				includeRootLinks: false,
				signal: deadline.signal,
			}, {
				fetch: async (url, options) => {
					limits.push(options.maxBytes);
					if (url.endsWith("index.xml")) return response(url, "<sitemapindex><sitemap><loc>/nested.xml</loc></sitemap></sitemapindex>", "application/xml");
					return response(url, "<urlset><url><loc>/page</loc></url></urlset>", "application/xml");
				},
			});
			assert.equal(limits[0], 1_000);
			assert.ok((limits[1] ?? 1_000) < 1_000);
		} finally {
			deadline.dispose();
		}
	});
});
