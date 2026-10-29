import { z } from "zod";
import { sourceScopeKey, type SourceScope } from "./web/contracts.ts";
import { defineContract } from "./define-contract.ts";

const id = z.string().min(1).max(200);
const scopeId = id.regex(/^[^:]+$/u, "Scope IDs cannot contain ':'.");
const cursor = z.string().min(1).max(1000).optional();
const contentHash = z.string().regex(/^[0-9a-f]{64}$/u);

export const sourceScopeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("thread"), projectId: scopeId, threadId: scopeId }).strict(),
	z.object({ kind: z.literal("project"), projectId: scopeId }).strict(),
]);

const accessSchema = z.object({ network: z.enum(["public", "private"]), credentialed: z.boolean(), requestScopeKey: z.string().nullable() }).strict();
const warningSchema = z.object({ code: z.string(), stage: z.string(), message: z.string() }).strict();
const completenessSchema = z.object({
	state: z.enum(["complete", "partial", "unknown"]),
	parts: z.array(z.object({ name: z.string(), state: z.enum(["complete", "partial", "unknown"]), fetched: z.number().int().nonnegative(), expected: z.number().int().nonnegative().optional(), reason: z.string().optional() }).strict()),
}).strict();
const snapshotMetaSchema = z.object({
	id,
	sourceId: id,
	kind: z.enum(["html", "markdown", "text", "json", "pdf", "github-api"]),
	contentHash,
	snapshotHash: contentHash,
	extractorId: z.string(),
	extractorVersion: z.string(),
	chars: z.number().int().nonnegative(),
	bytes: z.number().int().nonnegative(),
	truncated: z.boolean(),
	fetchedAt: z.number().int().nonnegative(),
	checkedAt: z.number().int().nonnegative(),
}).strict();
const sourceSummarySchema = z.object({
	id,
	scope: sourceScopeSchema,
	access: accessSchema,
	url: z.string(),
	canonicalUrl: z.string().nullable(),
	title: z.string(),
	latestSnapshot: snapshotMetaSchema.nullable(),
	lastRetrievedAt: z.number().int().nonnegative().nullable(),
	createdAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative(),
}).strict();
const retrievalSchema = z.object({
	id,
	origin: z.enum(["fetch", "search-content", "map", "crawl", "extract", "diff", "import"]),
	status: z.enum(["complete", "partial", "unknown", "failed"]),
	requestedUrl: z.string(),
	resolvedUrl: z.string().nullable(),
	finalUrl: z.string().nullable(),
	transport: z.enum(["direct", "github-smart", "provider"]).nullable(),
	representation: z.enum(["readable", "raw"]).nullable(),
	access: accessSchema,
	httpStatus: z.number().int(),
	artifactBytes: z.number().int().nonnegative().nullable(),
	redirects: z.number().int().nonnegative().nullable(),
	diagnostics: z.object({ durationMs: z.number(), redirects: z.number().int().nonnegative(), stageMs: z.record(z.string(), z.number()) }).strict().nullable(),
	completeness: completenessSchema.nullable(),
	warnings: z.array(warningSchema),
	snapshotId: id.nullable(),
	error: z.string().nullable(),
	startedAt: z.number().int().nonnegative(),
	finishedAt: z.number().int().nonnegative(),
	transferredBytes: z.number().int().nonnegative(),
	cache: z.enum(["miss", "hit", "revalidated"]),
}).strict();
const sourceDetailSchema = sourceSummarySchema.extend({
	snapshots: z.object({ items: z.array(snapshotMetaSchema), nextCursor: z.string().nullable() }).strict(),
	retrievals: z.object({ items: z.array(retrievalSchema), nextCursor: z.string().nullable() }).strict(),
}).strict();
const storageSummarySchema = z.object({ scope: sourceScopeSchema, sources: z.number().int().nonnegative(), snapshots: z.number().int().nonnegative(), retrievals: z.number().int().nonnegative(), contentBytes: z.number().int().nonnegative(), deleting: z.boolean() }).strict();
const deleteReceiptSchema = z.object({ sources: z.number().int().nonnegative(), snapshots: z.number().int().nonnegative(), retrievals: z.number().int().nonnegative(), discoveryLinks: z.number().int().nonnegative(), jobs: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }).strict();
const snapshotSliceSchema = z.object({ snapshot: snapshotMetaSchema, offset: z.number().int().nonnegative(), end: z.number().int().nonnegative(), total: z.number().int().nonnegative(), text: z.string(), citation: z.string(), nextOffset: z.number().int().nonnegative().nullable() }).strict();
const snapshotReadSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("ok"), slice: snapshotSliceSchema }).strict(),
	z.object({ status: z.literal("not-visible") }).strict(),
	z.object({ status: z.literal("evicted") }).strict(),
	z.object({ status: z.literal("stale"), contentHash }).strict(),
]);
const hunkRangeSchema = z.object({ startLine: z.number().int().positive(), endLine: z.number().int().positive(), text: z.string() }).strict();
const diffSchema = z.object({
	beforeSnapshotId: id,
	afterSnapshotId: id,
	unchanged: z.boolean(),
	extractorChanged: z.boolean(),
	hunks: z.array(z.object({ kind: z.enum(["added", "removed", "changed"]), headingPath: z.array(z.string()), before: hunkRangeSchema.nullable(), after: hunkRangeSchema.nullable() }).strict()),
	addedLines: z.number().int().nonnegative(),
	removedLines: z.number().int().nonnegative(),
	truncated: z.boolean(),
	warnings: z.array(z.string()),
	blockSummary: z.object({
		before: z.object({ blocks: z.number().int().nonnegative(), prefixHash: contentHash, suffixHash: contentHash }).strict(),
		after: z.object({ blocks: z.number().int().nonnegative(), prefixHash: contentHash, suffixHash: contentHash }).strict(),
	}).strict().optional(),
}).strict();

