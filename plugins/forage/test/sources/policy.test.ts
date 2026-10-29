import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { reconcileOrphanScopes } from "../../src/sources/policy.ts";
import { artifact, attempt, createRepository, projectScope, structured, threadScope } from "./helpers.ts";

describe("capture policy", () => {
	it("rejects restricted capture unless explicitly enabled for a thread", () => {
		const { repository } = createRepository();
		const restricted = artifact("private", { access: { network: "private", credentialed: false, requestScopeKey: "thread:proj_a:thr_a" } });
		const denied = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: restricted, attempt: attempt() });
		assert.equal(denied.persisted, false);
		assert.equal(denied.warning?.code, "POLICY_BLOCKED");
		const allowed = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: restricted, attempt: attempt(), allowRestrictedThreadCapture: true });
		assert.equal(allowed.persisted, true);
		assert.throws(() => repository.copyToProject({ from: threadScope(), sourceId: allowed.sourceId! }), /restricted/i);
	});

	it("rejects sensitive requested, redirect, canonical, structured-link, and content URLs without storing them", () => {
		const cases = [
			artifact("body", { requestedUrl: "https://example.com/?token=secret" }),
			artifact("body", { resolvedUrl: "https://example.com/?Code=secret" }),
			artifact("body", { finalUrl: "https://user:pass@example.com/" }),
			artifact("body", { structured: structured({ canonicalUrl: "https://example.com/?signature=secret" }) }),
			artifact("body", { structured: structured({ links: [{ url: "https://example.com/?access_token=secret", text: "x", relation: "content" }] }) }),
			artifact("See https://example.com/?session=secret for details"),
		];
		for (const value of cases) {
			const { repository, db } = createRepository();
			const receipt = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: value, attempt: attempt() });
			assert.equal(receipt.persisted, false);
			assert.equal(receipt.warning?.code, "POLICY_BLOCKED");
			assert.equal((db.prepare("SELECT COUNT(*) AS count FROM forage_sources").get() as { count: number }).count, 0);
			assert.doesNotMatch(JSON.stringify(receipt), /secret/);
		}
	});

	it("accepts ordinary pages with hundreds of benign links and labels an unverified URL overflow distinctly", () => {
		const benign = Array.from({ length: 600 }, (_, index) => `https://example.com/page-${index}`).join("\n");
		const { repository } = createRepository();
		const accepted = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact(benign), attempt: attempt() });
		assert.equal(accepted.persisted, true);

		const overflow = Array.from({ length: 5000 }, (_, index) => `https://example.com/page-${index}`).join("\n");
		const rejected = repository.recordRetrieval({
			scope: threadScope("thr_overflow"),
			origin: "fetch",
			artifact: artifact(overflow, { finalUrl: "https://example.com/overflow", requestedUrl: "https://example.com/overflow", resolvedUrl: "https://example.com/overflow" }),
			attempt: attempt(),
		});
		assert.equal(rejected.persisted, false);
		assert.match(rejected.warning?.message ?? "", /too many URL tokens to verify/i);
		assert.doesNotMatch(rejected.warning?.message ?? "", /sensitive URL/i);
	});

	it("rejects sensitive discovery links before writing any edge", () => {
		const { repository, db } = createRepository();
		assert.throws(() => repository.recordDiscovery({
			scope: threadScope(),
			fromSourceId: null,
			method: "sitemap",
			urls: [{ url: "https://example.com/?sig=secret", parentUrl: "https://example.com/sitemap.xml", title: null, lastModified: null, method: "sitemap" }],
			observedAt: 1,
		}), /sensitive URL policy/i);
		assert.equal((db.prepare("SELECT COUNT(*) AS count FROM forage_discovery_links").get() as { count: number }).count, 0);
	});

	it("keeps a source restricted after a later public retrieval", async () => {
		const { repository } = createRepository();
		const restricted = artifact("restricted", { access: { network: "public", credentialed: true, requestScopeKey: "thread:proj_a:thr_a" } });
		const first = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: restricted, attempt: attempt(), allowRestrictedThreadCapture: true });
		repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("public later"), attempt: attempt() });
		const records = [];
		for await (const record of repository.export(threadScope(), {})) records.push(record);
		assert.equal(records.length, 0);
		assert.throws(() => repository.copyToProject({ from: threadScope(), sourceId: first.sourceId! }), /restricted/i);
	});

	it("requires explicit selected thread records for restricted export", async () => {
		const { repository } = createRepository();
		const publicReceipt = repository.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("public"), attempt: attempt() });
		const restrictedReceipt = repository.recordRetrieval({
			scope: threadScope(),
			origin: "fetch",
			artifact: artifact("restricted", {
				requestedUrl: "https://example.com/private",
				resolvedUrl: "https://example.com/private",
				finalUrl: "https://example.com/private",
				access: { network: "public", credentialed: true, requestScopeKey: "thread:proj_a:thr_a" },
			}),
			attempt: attempt(),
			allowRestrictedThreadCapture: true,
		});
		const defaultRecords = [];
		for await (const record of repository.export(threadScope(), {})) defaultRecords.push(record);
		assert.deepEqual(defaultRecords.map((record) => record.source.id), [publicReceipt.sourceId]);
		const selected = [];
		for await (const record of repository.export(threadScope(), { sourceIds: [restrictedReceipt.sourceId!], includeRestricted: true })) selected.push(record);
		assert.equal(selected.length, 1);
		assert.equal(selected[0]!.source.id, restrictedReceipt.sourceId);
		await assert.rejects(async () => {
			for await (const _record of repository.export(projectScope(), { includeRestricted: true })) void _record;
		}, /thread scope/i);
	});
});

describe("authoritative orphan reconciliation", () => {
	it("deletes only scopes authoritatively reported missing and preserves transient failures", async () => {
		const { repository } = createRepository();
		repository.recordRetrieval({ scope: threadScope("thr_missing"), origin: "fetch", artifact: artifact("missing"), attempt: attempt() });
		repository.recordRetrieval({ scope: threadScope("thr_transient"), origin: "fetch", artifact: artifact("transient", { finalUrl: "https://example.com/transient", requestedUrl: "https://example.com/transient", resolvedUrl: "https://example.com/transient" }), attempt: attempt() });
		repository.recordRetrieval({ scope: threadScope("thr_archived"), origin: "fetch", artifact: artifact("archived", { finalUrl: "https://example.com/archived", requestedUrl: "https://example.com/archived", resolvedUrl: "https://example.com/archived" }), attempt: attempt() });
		const result = await reconcileOrphanScopes(repository, async (scope) => {
			if (scope.kind === "thread" && scope.threadId === "thr_missing") return { status: "missing" } as const;
			if (scope.kind === "thread" && scope.threadId === "thr_transient") throw new Error("503 from SDK");
			return { status: "present", archived: true } as const;
		});
		assert.deepEqual(result.deleted, ["thread:proj_a:thr_missing"]);
		assert.deepEqual(result.failed.map((failure) => failure.scopeKey), ["thread:proj_a:thr_transient"]);
		assert.equal(repository.list({ scope: threadScope("thr_missing"), limit: 10 }).sources.length, 0);
		assert.equal(repository.list({ scope: threadScope("thr_transient"), limit: 10 }).sources.length, 1);
		assert.equal(repository.list({ scope: threadScope("thr_archived"), limit: 10 }).sources.length, 1);
	});
});
