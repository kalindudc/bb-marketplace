import { experimental_PluginRpcRefusal, type BbPluginApi, type ExperimentalPluginRpcHandlersWithContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { sourceScopeSchema } from "./contract.ts";
import { rpcContract } from "./ui/contract.ts";
import type { CrawlJobService, CrawlJobView } from "./jobs/model.ts";
import { SourceRepositoryError, type SourceRepository, type SourceScope, type SourceSummary } from "./sources/model.ts";
import { isRestrictedAccess } from "./sources/policy.ts";
import { diffSnapshots } from "./sources/diff.ts";
import type { WebConfig } from "./web/config.ts";
import { sourceScopeKey } from "./web/contracts.ts";

export { rpcContract };

export interface SourcesRpcDependencies {
 repository: SourceRepository;
 jobs: CrawlJobService;
 getConfig(): WebConfig | Promise<WebConfig>;
 allowRestrictedThreadCapture(): boolean | Promise<boolean>;
 resolveScope?(scope: SourceScope, signal?: AbortSignal): Promise<SourceScope>;
}

function refuse(code: "forbidden" | "not_found" | "conflict" | "invalid", message: string): never {
 throw new experimental_PluginRpcRefusal({ code, message });
}
function invisible(): never { return refuse("not_found", "SOURCE_NOT_VISIBLE: The requested scope or record is unavailable."); }

export function createSourcesRpc(bb: BbPluginApi, deps: SourcesRpcDependencies) {
 const { repository, jobs } = deps;
 async function validateScope(scope: SourceScope, signal?: AbortSignal): Promise<void> {
  try {
   if (deps.resolveScope) { await deps.resolveScope(scope, signal); return; }
   const project = await bb.sdk.projects.get({ projectId: scope.projectId, signal });
   if (project.id !== scope.projectId) invisible();
   if (scope.kind === "thread") {
    const thread = await bb.sdk.threads.get({ threadId: scope.threadId, signal });
    if (thread.id !== scope.threadId || thread.projectId !== scope.projectId || thread.deletedAt != null) invisible();
   }
  } catch { invisible(); }
 }
 async function sourceAllowed(source: SourceSummary): Promise<boolean> {
  if (source.access.network === "private" && !(await deps.getConfig()).allowPrivateNetwork) return false;
  return !isRestrictedAccess(source.access) || (source.scope.kind === "thread" && await deps.allowRestrictedThreadCapture());
 }
 async function source(scope: SourceScope, id: string) {
  const detail = repository.get(scope, id);
  return detail && await sourceAllowed(detail) ? detail : null;
 }
 async function snapshot(scope: SourceScope, id: string) {
  const doc = repository.getSnapshot(scope, id);
  return doc && await source(scope, doc.sourceId) ? doc : null;
 }
 async function jobAllowed(job: CrawlJobView): Promise<boolean> {
  const config = await deps.getConfig();
  return config.allowedBackends.includes(job.backend) && !((config.privacyProfile === "private" || config.profile === "private") && job.backend !== "local");
 }
 const handlers: ExperimentalPluginRpcHandlersWithContext<typeof rpcContract> = {
  sourceSummary: async ({ projectId, threadId }) => {
   const scopes: SourceScope[] = [{ kind: "project", projectId }];
   if (threadId) scopes.push({ kind: "thread", projectId, threadId });
   for (const scope of scopes) await validateScope(scope);
   return { scopes: scopes.map((scope) => repository.storageSummary(scope)) };
  },
  listSources: async (input) => {
   await validateScope(input.scope);
   const page = repository.list(input);
   const sources: SourceSummary[] = [];
   for (const row of page.sources) if (await sourceAllowed(row)) sources.push(row);
   return { sources, nextCursor: page.nextCursor };
  },
  getSource: async ({ scope, sourceId, ...query }) => {
   await validateScope(scope);
   const detail = repository.get(scope, sourceId, query);
   return detail && await sourceAllowed(detail) ? detail : null;
  },
  readSnapshot: async ({ scope, snapshotId, ...range }) => {
   await validateScope(scope);
   const doc = repository.getSnapshot(scope, snapshotId);
   if (doc && !await source(scope, doc.sourceId)) return { status: "not-visible" };
   return repository.readSnapshot(scope, snapshotId, range);
  },
  snapshotMetadata: async ({ scope, snapshotId }) => {
   await validateScope(scope);
   const doc = await snapshot(scope, snapshotId);
   if (!doc) return null;
   return { contentType: doc.contentType, completeness: doc.completeness, warnings: doc.warnings, title: doc.structured.title, description: doc.structured.description, language: doc.structured.language };
  },
  diffSnapshots: async ({ scope, beforeSnapshotId, afterSnapshotId, ...options }) => {
   await validateScope(scope);
   const before = await snapshot(scope, beforeSnapshotId);
   const after = await snapshot(scope, afterSnapshotId);
   if (!before || !after) invisible();
   return diffSnapshots(before, after, { ...options, deadlineAt: Date.now() + 1000 });
  },
  listCrawlJobs: async (input) => {
   await validateScope(input.scope);
   const page = jobs.list(input);
   const visible: CrawlJobView[] = [];
   for (const job of page.jobs) if (await jobAllowed(job)) visible.push(job);
   return { jobs: visible, nextCursor: page.nextCursor };
  },
  getCrawlJob: async ({ scope, jobId }) => {
   await validateScope(scope);
   const job = jobs.status(scope, jobId);
   return job && await jobAllowed(job) ? job : null;
  },
  cancelCrawlJob: async ({ scope, jobId }) => {
   await validateScope(scope);
   if (!jobs.status(scope, jobId)) invisible();
   return jobs.cancel(scope, jobId);
  },
  resumeCrawlJob: async ({ scope, jobId, limits }) => {
   await validateScope(scope);
   const job = jobs.status(scope, jobId);
   if (!job) invisible();
   if (!await jobAllowed(job)) refuse("forbidden", "POLICY_BLOCKED: Crawl backend is outside the current provider ceiling.");
   return jobs.resume(scope, jobId, limits);
  },
  copySourceToProject: async ({ projectId, threadId, sourceId }) => {
   const scope = { kind: "thread", projectId, threadId } as const;
   await validateScope(scope);
   const detail = await source(scope, sourceId);
   if (!detail) invisible();
   if (isRestrictedAccess(detail.access)) refuse("forbidden", "POLICY_BLOCKED: Only public uncredentialed sources can be copied to a project.");
   return repository.copyToProject({ from: scope, sourceId });
  },
  deleteSource: async ({ scope, sourceId }) => {
   await validateScope(scope);
   if (!repository.get(scope, sourceId)) invisible();
   return repository.deleteSource(scope, sourceId);
  },
  deleteScope: async ({ scope }) => { await validateScope(scope); return repository.deleteScope(scope); },
 };
 const clientOnly = new Set<keyof typeof rpcContract>(["cancelCrawlJob", "resumeCrawlJob", "copySourceToProject", "deleteSource", "deleteScope"]);
 function wrap<M extends keyof typeof rpcContract>(method: M): void {
  const handler = handlers[method];
  handlers[method] = (async (input, context) => {
   if (clientOnly.has(method) && context.experimental_caller.kind !== "client") refuse("forbidden", "This control requires a local client caller.");
   try { return await handler(input, context); }
   catch (error) {
    if (error instanceof experimental_PluginRpcRefusal) throw error;
    if (error instanceof SourceRepositoryError) {
     if (error.code === "SOURCE_NOT_VISIBLE") invisible();
     refuse(error.code === "POLICY_BLOCKED" ? "forbidden" : error.code === "INVALID_INPUT" ? "invalid" : "conflict", `${error.code}: The source operation could not be completed.`);
    }
    refuse("conflict", "The source operation could not be completed. Refresh and try again.");
   }
  }) as typeof handler;
 }
 for (const method of Object.keys(handlers) as Array<keyof typeof rpcContract>) wrap(method);
 return {
  handlers, validateScope, sourceAllowed,
  invalidate(scope: SourceScope, domains: readonly ("sources" | "jobs")[] = ["sources", "jobs"]) {
   bb.rpc.experimental_invalidate(domains.map((domain) => `forage:${domain}:${sourceScopeKey(scope)}`));
  },
 };
}

export type SourcesRpc = ReturnType<typeof createSourcesRpc>;
export function registerSourcesRpc(bb: BbPluginApi, api: SourcesRpc): void {
 bb.rpc.register(rpcContract, api.handlers);
}

export const EXPORT_PATH = "/sources-export";
export const EXPORT_LIMITS = { bytes: 32 * 1024 * 1024, records: 1000, durationMs: 30_000, chunkBytes: 16 * 1024, concurrent: 2 } as const;
export const sourceExportSchema = z.object({
 scope: sourceScopeSchema,
 sourceIds: z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
 includeRestricted: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
 if (value.includeRestricted && (value.scope.kind !== "thread" || !value.sourceIds?.length)) ctx.addIssue({ code: "custom", message: "Restricted export requires explicitly selected thread sources." });
});

export function registerSourcesHttp(bb: BbPluginApi, deps: SourcesRpcDependencies, api: SourcesRpc): void {
 let active = 0;
 const downloads = new Set<() => Promise<void>>();
 bb.onDispose(async () => { await Promise.all([...downloads].map((close) => close())); });
 bb.http.route("GET", EXPORT_PATH, async (c) => {
  if (active >= EXPORT_LIMITS.concurrent) return c.json({ error: "Export capacity reached." }, 429);
  let input: z.output<typeof sourceExportSchema>;
  try {
   const params = new URL(c.req.url).searchParams;
   if ([...params.keys()].some((key) => key !== "request") || params.getAll("request").length !== 1) throw new Error("invalid query");
   const encoded = params.get("request");
   if (!encoded || encoded.length > 24_000) throw new Error("invalid request");
   input = sourceExportSchema.parse(JSON.parse(encoded));
  } catch { return c.json({ error: "INVALID_INPUT: Invalid source export request." }, 400); }
  try {
   await api.validateScope(input.scope, c.req.raw.signal);
   if (input.includeRestricted && !await deps.allowRestrictedThreadCapture()) return c.json({ error: "POLICY_BLOCKED: Restricted capture is disabled." }, 403);
   for (const id of input.sourceIds ?? []) {
    const row = deps.repository.get(input.scope, id);
    if (!row || !await api.sourceAllowed(row)) return c.json({ error: "SOURCE_NOT_VISIBLE" }, 404);
   }
  } catch { return c.json({ error: "SOURCE_NOT_VISIBLE" }, 404); }
  if (active >= EXPORT_LIMITS.concurrent) return c.json({ error: "Export capacity reached." }, 429);
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  c.req.raw.signal.addEventListener("abort", onAbort, { once: true });
  const deadlineAt = Date.now() + EXPORT_LIMITS.durationMs;
  const timer = setTimeout(() => { void release().catch(() => bb.log.warn("Source export cleanup failed.")); }, EXPORT_LIMITS.durationMs);
  const iterator = deps.repository.export(input.scope, { ...input, signal: abort.signal, deadlineAt })[Symbol.asyncIterator]();
  let released = false;
  let pending = new Uint8Array(0);
  let offset = 0;
  let bytes = 0;
  let records = 0;
  let ending = false;
  let currentSource: SourceSummary | null = null;
  const encoder = new TextEncoder();
  active += 1;
  async function release() {
   if (released) return;
   released = true;
   active -= 1;
   downloads.delete(release);
   clearTimeout(timer);
   c.req.raw.signal.removeEventListener("abort", onAbort);
   abort.abort();
   await iterator.return?.();
  }
  downloads.add(release);
  const stream = new ReadableStream<Uint8Array>({
   async pull(controller) {
    try {
     if (abort.signal.aborted || Date.now() >= deadlineAt) throw new Error("cancelled");
     if (currentSource) {
      const current = deps.repository.get(input.scope, currentSource.id);
      if (!current || !await api.sourceAllowed(current)) throw new Error("revoked");
     }
     if (offset >= pending.length) {
      if (ending) { await release(); controller.close(); return; }
      if (abort.signal.aborted || Date.now() >= deadlineAt) throw new Error("cancelled");
      await api.validateScope(input.scope, abort.signal);
      if (records >= EXPORT_LIMITS.records) {
       pending = encoder.encode(JSON.stringify({ type: "end", status: "partial", reason: "record-limit", records, bytes }) + "\n"); ending = true;
      } else {
       const next = await iterator.next();
       if (next.done) {
        pending = encoder.encode(JSON.stringify({ type: "end", status: "complete", records, bytes }) + "\n"); ending = true;
       } else {
        if (!await api.sourceAllowed(next.value.source)) throw new Error("revoked");
        currentSource = next.value.source;
        const data = encoder.encode(JSON.stringify({ type: "snapshot", ...next.value }) + "\n");
        if (bytes + data.byteLength > EXPORT_LIMITS.bytes - 512) {
         pending = encoder.encode(JSON.stringify({ type: "end", status: "partial", reason: "byte-limit", records, bytes }) + "\n"); ending = true;
        } else { pending = data; bytes += data.byteLength; records += 1; }
       }
      }
      offset = 0;
     }
     const end = Math.min(offset + EXPORT_LIMITS.chunkBytes, pending.length);
     controller.enqueue(pending.slice(offset, end)); offset = end;
    } catch {
     if (offset < pending.length) {
      controller.error(new Error("Export interrupted; no complete end record was delivered."));
      await release(); return;
     }
     controller.enqueue(encoder.encode(JSON.stringify({ type: "end", status: "partial", reason: "unavailable-or-cancelled", records, bytes }) + "\n"));
     await release(); controller.close();
    }
   },
   async cancel() { await release(); },
  });
  return new Response(stream, { headers: {
   "content-type": "application/x-ndjson; charset=utf-8", "content-disposition": 'attachment; filename="forage-sources.ndjson"',
   "cache-control": "no-store", "x-content-type-options": "nosniff",
  } });
 }, { auth: "local" });
}