export const crawlLimitsSchema = z.object({
	maxPages: z.number().int().min(1).max(200),
	maxDepth: z.number().int().min(0).max(5),
	maxBytes: z.number().int().min(1).max(100 * 1024 * 1024),
	maxDurationMs: z.number().int().min(1000).max(30 * 60 * 1000),
	concurrency: z.number().int().min(1).max(4),
}).strict();
const crawlCountsSchema = z.object({ queued: z.number().int().nonnegative(), fetching: z.number().int().nonnegative(), saved: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() }).strict();
const crawlJobSchema = z.object({
	id,
	scope: sourceScopeSchema,
	state: z.enum(["queued", "running", "cancelling", "cancelled", "paused", "partial", "completed", "failed"]),
	rootUrl: z.string(),
	includePaths: z.array(z.string()),
	excludePaths: z.array(z.string()),
	includeSubdomains: z.boolean(),
	limits: crawlLimitsSchema,
	backend: z.enum(["local", "firecrawl"]),
	counts: crawlCountsSchema,
	pagesUsed: z.number().int().nonnegative(),
	bytesUsed: z.number().int().nonnegative(),
	activeDurationMs: z.number().int().nonnegative(),
	generation: z.number().int().nonnegative(),
	createdAt: z.number().int().nonnegative(),
	startedAt: z.number().int().nonnegative().nullable(),
	updatedAt: z.number().int().nonnegative(),
	finishedAt: z.number().int().nonnegative().nullable(),
	stopReason: z.enum(["cancelled", "page-limit", "byte-limit", "time-limit", "frontier-empty", "storage-limit", "error"]).nullable(),
	error: z.string().nullable(),
}).strict();

export function deleteSourceConfirmation(scope: SourceScope, sourceId: string): string {
	return `delete-source:${sourceScopeKey(scope)}:${sourceId}`;
}

export function deleteScopeConfirmation(scope: SourceScope): string {
	return `delete-scope:${sourceScopeKey(scope)}`;
}

const deleteSourceInput = z.object({ scope: sourceScopeSchema, sourceId: id, confirm: z.string().min(1).max(1000) }).strict().superRefine((value, context) => {
	if (value.confirm !== deleteSourceConfirmation(value.scope, value.sourceId)) context.addIssue({ code: "custom", path: ["confirm"], message: "The source deletion confirmation token does not match." });
});
const deleteScopeInput = z.object({ scope: sourceScopeSchema, confirm: z.string().min(1).max(1000) }).strict().superRefine((value, context) => {
	if (value.confirm !== deleteScopeConfirmation(value.scope)) context.addIssue({ code: "custom", path: ["confirm"], message: "The scope deletion confirmation token does not match." });
});

