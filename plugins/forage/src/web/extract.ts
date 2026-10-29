import type { ExtractionOutput, RetrievalWarning, SnapshotKind, StructuredDocument } from "./contracts.ts";
import { extractDocument, findHtmlMarkdownAlternates, tokenize } from "./html.ts";

export const DETERMINISTIC_EXTRACTOR_VERSION = "forage-deterministic-v1";
const DEFAULT_MAX_STRUCTURED_ITEMS = 2_000;
const HARD_MAX_STRUCTURED_ITEMS = 10_000;
const MAX_JSON_LD_BYTES = 1024 * 1024;
const MAX_JSON_LD_DEPTH = 64;
const MAX_JSON_LD_NODES = 10_000;
const MAX_WARNINGS = 100;
const MAX_TABLE_CELLS = 256;

export interface ExtractionInput {
	finalUrl: string;
	contentType: string;
	body: string;
	maxStructuredItems?: number;
}

interface StructuredAccumulator {
	remaining: number;
	truncated: boolean;
	warnings: RetrievalWarning[];
	suppressedWarnings: number;
	warningLimitIndex: number | null;
}

function normalizedContentType(value: string): string {
	return value.split(";", 1)[0]!.trim().toLowerCase();
}

function warning(code: string, message: string): RetrievalWarning {
	return { code, stage: "extract", message };
}

