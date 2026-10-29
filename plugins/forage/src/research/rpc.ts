import type Database from "better-sqlite3";
import type { BbPluginApi, ExperimentalPluginRpcHandlersWithContext } from "@get-bb/plugin-sdk";
import type { CrawlJobService } from "../jobs/model.ts";
import type { DiagnosticEntry } from "../diagnostics.ts";
import type { ForageRuntime, OperationResult } from "../operations.ts";
import type { SourceRepository, SourceScope, SourceSummary } from "../sources/model.ts";
import type { rpcContract } from "../ui/contract.ts";
import type { WebConfig } from "../web/config.ts";
import type { ActivityEntry, ActivityRepository, ThreadScope } from "./activity.ts";
import type { researchContract } from "./contract.ts";
import { findInSources } from "./find.ts";
import type { ThreadPolicyStore } from "./policy.ts";
import {
 crawlGroups, crawlPages, matchesFilter, researchSourceById, researchSources, researchThreads, scopeStorage, expiresAt, sharedSources, sourceCitations,
 sourceIdsByUrl, storageOverview, visibleSourceIds, type Visibility,
} from "./queries.ts";

type Handlers = ExperimentalPluginRpcHandlersWithContext<typeof rpcContract>;
export type ResearchHandlers = Pick<Handlers, keyof typeof researchContract>;

export interface ResearchDependencies {
 db: Database.Database;
 repository: SourceRepository;
 jobs: CrawlJobService;
 activity: ActivityRepository;
 policies: ThreadPolicyStore;
 runtime(): ForageRuntime;
 getConfig(): WebConfig | Promise<WebConfig>;
 allowRestrictedThreadCapture(): boolean | Promise<boolean>;
 activityEnabled(): boolean;
 diagnostics(): DiagnosticEntry[];
 prune(): Promise<{ snapshots: number; sources: number; activity: number; bytes: number }>;
 maxContentBytes: number;
}

const ACTIVE = new Set(["queued", "running", "cancelling"]);
const readable = (message: string) => message.replace(/^[A-Z][A-Z_]+: /u, "").slice(0, 400);
const errorText = (error: unknown) => readable(error instanceof Error ? error.message : String(error));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const WARNING_TEXT: Record<string, string> = {
 "policy-blocked": "Blocked by a privacy or provider setting", deadline: "Ran past its time limit", "storage-limit": "Storage was full",
 partial: "Only part of it worked", cancelled: "Cancelled", failure: "Failed",
};

