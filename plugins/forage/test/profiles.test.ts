import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { CONFIG_DEFAULTS, type WebConfig } from "../src/web/config.ts";
import { PolicyError, resolvePolicy } from "../src/profiles.ts";

function config(overrides: Partial<WebConfig> = {}): WebConfig {
	return { ...CONFIG_DEFAULTS, warnings: [], ...overrides };
}

describe("provider policy profiles", () => {
	it("does not enable billable fallback merely because keys are configured", () => {
		const resolved = resolvePolicy(config({ braveApiKey: "brave", tavilyApiKey: "tavily" }), {});
		assert.deepEqual(resolved.providers, ["duckduckgo", "exa"]);
	});

	it("uses paid providers only after the setting explicitly permits fallback", () => {
		const resolved = resolvePolicy(config({
			profile: "fresh",
			allowPaidProviderFallback: true,
			braveApiKey: "brave",
			tavilyApiKey: "tavily",
		}), {});
		assert.deepEqual(resolved.providers, ["brave", "exa", "tavily"]);
		assert.equal(resolved.strictRecency, true);
	});

	it("intersects profile chains with the setting-level allowed-provider ceiling", () => {
		const resolved = resolvePolicy(config({ allowedProviders: ["exa", "searxng"], searxngUrl: "https://search.example" }), { profile: "docs" });
		assert.deepEqual(resolved.providers, ["exa"]);
	});

	it("drops unconfigured fallback providers after an explicit provider", () => {
		const resolved = resolvePolicy(config(), { provider: "exa", fallback: true });
		assert.deepEqual(resolved.providers, ["exa", "duckduckgo"]);
	});

	it("allows a request to narrow standard policy to private", () => {
		const resolved = resolvePolicy(config({ searxngUrl: "https://search.example" }), { profile: "private" });
		assert.deepEqual(resolved.providers, ["searxng"]);
		assert.deepEqual(resolved.readers, ["direct"]);
		assert.deepEqual(resolved.backends, ["local"]);
	});

	it("makes private the effective default when only the privacy ceiling is configured", () => {
		const resolved = resolvePolicy(config({ privacyProfile: "private", searxngUrl: "https://search.example" }), {});
		assert.equal(resolved.profile, "private");
		assert.deepEqual(resolved.providers, ["searxng"]);
		assert.deepEqual(resolved.readers, ["direct"]);
		assert.deepEqual(resolved.backends, ["local"]);
	});

	it("never lets explicit per-call selectors widen a configured private ceiling", () => {
		const privateConfig = config({ privacyProfile: "private", searxngUrl: "https://search.example" });
		assert.throws(() => resolvePolicy(privateConfig, { profile: "auto" }), PolicyError);
		assert.throws(() => resolvePolicy(privateConfig, { profile: "deep" }), PolicyError);
		assert.throws(() => resolvePolicy(privateConfig, { provider: "duckduckgo" }), PolicyError);
		assert.throws(() => resolvePolicy(privateConfig, { reader: "jina" }), PolicyError);
		assert.throws(() => resolvePolicy(privateConfig, { backend: "firecrawl" }), PolicyError);
	});
});
