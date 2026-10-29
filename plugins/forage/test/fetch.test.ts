import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { CONFIG_DEFAULTS, type WebConfig } from "../src/web/config.ts";
import { createByteBudget, createDeadline } from "../src/web/deadline.ts";
import { cacheClear, cacheGet, cacheSet, cacheStats, fetchContent, findPassages, hasGithubCredential, normalizeUrl, rewriteUrl, sliceContent } from "../src/web/fetch.ts";
import { type TestServer, html, startServer } from "./_server.ts";

function config(overrides: Partial<WebConfig> = {}): WebConfig {
	return { ...CONFIG_DEFAULTS, allowPrivateNetwork: true, warnings: [], ...overrides };
}

describe("normalizeUrl", () => {
	it("adds https, strips fragments and angle brackets", () => {
		assert.equal(normalizeUrl(" example.com/a#frag "), "https://example.com/a");
		assert.equal(normalizeUrl("<https://example.com/>"), "https://example.com/");
		assert.equal(normalizeUrl("http://example.com/x?y=1"), "http://example.com/x?y=1");
	});
	it("rejects non-http schemes", () => {
		assert.throws(() => normalizeUrl("file:///etc/passwd"), /Unsupported URL scheme/);
		assert.throws(() => normalizeUrl("mailto:x@y.z"), /Unsupported URL scheme/);
		assert.throws(() => normalizeUrl("javascript:alert(1)"), /Unsupported URL scheme/);
	});
	it("treats scheme-less host:port as a host, not a scheme (review F4)", () => {
		assert.equal(normalizeUrl("example.com:8080/path"), "https://example.com:8080/path");
		assert.equal(normalizeUrl("docs.lan:8080/api?x=1"), "https://docs.lan:8080/api?x=1");
		assert.equal(normalizeUrl("localhost:3000"), "https://localhost:3000/");
		assert.equal(normalizeUrl("localhost:3000/x"), "https://localhost:3000/x");
		assert.equal(normalizeUrl("192.168.1.10:9000/"), "https://192.168.1.10:9000/");
	});
});

