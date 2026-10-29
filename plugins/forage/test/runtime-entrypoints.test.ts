import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { fixtureRuntime } from "./runtime-helper.ts";
import { registerTools } from "../src/tools.ts";
import { createCli } from "../src/cli.ts";
import { CONFIG_DEFAULTS, type WebConfig } from "../src/web/config.ts";
import { artifact, attempt, threadScope } from "./sources/helpers.ts";
import type { FetchedContent } from "../src/web/fetch.ts";
import type { RuntimeDependencies } from "../src/operations.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function config(overrides: Partial<WebConfig> = {}): WebConfig { return { ...CONFIG_DEFAULTS, warnings: [], ...overrides }; }
function page(content = "# Example\n\nBody") : FetchedContent {
 const a = artifact(content, { fetchedAt: new Date().toISOString() });
 return { url: a.requestedUrl, finalUrl: a.finalUrl, title: a.title, content, kind: "markdown", contentType: a.contentType, status: 200, bytes: a.bytes, durationMs: 1, redirects: 0, cached: false, artifact: a, attempt: attempt(), contentHash: a.contentHash, access: a.access };
}
function host(overrides: Partial<RuntimeDependencies> = {}, settings: Partial<WebConfig> = {}) {
 const fake = createFakePluginHost({ pluginId: "forage", experimental_declaredIconNames: ["search", "fetch", "map", "extract", "crawl", "diff"] });
 const runtime = fixtureRuntime(fake.bb, async () => config(settings), overrides);
 registerTools(fake.bb, runtime); fake.bb.cli.register(createCli(runtime));
 cleanups.push(() => fake.harness.lifecycle.dispose());
 return { ...fake, runtime };
}
function text(result: unknown): string { return JSON.stringify(result); }
const flags = ["--project", "proj_a", "--thread", "thr_a"];

