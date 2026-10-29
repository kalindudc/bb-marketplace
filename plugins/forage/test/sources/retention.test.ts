import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { artifact, attempt, createRepository, MaintenanceStub, threadScope } from "./helpers.ts";

describe("retention and storage bounds", () => {
	it("refuses an oversized source and a capture that cannot fit after inactive eviction", () => {
		const { repository } = createRepository({ maxContentBytes: 12 });
		const first = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("12345678"), attempt: attempt() });
		assert.equal(first.persisted, true);
		const second = repository.recordRetrieval({
			scope: threadScope(),
			origin: "fetch",
			artifact: artifact("abcdefghijkl", { finalUrl: "https://example.com/second", requestedUrl: "https://example.com/second", resolvedUrl: "https://example.com/second" }),
			attempt: attempt(),
		});
		assert.equal(second.persisted, true);
		assert.equal(repository.readSnapshot(threadScope(), first.snapshotId!, { offset: 0, maxChars: 20 }).status, "evicted");

		const oversized = repository.recordRetrieval({
			scope: threadScope(),
			origin: "fetch",
			artifact: artifact("x".repeat(8 * 1024 * 1024 + 1), { finalUrl: "https://example.com/huge", requestedUrl: "https://example.com/huge", resolvedUrl: "https://example.com/huge" }),
			attempt: attempt(),
		});
		assert.equal(oversized.persisted, false);
		assert.equal(oversized.warning?.code, "STORAGE_LIMIT");
	});

	it("protects active snapshots and refuses a capture when only protected content could be evicted", () => {
		const maintenance = new MaintenanceStub();
		const { repository } = createRepository({ maxContentBytes: 8, maintenance });
		const first = repository.recordRetrieval({ scope: threadScope(), origin: "crawl", artifact: artifact("12345678"), attempt: attempt() });
		maintenance.protected.add(first.snapshotId!);
		const refused = repository.recordRetrieval({
			scope: threadScope(),
			origin: "fetch",
			artifact: artifact("ABCDEFGH", { finalUrl: "https://example.com/new", requestedUrl: "https://example.com/new", resolvedUrl: "https://example.com/new" }),
			attempt: attempt(),
		});
		assert.equal(refused.persisted, false);
		assert.equal(refused.warning?.code, "STORAGE_LIMIT");
		assert.equal(repository.readSnapshot(threadScope(), first.snapshotId!, { offset: 0, maxChars: 20 }).status, "ok");
	});

	it("walks past a protected oldest window when making capacity", () => {
		const maintenance = new MaintenanceStub();
		const { repository, db } = createRepository({ maxContentBytes: 600_000, maintenance });
		for (let index = 0; index < 200; index += 1) {
			const url = `https://example.com/protected-window-${index}`;
			repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("x".repeat(3000), { requestedUrl: url, resolvedUrl: url, finalUrl: url }), attempt: attempt() });
		}
		const oldest = db.prepare("SELECT id FROM forage_snapshots ORDER BY retained_at, id LIMIT 100").all() as Array<{ id: string }>;
		for (const row of oldest) maintenance.protected.add(row.id);
		const url = "https://example.com/after-protected-window";
		const receipt = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("y".repeat(3000), { requestedUrl: url, resolvedUrl: url, finalUrl: url }), attempt: attempt() });
		assert.equal(receipt.persisted, true);
		assert.equal((db.prepare("SELECT COUNT(*) AS count FROM forage_snapshots").get() as { count: number }).count, 200);
	});

	it("evicts enough small snapshots for a large capture", () => {
		const { repository, db } = createRepository({ maxContentBytes: 1024 * 1024 });
		for (let index = 0; index < 300; index += 1) {
			const url = `https://example.com/small-${index}`;
			repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("x".repeat(3000), { requestedUrl: url, resolvedUrl: url, finalUrl: url }), attempt: attempt() });
		}
		const url = "https://example.com/large";
		const receipt = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("y".repeat(500_000), { requestedUrl: url, resolvedUrl: url, finalUrl: url }), attempt: attempt() });
		assert.equal(receipt.persisted, true);
		assert.ok((db.prepare("SELECT COUNT(*) AS count FROM forage_snapshots").get() as { count: number }).count < 201);
	});

	it("prunes expired then oldest inactive snapshots and reports byte accounting", async () => {
		let now = Date.parse("2026-01-01T00:00:00.000Z");
		const { repository, maintenance } = createRepository({ now: () => now, maxContentBytes: 1_000 });
		const old = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("old"), attempt: attempt() });
		now += 10;
		const newest = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("newest", { finalUrl: "https://example.com/newest", requestedUrl: "https://example.com/newest", resolvedUrl: "https://example.com/newest" }), attempt: attempt() });
		now += 40 * 86_400_000;
		const result = await repository.prune({ threadDays: 30, projectDays: 180, completedJobDays: 30, failedJobDays: 7, maxContentBytes: 6, now });
		assert.ok(result.expiredSnapshots >= 2);
		assert.ok(result.retrievals >= 2);
		assert.ok(result.bytes >= Buffer.byteLength("old") + Buffer.byteLength("newest"));
		assert.equal(repository.readSnapshot(threadScope(), old.snapshotId!, { offset: 0, maxChars: 20 }).status, "evicted");
		assert.equal(repository.readSnapshot(threadScope(), newest.snapshotId!, { offset: 0, maxChars: 20 }).status, "evicted");
		assert.equal((maintenance as MaintenanceStub).pruneCalls, 1);
	});

	it("retains an old immutable snapshot that was checked recently", async () => {
		const capturedAt = Date.parse("2026-01-01T00:00:00.000Z");
		const now = capturedAt + 40 * 86_400_000;
		const { repository } = createRepository();
		const first = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("still current"), attempt: attempt({ startedAt: capturedAt, finishedAt: capturedAt }) });
		repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("still current"), attempt: attempt({ startedAt: now - 1, finishedAt: now, cache: "revalidated" }) });
		const result = await repository.prune({ threadDays: 30, projectDays: 180, completedJobDays: 30, failedJobDays: 7, maxContentBytes: 1_000, now });
		assert.equal(result.expiredSnapshots, 0);
		assert.equal(repository.readSnapshot(threadScope(), first.snapshotId!, { offset: 0, maxChars: 20 }).status, "ok");
	});

	it("uses indexed retention ordering and yields while pruning a large library", async () => {
		const capturedAt = Date.parse("2026-01-01T00:00:00.000Z");
		const now = capturedAt + 40 * 86_400_000;
		const { repository, db } = createRepository({ deleteBatchSize: 25 });
		for (let index = 0; index < 2000; index += 1) {
			const url = `https://example.com/expired-${index}`;
			repository.recordRetrieval({
				scope: threadScope(),
				origin: "fetch",
				artifact: artifact(`expired ${index}`, { requestedUrl: url, resolvedUrl: url, finalUrl: url }),
				attempt: attempt({ startedAt: capturedAt, finishedAt: capturedAt }),
			});
		}
		const indexes = db.pragma("index_list('forage_snapshots')") as Array<{ name: string }>;
		assert.ok(indexes.some((index) => index.name === "forage_snapshots_retained"));
		const tombstoneIndexes = db.pragma("index_list('forage_snapshot_tombstones')") as Array<{ name: string }>;
		assert.ok(tombstoneIndexes.some((index) => index.name === "forage_snapshot_tombstones_source"));
		let timerFired = false;
		setTimeout(() => { timerFired = true; }, 0);
		const startedAt = performance.now();
		const result = await repository.prune({ threadDays: 30, projectDays: 180, completedJobDays: 30, failedJobDays: 7, maxContentBytes: 1_000_000, now });
		const durationMs = performance.now() - startedAt;
		assert.equal(result.expiredSnapshots, 2000);
		assert.equal(timerFired, true);
		assert.ok(durationMs < 2000, `expected indexed prune under 2000ms, got ${durationMs.toFixed(1)}ms`);
	});

	it("removes expired failed-attempt sources after their retrieval metadata is pruned", async () => {
		const now = 40 * 86_400_000;
		const { repository } = createRepository();
		const failed = repository.recordRetrieval({
			scope: threadScope(),
			origin: "fetch",
			artifact: null,
			requestedUrl: "https://example.com/failure",
			access: { network: "public", credentialed: false, requestScopeKey: "thread:proj_a:thr_a" },
			attempt: { ...attempt(), error: "failed" },
		});
		const result = await repository.prune({ threadDays: 30, projectDays: 180, completedJobDays: 30, failedJobDays: 7, maxContentBytes: 1_000, now });
		assert.equal(result.retrievals, 1);
		assert.equal(result.sources, 1);
		assert.equal(repository.get(threadScope(), failed.sourceId!), null);
	});

	it("expires tombstones and discovery links before removing empty sources", async () => {
		const capturedAt = Date.parse("2025-01-01T00:00:00.000Z");
		const now = capturedAt + 400 * 86_400_000;
		const { repository, db } = createRepository({ now: () => capturedAt });
		const receipt = repository.recordRetrieval({
			scope: threadScope(),
			origin: "fetch",
			artifact: artifact("expired", { fetchedAt: new Date(capturedAt).toISOString() }),
			attempt: attempt({ startedAt: capturedAt, finishedAt: capturedAt }),
		});
		repository.recordDiscovery({
			scope: threadScope(),
			fromSourceId: receipt.sourceId,
			method: "sitemap",
			urls: [{ url: "https://example.com/old", method: "sitemap", parentUrl: "https://example.com/sitemap.xml", title: null, lastModified: null }],
			observedAt: capturedAt,
		});
		repository.recordDiscovery({
			scope: threadScope(),
			fromSourceId: null,
			method: "sitemap",
			urls: [{ url: "https://example.com/root-old", method: "sitemap", parentUrl: "https://example.com/sitemap.xml", title: null, lastModified: null }],
			observedAt: capturedAt,
		});
		const result = await repository.prune({ threadDays: 30, projectDays: 180, completedJobDays: 30, failedJobDays: 7, maxContentBytes: 1_000, now });
		assert.equal(result.discoveryLinks, 2);
		assert.equal(result.sources, 1);
		assert.deepEqual(repository.list({ scope: threadScope(), limit: 10 }).sources, []);
		assert.equal((db.prepare("SELECT COUNT(*) AS count FROM forage_snapshot_tombstones").get() as { count: number }).count, 0);
		assert.equal((db.prepare("SELECT COUNT(*) AS count FROM forage_discovery_links").get() as { count: number }).count, 0);
	});

	it("prunes thousands of snapshots from one source without quadratic latest recomputation", async () => {
		const capturedAt = Date.parse("2025-01-01T00:00:00.000Z");
		const now = capturedAt + 40 * 86_400_000;
		const { repository, db } = createRepository({ now: () => capturedAt, deleteBatchSize: 100, maxContentBytes: 1024 * 1024 });
		const first = repository.recordRetrieval({
			scope: threadScope(),
			origin: "fetch",
			artifact: artifact("seed", { fetchedAt: new Date(capturedAt).toISOString() }),
			attempt: attempt({ startedAt: capturedAt, finishedAt: capturedAt }),
		});
		const snapshot = db.prepare("SELECT * FROM forage_snapshots WHERE id = ?").get(first.snapshotId!) as Record<string, unknown>;
		const retrieval = db.prepare("SELECT * FROM forage_retrievals WHERE id = ?").get(first.retrievalId!) as Record<string, unknown>;
		const insertSnapshot = db.prepare(`INSERT INTO forage_snapshots (id, source_id, kind, content_type, content, structured_json, content_hash, snapshot_hash,
			extractor_id, extractor_version, truncated, content_bytes, structured_bytes, fetched_at, retained_at, completeness_json, warnings_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
		const insertRetrieval = db.prepare(`INSERT INTO forage_retrievals (id, source_id, snapshot_id, origin, status, requested_url, resolved_url, final_url, transport,
			representation, access_network, access_credentialed, request_scope_key, http_status, artifact_bytes, redirects, diagnostics_json,
			completeness_json, warnings_json, started_at, finished_at, transferred_bytes, cache_state, error)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
		let latestSnapshotId = first.snapshotId!;
		db.transaction(() => {
			for (let index = 1; index < 4000; index += 1) {
				latestSnapshotId = `snap_perf_${index}`;
				insertSnapshot.run(latestSnapshotId, first.sourceId, snapshot.kind, snapshot.content_type, `body-${index}`, snapshot.structured_json,
					`content-${index}`, `snapshot-${index}`, snapshot.extractor_id, snapshot.extractor_version, snapshot.truncated, 10,
					snapshot.structured_bytes, capturedAt + index, capturedAt + index, snapshot.completeness_json, snapshot.warnings_json);
				insertRetrieval.run(`ret_perf_${index}`, first.sourceId, latestSnapshotId, retrieval.origin, retrieval.status, retrieval.requested_url,
					retrieval.resolved_url, retrieval.final_url, retrieval.transport, retrieval.representation, retrieval.access_network,
					retrieval.access_credentialed, retrieval.request_scope_key, retrieval.http_status, 10, retrieval.redirects, retrieval.diagnostics_json,
					retrieval.completeness_json, retrieval.warnings_json, capturedAt + index, capturedAt + index, 10, retrieval.cache_state, null);
			}
			db.prepare("UPDATE forage_sources SET latest_snapshot_id = ? WHERE id = ?").run(latestSnapshotId, first.sourceId);
		})();
		let timerFired = false;
		setTimeout(() => { timerFired = true; }, 0);
		const startedAt = performance.now();
		const result = await repository.prune({ threadDays: 30, projectDays: 180, completedJobDays: 30, failedJobDays: 7, maxContentBytes: 1024 * 1024, now });
		const durationMs = performance.now() - startedAt;
		assert.equal(result.expiredSnapshots, 4000);
		assert.equal(timerFired, true);
		assert.ok(durationMs < 2500, `expected linear prune under 2500ms, got ${durationMs.toFixed(1)}ms`);
	});
});