export function createResearchHandlers(bb: BbPluginApi, deps: ResearchDependencies, helpers: {
 validateScope(scope: SourceScope, signal?: AbortSignal): Promise<void>;
 sourceAllowed(source: SourceSummary): Promise<boolean>;
}): ResearchHandlers {
 const { db, activity, policies } = deps;
 async function visibility(scope: SourceScope): Promise<Visibility> {
  const config = await deps.getConfig();
  return { allowPrivate: config.allowPrivateNetwork, allowRestricted: scope.kind === "thread" && await deps.allowRestrictedThreadCapture() };
 }
 const thread = (input: { projectId: string; threadId: string }): ThreadScope => ({ kind: "thread", projectId: input.projectId, threadId: input.threadId });

 // Links in the log only point at sources that still exist and that current policy lets this view show.
 function resolve(scope: ThreadScope, entries: readonly ActivityEntry[], vis: Visibility) {
  const urls: string[] = [];
  const ids: string[] = [];
  for (const entry of entries) {
   const summary = entry.summary;
   if (summary.kind === "search") for (const q of summary.queries) for (const r of q.results) urls.push(r.url);
   if ("pages" in summary) for (const page of summary.pages) if (page.sourceId) ids.push(page.sourceId);
   if (summary.kind === "diff" && summary.sourceId) ids.push(summary.sourceId);
  }
  const byUrl = sourceIdsByUrl(db, scope, urls, vis);
  const visible = visibleSourceIds(db, scope, ids, vis);
  return entries.map((entry) => {
   const summary = entry.summary;
   const pages = "pages" in summary ? summary.pages.map((page) => ({ ...page, sourceId: page.sourceId && visible.has(page.sourceId) ? page.sourceId : null })) : undefined;
   const next = summary.kind === "search"
    ? { ...summary, pages: pages!, queries: summary.queries.map((q) => ({ ...q, results: q.results.map((r) => ({ ...r, sourceId: byUrl.get(r.url) ?? null })) })) }
    : pages ? { ...summary, pages }
    : summary.kind === "diff" ? { ...summary, sourceId: summary.sourceId && visible.has(summary.sourceId) ? summary.sourceId : null } : summary;
   return { id: entry.id, actor: entry.actor, operation: entry.operation, status: entry.status, items: entry.items, startedAt: entry.startedAt, finishedAt: entry.finishedAt, error: entry.error, summary: next };
  });
 }
 async function runningJobs(scope: SourceScope) {
  return deps.jobs.list({ scope, limit: 20 }).jobs.filter((job) => ACTIVE.has(job.state))
   .map((job) => ({ jobId: job.id, rootUrl: job.rootUrl, state: job.state, pagesUsed: job.pagesUsed, maxPages: job.limits.maxPages, saved: job.counts.saved }));
 }
 async function titles(threadIds: readonly string[]) {
  const out = new Map<string, { title: string; projectId: string; archived: boolean }>();
  await Promise.allSettled(threadIds.map(async (threadId) => {
   const value = await bb.sdk.threads.get({ threadId, signal: AbortSignal.timeout(5000) });
   if (value.deletedAt !== null) return;
   out.set(threadId, { title: value.title ?? value.titleFallback ?? "Untitled thread", projectId: value.projectId, archived: value.archivedAt !== null });
  }));
  return out;
 }
 async function projectNames(projectIds: readonly string[]) {
  const out = new Map<string, string>();
  await Promise.allSettled([...new Set(projectIds)].map(async (projectId) => {
   const value = await bb.sdk.projects.get({ projectId, signal: AbortSignal.timeout(5000) });
   out.set(projectId, value.name);
  }));
  return out;
 }
 const entriesVisible = (vis: Visibility) => vis.allowPrivate && vis.allowRestricted;

 return {
  researchSummary: async (input) => {
   const scope = thread(input);
   const project: SourceScope = { kind: "project", projectId: input.projectId };
   await helpers.validateScope(scope);
   const vis = await visibility(scope);
   const sources = researchSources(db, scope, vis);
   const shared = researchSources(db, project, await visibility(project), input.threadId).length;
   const stats = activity.stats(scope);
   const storage = scopeStorage(db, scope);
   const latest = activity.list(scope, { limit: 3, includeRestricted: entriesVisible(vis) }).entries;
   return {
    policy: await policies.get(input.threadId), activityLog: deps.activityEnabled(), searches: stats.searches,
    reads: sources.filter((s) => s.arrival !== "crawl" && s.status !== "failed").length, sources: sources.length,
    cited: sources.filter((s) => s.cited > 0).length, problems: sources.filter((s) => s.status !== "complete").length,
    crawled: sources.filter((s) => s.arrival === "crawl").length, shared, running: await runningJobs(scope), bytes: storage.bytes,
    expiresAt: expiresAt(storage.oldestRetainedAt), lastActivityAt: stats.lastAt,
    recentSources: sources.filter((s) => s.arrival !== "crawl").slice(0, 5), latest: resolve(scope, latest, vis),
   };
  },
  listActivity: async ({ scope, cursor, limit }) => {
   await helpers.validateScope(scope);
   const vis = await visibility(scope);
   const page = activity.list(scope, { cursor, limit, includeRestricted: entriesVisible(vis) });
   return { entries: resolve(scope, page.entries, vis), nextCursor: page.nextCursor, enabled: deps.activityEnabled() };
  },
  clearActivity: async ({ scope }) => {
   await helpers.validateScope(scope);
   return { removed: activity.clear(scope) };
  },
  listResearchSources: async ({ scope, query, filter, cursor, limit, exceptThreadId }) => {
   await helpers.validateScope(scope);
   const all = researchSources(db, scope, await visibility(scope), exceptThreadId);
   const text = query?.toLowerCase() ?? "";
   const flat = text !== "" || filter !== "all" || scope.kind === "project";
   const matching = all.filter((source) => matchesFilter(source, filter) && (!text || `${source.title} ${source.url}`.toLowerCase().includes(text)) && (flat || source.arrival !== "crawl"));
   const offset = Math.max(0, Number(cursor ?? 0) || 0);
   return {
    sources: matching.slice(offset, offset + limit), crawlGroups: flat ? [] : crawlGroups(db, scope, all), nextCursor: offset + limit < matching.length ? String(offset + limit) : null,
    counts: { all: all.length, cited: all.filter((s) => s.cited > 0).length, changed: all.filter((s) => s.versions > 1).length, problems: all.filter((s) => s.status !== "complete").length },
   };
  },
  listCrawlPages: async ({ scope, jobId, cursor, limit }) => {
   await helpers.validateScope(scope);
   const page = crawlPages(db, scope, jobId, { ...(cursor ? { cursor } : {}), limit });
   if (!page) throw new Error("SOURCE_NOT_VISIBLE: The crawl is unavailable.");
   const vis = await visibility(scope);
   const visible = visibleSourceIds(db, scope, page.pages.map((p) => p.sourceId).filter((v): v is string => Boolean(v)), vis);
   return { pages: page.pages.map((p) => ({ ...p, url: p.url, sourceId: p.sourceId && visible.has(p.sourceId) ? p.sourceId : null })), nextCursor: page.nextCursor };
  },
  researchSource: async ({ scope, sourceId }) => {
   await helpers.validateScope(scope);
   const detail = deps.repository.get(scope, sourceId, { limit: 20 });
   if (!detail || !await helpers.sourceAllowed(detail)) return null;
   const source = researchSourceById(db, scope, sourceId, await visibility(scope));
   if (!source) return null;
   const r = detail.retrievals.items[0];
   return {
    source, canonicalUrl: detail.canonicalUrl,
    versions: detail.snapshots.items.map((s) => ({ id: s.id, contentHash: s.contentHash, fetchedAt: s.fetchedAt, bytes: s.bytes, truncated: s.truncated, kind: s.kind })),
    citations: sourceCitations(db, sourceId),
    retrieval: r ? { status: r.status, httpStatus: r.httpStatus, transport: r.transport, representation: r.representation, redirects: r.redirects, durationMs: r.diagnostics?.durationMs ?? null, cache: r.cache, finishedAt: r.finishedAt, error: r.error, transferredBytes: r.transferredBytes, origin: r.origin } : null,
    contentHash: detail.latestSnapshot?.contentHash ?? null, extractor: detail.latestSnapshot ? `${detail.latestSnapshot.extractorId} ${detail.latestSnapshot.extractorVersion}` : null,
   };
  },
  readLines: async ({ scope, snapshotId, startLine, endLine, find }) => {
   await helpers.validateScope(scope);
   const doc = deps.repository.getSnapshot(scope, snapshotId);
   const source = doc ? deps.repository.get(scope, doc.sourceId, { limit: 1 }) : null;
   if (!doc || !source || !await helpers.sourceAllowed(source)) return { status: "not-visible" as const };
   const lines = doc.content.split("\n");
   // A citation that points past the page, or at a phrase the page does not have, is reported as missing instead of quoting other text.
   if (startLine > lines.length) return { status: "missing" as const, totalLines: lines.length };
   let start = startLine;
   let end = endLine ?? start + 399;
   if (find) {
    const needle = find.toLowerCase();
    const at = lines.findIndex((line, i) => i >= startLine - 1 && line.toLowerCase().includes(needle));
    if (at < 0) return { status: "missing" as const, totalLines: lines.length };
    start = at + 1; end = endLine && endLine > at ? endLine : at + 3;
   }
   end = Math.min(lines.length, Math.max(start, end), start + 399);
   const out: string[] = [];
   let chars = 0;
   for (let i = start - 1; i < end; i++) {
    const line = lines[i] ?? "";
    chars += line.length;
    if (chars > 80_000 && out.length > 0) break;
    out.push(line.length > 4000 ? `${line.slice(0, 3999)}…` : line);
   }
   return { status: "ok" as const, snapshotId: doc.id, sourceId: doc.sourceId, title: source.title, url: source.url, fetchedAt: doc.fetchedAt, latest: source.latestSnapshot?.contentHash === doc.contentHash, totalLines: lines.length, startLine: start, endLine: start + out.length - 1, lines: out };
  },
  noteCitation: async (input) => {
   const scope = thread(input);
   await helpers.validateScope(scope);
   const startLine = Math.min(input.startLine, input.endLine);
   return { noted: activity.noteCitation({ scope, snapshotId: input.snapshotId, messageId: input.messageId, startLine, endLine: Math.max(input.startLine, input.endLine) }) };
  },
  findInSources: async ({ scope, text }) => {
   await helpers.validateScope(scope);
   return findInSources(db, scope, text, await visibility(scope), AbortSignal.timeout(10_000));
  },
  run: async (input) => {
   const scope = thread(input);
   await helpers.validateScope(scope);
   const runtime = deps.runtime();
   const context = { scope, signal: AbortSignal.timeout(5 * 60_000), actor: "person" as const, policy: await policies.get(input.threadId), ...(input.via ? { via: input.via } : {}) };
   const profile = input.profile ? { profile: input.profile } : {};
   let result: OperationResult;
   try {
    if (input.operation === "search") {
     if (!input.query) return { ok: false, message: "Type something to search for.", jobId: null, sourceIds: [] };
     result = await runtime.executeSearch({ query: input.query, ...profile }, context);
     const details = result.details as { totalResults?: number; queries?: Array<{ error?: string }> };
     const failed = details.queries?.find((q) => q.error)?.error;
     return { ok: !result.isError && !failed, message: failed ? readable(failed) : `Found ${plural(details.totalResults ?? 0, "result")}.`, jobId: null, sourceIds: [] };
    }
    if (!input.url) return { ok: false, message: "Paste a link to read.", jobId: null, sourceIds: [] };
    if (input.operation === "read") {
     result = await runtime.executeFetch({ url: input.url, ...profile }, context);
     const details = result.details as { results?: Array<{ error?: string; title?: string }> };
     const first = details.results?.[0];
     return first?.error ? { ok: false, message: readable(first.error), jobId: null, sourceIds: [] } : { ok: true, message: `Read ${first?.title || "the page"}.`, jobId: null, sourceIds: [] };
    }
    if (input.operation === "map") {
     result = await runtime.executeMap({ url: input.url }, context);
     const found = (result.details as { urls?: unknown[] }).urls?.length ?? 0;
     return { ok: !result.isError, message: `Found ${found} ${found === 1 ? "address" : "addresses"}.`, jobId: null, sourceIds: [] };
    }
    const limits = { ...(input.crawl?.maxPages ? { maxPages: input.crawl.maxPages } : {}), ...(input.crawl?.maxDepth !== undefined ? { maxDepth: input.crawl.maxDepth } : {}), ...(input.crawl?.maxDurationMs ? { maxDurationMs: input.crawl.maxDurationMs } : {}) };
    result = await runtime.executeCrawl({ action: "start", url: input.url, ...(input.crawl?.includePaths?.length ? { includePaths: input.crawl.includePaths } : {}), ...(Object.keys(limits).length ? { limits } : {}) }, context);
    const job = result.details as { id?: string; rootUrl?: string };
    return { ok: !result.isError, message: `Crawl started at ${job.rootUrl ?? input.url}.`, jobId: job.id ?? null, sourceIds: [] };
   } catch (error) {
    return { ok: false, message: errorText(error), jobId: null, sourceIds: [] };
   }
  },
  setThreadPolicy: async ({ threadId, policy }) => {
   const value = await bb.sdk.threads.get({ threadId, signal: AbortSignal.timeout(5000) });
   if (value.deletedAt !== null) throw new Error("SOURCE_NOT_VISIBLE: The thread is unavailable.");
   const saved = await policies.set(threadId, policy);
   // Crawls already running keep reading the web, so stop the ones the new policy would not allow.
   if (saved === "off" || saved === "private") {
    const scope: ThreadScope = { kind: "thread", projectId: value.projectId, threadId };
    for (const job of deps.jobs.list({ scope, limit: 100 }).jobs) if (ACTIVE.has(job.state) && (saved === "off" || job.backend !== "local")) deps.jobs.cancel(scope, job.id);
   }
   return { policy: saved };
  },
  policies: async ({ keys }) => policies.list(keys),
  researchConfig: async () => {
   const config = await deps.getConfig();
   return { searxng: Boolean(config.searxngUrl) && config.allowedProviders.includes("searxng"), activityLog: deps.activityEnabled() };
  },
  researchThreads: async ({ limit }) => {
   const rows = researchThreads(db, limit);
   const info = await titles(rows.map((row) => row.threadId));
   const live = rows.filter((row) => info.get(row.threadId)?.projectId === row.projectId);
   const names = await projectNames(live.map((row) => row.projectId));
   const threadPolicies = live.length ? await policies.list(live.map((row) => row.threadId)).catch(() => ({} as Record<string, "settings">)) : {};
   const threads = await Promise.all(live.map(async (row) => {
    const running = (await runningJobs({ kind: "thread", projectId: row.projectId, threadId: row.threadId }))[0] ?? null;
    const meta = info.get(row.threadId)!;
    return { projectId: row.projectId, projectName: names.get(row.projectId) ?? "Project", threadId: row.threadId, title: meta.title, archived: meta.archived, lastAt: row.lastAt, sources: row.sources, cited: row.cited, bytes: row.bytes, activity: row.activity, policy: threadPolicies[row.threadId] ?? "settings" as const, running };
   }));
   const overview = storageOverview(db);
   return { threads, totals: { threads: threads.length, sources: overview.sources, bytes: overview.bytes, running: threads.filter((t) => t.running).length } };
  },
  sharedSources: async ({ limit }) => {
   const rows = sharedSources(db, limit);
   const names = await projectNames(rows.map((row) => row.projectId));
   return { sources: rows.filter((row) => names.has(row.projectId)).map((row) => ({ ...row, projectName: names.get(row.projectId)! })) };
  },
  health: async () => {
   const config = await deps.getConfig();
   const privateCeiling = config.privacyProfile === "private" || config.profile === "private";
   const keyed = { brave: config.braveApiKey, tavily: config.tavilyApiKey, firecrawl: config.firecrawlApiKey } as Record<string, string | undefined>;
   const search = (["duckduckgo", "exa", "brave", "searxng", "tavily"] as const).map((providerId) => {
    const label = { duckduckgo: "DuckDuckGo", exa: "Exa", brave: "Brave", searxng: "SearXNG", tavily: "Tavily" }[providerId];
    const state = !config.allowedProviders.includes(providerId) ? "not-allowed" as const
     : privateCeiling && providerId !== "searxng" ? "blocked" as const
     : providerId === "searxng" && !config.searxngUrl ? "not-configured" as const
     : (providerId === "brave" || providerId === "tavily") && !keyed[providerId] ? "needs-key" as const : "ready" as const;
    const note = { duckduckgo: "No key needed", exa: config.exaApiKey ? "Keyless, plus your account key when a call asks for it" : "No key needed", brave: "Needs an API key", searxng: "Needs your server's address; the only search the Private ceiling allows", tavily: "Needs an API key" }[providerId];
    return { id: providerId, label, kind: "search" as const, state, note: state === "ready" && (providerId === "brave" || providerId === "tavily") ? (config.allowPaidProviderFallback ? "Key set; used for fallback too" : "Key set; used only when a call asks for it") : note };
   });
   const readers = (["direct", "jina", "tavily", "firecrawl"] as const).map((readerId) => {
    const label = { direct: "Direct", jina: "Jina", tavily: "Tavily reader", firecrawl: "Firecrawl" }[readerId];
    const state = !config.allowedReaders.includes(readerId) ? "not-allowed" as const
     : privateCeiling && readerId !== "direct" ? "blocked" as const
     : (readerId === "tavily" || readerId === "firecrawl") && !keyed[readerId] ? "needs-key" as const : "ready" as const;
    const note = { direct: "Reads pages from this machine", jina: "Used only when a call asks for it", tavily: "Needs an API key", firecrawl: "Needs an API key" }[readerId];
    return { id: `reader:${readerId}`, label, kind: "reader" as const, state, note: state === "ready" && readerId !== "direct" && readerId !== "jina" ? "Key set; used only when a call asks for it" : note };
   });
   const crawl = (["local", "firecrawl"] as const).map((backend) => ({
    id: `crawl:${backend}`, label: backend === "local" ? "Crawl on this machine" : "Firecrawl crawl", kind: "crawl" as const,
    state: !config.allowedBackends.includes(backend) ? "not-allowed" as const : privateCeiling && backend !== "local" ? "blocked" as const : backend === "firecrawl" && !config.firecrawlApiKey ? "needs-key" as const : "ready" as const,
    note: backend === "local" ? "Built in" : "Needs a Firecrawl key",
   }));
   const since = Date.now() - 86_400_000;
   const records = deps.diagnostics().filter((entry) => entry.at >= since);
   const ops = new Map<string, { total: number; failed: number }>();
   for (const entry of records) { const op = ops.get(entry.operation) ?? { total: 0, failed: 0 }; op.total++; if (entry.status === "failure") op.failed++; ops.set(entry.operation, op); }
   const overview = storageOverview(db);
   const scopeTitles = await titles(overview.byScope.flatMap((row) => (row.scope.kind === "thread" ? [row.scope.threadId] : [])));
   const projects = await projectNames(overview.byScope.filter((row) => row.scope.kind === "project").map((row) => row.scope.projectId));
   return {
    providers: [...search, ...readers, ...crawl],
    policy: { profile: config.profile, privacy: privateCeiling ? "private" : "standard", paidFallback: config.allowPaidProviderFallback, privateNetwork: config.allowPrivateNetwork, restrictedCapture: await deps.allowRestrictedThreadCapture(), activityLog: deps.activityEnabled(), customThreads: policies.countCustom() },
    last24h: {
     total: records.length, success: records.filter((r) => r.status === "success").length, partial: records.filter((r) => r.status === "partial").length,
     failure: records.filter((r) => r.status === "failure").length, cancelled: records.filter((r) => r.status === "cancelled").length,
     byOperation: [...ops.entries()].map(([operation, v]) => ({ operation, ...v })),
     failures: records.filter((r) => r.status === "failure").slice(-8).reverse().map((r) => ({ operation: r.operation, provider: r.provider ?? null, reason: WARNING_TEXT[r.warnings?.find((w) => w !== "failure") ?? "failure"] ?? "Failed", at: r.at })),
    },
    storage: {
     bytes: overview.bytes, maxBytes: deps.maxContentBytes, sources: overview.sources,
     byThread: overview.byScope.map((row) => ({ projectId: row.scope.projectId, threadId: row.scope.kind === "thread" ? row.scope.threadId : null, bytes: row.bytes,
      title: row.scope.kind === "thread" ? scopeTitles.get(row.scope.threadId)?.title ?? "A deleted or unavailable thread" : `Shared with ${projects.get(row.scope.projectId) ?? "a project"}` })),
    },
   };
  },
  prune: async () => deps.prune(),
 };
}
