import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { SETTINGS, configFromSettings } from "../src/settings.ts";

describe("provider settings", () => {
	it("marks every provider credential as a secret", () => {
		for (const name of ["braveApiKey", "exaApiKey", "tavilyApiKey", "firecrawlApiKey", "jinaApiKey"] as const) {
			assert.equal(SETTINGS[name].secret, true, name);
		}
	});

	it("exposes explicit policy and paid-fallback controls", () => {
		assert.equal(SETTINGS.profile.type, "select");
		assert.equal(SETTINGS.privacyProfile.type, "select");
		assert.equal(SETTINGS.allowedProviders.type, "string");
		assert.equal(SETTINGS.allowedReaders.type, "string");
		assert.equal(SETTINGS.allowedBackends.type, "string");
		assert.equal(SETTINGS.allowPaidProviderFallback.default, false);
	});

	it("passes policy settings through configuration resolution", () => {
		const config = configFromSettings({ profile: "private", privacyProfile: "private", allowedProviders: "searxng", searxngUrl: "https://search.example" });
		assert.equal(config.profile, "private");
		assert.equal(config.privacyProfile, "private");
		assert.deepEqual(config.allowedProviders, ["searxng"]);
	});
});
