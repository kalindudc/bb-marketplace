import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { AccessDescriptor, RetrievalArtifact, RetrievalAttempt, StructuredDocument } from "../../src/web/contracts.ts";
import type { JobMaintenancePort } from "../../src/jobs/model.ts";
import { configureSourceDatabase, SOURCE_MIGRATIONS } from "../../src/sources/schema.ts";
import { SqliteSourceRepository } from "../../src/sources/repository.ts";
import type { SourceRepositoryOptions, SourceScope } from "../../src/sources/model.ts";

export const threadScope = (threadId = "thr_a"): Extract<SourceScope, { kind: "thread" }> => ({ kind: "thread", projectId: "proj_a", threadId });
export const projectScope = (): Extract<SourceScope, { kind: "project" }> => ({ kind: "project", projectId: "proj_a" });

export function structured(overrides: Partial<StructuredDocument> = {}): StructuredDocument {
	return {
		schemaVersion: 1,
		title: "Example",
		description: "",
		canonicalUrl: "https://example.com/docs",
		language: "en",
		headings: [],
		links: [],
		tables: [],
		jsonLd: [],
		...overrides,
	};
}

export function artifact(content: string, overrides: Partial<RetrievalArtifact> = {}): RetrievalArtifact {
	const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
	const access: AccessDescriptor = { network: "public", credentialed: false, requestScopeKey: "thread:proj_a:thr_a" };
	return {
		schemaVersion: 1,
		requestedUrl: "https://example.com/docs",
		resolvedUrl: "https://example.com/docs",
		finalUrl: "https://example.com/docs",
		transport: "direct",
		representation: "readable",
		kind: "markdown",
		status: 200,
		contentType: "text/markdown; charset=utf-8",
		bytes: Buffer.byteLength(content),
		fetchedAt: "2026-01-01T00:00:00.000Z",
		title: "Example",
		content,
		contentHash,
		structured: structured(),
		extraction: { id: "forage", contentRoot: "article" },
		access,
		completeness: { state: "complete", parts: [{ name: "body", state: "complete", fetched: Buffer.byteLength(content) }] },
		warnings: [],
		diagnostics: { durationMs: 10, redirects: 0, stageMs: { body: 5 } },
		...overrides,
	};
}

export function attempt(overrides: Partial<RetrievalAttempt> = {}): RetrievalAttempt {
	return { startedAt: 100, finishedAt: 200, httpStatus: 200, transferredBytes: 100, cache: "miss", ...overrides };
}

export class MaintenanceStub implements JobMaintenancePort {
	protected = new Set<string>();
	invalidated: SourceScope[] = [];
	deletedScopes: SourceScope[] = [];
	beforeDeleted: string[][] = [];
	pruneCalls = 0;
	protectedSnapshotIds(): ReadonlySet<string> {
		return this.protected;
	}
	invalidateScope(scope: SourceScope): number {
		this.invalidated.push(scope);
		return this.invalidated.length;
	}
	async beforeSnapshotsDeleted(snapshotIds: readonly string[]): Promise<void> {
		this.beforeDeleted.push([...snapshotIds]);
	}
	async deleteScope(scope: SourceScope): Promise<number> {
		this.deletedScopes.push(scope);
		return 0;
	}
	async pruneJobs(): Promise<number> {
		this.pruneCalls += 1;
		return 0;
	}
}

export function createRepository(options: Partial<SourceRepositoryOptions> = {}) {
	const db = new Database(":memory:");
	configureSourceDatabase(db);
	for (const migration of SOURCE_MIGRATIONS) db.exec(migration);
	const maintenance = options.maintenance ?? new MaintenanceStub();
	const repository = new SqliteSourceRepository(db, {
		now: options.now ?? (() => 1_000_000),
		maxContentBytes: options.maxContentBytes ?? 128 * 1024 * 1024,
		maintenance,
		deleteBatchSize: options.deleteBatchSize ?? 2,
	});
	return { db, repository, maintenance };
}
