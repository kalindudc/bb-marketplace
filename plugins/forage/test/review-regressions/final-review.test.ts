import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { fixtureRuntime } from "../runtime-helper.ts";
import { CONFIG_DEFAULTS } from "../../src/web/config.ts";
import { artifact, attempt, createRepository, threadScope } from "../sources/helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const cases: Array<{ name: string; documents: Record<string, string>; methods: string[] }> = [
 { name: "HTML links", documents: { "/": '<html><body><a href="/ordinary-page">Page</a></body></html>' }, methods: ["html-link"] },
 { name: "mixed discovery methods", documents: {
  "/robots.txt": "User-agent: *\nAllow: /\nSitemap: https://example.com/robots-map.xml",
  "/robots-map.xml": "<urlset><url><loc>https://example.com/from-robots</loc></url></urlset>",
  "/sitemap.xml": "<sitemapindex><sitemap><loc>https://example.com/nested.xml</loc></sitemap></sitemapindex>",
  "/nested.xml": "<urlset><url><loc>https://example.com/from-index</loc></url></urlset>",
  "/sitemap_index.xml": "<urlset><url><loc>https://example.com/from-sitemap</loc></url></urlset>",
  "/llms.txt": "- [LLM page](https://example.com/from-llms)",
 }, methods: ["llms", "robots", "sitemap", "sitemap-index"] },
];

describe("independent final review regressions", () => {
 for (const scenario of cases) it(`maps and persists ${scenario.name} without losing discovery provenance`, async () => {
  const fake = createFakePluginHost({ pluginId: "forage-review" });
  const runtime = fixtureRuntime(fake.bb, async () => ({ ...CONFIG_DEFAULTS, warnings: [] }), {
   fetch: async url => {
    const content = scenario.documents[new URL(url).pathname];
    const status = content === undefined ? 404 : 200;
    const a = artifact(content ?? "", { requestedUrl: url, resolvedUrl: url, finalUrl: url, representation: "raw" });
    return { url, finalUrl: url, title: "Fixture", content: a.content, kind: a.kind, contentType: "text/plain", status, bytes: a.bytes, durationMs: 1, redirects: 0, cached: false, access: a.access,
     attempt: attempt({ httpStatus: status }), ...(content === undefined ? { error: "Not found" } : { artifact: a }) };
   },
  });
  cleanups.push(() => fake.harness.lifecycle.dispose());
  const record = vi.spyOn(runtime.sources, "recordDiscovery");
  const result = await runtime.executeMap({ url: "https://example.com/" }, { scope: threadScope(), signal: new AbortController().signal });
  const discovered = JSON.parse(result.text) as { urls: Array<{ method: string }> };
  expect(discovered.urls).toHaveLength(scenario.methods.length);
  expect(discovered.urls.map(url => url.method).sort()).toEqual(scenario.methods);
  expect(record.mock.calls.map(([input]) => input.method).sort()).toEqual(scenario.methods);
  for (const [input] of record.mock.calls) expect(input.urls.every(url => url.method === input.method)).toBe(true);
 });

 it("keeps cached older content from reversing latest or blocking a newer network observation", () => {
  const { repository, db } = createRepository();
  cleanups.push(async () => { db.close(); });
  const oldArtifact = artifact("A", { title: "Old title" });
  const old = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: oldArtifact, attempt: attempt({ startedAt: 100, finishedAt: 100 }) });
  const current = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("B", { title: "New title" }), attempt: attempt({ startedAt: 200, finishedAt: 200 }) });
  const cached = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: oldArtifact, attempt: attempt({ startedAt: 400, finishedAt: 400, cache: "hit", transferredBytes: 0 }) });
  assert.equal(cached.snapshotId, old.snapshotId);
  assert.equal(repository.get(threadScope(), old.sourceId!)?.latestSnapshot?.id, current.snapshotId);
  assert.equal(repository.get(threadScope(), old.sourceId!)?.title, "New title");
  const pair = repository.snapshotPair(threadScope(), { sourceId: old.sourceId! });
  assert.equal(pair?.before.id, old.snapshotId);
  assert.equal(pair?.after.id, current.snapshotId);
  const newer = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("C"), attempt: attempt({ startedAt: 300, finishedAt: 300 }) });
  assert.equal(repository.get(threadScope(), old.sourceId!)?.latestSnapshot?.id, newer.snapshotId);
  const nextPair = repository.snapshotPair(threadScope(), { sourceId: old.sourceId! });
  assert.equal(nextPair?.before.id, current.snapshotId);
  assert.equal(nextPair?.after.id, newer.snapshotId);
 });
});