function normalizeText(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

function titleFromUrl(value: string): string {
	try {
		const url = new URL(value);
		const last = url.pathname.split("/").filter(Boolean).pop();
		return last ? decodeURIComponent(last) : url.hostname;
	} catch {
		return value;
	}
}

function resolveLink(value: string, baseUrl: string): string | null {
	const trimmed = value.trim().replace(/^<|>$/g, "");
	if (!trimmed || trimmed.startsWith("#") || /^(?:javascript|data|mailto|tel|vbscript):/i.test(trimmed)) return null;
	try {
		const url = new URL(trimmed, baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.hash = "";
		return url.href;
	} catch {
		return null;
	}
}

function plainInline(value: string): string {
	const labels: string[] = [];
	let start = 0;
	let index = 0;
	while (index < value.length) {
		const labelStart = value[index] === "[" ? index + 1 : value.startsWith("![", index) ? index + 2 : -1;
		if (labelStart === -1) {
			index++;
			continue;
		}
		const labelEnd = value.indexOf("]", labelStart);
		if (labelEnd === -1) break;
		if (value[labelEnd + 1] !== "(") {
			index = labelEnd + 1;
			continue;
		}
		const targetEnd = value.indexOf(")", labelEnd + 2);
		if (targetEnd === -1) break;
		labels.push(value.slice(start, index), value.slice(labelStart, labelEnd));
		index = targetEnd + 1;
		start = index;
	}
	labels.push(value.slice(start));
	const source = labels.join("");
	const angles: string[] = [];
	start = 0;
	index = 0;
	while (index < source.length) {
		const open = source.indexOf("<", index);
		if (open === -1) break;
		if (!source.startsWith("http://", open + 1) && !source.startsWith("https://", open + 1)) {
			index = open + 1;
			continue;
		}
		const close = source.indexOf(">", open + 1);
		if (close === -1) break;
		angles.push(source.slice(start, open), source.slice(open + 1, close));
		index = close + 1;
		start = index;
	}
	angles.push(source.slice(start));
	return angles.join("")
		.replace(/[`*_~]/g, "")
		.replace(/\\([\\`*{}\[\]()#+\-.!|>])/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

function atxHeading(line: string): { level: number; text: string } | null {
	let level = 0;
	while (line[level] === "#") level++;
	if (level === 0 || level > 6 || !/\s/.test(line[level] ?? "")) return null;
	let text = line.slice(level).trim();
	if (!text) return null;
	let end = text.length;
	while (text[end - 1] === "#") end--;
	if (end > 0 && end < text.length && /\s/.test(text[end - 1]!)) text = text.slice(0, end).trimEnd();
	return { level, text };
}

function pushWarning(acc: StructuredAccumulator, item: RetrievalWarning): void {
	if (acc.warningLimitIndex !== null) {
		acc.suppressedWarnings++;
		acc.warnings[acc.warningLimitIndex] = warning("warning-limit", `${acc.suppressedWarnings} additional extraction warnings were suppressed.`);
		return;
	}
	if (acc.warnings.length < MAX_WARNINGS - 1) {
		acc.warnings.push(item);
		return;
	}
	acc.suppressedWarnings = 1;
	acc.warningLimitIndex = acc.warnings.length;
	acc.warnings.push(warning("warning-limit", "1 additional extraction warning was suppressed."));
}

function takeItem(acc: StructuredAccumulator): boolean {
	if (acc.remaining > 0) {
		acc.remaining--;
		return true;
	}
	if (!acc.truncated) pushWarning(acc, warning("structured-item-limit", "Structured extraction reached the configured item limit."));
	acc.truncated = true;
	return false;
}

function* tableCells(line: string): Generator<string> {
	let source = line.trim();
	if (source.startsWith("|")) source = source.slice(1);
	if (source.endsWith("|")) source = source.slice(0, -1);
	let start = 0;
	for (let index = 0; index < source.length; index++) {
		if (source[index] === "\\") index++;
		else if (source[index] === "|") {
			yield source.slice(start, index).replace(/\\([\s\S])/g, "$1");
			start = index + 1;
		}
	}
	yield source.slice(start).replace(/\\([\s\S])/g, "$1");
}

function splitTableRow(line: string, acc: StructuredAccumulator): string[] {
	const cells: string[] = [];
	for (const cell of tableCells(line)) {
		if (cells.length >= MAX_TABLE_CELLS) {
			acc.truncated = true;
			pushWarning(acc, warning("table-cell-limit", `A table row exceeded the ${MAX_TABLE_CELLS}-cell limit.`));
			break;
		}
		if (!takeItem(acc)) break;
		cells.push(plainInline(cell));
	}
	return cells;
}

function isTableSeparator(line: string): boolean {
	for (const cell of tableCells(line)) {
		if (!/^:?-{3,}:?$/.test(cell.replace(/\s+/g, ""))) return false;
	}
	return true;
}

function scanInlineLinks(line: string, visit: (text: string, target: string) => void): void {
	const lastAngleClose = line.lastIndexOf(">");
	const lastDoubleQuote = line.lastIndexOf('"');
	const lastSingleQuote = line.lastIndexOf("'");
	let index = 0;
	while (index < line.length) {
		const ch = line[index];
		if (ch === "<" && (line.startsWith("http://", index + 1) || line.startsWith("https://", index + 1))) {
			const end = line.indexOf(">", index + 1);
			if (end === -1) break;
			const target = line.slice(index + 1, end);
			visit(target, target);
			index = end + 1;
			continue;
		}
		if (ch !== "[" || line[index - 1] === "!") {
			index++;
			continue;
		}
		const labelEnd = line.indexOf("]", index + 1);
		if (labelEnd === -1) break;
		if (line[labelEnd + 1] !== "(") {
			index = labelEnd + 1;
			continue;
		}
		let cursor = labelEnd + 2;
		while (cursor < line.length && /\s/.test(line[cursor] ?? "")) cursor++;
		let target = "";
		if (line[cursor] === "<") {
			if (lastAngleClose <= cursor) {
				index = cursor + 1;
				continue;
			}
			const targetEnd = line.indexOf(">", cursor + 1);
			target = line.slice(cursor + 1, targetEnd);
			cursor = targetEnd + 1;
		} else {
			const targetStart = cursor;
			while (cursor < line.length && !/[\s)]/.test(line[cursor] ?? "")) cursor++;
			target = line.slice(targetStart, cursor);
		}
		while (cursor < line.length && /\s/.test(line[cursor] ?? "")) cursor++;
		if (line[cursor] === '"' || line[cursor] === "'") {
			const quote = line[cursor++];
			const lastQuote = quote === '"' ? lastDoubleQuote : lastSingleQuote;
			if (lastQuote < cursor) {
				index = cursor;
				continue;
			}
			const titleEnd = line.indexOf(quote, cursor);
			cursor = titleEnd + 1;
			while (cursor < line.length && /\s/.test(line[cursor] ?? "")) cursor++;
		}
		if (!target || line[cursor] !== ")") {
			index = Math.max(cursor, labelEnd + 1);
			continue;
		}
		visit(line.slice(index + 1, labelEnd), target);
		index = cursor + 1;
	}
}

function jsonLdWithinLimits(value: unknown): boolean {
	const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	let nodes = 0;
	while (stack.length) {
		const current = stack.pop()!;
		if (++nodes > MAX_JSON_LD_NODES || current.depth > MAX_JSON_LD_DEPTH) return false;
		if (current.value === null || typeof current.value !== "object") continue;
		if (Array.isArray(current.value)) {
			if (nodes + current.value.length > MAX_JSON_LD_NODES) return false;
			for (let index = current.value.length - 1; index >= 0; index--) stack.push({ value: current.value[index], depth: current.depth + 1 });
			continue;
		}
		const values = Object.values(current.value as Record<string, unknown>);
		if (nodes + values.length > MAX_JSON_LD_NODES) return false;
		for (let index = values.length - 1; index >= 0; index--) stack.push({ value: values[index], depth: current.depth + 1 });
	}
	return true;
}

function scanMarkdown(content: string, baseUrl: string, acc: StructuredAccumulator): Pick<StructuredDocument, "title" | "headings" | "links" | "tables"> {
	const lines = content.split("\n");
	const headings: StructuredDocument["headings"] = [];
	const links: StructuredDocument["links"] = [];
	const tables: StructuredDocument["tables"] = [];
	const seenLinks = new Set<string>();
	let fence: { marker: "`" | "~"; length: number } | null = null;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fence) {
			if (fenceMatch?.[1]?.startsWith(fence.marker) && fenceMatch[1].length >= fence.length) fence = null;
			continue;
		}
		if (fenceMatch?.[1]) {
			fence = { marker: fenceMatch[1][0] as "`" | "~", length: fenceMatch[1].length };
			continue;
		}
		const atx = atxHeading(line);
		if (atx) {
			if (takeItem(acc)) headings.push({ level: atx.level as 1 | 2 | 3 | 4 | 5 | 6, text: plainInline(atx.text), line: index + 1 });
		} else if (index + 1 < lines.length && /^(?:=+|-+)\s*$/.test(lines[index + 1] ?? "") && line.trim()) {
			if (takeItem(acc)) headings.push({ level: (lines[index + 1] ?? "").trim().startsWith("=") ? 1 : 2, text: plainInline(line), line: index + 1 });
		}

		const scanLineLinks = (source: string) => scanInlineLinks(source, (text, target) => {
			const url = resolveLink(target, baseUrl);
			if (!url || seenLinks.has(url)) return;
			seenLinks.add(url);
			if (takeItem(acc)) links.push({ url, text: plainInline(text), relation: "content" });
		});
		scanLineLinks(line);

		if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1] ?? "")) {
			const includeTable = takeItem(acc);
			const headers = includeTable ? splitTableRow(line, acc) : [];
			const rows: string[][] = [];
			let cursor = index + 2;
			while (cursor < lines.length && (lines[cursor] ?? "").includes("|") && (lines[cursor] ?? "").trim()) {
				const row = lines[cursor] ?? "";
				scanLineLinks(row);
				if (includeTable && takeItem(acc)) rows.push(splitTableRow(row, acc));
				cursor++;
			}
			let caption: string | null = null;
			for (let previous = index - 1; previous >= 0 && index - previous <= 2; previous--) {
				const candidate = (lines[previous] ?? "").trim();
				if (!candidate) continue;
				const italic = /^\*([^*]+)\*$/.exec(candidate);
				if (italic) caption = plainInline(italic[1] ?? "");
				break;
			}
			if (includeTable) tables.push({ caption, headers, rows, line: index + 1 });
			index = cursor - 1;
		}
	}

	return { title: headings.find((heading) => heading.level === 1)?.text ?? titleFromUrl(baseUrl), headings, links, tables };
}

