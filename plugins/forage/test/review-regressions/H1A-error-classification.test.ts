import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { CONFIG_DEFAULTS } from "../../src/web/config.ts";
import { type TestServer, startServer } from "../_server.ts";

vi.mock("../../src/web/html.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/web/html.ts")>();
	const { DeadlineError } = await import("../../src/web/deadline.ts");
	return {
		...actual,
		extractDocument: () => {
			throw new DeadlineError("HTML extraction");
		},
	};
});

vi.mock("../../src/web/isolate.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/web/isolate.ts")>();
	return {
		...actual,
		runBoundedProcess: async () => {
			throw new actual.BoundedProcessTimeoutError(25);
		},
	};
});

const { fetchContent } = await import("../../src/web/fetch.ts");

describe("H1A review regressions: extraction error classification", () => {
	let server: TestServer;
	beforeAll(async () => {
		server = await startServer({
			"/html": (_req, res) => {
				res.writeHead(200, { "content-type": "text/html" });
				res.end("<!doctype html><html><body><main>content</main></body></html>");
			},
			"/pdf": (_req, res) => {
				res.writeHead(200, { "content-type": "application/pdf" });
				res.end("%PDF-mocked");
			},
		});
	});
	afterAll(async () => server.close());

	it("classifies HTML extraction DeadlineError as timeout", async () => {
		const result = await fetchContent(`${server.url}/html`, {
			mode: "readable",
			config: { ...CONFIG_DEFAULTS, allowPrivateNetwork: true, warnings: [] },
			noCache: true,
		});
		assert.equal(result.errorCode, "timeout");
		assert.match(result.error ?? "", /HTML extraction timed out/i);
	});

	it("classifies a pdftotext child-process timeout as timeout", async () => {
		const result = await fetchContent(`${server.url}/pdf`, {
			mode: "readable",
			config: { ...CONFIG_DEFAULTS, allowPrivateNetwork: true, warnings: [] },
			noCache: true,
		});
		assert.equal(result.errorCode, "timeout");
		assert.match(result.error ?? "", /Child process timed out after 25ms/i);
	});
});