describe("rewriteUrl (GitHub)", () => {
	it("maps blob and raw paths to raw.githubusercontent.com", () => {
		const r = rewriteUrl("https://github.com/o/r/blob/main/dir/file name.md?plain=1");
		assert.equal(r.kind, "github-raw");
		assert.equal(r.url, "https://raw.githubusercontent.com/o/r/main/dir/file%20name.md");
		assert.equal(rewriteUrl("https://github.com/o/r/raw/v1.2/x.ts").url, "https://raw.githubusercontent.com/o/r/v1.2/x.ts");
	});
	it("maps repo roots to README with the HTML page as fallback", () => {
		const r = rewriteUrl("https://github.com/o/r/");
		assert.equal(r.kind, "github-readme");
		assert.equal(r.url, "https://raw.githubusercontent.com/o/r/HEAD/README.md");
		assert.equal(r.fallback, "https://github.com/o/r/");
	});
	it("maps tree and issue/pull URLs to the API", () => {
		const t = rewriteUrl("https://github.com/o/r/tree/main/src/lib");
		assert.equal(t.kind, "github-tree");
		assert.equal(t.url, "https://api.github.com/repos/o/r/contents/src/lib?ref=main");
		assert.equal(rewriteUrl("https://github.com/o/r/issues/12").url, "https://api.github.com/repos/o/r/issues/12");
		assert.equal(rewriteUrl("https://github.com/o/r/pull/7").url, "https://api.github.com/repos/o/r/pulls/7");
		assert.equal(rewriteUrl("https://github.com/o/r/pull/7").kind, "github-issue");
	});
	it("tolerates malformed percent-escapes instead of throwing URIError (review F3)", () => {
		const a = rewriteUrl("https://github.com/o/r/tree/%ZZ/src");
		assert.equal(a.kind, "github-tree");
		assert.equal(a.meta?.ref, "%ZZ");
		const b = rewriteUrl("https://github.com/o/r/tree/main/%E0%A4%A");
		assert.equal(b.kind, "github-tree");
		assert.equal(b.meta?.path, "%E0%A4%A");
	});
	it("leaves other GitHub and non-GitHub URLs alone", () => {
		assert.equal(rewriteUrl("https://github.com/o/r/actions").kind, "none");
		assert.equal(rewriteUrl("https://github.com/orgs/x").kind, "none");
		assert.equal(rewriteUrl("https://example.com/o/r/blob/main/x").kind, "none");
		assert.equal(rewriteUrl("https://github.com/o/r/pull/abc").kind, "none");
	});
	it("classifies token-bearing GitHub retrievals as credentialed", () => {
		const previous = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = "placeholder-not-used";
		try {
			assert.equal(hasGithubCredential(), true);
		} finally {
			if (previous === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = previous;
		}
	});
});

describe("sliceContent / findPassages", () => {
	const doc = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}: ${i === 20 ? "the NEEDLE is here" : "filler text"}`).join("\n");

	it("slices at a line boundary and reports paging metadata", () => {
		const s = sliceContent(doc, 0, 100);
		assert.ok(s.text.endsWith("\n"));
		assert.ok(s.end <= 100 && s.end >= 70);
		assert.equal(s.truncated, true);
		assert.equal(s.total, doc.length);
		const tail = sliceContent(doc, s.end, 100_000);
		assert.equal(tail.truncated, false);
		assert.equal(s.text + tail.text, doc);
	});
	it("clamps offsets past the end", () => {
		const s = sliceContent(doc, 10_000, 10);
		assert.equal(s.text, "");
		assert.equal(s.offset, doc.length);
	});
	it("finds case-insensitive passages with line numbers and context", async () => {
		const p = await findPassages(doc, "needle", { context: 12, max: 5 });
		assert.equal(p.length, 1);
		assert.equal(p[0]?.line, 21);
		assert.match(p[0]?.excerpt ?? "", /^…[\s\S]*NEEDLE[\s\S]*…$/);
	});
	it("anchors ^/$ to lines in /regex/ needles (m is always on) and honours user flags", async () => {
		const md = "# Title\n\n## Install\n\ntext\n\n## install notes\n\n## Usage\n";
		assert.equal((await findPassages(md, "/^## Install/", { context: 0 })).length, 1);
		assert.equal((await findPassages(md, "/^## install/i", { context: 0 })).length, 2);
		assert.equal((await findPassages(md, "/^## /", { context: 0 })).length, 3);
		assert.equal((await findPassages(md, "/^## /gm", { context: 0 })).length, 3, "duplicate flags are tolerated");
	});
	it("supports /regex/ needles, caps matches and merges overlapping windows", async () => {
		const p = await findPassages(doc, "/line \\d+/i", { context: 5, max: 3 });
		assert.equal(p.length, 3);
		const wide = await findPassages(doc, "filler", { context: doc.length, max: 20 });
		assert.equal(wide.length, 1, "matches inside the previous excerpt are skipped");
		const narrow = await findPassages(doc, "filler", { context: 0, max: 100 });
		assert.equal(narrow.length, 49, "non-overlapping matches are all reported");
	});
	it("falls back to literal matching for invalid regexes and empty patterns", async () => {
		assert.equal((await findPassages(doc, "/([/", {})).length, 0);
		assert.equal((await findPassages("a(b", "a(b", {})).length, 1);
	});
	it("terminates catastrophic regular expressions and remains responsive", async () => {
		const hostile = `${"a".repeat(200_000)}!`;
		await assert.rejects(findPassages(hostile, "/(a+)+$/", { timeoutMs: 50 }), /timed out/i);
		assert.equal((await findPassages("after timeout", "timeout")).length, 1);
	});
});

describe("cache", () => {
	it("stores, touches and clears entries; skips empty errors", () => {
		cacheClear();
		const value = {
			url: "u",
			finalUrl: "u",
			title: "t",
			content: "c",
			kind: "text" as const,
			contentType: "text/plain",
			status: 200,
			bytes: 1,
			durationMs: 1,
			redirects: 0,
			cached: false,
			access: { network: "public" as const, credentialed: false, requestScopeKey: null },
		};
		cacheSet("https://a/", "readable", value);
		assert.equal(cacheGet("https://a/", "readable")?.title, "t");
		assert.equal(cacheGet("https://a/", "raw"), undefined);
		cacheSet("https://b/", "readable", { ...value, content: "", error: "x", kind: "error" });
		assert.equal(cacheStats().entries, 1);
		cacheClear();
		assert.equal(cacheStats().entries, 0);
	});
	it("requires matching scope and credential state for restricted entries", () => {
		cacheClear();
		const value = {
			url: "https://github.com/o/r/",
			finalUrl: "https://api.github.com/repos/o/r",
			title: "private",
			content: "credentialed",
			kind: "github-api" as const,
			contentType: "application/json",
			status: 200,
			bytes: 12,
			durationMs: 1,
			redirects: 0,
			cached: false,
			access: { network: "public" as const, credentialed: true, requestScopeKey: "thread:a" },
		};
		cacheSet(value.url, "readable", value);
		assert.equal(cacheGet(value.url, "readable", { credentialed: true, requestScopeKey: "thread:a" })?.title, "private");
		assert.equal(cacheGet(value.url, "readable", { credentialed: true, requestScopeKey: "thread:b" }), undefined);
		assert.equal(cacheGet(value.url, "readable", { credentialed: false, requestScopeKey: "thread:a" }), undefined);

		const privateResponse = {
			...value,
			url: "https://example.com/private",
			title: "private response",
			access: { network: "public" as const, credentialed: false, requestScopeKey: "thread:a" },
			cacheControl: "private, max-age=60",
		};
		cacheSet(privateResponse.url, "readable", privateResponse);
		assert.equal(cacheGet(privateResponse.url, "readable"), undefined);
		assert.equal(cacheGet(privateResponse.url, "readable", { requestScopeKey: "thread:a" })?.title, "private response");
	});
});

describe("fetchContent (local server)", () => {
	let server: TestServer;
	let hits = 0;
	let slowHits = 0;
	let etagHits = 0;
	let noStoreHits = 0;
	let alternateHits = 0;
	let noStoreAlternatePageHits = 0;
	let badAlternateHits = 0;
	let failingRevalidation = false;
	let alternateHangingHits = 0;
	let cancelAlternate: (() => void) | undefined;
	beforeAll(async () => {
		server = await startServer({
			"/page": (_req, res) => {
				hits++;
				html(res, `<html><head><title>Doc Title</title><meta name="description" content="A doc"></head><body><nav>Nav</nav><main><h1>Doc</h1><p>${"Paragraph text. ".repeat(30)}</p><pre><code class="language-js">let x = 1;</code></pre></main><footer>F</footer></body></html>`);
			},
			"/json": (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"a":1,"b":[1,2]}'); },
			"/text": (_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("# Heading\n\nplain"); },
			"/md": (_req, res) => { res.writeHead(200, { "content-type": "text/markdown" }); res.end("# Readme\n\nbody"); },
			"/alternate-page": (_req, res) => html(res, `<html><head><title>HTML title</title><link rel="alternate" type="text/markdown" href="/alternate.md"></head><body><main><h1>HTML fallback</h1><p>${"fallback ".repeat(40)}</p></main></body></html>`),
			"/alternate-no-store": (_req, res) => {
				noStoreAlternatePageHits++;
				html(res, `<html><head><title>Private HTML</title><link rel="alternate" type="text/markdown" href="/alternate-cacheable.md"></head><body><main><h1>Fallback</h1></main></body></html>`, 200, { "cache-control": "no-store" });
			},
			"/alternate-hanging-page": (_req, res) => html(res, '<link rel="alternate" type="text/markdown" href="/hanging.md"><main>HTML fallback</main>'),
			"/hanging.md": () => { alternateHangingHits++; cancelAlternate?.(); },
			"/alternate-budget-page": (_req, res) => html(res, '<link rel="alternate" type="text/markdown" href="/budget.md"><main>HTML fallback</main>'),
			"/budget.md": (_req, res) => { res.writeHead(200, { "content-type": "text/markdown" }); res.end("markdown ".repeat(1_000)); },
			"/alternate.md": (_req, res) => { alternateHits++; res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }); res.end("# Markdown alternate\n\ncode survives\n"); },
			"/alternate-cacheable.md": (_req, res) => { res.writeHead(200, { "content-type": "text/markdown", "cache-control": "max-age=600" }); res.end("# Cacheable alternate\n"); },
			"/header-alternate": (_req, res) => html(res, `<html><head><title>Header source</title></head><body><main><p>${"source ".repeat(40)}</p></main></body></html>`, 200, { link: '</alternate.md>; rel="alternate"; type="text/markdown"' }),
			"/bad-alternate": (_req, res) => html(res, `<html><head><title>Keep HTML</title><link rel="alternate" type="text/markdown" href="/not-markdown"></head><body><main><h1>Keep HTML</h1><p>${"body ".repeat(40)}</p></main></body></html>`),
			"/not-markdown": (_req, res) => { badAlternateHits++; html(res, `<html><body><p>Not markdown</p></body></html>`); },
			"/negotiated": (req, res) => {
				if ((req.headers.accept ?? "").startsWith("text/markdown")) {
					res.writeHead(200, { "content-type": "text/markdown", vary: "Accept" });
					res.end("# Negotiated markdown\n");
					return;
				}
				html(res, `<html><body><main><h1>HTML response</h1><p>${"html ".repeat(40)}</p></main></body></html>`);
			},
			"/octet-html": (_req, res) => { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end("<!doctype html><html><head><title>Sniffed</title></head><body><p>" + "sniffed body ".repeat(40) + "</p></body></html>"); },
			"/binary": (_req, res) => { res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])); },
			"/forbidden": (_req, res) => html(res, "<html><head><title>Login required</title></head><body>no</body></html>", 403),
			"/shell": (_req, res) => html(res, `<html><head><title>App</title><script src="1.js"></script><script src="2.js"></script><script src="3.js"></script></head><body><div id="root"></div></body></html>`),
			"/redirect": (_req, res) => { res.writeHead(302, { location: "/page" }); res.end(); },
			"/slow-page": (_req, res) => {
				slowHits++;
				setTimeout(() => { res.writeHead(200, { "content-type": "text/plain" }); res.end("shared response"); }, 120);
			},
			"/etag": (req, res) => {
				etagHits++;
				if (req.headers["if-none-match"] === '"v1"') {
					res.writeHead(304, { etag: '"v1"', "cache-control": "max-age=0" });
					res.end();
					return;
				}
				res.writeHead(200, { "content-type": "text/plain", etag: '"v1"', "cache-control": "max-age=0" });
				res.end("version one");
			},
			"/no-store": (_req, res) => {
				noStoreHits++;
				res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
				res.end("never cached");
			},
			"/etag-fail": (req, res) => {
				if (req.headers["if-none-match"] === '"f1"' && failingRevalidation) {
					res.writeHead(503, { "content-type": "text/plain" });
					res.end("unavailable");
					return;
				}
				res.writeHead(200, { "content-type": "text/plain", etag: '"f1"', "cache-control": "max-age=0" });
				res.end("old content");
			},
		});
	});
	afterAll(() => server.close());

	it("converts HTML to markdown with metadata, content root and timing", async () => {
		cacheClear();
		const r = await fetchContent(`${server.url}/page`, { mode: "readable", config: config(), requestScopeKey: "thread:test" });
		assert.equal(r.error, undefined);
		assert.equal(r.kind, "html");
		assert.equal(r.title, "Doc Title");
		assert.equal(r.description, "A doc");
		assert.equal(r.contentRoot, "main");
		assert.equal(r.status, 200);
		assert.match(r.content, /^# Doc\n\nParagraph text\./);
		assert.match(r.content, /```js\nlet x = 1;\n```$/);
		assert.doesNotMatch(r.content, /Nav|F$/);
		assert.equal(r.cached, false);
		assert.ok(r.durationMs >= 0);
	});
	it("serves repeat requests from cache and bypasses it with noCache", async () => {
		const before = hits;
		const r = await fetchContent(`${server.url}/page#frag`, { mode: "readable", config: config(), requestScopeKey: "thread:test" });
		assert.equal(r.cached, true);
		assert.equal(hits, before);
		const fresh = await fetchContent(`${server.url}/page`, { mode: "readable", config: config(), requestScopeKey: "thread:test", noCache: true });
		assert.equal(fresh.cached, false);
		assert.equal(hits, before + 1);
	});
	it("does not serve private cache entries after policy revocation", async () => {
		cacheClear();
		const warm = await fetchContent(`${server.url}/page`, { mode: "readable", config: config(), requestScopeKey: "thread:private" });
		assert.equal(warm.access?.network, "private");
		const blocked = await fetchContent(`${server.url}/page`, {
			mode: "readable",
			config: config({ allowPrivateNetwork: false }),
			requestScopeKey: "thread:private",
		});
		assert.equal(blocked.cached, false);
		assert.match(blocked.error ?? "", /Blocked address/);
	});
	it("revalidates stale entries without replacing original provenance", async () => {
		cacheClear();
		etagHits = 0;
		const first = await fetchContent(`${server.url}/etag`, { mode: "readable", config: config(), requestScopeKey: "thread:etag" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		const second = await fetchContent(`${server.url}/etag`, { mode: "readable", config: config(), requestScopeKey: "thread:etag" });
		assert.equal(etagHits, 2);
		assert.equal(second.content, "version one");
		assert.equal(second.cache, "revalidated");
		assert.equal(second.attempt?.httpStatus, 304);
		assert.equal(second.fetchedAt, first.fetchedAt);
		assert.notEqual(second.checkedAt, first.checkedAt);
	});
	it("honours no-store and does not silently return stale content on failure", async () => {
		cacheClear();
		noStoreHits = 0;
		await fetchContent(`${server.url}/no-store`, { mode: "readable", config: config(), requestScopeKey: "thread:no-store" });
		await fetchContent(`${server.url}/no-store`, { mode: "readable", config: config(), requestScopeKey: "thread:no-store" });
		assert.equal(noStoreHits, 2);

		failingRevalidation = false;
		const first = await fetchContent(`${server.url}/etag-fail`, { mode: "readable", config: config(), requestScopeKey: "thread:stale" });
		assert.equal(first.content, "old content");
		failingRevalidation = true;
		const failed = await fetchContent(`${server.url}/etag-fail`, { mode: "readable", config: config(), requestScopeKey: "thread:stale" });
		assert.equal(failed.status, 503);
		assert.equal(failed.content, "");
		assert.equal(failed.contentHash, undefined);
		assert.match(failed.error ?? "", /HTTP 503/);
	});
	it("coalesces compatible requests while keeping waiter cancellation independent", async () => {
		cacheClear();
		slowHits = 0;
		const cancelled = new AbortController();
		const first = fetchContent(`${server.url}/slow-page`, { mode: "readable", config: config(), requestScopeKey: "thread:coalesce", signal: cancelled.signal, noCache: true });
		const second = fetchContent(`${server.url}/slow-page`, { mode: "readable", config: config(), requestScopeKey: "thread:coalesce", noCache: true });
		setTimeout(() => cancelled.abort(), 20);
		const [a, b] = await Promise.all([first, second]);
		assert.match(a.error ?? "", /cancel/i);
		assert.equal(b.content, "shared response");
		assert.equal(slowHits, 1);

		slowHits = 0;
		await Promise.all([
			fetchContent(`${server.url}/slow-page`, { mode: "readable", config: config(), requestScopeKey: "thread:coalesce", byteBudget: createByteBudget(10_000), noCache: true }),
			fetchContent(`${server.url}/slow-page`, { mode: "readable", config: config(), requestScopeKey: "thread:coalesce", byteBudget: createByteBudget(10_000), noCache: true }),
		]);
		assert.equal(slowHits, 2, "different byte budgets are never coalesced");
	});
	it("returns raw HTML source in raw mode", async () => {
		const r = await fetchContent(`${server.url}/page`, { mode: "raw", config: config() });
		assert.equal(r.kind, "html");
		assert.match(r.content, /^<html><head><title>Doc Title<\/title>/);
	});
	it("preserves JSON text and passes text/markdown through", async () => {
		const j = await fetchContent(`${server.url}/json`, { mode: "readable", config: config() });
		assert.equal(j.kind, "json");
		assert.equal(j.content, '{"a":1,"b":[1,2]}');
		const t = await fetchContent(`${server.url}/text`, { mode: "readable", config: config() });
		assert.equal(t.kind, "text");
		assert.equal(t.title, "Heading");
		const m = await fetchContent(`${server.url}/md`, { mode: "readable", config: config() });
		assert.equal(m.kind, "markdown");
		assert.equal(m.title, "Readme");
	});
	it("prefers verified HTML markdown alternates and records provenance", async () => {
		cacheClear();
		alternateHits = 0;
		const result = await fetchContent(`${server.url}/alternate-page`, { mode: "readable", config: config(), noCache: true });
		assert.equal(result.kind, "markdown");
		assert.equal(result.finalUrl, `${server.url}/alternate.md`);
		assert.equal(result.content, "# Markdown alternate\n\ncode survives\n");
		assert.deepEqual(result.alternate, {
			source: "html-link",
			url: `${server.url}/alternate.md`,
			contentType: "text/markdown",
		});
		assert.equal(result.artifact?.requestedUrl, `${server.url}/alternate-page`);
		assert.equal(result.artifact?.resolvedUrl, `${server.url}/alternate.md`);
		assert.equal(alternateHits, 1);
	});
	it("preserves restrictive primary cache policy when using an alternate", async () => {
		cacheClear();
		noStoreAlternatePageHits = 0;
		const first = await fetchContent(`${server.url}/alternate-no-store`, { mode: "readable", config: config(), requestScopeKey: "thread:no-store-alt" });
		const second = await fetchContent(`${server.url}/alternate-no-store`, { mode: "readable", config: config(), requestScopeKey: "thread:no-store-alt" });
		assert.equal(first.kind, "markdown");
		assert.match(first.cacheControl ?? "", /no-store/);
		assert.equal(second.cached, false);
		assert.equal(noStoreAlternatePageHits, 2);
		assert.equal(cacheStats().entries, 0);
	});

	it("does not cache HTML fallback after a markdown alternate times out", async () => {
		cacheClear();
		alternateHangingHits = 0;
		for (let attempt = 0; attempt < 2; attempt++) {
			const deadline = createDeadline(2_000);
			try {
				const result = await fetchContent(`${server.url}/alternate-hanging-page`, {
					mode: "readable", config: config({ timeoutMs: 150 }), deadline, requestScopeKey: "thread:alt-timeout",
				});
				assert.equal(result.kind, "error");
				assert.equal(result.errorCode, "timeout");
				assert.equal(result.cached, false);
				assert.equal(cacheStats().entries, 0);
			} finally {
				deadline.dispose();
			}
		}
		assert.equal(alternateHangingHits, 2, "a later call retries the alternate");
	});

	it("does not cache HTML fallback after alternate cancellation or budget exhaustion", async () => {
		cacheClear();
		const controller = new AbortController();
		cancelAlternate = () => controller.abort();
		try {
			const cancelled = await fetchContent(`${server.url}/alternate-hanging-page`, {
				mode: "readable", config: config(), signal: controller.signal, requestScopeKey: "thread:alt-cancel",
			});
			assert.equal(cancelled.errorCode, "aborted");
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(cacheStats().entries, 0);
		} finally {
			cancelAlternate = undefined;
		}
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await fetchContent(`${server.url}/alternate-budget-page`, {
				mode: "readable", config: config(), byteBudget: createByteBudget(1_000), requestScopeKey: "thread:alt-budget",
			});
			assert.equal(result.kind, "error");
			assert.equal(result.errorCode, "budget");
			assert.equal(result.cached, false);
			assert.equal(cacheStats().entries, 0);
		}
	});

	it("does not invent a .md URL when no alternate is declared", async () => {
		cacheClear();
		const before = server.requests.length;
		const result = await fetchContent(`${server.url}/page`, { mode: "readable", config: config(), noCache: true });
		assert.equal(result.kind, "html");
		assert.deepEqual(server.requests.slice(before).map((request) => request.path), ["/page"]);
	});
	it("accepts verified HTTP Link alternates and markdown content negotiation", async () => {
		cacheClear();
		const linked = await fetchContent(`${server.url}/header-alternate`, { mode: "readable", config: config(), noCache: true });
		assert.equal(linked.alternate?.source, "http-link");
		assert.equal(linked.kind, "markdown");

		const negotiated = await fetchContent(`${server.url}/negotiated`, { mode: "readable", config: config(), noCache: true });
		assert.equal(negotiated.kind, "markdown");
		assert.equal(negotiated.alternate?.source, "content-negotiation");
		assert.equal(negotiated.finalUrl, `${server.url}/negotiated`);
	});
	it("does not trust mislabeled alternates or alter raw-mode semantics", async () => {
		cacheClear();
		badAlternateHits = 0;
		const readable = await fetchContent(`${server.url}/bad-alternate`, { mode: "readable", config: config(), noCache: true });
		assert.equal(readable.kind, "html");
		assert.equal(readable.title, "Keep HTML");
		assert.equal(badAlternateHits, 1);
		assert.ok(readable.warnings?.some((warning) => warning.code === "markdown-alternate-rejected"));

		alternateHits = 0;
		const raw = await fetchContent(`${server.url}/alternate-page`, { mode: "raw", config: config(), noCache: true });
		assert.equal(raw.kind, "html");
		assert.match(raw.content, /<link rel="alternate"/);
		assert.equal(raw.alternate, undefined);
		assert.equal(alternateHits, 0);
	});
	it("sniffs HTML served as octet-stream and rejects true binaries", async () => {
		const s = await fetchContent(`${server.url}/octet-html`, { mode: "readable", config: config() });
		assert.equal(s.kind, "html");
		assert.equal(s.title, "Sniffed");
		const b = await fetchContent(`${server.url}/binary`, { mode: "readable", config: config() });
		assert.equal(b.kind, "error");
		assert.match(b.error ?? "", /Unsupported binary content: image\/png/);
	});
	it("reports HTTP errors with page title and guidance", async () => {
		const r = await fetchContent(`${server.url}/forbidden`, { mode: "readable", config: config() });
		assert.equal(r.kind, "error");
		assert.equal(r.status, 403);
		assert.match(r.error ?? "", /HTTP 403.*"Login required".*Access denied/);
		const nf = await fetchContent(`${server.url}/missing`, { mode: "readable", config: config() });
		assert.match(nf.error ?? "", /HTTP 404.*does not exist/);
	});
	it("warns about JavaScript-rendered shells", async () => {
		const r = await fetchContent(`${server.url}/shell`, { mode: "readable", config: config() });
		assert.equal(r.error, undefined);
		assert.match(r.warning ?? "", /JavaScript-rendered/);
	});
	it("follows redirects and records the final URL", async () => {
		const r = await fetchContent(`${server.url}/redirect`, { mode: "readable", config: config() });
		assert.equal(r.finalUrl, `${server.url}/page`);
		assert.equal(r.redirects, 1);
	});
	it("returns a blocked error (not a throw) when private networks are disallowed", async () => {
		const r = await fetchContent(`${server.url}/page`, { mode: "readable", config: config({ allowPrivateNetwork: false }), noCache: true });
		assert.equal(r.kind, "error");
		assert.match(r.error ?? "", /Blocked address 127\.0\.0\.1/);
	});
	it("returns errors for invalid input without throwing", async () => {
		const r = await fetchContent("mailto:x@y.z", { mode: "readable", config: config() });
		assert.match(r.error ?? "", /Unsupported URL scheme/);
	});
});
