import type { JobMaintenancePort } from "../jobs/model.ts";
import type {
	AccessDescriptor,
	DiscoveredUrl,
	RetrievalArtifact,
	RetrievalAttempt,
	RetrievalWarning,
	SnapshotKind,
	SourceScope,
	StructuredDocument,
} from "../web/contracts.ts";

export type {
	AccessDescriptor,
	DiscoveredUrl,
	RetrievalArtifact,
	RetrievalAttempt,
	RetrievalWarning,
	SnapshotKind,
	SourceScope,
	StructuredDocument,
} from "../web/contracts.ts";

export type RetrievalOrigin = "fetch" | "search-content" | "map" | "crawl" | "extract" | "diff" | "import";
export type SourceRepositoryErrorCode = "ACTIVE_JOB" | "INVALID_INPUT" | "POLICY_BLOCKED" | "SOURCE_NOT_VISIBLE" | "SNAPSHOT_EVICTED" | "STALE_CONTENT" | "STORAGE_LIMIT";
export type SnapshotEvictionReason = "expired" | "storage-limit" | "source-deleted" | "scope-deleted";

export class SourceRepositoryError extends Error {
	constructor(readonly code: SourceRepositoryErrorCode, message: string) {
		super(message);
		this.name = "SourceRepositoryError";
	}
}

export interface RepositoryWarning {
	code: "POLICY_BLOCKED" | "STORAGE_LIMIT";
	message: string;
}

export interface RecordSuccessfulRetrievalInput {
	scope: SourceScope;
	origin: RetrievalOrigin;
	artifact: RetrievalArtifact;
	attempt: RetrievalAttempt;
	allowRestrictedThreadCapture?: boolean;
	save?: boolean;
}

export interface RecordFailedRetrievalInput {
	scope: SourceScope;
	origin: RetrievalOrigin;
	artifact: null;
	requestedUrl: string;
	access: AccessDescriptor;
	attempt: RetrievalAttempt & { error: string };
	allowRestrictedThreadCapture?: boolean;
	save?: boolean;
}

export type RecordRetrievalInput = RecordSuccessfulRetrievalInput | RecordFailedRetrievalInput;

export interface RetrievalReceipt {
	sourceId: string | null;
	retrievalId: string | null;
	snapshotId: string | null;
	contentHash: string | null;
	snapshotHash: string | null;
	changed: boolean;
	persisted: boolean;
	warning: RepositoryWarning | null;
}

export interface SnapshotMeta {
	id: string;
	sourceId: string;
	kind: SnapshotKind;
	contentHash: string;
	snapshotHash: string;
	extractorId: string;
	extractorVersion: string;
	chars: number;
	bytes: number;
	truncated: boolean;
	fetchedAt: number;
	checkedAt: number;
}

