import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { fixtureRuntime } from "./runtime-helper.ts";
import { CONFIG_DEFAULTS } from "../src/web/config.ts";
import { doctor } from "../src/doctor.ts";
import { bench } from "../src/bench.ts";

describe("offline diagnostics and bounded keyless doctor", () => {
 it("does not dispatch by default and never retains configured secrets", async () => {
  const fake = createFakePluginHost();
  const runtime = fixtureRuntime(fake.bb, async () => ({ ...CONFIG_DEFAULTS, warnings: [], braveApiKey: "secret-brave", exaApiKey: "secret-exa", searxngUrl: "https://self.example" }));
  let calls = 0;
  const report = await doctor(runtime, false, undefined, async () => { calls++; throw new Error("not allowed"); });
  expect(calls).toBe(0); expect(JSON.stringify(report)).not.toContain("secret-"); expect(JSON.stringify(report)).not.toContain("https://");
  await fake.harness.lifecycle.dispose();
 });
 it("makes one logical probe for each allowed keyless provider with fresh bounded deadlines and no account keys", async () => {
  const fake = createFakePluginHost();
  const runtime = fixtureRuntime(fake.bb, async () => ({ ...CONFIG_DEFAULTS, warnings: [], searxngUrl: "https://self.example", braveApiKey: "brave", exaApiKey: "exa", tavilyApiKey: "tavily", firecrawlApiKey: "firecrawl", jinaApiKey: "jina" }));
  const providers: string[] = [];
  const report = await doctor(runtime, true, undefined, async (query, options, config, requested) => {
   providers.push(requested!); expect(options.context!.deadline.remainingMs()).toBeLessThanOrEqual(5000); expect(options.fallback).toBe(false);
   for (const key of ["braveApiKey", "exaApiKey", "tavilyApiKey", "firecrawlApiKey", "jinaApiKey"] as const) expect(config[key]).toBeUndefined();
   return { query, provider: requested as "exa", results: [], rawCount: 0, attempts: [], durationMs: 0, appliedControls: [], unsupportedControls: [], cached: false };
  });
  expect(providers).toEqual(["duckduckgo", "exa", "searxng"]); expect(report).toHaveProperty("probes");
  await fake.harness.lifecycle.dispose();
 });
 it("does not probe cloud providers under the private ceiling", async () => {
  const fake = createFakePluginHost();
  const runtime = fixtureRuntime(fake.bb, async () => ({ ...CONFIG_DEFAULTS, profile: "private", privacyProfile: "private", warnings: [], searxngUrl: "https://self.example" }));
  const providers: string[] = [];
  await doctor(runtime, true, undefined, async (_query, _options, _config, requested) => { providers.push(requested!); throw new Error("fixture upstream failure"); });
  expect(providers).toEqual(["searxng"]);
  await fake.harness.lifecycle.dispose();
 });
 it("extracts the inline benchmark corpus without filesystem or network access", () => {
  const result = bench(); expect(result.network).toBe(false); expect(result.cases).toHaveLength(3); expect(result.cases[0]!.tables).toBe(1); expect(result.cases[0]!.links).toBe(1); expect(result.cases.every(item => !item.truncated)).toBe(true);
 });
});
