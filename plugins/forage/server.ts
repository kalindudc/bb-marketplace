import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createCli } from "./src/cli.ts";
import { createCrawlService, type CrawlEngineOptions } from "./src/crawl/engine.ts";
import { FORAGE_MIGRATIONS } from "./src/crawl/schema.ts";
import { createForageRuntime, type ForageRuntime, type RuntimeDependencies } from "./src/operations.ts";
import { createSourcesRpc, registerSourcesHttp, registerSourcesRpc } from "./src/rpc.ts";
import { configFromSettings, SETTINGS } from "./src/settings.ts";
import { SqliteSourceRepository } from "./src/sources/repository.ts";
import { configureSourceDatabase } from "./src/sources/schema.ts";
import type { SourceScope } from "./src/web/contracts.ts";
import { createDeadline } from "./src/web/deadline.ts";
import { registerTools } from "./src/tools.ts";

function authoritativeNotFound(error: unknown): boolean {
 if (!error || typeof error !== "object") return false;
 const value = error as { status?: unknown; statusCode?: unknown; code?: unknown };
 return value.status === 404 || value.statusCode === 404 || value.code === "not_found";
}

export async function createServerRuntime(bb: BbPluginApi, dependencies: {
 fetch?: RuntimeDependencies["fetch"];
 search?: RuntimeDependencies["search"];
 crawl?: Partial<Omit<CrawlEngineOptions, "getSources" | "getConfig" | "onChanged" | "allowRestrictedThreadCapture">>;
} = {}): Promise<ForageRuntime> {
 const settings = bb.settings.define(SETTINGS);
 let cachedConfig = configFromSettings(await settings.get());
 const db = bb.storage.database(); configureSourceDatabase(db); bb.storage.migrate(db, [...FORAGE_MIGRATIONS]);
 let disposed = false;
 let sources: SqliteSourceRepository;
 let runtime: ForageRuntime;
 let api: ReturnType<typeof createSourcesRpc>;
 const lifecycle = new AbortController();
 const changed = (scope: SourceScope) => { if (!disposed) api?.invalidate(scope, ["sources", "jobs"]); };
 const crawl = createCrawlService(db, { ...dependencies.crawl, getSources: () => sources, getConfig: () => cachedConfig, allowRestrictedThreadCapture: () => cachedConfig.allowRestrictedThreadCapture, onChanged: changed });
 sources = new SqliteSourceRepository(db, { maintenance: crawl });
 const deleteScope = sources.deleteScope.bind(sources);
 sources.deleteScope = async (scope, options) => {
  runtime?.fenceScope(scope);
  const result = await deleteScope(scope, options); changed(scope); return result;
 };
 const deleteSource = sources.deleteSource.bind(sources);
 sources.deleteSource = async (scope, id, options) => {
  runtime?.fenceScope(scope);
  const result = await deleteSource(scope, id, options); changed(scope); return result;
 };
 async function authority(scope: SourceScope, signal?: AbortSignal): Promise<"present" | "missing"> {
  const deadline = createDeadline(5000, signal);
  try {
   const project = await bb.sdk.projects.get({ projectId: scope.projectId, signal: deadline.signal });
   if (project.id !== scope.projectId) throw new Error("Scope authority returned a different project");
   if (scope.kind === "thread") {
    const thread = await bb.sdk.threads.get({ threadId: scope.threadId, signal: deadline.signal });
    if (thread.id !== scope.threadId) throw new Error("Scope authority returned a different thread");
    if (thread.projectId !== scope.projectId || thread.deletedAt !== null) return "missing";
   }
   return "present";
  } catch (error) { if (authoritativeNotFound(error)) return "missing"; throw error; }
  finally { deadline.dispose(); }
 }
 runtime = createForageRuntime({ getConfig: async () => cachedConfig, sources, jobs: crawl, allowRestrictedThreadCapture: () => cachedConfig.allowRestrictedThreadCapture,
  async resolveScope(scope, signal) {
   if (await authority(scope, signal) === "missing") { await sources.deleteScope(scope, { signal }); throw new Error("SOURCE_NOT_VISIBLE: The requested scope is unavailable."); }
   return scope;
  }, fetch: dependencies.fetch, search: dependencies.search, onChanged: changed, onInvalidateAll: () => { if (!disposed) bb.rpc.experimental_invalidateAll(); },
 });
 const rpcDependencies = { repository: sources, jobs: crawl, getConfig: runtime.getConfig, allowRestrictedThreadCapture: runtime.allowRestrictedThreadCapture, resolveScope: runtime.resolveScope };
 api = createSourcesRpc(bb, rpcDependencies); registerSourcesRpc(bb, api); registerSourcesHttp(bb, rpcDependencies, api);
 registerTools(bb, runtime); bb.cli.register(createCli(runtime));
 let tail = Promise.resolve();
 const serialize = (work: () => Promise<void>): Promise<void> => { const next = tail.then(work, work); tail = next; return next; };
 async function maintain(signal: AbortSignal): Promise<void> {
  await sources.resumePendingDeletes({ signal });
  for (const repository of [sources, crawl]) for await (const scope of repository.scopes()) {
   signal.throwIfAborted();
   try { if (await authority(scope, signal) === "missing") await sources.deleteScope(scope, { signal }); }
   catch (error) { if (signal.aborted) throw error; bb.log.warn("Scope authority lookup failed; retained existing evidence."); }
  }
  await sources.prune({ threadDays: 30, projectDays: 180, completedJobDays: 30, failedJobDays: 7, maxContentBytes: 128 * 1024 * 1024, now: Date.now(), signal });
  runtime.invalidateAll();
 }
 bb.events.on("thread.deleted", ({ thread }) => {
  const scope: SourceScope = { kind: "thread", projectId: thread.projectId, threadId: thread.id };
  runtime.fenceScope(scope);
  return serialize(async () => { await sources.deleteScope(scope, { signal: lifecycle.signal }); });
 });
 bb.background.service("crawl", { async start(signal) {
  const combined = AbortSignal.any([signal, lifecycle.signal]);
  await serialize(() => maintain(combined));
  await crawl.run(combined);
 } });
 bb.background.schedule("retention", "0 * * * *", () => serialize(() => maintain(lifecycle.signal)));
 settings.onChange((next) => {
  cachedConfig = configFromSettings(next);
  runtime.fenceAll(); const revoked = crawl.revoke();
  runtime.cache.clear(); runtime.invalidateAll();
  for (const field of cachedConfig.warnings) bb.log.warn(`Settings: ${field.split(":", 1)[0]} is invalid or was clamped.`);
  void serialize(async () => {
   for (const scope of revoked) { await crawl.cancelScope(scope); changed(scope); }
  }).catch(() => { if (!disposed) bb.log.warn("Settings revocation cleanup failed; jobs remain fenced."); });
 });
 bb.onDispose(async () => {
  disposed = true; lifecycle.abort(new Error("Forage disposed"));
  await runtime.dispose(); await crawl.dispose(); await Promise.allSettled([tail]);
 });
 return runtime;
}

export default async function foragePlugin(bb: BbPluginApi): Promise<void> { await createServerRuntime(bb); }
