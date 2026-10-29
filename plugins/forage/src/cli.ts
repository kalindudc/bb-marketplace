import { cliCommand, defineCli, type PluginCliCommand } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { type ForageRuntime, type ForageContext, type OperationResult } from "./operations.ts";
import { deleteScopeConfirmation, deleteSourceConfirmation, sourceScopeSchema } from "./contract.ts";
import { sourceScopeKey, type SourceScope } from "./web/contracts.ts";
import { isRestrictedAccess } from "./sources/policy.ts";
import { boundOutput } from "./format.ts";
import { doctor } from "./doctor.ts";
import { bench } from "./bench.ts";
import { PROFILE_NAMES } from "./profiles.ts";
import { CRAWL_BACKENDS, READER_PROVIDERS, SEARCH_PROVIDERS } from "./web/config.ts";

const scopeOptions = {
 project: { type: "string", required: true, aliases: ["project-id"], description: "Explicit SDK-validated project ID." },
 thread: { type: "string", aliases: ["thread-id"], description: "Explicit SDK-validated thread ID; omit only for project-scoped source operations." },
} as const;
const inputOption = { type: "string", stdin: true, description: "Strict operation JSON object (or --input-stdin)." } as const;
function parseInput(value?: string): Record<string, unknown> {
 const input: unknown = value === undefined ? {} : JSON.parse(value);
 if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("input must be a JSON object");
 return input as Record<string, unknown>;
}
function output(value: unknown) {
 const json = JSON.stringify(value, null, 2);
 const stdout = json.length <= 32000 ? json : JSON.stringify({ partial: true, reason: "output-limit", preview: json.slice(0, 14000), instruction: "Narrow the request or use a cursor / streamed export." });
 return { exitCode: 0, stdout };
}
function failure(error: unknown) { return { exitCode: 1, stderr: boundOutput(`Forage: ${error instanceof Error ? error.message : String(error)}`, "Narrow the request.").text }; }