export interface SourceSummary {
	id: string;
	scope: SourceScope;
	access: AccessDescriptor;
	url: string;
	canonicalUrl: string | null;
	title: string;
	latestSnapshot: SnapshotMeta | null;
	lastRetrievedAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface RetrievalSummary {
	id: string;
	origin: RetrievalOrigin;
	status: "complete" | "partial" | "unknown" | "failed";
	requestedUrl: string;
	resolvedUrl: string | null;
	finalUrl: string | null;
	transport: RetrievalArtifact["transport"] | null;
	representation: RetrievalArtifact["representation"] | null;
	access: AccessDescriptor;
	httpStatus: number;
	artifactBytes: number | null;
	redirects: number | null;
	diagnostics: RetrievalArtifact["diagnostics"] | null;
	completeness: RetrievalArtifact["completeness"] | null;
	warnings: RetrievalWarning[];
	snapshotId: string | null;
	error: string | null;
	startedAt: number;
	finishedAt: number;
	transferredBytes: number;
	cache: RetrievalAttempt["cache"];
}

export interface CursorPage<T> {
	items: T[];
	nextCursor: string | null;
}

export interface SourceDetail extends SourceSummary {
	snapshots: CursorPage<SnapshotMeta>;
	retrievals: CursorPage<RetrievalSummary>;
}

export interface SourceListQuery {
	scope: SourceScope;
	query?: string;
	cursor?: string;
	limit: number;
}

export interface SourceDetailQuery {
	snapshotCursor?: string;
	retrievalCursor?: string;
	limit?: number;
}

export interface SourcePage {
	sources: SourceSummary[];
	nextCursor: string | null;
}

export interface SnapshotDocument extends SnapshotMeta {
	scope: SourceScope;
	contentType: string;
	content: string;
	structured: StructuredDocument;
	completeness: RetrievalArtifact["completeness"];
	warnings: RetrievalWarning[];
}

export interface SnapshotSlice {
	snapshot: SnapshotMeta;
	offset: number;
	end: number;
	total: number;
	text: string;
	citation: string;
	nextOffset: number | null;
}

export type SnapshotReadResult =
	| { status: "ok"; slice: SnapshotSlice }
	| { status: "not-visible" }
	| { status: "evicted" }
	| { status: "stale"; contentHash: string };

export interface CopyReceipt {
	sourceId: string;
	snapshotId: string;
	copied: boolean;
}

export interface DeleteReceipt {
	sources: number;
	snapshots: number;
	retrievals: number;
	discoveryLinks: number;
	jobs: number;
	bytes: number;
}

export interface RetentionPolicy {
	threadDays: number;
	projectDays: number;
	completedJobDays: number;
	failedJobDays: number;
	maxContentBytes: number;
}

export interface PruneReceipt extends DeleteReceipt {
	expiredSnapshots: number;
	budgetSnapshots: number;
}

export interface SourceStorageSummary {
	scope: SourceScope;
	sources: number;
	snapshots: number;
	retrievals: number;
	contentBytes: number;
	deleting: boolean;
}

export interface DiffHunk {
	kind: "added" | "removed" | "changed";
	headingPath: string[];
	before: { startLine: number; endLine: number; text: string } | null;
	after: { startLine: number; endLine: number; text: string } | null;
}

export interface SnapshotDiff {
	beforeSnapshotId: string;
	afterSnapshotId: string;
	unchanged: boolean;
	extractorChanged: boolean;
	hunks: DiffHunk[];
	addedLines: number;
	removedLines: number;
	truncated: boolean;
	warnings: string[];
	blockSummary?: {
		before: { blocks: number; prefixHash: string; suffixHash: string };
		after: { blocks: number; prefixHash: string; suffixHash: string };
	};
}

export interface DiffOptions {
	maxBlocks?: number;
	maxHunks?: number;
	maxChars?: number;
	signal?: AbortSignal;
	deadlineAt?: number;
	now?: () => number;
}

export interface RepositoryWorkOptions {
	signal?: AbortSignal;
	deadlineAt?: number;
}

export interface SourceExportOptions extends RepositoryWorkOptions {
	sourceIds?: readonly string[];
	includeRestricted?: boolean;
}

export interface SourceExportRecord {
	source: SourceSummary;
	snapshot: SnapshotDocument;
}

export interface SourceRepositoryOptions {
	now?: () => number;
	maxContentBytes?: number;
	maintenance?: JobMaintenancePort;
	deleteBatchSize?: number;
}

export interface ScopeAuthorityResult {
	status: "present" | "missing";
	archived?: boolean;
}

export interface SourceRepository {
	recordRetrieval(input: RecordRetrievalInput): RetrievalReceipt;
	recordDiscovery(input: {
		scope: SourceScope;
		fromSourceId: string | null;
		method: DiscoveredUrl["method"];
		urls: readonly DiscoveredUrl[];
		observedAt: number;
	}): void;
	list(query: SourceListQuery): SourcePage;
	get(scope: SourceScope, sourceId: string, query?: SourceDetailQuery): SourceDetail | null;
	readSnapshot(scope: SourceScope, snapshotId: string, range: { offset: number; maxChars: number; contentHash?: string }): SnapshotReadResult;
	getSnapshot(scope: SourceScope, snapshotId: string): SnapshotDocument | null;
	snapshotPair(scope: SourceScope, input: { sourceId: string; beforeId?: string; afterId?: string }): { before: SnapshotDocument; after: SnapshotDocument } | null;
	copyToProject(input: { from: Extract<SourceScope, { kind: "thread" }>; sourceId: string }): CopyReceipt;
	deleteSource(scope: SourceScope, sourceId: string, options?: RepositoryWorkOptions): Promise<DeleteReceipt>;
	deleteScope(scope: SourceScope, options?: RepositoryWorkOptions): Promise<DeleteReceipt>;
	resumePendingDeletes(options?: RepositoryWorkOptions): Promise<DeleteReceipt>;
	prune(input: RetentionPolicy & RepositoryWorkOptions & { now: number }): Promise<PruneReceipt>;
	export(scope: SourceScope, options: SourceExportOptions): AsyncIterable<SourceExportRecord>;
	storageSummary(scope: SourceScope): SourceStorageSummary;
	scopes(): AsyncIterable<SourceScope>;
}