function appendMetadataLink(
	links: StructuredDocument["links"],
	seen: Set<string>,
	acc: StructuredAccumulator,
	input: { url: string | null | undefined; text: string; relation: "canonical" | "alternate" },
): void {
	if (!input.url || seen.has(`${input.relation}:${input.url}`)) return;
	seen.add(`${input.relation}:${input.url}`);
	if (takeItem(acc)) links.push({ url: input.url, text: input.text, relation: input.relation });
}

function emptyDocument(title: string): StructuredDocument {
	return {
		schemaVersion: 1,
		title,
		description: "",
		canonicalUrl: null,
		language: null,
		headings: [],
		links: [],
		tables: [],
		jsonLd: [],
	};
}

function kindFor(contentType: string, finalUrl: string): SnapshotKind {
	if (contentType === "text/html" || contentType === "application/xhtml+xml") return "html";
	if (contentType.includes("markdown") || /\.(?:md|markdown|mdx)$/i.test(new URL(finalUrl).pathname)) return "markdown";
	if (contentType.includes("json")) return "json";
	if (contentType === "application/pdf" || contentType === "application/x-pdf") return "pdf";
	return "text";
}

export function extractDeterministic(input: ExtractionInput): ExtractionOutput {
	const contentType = normalizedContentType(input.contentType);
	const kind = kindFor(contentType, input.finalUrl);
	const configuredLimit = input.maxStructuredItems ?? DEFAULT_MAX_STRUCTURED_ITEMS;
	const limit = Math.max(0, Math.min(HARD_MAX_STRUCTURED_ITEMS, Math.floor(configuredLimit)));
	const acc: StructuredAccumulator = {
		remaining: limit,
		truncated: configuredLimit > HARD_MAX_STRUCTURED_ITEMS,
		warnings: [],
		suppressedWarnings: 0,
		warningLimitIndex: null,
	};
	if (configuredLimit > HARD_MAX_STRUCTURED_ITEMS) {
		pushWarning(acc, warning("structured-item-hard-limit", `Structured item limit was capped at ${HARD_MAX_STRUCTURED_ITEMS}.`));
	}

	if (kind === "json") {
		const content = input.body;
		try {
			JSON.parse(content);
		} catch {
			pushWarning(acc, warning("invalid-json", "The response declared JSON but could not be parsed; the original text was retained."));
		}
		return {
			kind,
			contentType,
			content,
			structured: emptyDocument(titleFromUrl(input.finalUrl)),
			extractorVersion: DETERMINISTIC_EXTRACTOR_VERSION,
			truncated: acc.truncated,
			warnings: acc.warnings,
		};
	}

	if (kind !== "html") {
		const content = normalizeText(input.body);
		const scanned = scanMarkdown(content, input.finalUrl, acc);
		return {
			kind,
			contentType,
			content,
			structured: {
				schemaVersion: 1,
				title: scanned.title,
				description: "",
				canonicalUrl: null,
				language: null,
				headings: scanned.headings,
				links: scanned.links,
				tables: scanned.tables,
				jsonLd: [],
			},
			extractorVersion: DETERMINISTIC_EXTRACTOR_VERSION,
			truncated: acc.truncated,
			warnings: acc.warnings,
		};
	}

	const document = extractDocument(input.body, input.finalUrl);
	const content = normalizeText(document.markdown);
	const scanned = scanMarkdown(content, document.baseUrl ?? input.finalUrl, acc);
	const links = [...scanned.links];
	const seenMetadata = new Set<string>();
	appendMetadataLink(links, seenMetadata, acc, {
		url: document.canonicalUrl ?? null,
		text: document.title || scanned.title,
		relation: "canonical",
	});
	for (const alternate of findHtmlMarkdownAlternates(input.body, document.baseUrl ?? input.finalUrl)) {
		appendMetadataLink(links, seenMetadata, acc, { url: alternate.url, text: alternate.title || titleFromUrl(alternate.url), relation: "alternate" });
	}

	const jsonLd: unknown[] = [];
	let jsonLdBytes = 0;
	for (const token of tokenize(input.body)) {
		if (token.type !== "json-ld") continue;
		if (token.truncated) {
			acc.truncated = true;
			pushWarning(acc, warning("json-ld-size-limit", "An ld+json block exceeded the retention limit and was not parsed."));
			continue;
		}
		const tokenBytes = Buffer.byteLength(token.value, "utf8");
		if (tokenBytes > MAX_JSON_LD_BYTES - jsonLdBytes) {
			acc.truncated = true;
			pushWarning(acc, warning("json-ld-total-size-limit", "The retained ld+json data exceeded the total structured-data limit."));
			continue;
		}
		try {
			const value: unknown = JSON.parse(token.value);
			if (!jsonLdWithinLimits(value)) {
				acc.truncated = true;
				pushWarning(acc, warning("json-ld-complexity-limit", "An application/ld+json block exceeded the depth or node limit and was ignored."));
				continue;
			}
			if (takeItem(acc)) {
				jsonLd.push(value);
				jsonLdBytes += tokenBytes;
			}
		} catch {
			pushWarning(acc, warning("invalid-json-ld", "An application/ld+json block was invalid and was ignored."));
		}
	}

	return {
		kind,
		contentType,
		content,
		structured: {
			schemaVersion: 1,
			title: document.title || scanned.title,
			description: document.description,
			canonicalUrl: document.canonicalUrl ?? null,
			language: document.lang || null,
			headings: scanned.headings,
			links,
			tables: scanned.tables,
			jsonLd,
		},
		extractorVersion: DETERMINISTIC_EXTRACTOR_VERSION,
		truncated: acc.truncated,
		warnings: acc.warnings,
	};
}