describe("shared native tool and CLI runtime", () => {
 it("captures before rendering and exposes tool diagnostics in CLI status", async () => {
  const fake = host({ fetch: async () => page("# Saved\n\n" + "body ".repeat(300)) });
  const result = await fake.harness.behavior.callAgentTool("web_fetch", { url: "https://example.com/docs", maxChars: 200 }, { projectId: "proj_a", threadId: "thr_a" });
  expect(text(result)).toContain("snapshotId=");
  const saved = fake.runtime.sources.list({ scope: threadScope(), limit: 10 });
  expect(saved.sources).toHaveLength(1);
  expect(fake.runtime.sources.getSnapshot(threadScope(), saved.sources[0]!.latestSnapshot!.id)?.content.length).toBeGreaterThan(1000);
  const status = await fake.harness.behavior.runCli(["status"]);
  expect(status.stdout).toContain('"diagnostics": 1');
  const diagnostics = await fake.harness.behavior.runCli(["diagnostics"]);
  expect(diagnostics.stdout).toContain('"operation": "fetch"');
  expect(diagnostics.stdout).not.toContain("example.com");
  expect(diagnostics.stdout).not.toContain("body");
 });
 it("supports immutable paging after cache clearing and refuses stale or wrong-scope IDs", async () => {
  let calls = 0;
  const fake = host({ fetch: async () => { calls++; return page(); } });
  await fake.runtime.executeFetch({ url: "https://example.com/docs" }, { scope: threadScope(), signal: new AbortController().signal });
  const snapshot = fake.runtime.sources.list({ scope: threadScope(), limit: 10 }).sources[0]!.latestSnapshot!;
  fake.runtime.cache.clear();
  const command = await fake.harness.behavior.runCli(["fetch", ...flags, "--input", JSON.stringify({ snapshotId: snapshot.id, contentHash: snapshot.contentHash, offset: 2 })]);
  expect(command.exitCode).toBe(0); expect(calls).toBe(1);
  const stale = await fake.harness.behavior.runCli(["fetch", ...flags, "--input", JSON.stringify({ snapshotId: snapshot.id, contentHash: "0".repeat(64) })]);
  expect(stale.exitCode).toBe(1); expect(stale.stderr).toContain("STALE_CONTENT");
  await expect(fake.runtime.executeFetch({ snapshotId: snapshot.id }, { scope: threadScope("other"), signal: new AbortController().signal })).rejects.toThrow("SOURCE_NOT_VISIBLE");
 });
 it("enforces provider, reader, backend and profile ceilings before all six tool and CLI entrypoints", async () => {
  let network = 0;
  const fake = host({ fetch: async () => { network++; return page(); }, search: async () => { network++; throw new Error("must not dispatch"); } }, { profile: "private", privacyProfile: "private", provider: "searxng", searxngUrl: "https://self-hosted.example", allowedProviders: ["searxng"], allowedReaders: ["direct"], allowedBackends: ["local"] });
  for (const name of ["search", "fetch", "map", "extract", "crawl", "diff"]) {
   for (const denied of [{ provider: "exa" }, { reader: "jina" }, { backend: "firecrawl" }, { profile: "deep" }]) {
    const input = { ...(name === "search" ? { query: "private text" } : { url: "https://example.com/docs" }), ...denied };
    const tool = await fake.harness.behavior.callAgentTool(`web_${name}`, input);
    expect(text(tool)).toContain("POLICY_BLOCKED");
    const cli = await fake.harness.behavior.runCli([name, ...(name === "crawl" ? ["start"] : []), ...flags, "--input", JSON.stringify(input)]);
    expect(cli.exitCode).toBe(1); expect(cli.stderr).toContain("POLICY_BLOCKED");
   }
  }
  expect(network).toBe(0); expect(fake.runtime.diagnostics.snapshot()).toHaveLength(48);
 });
 it("allows private page-only operations without SearXNG but still blocks private search and cloud selectors", async () => {
  let queries = 0;
  const fake = host({ fetch: async () => page(), search: async () => { queries++; throw new Error("must not search"); } }, { profile: "private", privacyProfile: "private", provider: "auto", allowedProviders: [], allowedReaders: ["direct"], allowedBackends: ["local"] });
  fake.runtime.jobs.list = () => ({ jobs: [], nextCursor: null });
  const before = fake.runtime.sources.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("# Before"), attempt: attempt() });
  const after = fake.runtime.sources.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("# After"), attempt: attempt() });
  for (const [name, input] of Object.entries({ fetch: { url: "https://example.com/docs" }, map: { url: "https://example.com", maxIndexDocuments: 1 }, extract: { url: "https://example.com/docs", fields: ["headings"] }, crawl: { action: "list" }, diff: { beforeSnapshotId: before.snapshotId, afterSnapshotId: after.snapshotId } })) {
   const tool = await fake.harness.behavior.callAgentTool(`web_${name}`, input, { projectId: "proj_a", threadId: "thr_a" });
   expect(text(tool)).not.toContain("POLICY_BLOCKED"); expect(tool).not.toHaveProperty("isError", true);
   const cli = await fake.harness.behavior.runCli([name, ...(name === "crawl" ? ["list"] : []), ...flags, "--input", JSON.stringify(input)]);
   expect(cli.exitCode, cli.stderr).toBe(0);
   for (const denied of [{ reader: "jina" }, { provider: "exa" }, { backend: "firecrawl" }, { profile: "deep" }]) {
    const result = await fake.harness.behavior.runCli([name, ...(name === "crawl" ? ["list"] : []), ...flags, "--input", JSON.stringify({ ...input, ...denied })]);
    expect(result.exitCode).toBe(1); expect(result.stderr).toContain("POLICY_BLOCKED");
   }
  }
  const search = await fake.harness.behavior.runCli(["search", ...flags, "--input", '{"query":"private query"}']);
  expect(search.exitCode).toBe(1); expect(search.stderr).toContain("POLICY_BLOCKED"); expect(queries).toBe(0);
 });
 it("gives content targets fresh deadlines after the entire search phase and shares their byte budget", async () => {
  const remaining: number[] = []; const budgets: unknown[] = [];
  const fake = host({ search: async (query, options) => {
   budgets.push(options.context?.byteBudget);
   await new Promise(resolve => setTimeout(resolve, query === "slow" ? 60 : 2));
   return { query, provider: "duckduckgo", results: [{ title: query, url: `https://${query}.example/docs`, snippet: "fixture" }], rawCount: 1, durationMs: 1, attempts: [], appliedControls: [], unsupportedControls: [], cached: false };
  }, fetch: async (_url, options) => { remaining.push(options.deadline!.remainingMs()); budgets.push(options.byteBudget); return page(); } }, { timeoutMs: 80, concurrency: 2 });
  const result = await fake.harness.behavior.runCli(["search", ...flags, "--input", JSON.stringify({ queries: ["fast", "slow"], includeContent: true })]);
  expect(result.exitCode).toBe(0); expect(remaining).toHaveLength(2); expect(Math.min(...remaining)).toBeGreaterThan(50); expect(new Set(budgets).size).toBe(1);
 });
 it("does not fabricate source IDs for capture-refused public sensitive or restricted pages", async () => {
  const fake = host({ fetch: async () => page("https://example.com/?token=secret") });
  const result = await fake.runtime.executeFetch({ url: "https://example.com/docs" }, { scope: threadScope(), signal: new AbortController().signal });
  expect(result.text).toContain("Not persisted"); expect(result.text).not.toContain("snapshotId=");
  expect(fake.runtime.sources.list({ scope: threadScope(), limit: 10 }).sources).toEqual([]);
 });
 it("fences in-flight captures when a thread or its project is cleared", async () => {
  for (const project of [false, true]) {
   let release!: () => void; let started!: () => void;
   const dispatched = new Promise<void>(resolve => { started = resolve; });
   const delayed = new Promise<void>(resolve => { release = resolve; });
   const fake = host({ fetch: async () => { started(); await delayed; return page(); } });
   const pending = fake.runtime.executeFetch({ url: "https://example.com/docs" }, { scope: threadScope(), signal: new AbortController().signal });
   await dispatched;
   fake.runtime.fenceScope(project ? { kind: "project", projectId: "proj_a" } : threadScope());
   release();
   await expect(pending).rejects.toThrow("Scope was cleared or deleted");
   expect(fake.runtime.sources.list({ scope: threadScope(), limit: 10 }).sources).toEqual([]);
   expect(fake.runtime.diagnostics.snapshot().at(-1)?.status).toBe("cancelled");
  }
 });
 it("revokes restricted snapshot reads immediately when capture is disabled", async () => {
  let enabled = true;
  const restricted = page(); restricted.artifact!.access = { network: "private", credentialed: false, requestScopeKey: "thread:proj_a:thr_a" };
  const fake = host({ fetch: async () => restricted, allowRestrictedThreadCapture: () => enabled }, { allowPrivateNetwork: true });
  const context = { scope: threadScope(), signal: new AbortController().signal };
  await fake.runtime.executeFetch({ url: "https://example.com/docs" }, context);
  const id = fake.runtime.sources.list({ scope: threadScope(), limit: 10 }).sources[0]!.latestSnapshot!.id;
  expect((await fake.runtime.executeFetch({ snapshotId: id }, context)).text).toContain("Body");
  enabled = false;
  await expect(fake.runtime.executeFetch({ snapshotId: id }, context)).rejects.toThrow("SOURCE_NOT_VISIBLE");
  const hidden = await fake.harness.behavior.runCli(["sources", "list", ...flags]);
  expect(hidden.stdout).not.toContain(id);
 });
 it("compares a capture-refused refresh in memory without a fabricated snapshot ID", async () => {
  let content = "# Baseline\n\nOriginal body";
  const fake = host({ fetch: async () => page(content) });
  const context = { scope: threadScope(), signal: new AbortController().signal };
  await fake.runtime.executeFetch({ url: "https://example.com/docs" }, context);
  const baseline = fake.runtime.sources.list({ scope: threadScope(), limit: 10 }).sources[0]!;
  content = "# Baseline\n\nChanged body https://example.com/?token=secret";
  const result = await fake.runtime.executeDiff({ beforeSnapshotId: baseline.latestSnapshot!.id, url: "https://example.com/docs" }, context);
  expect(result.details).toMatchObject({ persisted: false, afterSnapshotId: null, unchanged: false });
  expect(fake.runtime.sources.get(threadScope(), baseline.id)!.snapshots.items).toHaveLength(1);
 });
 it("rejects missing CLI scope and bad/unknown parameters without network", async () => {
  const fake = host({ fetch: async () => { throw new Error("must not dispatch"); } });
  expect((await fake.harness.behavior.runCli(["fetch", "--input", "{}"])) .exitCode).toBe(1);
  expect((await fake.harness.behavior.runCli(["fetch", ...flags, "--input", '{"invented":true}'])) .exitCode).toBe(1);
  const doctor = await fake.harness.behavior.runCli(["doctor"]); expect(doctor.exitCode).toBe(0); expect(doctor.stdout).toContain('"mode": "offline"');
  const bench = await fake.harness.behavior.runCli(["bench"]); expect(bench.exitCode).toBe(0); expect(bench.stdout).toContain('"network": false');
 });
});
