// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import app from "../../app.tsx";
import { SourcesBrowser } from "../../src/ui/sources.tsx";
import { deleteSourceConfirmation } from "../../src/contract.ts";
import { rpcContract } from "../../src/ui/contract.ts";
import { createSourcesRpc } from "../../src/rpc.ts";
import { fixtureServices } from "../fixtures/ui/services.ts";
import { artifact, attempt } from "../sources/helpers.ts";
import { ThreadSources } from "../../src/ui/panels.tsx";
const fixtures: ReturnType<typeof fixtureServices>[] = [];
const mounts: ReturnType<typeof renderSlot>[] = [];
afterEach(async () => { for (const m of mounts.splice(0)) m.unmount(); for (const f of fixtures.splice(0)) await f.close(); });
function setup(prepare?: (f: ReturnType<typeof fixtureServices>) => void) {
 const f = fixtureServices(); fixtures.push(f); prepare?.(f);
 const api = createSourcesRpc(f.bb, f); const context = { experimental_caller: { kind: "client" as const } };
 const rpc: PluginRpcTestHandlers<typeof rpcContract> = {
  snapshotMetadata: (v) => api.handlers.snapshotMetadata(v, context),
  sourceSummary: (v) => api.handlers.sourceSummary(v, context), listSources: (v) => api.handlers.listSources(v, context),
  getSource: (v) => api.handlers.getSource(v, context), readSnapshot: (v) => api.handlers.readSnapshot(v, context),
  diffSnapshots: (v) => api.handlers.diffSnapshots(v, context), listCrawlJobs: (v) => api.handlers.listCrawlJobs(v, context),
  getCrawlJob: (v) => api.handlers.getCrawlJob(v, context), cancelCrawlJob: (v) => api.handlers.cancelCrawlJob(v, context),
  resumeCrawlJob: (v) => api.handlers.resumeCrawlJob(v, context), copySourceToProject: (v) => api.handlers.copySourceToProject(v, context),
  deleteSource: (v) => api.handlers.deleteSource(v, context), deleteScope: (v) => api.handlers.deleteScope(v, context),
 };
 const view = renderSlot({ component: SourcesBrowser }, { scope: f.scope }, { pluginId: "forage", rpc, experimental_rpcContract: rpcContract }); mounts.push(view);
 return { ...f, api, view, rpc };
}
it("uses the supported project panel and current thread tab registrations", async () => {
 const loaded = await loadPluginApp(app);
 expect(loaded.navPanels).toHaveLength(1); expect(loaded.navPanels[0]).toMatchObject({ id: "sources", path: "sources" });
 expect(loaded.tabs).toContainEqual(expect.objectContaining({ id: "sources", context: { kind: "thread" }, availability: "fixed" }));
 expect(loaded.contentScripts).toHaveLength(0);
});
it("shows labeled thread sources, source metadata, completeness and immutable citation preview", async () => {
 const { view } = setup();
 expect(await view.findByRole("heading", { name: "Thread sources" })).toBeTruthy();
 fireEvent.click(await view.findByRole("button", { name: "Example" }));
 expect(await view.findByText("Complete", { exact: true })).toBeTruthy();
 expect(await view.findByText(/Changed line/)).toBeTruthy();
 expect(await view.findByLabelText("Citation")).toHaveProperty("value", expect.stringContaining("lines:1-4"));
 expect(view.getByRole("link", { name: "Export public sources" }).getAttribute("href")).toContain("/api/v1/plugins/forage/http/sources-export");
});
it("compares snapshots and copies a public source into project scope", async () => {
 const { view, repository, scope } = setup();
 fireEvent.click(await view.findByRole("button", { name: "Example" }));
 fireEvent.click(await view.findByRole("button", { name: "Compare snapshots" }));
 const comparison = await view.findByRole("region", { name: "Snapshot comparison" });
 expect(await within(comparison).findByText(/Changed line/, { selector: "pre" })).toBeTruthy();
 fireEvent.click(view.getByRole("button", { name: "Copy public source to project" }));
 await waitFor(() => expect(repository.list({ scope: { kind: "project", projectId: scope.projectId }, limit: 10 }).sources).toHaveLength(1));
});
it("requires the exact destructive token and removes source detail after accepted deletion", async () => {
 const { view, repository, scope, first } = setup();
 fireEvent.click(await view.findByRole("button", { name: "Example" }));
 fireEvent.click(await view.findByRole("button", { name: "Delete source" }));
 const confirm = view.getByRole("button", { name: "Confirm deletion" });
 expect(confirm.hasAttribute("disabled")).toBe(true);
 fireEvent.change(view.getByLabelText("Deletion confirmation"), { target: { value: deleteSourceConfirmation(scope, first.sourceId!) } });
 fireEvent.click(confirm);
 await waitFor(() => expect(repository.get(scope, first.sourceId!)).toBeNull());
 await waitFor(() => expect(view.queryByLabelText("Citation")).toBeNull());
});
it("shows crawl budgets and supports resume and cancel", async () => {
 const { view } = setup();
 const job = await view.findByRole("region", { name: "Crawl job_a" });
 expect(within(job).getByText(/42.*bytes/)).toBeTruthy();
 fireEvent.click(within(job).getByRole("button", { name: "Resume" }));
 await waitFor(() => expect(within(job).getByText("running")).toBeTruthy());
 fireEvent.click(within(job).getByRole("button", { name: "Cancel" }));
 await waitFor(() => expect(within(job).getByText("cancelled")).toBeTruthy());
});
it("paginates the source list and content without sending undefined cursors", async () => {
 const { view } = setup((f) => {
  for (let i = 0; i < 21; i++) {
   const url = `https://example.com/page-${i}`;
   f.repository.recordRetrieval({ scope: f.scope, origin: "fetch", artifact: artifact(`body ${i}`, { title: `Page ${i}`, requestedUrl: url, resolvedUrl: url, finalUrl: url }), attempt: attempt() });
  }
 });
 await view.findByRole("region", { name: "Sources list" });
 const list = () => within(view.getByRole("region", { name: "Sources list" }));
 await waitFor(() => expect(list().getAllByRole("listitem")).toHaveLength(20));
 fireEvent.click(list().getByRole("button", { name: "Next page" }));
 await waitFor(() => expect(list().getAllByRole("listitem")).toHaveLength(2));
 fireEvent.click(list().getByRole("button", { name: "Previous page" }));
 await waitFor(() => expect(list().getAllByRole("listitem")).toHaveLength(20));
});
it("pages long content with stable snapshot hash and one-based citations", async () => {
 const { view } = setup((f) => {
  f.repository.recordRetrieval({ scope: f.scope, origin: "fetch", artifact: artifact("A line\n".repeat(2500)), attempt: attempt({ startedAt: 500, finishedAt: 600 }) });
 });
 fireEvent.click(await view.findByRole("button", { name: "Example" }));
 const citation = await view.findByLabelText("Citation"); expect((citation as HTMLTextAreaElement).value).toContain("lines:1-");
 fireEvent.click(view.getByRole("button", { name: "Next content" }));
 await waitFor(() => expect((view.getByLabelText("Citation") as HTMLTextAreaElement).value).not.toContain("lines:1-"));
 const readCalls = view.inspection.rpcCalls.filter((c) => c.method === "readSnapshot");
 expect(readCalls.length).toBeGreaterThanOrEqual(2);
 expect(readCalls.at(-1)!.input).toMatchObject({ offset: 12000, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
});
it("switches the thread tab between thread and shared project scope", async () => {
 const f = setup();
 const { makeThreadResponse } = await import("@get-bb/plugin-sdk/testing");
 const view = renderSlot({ component: ThreadSources }, { threadId: "thr_a" }, { pluginId: "forage", rpc: f.rpc, experimental_rpcContract: rpcContract, sdk: { threads: { get: async () => makeThreadResponse({ id: "thr_a", projectId: "proj_a" }) } } }); mounts.push(view);
 const nav = await view.findByRole("navigation", { name: "Source scope" });
 fireEvent.click(within(nav).getByRole("button", { name: "Project sources (shared)" }));
 expect(await view.findByRole("heading", { name: "Project sources (shared)" })).toBeTruthy();
 await waitFor(() => expect(view.inspection.rpcCalls.some((c) => c.method === "listSources" && (c.input as { scope: { kind: string } }).scope.kind === "project")).toBe(true));
});
it("refreshes scoped queries on background invalidation and suppresses stale previews on denial", async () => {
 const f = setup(); fireEvent.click(await f.view.findByRole("button", { name: "Example" }));
 await f.view.findByLabelText("Citation");
 await f.repository.deleteSource(f.scope, f.first.sourceId!);
 await f.view.behavior.experimental_invalidateRpc(["forage:sources:thread:proj_a:thr_a"], "forage");
 await waitFor(() => expect(f.view.queryByLabelText("Citation")).toBeNull());
});
