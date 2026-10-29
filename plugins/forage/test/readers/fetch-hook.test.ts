import { afterEach, describe, expect, it } from "vitest";
import { fetchContent, cacheClear } from "../../src/web/fetch.ts";
import { CONFIG_DEFAULTS, resolveConfig } from "../../src/web/config.ts";
import { createByteBudget, createDeadline } from "../../src/web/deadline.ts";
import { SETTINGS } from "../../src/settings.ts";
import type { ProviderTransport } from "../../src/web/providers/http.ts";

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 as const }];
const config = { ...CONFIG_DEFAULTS, warnings: [], timeoutMs: 1000 };
afterEach(cacheClear);
function transport(reader: "jina" | "tavily" | "firecrawl", observed: string[], finalUrl = "https://public.example/final"): ProviderTransport {
 return async (url) => {
  observed.push(url);
  const payload = reader === "jina" ? { code: 200, data: { title: "Reader", url: finalUrl, content: "# Reader\n\n[Reference](/reference)" } } : reader === "tavily" ? { results: [{ url: finalUrl, raw_content: "# Reader" }], failed_results: [] } : { success: true, data: { markdown: "# Reader", metadata: { title: "Reader", statusCode: 200, url: finalUrl } } };
  return { response: new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } }), finalUrl: url, redirects: 0, acceptedRedirectBytes: 0, access: { network: "public", credentialed: reader !== "jina", requestScopeKey: null } };
 };
}

describe("explicit fetch reader hook", () => {
 it("keeps restricted capture default-off and does not infer it from private network access", () => {
  expect(SETTINGS.allowRestrictedThreadCapture.default).toBe(false);
  expect(resolveConfig().allowRestrictedThreadCapture).toBe(false);
  expect(resolveConfig({ allowPrivateNetwork: true }).allowRestrictedThreadCapture).toBe(false);
  expect(resolveConfig({ allowRestrictedThreadCapture: true }).allowRestrictedThreadCapture).toBe(true);
  expect(resolveConfig({ allowRestrictedThreadCapture: "invalid" }).allowRestrictedThreadCapture).toBe(false);
 });
 for (const reader of ["jina", "tavily", "firecrawl"] as const) it(`uses explicit ${reader} with real adapter parsing and provider provenance`, async () => {
  const observed: string[] = []; const deadline = createDeadline(1000); const budget = createByteBudget(10000);
  try {
   const page = await fetchContent("https://public.example/page", { mode: "readable", reader, config: { ...config, tavilyApiKey: "fixture-only", firecrawlApiKey: "fixture-only" }, deadline, byteBudget: budget, requestScopeKey: "thread:proj_a:thr_a" }, { resolver: publicResolver, readerTransport: transport(reader, observed) });
   expect(page.error).toBeUndefined(); expect(observed).toHaveLength(1); expect(page.content).toContain("# Reader"); expect(page.artifact?.transport).toBe("provider"); expect(page.artifact?.extraction.id).toContain(reader); expect(page.artifact?.structured?.headings[0]?.text).toBe("Reader"); expect(budget.remaining()).toBeLessThan(10000); expect(page.attempt?.transferredBytes).toBeGreaterThan(0);
  } finally { deadline.dispose(); }
 });
 it("rejects disallowed readers and raw/smart cloud reads before dispatch", async () => {
  const observed: string[] = [];
  for (const options of [
   { mode: "raw" as const, reader: "jina" as const, config },
   { mode: "readable" as const, resolve: "smart" as const, reader: "jina" as const, config },
   { mode: "readable" as const, reader: "jina" as const, config: { ...config, allowedReaders: ["direct" as const] } },
   { mode: "readable" as const, reader: "jina" as const, config: { ...config, privacyProfile: "private" as const, searxngUrl: "https://search.example" } },
  ]) {
   const page = await fetchContent("https://public.example/page", options, { resolver: publicResolver, readerTransport: transport("jina", observed) });
   expect(page.error).toContain("POLICY_BLOCKED");
  }
  expect(observed).toEqual([]);
 });
 it("never forwards unsafe or unresolvable targets even with local private access enabled", async () => {
  const observed: string[] = [];
  for (const url of ["http://127.0.0.1/private", "http://service.internal/", "https://public.example/page?%74oken=secret", "https://name:password@public.example/page"]) {
   const page = await fetchContent(url, { mode: "readable", reader: "jina", config: { ...config, allowPrivateNetwork: true } }, { resolver: publicResolver, readerTransport: transport("jina", observed) });
   expect(page.error).toContain("POLICY_BLOCKED"); expect(page.error).not.toContain("secret"); expect(page.error).not.toContain("password");
  }
  const unresolved = await fetchContent("https://unresolved.example/", { mode: "readable", reader: "jina", config }, { resolver: async () => { throw new Error("DNS fixture failure"); }, readerTransport: transport("jina", observed) });
  expect(unresolved.error).toContain("POLICY_BLOCKED"); expect(observed).toEqual([]);
 });
 it("rejects a remote private final URL and never returns its content or a snapshot", async () => {
  const observed: string[] = [];
  const page = await fetchContent("https://public.example/page", { mode: "readable", reader: "jina", config }, { resolver: publicResolver, readerTransport: transport("jina", observed, "http://127.0.0.1/private") });
  expect(observed).toHaveLength(1); expect(page.error).toContain("POLICY_BLOCKED"); expect(page.content).toBe(""); expect(page.artifact).toBeUndefined();
 });
 it("honors caller cancellation independently of a supplied deadline and shared payload exhaustion", async () => {
  const controller = new AbortController(); const deadline = createDeadline(1000);
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = fetchContent("https://public.example/page", { mode: "readable", reader: "jina", config, signal: controller.signal, deadline }, { resolver: publicResolver, readerTransport: async (_url, options) => {
   entered(); await new Promise<void>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(new Error("fixture cancelled")), { once: true }));
   throw new Error("unreachable");
  } });
  await started; controller.abort();
  const cancelled = await pending; expect(cancelled.error).toContain("cancelled"); expect(cancelled.artifact).toBeUndefined(); deadline.dispose();
  const budget = createByteBudget(5); const observed: string[] = [];
  const exhausted = await fetchContent("https://public.example/page", { mode: "readable", reader: "jina", config, byteBudget: budget }, { resolver: publicResolver, readerTransport: transport("jina", observed) });
  expect(exhausted.errorCode).toBe("budget"); expect(exhausted.artifact).toBeUndefined(); expect(observed).toHaveLength(1);
 });
 it("does not share a reader response with a direct request or a different reader", async () => {
  const observed: string[] = [];
  for (const reader of ["jina", "firecrawl"] as const) {
   const page = await fetchContent("https://public.example/page", { mode: "readable", reader, config: { ...config, firecrawlApiKey: "fixture-only" } }, { resolver: publicResolver, readerTransport: transport(reader, observed) });
   expect(page.error).toBeUndefined(); expect(page.artifact?.extraction.id).toContain(reader);
  }
  expect(observed).toHaveLength(2);
 });
});
