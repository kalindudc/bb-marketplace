import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type {
	AccessDescriptor,
	Deadline,
	ExtractionOutput,
	OperationContext,
	RetrievalArtifact,
	SourceScope,
} from "../src/web/contracts.ts";
import { createByteBudget, createDeadline } from "../src/web/deadline.ts";
import { runBoundedProcess } from "../src/web/isolate.ts";
import { canonicalUrlKey } from "../src/web/url.ts";

describe("shared web contracts", () => {
	it("loads the SDK testing host with its declared cron-parser peer", async () => {
		const testing = await import("@get-bb/plugin-sdk/testing");
		assert.equal(typeof testing.createFakePluginHost, "function");
	});
	it("compile as the single shared contract surface", () => {
		const scope: SourceScope = { kind: "thread", projectId: "project", threadId: "thread" };
		const deadline: Deadline = createDeadline(1000);
		const context: OperationContext = { scope, deadline, byteBudget: createByteBudget(1024) };
		const access: AccessDescriptor = { network: "public", credentialed: false, requestScopeKey: "thread:project:thread" };
		const extraction: ExtractionOutput = {
			kind: "text",
			contentType: "text/plain",
			content: "body",
			structured: { schemaVersion: 1, title: "", description: "", canonicalUrl: null, language: null, headings: [], links: [], tables: [], jsonLd: [] },
			extractorVersion: "1",
			truncated: false,
			warnings: [],
		};
		const artifact: RetrievalArtifact = {
			schemaVersion: 1,
			requestedUrl: "https://example.com/",
			resolvedUrl: "https://example.com/",
			finalUrl: "https://example.com/",
			transport: "direct",
			representation: "readable",
			kind: extraction.kind,
			status: 200,
			contentType: extraction.contentType,
			bytes: 4,
			fetchedAt: new Date(0).toISOString(),
			title: "",
			content: extraction.content,
			contentHash: "0".repeat(64),
			structured: extraction.structured,
			extraction: { id: "forage:1" },
			access,
			completeness: { state: "complete", parts: [] },
			warnings: [],
			diagnostics: { durationMs: 1, redirects: 0, stageMs: {} },
		};
		assert.equal(context.scope?.kind, "thread");
		assert.equal(artifact.schemaVersion, 1);
		deadline.dispose();
	});
});

describe("deadline and byte budget", () => {
	it("aborts at one fixed expiry and propagates parent cancellation", async () => {
		const deadline = createDeadline(20);
		const expiresAt = deadline.expiresAt;
		await new Promise((resolve) => setTimeout(resolve, 35));
		assert.equal(deadline.expiresAt, expiresAt);
		assert.equal(deadline.signal.aborted, true);
		assert.throws(() => deadline.throwIfExpired("dns"), /dns.*timed out/i);
		deadline.dispose();

		const parent = new AbortController();
		const child = createDeadline(1000, parent.signal);
		parent.abort(new Error("parent stopped"));
		assert.equal(child.signal.aborted, true);
		child.dispose();
	});
	it("consumes bytes atomically and rejects over-budget reads", () => {
		const budget = createByteBudget(10);
		budget.consume(4);
		assert.equal(budget.remaining(), 6);
		assert.throws(() => budget.consume(7), /byte budget/i);
		assert.equal(budget.remaining(), 6);
	});
});

describe("canonicalUrlKey", () => {
	it("normalizes origin syntax without changing path or query case/order", () => {
		assert.equal(canonicalUrlKey("HTTPS://Example.COM:443/Aa?B=2&a=1#fragment"), "https://example.com/Aa?B=2&a=1");
		assert.equal(canonicalUrlKey("http://Example.com:80/path"), "http://example.com/path");
		assert.notEqual(canonicalUrlKey("https://example.com/Path"), canonicalUrlKey("https://example.com/path"));
	});
});

describe("bounded child processes", () => {
	it("kills children that exceed output or time bounds", async () => {
		await assert.rejects(
			runBoundedProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], { timeoutMs: 1000, maxStdoutBytes: 1024, maxStderrBytes: 1024 }),
			/stdout.*limit/i,
		);
		await assert.rejects(
			runBoundedProcess(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { timeoutMs: 20, maxStdoutBytes: 1024, maxStderrBytes: 1024 }),
			/timed out/i,
		);
	});
});