const sourceTag = (scope: SourceScope) => `forage:sources:${sourceScopeKey(scope)}`;
const jobTag = (scope: SourceScope) => `forage:jobs:${sourceScopeKey(scope)}`;

export const rpcContract = defineContract({
	sourceSummary: {
		input: z.object({ projectId: id, threadId: id.optional() }).strict(),
		output: z.object({ scopes: z.array(storageSummarySchema) }).strict(),
		tags: (input: { projectId: string; threadId?: string }) => [sourceTag({ kind: "project", projectId: input.projectId }), ...(input.threadId ? [sourceTag({ kind: "thread", projectId: input.projectId, threadId: input.threadId })] : [])],
	},
	listSources: { input: z.object({ scope: sourceScopeSchema, query: z.string().trim().max(500).optional(), cursor, limit: z.number().int().min(1).max(100) }).strict(), output: z.object({ sources: z.array(sourceSummarySchema), nextCursor: z.string().nullable() }).strict(), tags: (input: { scope: SourceScope }) => [sourceTag(input.scope)] },
	getSource: { input: z.object({ scope: sourceScopeSchema, sourceId: id, snapshotCursor: cursor, retrievalCursor: cursor, limit: z.number().int().min(1).max(100).optional() }).strict(), output: sourceDetailSchema.nullable(), tags: (input: { scope: SourceScope }) => [sourceTag(input.scope)] },
	readSnapshot: { input: z.object({ scope: sourceScopeSchema, snapshotId: id, offset: z.number().int().nonnegative(), maxChars: z.number().int().min(1).max(200_000), contentHash: contentHash.optional() }).strict(), output: snapshotReadSchema, tags: (input: { scope: SourceScope }) => [sourceTag(input.scope)] },
	diffSnapshots: { input: z.object({ scope: sourceScopeSchema, beforeSnapshotId: id, afterSnapshotId: id, maxHunks: z.number().int().min(1).max(200).optional(), maxChars: z.number().int().min(200).max(100_000).optional() }).strict(), output: diffSchema, tags: (input: { scope: SourceScope }) => [sourceTag(input.scope)] },
	listCrawlJobs: { input: z.object({ scope: sourceScopeSchema, cursor, limit: z.number().int().min(1).max(100) }).strict(), output: z.object({ jobs: z.array(crawlJobSchema), nextCursor: z.string().nullable() }).strict(), tags: (input: { scope: SourceScope }) => [jobTag(input.scope)] },
	getCrawlJob: { input: z.object({ scope: sourceScopeSchema, jobId: id }).strict(), output: crawlJobSchema.nullable(), tags: (input: { scope: SourceScope }) => [jobTag(input.scope)] },
	cancelCrawlJob: { input: z.object({ scope: sourceScopeSchema, jobId: id }).strict(), output: crawlJobSchema, invalidates: (input: { scope: SourceScope }) => [jobTag(input.scope)] },
	resumeCrawlJob: { input: z.object({ scope: sourceScopeSchema, jobId: id, limits: crawlLimitsSchema.partial().optional() }).strict(), output: crawlJobSchema, invalidates: (input: { scope: SourceScope }) => [jobTag(input.scope)] },
	copySourceToProject: { input: z.object({ projectId: id, threadId: id, sourceId: id }).strict(), output: z.object({ sourceId: id, snapshotId: id, copied: z.boolean() }).strict(), invalidates: (input: { projectId: string }) => [sourceTag({ kind: "project", projectId: input.projectId })] },
	deleteSource: { input: deleteSourceInput, output: deleteReceiptSchema, invalidates: (input: { scope: SourceScope }) => [sourceTag(input.scope), jobTag(input.scope)] },
	deleteScope: { input: deleteScopeInput, output: deleteReceiptSchema, invalidates: (input: { scope: SourceScope }) => [sourceTag(input.scope), jobTag(input.scope)] },
});