export function createCli(runtime: ForageRuntime) {
 async function scope(options: { project: string; thread?: string }, signal?: AbortSignal): Promise<SourceScope> {
  return runtime.resolveScope(sourceScopeSchema.parse(options.thread ? { kind: "thread", projectId: options.project, threadId: options.thread } : { kind: "project", projectId: options.project }), signal);
 }
 async function visible(s: SourceScope, id: string) {
  const source = runtime.sources.get(s, id);
  const config = await runtime.getConfig();
  return source && !(source.access.network === "private" && !config.allowPrivateNetwork) && (!isRestrictedAccess(source.access) || (s.kind === "thread" && await runtime.allowRestrictedThreadCapture())) ? source : null;
 }
 const commands: Record<string, PluginCliCommand> = {};
 const operations = { search: runtime.executeSearch, fetch: runtime.executeFetch, map: runtime.executeMap, extract: runtime.executeExtract, diff: runtime.executeDiff, crawl: runtime.executeCrawl };
 for (const [name, execute] of Object.entries(operations)) {
  const actions = name === "crawl" ? ["start", "status", "list", "cancel", "resume"] : [""];
  for (const action of actions) commands[action ? `${name} ${action}` : name] = cliCommand({
   summary: `Run shared ${name}${action ? ` ${action}` : ""} without a model turn`,
   options: { ...scopeOptions, input: inputOption,
    profile: { type: "enum", values: PROFILE_NAMES, description: "Narrow the configured profile." },
    provider: { type: "enum", values: SEARCH_PROVIDERS, description: "Narrow the configured search provider ceiling." },
    reader: { type: "enum", values: READER_PROVIDERS, description: "Explicit page reader; never widens privacy policy." },
    backend: { type: "enum", values: CRAWL_BACKENDS, description: "Explicit crawl backend; never widens privacy policy." },
   },
   async run({ options }, ctx) {
    try {
     const parsed = parseInput(options.input);
     for (const key of ["profile", "provider", "reader", "backend"] as const) if (options[key] !== undefined) {
      if (parsed[key] !== undefined && parsed[key] !== options[key]) throw new Error(`Conflicting ${key} in JSON and flag.`);
      parsed[key] = options[key];
     }
     if (action) { if (parsed.action !== undefined && parsed.action !== action) throw new Error("Crawl action conflicts with command."); parsed.action = action; }
     const resolved = await scope(options, ctx.signal);
     if (resolved.kind !== "thread") throw new Error("Web operations require explicit --thread capture scope.");
     const context: ForageContext = { scope: resolved, signal: ctx.signal ?? new AbortController().signal };
     const result: OperationResult = await execute(parsed, context);
     return { exitCode: result.isError ? 1 : 0, stdout: result.text };
    } catch (error) { return failure(error); }
   },
  });
 }
 commands.status = cliCommand({ summary: "Show redacted policy, cache and shared tool/CLI diagnostics", options: {}, async run() {
  try { return output(await doctor(runtime)); } catch (error) { return failure(error); }
 } });
 commands.diagnostics = cliCommand({ summary: "Read the shared 200-record / 24-hour redacted diagnostic ring", options: {}, run() { return output({ records: runtime.diagnostics.snapshot() }); } });
 commands.clear = cliCommand({ summary: "Clear process page/search caches, not saved sources or jobs", options: {}, run() { const before = runtime.cache.stats(); runtime.cache.clear(); return output({ cleared: before }); } });
 commands.doctor = cliCommand({ summary: "Offline diagnostics; --live explicitly permits bounded keyless checks only", options: { live: { type: "boolean", description: "One query per allowed keyless provider; 5s/provider, 20s total. No account credentials." } }, async run({ options }, ctx) { try { return output(await doctor(runtime, options.live, ctx.signal)); } catch (error) { return failure(error); } } });
 commands.bench = cliCommand({ summary: "Run the bundled local extraction corpus (no network)", options: {}, run() { return output(bench()); } });
 commands["sources list"] = cliCommand({ summary: "List visible sources with bounded cursor paging", options: { ...scopeOptions, input: inputOption }, async run({ options }, ctx) {
  try {
   const query = z.object({ query: z.string().max(500).optional(), cursor: z.string().max(1000).optional(), limit: z.number().int().min(1).max(100).default(20) }).strict().parse(parseInput(options.input));
   const s = await scope(options, ctx.signal); const page = runtime.sources.list({ scope: s, ...query });
   const sources = []; for (const source of page.sources) { const allowed = await visible(s, source.id); if (allowed) sources.push(allowed); }
   return output({ sources, nextCursor: page.nextCursor });
  } catch (error) { return failure(error); }
 } });
 commands["sources show"] = cliCommand({ summary: "Show source metadata or a bounded hash-bound snapshot slice", options: { ...scopeOptions, input: inputOption }, async run({ options }, ctx) {
  try {
   const query = z.object({ sourceId: z.string().min(1), snapshotId: z.string().min(1).optional(), contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), offset: z.number().int().nonnegative().default(0), maxChars: z.number().int().min(1).max(24000).default(12000), snapshotCursor: z.string().optional(), retrievalCursor: z.string().optional(), limit: z.number().int().min(1).max(50).default(20) }).strict().parse(parseInput(options.input));
   const s = await scope(options, ctx.signal); if (!await visible(s, query.sourceId)) throw new Error("SOURCE_NOT_VISIBLE");
   if (query.snapshotId) {
    const doc = runtime.sources.getSnapshot(s, query.snapshotId);
    if (!doc || doc.sourceId !== query.sourceId) throw new Error("SOURCE_NOT_VISIBLE");
    return output(runtime.sources.readSnapshot(s, query.snapshotId, query));
   }
   return output(runtime.sources.get(s, query.sourceId, query));
  } catch (error) { return failure(error); }
 } });
 commands["sources delete"] = cliCommand({ summary: "Delete a source or scope using its exact confirmation token", options: { ...scopeOptions, input: inputOption, confirm: { type: "string", required: true, description: "Exact delete-source:<scopeKey>:<sourceId> or delete-scope:<scopeKey> token." } }, async run({ options }, ctx) {
  try {
   const query = z.object({ sourceId: z.string().min(1).optional() }).strict().parse(parseInput(options.input)); const s = await scope(options, ctx.signal);
   const expected = query.sourceId ? deleteSourceConfirmation(s, query.sourceId) : deleteScopeConfirmation(s);
   if (options.confirm !== expected) throw new Error(`Exact confirmation required: ${expected}`);
   const receipt = query.sourceId ? await runtime.sources.deleteSource(s, query.sourceId, { signal: ctx.signal }) : await runtime.sources.deleteScope(s, { signal: ctx.signal });
   runtime.invalidate(s); return output(receipt);
  } catch (error) { return failure(error); }
 } });
 commands["sources prune"] = cliCommand({ summary: "Prune expired/inactive sources and job metadata globally", options: { confirm: { type: "string", required: true, description: "Exact token prune-sources:all acknowledges global retention maintenance." } }, async run({ options }, ctx) {
  try {
   if (options.confirm !== "prune-sources:all") throw new Error("Exact confirmation required: prune-sources:all");
   const receipt = await runtime.sources.prune({ threadDays: 30, projectDays: 180, completedJobDays: 30, failedJobDays: 7, maxContentBytes: 128 * 1024 * 1024, now: Date.now(), signal: ctx.signal });
   runtime.invalidateAll(); return output(receipt);
  } catch (error) { return failure(error); }
 } });
 commands["sources export"] = cliCommand({ summary: "Return a local-auth streamed NDJSON download route, not content on stdout", options: { ...scopeOptions, input: inputOption }, async run({ options }, ctx) {
  try {
   const query = z.object({ sourceIds: z.array(z.string().min(1)).min(1).max(100).optional(), includeRestricted: z.boolean().default(false) }).strict().parse(parseInput(options.input));
   const s = await scope(options, ctx.signal);
   if (query.includeRestricted && (s.kind !== "thread" || !query.sourceIds?.length || !await runtime.allowRestrictedThreadCapture())) throw new Error("Restricted export requires explicitly selected sources and enabled restricted thread capture.");
   for (const id of query.sourceIds ?? []) if (!await visible(s, id)) throw new Error("SOURCE_NOT_VISIBLE");
   return output({ path: `/api/v1/plugins/forage/http/sources-export?request=${encodeURIComponent(JSON.stringify({ scope: s, ...query }))}`, authentication: "Open the local-auth plugin HTTP route on the connected BB server. No server filesystem path is exposed.", format: "application/x-ndjson", scopeKey: sourceScopeKey(s) });
  } catch (error) { return failure(error); }
 } });
 return defineCli({ name: "forage", summary: "Scoped web research, durable sources and bounded crawl jobs; zero model turns", commands });
}
