import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { artifact, attempt, createRepository, MaintenanceStub, threadScope } from "./helpers.ts";

function capacityFixture(count: number) {
	const maintenance = new MaintenanceStub();
	const fixture = createRepository({ maxContentBytes: count, maintenance });
	const first = fixture.repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("x"), attempt: attempt() });
	const insertSnapshot = fixture.db.prepare(`INSERT INTO forage_snapshots
		SELECT ?, source_id, kind, content_type, content, structured_json, content_hash, ?, extractor_id, extractor_version,
		truncated, content_bytes, structured_bytes, fetched_at, completeness_json, warnings_json, retained_at + ?
		FROM forage_snapshots WHERE id = ?`);
	const insertRetrieval = fixture.db.prepare(`INSERT INTO forage_retrievals
		SELECT ?, source_id, ?, origin, status, requested_url, resolved_url, final_url, transport, representation,
		access_network, access_credentialed, request_scope_key, http_status, artifact_bytes, redirects, diagnostics_json,
		completeness_json, warnings_json, started_at + ?, finished_at + ?, transferred_bytes, cache_state, error
		FROM forage_retrievals WHERE id = ?`);
	fixture.db.transaction(() => {
		for (let index = 1; index < count; index += 1) {
			insertSnapshot.run(`snap_bound_${index}`, `hash_bound_${index}`, index, first.snapshotId);
			insertRetrieval.run(`ret_bound_${index}`, `snap_bound_${index}`, index, index, first.retrievalId);
		}
		fixture.db.prepare("UPDATE forage_sources SET latest_snapshot_id = ?, last_retrieved_at = ? WHERE id = ?").run(`snap_bound_${count - 1}`, 200 + count - 1, first.sourceId);
	})();
	return { ...fixture, maintenance };
}

function exportFixture(count: number, restricted: boolean) {
	const fixture = createRepository();
	const first = fixture.repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("selected"), attempt: attempt() });
	const insertSource = fixture.db.prepare(`INSERT INTO forage_sources
		SELECT ?, scope_key, scope_kind, project_id, thread_id, ?, ?, canonical_url, access_network, ?, request_scope_key,
		title, NULL, last_retrieved_at, created_at, updated_at, deleting FROM forage_sources WHERE id = ?`);
	fixture.db.transaction(() => {
		for (let index = 0; index < count; index += 1) {
			const url = `https://example.com/skipped-${index}`;
			insertSource.run(`src_skipped_${index}`, url, url, restricted ? 1 : 0, first.sourceId);
		}
	})();
	return { ...fixture, first };
}

describe("synchronous capacity work bound", () => {
	it.each([false, true])("refuses atomically after at most 1000 examined snapshots (protected=%s)", (protectedWindow) => {
		const { repository, db, maintenance } = capacityFixture(1200);
		if (protectedWindow) {
			const rows = db.prepare("SELECT id FROM forage_snapshots ORDER BY retained_at, id LIMIT 1000").all() as Array<{ id: string }>;
			for (const row of rows) maintenance.protected.add(row.id);
		}
		const before = db.serialize();
		const prepare = vi.spyOn(db, "prepare");
		try {
			const startedAt = performance.now();
			const receipt = repository.recordRetrieval({
				scope: threadScope(), origin: "fetch", artifact: artifact("y".repeat(protectedWindow ? 1 : 1200)), attempt: attempt({ finishedAt: 4000 }),
			});
			const durationMs = performance.now() - startedAt;
			assert.equal(receipt.persisted, false);
			assert.equal(receipt.warning?.code, "STORAGE_LIMIT");
			assert.equal(receipt.sourceId, null);
			const scans = prepare.mock.calls.filter(([sql]) => sql.includes("s INDEXED BY forage_snapshots_retained"));
			assert.ok(scans.length <= 10, `expected at most 10 capacity batches, got ${scans.length}`);
			assert.deepEqual(maintenance.beforeDeleted, []);
			assert.deepEqual(db.serialize(), before);
			assert.ok(durationMs < 250, `expected bounded capture under 250ms, got ${durationMs.toFixed(1)}ms`);
			console.info(`capacity refusal protected=${protectedWindow}: ${scans.length} batches, ${durationMs.toFixed(1)}ms`);
		} finally {
			prepare.mockRestore();
			db.close();
		}
	});

	it("allows exactly 1000 evictions without exceeding the capture lag budget", async () => {
		const { repository, db, maintenance } = capacityFixture(1000);
		let lagMs = 0;
		const startedAt = performance.now();
		const timer = new Promise<void>((resolve) => setTimeout(() => { lagMs = performance.now() - startedAt; resolve(); }, 0));
		try {
			const receipt = repository.recordRetrieval({
				scope: threadScope(), origin: "fetch", artifact: artifact("y".repeat(1000)), attempt: attempt({ finishedAt: 4000 }),
			});
			await timer;
			assert.equal(receipt.persisted, true);
			assert.equal(maintenance.beforeDeleted.flat().length, 1000);
			assert.equal(repository.storageSummary(threadScope()).snapshots, 1);
			assert.equal(repository.get(threadScope(), receipt.sourceId!)?.latestSnapshot?.id, receipt.snapshotId);
			assert.ok(lagMs < 250, `expected capture timer lag under 250ms, got ${lagMs.toFixed(1)}ms`);
			console.info(`capacity boundary: 1000 evictions, ${lagMs.toFixed(1)}ms timer lag`);
		} finally {
			db.close();
		}
	});
});

