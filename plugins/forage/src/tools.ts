import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { operationSchemas, type ForageRuntime } from "./operations.ts";
import { boundOutput } from "./format.ts";
export { runDispatchedBatch, selectContentTargets } from "./operations.ts";

export const TOOL_NAMES = ["web_search", "web_fetch", "web_map", "web_extract", "web_crawl", "web_diff"] as const;

export function registerTools(bb: BbPluginApi, runtime: ForageRuntime): void {
 const definitions = [
  { name: "search", title: "Search the web", description: "Search ranked web results with batches, domain/date filters and optional content. Profiles and providers can only narrow configured privacy policy.", instructions: "Search varied angles, then read relevant URLs with web_fetch before relying on snippets." },
  { name: "fetch", title: "Read web sources", description: "Read URLs or immutable snapshotId content. Use contentHash with offset for stable paging. Supports raw/direct, outline, links, lines and focus views. URL-only paging may fetch again after cache expiry.", instructions: "Use snapshotId and contentHash from a prior result for immutable continuation. Source IDs are scoped; share URLs or findings across threads unless explicitly copied to the project. To cite a kept page in a reply, put ::forage-cite{snapshot=\"<snapshotId>\" lines=\"<from>-<to>\"} on its own line after the claim, with only the few lines that support it." },
  { name: "map", title: "Map a site", description: "Discover bounded same-site URLs from robots, sitemap indexes, llms.txt and optional HTML links. Reports partial limits and discovery provenance.", instructions: "Map before a bounded crawl. Use includePaths and excludePaths to narrow the site." },
  { name: "extract", title: "Extract source fields", description: "Extract deterministic title, description, canonical URL, language, headings, links, tables and JSON-LD from URLs or snapshotId. No AI schema inference or hidden model calls.", instructions: "Choose fields explicitly when only a small structured result is needed." },
  { name: "crawl", title: "Manage bounded crawls", description: "Start, status, list, cancel or resume persisted crawl jobs. Explicit page/depth/byte/time/concurrency limits and backend policy apply.", instructions: "Start narrow jobs and inspect status. Cancel unwanted jobs before deleting protected sources." },
  { name: "diff", title: "Compare source snapshots", description: "Compare scoped immutable snapshots or refresh a URL against a stored baseline. Capture-refused refreshes compare in memory without fabricated source IDs.", instructions: "Use beforeSnapshotId and afterSnapshotId, or sourceId for its latest pair. A URL refresh needs a visible baseline." },
 ] as const;
 for (const definition of definitions) {
  const execute = { search: runtime.executeSearch, fetch: runtime.executeFetch, map: runtime.executeMap, extract: runtime.executeExtract, crawl: runtime.executeCrawl, diff: runtime.executeDiff }[definition.name];
  bb.agents.registerTool({
   name: `web_${definition.name}`, description: definition.description, instructions: definition.instructions,
   presentation: { label: { pending: definition.title, completed: definition.title }, icon: { glyph: `forage/${definition.name}` } },
   parameters: operationSchemas[definition.name],
   async execute(params, ctx) {
    try {
     const result = await execute(params, { scope: { kind: "thread", projectId: ctx.projectId, threadId: ctx.threadId }, signal: ctx.signal, actor: "agent" });
     return { content: [{ type: "text" as const, text: result.text }], ...(result.isError ? { isError: true } : {}) };
    } catch (error) {
     return { content: [{ type: "text" as const, text: boundOutput(`Forage: ${error instanceof Error ? error.message : String(error)}`, "Narrow the request.").text }], isError: true };
    }
   },
  });
 }
}
