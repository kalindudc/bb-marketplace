import { z } from "zod";
import { sourceScopeSchema } from "../contract.ts";
import { sourceScopeKey, type SourceScope } from "../web/contracts.ts";
import { PROFILE_NAMES } from "../profiles.ts";
import { THREAD_POLICIES } from "./policy.ts";

const id = z.string().min(1).max(200);
const scopeId = id.regex(/^[^:]+$/u, "Scope IDs cannot contain ':'.");
export const threadScopeSchema = z.object({ kind: z.literal("thread"), projectId: scopeId, threadId: scopeId }).strict();
const cursor = z.string().min(1).max(1000).optional();
const time = z.number().int().nonnegative();
const policySchema = z.enum(THREAD_POLICIES);

const pageRefSchema = z.object({ url: z.string(), title: z.string(), sourceId: z.string().nullable(), snapshotId: z.string().nullable(), chars: z.number().int().nonnegative(), error: z.string().optional() }).strict();
const resultRefSchema = z.object({ title: z.string(), url: z.string(), snippet: z.string().optional(), sourceId: z.string().nullable() }).strict();
const queryRefSchema = z.object({ query: z.string(), provider: z.string().nullable(), total: z.number().int().nonnegative(), error: z.string().optional(), results: z.array(resultRefSchema) }).strict();
const summarySchema = z.discriminatedUnion("kind", [
 z.object({ kind: z.literal("search"), queries: z.array(queryRefSchema), pages: z.array(pageRefSchema) }).strict(),
 z.object({ kind: z.literal("fetch"), find: z.string().optional(), pages: z.array(pageRefSchema) }).strict(),
 z.object({ kind: z.literal("save"), pages: z.array(pageRefSchema) }).strict(),
 z.object({ kind: z.literal("map"), root: z.string(), total: z.number().int().nonnegative(), methods: z.record(z.string(), z.number()), truncated: z.boolean(), sample: z.array(z.string()) }).strict(),
 z.object({ kind: z.literal("extract"), fields: z.array(z.string()), pages: z.array(pageRefSchema) }).strict(),
 z.object({ kind: z.literal("crawl"), action: z.enum(["start", "cancel", "resume"]), jobId: z.string().nullable(), root: z.string().nullable() }).strict(),
 z.object({ kind: z.literal("diff"), url: z.string().nullable(), sourceId: z.string().nullable(), unchanged: z.boolean(), added: z.number().int().nonnegative(), removed: z.number().int().nonnegative(), sections: z.array(z.string()), persisted: z.boolean() }).strict(),
]);
export const activityEntrySchema = z.object({
 id, actor: z.enum(["agent", "person"]), operation: z.enum(["search", "fetch", "map", "extract", "crawl", "diff", "save"]),
 status: z.enum(["success", "partial", "failure", "cancelled"]), items: z.number().int().nonnegative(), startedAt: time, finishedAt: time,
 error: z.string().nullable(), summary: summarySchema,
}).strict();

export const researchSourceSchema = z.object({
 id, url: z.string(), title: z.string(), network: z.enum(["public", "private"]), credentialed: z.boolean(),
 arrival: z.enum(["agent", "crawl", "person", "shared"]), via: z.enum(["tab", "browser"]).nullable(), crawlJobId: z.string().nullable(),
 versions: z.number().int().nonnegative(), latestSnapshotId: z.string().nullable(), bytes: z.number().int().nonnegative(), truncated: z.boolean(),
 status: z.enum(["complete", "partial", "failed"]), error: z.string().nullable(), cited: z.number().int().nonnegative(), shared: z.boolean(),
 createdAt: time, updatedAt: time, lastRetrievedAt: time.nullable(),
}).strict();
const crawlGroupSchema = z.object({ jobId: z.string().nullable(), rootUrl: z.string().nullable(), state: z.string().nullable(), sources: z.number().int().nonnegative() }).strict();
const runningJobSchema = z.object({ jobId: id, rootUrl: z.string(), state: z.string(), pagesUsed: z.number().int().nonnegative(), maxPages: z.number().int().positive(), saved: z.number().int().nonnegative() }).strict();
const matchSchema = z.object({
 sourceId: id, snapshotId: id, title: z.string(), url: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive(),
 lines: z.array(z.string()), matched: z.array(z.string()), score: z.number().int().nonnegative(), latest: z.boolean(), fetchedAt: time,
}).strict();
const providerStateSchema = z.object({
 id: z.string(), label: z.string(), kind: z.enum(["search", "reader", "crawl"]), state: z.enum(["ready", "needs-key", "not-configured", "blocked", "not-allowed"]), note: z.string(),
}).strict();

const tag = (domain: "sources" | "jobs" | "activity", scope: SourceScope) => `forage:${domain}:${sourceScopeKey(scope)}`;
const threadOf = (input: { projectId: string; threadId: string }): SourceScope => ({ kind: "thread", projectId: input.projectId, threadId: input.threadId });
export const RESEARCH_TAG = "forage:research";
export const POLICY_TAG = "forage:policy";