describe("export source batches", () => {
	it("queries selected IDs without scanning unselected sources", async () => {
		const { repository, db, first } = exportFixture(1200, false);
		const prepare = vi.spyOn(db, "prepare");
		try {
			const startedAt = performance.now();
			const records = [];
			for await (const record of repository.export(threadScope(), { sourceIds: [first.sourceId!, first.sourceId!, "missing"] })) records.push(record);
			const durationMs = performance.now() - startedAt;
			assert.deepEqual(records.map((record) => record.source.id), [first.sourceId]);
			const scans = prepare.mock.calls.filter(([sql]) => sql.includes("SELECT * FROM forage_sources"));
			assert.equal(scans.length, 1);
			assert.ok(durationMs < 250, `expected selected export under 250ms, got ${durationMs.toFixed(1)}ms`);
			console.info(`selected export: ${scans.length} source query, ${durationMs.toFixed(1)}ms`);
		} finally {
			prepare.mockRestore();
			db.close();
		}
	});

	it("continues past empty selected-ID batches without exposing other scopes or deleting sources", async () => {
		const { repository, db, first } = exportFixture(1200, true);
		const other = repository.recordRetrieval({ scope: threadScope("other"), origin: "fetch", artifact: artifact("other scope"), attempt: attempt() });
		const deleting = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("deleting", { finalUrl: "https://example.com/deleting" }), attempt: attempt() });
		db.prepare("UPDATE forage_sources SET deleting = 1 WHERE id = ?").run(deleting.sourceId);
		const sourceIds = [deleting.sourceId!, first.sourceId!, other.sourceId!, ...Array.from({ length: 100 }, (_, index) => `missing_${index}`)];
		try {
			const records = [];
			for await (const record of repository.export(threadScope(), { sourceIds, includeRestricted: true })) records.push(record);
			assert.deepEqual(records.map((record) => record.source.id), [first.sourceId]);
			for await (const _record of repository.export(threadScope(), { sourceIds: [] })) assert.fail("An empty selection must not export anything.");
		} finally {
			db.close();
		}
	});

	it("observes cancellation between empty selected-ID batches", async () => {
		const { repository, db } = createRepository();
		const controller = new AbortController();
		setImmediate(() => controller.abort());
		try {
			await assert.rejects(async () => {
				for await (const _record of repository.export(threadScope(), { sourceIds: Array.from({ length: 100 }, (_, index) => `missing_${index}`), signal: controller.signal })) assert.fail("Missing sources must not emit records.");
			}, /cancelled/i);
		} finally {
			db.close();
		}
	});

	it.each([false, true])("yields and observes cancellation in batches that emit nothing (restricted=%s)", async (restricted) => {
		const { repository, db, first } = exportFixture(1200, restricted);
		db.prepare("UPDATE forage_sources SET deleting = 1 WHERE id = ?").run(first.sourceId);
		const controller = new AbortController();
		setImmediate(() => controller.abort());
		try {
			await assert.rejects(async () => {
				for await (const _record of repository.export(threadScope(), { signal: controller.signal })) assert.fail("Skipped sources must not emit records.");
			}, /cancelled/i);
		} finally {
			db.close();
		}
	});

	it("keeps timers responsive while skipping restricted sources", async () => {
		const { repository, db, first } = exportFixture(1200, true);
		db.prepare("UPDATE forage_sources SET deleting = 1 WHERE id = ?").run(first.sourceId);
		let ticks = 0;
		let maxLagMs = 0;
		let lastTick = performance.now();
		const timer = setInterval(() => {
			const now = performance.now();
			maxLagMs = Math.max(maxLagMs, now - lastTick);
			lastTick = now;
			ticks += 1;
		}, 1);
		try {
			for await (const _record of repository.export(threadScope(), {})) assert.fail("Restricted sources must not be exported.");
			assert.ok(ticks > 0, "expected timer ticks during skipped source batches");
			assert.ok(maxLagMs < 250, `expected export timer lag under 250ms, got ${maxLagMs.toFixed(1)}ms`);
			console.info(`skipped restricted export: ${ticks} timer ticks, ${maxLagMs.toFixed(1)}ms maximum lag`);
		} finally {
			clearInterval(timer);
			db.close();
		}
	});
});
