import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, it } from "vitest";
import { SourceRepositoryError } from "../../src/sources/model.ts";
import { configureSourceDatabase, SOURCE_MIGRATIONS } from "../../src/sources/schema.ts";
import { SqliteSourceRepository } from "../../src/sources/repository.ts";
import { artifact, attempt, createRepository, MaintenanceStub, projectScope, structured, threadScope } from "./helpers.ts";

const cleanup: string[] = [];
afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("source migrations", () => {
	it("applies every append-only migration prefix", () => {
		for (let prefix = 1; prefix <= SOURCE_MIGRATIONS.length; prefix += 1) {
			const db = new Database(":memory:");
			configureSourceDatabase(db);
			for (const migration of SOURCE_MIGRATIONS.slice(0, prefix)) db.exec(migration);
			assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
			db.close();
		}
	});

	it("persists immutable snapshots across a real SQLite reopen", () => {
		const directory = mkdtempSync(join(tmpdir(), "forage-sources-"));
		cleanup.push(directory);
		const path = join(directory, "sources.db");
		let db = new Database(path);
		configureSourceDatabase(db);
		for (const migration of SOURCE_MIGRATIONS) db.exec(migration);
		let repository = new SqliteSourceRepository(db, { now: () => 300, maxContentBytes: 1024 * 1024 });
		const receipt = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("# First\n\nBody"), attempt: attempt() });
		assert.equal(receipt.persisted, true);
		db.close();

		db = new Database(path);
		configureSourceDatabase(db);
		repository = new SqliteSourceRepository(db, { now: () => 400, maxContentBytes: 1024 * 1024 });
		const read = repository.readSnapshot(threadScope(), receipt.snapshotId!, { offset: 0, maxChars: 100, contentHash: receipt.contentHash! });
		assert.equal(read.status, "ok");
		if (read.status === "ok") assert.equal(read.slice.text, "# First\n\nBody");
		db.close();
	});

	it("runs the same migrations and repository across an SDK fake-host reload", async () => {
		let repository: SqliteSourceRepository;
		const load = async (bb: BbPluginApi) => {
			const db = bb.storage.database();
			configureSourceDatabase(db);
			bb.storage.migrate(db, [...SOURCE_MIGRATIONS]);
			repository = new SqliteSourceRepository(db, { now: () => 500, maxContentBytes: 1024 * 1024 });
		};
		let host = createFakePluginHost({ pluginId: "forage-s2" });
		await load(host.bb);
		const receipt = repository!.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("host reload"), attempt: attempt() });
		host = await host.harness.lifecycle.reload(load);
		assert.equal(repository!.readSnapshot(threadScope(), receipt.snapshotId!, { offset: 0, maxChars: 100 }).status, "ok");
		await host.harness.lifecycle.dispose();
	});
});

