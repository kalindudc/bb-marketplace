import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { rpcContract } from "../../src/contract.ts";
import { diffSnapshots } from "../../src/sources/diff.ts";
import type { SnapshotDocument } from "../../src/sources/model.ts";
import { structured, threadScope } from "./helpers.ts";

function snapshot(id: string, content: string, extractorVersion = "1"): SnapshotDocument {
	return {
		id,
		sourceId: "src_a",
		scope: threadScope(),
		kind: "markdown",
		contentType: "text/markdown",
		content,
		structured: structured(),
		contentHash: id.padEnd(64, "0").slice(0, 64),
		snapshotHash: id.padEnd(64, "1").slice(0, 64),
		extractorId: "forage",
		extractorVersion,
		chars: content.length,
		bytes: Buffer.byteLength(content),
		truncated: false,
		fetchedAt: 1,
		checkedAt: 1,
		completeness: { state: "complete", parts: [] },
		warnings: [],
	};
}

describe("bounded snapshot diff", () => {
	it("returns stable line-addressed heading, table, and code hunks", () => {
		const before = snapshot("snap_before", readFileSync(new URL("../fixtures/sources/diff-before.md", import.meta.url), "utf8"));
		const after = snapshot("snap_after", readFileSync(new URL("../fixtures/sources/diff-after.md", import.meta.url), "utf8"));
		const result = diffSnapshots(before, after);
		assert.equal(result.unchanged, false);
		assert.deepEqual(result.hunks.map((hunk) => hunk.headingPath), [["API"], ["API"], ["API"]]);
		assert.ok(result.hunks.every((hunk) => (hunk.before?.startLine ?? hunk.after?.startLine ?? 0) > 0));
		assert.equal(result.truncated, false);
	});

	it("keeps skipped heading levels dense and valid through the RPC contract", () => {
		const result = diffSnapshots(snapshot("snap_a", "# A\n\n### B\n\nold"), snapshot("snap_b", "# A\n\n### B\n\nnew"));
		assert.deepEqual(result.hunks.map((hunk) => hunk.headingPath), [["A", "B"]]);
		assert.equal(rpcContract.diffSnapshots.output.safeParse(result).success, true);
	});

	it("does not report repeated identical blocks as changed", () => {
		const unchanged = diffSnapshots(snapshot("snap_a", "foo\n\nfoo"), snapshot("snap_b", "foo\n\nfoo"));
		assert.equal(unchanged.unchanged, true);
		assert.deepEqual(unchanged.hunks, []);
		assert.equal(unchanged.addedLines, 0);
		assert.equal(unchanged.removedLines, 0);

		const inserted = diffSnapshots(snapshot("snap_c", "A\n\nA\n\nB"), snapshot("snap_d", "N\n\nA\n\nA\n\nB"));
		assert.deepEqual(inserted.hunks.map((hunk) => ({ kind: hunk.kind, before: hunk.before?.text ?? null, after: hunk.after?.text ?? null })), [
			{ kind: "added", before: null, after: "N" },
		]);
		assert.equal(inserted.addedLines, 1);
		assert.equal(inserted.removedLines, 0);
	});

	it("reports extractor changes even when content is unchanged", () => {
		const result = diffSnapshots(snapshot("snap_a", "same", "1"), snapshot("snap_b", "same", "2"));
		assert.equal(result.unchanged, true);
		assert.equal(result.extractorChanged, true);
		assert.match(result.warnings.join(" "), /extractor/i);
	});

	it("enforces block, hunk, character, cancellation, and deadline bounds", () => {
		const many = Array.from({ length: 100 }, (_, index) => `## H${index}\n\nvalue ${index}`).join("\n\n");
		const bounded = diffSnapshots(snapshot("snap_a", many), snapshot("snap_b", many.replaceAll("value", "changed")), { maxBlocks: 20, maxHunks: 3, maxChars: 80 });
		assert.equal(bounded.truncated, true);
		assert.ok(bounded.hunks.length <= 3);
		assert.ok(bounded.hunks.reduce((total, hunk) => total + (hunk.before?.text.length ?? 0) + (hunk.after?.text.length ?? 0), 0) <= 80);
		assert.ok(bounded.blockSummary);

		const aborted = new AbortController();
		aborted.abort(new Error("stop"));
		assert.throws(() => diffSnapshots(snapshot("snap_a", "a"), snapshot("snap_b", "b"), { signal: aborted.signal }), /cancel/i);
		assert.throws(() => diffSnapshots(snapshot("snap_a", "a"), snapshot("snap_b", "b"), { deadlineAt: 0, now: () => 1 }), /timed out/i);
	});
});
