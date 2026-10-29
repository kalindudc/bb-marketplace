import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { extractDeterministic } from "../../src/web/extract.ts";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/extract/${name}`, import.meta.url), "utf8");

describe("extractDeterministic", () => {
	it("extracts HTML through the existing converter with final-markdown line numbers", () => {
		const input = {
			finalUrl: "https://example.com/source/page",
			contentType: "text/html; charset=utf-8",
			body: fixture("structured.html"),
		};
		const first = extractDeterministic(input);
		const second = extractDeterministic(input);

		assert.deepEqual(second, first, "the same input is byte-for-byte deterministic");
		assert.equal(first.kind, "html");
		assert.equal(first.contentType, "text/html");
		assert.equal(first.structured.title, "Structured guide");
		assert.equal(first.structured.description, "A deterministic fixture");
		assert.equal(first.structured.canonicalUrl, "https://example.com/docs/guide");
		assert.equal(first.structured.language, "en-CA");
		assert.deepEqual(first.structured.headings, [
			{ level: 1, text: "Structured guide", line: 1 },
			{ level: 2, text: "Compatibility", line: 5 },
		]);
		assert.deepEqual(first.structured.links, [
			{ url: "https://example.com/docs/start", text: "quick start", relation: "content" },
			{ url: "https://example.com/docs/guide", text: "Structured guide", relation: "canonical" },
			{ url: "https://example.com/docs/guide.md", text: "Markdown", relation: "alternate" },
		]);
		assert.deepEqual(first.structured.tables, [{
			caption: "Versions",
			headers: ["Runtime", "Status"],
			rows: [["Node 24", "Supported"]],
			line: 9,
		}]);
		assert.deepEqual(first.structured.jsonLd, [{
			"@context": "https://schema.org",
			"@type": "TechArticle",
			name: "Structured guide",
		}]);
		assert.ok(first.warnings.some((warning) => warning.code === "invalid-json-ld"));
		assert.match(first.content, /\| Node 24 \| Supported \|/);
	});

	it("normalizes markdown and extracts fixed fields without inventing metadata", () => {
		const result = extractDeterministic({
			finalUrl: "https://example.com/releases/latest",
			contentType: "text/markdown",
			body: fixture("structured.md").replace(/\n/g, "\r\n"),
		});
		assert.equal(result.kind, "markdown");
		assert.doesNotMatch(result.content, /\r/);
		assert.equal(result.structured.title, "Release notes");
		assert.deepEqual(result.structured.headings, [
			{ level: 1, text: "Release notes", line: 1 },
			{ level: 2, text: "Support matrix", line: 5 },
		]);
		assert.deepEqual(result.structured.links, [{
			url: "https://example.com/docs/migrate",
			text: "migration guide",
			relation: "content",
		}]);
		assert.deepEqual(result.structured.tables, [{
			caption: null,
			headers: ["Runtime", "Status"],
			rows: [["Node 24", "Supported"]],
			line: 7,
		}]);
	});

	it("does not treat fenced code contents as document structure", () => {
		const result = extractDeterministic({
			finalUrl: "https://example.com/code",
			contentType: "text/markdown",
			body: "# Real heading\n\n```md\n# Fake heading\n[bad](/bad)\n| Fake | Table |\n| --- | --- |\n```\n\n[good](/good)\n",
		});
		assert.deepEqual(result.structured.headings, [{ level: 1, text: "Real heading", line: 1 }]);
		assert.deepEqual(result.structured.links, [{ url: "https://example.com/good", text: "good", relation: "content" }]);
		assert.deepEqual(result.structured.tables, []);
	});

	it("preserves exact JSON values and key order while leaving structured page fields empty", () => {
		const body = '{"id":12345678901234567890,"2":1,"1":2,"dup":1,"dup":2}';
		const result = extractDeterministic({
			finalUrl: "https://example.com/data.json",
			contentType: "application/json",
			body,
		});
		assert.equal(result.kind, "json");
		assert.equal(result.content, body);
		assert.deepEqual(result.structured, {
			schemaVersion: 1,
			title: "data.json",
			description: "",
			canonicalUrl: null,
			language: null,
			headings: [],
			links: [],
			tables: [],
			jsonLd: [],
		});
	});

	it("scans hostile markdown inputs in bounded time", () => {
		for (const body of ["[".repeat(80_000), "<http://".repeat(10_000), "[a](<".repeat(200_000)]) {
			const started = performance.now();
			extractDeterministic({ finalUrl: "https://example.com/hostile.md", contentType: "text/markdown", body });
			assert.ok(performance.now() - started < 250, "markdown link scanning must remain linear");
		}
	});

	it("bounds inline cleanup for large headings, link labels, table cells, and HTML headings", () => {
		const hostile = "![".repeat(80_000);
		const cases = [
			{ contentType: "text/markdown", body: `# ${hostile}` },
			{ contentType: "text/markdown", body: `[${hostile}](/target)` },
			{ contentType: "text/markdown", body: `| Value |\n| --- |\n| ${hostile} |\n` },
			{ contentType: "text/html", body: `<h1>${hostile}</h1>` },
		];
		for (const input of cases) {
			const started = performance.now();
			extractDeterministic({ finalUrl: "https://example.com/hostile", ...input });
			assert.ok(performance.now() - started < 500, `${input.contentType} inline cleanup must be bounded`);
		}
	});

	it("parses long ATX whitespace and closing markers in linear time", () => {
		const body = `# a${" ".repeat(200_000)}x ###\n## Keep#\n### End ###   `;
		const started = performance.now();
		const result = extractDeterministic({ finalUrl: "https://example.com/heading.md", contentType: "text/markdown", body });
		assert.ok(performance.now() - started < 1_000, "ATX parsing must remain linear");
		assert.deepEqual(result.structured.headings.map(({ text }) => text), ["a x", "Keep#", "End"]);
		assert.equal(result.content, body);
	});

	it("bounds total inline work and table cells while preserving source text", () => {
		const fragment = "[".repeat(4_094);
		for (const body of [
			Array.from({ length: 2_000 }, () => `# ${fragment}`).join("\n"),
			`|${Array.from({ length: 1_280 }, () => fragment).join("|")}|\n| --- |\n| body |\n`,
		]) {
			const started = performance.now();
			const result = extractDeterministic({ finalUrl: "https://example.com/inline.md", contentType: "text/markdown", body });
			assert.ok(performance.now() - started < 1_500, "inline work must remain linear across the document");
			assert.equal(result.content, body);
			if (body.startsWith("|")) {
				assert.equal(result.structured.tables.length, 1);
				assert.equal(result.structured.tables[0]!.headers.length, 256);
				assert.equal(result.truncated, true);
				assert.ok(result.warnings.some(({ code }) => code === "table-cell-limit"));
			}
		}
	});

	it("preserves long inline labels and bounds table cells by the shared item budget", () => {
		const label = "visible ".repeat(1_000).trim();
		const result = extractDeterministic({
			finalUrl: "https://example.com/labels.md", contentType: "text/markdown",
			body: `# ![image](a.png) [${label}](/target) <https://example.com/>\n`,
		});
		assert.equal(result.structured.headings[0]!.text, `image ${label} https://example.com/`);
		assert.equal(result.structured.links[0]!.text, label);
		const body = `| ${"header | ".repeat(300)}\n| --- |\n| ${"cell | ".repeat(300)}\n`;
		const bounded = extractDeterministic({
			finalUrl: "https://example.com/table.md", contentType: "text/markdown", body, maxStructuredItems: 10,
		});
		assert.equal(bounded.truncated, true);
		assert.ok(bounded.structured.tables[0]!.headers.length + bounded.structured.tables[0]!.rows.flat().length <= 10);
		assert.ok(bounded.warnings.some(({ code }) => code === "structured-item-limit"));
		assert.equal(bounded.content, body);
		const wideRow = extractDeterministic({
			finalUrl: "https://example.com/row.md", contentType: "text/markdown",
			body: `| header |\n| --- |\n| ${"cell | ".repeat(300)}\n`,
		});
		assert.equal(wideRow.structured.tables[0]!.rows[0]!.length, 256);
		assert.equal(wideRow.truncated, true);
		assert.ok(wideRow.warnings.some(({ code }) => code === "table-cell-limit"));
	});

	it("retains links found inside markdown table rows", () => {
		const result = extractDeterministic({
			finalUrl: "https://example.com/table.md",
			contentType: "text/markdown",
			body: "| Name | More |\n| --- | --- |\n| [one](/one) | [two](/two) |\n",
		});
		assert.deepEqual(result.structured.links, [
			{ url: "https://example.com/one", text: "one", relation: "content" },
			{ url: "https://example.com/two", text: "two", relation: "content" },
		]);
	});

	it("drops JSON-LD that cannot be serialized within bounded depth", () => {
		const nested = `${"[".repeat(30_000)}${"]".repeat(30_000)}`;
		const result = extractDeterministic({
			finalUrl: "https://example.com/deep",
			contentType: "text/html",
			body: `<html><head><script type="application/ld+json">${nested}</script></head><body><p>x</p></body></html>`,
		});
		assert.deepEqual(result.structured.jsonLd, []);
		assert.ok(result.warnings.some((warning) => warning.code === "json-ld-complexity-limit"));
		assert.doesNotThrow(() => JSON.stringify(result.structured));
	});

	it("caps repeated invalid JSON-LD warnings", () => {
		const result = extractDeterministic({
			finalUrl: "https://example.com/invalid",
			contentType: "text/html",
			body: `<html><body>${'<script type="application/ld+json">x</script>'.repeat(500)}</body></html>`,
		});
		assert.ok(result.warnings.length <= 100);
		assert.ok(result.warnings.some((warning) => warning.code === "warning-limit"));
	});

	it("caps structured items explicitly", () => {
		const result = extractDeterministic({
			finalUrl: "https://example.com/many",
			contentType: "text/markdown",
			body: "# One\n\n## Two\n\n[three](/three)\n",
			maxStructuredItems: 2,
		});
		assert.equal(result.truncated, true);
		assert.equal(result.structured.headings.length, 2);
		assert.equal(result.structured.links.length, 0);
		assert.ok(result.warnings.some((warning) => warning.code === "structured-item-limit"));
	});
});