describe("scoped immutable source repository", () => {
	it("isolates the same URL across thread scopes and hides wrong-scope IDs", () => {
		const { repository } = createRepository();
		const first = repository.recordRetrieval({ scope: threadScope("thr_a"), origin: "fetch", artifact: artifact("A"), attempt: attempt() });
		const second = repository.recordRetrieval({ scope: threadScope("thr_b"), origin: "fetch", artifact: artifact("B"), attempt: attempt() });
		assert.notEqual(first.sourceId, second.sourceId);
		assert.equal(repository.get(threadScope("thr_b"), first.sourceId!), null);
		assert.deepEqual(repository.readSnapshot(threadScope("thr_b"), first.snapshotId!, { offset: 0, maxChars: 10 }), { status: "not-visible" });
	});

	it("rejects ambiguous scope IDs at every repository boundary", async () => {
		const { repository } = createRepository();
		const receipt = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("valid"), attempt: attempt() });
		const ambiguous = { kind: "thread" as const, projectId: "proj:a", threadId: "thr" };
		const invalid = (error: unknown) => error instanceof SourceRepositoryError && error.code === "INVALID_INPUT";
		assert.throws(() => repository.recordRetrieval({ scope: ambiguous, origin: "fetch", artifact: artifact("invalid"), attempt: attempt() }), invalid);
		assert.throws(() => repository.recordDiscovery({ scope: ambiguous, fromSourceId: null, method: "sitemap", urls: [], observedAt: 1 }), invalid);
		assert.throws(() => repository.list({ scope: ambiguous, limit: 10 }), invalid);
		assert.throws(() => repository.get(ambiguous, receipt.sourceId!), invalid);
		assert.throws(() => repository.readSnapshot(ambiguous, receipt.snapshotId!, { offset: 0, maxChars: 10 }), invalid);
		assert.throws(() => repository.getSnapshot(ambiguous, receipt.snapshotId!), invalid);
		assert.throws(() => repository.snapshotPair(ambiguous, { sourceId: receipt.sourceId! }), invalid);
		assert.throws(() => repository.storageSummary(ambiguous), invalid);
		await assert.rejects(repository.deleteSource(ambiguous, receipt.sourceId!), invalid);
		await assert.rejects(repository.deleteScope(ambiguous), invalid);
		await assert.rejects(repository.export(ambiguous, {})[Symbol.asyncIterator]().next(), invalid);
	});

	it("pages by Unicode code point without stalling on a surrogate pair", () => {
		const { repository } = createRepository();
		const receipt = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("😀x"), attempt: attempt() });
		const first = repository.readSnapshot(threadScope(), receipt.snapshotId!, { offset: 0, maxChars: 1 });
		assert.equal(first.status, "ok");
		if (first.status !== "ok") return;
		assert.equal(first.slice.text, "😀");
		assert.match(first.slice.citation, /^https:\/\/example\.com\/docs source:src_.* snapshot:snap_.* lines:1-1$/u);
		assert.equal(first.slice.nextOffset, 2);
		const second = repository.readSnapshot(threadScope(), receipt.snapshotId!, { offset: first.slice.nextOffset!, maxChars: 1 });
		assert.equal(second.status, "ok");
		if (second.status === "ok") assert.equal(second.slice.text, "x");
	});

	it("records failed attempts without fabricating snapshots", () => {
		const { repository } = createRepository();
		const receipt = repository.recordRetrieval({
			scope: threadScope(),
			origin: "fetch",
			artifact: null,
			requestedUrl: "https://example.com/unavailable",
			access: { network: "public", credentialed: false, requestScopeKey: "thread:proj_a:thr_a" },
			attempt: { ...attempt({ httpStatus: 503 }), error: "upstream failed at https://example.com/unavailable" },
		});
		assert.equal(receipt.persisted, true);
		assert.equal(receipt.snapshotId, null);
		const detail = repository.get(threadScope(), receipt.sourceId!);
		assert.equal(detail?.retrievals.items[0]?.status, "failed");
		assert.equal(detail?.retrievals.items[0]?.error, "upstream failed at [url]");
	});

	it("preserves source metadata and the latest snapshot when a later check fails", () => {
		const { repository } = createRepository();
		const first = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("saved", { title: "Saved title" }), attempt: attempt() });
		repository.recordRetrieval({
			scope: threadScope(),
			origin: "fetch",
			artifact: null,
			requestedUrl: "https://example.com/docs",
			access: { network: "public", credentialed: false, requestScopeKey: "thread:proj_a:thr_a" },
			attempt: { ...attempt({ httpStatus: 503 }), error: "temporarily unavailable" },
		});
		const detail = repository.get(threadScope(), first.sourceId!);
		assert.equal(detail?.title, "Saved title");
		assert.equal(detail?.canonicalUrl, "https://example.com/docs");
		assert.equal(detail?.latestSnapshot?.id, first.snapshotId);
		assert.equal(detail?.retrievals.items.length, 2);
	});

	it("selects latest by successful retrieval time rather than latest attempt time", () => {
		const { repository } = createRepository();
		const first = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("first"), attempt: attempt({ startedAt: 10, finishedAt: 10 }) });
		repository.recordRetrieval({
			scope: threadScope(),
			origin: "fetch",
			artifact: null,
			requestedUrl: "https://example.com/docs",
			access: { network: "public", credentialed: false, requestScopeKey: "thread:proj_a:thr_a" },
			attempt: { ...attempt({ startedAt: 20, finishedAt: 20, httpStatus: 503 }), error: "temporarily unavailable" },
		});
		const second = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("second"), attempt: attempt({ startedAt: 15, finishedAt: 15 }) });
		const detail = repository.get(threadScope(), first.sourceId!);
		assert.equal(detail?.latestSnapshot?.id, second.snapshotId);
		assert.equal(detail?.lastRetrievedAt, 20);
	});

	it("records unchanged checks without duplicating snapshots and separates extractor changes", () => {
		let now = 1_000;
		const { repository, db } = createRepository({ now: () => now });
		const first = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("same"), attempt: attempt() });
		now += 100;
		const unchanged = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("same"), attempt: attempt({ cache: "revalidated" }) });
		const changedExtractor = repository.recordRetrieval({
			scope: threadScope(),
			origin: "fetch",
			artifact: artifact("same", { extraction: { id: "forage-v2" }, structured: structured({ title: "Changed extraction" }) }),
			attempt: attempt(),
		});
		assert.equal(unchanged.snapshotId, first.snapshotId);
		assert.equal(unchanged.changed, false);
		assert.notEqual(changedExtractor.snapshotId, first.snapshotId);
		assert.equal(changedExtractor.contentHash, first.contentHash);
		assert.notEqual(changedExtractor.snapshotHash, first.snapshotHash);
		assert.equal((db.prepare("SELECT COUNT(*) AS count FROM forage_retrievals").get() as { count: number }).count, 3);
		assert.equal((db.prepare("SELECT COUNT(*) AS count FROM forage_snapshots").get() as { count: number }).count, 2);
		const provenance = repository.get(threadScope(), first.sourceId!)!.retrievals.items.at(-1)!;
		assert.equal(provenance.requestedUrl, "https://example.com/docs");
		assert.equal(provenance.resolvedUrl, "https://example.com/docs");
		assert.equal(provenance.finalUrl, "https://example.com/docs");
		assert.equal(provenance.transport, "direct");
		assert.equal(provenance.representation, "readable");
		assert.equal(provenance.completeness?.state, "complete");
		assert.equal(provenance.diagnostics?.redirects, 0);
	});

	it("deduplicates root discovery links while retaining the latest observation", () => {
		const { repository, db } = createRepository();
		const discovered = { url: "https://example.com/guide", method: "sitemap" as const, parentUrl: "https://example.com/sitemap.xml", title: "Guide", lastModified: null };
		repository.recordDiscovery({ scope: threadScope(), fromSourceId: null, method: "sitemap", urls: [discovered], observedAt: 10 });
		repository.recordDiscovery({ scope: threadScope(), fromSourceId: null, method: "sitemap", urls: [{ ...discovered, title: "Updated" }], observedAt: 20 });
		const row = db.prepare("SELECT COUNT(*) AS count, MAX(title) AS title, MAX(observed_at) AS observed_at FROM forage_discovery_links").get() as { count: number; title: string; observed_at: number };
		assert.deepEqual(row, { count: 1, title: "Updated", observed_at: 20 });
	});

	it("copies public snapshots to project scope and preserves them after thread deletion", async () => {
		const { repository } = createRepository();
		const threadReceipt = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("project copy"), attempt: attempt() });
		const copied = repository.copyToProject({ from: threadScope(), sourceId: threadReceipt.sourceId! });
		assert.equal(copied.copied, true);
		assert.notEqual(copied.sourceId, threadReceipt.sourceId);
		await repository.deleteScope(threadScope());
		assert.equal(repository.get(threadScope(), threadReceipt.sourceId!), null);
		assert.deepEqual(repository.readSnapshot(threadScope(), threadReceipt.snapshotId!, { offset: 0, maxChars: 100 }), { status: "not-visible" });
		assert.ok(repository.get(projectScope(), copied.sourceId));
		const projectRead = repository.readSnapshot(projectScope(), copied.snapshotId, { offset: 0, maxChars: 100 });
		assert.equal(projectRead.status, "ok");
	});

	it("preserves partial completeness when importing a project copy", () => {
		const { repository } = createRepository();
		const receipt = repository.recordRetrieval({
			scope: threadScope(),
			origin: "fetch",
			artifact: artifact("partial", { completeness: { state: "partial", parts: [{ name: "body", state: "partial", fetched: 7, reason: "limit" }] } }),
			attempt: attempt(),
		});
		const copied = repository.copyToProject({ from: threadScope(), sourceId: receipt.sourceId! });
		assert.equal(repository.get(projectScope(), copied.sourceId)?.retrievals.items[0]?.status, "partial");
	});

	it("can promote under a tight cap by evicting the inactive thread copy after buffering it", () => {
		const { repository } = createRepository({ maxContentBytes: 4 });
		const receipt = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("copy"), attempt: attempt() });
		const copied = repository.copyToProject({ from: threadScope(), sourceId: receipt.sourceId! });
		assert.equal(repository.readSnapshot(threadScope(), receipt.snapshotId!, { offset: 0, maxChars: 20 }).status, "evicted");
		assert.equal(repository.readSnapshot(projectScope(), copied.snapshotId, { offset: 0, maxChars: 20 }).status, "ok");
	});

	it("returns stale, evicted, and invisible snapshot outcomes without cross-scope disclosure", async () => {
		let now = Date.parse("2026-01-01T00:00:00.000Z");
		const { repository } = createRepository({ now: () => now });
		const receipt = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("version one"), attempt: attempt() });
		assert.equal(repository.readSnapshot(threadScope(), receipt.snapshotId!, { offset: 0, maxChars: 20, contentHash: "f".repeat(64) }).status, "stale");
		assert.equal(repository.readSnapshot(threadScope("thr_b"), receipt.snapshotId!, { offset: 0, maxChars: 20 }).status, "not-visible");
		now += 40 * 86_400_000;
		await repository.prune({ threadDays: 30, projectDays: 180, completedJobDays: 30, failedJobDays: 7, maxContentBytes: 1024 * 1024, now });
		assert.equal(repository.readSnapshot(threadScope(), receipt.snapshotId!, { offset: 0, maxChars: 20 }).status, "evicted");
	});

	it("uses retrieval recency for the default snapshot pair after an A-B-A revert", () => {
		const { repository } = createRepository();
		const first = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("A"), attempt: attempt({ startedAt: 100, finishedAt: 100 }) });
		const second = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("B"), attempt: attempt({ startedAt: 200, finishedAt: 200 }) });
		const reverted = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("A"), attempt: attempt({ startedAt: 300, finishedAt: 300 }) });
		assert.equal(reverted.snapshotId, first.snapshotId);
		assert.equal(repository.get(threadScope(), first.sourceId!)?.latestSnapshot?.id, first.snapshotId);
		const pair = repository.snapshotPair(threadScope(), { sourceId: first.sourceId! });
		assert.equal(pair?.before.id, second.snapshotId);
		assert.equal(pair?.after.id, first.snapshotId);
	});

	it("keeps a failed scope deletion fenced and resumes its physical cleanup", async () => {
		let fail = true;
		class InterruptingMaintenance extends MaintenanceStub {
			override async deleteScope(scope: Parameters<MaintenanceStub["deleteScope"]>[0]): Promise<number> {
				if (fail) {
					fail = false;
					throw new Error("interrupted delete");
				}
				return super.deleteScope(scope);
			}
		}
		const maintenance = new InterruptingMaintenance();
		const { repository } = createRepository({ maintenance });
		const receipt = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("resume me"), attempt: attempt() });
		await assert.rejects(repository.deleteScope(threadScope()), /interrupted delete/);
		assert.equal(repository.storageSummary(threadScope()).deleting, true);
		assert.equal(repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("blocked"), attempt: attempt() }).persisted, false);
		assert.throws(() => repository.copyToProject({ from: threadScope(), sourceId: receipt.sourceId! }), /not visible/i);
		assert.throws(() => repository.recordDiscovery({ scope: threadScope(), fromSourceId: null, method: "sitemap", urls: [], observedAt: 1 }), /being deleted/i);
		const resumed = await repository.resumePendingDeletes();
		assert.equal(resumed.sources, 1);
		assert.equal(repository.storageSummary(threadScope()).deleting, false);
	});

	it("resumes after cancellation interrupts physical deletion between batches", async () => {
		const { repository } = createRepository({ deleteBatchSize: 2 });
		for (let index = 0; index < 20; index += 1) {
			const url = `https://example.com/resume-${index}`;
			repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact(`body ${index}`, { requestedUrl: url, resolvedUrl: url, finalUrl: url }), attempt: attempt() });
		}
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 0);
		await assert.rejects(repository.deleteScope(threadScope(), { signal: controller.signal }), /cancelled/i);
		assert.equal(repository.storageSummary(threadScope()).deleting, true);
		const resumed = await repository.resumePendingDeletes();
		assert.ok(resumed.sources > 0);
		assert.equal(repository.storageSummary(threadScope()).deleting, false);
	});

	it("supports cancellation and deadlines before destructive or export work starts", async () => {
		const { repository } = createRepository();
		repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("bounded"), attempt: attempt() });
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(repository.deleteScope(threadScope(), { signal: controller.signal }), /cancelled/i);
		assert.equal(repository.storageSummary(threadScope()).deleting, false);
		await assert.rejects(repository.prune({ threadDays: 30, projectDays: 180, completedJobDays: 30, failedJobDays: 7, maxContentBytes: 1000, now: 1000, signal: controller.signal }), /cancelled/i);
		const iterator = repository.export(threadScope(), { deadlineAt: 0 })[Symbol.asyncIterator]();
		await assert.rejects(iterator.next(), /timed out/i);
	});

	it("yields to timers while deleting a large scope", async () => {
		const { repository } = createRepository({ deleteBatchSize: 2 });
		for (let index = 0; index < 200; index += 1) {
			const url = `https://example.com/${index}`;
			repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact(`body ${index}`, { requestedUrl: url, resolvedUrl: url, finalUrl: url }), attempt: attempt() });
		}
		let timerFired = false;
		setTimeout(() => { timerFired = true; }, 0);
		await repository.deleteScope(threadScope());
		assert.equal(timerFired, true);
	});

	it("truncates the WAL after explicit deletion", async () => {
		const directory = mkdtempSync(join(tmpdir(), "forage-delete-wal-"));
		cleanup.push(directory);
		const path = join(directory, "sources.db");
		const walPath = `${path}-wal`;
		const db = new Database(path);
		configureSourceDatabase(db);
		db.pragma("wal_autocheckpoint = 0");
		for (const migration of SOURCE_MIGRATIONS) db.exec(migration);
		const repository = new SqliteSourceRepository(db, { now: () => 500, maxContentBytes: 1024 * 1024, deleteBatchSize: 2 });
		const receipt = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("delete securely"), attempt: attempt() });
		assert.equal(existsSync(walPath), true);
		assert.ok(statSync(walPath).size > 0);
		await repository.deleteSource(threadScope(), receipt.sourceId!);
		assert.equal(statSync(walPath).size, 0);
		db.close();
	});

	it("blocks deletion of active snapshots until the job port releases them", async () => {
		const maintenance = new MaintenanceStub();
		const { repository } = createRepository({ maintenance });
		const receipt = repository.recordRetrieval({ scope: threadScope(), origin: "crawl", artifact: artifact("active"), attempt: attempt() });
		maintenance.protected.add(receipt.snapshotId!);
		await assert.rejects(repository.deleteSource(threadScope(), receipt.sourceId!), (error: unknown) => error instanceof SourceRepositoryError && error.code === "ACTIVE_JOB");
		maintenance.protected.clear();
		const deleted = await repository.deleteSource(threadScope(), receipt.sourceId!);
		assert.equal(deleted.sources, 1);
		assert.deepEqual(repository.readSnapshot(threadScope(), receipt.snapshotId!, { offset: 0, maxChars: 20 }), { status: "not-visible" });
		assert.deepEqual(maintenance.beforeDeleted, [[receipt.snapshotId!]]);
	});
});
