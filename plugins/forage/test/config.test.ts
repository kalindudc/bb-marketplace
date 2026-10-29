import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { CONFIG_DEFAULTS, resolveConfig } from "../src/web/config.ts";

describe("provider configuration", () => {
	it("resolves provider, reader, backend and privacy ceilings", () => {
		const resolved = resolveConfig({
			profile: "docs",
			privacyProfile: "standard",
			allowedProviders: "exa, duckduckgo, exa",
			allowedReaders: "direct,jina",
			allowedBackends: "local,firecrawl",
			allowPaidProviderFallback: "true",
			exaApiKey: " exa-key ",
			tavilyApiKey: " tavily-key ",
			firecrawlApiKey: " firecrawl-key ",
			jinaApiKey: " jina-key ",
			searchCacheTtlMs: "45000",
			searchCacheMaxEntries: 12,
		});
		assert.equal(resolved.profile, "docs");
		assert.equal(resolved.privacyProfile, "standard");
		assert.deepEqual(resolved.allowedProviders, ["exa", "duckduckgo"]);
		assert.deepEqual(resolved.allowedReaders, ["direct", "jina"]);
		assert.deepEqual(resolved.allowedBackends, ["local", "firecrawl"]);
		assert.equal(resolved.allowPaidProviderFallback, true);
		assert.equal(resolved.exaApiKey, "exa-key");
		assert.equal(resolved.tavilyApiKey, "tavily-key");
		assert.equal(resolved.firecrawlApiKey, "firecrawl-key");
		assert.equal(resolved.jinaApiKey, "jina-key");
		assert.equal(resolved.searchCacheTtlMs, 45_000);
		assert.equal(resolved.searchCacheMaxEntries, 12);
		assert.deepEqual(resolved.warnings, []);
	});

	it("fails closed while retaining valid ceiling entries", () => {
		const resolved = resolveConfig({
			profile: "unknown",
			privacyProfile: "wide-open",
			allowedProviders: "searxng,unknown",
			allowedReaders: "direct,unknown",
			allowedBackends: "local,unknown",
			searchCacheTtlMs: 0,
			searchCacheMaxEntries: 5000,
		});
		assert.equal(resolved.profile, CONFIG_DEFAULTS.profile);
		assert.equal(resolved.privacyProfile, "private");
		assert.deepEqual(resolved.allowedProviders, ["searxng"]);
		assert.deepEqual(resolved.allowedReaders, ["direct"]);
		assert.deepEqual(resolved.allowedBackends, ["local"]);
		assert.equal(resolved.searchCacheTtlMs, CONFIG_DEFAULTS.searchCacheTtlMs);
		assert.equal(resolved.searchCacheMaxEntries, 256);
		assert.ok(resolved.warnings.length >= 5);
	});

	it("uses restrictive ceilings for blank or wholly invalid values", () => {
		const resolved = resolveConfig({
			allowedProviders: " , ",
			allowedReaders: "jinaa",
			allowedBackends: "locl",
		});
		assert.deepEqual(resolved.allowedProviders, ["duckduckgo", "exa"]);
		assert.deepEqual(resolved.allowedReaders, ["direct"]);
		assert.deepEqual(resolved.allowedBackends, ["local"]);
		assert.equal(resolved.warnings.length, 3);
	});
});
