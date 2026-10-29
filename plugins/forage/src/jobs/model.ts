import type { SourceScope } from "../web/contracts.ts";

export type CrawlJobState = "queued" | "running" | "cancelling" | "cancelled" | "paused" | "partial" | "completed" | "failed";
export type CrawlBackend = "local" | "firecrawl";
export type CrawlStopReason = "cancelled" | "page-limit" | "byte-limit" | "time-limit" | "frontier-empty" | "storage-limit" | "error" | null;

export interface CrawlLimits {
	maxPages: number;
	maxDepth: number;
	maxBytes: number;
	maxDurationMs: number;
	concurrency: number;
}

export interface CrawlRequest {
	scope: SourceScope;
	rootUrl: string;
	includePaths: string[];
	excludePaths: string[];
	includeSubdomains: boolean;
	limits: CrawlLimits;
	backend: CrawlBackend;
}

export interface CrawlJobCounts {
	queued: number;
	fetching: number;
	saved: number;
	failed: number;
	skipped: number;
}

export interface CrawlJobView {
	id: string;
	scope: SourceScope;
	state: CrawlJobState;
	rootUrl: string;
	includePaths: string[];
	excludePaths: string[];
	includeSubdomains: boolean;
	limits: CrawlLimits;
	backend: CrawlBackend;
	counts: CrawlJobCounts;
	pagesUsed: number;
	bytesUsed: number;
	activeDurationMs: number;
	generation: number;
	createdAt: number;
	startedAt: number | null;
	updatedAt: number;
	finishedAt: number | null;
	stopReason: CrawlStopReason;
	error: string | null;
}

export interface CrawlJobPage {
	jobs: CrawlJobView[];
	nextCursor: string | null;
}

export interface CrawlJobService {
	create(request: CrawlRequest): CrawlJobView;
	status(scope: SourceScope, jobId: string): CrawlJobView | null;
	list(input: { scope: SourceScope; cursor?: string; limit: number }): CrawlJobPage;
	cancel(scope: SourceScope, jobId: string): CrawlJobView;
	resume(scope: SourceScope, jobId: string, limits?: Partial<CrawlLimits>): CrawlJobView;
	cancelScope(scope: SourceScope): Promise<number>;
	run(signal: AbortSignal): Promise<void>;
	wake(): void;
}

export interface JobMaintenancePort {
	protectedSnapshotIds(): ReadonlySet<string>;
	invalidateScope(scope: SourceScope): number;
	beforeSnapshotsDeleted(snapshotIds: readonly string[]): void;
	deleteScope(scope: SourceScope): Promise<number>;
	pruneJobs(input?: { completedBefore?: number; failedBefore?: number }): Promise<number>;
}

export interface CrawlJobMaintenancePort extends CrawlJobService, JobMaintenancePort {}
