import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { JobMaintenancePort } from "../jobs/model.ts";
import { canonicalUrlKey } from "../web/url.ts";
import { sourceScopeKey, type AccessDescriptor, type DiscoveredUrl, type RetrievalArtifact, type SourceScope, type StructuredDocument } from "../web/contracts.ts";
import {
	SourceRepositoryError,
	type CopyReceipt,
	type CursorPage,
	type DeleteReceipt,
	type PruneReceipt,
	type RecordRetrievalInput,
	type RepositoryWorkOptions,
	type RetrievalReceipt,
	type RetrievalSummary,
	type SnapshotDocument,
	type SnapshotEvictionReason,
	type SnapshotMeta,
	type SnapshotReadResult,
	type SourceDetail,
	type SourceDetailQuery,
	type SourceExportOptions,
	type SourceExportRecord,
	type SourceListQuery,
	type SourcePage,
	type SourceRepository,
	type SourceRepositoryOptions,
	type SourceStorageSummary,
	type SourceSummary,
} from "./model.ts";
import { evaluateCapturePolicy, isRestrictedAccess, isSensitiveUrl } from "./policy.ts";

const DAY_MS = 86_400_000;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_STRUCTURED_BYTES = 1024 * 1024;
const DEFAULT_CONTENT_BYTES = 128 * 1024 * 1024;
const DEFAULT_DELETE_BATCH = 100;
const CAPACITY_BATCH = 100;
const MAX_CAPACITY_WORK = 1000;
const TOMBSTONE_WINDOW_MS = 30 * DAY_MS;
const ITERATOR_BATCH = 50;
const MAX_DISCOVERY_URLS = 5000;
const MAX_EXPORT_SOURCES = 5000;

interface SourceRow {
	id: string;
	scope_key: string;
	scope_kind: "thread" | "project";
	project_id: string;
	thread_id: string | null;
	normalized_url: string;
	display_url: string;
	canonical_url: string | null;
	access_network: AccessDescriptor["network"];
	access_credentialed: number;
	request_scope_key: string | null;
	title: string;
	latest_snapshot_id: string | null;
	last_retrieved_at: number | null;
	created_at: number;
	updated_at: number;
	deleting: number;
}

interface SnapshotRow {
	id: string;
	source_id: string;
	kind: RetrievalArtifact["kind"];
	content_type: string;
	content: string;
	structured_json: string;
	content_hash: string;
	snapshot_hash: string;
	extractor_id: string;
	extractor_version: string;
	truncated: number;
	content_bytes: number;
	structured_bytes: number;
	fetched_at: number;
	retained_at: number;
	completeness_json: string;
	warnings_json: string;
}

interface RetrievalRow {
	id: string;
	source_id: string;
	snapshot_id: string | null;
	origin: RetrievalSummary["origin"];
	status: RetrievalSummary["status"];
	requested_url: string;
	resolved_url: string | null;
	final_url: string | null;
	transport: RetrievalSummary["transport"];
	representation: RetrievalSummary["representation"];
	access_network: AccessDescriptor["network"];
	access_credentialed: number;
	request_scope_key: string | null;
	http_status: number;
	artifact_bytes: number | null;
	redirects: number | null;
	diagnostics_json: string | null;
	completeness_json: string | null;
	warnings_json: string | null;
	started_at: number;
	finished_at: number;
	transferred_bytes: number;
	cache_state: RetrievalSummary["cache"];
	error: string | null;
}

interface CursorValue {
	at: number;
	id: string;
}

const NO_MAINTENANCE: JobMaintenancePort = {
	protectedSnapshotIds: () => new Set(),
	invalidateScope: () => 0,
	beforeSnapshotsDeleted: () => undefined,
	deleteScope: async () => 0,
	pruneJobs: async () => 0,
};

function id(prefix: "src" | "ret" | "snap"): string {
	return `${prefix}_${randomUUID()}`;
}

function scopeFromRow(row: Pick<SourceRow, "scope_kind" | "project_id" | "thread_id">): SourceScope {
	return row.scope_kind === "thread"
		? { kind: "thread", projectId: row.project_id, threadId: row.thread_id! }
		: { kind: "project", projectId: row.project_id };
}

function accessFromRow(row: Pick<SourceRow, "access_network" | "access_credentialed" | "request_scope_key">): AccessDescriptor {
	return { network: row.access_network, credentialed: row.access_credentialed === 1, requestScopeKey: row.request_scope_key };
}

function encodeCursor(value: CursorValue): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): CursorValue | null {
	if (value === undefined) return null;
	try {
		const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CursorValue>;
		if (!Number.isSafeInteger(parsed.at) || parsed.at! < 0 || typeof parsed.id !== "string" || parsed.id === "") throw new Error("invalid cursor");
		return { at: parsed.at!, id: parsed.id };
	} catch {
		throw new SourceRepositoryError("INVALID_INPUT", "The source cursor is invalid.");
	}
}

function validateLimit(value: number, max = 100): number {
	if (!Number.isInteger(value) || value < 1 || value > max) throw new SourceRepositoryError("INVALID_INPUT", `The limit must be between 1 and ${max}.`);
	return value;
}

function repositoryScopeKey(scope: SourceScope): string {
	const ids = scope.kind === "thread" ? [scope.projectId, scope.threadId] : [scope.projectId];
	if (ids.some((value) => value.includes(":"))) throw new SourceRepositoryError("INVALID_INPUT", "Source scope IDs cannot contain colons.");
	return sourceScopeKey(scope);
}

function retentionCutoff(scopeKey: string, threadBefore: number, projectBefore: number): number | null {
	if (scopeKey.startsWith("thread:")) return threadBefore;
	if (scopeKey.startsWith("project:")) return projectBefore;
	return null;
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new SourceRepositoryError("INVALID_INPUT", "Structured source numbers must be finite.");
		return value;
	}
	if (typeof value !== "object") throw new SourceRepositoryError("INVALID_INPUT", "Structured source data must contain only JSON values.");
	if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
		throw new SourceRepositoryError("INVALID_INPUT", "Structured source data must contain only JSON values.");
	}
	if (seen.has(value)) throw new SourceRepositoryError("INVALID_INPUT", "Structured source data cannot contain cycles.");
	seen.add(value);
	const result = Array.isArray(value)
		? value.map((item) => stableValue(item, seen))
		: Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stableValue((value as Record<string, unknown>)[key], seen)]));
	seen.delete(value);
	return result;
}

function stableJson(value: unknown): string {
	try {
		const serialized = JSON.stringify(stableValue(value));
		if (serialized === undefined) throw new Error("not serializable");
		return serialized;
	} catch (error) {
		if (error instanceof SourceRepositoryError) throw error;
		throw new SourceRepositoryError("INVALID_INPUT", "Structured source data must be JSON serializable.");
	}
}

function emptyStructured(artifact: RetrievalArtifact): StructuredDocument {
	return {
		schemaVersion: 1,
		title: artifact.title,
		description: "",
		canonicalUrl: null,
		language: null,
		headings: [],
		links: [],
		tables: [],
		jsonLd: [],
	};
}

