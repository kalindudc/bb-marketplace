// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import app from "../../app.tsx";
import { createServerRuntime } from "../../server.ts";
import { rpcContract } from "../../src/ui/contract.ts";
import { resetResearchPlaces, ResearchView } from "../../src/ui/research.tsx";
import { CiteDirective, policyAction } from "../../src/ui/chat.tsx";
import { ResearchPage } from "../../src/ui/page.tsx";
import { Reader } from "../../src/ui/reader.tsx";
import { artifact, attempt } from "../sources/helpers.ts";
import type { FetchedContent } from "../../src/web/fetch.ts";
import type { SearchResponse } from "../../src/web/search.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); resetResearchPlaces(); });
const scope = { kind: "thread", projectId: "proj_a", threadId: "thr_a" } as const;
const DOC = "# Performance\n\nWorkers **LISTEN** on a channel.\n\n## Connection poolers\n\nPgBouncer in transaction mode does not support LISTEN.\nGive workers a direct connection.";
const LONG = Array.from({ length: 900 }, (_, i) => `Line ${i + 1} of the long page.`).join("\n");
function page(url: string): FetchedContent {
 const DOCUMENT = url.includes("long") ? LONG : DOC;
 const a = artifact(DOCUMENT, { requestedUrl: url, resolvedUrl: url, finalUrl: url, title: "Performance", fetchedAt: new Date().toISOString(), structured: { schemaVersion: 1, title: "Performance", description: "", canonicalUrl: url, language: "en", headings: [], links: [], tables: [], jsonLd: [] } });
 return { url, finalUrl: url, title: "Performance", content: DOCUMENT, kind: "markdown", contentType: "text/markdown", status: 200, bytes: a.bytes, durationMs: 1, redirects: 0, cached: false, artifact: a, attempt: attempt(), contentHash: a.contentHash, access: a.access };
}
const searched = (query: string): SearchResponse => ({ query, provider: "duckduckgo", rawCount: 2, durationMs: 3, attempts: [], appliedControls: [], unsupportedControls: [], cached: false,
 results: [{ title: "Performance", url: "https://worker.example/docs/performance", snippet: "" }, { title: "Releases", url: "https://worker.example/releases", snippet: "" }] });

async function server() {
 const fake = createFakePluginHost({ pluginId: "forage", agentSkillIds: ["forage", "forage-research"], experimental_declaredIconNames: ["forage", "search", "fetch", "map", "extract", "crawl", "diff"] });
 fake.harness.sdk.stub("projects.get", async ({ projectId }) => ({ id: projectId, name: "Acme API", createdAt: 1, updatedAt: 1, gitRemoteUrl: null, kind: "standard", sources: [] }));
 fake.harness.sdk.stub("threads.get", async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "proj_a", title: "Pick a job queue" }));
 fake.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
 fake.harness.sdk.stub("threads.experimental_listPluginMetadata", async () => ({ threads: [] }));
 cleanups.push(() => fake.harness.lifecycle.dispose());
 await createServerRuntime(fake.bb, { search: async (query) => searched(query), fetch: async (url) => page(url) });
 const rpc = Object.fromEntries(Object.keys(rpcContract).map((method) => [method, (input: unknown) => fake.harness.behavior.callRpc(method, input)])) as unknown as PluginRpcTestHandlers<typeof rpcContract>;
 const tool = (name: string, input: unknown) => fake.harness.behavior.callAgentTool(name, input, { projectId: "proj_a", threadId: "thr_a" });
 return { fake, rpc, tool };
}
function mount<P extends object>(component: React.ComponentType<P>, props: P, rpc: PluginRpcTestHandlers<typeof rpcContract>) {
 const view = renderSlot({ component }, props, { pluginId: "forage", rpc, experimental_rpcContract: rpcContract, context: { projectId: "proj_a", threadId: "thr_a" }, sdk: { threads: { get: async () => makeThreadResponse({ id: "thr_a", projectId: "proj_a" }) } } as never });
 cleanups.push(() => view.unmount());
 return view;
}

