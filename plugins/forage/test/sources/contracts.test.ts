import assert from "node:assert/strict";
import { describe, expectTypeOf, it } from "vitest";
import { deleteScopeConfirmation, deleteSourceConfirmation, rpcContract, sourceScopeSchema } from "../../src/contract.ts";
import type { CrawlJobMaintenancePort, CrawlJobService, JobMaintenancePort } from "../../src/jobs/model.ts";
import type { SourceRepository } from "../../src/sources/model.ts";
import { SqliteSourceRepository } from "../../src/sources/repository.ts";
import type { SourceScope as SharedSourceScope } from "../../src/web/contracts.ts";
import type { SourceScope } from "../../src/sources/model.ts";
import { artifact, attempt, createRepository } from "./helpers.ts";

const thread: SourceScope = { kind: "thread", projectId: "proj_a", threadId: "thr_a" };

const parseInput = (method: keyof typeof rpcContract, input: unknown) => rpcContract[method].input.safeParse(input);

describe("frozen source, job, and RPC contracts", () => {
	it("re-exports the H1 source scope instead of defining a competing type", () => {
		const source: SourceScope = thread;
		const shared: SharedSourceScope = source;
		assert.deepEqual(shared, thread);
		assert.equal(sourceScopeSchema.safeParse(thread).success, true);
		assert.equal(sourceScopeSchema.safeParse({ kind: "thread", projectId: "a:b", threadId: "c" }).success, false);
		assert.equal(sourceScopeSchema.safeParse({ kind: "thread", projectId: "a", threadId: "b:c" }).success, false);
	});

	it("publishes the complete strict RPC method surface", () => {
		assert.deepEqual(Object.keys(rpcContract).sort(), [
			"cancelCrawlJob",
			"copySourceToProject",
			"deleteScope",
			"deleteSource",
			"diffSnapshots",
			"getCrawlJob",
			"getSource",
			"listCrawlJobs",
			"listSources",
			"readSnapshot",
			"resumeCrawlJob",
			"sourceSummary",
		].sort());
		assert.equal(parseInput("listSources", { scope: thread, limit: 20, unsupported: true }).success, false);
		assert.equal(parseInput("readSnapshot", { scope: thread, snapshotId: "snap_a", offset: 0, maxChars: 200_001 }).success, false);
		assert.equal(parseInput("listCrawlJobs", { scope: thread, limit: 101 }).success, false);
	});

	it("validates concrete repository results with strict output schemas", () => {
		const { repository } = createRepository();
		const receipt = repository.recordRetrieval({ scope: thread, origin: "fetch", artifact: artifact("contract"), attempt: attempt() });
		assert.equal(rpcContract.listSources.output.safeParse(repository.list({ scope: thread, limit: 20 })).success, true);
		assert.equal(rpcContract.getSource.output.safeParse(repository.get(thread, receipt.sourceId!)).success, true);
		assert.equal(rpcContract.readSnapshot.output.safeParse(repository.readSnapshot(thread, receipt.snapshotId!, { offset: 0, maxChars: 200 })).success, true);
		assert.equal(rpcContract.sourceSummary.output.safeParse({ scopes: [repository.storageSummary(thread)] }).success, true);
	});

	it("requires exact destructive confirmation tokens", () => {
		const sourceId = "src_a";
		const sourceToken = deleteSourceConfirmation(thread, sourceId);
		assert.equal(parseInput("deleteSource", { scope: thread, sourceId, confirm: sourceToken }).success, true);
		assert.equal(parseInput("deleteSource", { scope: thread, sourceId, confirm: "yes" }).success, false);
		const scopeToken = deleteScopeConfirmation(thread);
		assert.equal(parseInput("deleteScope", { scope: thread, confirm: scopeToken }).success, true);
		assert.equal(parseInput("deleteScope", { scope: thread, confirm: "thread:other" }).success, false);
	});

	it("keeps the downstream structural ports compatible without a crawl implementation", () => {
		expectTypeOf<SqliteSourceRepository>().toMatchTypeOf<SourceRepository>();
		expectTypeOf<CrawlJobMaintenancePort>().toMatchTypeOf<CrawlJobService>();
		expectTypeOf<CrawlJobMaintenancePort>().toMatchTypeOf<JobMaintenancePort>();
	});
});