function normalizedContentType(value: string): string {
	return value.trim().toLocaleLowerCase("en-US");
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function snapshotHash(artifact: RetrievalArtifact, structuredJson: string): string {
	return sha256([artifact.kind, artifact.extraction.id, normalizedContentType(artifact.contentType), artifact.content, structuredJson].join("\0"));
}

function fetchedAt(artifact: RetrievalArtifact): number {
	const parsed = Date.parse(artifact.fetchedAt);
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new SourceRepositoryError("INVALID_INPUT", "The artifact fetched-at timestamp is invalid.");
	return parsed;
}

function validateAttempt(input: RecordRetrievalInput): void {
	const { attempt } = input;
	if (!Number.isSafeInteger(attempt.startedAt) || attempt.startedAt < 0 || !Number.isSafeInteger(attempt.finishedAt) || attempt.finishedAt < attempt.startedAt) {
		throw new SourceRepositoryError("INVALID_INPUT", "Retrieval attempt timestamps are invalid.");
	}
	if (!Number.isInteger(attempt.httpStatus) || attempt.httpStatus < 0 || attempt.httpStatus > 599 || !Number.isSafeInteger(attempt.transferredBytes) || attempt.transferredBytes < 0) {
		throw new SourceRepositoryError("INVALID_INPUT", "Retrieval attempt accounting is invalid.");
	}
	if (input.artifact !== null && (!Number.isSafeInteger(input.artifact.bytes) || input.artifact.bytes < 0)) {
		throw new SourceRepositoryError("INVALID_INPUT", "Artifact byte accounting is invalid.");
	}
}

function sanitizeError(value: string | undefined): string | null {
	if (value === undefined) return null;
	return value.replace(/https?:\/\/[^\s]+/giu, "[url]").slice(0, 1000);
}

function safeWarnings(artifact: RetrievalArtifact): RetrievalArtifact["warnings"] {
	return artifact.warnings.map((warning) => ({ ...warning, message: sanitizeError(warning.message) ?? "" }));
}

function emptyDeleteReceipt(): DeleteReceipt {
	return { sources: 0, snapshots: 0, retrievals: 0, discoveryLinks: 0, jobs: 0, bytes: 0 };
}

function addDeleteReceipt(target: DeleteReceipt, value: DeleteReceipt): DeleteReceipt {
	for (const key of ["sources", "snapshots", "retrievals", "discoveryLinks", "jobs", "bytes"] as const) target[key] += value[key];
	return target;
}

function placeholders(length: number): string {
	return Array.from({ length }, () => "?").join(", ");
}

function batch<T>(values: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
	return result;
}

function nextCodePointBoundary(content: string, value: number): number {
	if (value <= 0 || value >= content.length) return Math.max(0, Math.min(value, content.length));
	const code = content.charCodeAt(value);
	return code >= 0xdc00 && code <= 0xdfff ? value + 1 : value;
}

function previousCodePointBoundary(content: string, value: number): number {
	if (value <= 0 || value >= content.length) return Math.max(0, Math.min(value, content.length));
	const code = content.charCodeAt(value - 1);
	return code >= 0xd800 && code <= 0xdbff ? value - 1 : value;
}

function checkWork(options: RepositoryWorkOptions): void {
	if (options.signal?.aborted) throw new Error("Source repository operation was cancelled.");
	if (options.deadlineAt !== undefined && Date.now() > options.deadlineAt) throw new Error("Source repository operation timed out.");
}

async function yieldToHost(options: RepositoryWorkOptions): Promise<void> {
	checkWork(options);
	await new Promise<void>((resolve) => setImmediate(resolve));
	checkWork(options);
}

export class SqliteSourceRepository implements SourceRepository {
	private readonly now: () => number;
	private readonly maxContentBytes: number;
	private readonly maintenance: JobMaintenancePort;
	private readonly deleteBatchSize: number;

	constructor(private readonly db: Database.Database, options: SourceRepositoryOptions = {}) {
		this.now = options.now ?? Date.now;
		this.maxContentBytes = options.maxContentBytes ?? DEFAULT_CONTENT_BYTES;
		if (!Number.isSafeInteger(this.maxContentBytes) || this.maxContentBytes < 1) throw new SourceRepositoryError("INVALID_INPUT", "The retained-content limit must be a positive integer.");
		this.maintenance = options.maintenance ?? NO_MAINTENANCE;
		this.deleteBatchSize = options.deleteBatchSize ?? DEFAULT_DELETE_BATCH;
		validateLimit(this.deleteBatchSize, 10_000);
	}

	recordRetrieval(input: RecordRetrievalInput): RetrievalReceipt {
		validateAttempt(input);
		const scopeKey = repositoryScopeKey(input.scope);
		const policy = evaluateCapturePolicy(input);
		if (!policy.persist) {
			return {
				sourceId: null,
				retrievalId: null,
				snapshotId: null,
				contentHash: null,
				snapshotHash: null,
				changed: false,
				persisted: false,
				warning: policy.code === null ? null : { code: policy.code, message: policy.message! },
			};
		}
		if (this.scopeDeleting(scopeKey)) return this.blockedReceipt("The source scope is being deleted.");
		const artifact = input.artifact;
		const url = artifact === null ? input.requestedUrl : artifact.finalUrl;
		let normalizedUrl: string;
		try {
			normalizedUrl = canonicalUrlKey(url);
		} catch {
			throw new SourceRepositoryError("INVALID_INPUT", "The source URL is invalid.");
		}
		const existingSource = this.db.prepare("SELECT * FROM forage_sources WHERE scope_key = ? AND normalized_url = ?").get(scopeKey, normalizedUrl) as SourceRow | undefined;
		if (existingSource?.deleting === 1) return this.blockedReceipt("The source is being deleted.");
		let structuredJson: string | null = null;
		let computedSnapshotHash: string | null = null;
		let contentBytes = 0;
		let structuredBytes = 0;
		let existingSnapshot: SnapshotRow | undefined;
		if (artifact !== null) {
			const computedContentHash = sha256(artifact.content);
			if (computedContentHash !== artifact.contentHash) throw new SourceRepositoryError("INVALID_INPUT", "The retrieval content hash does not match its content.");
			structuredJson = stableJson(artifact.structured ?? emptyStructured(artifact));
			computedSnapshotHash = snapshotHash(artifact, structuredJson);
			contentBytes = Buffer.byteLength(artifact.content, "utf8");
			structuredBytes = Buffer.byteLength(structuredJson, "utf8");
			if (contentBytes > MAX_SOURCE_BYTES || structuredBytes > MAX_STRUCTURED_BYTES) return this.storageReceipt("The source exceeds the per-snapshot storage limit.");
			if (existingSource) {
				existingSnapshot = this.db.prepare("SELECT * FROM forage_snapshots WHERE source_id = ? AND snapshot_hash = ?").get(existingSource.id, computedSnapshotHash) as SnapshotRow | undefined;
			}
		}

		return this.db.transaction(() => {
			if (artifact !== null && !existingSnapshot && !this.makeCapacity(contentBytes, this.maxContentBytes)) {
				return this.storageReceipt("The source cannot fit within the retained-content limit.");
			}
			const at = this.now();
			const sourceId = existingSource?.id ?? id("src");
			const lastRetrievedAt = Math.max(existingSource?.last_retrieved_at ?? 0, input.attempt.finishedAt);
			const latestSuccess = existingSource
				? this.db.prepare("SELECT MAX(finished_at) AS finished_at FROM forage_retrievals WHERE source_id = ? AND snapshot_id IS NOT NULL AND cache_state != 'hit'").get(existingSource.id) as { finished_at: number | null }
				: null;
			const isLatestRetrieval = latestSuccess?.finished_at === null || latestSuccess === null || input.attempt.finishedAt >= latestSuccess.finished_at;
			const requestedAccess = artifact === null ? input.access : artifact.access;
			const access: AccessDescriptor = existingSource
				? {
					network: existingSource.access_network === "private" || requestedAccess.network === "private" ? "private" : "public",
					credentialed: existingSource.access_credentialed === 1 || requestedAccess.credentialed,
					requestScopeKey: existingSource.request_scope_key ?? requestedAccess.requestScopeKey,
				}
				: requestedAccess;
			const advancesLatest = isLatestRetrieval && (input.attempt.cache !== "hit" || existingSource?.latest_snapshot_id == null);
			const canonicalUrl = existingSource && !advancesLatest ? existingSource.canonical_url : artifact?.structured?.canonicalUrl ?? artifact?.finalUrl ?? existingSource?.canonical_url ?? null;
			const title = existingSource && !advancesLatest ? existingSource.title : artifact?.title ?? existingSource?.title ?? "";
			if (existingSource) {
				this.db.prepare(`UPDATE forage_sources SET display_url = ?, canonical_url = ?, access_network = ?, access_credentialed = ?, request_scope_key = ?,
					title = ?, last_retrieved_at = ?, updated_at = ? WHERE id = ?`).run(url, canonicalUrl, access.network, access.credentialed ? 1 : 0, access.requestScopeKey, title, lastRetrievedAt, at, sourceId);
			} else {
				this.db.prepare(`INSERT INTO forage_sources (id, scope_key, scope_kind, project_id, thread_id, normalized_url, display_url, canonical_url,
					access_network, access_credentialed, request_scope_key, title, latest_snapshot_id, last_retrieved_at, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`).run(
					sourceId,
					scopeKey,
					input.scope.kind,
					input.scope.projectId,
					input.scope.kind === "thread" ? input.scope.threadId : null,
					normalizedUrl,
					url,
					canonicalUrl,
					access.network,
					access.credentialed ? 1 : 0,
					access.requestScopeKey,
					title,
					lastRetrievedAt,
					at,
					at,
				);
			}
			let snapshotId: string | null = existingSnapshot?.id ?? null;
			let changed = false;
			if (artifact !== null && snapshotId === null) {
				snapshotId = id("snap");
				this.db.prepare(`INSERT INTO forage_snapshots (id, source_id, kind, content_type, content, structured_json, content_hash, snapshot_hash,
					extractor_id, extractor_version, truncated, content_bytes, structured_bytes, fetched_at, retained_at, completeness_json, warnings_json)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
					snapshotId,
					sourceId,
					artifact.kind,
					normalizedContentType(artifact.contentType),
					artifact.content,
					structuredJson,
					artifact.contentHash,
					computedSnapshotHash,
					artifact.extraction.id,
					artifact.extraction.id,
					artifact.completeness.state === "complete" ? 0 : 1,
					contentBytes,
					structuredBytes,
					fetchedAt(artifact),
					Math.max(fetchedAt(artifact), input.attempt.finishedAt),
					stableJson(artifact.completeness),
					stableJson(safeWarnings(artifact)),
				);
				changed = true;
			}
			const retrievalId = id("ret");
			const status = artifact === null ? "failed" : artifact.completeness.state;
			this.db.prepare(`INSERT INTO forage_retrievals (id, source_id, snapshot_id, origin, status, requested_url, resolved_url, final_url, transport,
				representation, access_network, access_credentialed, request_scope_key, http_status, artifact_bytes, redirects, diagnostics_json,
				completeness_json, warnings_json, started_at, finished_at, transferred_bytes, cache_state, error)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				retrievalId,
				sourceId,
				snapshotId,
				input.origin,
				status,
				artifact === null ? input.requestedUrl : artifact.requestedUrl,
				artifact?.resolvedUrl ?? null,
				artifact?.finalUrl ?? null,
				artifact?.transport ?? null,
				artifact?.representation ?? null,
				requestedAccess.network,
				requestedAccess.credentialed ? 1 : 0,
				requestedAccess.requestScopeKey,
				input.attempt.httpStatus,
				artifact?.bytes ?? null,
				artifact?.diagnostics.redirects ?? null,
				artifact ? stableJson(artifact.diagnostics) : null,
				artifact ? stableJson(artifact.completeness) : null,
				artifact ? stableJson(safeWarnings(artifact)) : stableJson([]),
				input.attempt.startedAt,
				input.attempt.finishedAt,
				input.attempt.transferredBytes,
				input.attempt.cache,
				sanitizeError(input.attempt.error),
			);
			if (snapshotId !== null) {
				this.db.prepare("UPDATE forage_snapshots SET retained_at = MAX(retained_at, ?) WHERE id = ?").run(input.attempt.finishedAt, snapshotId);
				if (advancesLatest) this.db.prepare("UPDATE forage_sources SET latest_snapshot_id = ? WHERE id = ?").run(snapshotId, sourceId);
			}
			return {
				sourceId,
				retrievalId,
				snapshotId,
				contentHash: artifact?.contentHash ?? null,
				snapshotHash: computedSnapshotHash,
				changed,
				persisted: true,
				warning: null,
			};
		})();
	}

	recordDiscovery(input: { scope: SourceScope; fromSourceId: string | null; method: DiscoveredUrl["method"]; urls: readonly DiscoveredUrl[]; observedAt: number }): void {
		const scopeKey = repositoryScopeKey(input.scope);
		if (this.scopeDeleting(scopeKey)) throw new SourceRepositoryError("POLICY_BLOCKED", "The source scope is being deleted.");
		if (input.fromSourceId !== null && !this.sourceRow(input.scope, input.fromSourceId)) throw new SourceRepositoryError("SOURCE_NOT_VISIBLE", "The source is not visible in this scope.");
		if (input.urls.length > MAX_DISCOVERY_URLS) throw new SourceRepositoryError("INVALID_INPUT", `Discovery batches cannot exceed ${MAX_DISCOVERY_URLS} URLs.`);
		if (input.urls.some((url) => url.method !== input.method)) throw new SourceRepositoryError("INVALID_INPUT", "Discovery methods must match the recorded batch method.");
		if (input.urls.some((url) => isSensitiveUrl(url.url) || isSensitiveUrl(url.parentUrl))) throw new SourceRepositoryError("POLICY_BLOCKED", "Discovery storage was rejected by the sensitive URL policy.");
		this.db.transaction(() => {
			const statement = this.db.prepare(`INSERT INTO forage_discovery_links (scope_key, from_source_id, method, url, parent_url, title, last_modified, observed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT
				DO UPDATE SET title = excluded.title, last_modified = excluded.last_modified, observed_at = excluded.observed_at`);
			for (const url of input.urls) statement.run(scopeKey, input.fromSourceId, input.method, url.url, url.parentUrl, url.title, url.lastModified, input.observedAt);
		})();
	}

	list(query: SourceListQuery): SourcePage {
		const limit = validateLimit(query.limit);
		const cursor = decodeCursor(query.cursor);
		const scopeKey = repositoryScopeKey(query.scope);
		if (this.scopeDeleting(scopeKey)) return { sources: [], nextCursor: null };
		const conditions = ["scope_key = ?", "deleting = 0"];
		const args: unknown[] = [scopeKey];
		if (query.query !== undefined && query.query.trim() !== "") {
			conditions.push("(title LIKE ? ESCAPE '\\' OR display_url LIKE ? ESCAPE '\\')");
			const escaped = `%${query.query.replace(/[\\%_]/gu, "\\$&")}%`;
			args.push(escaped, escaped);
		}
		if (cursor) {
			conditions.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
			args.push(cursor.at, cursor.at, cursor.id);
		}
		args.push(limit + 1);
		const rows = this.db.prepare(`SELECT * FROM forage_sources WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...args) as SourceRow[];
		const page = rows.slice(0, limit);
		return {
			sources: page.map((row) => this.sourceSummary(row)),
			nextCursor: rows.length > limit ? encodeCursor({ at: page.at(-1)!.updated_at, id: page.at(-1)!.id }) : null,
		};
	}

	get(scope: SourceScope, sourceId: string, query: SourceDetailQuery = {}): SourceDetail | null {
		const row = this.sourceRow(scope, sourceId);
		if (!row) return null;
		const limit = validateLimit(query.limit ?? 50);
		return {
			...this.sourceSummary(row),
			snapshots: this.snapshotPage(sourceId, query.snapshotCursor, limit),
			retrievals: this.retrievalPage(sourceId, query.retrievalCursor, limit),
		};
	}

	readSnapshot(scope: SourceScope, snapshotId: string, range: { offset: number; maxChars: number; contentHash?: string }): SnapshotReadResult {
		if (!Number.isInteger(range.offset) || range.offset < 0 || !Number.isInteger(range.maxChars) || range.maxChars < 1 || range.maxChars > 200_000) {
			throw new SourceRepositoryError("INVALID_INPUT", "Snapshot ranges must use a non-negative offset and 1 to 200000 characters.");
		}
		const row = this.snapshotRow(scope, snapshotId);
		if (!row) {
			const tombstone = this.db.prepare("SELECT 1 FROM forage_snapshot_tombstones WHERE scope_key = ? AND id = ?").get(repositoryScopeKey(scope), snapshotId);
			return tombstone ? { status: "evicted" } : { status: "not-visible" };
		}
		if (range.contentHash !== undefined && range.contentHash !== row.content_hash) return { status: "stale", contentHash: row.content_hash };
		const offset = nextCodePointBoundary(row.content, Math.min(range.offset, row.content.length));
		let end = previousCodePointBoundary(row.content, Math.min(row.content.length, offset + range.maxChars));
		if (end === offset && offset < row.content.length) end = nextCodePointBoundary(row.content, offset + 1);
		const text = row.content.slice(offset, end);
		const startLine = row.content.slice(0, offset).split("\n").length;
		const endLine = row.content.slice(0, Math.max(offset, end - 1)).split("\n").length;
		const source = this.db.prepare("SELECT display_url FROM forage_sources WHERE id = ?").get(row.source_id) as { display_url: string };
		return {
			status: "ok",
			slice: {
				snapshot: this.snapshotMeta(row),
				offset,
				end,
				total: row.content.length,
				text,
				citation: `${source.display_url} source:${row.source_id} snapshot:${row.id} lines:${startLine}-${endLine}`,
				nextOffset: end < row.content.length ? end : null,
			},
		};
	}

	getSnapshot(scope: SourceScope, snapshotId: string): SnapshotDocument | null {
		const row = this.snapshotRow(scope, snapshotId);
		return row ? this.snapshotDocument(row, scope) : null;
	}

	snapshotPair(scope: SourceScope, input: { sourceId: string; beforeId?: string; afterId?: string }): { before: SnapshotDocument; after: SnapshotDocument } | null {
		const source = this.sourceRow(scope, input.sourceId);
		if (!source) return null;
		let ids: string[];
		if (input.beforeId && input.afterId) ids = [input.beforeId, input.afterId];
		else {
			if (source.latest_snapshot_id === null) return null;
			const previous = this.db.prepare(`SELECT snapshot_id AS id FROM forage_retrievals
				WHERE source_id = ? AND snapshot_id IS NOT NULL AND snapshot_id != ?
				ORDER BY (cache_state != 'hit') DESC, finished_at DESC, rowid DESC LIMIT 1`).get(source.id, source.latest_snapshot_id) as { id: string } | undefined;
			if (!previous) return null;
			ids = [previous.id, source.latest_snapshot_id];
		}
		const before = this.getSnapshot(scope, ids[0]!);
		const after = this.getSnapshot(scope, ids[1]!);
		if (!before || !after || before.sourceId !== source.id || after.sourceId !== source.id) return null;
		return { before, after };
	}

	copyToProject(input: { from: Extract<SourceScope, { kind: "thread" }>; sourceId: string }): CopyReceipt {
		const source = this.sourceRow(input.from, input.sourceId);
		if (!source || source.latest_snapshot_id === null) throw new SourceRepositoryError("SOURCE_NOT_VISIBLE", "The source is not visible in this scope.");
		if (isRestrictedAccess(accessFromRow(source))) throw new SourceRepositoryError("POLICY_BLOCKED", "Restricted sources cannot be copied to a project.");
		const snapshot = this.db.prepare("SELECT * FROM forage_snapshots WHERE id = ?").get(source.latest_snapshot_id) as SnapshotRow;
		const targetScope: SourceScope = { kind: "project", projectId: input.from.projectId };
		const targetKey = repositoryScopeKey(targetScope);
		if (this.scopeDeleting(targetKey)) throw new SourceRepositoryError("POLICY_BLOCKED", "The target source scope is being deleted.");
		let target = this.db.prepare("SELECT * FROM forage_sources WHERE scope_key = ? AND normalized_url = ?").get(targetKey, source.normalized_url) as SourceRow | undefined;
		if (target?.deleting === 1) throw new SourceRepositoryError("POLICY_BLOCKED", "The target source is being deleted.");
		const existing = target ? this.db.prepare("SELECT * FROM forage_snapshots WHERE source_id = ? AND snapshot_hash = ?").get(target.id, snapshot.snapshot_hash) as SnapshotRow | undefined : undefined;
		return this.db.transaction(() => {
			if (!existing && !this.makeCapacity(snapshot.content_bytes, this.maxContentBytes)) {
				throw new SourceRepositoryError("STORAGE_LIMIT", "The project copy cannot fit within the retained-content limit.");
			}
			const at = this.now();
			if (!target) {
				const targetId = id("src");
				this.db.prepare(`INSERT INTO forage_sources (id, scope_key, scope_kind, project_id, thread_id, normalized_url, display_url, canonical_url,
					access_network, access_credentialed, request_scope_key, title, latest_snapshot_id, last_retrieved_at, created_at, updated_at)
					VALUES (?, ?, 'project', ?, NULL, ?, ?, ?, 'public', 0, NULL, ?, NULL, ?, ?, ?)`).run(
					targetId,
					targetKey,
					input.from.projectId,
					source.normalized_url,
					source.display_url,
					source.canonical_url,
					source.title,
					at,
					at,
					at,
				);
				target = this.db.prepare("SELECT * FROM forage_sources WHERE id = ?").get(targetId) as SourceRow;
			}
			const snapshotId = existing?.id ?? id("snap");
			if (!existing) {
				this.db.prepare(`INSERT INTO forage_snapshots (id, source_id, kind, content_type, content, structured_json, content_hash, snapshot_hash, extractor_id,
					extractor_version, truncated, content_bytes, structured_bytes, fetched_at, retained_at, completeness_json, warnings_json)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
					snapshotId, target.id, snapshot.kind, snapshot.content_type, snapshot.content, snapshot.structured_json, snapshot.content_hash,
					snapshot.snapshot_hash, snapshot.extractor_id, snapshot.extractor_version, snapshot.truncated, snapshot.content_bytes,
					snapshot.structured_bytes, snapshot.fetched_at, at, snapshot.completeness_json, snapshot.warnings_json,
				);
			}
			this.db.prepare("UPDATE forage_sources SET latest_snapshot_id = ?, last_retrieved_at = ?, updated_at = ? WHERE id = ?").run(snapshotId, at, at, target.id);
			const completeness = JSON.parse(snapshot.completeness_json) as RetrievalArtifact["completeness"];
			this.db.prepare(`INSERT INTO forage_retrievals (id, source_id, snapshot_id, origin, status, requested_url, resolved_url, final_url, transport,
				representation, access_network, access_credentialed, request_scope_key, http_status, artifact_bytes, redirects, diagnostics_json,
				completeness_json, warnings_json, started_at, finished_at, transferred_bytes, cache_state, error)
				VALUES (?, ?, ?, 'import', ?, ?, ?, ?, NULL, NULL, 'public', 0, NULL, 200, ?, 0, ?, ?, ?, ?, ?, 0, 'hit', NULL)`).run(
				id("ret"), target.id, snapshotId, completeness.state, source.display_url, source.display_url, source.display_url, snapshot.content_bytes,
				stableJson({ durationMs: 0, redirects: 0, stageMs: {} }), snapshot.completeness_json, snapshot.warnings_json, at, at,
			);
			this.db.prepare("UPDATE forage_snapshots SET retained_at = MAX(retained_at, ?) WHERE id = ?").run(at, snapshotId);
			return { sourceId: target.id, snapshotId, copied: !existing };
		})();
	}

	async deleteSource(scope: SourceScope, sourceId: string, options: RepositoryWorkOptions = {}): Promise<DeleteReceipt> {
		checkWork(options);
		const source = this.sourceRow(scope, sourceId);
		if (!source) return emptyDeleteReceipt();
		for (const snapshotId of this.maintenance.protectedSnapshotIds()) {
			if (this.db.prepare("SELECT 1 FROM forage_snapshots WHERE source_id = ? AND id = ?").get(source.id, snapshotId)) {
				throw new SourceRepositoryError("ACTIVE_JOB", "Cancel the active job before deleting this source.");
			}
		}
		this.db.prepare("UPDATE forage_sources SET deleting = 1 WHERE id = ?").run(source.id);
		const receipt = await this.deleteSourcePhysical(source, "source-deleted", options);
		this.checkpointWal();
		return receipt;
	}

	async deleteScope(scope: SourceScope, options: RepositoryWorkOptions = {}): Promise<DeleteReceipt> {
		checkWork(options);
		const scopeKey = repositoryScopeKey(scope);
		this.maintenance.invalidateScope(scope);
		this.db.transaction(() => {
			this.db.prepare("INSERT INTO forage_scope_deletions (scope_key, scope_json, started_at) VALUES (?, ?, ?) ON CONFLICT (scope_key) DO NOTHING").run(scopeKey, JSON.stringify(scope), this.now());
			this.db.prepare("UPDATE forage_sources SET deleting = 1 WHERE scope_key = ?").run(scopeKey);
		})();
		const receipt = emptyDeleteReceipt();
		receipt.jobs = await this.maintenance.deleteScope(scope);
		for (;;) {
			const row = this.db.prepare("SELECT * FROM forage_sources WHERE scope_key = ? ORDER BY id LIMIT 1").get(scopeKey) as SourceRow | undefined;
			if (!row) break;
			addDeleteReceipt(receipt, await this.deleteSourcePhysical(row, "scope-deleted", options));
		}
		for (;;) {
			const ids = (this.db.prepare("SELECT id FROM forage_discovery_links WHERE scope_key = ? LIMIT ?").all(scopeKey, this.deleteBatchSize) as Array<{ id: number }>).map((row) => row.id);
			if (ids.length === 0) break;
			receipt.discoveryLinks += this.db.prepare(`DELETE FROM forage_discovery_links WHERE id IN (${placeholders(ids.length)})`).run(...ids).changes;
			await yieldToHost(options);
		}
		for (;;) {
			const ids = (this.db.prepare("SELECT id FROM forage_snapshot_tombstones WHERE scope_key = ? LIMIT ?").all(scopeKey, this.deleteBatchSize) as Array<{ id: string }>).map((row) => row.id);
			if (ids.length === 0) break;
			this.db.prepare(`DELETE FROM forage_snapshot_tombstones WHERE id IN (${placeholders(ids.length)})`).run(...ids);
			await yieldToHost(options);
		}
		this.db.prepare("DELETE FROM forage_scope_deletions WHERE scope_key = ?").run(scopeKey);
		this.checkpointWal();
		return receipt;
	}

	async resumePendingDeletes(options: RepositoryWorkOptions = {}): Promise<DeleteReceipt> {
		checkWork(options);
		const receipt = emptyDeleteReceipt();
		for (;;) {
			const entry = this.db.prepare("SELECT scope_json FROM forage_scope_deletions ORDER BY started_at, scope_key LIMIT 1").get() as { scope_json: string } | undefined;
			if (!entry) break;
			addDeleteReceipt(receipt, await this.deleteScope(JSON.parse(entry.scope_json) as SourceScope, options));
		}
		for (;;) {
			const row = this.db.prepare("SELECT * FROM forage_sources WHERE deleting = 1 ORDER BY id LIMIT 1").get() as SourceRow | undefined;
			if (!row) break;
			addDeleteReceipt(receipt, await this.deleteSourcePhysical(row, "source-deleted", options));
		}
		this.checkpointWal();
		return receipt;
	}

	async prune(input: import("./model.ts").RetentionPolicy & RepositoryWorkOptions & { now: number }): Promise<PruneReceipt> {
		checkWork(input);
		if (![input.threadDays, input.projectDays, input.completedJobDays, input.failedJobDays, input.maxContentBytes, input.now].every((value) => Number.isFinite(value) && value >= 0)) {
			throw new SourceRepositoryError("INVALID_INPUT", "Retention values must be non-negative finite numbers.");
		}
		const protectedIds = this.maintenance.protectedSnapshotIds();
		const threadBefore = input.now - input.threadDays * DAY_MS;
		const projectBefore = input.now - input.projectDays * DAY_MS;
		const receipt: PruneReceipt = { ...emptyDeleteReceipt(), expiredSnapshots: 0, budgetSnapshots: 0 };
		let afterAt = -1;
		let afterId = "";
		let afterDiscoveryId = 0;
		const discoveryCandidateBefore = Math.max(threadBefore, projectBefore);
		for (;;) {
			const rows = this.db.prepare(`SELECT id, scope_key, observed_at FROM forage_discovery_links INDEXED BY forage_discovery_observed
				WHERE observed_at < ? AND (observed_at, id) > (?, ?) ORDER BY observed_at, id LIMIT ?`).all(
				discoveryCandidateBefore, afterAt, afterDiscoveryId, this.deleteBatchSize,
			) as Array<{ id: number; scope_key: string; observed_at: number }>;
			if (rows.length === 0) break;
			const last = rows.at(-1)!;
			afterAt = last.observed_at;
			afterDiscoveryId = last.id;
			const ids = rows.filter((row) => {
				const cutoff = retentionCutoff(row.scope_key, threadBefore, projectBefore);
				return cutoff !== null && row.observed_at < cutoff;
			}).map((row) => row.id);
			if (ids.length > 0) receipt.discoveryLinks += this.db.prepare(`DELETE FROM forage_discovery_links WHERE id IN (${placeholders(ids.length)})`).run(...ids).changes;
			await yieldToHost(input);
		}
		afterAt = -1;
		afterId = "";
		for (;;) {
			const rows = this.db.prepare(`SELECT s.id, s.retained_at FROM forage_snapshots s INDEXED BY forage_snapshots_retained
				JOIN forage_sources src ON src.id = s.source_id
				WHERE src.deleting = 0 AND ((src.scope_kind = 'thread' AND s.retained_at < ?) OR (src.scope_kind = 'project' AND s.retained_at < ?))
				AND (s.retained_at, s.id) > (?, ?) ORDER BY s.retained_at, s.id LIMIT ?`).all(
				threadBefore, projectBefore, afterAt, afterId, this.deleteBatchSize,
			) as Array<{ id: string; retained_at: number }>;
			if (rows.length === 0) break;
			const last = rows.at(-1)!;
			afterAt = last.retained_at;
			afterId = last.id;
			const removed = this.evictSnapshotIds(rows.map((row) => row.id).filter((snapshotId) => !protectedIds.has(snapshotId)), "expired");
			receipt.snapshots += removed.snapshots;
			receipt.bytes += removed.bytes;
			receipt.expiredSnapshots += removed.snapshots;
			await yieldToHost(input);
		}
		const cap = Math.min(input.maxContentBytes, this.maxContentBytes);
		let total = this.contentBytes();
		afterAt = -1;
		afterId = "";
		while (total > cap) {
			const rows = this.db.prepare(`SELECT s.id, s.content_bytes, s.retained_at FROM forage_snapshots s INDEXED BY forage_snapshots_retained
				JOIN forage_sources src ON src.id = s.source_id WHERE src.deleting = 0
				AND (s.retained_at, s.id) > (?, ?)
				ORDER BY s.retained_at, s.id LIMIT ?`).all(afterAt, afterId, this.deleteBatchSize) as Array<{ id: string; content_bytes: number; retained_at: number }>;
			if (rows.length === 0) break;
			const last = rows.at(-1)!;
			afterAt = last.retained_at;
			afterId = last.id;
			const selected: string[] = [];
			for (const row of rows) {
				if (total <= cap) break;
				if (protectedIds.has(row.id)) continue;
				selected.push(row.id);
				total -= row.content_bytes;
			}
			const removed = this.evictSnapshotIds(selected, "storage-limit");
			receipt.snapshots += removed.snapshots;
			receipt.bytes += removed.bytes;
			receipt.budgetSnapshots += removed.snapshots;
			await yieldToHost(input);
		}
		afterAt = -1;
		afterId = "";
		for (;;) {
			const rows = this.db.prepare(`SELECT r.id, r.finished_at FROM forage_retrievals r INDEXED BY forage_retrievals_finished
				JOIN forage_sources src ON src.id = r.source_id
				WHERE src.deleting = 0 AND ((src.scope_kind = 'thread' AND r.finished_at < ?) OR (src.scope_kind = 'project' AND r.finished_at < ?))
				AND (r.finished_at, r.id) > (?, ?) ORDER BY r.finished_at, r.id LIMIT ?`).all(
				threadBefore, projectBefore, afterAt, afterId, this.deleteBatchSize,
			) as Array<{ id: string; finished_at: number }>;
			if (rows.length === 0) break;
			const last = rows.at(-1)!;
			afterAt = last.finished_at;
			afterId = last.id;
			const ids = rows.map((row) => row.id);
			receipt.retrievals += this.db.prepare(`DELETE FROM forage_retrievals WHERE id IN (${placeholders(ids.length)})`).run(...ids).changes;
			await yieldToHost(input);
		}
		const tombstoneThreadBefore = threadBefore - TOMBSTONE_WINDOW_MS;
		const tombstoneProjectBefore = projectBefore - TOMBSTONE_WINDOW_MS;
		const tombstoneCandidateBefore = Math.max(tombstoneThreadBefore, tombstoneProjectBefore);
		afterAt = -1;
		afterId = "";
		for (;;) {
			const rows = this.db.prepare(`SELECT id, scope_key, retained_at FROM forage_snapshot_tombstones INDEXED BY forage_snapshot_tombstones_retained
				WHERE retained_at < ? AND (retained_at, id) > (?, ?) ORDER BY retained_at, id LIMIT ?`).all(
				tombstoneCandidateBefore, afterAt, afterId, this.deleteBatchSize,
			) as Array<{ id: string; scope_key: string; retained_at: number }>;
			if (rows.length === 0) break;
			const last = rows.at(-1)!;
			afterAt = last.retained_at;
			afterId = last.id;
			const ids = rows.filter((row) => {
				const cutoff = retentionCutoff(row.scope_key, tombstoneThreadBefore, tombstoneProjectBefore);
				return cutoff !== null && row.retained_at < cutoff;
			}).map((row) => row.id);
			if (ids.length > 0) this.db.prepare(`DELETE FROM forage_snapshot_tombstones WHERE id IN (${placeholders(ids.length)})`).run(...ids);
			await yieldToHost(input);
		}
		for (;;) {
			const row = this.db.prepare(`SELECT src.* FROM forage_sources src WHERE src.deleting = 0
				AND NOT EXISTS (SELECT 1 FROM forage_snapshots s WHERE s.source_id = src.id)
				AND NOT EXISTS (SELECT 1 FROM forage_retrievals r WHERE r.source_id = src.id)
				AND NOT EXISTS (SELECT 1 FROM forage_snapshot_tombstones t WHERE t.source_id = src.id)
				ORDER BY src.updated_at, src.id LIMIT 1`).get() as SourceRow | undefined;
			if (!row) break;
			addDeleteReceipt(receipt, await this.deleteSourcePhysical(row, "source-deleted", input));
		}
		receipt.jobs = await this.maintenance.pruneJobs({ completedBefore: input.now - input.completedJobDays * DAY_MS, failedBefore: input.now - input.failedJobDays * DAY_MS });
		this.checkpointWal();
		return receipt;
	}

	async *export(scope: SourceScope, options: SourceExportOptions): AsyncIterable<SourceExportRecord> {
		checkWork(options);
		if (options.sourceIds && options.sourceIds.length > MAX_EXPORT_SOURCES) throw new SourceRepositoryError("INVALID_INPUT", `Exports cannot select more than ${MAX_EXPORT_SOURCES} sources.`);
		if (scope.kind === "project" && options.includeRestricted) throw new SourceRepositoryError("POLICY_BLOCKED", "Restricted export is available only for explicitly selected records in a thread scope.");
		const selected = options.sourceIds ? new Set(options.sourceIds) : null;
		const selectedIds = selected ? [...selected].sort() : null;
		const scopeKey = repositoryScopeKey(scope);
		let afterSource = "";
		for (;;) {
			if (selectedIds?.length === 0) break;
			const sourceBatch = selectedIds?.splice(0, ITERATOR_BATCH);
			const rows = (sourceBatch
				? this.db.prepare(`SELECT * FROM forage_sources WHERE scope_key = ? AND deleting = 0 AND id IN (${placeholders(sourceBatch.length)}) ORDER BY id`).all(scopeKey, ...sourceBatch)
				: this.db.prepare("SELECT * FROM forage_sources WHERE scope_key = ? AND deleting = 0 AND id > ? ORDER BY id LIMIT ?").all(scopeKey, afterSource, ITERATOR_BATCH)) as SourceRow[];
			if (rows.length === 0 && selectedIds === null) break;
			for (const row of rows) {
				afterSource = row.id;
				if (selected && !selected.has(row.id)) continue;
				const restricted = isRestrictedAccess(accessFromRow(row));
				if (restricted && !(scope.kind === "thread" && options.includeRestricted === true && selected?.has(row.id))) continue;
				const source = this.sourceSummary(row);
				let afterSnapshot = "";
				for (;;) {
					const snapshots = this.db.prepare("SELECT * FROM forage_snapshots WHERE source_id = ? AND id > ? ORDER BY id LIMIT ?").all(row.id, afterSnapshot, ITERATOR_BATCH) as SnapshotRow[];
					if (snapshots.length === 0) break;
					for (const snapshot of snapshots) {
						afterSnapshot = snapshot.id;
						yield { source, snapshot: this.snapshotDocument(snapshot, scope) };
						await yieldToHost(options);
					}
				}
			}
			await yieldToHost(options);
		}
	}

	storageSummary(scope: SourceScope): SourceStorageSummary {
		const scopeKey = repositoryScopeKey(scope);
		const row = this.db.prepare(`SELECT COUNT(DISTINCT src.id) AS sources, COUNT(s.id) AS snapshots,
			(SELECT COUNT(*) FROM forage_retrievals r JOIN forage_sources rsrc ON rsrc.id = r.source_id WHERE rsrc.scope_key = ?) AS retrievals,
			COALESCE(SUM(s.content_bytes), 0) AS content_bytes
			FROM forage_sources src LEFT JOIN forage_snapshots s ON s.source_id = src.id WHERE src.scope_key = ?`).get(scopeKey, scopeKey) as { sources: number; snapshots: number; retrievals: number; content_bytes: number };
		return { scope, sources: row.sources, snapshots: row.snapshots, retrievals: row.retrievals, contentBytes: row.content_bytes, deleting: this.scopeDeleting(scopeKey) };
	}

	async *scopes(): AsyncIterable<SourceScope> {
		let after = "";
		for (;;) {
			const rows = this.db.prepare(`SELECT scope_key, scope_kind, project_id, thread_id FROM forage_sources
				WHERE scope_key > ? GROUP BY scope_key, scope_kind, project_id, thread_id ORDER BY scope_key LIMIT ?`).all(after, ITERATOR_BATCH) as Array<Pick<SourceRow, "scope_key" | "scope_kind" | "project_id" | "thread_id">>;
			if (rows.length === 0) break;
			for (const row of rows) {
				after = row.scope_key;
				yield scopeFromRow(row);
			}
			await yieldToHost({});
		}
	}

	private blockedReceipt(message: string): RetrievalReceipt {
		return { sourceId: null, retrievalId: null, snapshotId: null, contentHash: null, snapshotHash: null, changed: false, persisted: false, warning: { code: "POLICY_BLOCKED", message } };
	}

	private storageReceipt(message: string): RetrievalReceipt {
		return { sourceId: null, retrievalId: null, snapshotId: null, contentHash: null, snapshotHash: null, changed: false, persisted: false, warning: { code: "STORAGE_LIMIT", message } };
	}

	private scopeDeleting(scopeKey: string): boolean {
		return this.db.prepare("SELECT 1 FROM forage_scope_deletions WHERE scope_key = ?").get(scopeKey) !== undefined;
	}

	private sourceRow(scope: SourceScope, sourceId: string): SourceRow | null {
		return (this.db.prepare("SELECT * FROM forage_sources WHERE scope_key = ? AND id = ? AND deleting = 0").get(repositoryScopeKey(scope), sourceId) as SourceRow | undefined) ?? null;
	}

	private snapshotRow(scope: SourceScope, snapshotId: string): SnapshotRow | null {
		return (this.db.prepare(`SELECT s.* FROM forage_snapshots s JOIN forage_sources src ON src.id = s.source_id
			WHERE src.scope_key = ? AND src.deleting = 0 AND s.id = ?`).get(repositoryScopeKey(scope), snapshotId) as SnapshotRow | undefined) ?? null;
	}

	private sourceSummary(row: SourceRow): SourceSummary {
		const latest = row.latest_snapshot_id ? this.db.prepare("SELECT * FROM forage_snapshots WHERE id = ?").get(row.latest_snapshot_id) as SnapshotRow | undefined : undefined;
		return {
			id: row.id,
			scope: scopeFromRow(row),
			access: accessFromRow(row),
			url: row.display_url,
			canonicalUrl: row.canonical_url,
			title: row.title,
			latestSnapshot: latest ? this.snapshotMeta(latest) : null,
			lastRetrievedAt: row.last_retrieved_at,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	private snapshotMeta(row: SnapshotRow): SnapshotMeta {
		const checked = this.db.prepare("SELECT MAX(finished_at) AS checked_at FROM forage_retrievals WHERE snapshot_id = ?").get(row.id) as { checked_at: number | null };
		return {
			id: row.id,
			sourceId: row.source_id,
			kind: row.kind,
			contentHash: row.content_hash,
			snapshotHash: row.snapshot_hash,
			extractorId: row.extractor_id,
			extractorVersion: row.extractor_version,
			chars: row.content.length,
			bytes: row.content_bytes,
			truncated: row.truncated === 1,
			fetchedAt: row.fetched_at,
			checkedAt: checked.checked_at ?? row.fetched_at,
		};
	}

	private snapshotDocument(row: SnapshotRow, scope: SourceScope): SnapshotDocument {
		return {
			...this.snapshotMeta(row),
			scope,
			contentType: row.content_type,
			content: row.content,
			structured: JSON.parse(row.structured_json) as StructuredDocument,
			completeness: JSON.parse(row.completeness_json) as RetrievalArtifact["completeness"],
			warnings: JSON.parse(row.warnings_json) as RetrievalArtifact["warnings"],
		};
	}

	private snapshotPage(sourceId: string, cursorValue: string | undefined, limit: number): CursorPage<SnapshotMeta> {
		const cursor = decodeCursor(cursorValue);
		const args: unknown[] = [sourceId];
		let condition = "";
		if (cursor) {
			condition = "AND (fetched_at < ? OR (fetched_at = ? AND id < ?))";
			args.push(cursor.at, cursor.at, cursor.id);
		}
		args.push(limit + 1);
		const rows = this.db.prepare(`SELECT * FROM forage_snapshots WHERE source_id = ? ${condition} ORDER BY fetched_at DESC, id DESC LIMIT ?`).all(...args) as SnapshotRow[];
		const page = rows.slice(0, limit);
		return { items: page.map((row) => this.snapshotMeta(row)), nextCursor: rows.length > limit ? encodeCursor({ at: page.at(-1)!.fetched_at, id: page.at(-1)!.id }) : null };
	}

	private retrievalPage(sourceId: string, cursorValue: string | undefined, limit: number): CursorPage<RetrievalSummary> {
		const cursor = decodeCursor(cursorValue);
		const args: unknown[] = [sourceId];
		let condition = "";
		if (cursor) {
			condition = "AND (finished_at < ? OR (finished_at = ? AND id < ?))";
			args.push(cursor.at, cursor.at, cursor.id);
		}
		args.push(limit + 1);
		const rows = this.db.prepare(`SELECT * FROM forage_retrievals WHERE source_id = ? ${condition} ORDER BY finished_at DESC, id DESC LIMIT ?`).all(...args) as RetrievalRow[];
		const page = rows.slice(0, limit);
		return {
			items: page.map((row) => ({
				id: row.id,
				origin: row.origin,
				status: row.status,
				requestedUrl: row.requested_url,
				resolvedUrl: row.resolved_url,
				finalUrl: row.final_url,
				transport: row.transport,
				representation: row.representation,
				access: { network: row.access_network, credentialed: row.access_credentialed === 1, requestScopeKey: row.request_scope_key },
				httpStatus: row.http_status,
				artifactBytes: row.artifact_bytes,
				redirects: row.redirects,
				diagnostics: row.diagnostics_json ? JSON.parse(row.diagnostics_json) as RetrievalArtifact["diagnostics"] : null,
				completeness: row.completeness_json ? JSON.parse(row.completeness_json) as RetrievalArtifact["completeness"] : null,
				warnings: row.warnings_json ? JSON.parse(row.warnings_json) as RetrievalArtifact["warnings"] : [],
				snapshotId: row.snapshot_id,
				error: row.error,
				startedAt: row.started_at,
				finishedAt: row.finished_at,
				transferredBytes: row.transferred_bytes,
				cache: row.cache_state,
			})),
			nextCursor: rows.length > limit ? encodeCursor({ at: page.at(-1)!.finished_at, id: page.at(-1)!.id }) : null,
		};
	}

	private async deleteSourcePhysical(source: SourceRow, reason: SnapshotEvictionReason, options: RepositoryWorkOptions): Promise<DeleteReceipt> {
		const receipt = emptyDeleteReceipt();
		for (;;) {
			const ids = (this.db.prepare("SELECT id FROM forage_snapshots WHERE source_id = ? ORDER BY id LIMIT ?").all(source.id, this.deleteBatchSize) as Array<{ id: string }>).map((row) => row.id);
			if (ids.length === 0) break;
			const removed = this.evictSnapshotIds(ids, reason, false);
			receipt.snapshots += removed.snapshots;
			receipt.bytes += removed.bytes;
			await yieldToHost(options);
		}
		for (;;) {
			const ids = (this.db.prepare("SELECT id FROM forage_retrievals WHERE source_id = ? LIMIT ?").all(source.id, this.deleteBatchSize) as Array<{ id: string }>).map((row) => row.id);
			if (ids.length === 0) break;
			receipt.retrievals += this.db.prepare(`DELETE FROM forage_retrievals WHERE id IN (${placeholders(ids.length)})`).run(...ids).changes;
			await yieldToHost(options);
		}
		for (;;) {
			const ids = (this.db.prepare("SELECT id FROM forage_discovery_links WHERE from_source_id = ? LIMIT ?").all(source.id, this.deleteBatchSize) as Array<{ id: number }>).map((row) => row.id);
			if (ids.length === 0) break;
			receipt.discoveryLinks += this.db.prepare(`DELETE FROM forage_discovery_links WHERE id IN (${placeholders(ids.length)})`).run(...ids).changes;
			await yieldToHost(options);
		}
		receipt.sources += this.db.prepare("DELETE FROM forage_sources WHERE id = ?").run(source.id).changes;
		if (reason === "source-deleted") this.db.prepare("DELETE FROM forage_snapshot_tombstones WHERE source_id = ?").run(source.id);
		return receipt;
	}

	private makeCapacity(requiredBytes: number, cap: number): boolean {
		if (requiredBytes > cap) return false;
		let total = this.contentBytes();
		if (total + requiredBytes <= cap) return true;
		const protectedIds = this.maintenance.protectedSnapshotIds();
		const selected: string[] = [];
		let examined = 0;
		let afterAt = -1;
		let afterId = "";
		while (total + requiredBytes > cap) {
			if (examined >= MAX_CAPACITY_WORK) return false;
			const rows = this.db.prepare(`SELECT s.id, s.content_bytes, s.retained_at, src.deleting FROM forage_snapshots s INDEXED BY forage_snapshots_retained
				JOIN forage_sources src ON src.id = s.source_id WHERE (s.retained_at, s.id) > (?, ?)
				ORDER BY s.retained_at, s.id LIMIT ?`).all(afterAt, afterId, Math.min(CAPACITY_BATCH, MAX_CAPACITY_WORK - examined)) as Array<{ id: string; content_bytes: number; retained_at: number; deleting: number }>;
			if (rows.length === 0) return false;
			examined += rows.length;
			const last = rows.at(-1)!;
			afterAt = last.retained_at;
			afterId = last.id;
			for (const row of rows) {
				if (row.deleting === 1 || protectedIds.has(row.id)) continue;
				selected.push(row.id);
				total -= row.content_bytes;
				if (total + requiredBytes <= cap) break;
			}
		}
		this.evictSnapshotIds(selected, "storage-limit");
		return true;
	}

	private evictSnapshotIds(snapshotIds: readonly string[], reason: SnapshotEvictionReason, recomputeLatest = true): { snapshots: number; bytes: number } {
		if (snapshotIds.length === 0) return { snapshots: 0, bytes: 0 };
		this.maintenance.beforeSnapshotsDeleted(snapshotIds);
		return this.db.transaction(() => {
			let snapshots = 0;
			let bytes = 0;
			const latestSources = new Set<string>();
			for (const snapshotId of snapshotIds) {
				const row = this.db.prepare(`SELECT s.*, src.scope_key, src.latest_snapshot_id FROM forage_snapshots s
					JOIN forage_sources src ON src.id = s.source_id WHERE s.id = ?`).get(snapshotId) as (SnapshotRow & { scope_key: string; latest_snapshot_id: string | null }) | undefined;
				if (!row) continue;
				this.db.prepare(`INSERT INTO forage_snapshot_tombstones (id, scope_key, source_id, content_hash, reason, deleted_at, retained_at)
					VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET reason = excluded.reason, deleted_at = excluded.deleted_at,
					retained_at = excluded.retained_at`).run(row.id, row.scope_key, row.source_id, row.content_hash, reason, this.now(), row.retained_at);
				this.db.prepare("DELETE FROM forage_snapshots WHERE id = ?").run(row.id);
				if (recomputeLatest && row.latest_snapshot_id === row.id) latestSources.add(row.source_id);
				snapshots += 1;
				bytes += row.content_bytes;
			}
			for (const sourceId of latestSources) {
				const latest = this.db.prepare(`SELECT s.id FROM forage_snapshots s JOIN forage_retrievals r ON r.snapshot_id = s.id
					WHERE s.source_id = ? GROUP BY s.id ORDER BY MAX(r.finished_at) DESC, MAX(r.rowid) DESC LIMIT 1`).get(sourceId) as { id: string } | undefined;
				this.db.prepare("UPDATE forage_sources SET latest_snapshot_id = ?, updated_at = ? WHERE id = ?").run(latest?.id ?? null, this.now(), sourceId);
			}
			return { snapshots, bytes };
		})();
	}

	private checkpointWal(): void {
		this.db.pragma("wal_checkpoint(TRUNCATE)");
	}

	private contentBytes(): number {
		return (this.db.prepare("SELECT COALESCE(SUM(content_bytes), 0) AS bytes FROM forage_snapshots").get() as { bytes: number }).bytes;
	}
}
