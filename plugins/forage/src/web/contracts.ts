export type SourceScope =
	| { kind: "thread"; projectId: string; threadId: string }
	| { kind: "project"; projectId: string };

export type SnapshotKind = "html" | "markdown" | "text" | "json" | "pdf" | "github-api";

export interface Deadline {
	readonly expiresAt: number;
	readonly signal: AbortSignal;
	remainingMs(): number;
	throwIfExpired(stage: string): void;
	dispose(): void;
}

export interface ByteBudget {
	remaining(): number;
	consume(bytes: number): void;
}

export interface OperationContext {
	scope?: SourceScope;
	deadline: Deadline;
	byteBudget?: ByteBudget;
}

export interface RetrievalWarning {
	code: string;
	stage: string;
	message: string;
}

export interface AccessDescriptor {
	network: "public" | "private";
	credentialed: boolean;
	requestScopeKey: string | null;
}

export interface StructuredDocument {
	schemaVersion: 1;
	title: string;
	description: string;
	canonicalUrl: string | null;
	language: string | null;
	headings: Array<{ level: 1 | 2 | 3 | 4 | 5 | 6; text: string; line: number }>;
	links: Array<{ url: string; text: string; relation: "content" | "canonical" | "alternate" }>;
	tables: Array<{ caption: string | null; headers: string[]; rows: string[][]; line: number }>;
	jsonLd: unknown[];
}

export interface ExtractionOutput {
	kind: SnapshotKind;
	contentType: string;
	content: string;
	structured: StructuredDocument;
	extractorVersion: string;
	truncated: boolean;
	warnings: RetrievalWarning[];
}

export interface DiscoveredUrl {
	url: string;
	method: "robots" | "sitemap" | "sitemap-index" | "llms" | "html-link" | "provider";
	parentUrl: string;
	title: string | null;
	lastModified: string | null;
}

export interface RetrievalArtifact {
	schemaVersion: 1;
	requestedUrl: string;
	resolvedUrl: string;
	finalUrl: string;
	transport: "direct" | "github-smart" | "provider";
	representation: "readable" | "raw";
	kind: SnapshotKind;
	status: number;
	contentType: string;
	bytes: number;
	fetchedAt: string;
	title: string;
	content: string;
	contentHash: string;
	structured?: StructuredDocument;
	extraction: { id: string; contentRoot?: string };
	access: AccessDescriptor;
	completeness: {
		state: "complete" | "partial" | "unknown";
		parts: Array<{ name: string; state: "complete" | "partial" | "unknown"; fetched: number; expected?: number; reason?: string }>;
	};
	warnings: RetrievalWarning[];
	diagnostics: { durationMs: number; redirects: number; stageMs: Record<string, number> };
}

export interface RetrievalAttempt {
	startedAt: number;
	finishedAt: number;
	httpStatus: number;
	transferredBytes: number;
	cache: "miss" | "hit" | "revalidated";
	error?: string;
}

export interface StoredSourceRef {
	sourceId: string;
	snapshotId: string;
	contentHash: string;
}

export interface PageCursor {
	nextOffset: number;
	total: number;
	contentHash: string;
	source?: StoredSourceRef;
}

export interface RenderedPage {
	text: string;
	usedChars: number;
	complete: boolean;
	cursor?: PageCursor;
	omitted: number;
}

export function sourceScopeKey(scope: SourceScope): string {
	return scope.kind === "thread"
		? `thread:${scope.projectId}:${scope.threadId}`
		: `project:${scope.projectId}`;
}