export const researchContract = {
 researchSummary: {
  input: z.object({ projectId: id, threadId: id }).strict(),
  output: z.object({
   policy: policySchema, activityLog: z.boolean(), searches: z.number().int().nonnegative(), reads: z.number().int().nonnegative(), sources: z.number().int().nonnegative(),
   cited: z.number().int().nonnegative(), problems: z.number().int().nonnegative(), crawled: z.number().int().nonnegative(), shared: z.number().int().nonnegative(),
   running: z.array(runningJobSchema), bytes: z.number().int().nonnegative(), expiresAt: time.nullable(), lastActivityAt: time.nullable(),
   recentSources: z.array(researchSourceSchema), latest: z.array(activityEntrySchema),
  }).strict(),
  tags: (input: { projectId: string; threadId: string }) => [tag("sources", threadOf(input)), tag("jobs", threadOf(input)), tag("activity", threadOf(input)), tag("sources", { kind: "project", projectId: input.projectId }), POLICY_TAG],
 },
 listActivity: {
  input: z.object({ scope: threadScopeSchema, cursor, limit: z.number().int().min(1).max(100) }).strict(),
  output: z.object({ entries: z.array(activityEntrySchema), nextCursor: z.string().nullable(), enabled: z.boolean() }).strict(),
  tags: (input: { scope: SourceScope }) => [tag("activity", input.scope), tag("sources", input.scope), tag("jobs", input.scope)],
 },
 clearActivity: {
  input: z.object({ scope: threadScopeSchema }).strict(),
  output: z.object({ removed: z.number().int().nonnegative() }).strict(),
  invalidates: (input: { scope: SourceScope }) => [tag("activity", input.scope), RESEARCH_TAG],
 },
 listResearchSources: {
  input: z.object({ scope: sourceScopeSchema, query: z.string().trim().max(500).optional(), filter: z.enum(["all", "cited", "changed", "problems"]), cursor, limit: z.number().int().min(1).max(200), exceptThreadId: id.optional() }).strict(),
  output: z.object({
   sources: z.array(researchSourceSchema), crawlGroups: z.array(crawlGroupSchema), nextCursor: z.string().nullable(),
   counts: z.object({ all: z.number().int().nonnegative(), cited: z.number().int().nonnegative(), changed: z.number().int().nonnegative(), problems: z.number().int().nonnegative() }).strict(),
  }).strict(),
  tags: (input: { scope: SourceScope }) => [tag("sources", input.scope), tag("jobs", input.scope)],
 },
 listCrawlPages: {
  input: z.object({ scope: threadScopeSchema, jobId: id, cursor, limit: z.number().int().min(1).max(200) }).strict(),
  output: z.object({ pages: z.array(z.object({ id: z.number().int(), url: z.string(), depth: z.number().int().nonnegative(), state: z.string(), error: z.string().nullable(), sourceId: z.string().nullable() }).strict()), nextCursor: z.string().nullable() }).strict(),
  tags: (input: { scope: SourceScope }) => [tag("jobs", input.scope), tag("sources", input.scope)],
 },
 researchSource: {
  input: z.object({ scope: sourceScopeSchema, sourceId: id }).strict(),
  output: z.object({
   source: researchSourceSchema, canonicalUrl: z.string().nullable(),
   versions: z.array(z.object({ id, contentHash: z.string(), fetchedAt: time, bytes: z.number().int().nonnegative(), truncated: z.boolean(), kind: z.string() }).strict()),
   citations: z.array(z.object({ messageId: z.string(), snapshotId: z.string(), startLine: z.number().int(), endLine: z.number().int(), notedAt: time }).strict()),
   retrieval: z.object({
    status: z.string(), httpStatus: z.number().int(), transport: z.string().nullable(), representation: z.string().nullable(), redirects: z.number().int().nullable(),
    durationMs: z.number().nullable(), cache: z.string(), finishedAt: time, error: z.string().nullable(), transferredBytes: z.number().int().nonnegative(), origin: z.string(),
   }).strict().nullable(),
   contentHash: z.string().nullable(), extractor: z.string().nullable(),
  }).strict().nullable(),
  tags: (input: { scope: SourceScope }) => [tag("sources", input.scope)],
 },
 readLines: {
  input: z.object({ scope: sourceScopeSchema, snapshotId: id, startLine: z.number().int().min(1).max(10_000_000), endLine: z.number().int().min(1).max(10_000_000).optional(), find: z.string().trim().min(1).max(200).optional() }).strict(),
  output: z.discriminatedUnion("status", [
   z.object({ status: z.literal("ok"), snapshotId: id, sourceId: id, title: z.string(), url: z.string(), fetchedAt: time, latest: z.boolean(), totalLines: z.number().int().nonnegative(), startLine: z.number().int().positive(), endLine: z.number().int().nonnegative(), lines: z.array(z.string()) }).strict(),
   z.object({ status: z.literal("not-visible") }).strict(),
   z.object({ status: z.literal("missing"), totalLines: z.number().int().nonnegative() }).strict(),
  ]),
  tags: (input: { scope: SourceScope }) => [tag("sources", input.scope)],
 },
 noteCitation: {
  input: z.object({ projectId: id, threadId: id, messageId: id, snapshotId: id, startLine: z.number().int().min(1), endLine: z.number().int().min(1) }).strict(),
  output: z.object({ noted: z.boolean() }).strict(),
  invalidates: (input: { projectId: string; threadId: string }) => [tag("sources", threadOf(input)), RESEARCH_TAG],
 },
 findInSources: {
  input: z.object({ scope: threadScopeSchema, text: z.string().trim().min(1).max(2000) }).strict(),
  output: z.object({ terms: z.array(z.string()), scanned: z.number().int().nonnegative(), matches: z.array(matchSchema) }).strict(),
  tags: (input: { scope: SourceScope }) => [tag("sources", input.scope)],
 },
 run: {
  input: z.object({
   projectId: id, threadId: id, operation: z.enum(["search", "read", "map", "crawl"]), query: z.string().trim().min(1).max(500).optional(), url: z.string().trim().min(1).max(2000).optional(),
   profile: z.enum(PROFILE_NAMES).optional(), via: z.enum(["tab", "browser"]).optional(),
   crawl: z.object({ includePaths: z.array(z.string().min(1).max(200)).max(10).optional(), maxPages: z.number().int().min(1).max(200).optional(), maxDepth: z.number().int().min(0).max(5).optional(), maxDurationMs: z.number().int().min(1000).max(1_800_000).optional() }).strict().optional(),
  }).strict(),
  output: z.object({ ok: z.boolean(), message: z.string(), jobId: z.string().nullable(), sourceIds: z.array(z.string()) }).strict(),
  invalidates: (input: { projectId: string; threadId: string }) => [tag("activity", threadOf(input)), tag("sources", threadOf(input)), tag("jobs", threadOf(input)), RESEARCH_TAG],
 },
 policies: {
  input: z.object({ keys: z.array(id).min(1).max(200) }).strict(),
  output: z.record(z.string(), policySchema),
  tags: () => [POLICY_TAG],
 },
 researchConfig: {
  input: z.object({}).strict(),
  output: z.object({ searxng: z.boolean(), activityLog: z.boolean() }).strict(),
  tags: () => [POLICY_TAG, RESEARCH_TAG],
 },
 setThreadPolicy: {
  input: z.object({ threadId: id, policy: policySchema }).strict(),
  output: z.object({ policy: policySchema }).strict(),
  invalidates: () => [POLICY_TAG, RESEARCH_TAG],
 },
 researchThreads: {
  input: z.object({ limit: z.number().int().min(1).max(100) }).strict(),
  output: z.object({
   threads: z.array(z.object({
    projectId: id, projectName: z.string(), threadId: id, title: z.string(), archived: z.boolean(), lastAt: time, sources: z.number().int().nonnegative(),
    cited: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), activity: z.number().int().nonnegative(), policy: policySchema, running: runningJobSchema.nullable(),
   }).strict()),
   totals: z.object({ threads: z.number().int().nonnegative(), sources: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), running: z.number().int().nonnegative() }).strict(),
  }).strict(),
  tags: () => [RESEARCH_TAG, POLICY_TAG],
 },
 sharedSources: {
  input: z.object({ limit: z.number().int().min(1).max(100) }).strict(),
  output: z.object({ sources: z.array(z.object({ id, projectId: id, projectName: z.string(), title: z.string(), url: z.string(), updatedAt: time }).strict()) }).strict(),
  tags: () => [RESEARCH_TAG],
 },
 health: {
  input: z.object({}).strict(),
  output: z.object({
   providers: z.array(providerStateSchema),
   policy: z.object({ profile: z.string(), privacy: z.string(), paidFallback: z.boolean(), privateNetwork: z.boolean(), restrictedCapture: z.boolean(), activityLog: z.boolean(), customThreads: z.number().int().nonnegative() }).strict(),
   last24h: z.object({
    total: z.number().int().nonnegative(), success: z.number().int().nonnegative(), partial: z.number().int().nonnegative(), failure: z.number().int().nonnegative(), cancelled: z.number().int().nonnegative(),
    byOperation: z.array(z.object({ operation: z.string(), total: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }).strict()),
    failures: z.array(z.object({ operation: z.string(), provider: z.string().nullable(), reason: z.string(), at: time }).strict()),
   }).strict(),
   storage: z.object({
    bytes: z.number().int().nonnegative(), maxBytes: z.number().int().positive(), sources: z.number().int().nonnegative(),
    byThread: z.array(z.object({ projectId: id, threadId: z.string().nullable(), title: z.string(), bytes: z.number().int().nonnegative() }).strict()),
   }).strict(),
  }).strict(),
  tags: () => [RESEARCH_TAG, POLICY_TAG],
 },
 prune: {
  input: z.object({}).strict(),
  output: z.object({ snapshots: z.number().int().nonnegative(), sources: z.number().int().nonnegative(), activity: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }).strict(),
  invalidates: () => [RESEARCH_TAG],
 },
} as const;

export type ActivityEntryView = z.infer<typeof activityEntrySchema>;
export type ResearchSourceView = z.infer<typeof researchSourceSchema>;
export type ProviderStateView = z.infer<typeof providerStateSchema>;