describe("Forage frontend", () => {
 it("registers the per-thread surfaces and keeps the ids people already have open", async () => {
  const loaded = await loadPluginApp(app);
  expect(loaded.navPanels).toEqual([expect.objectContaining({ id: "sources", path: "sources", title: "Research", icon: "forage/forage" })]);
  expect(loaded.tabs).toEqual(expect.arrayContaining([
   expect.objectContaining({ id: "sources", title: "Research", context: { kind: "thread" }, availability: "fixed" }),
   expect.objectContaining({ id: "check", context: { kind: "thread" }, availability: "action" }),
  ]));
  expect(loaded.messageDirectives.map((d) => d.id).sort()).toEqual(["forage-cite", "forage-sources"]);
  expect(loaded.messageActions.map((a) => a.id)).toEqual(["check-in-sources"]);
  expect(loaded.threadHeaderActions).toHaveLength(1);
  expect(loaded.threadContextSegments).toHaveLength(1);
  expect(loaded.threadInfoSections).toHaveLength(1);
  expect(loaded.threadActions.map((a) => a.id)).toEqual(["web-research"]);
  expect(loaded.browserToolbarActions.map((a) => a.id)).toEqual(["save"]);
  expect(loaded.contentScripts).toHaveLength(0);
 });

 it("shows the thread's activity, lets a person read a result, and opens kept text in the reader", async () => {
  const { rpc, tool } = await server();
  await tool("web_search", { query: "pg-boss vs graphile-worker" });
  await tool("web_fetch", { url: "https://worker.example/docs/performance" });
  const view = mount(ResearchView, { scope, variant: "panel", canQuote: false }, rpc);
  expect(await view.findByText("Searched “pg-boss vs graphile-worker”")).toBeTruthy();
  expect(await view.findByText(/1 search · 1 page read · 1 source/u)).toBeTruthy();
  fireEvent.click(view.getByText("Searched “pg-boss vs graphile-worker”"));
  const query = await view.findByText("“pg-boss vs graphile-worker”");
  const results = query.closest("div.overflow-hidden") as HTMLElement;
  expect(within(results).getByText("Read")).toBeTruthy();
  fireEvent.click(within(results).getByRole("button", { name: /Read now/u }));
  await waitFor(() => expect(view.inspection.rpcCalls.some((call) => call.method === "run")).toBe(true));
  expect(await view.findByText(/You read/u)).toBeTruthy();
  fireEvent.click(view.getByRole("tab", { name: /Sources/u }));
  fireEvent.click((await view.findAllByRole("button", { name: /Performance/u }))[0]!);
  expect(await view.findByText("PgBouncer in transaction mode does not support LISTEN.")).toBeTruthy();
  fireEvent.click(view.getByText("PgBouncer in transaction mode does not support LISTEN."));
  expect(view.queryByRole("button", { name: "Quote in message" })).toBeNull();
  fireEvent.click(await view.findByRole("button", { name: "Copy citation" }));
  await waitFor(() => expect(view.inspection.experimental_clipboardWrites.at(-1)).toMatchObject({ text: expect.stringContaining("lines 7–8") }));
 });

 it("quotes selected lines into the thread's composer", async () => {
  const { rpc, tool } = await server();
  await tool("web_fetch", { url: "https://worker.example/docs/performance" });
  const view = mount(ResearchView, { scope, variant: "panel", canQuote: true }, rpc);
  fireEvent.click(await view.findByRole("tab", { name: /Sources/u }));
  fireEvent.click(await view.findByRole("button", { name: /Performance/u }));
  fireEvent.click(await view.findByText("Give workers a direct connection."));
  fireEvent.click(await view.findByRole("button", { name: "Quote in message" }));
  await waitFor(() => expect(view.inspection.composer.text).toContain("> Give workers a direct connection."));
  expect(view.inspection.composer.text).toMatch(/Forage snapshot \S+, lines 7–8/u);
 });

 it("renders a citation card from a reply and records the citation", async () => {
  const { rpc, tool } = await server();
  await tool("web_fetch", { url: "https://worker.example/docs/performance" });
  const sources = await rpc.listResearchSources({ scope, filter: "all", limit: 10 }) as { sources: Array<{ latestSnapshotId: string; id: string }> };
  const snapshot = sources.sources[0]!.latestSnapshotId;
  const view = mount(CiteDirective, { attributes: { snapshot, lines: "3" }, source: "", message: { id: "msg_1", threadId: "thr_a", turnId: null, projectId: "proj_a" }, openWorkspaceFile: null }, rpc);
  const card = await view.findByRole("button", { name: /Performance/u });
  expect(card.textContent).toContain("“Workers LISTEN on a channel.”");
  expect(card.getAttribute("data-forage-cite")).toBe(`${snapshot}:3-3`);
  await waitFor(async () => expect(((await rpc.listResearchSources({ scope, filter: "cited", limit: 10 })) as { counts: { cited: number } }).counts.cited).toBe(1));
  fireEvent.click(card);
  expect(view.inspection.experimental_tabOpenCalls.at(-1)).toMatchObject({ tab: { id: "sources", availability: "fixed" } });
 });

 it("opens a citation deep in a long page and pages the reader in windows", async () => {
  const { rpc, tool } = await server();
  await tool("web_fetch", { url: "https://worker.example/long" });
  const sources = await rpc.listResearchSources({ scope, filter: "all", limit: 10 }) as { sources: Array<{ id: string }> };
  const view = mount(Reader, { scope, sourceId: sources.sources[0]!.id, lines: [850, 851], backLabel: "Sources", onBack: () => undefined, canQuote: false }, rpc);
  expect(await view.findByText("Line 850 of the long page.")).toBeTruthy();
  expect(view.queryByText("Line 1 of the long page.")).toBeNull();
  fireEvent.click(await view.findByRole("button", { name: /Show lines 410–809/u }));
  expect(await view.findByText("Line 410 of the long page.")).toBeTruthy();
  fireEvent.change(view.getByLabelText("Find in page"), { target: { value: "Line 5 of" } });
  fireEvent.keyDown(view.getByLabelText("Find in page"), { key: "Enter" });
  expect(await view.findByText("Line 5 of the long page.")).toBeTruthy();
 });

 it("does not quote or record a citation whose phrase is not on the page", async () => {
  const { rpc, tool } = await server();
  await tool("web_fetch", { url: "https://worker.example/docs/performance" });
  const sources = await rpc.listResearchSources({ scope, filter: "all", limit: 10 }) as { sources: Array<{ latestSnapshotId: string }> };
  const view = mount(CiteDirective, { attributes: { snapshot: sources.sources[0]!.latestSnapshotId, find: "rate limit is 50" }, source: "", message: { id: "msg_2", threadId: "thr_a", turnId: null, projectId: "proj_a" }, openWorkspaceFile: null }, rpc);
  expect(await view.findByText(/The cited phrase “rate limit is 50” is not in the kept page/u)).toBeTruthy();
  expect(view.inspection.rpcCalls.some((call) => call.method === "noteCitation")).toBe(false);
 });

 it("offers per-thread web research choices and disables Private without SearXNG", () => {
  const item = policyAction.item({ thread: { id: "thr_a" } as never, data: { policies: { thr_a: "docs" }, searxng: false, set: async () => undefined }, sdk: {} as never, navigate: {} as never })!;
  expect(item.detail).toBe("Docs first");
  expect(item.choices!.items.map((c) => [c.id, Boolean(c.selected), Boolean(c.disabled)])).toEqual([["settings", false, false], ["docs", true, false], ["fresh", false, false], ["private", false, true], ["off", false, false]]);
 });

 it("lists threads with research on the Research page", async () => {
  const { rpc, tool } = await server();
  await tool("web_search", { query: "anything" });
  const view = mount(ResearchPage, { subPath: "" }, rpc);
  expect(await view.findByText("Pick a job queue")).toBeTruthy();
  expect(view.getByText("What agents and you looked up, thread by thread.")).toBeTruthy();
 });
});
