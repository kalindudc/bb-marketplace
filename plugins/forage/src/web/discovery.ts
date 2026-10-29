import type { DiscoveredUrl, OperationContext } from "./contracts.ts";
import { extractDocument } from "./html.ts";
import { parseRobots } from "./robots.ts";

const DEFAULT_MAX_URLS = 200;
const HARD_MAX_URLS = 5_000;
const DEFAULT_MAX_INDEX_DOCUMENTS = 16;
const HARD_MAX_INDEX_DOCUMENTS = 64;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const HARD_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 4;
const HARD_MAX_DEPTH = 8;

export interface DiscoveryRequest {
	rootUrl: string;
	sitemapUrl?: string;
	includePaths?: string[];
	excludePaths?: string[];
	includeSubdomains?: boolean;
	maxUrls?: number;
	maxIndexDocuments?: number;
	maxBytes?: number;
	maxDepth?: number;
	includeRootLinks?: boolean;
	signal: AbortSignal;
	operation?: OperationContext;
}

export interface DiscoveryFetchOptions {
	signal: AbortSignal;
	operation?: OperationContext;
	purpose: "robots" | "sitemap" | "llms" | "html-root";
	maxBytes: number;
}

export interface DiscoveryFetchResult {
	requestedUrl: string;
	finalUrl: string;
	status: number;
	contentType: string;
	content: string;
	bytes: number;
	error?: string;
}

export interface DiscoveryDependencies {
	fetch(url: string, options: DiscoveryFetchOptions): Promise<DiscoveryFetchResult>;
}

export interface DiscoveryResult {
	rootUrl: string;
	urls: DiscoveredUrl[];
	fetchedIndexes: number;
	bytes: number;
	truncated: boolean;
	warnings: string[];
}

interface Limits {
	maxUrls: number;
	maxIndexDocuments: number;
	maxBytes: number;
	maxDepth: number;
}

interface SitemapEntry {
	loc: string;
	lastModified: string | null;
}

function clamp(value: number | undefined, fallback: number, hardMax: number): number {
	return Math.max(0, Math.min(hardMax, Math.floor(value ?? fallback)));
}

function normalizeRoot(input: string): URL {
	const url = new URL(input);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Discovery root must use http or https");
	if (url.username || url.password) throw new Error("Discovery root must not contain embedded credentials");
	url.hash = "";
	return url;
}

function normalizeUrl(input: string, base: URL): URL | null {
	try {
		const url = new URL(input.trim(), base);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (url.username || url.password) return null;
		url.hash = "";
		return url;
	} catch {
		return null;
	}
}

function allowedHost(url: URL, root: URL, includeSubdomains: boolean): boolean {
	if (url.protocol !== root.protocol || url.port !== root.port) return false;
	const host = url.hostname.toLowerCase();
	const rootHost = root.hostname.toLowerCase();
	return host === rootHost || (includeSubdomains && host.endsWith(`.${rootHost}`));
}

function allowedPath(url: URL, includePaths: readonly string[], excludePaths: readonly string[]): boolean {
	if (includePaths.length && !includePaths.some((prefix) => url.pathname.startsWith(prefix))) return false;
	return !excludePaths.some((prefix) => url.pathname.startsWith(prefix));
}

function decodeXml(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
		if (entity[0] === "#") {
			const hex = entity[1]?.toLowerCase() === "x";
			const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
			if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return "\ufffd";
			return String.fromCodePoint(codePoint);
		}
		return entity.toLowerCase() === "amp" ? "&"
			: entity.toLowerCase() === "lt" ? "<"
				: entity.toLowerCase() === "gt" ? ">"
					: entity.toLowerCase() === "quot" ? '"'
						: entity.toLowerCase() === "apos" ? "'"
							: match;
	});
}

function asciiLower(value: string): string {
	return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function stripXmlComments(content: string): string {
	const parts: string[] = [];
	let cursor = 0;
	while (cursor < content.length) {
		const start = content.indexOf("<!--", cursor);
		if (start === -1) {
			parts.push(content.slice(cursor));
			break;
		}
		parts.push(content.slice(cursor, start));
		const end = content.indexOf("-->", start + 4);
		if (end === -1) break;
		cursor = end + 3;
	}
	return parts.join("");
}

function startTag(lower: string, name: string, from: number): number {
	const needle = `<${name}`;
	let cursor = from;
	while (cursor < lower.length) {
		const found = lower.indexOf(needle, cursor);
		if (found === -1) return -1;
		const boundary = lower[found + needle.length] ?? "";
		if (boundary === ">" || boundary === "/" || /\s/.test(boundary)) return found;
		cursor = found + 1;
	}
	return -1;
}

function closingTag(lower: string, name: string, from: number): { start: number; end: number } | null {
	const needle = `</${name}`;
	let cursor = from;
	while (cursor < lower.length) {
		const found = lower.indexOf(needle, cursor);
		if (found === -1) return null;
		const boundary = lower[found + needle.length] ?? "";
		if (boundary === ">" || /\s/.test(boundary)) {
			const end = lower.indexOf(">", found + needle.length);
			return end === -1 ? null : { start: found, end: end + 1 };
		}
		cursor = found + 1;
	}
	return null;
}

function tagValue(block: string, name: string): string | null {
	const lower = asciiLower(block);
	const open = startTag(lower, name, 0);
	if (open === -1) return null;
	const openEnd = block.indexOf(">", open);
	if (openEnd === -1) return null;
	const close = closingTag(lower, name, openEnd + 1);
	if (!close) return null;
	let value = block.slice(openEnd + 1, close.start).trim();
	if (value.startsWith("<![CDATA[") && value.endsWith("]]>")) value = value.slice(9, -3);
	return value ? decodeXml(value.trim()) : null;
}

function parseSitemap(content: string): { kind: "index" | "urlset" | "invalid"; entries: Iterable<SitemapEntry>; warning?: string } {
	const source = stripXmlComments(content);
	if (/<!DOCTYPE|<!ENTITY/i.test(source)) return { kind: "invalid", entries: [], warning: "Rejected sitemap containing a DTD or external entity declaration." };
	const lower = asciiLower(source);
	const indexStart = startTag(lower, "sitemapindex", 0);
	const urlsetStart = startTag(lower, "urlset", 0);
	const kind = indexStart !== -1 && (urlsetStart === -1 || indexStart < urlsetStart) ? "index" : urlsetStart !== -1 ? "urlset" : null;
	if (!kind) return { kind: "invalid", entries: [], warning: "Sitemap document was not a sitemap index or URL set." };
	const rootName = kind === "index" ? "sitemapindex" : "urlset";
	const rootStart = kind === "index" ? indexStart : urlsetStart;
	const rootOpenEnd = source.indexOf(">", rootStart);
	const rootClose = rootOpenEnd === -1 ? null : closingTag(lower, rootName, rootOpenEnd + 1);
	if (rootOpenEnd === -1 || !rootClose) return { kind: "invalid", entries: [], warning: "Sitemap XML was malformed or incomplete." };

	const element = kind === "index" ? "sitemap" : "url";
	const rootEnd = rootClose.start;
	function* entries(): Generator<SitemapEntry> {
		let cursor = rootOpenEnd + 1;
		while (cursor < rootEnd) {
			const open = startTag(lower, element, cursor);
			if (open === -1 || open >= rootEnd) break;
			const openEnd = source.indexOf(">", open);
			if (openEnd === -1 || openEnd >= rootEnd) break;
			const close = closingTag(lower, element, openEnd + 1);
			if (!close || close.start > rootEnd) break;
			const block = source.slice(openEnd + 1, close.start);
			const loc = tagValue(block, "loc");
			if (loc) yield { loc, lastModified: tagValue(block, "lastmod") };
			cursor = close.end;
		}
	}
	return { kind, entries: entries() };
}

function markdownLinks(content: string, base: URL): Array<{ url: URL; title: string }> {
	const links: Array<{ url: URL; title: string }> = [];
	const seen = new Set<string>();
	const lastAngleClose = content.lastIndexOf(">");
	const lastDoubleQuote = content.lastIndexOf('"');
	const lastSingleQuote = content.lastIndexOf("'");
	let index = 0;
	while (index < content.length) {
		const open = content.indexOf("[", index);
		if (open === -1) break;
		if (content[open - 1] === "!") {
			index = open + 1;
			continue;
		}
		const labelEnd = content.indexOf("]", open + 1);
		if (labelEnd === -1) break;
		if (content[labelEnd + 1] !== "(") {
			index = labelEnd + 1;
			continue;
		}
		let cursor = labelEnd + 2;
		while (cursor < content.length && /\s/.test(content[cursor] ?? "")) cursor++;
		let target = "";
		if (content[cursor] === "<") {
			if (lastAngleClose <= cursor) {
				index = cursor + 1;
				continue;
			}
			const end = content.indexOf(">", cursor + 1);
			target = content.slice(cursor + 1, end);
			cursor = end + 1;
		} else {
			const targetStart = cursor;
			while (cursor < content.length && !/[\s)]/.test(content[cursor] ?? "")) cursor++;
			target = content.slice(targetStart, cursor);
		}
		while (cursor < content.length && /\s/.test(content[cursor] ?? "")) cursor++;
		if (content[cursor] === '"' || content[cursor] === "'") {
			const quote = content[cursor++];
			const lastQuote = quote === '"' ? lastDoubleQuote : lastSingleQuote;
			if (lastQuote < cursor) {
				index = cursor;
				continue;
			}
			const titleEnd = content.indexOf(quote, cursor);
			cursor = titleEnd + 1;
			while (cursor < content.length && /\s/.test(content[cursor] ?? "")) cursor++;
		}
		if (!target || content[cursor] !== ")") {
			index = Math.max(cursor, labelEnd + 1);
			continue;
		}
		const url = normalizeUrl(target, base);
		if (url && !seen.has(url.href)) {
			seen.add(url.href);
			links.push({ url, title: content.slice(open + 1, labelEnd).replace(/[`*_~]/g, "").trim() });
		}
		index = cursor + 1;
	}
	return links;
}

export async function discoverSite(request: DiscoveryRequest, deps: DiscoveryDependencies): Promise<DiscoveryResult> {
	const root = normalizeRoot(request.rootUrl);
	const includePaths = (request.includePaths ?? []).slice(0, 50);
	const excludePaths = (request.excludePaths ?? []).slice(0, 50);
	const includeSubdomains = request.includeSubdomains ?? false;
	const limits: Limits = {
		maxUrls: clamp(request.maxUrls, DEFAULT_MAX_URLS, HARD_MAX_URLS),
		maxIndexDocuments: clamp(request.maxIndexDocuments, DEFAULT_MAX_INDEX_DOCUMENTS, HARD_MAX_INDEX_DOCUMENTS),
		maxBytes: clamp(request.maxBytes, DEFAULT_MAX_BYTES, HARD_MAX_BYTES),
		maxDepth: clamp(request.maxDepth, DEFAULT_MAX_DEPTH, HARD_MAX_DEPTH),
	};
	const result: DiscoveryResult = { rootUrl: root.href, urls: [], fetchedIndexes: 0, bytes: 0, truncated: false, warnings: [] };
	const seenUrls = new Set<string>();
	const fetchedDocuments = new Set<string>();
	let attemptedDocuments = 0;
	let stopped = false;

	const checkActive = (stage: string) => {
		request.operation?.deadline.throwIfExpired(stage);
		if (request.signal.aborted) throw request.signal.reason instanceof Error ? request.signal.reason : new Error(`${stage} cancelled`);
	};
	const stop = (message: string) => {
		result.truncated = true;
		if (!result.warnings.includes(message)) result.warnings.push(message);
		stopped = true;
	};
	const fetchDocument = async (url: URL, purpose: DiscoveryFetchOptions["purpose"]): Promise<DiscoveryFetchResult | null> => {
		checkActive(`discovery ${purpose}`);
		if (stopped) return null;
		if (!allowedHost(url, root, includeSubdomains)) return null;
		if (fetchedDocuments.has(url.href)) return null;
		if (attemptedDocuments >= limits.maxIndexDocuments) {
			stop(`Discovery document limit reached (${limits.maxIndexDocuments}).`);
			return null;
		}
		attemptedDocuments++;
		fetchedDocuments.add(url.href);
		let fetched: DiscoveryFetchResult;
		try {
			fetched = await deps.fetch(url.href, {
				signal: request.signal,
				operation: request.operation,
				purpose,
				maxBytes: Math.max(0, limits.maxBytes - result.bytes),
			});
		} catch (error) {
			if (request.signal.aborted || request.operation?.deadline.remainingMs() === 0) throw error;
			if (error instanceof Error && error.name === "ByteBudgetError") {
				stop(`Discovery shared byte budget was exhausted while fetching ${url.href}.`);
				return null;
			}
			result.warnings.push(`Failed to fetch ${url.href}: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
		const expandedBytes = Buffer.byteLength(fetched.content, "utf8");
		const accountedBytes = Math.max(expandedBytes, Math.max(0, fetched.bytes));
		if (accountedBytes > limits.maxBytes - result.bytes) {
			stop(`Discovery expanded byte limit reached (${limits.maxBytes} bytes).`);
			return null;
		}
		result.bytes += accountedBytes;
		if (fetched.status < 200 || fetched.status >= 300 || fetched.error) return null;
		const finalUrl = normalizeUrl(fetched.finalUrl, url);
		if (!finalUrl || !allowedHost(finalUrl, root, includeSubdomains)) {
			result.warnings.push(`The final URL for ${url.href} was outside the permitted site boundary and was ignored.`);
			return null;
		}
		result.fetchedIndexes++;
		return { ...fetched, finalUrl: finalUrl.href };
	};
	const addUrl = (input: string, method: DiscoveredUrl["method"], parentUrl: string, title: string | null, lastModified: string | null) => {
		if (stopped) return;
		const url = normalizeUrl(input, new URL(parentUrl));
		if (!url || !allowedHost(url, root, includeSubdomains) || !allowedPath(url, includePaths, excludePaths)) return;
		if (seenUrls.has(url.href)) return;
		if (result.urls.length >= limits.maxUrls) {
			stop(`Discovery URL limit reached (${limits.maxUrls}).`);
			return;
		}
		seenUrls.add(url.href);
		result.urls.push({ url: url.href, method, parentUrl, title, lastModified });
	};
	const processSitemaps = async (seeds: Array<{ url: URL; method: "robots" | "sitemap" | "sitemap-index" }>) => {
		const queue: Array<{ url: URL; method: "robots" | "sitemap" | "sitemap-index"; depth: number; ancestors: Set<string> }> = [];
		const queued = new Set<string>();
		const documentLimit = () => {
			result.truncated = true;
			const message = `Discovery document limit reached (${limits.maxIndexDocuments}); additional sitemap references were omitted.`;
			if (!result.warnings.includes(message)) result.warnings.push(message);
		};
		for (const seed of seeds) {
			if (fetchedDocuments.has(seed.url.href) || queued.has(seed.url.href)) continue;
			if (queue.length >= limits.maxIndexDocuments - attemptedDocuments) {
				documentLimit();
				break;
			}
			queued.add(seed.url.href);
			queue.push({ ...seed, depth: 0, ancestors: new Set<string>() });
		}
		for (let cursor = 0; cursor < queue.length && !stopped; cursor++) {
			const current = queue[cursor]!;
			const fetched = await fetchDocument(current.url, "sitemap");
			if (!fetched) continue;
			const parsed = parseSitemap(fetched.content);
			if (parsed.warning) result.warnings.push(`${current.url.href}: ${parsed.warning}`);
			if (parsed.kind === "invalid") result.truncated = true;
			if (parsed.kind === "index") {
				if (current.depth >= limits.maxDepth) {
					stop(`Sitemap nesting depth limit reached (${limits.maxDepth}).`);
					continue;
				}
				const base = new URL(fetched.finalUrl);
				for (const entry of parsed.entries) {
					const nested = normalizeUrl(entry.loc, base);
					if (!nested || !allowedHost(nested, root, includeSubdomains)) continue;
					if (nested.href === current.url.href || current.ancestors.has(nested.href)) {
						result.truncated = true;
						result.warnings.push(`Cyclic sitemap index reference ignored: ${current.url.href} -> ${nested.href}.`);
						continue;
					}
					if (queued.has(nested.href) || fetchedDocuments.has(nested.href)) continue;
					if (queue.length - cursor - 1 >= limits.maxIndexDocuments - attemptedDocuments) {
						documentLimit();
						break;
					}
					queued.add(nested.href);
					queue.push({
						url: nested,
						depth: current.depth + 1,
						method: current.method === "robots" ? "robots" : "sitemap-index",
						ancestors: new Set([...current.ancestors, current.url.href]),
					});
				}
			} else if (parsed.kind === "urlset") {
				for (const entry of parsed.entries) {
					addUrl(entry.loc, current.method, fetched.finalUrl, null, entry.lastModified);
					if (stopped) break;
				}
			}
		}
	};

	const explicit = request.sitemapUrl ? normalizeUrl(request.sitemapUrl, root) : null;
	if (request.sitemapUrl && (!explicit || !allowedHost(explicit, root, includeSubdomains))) {
		result.warnings.push("The supplied sitemap URL was outside the permitted site boundary and was not fetched.");
	}
	if (explicit && allowedHost(explicit, root, includeSubdomains)) await processSitemaps([{ url: explicit, method: "sitemap" }]);

	if (!stopped) {
		const robotsUrl = new URL("/robots.txt", root);
		const robots = await fetchDocument(robotsUrl, "robots");
		if (robots) {
			const parsed = parseRobots(robots.content, robots.finalUrl);
			if (parsed.truncated) result.warnings.push(`${robots.finalUrl}: robots.txt was truncated while parsing.`);
			const seeds = parsed.sitemaps
				.map((url) => normalizeUrl(url, root))
				.filter((url): url is URL => Boolean(url && allowedHost(url, root, includeSubdomains)))
				.map((url) => ({ url, method: "robots" as const }));
			await processSitemaps(seeds);
		}
	}

	if (!stopped) {
		const conventional = [new URL("/sitemap.xml", root), new URL("/sitemap_index.xml", root)]
			.map((url) => ({ url, method: "sitemap" as const }));
		await processSitemaps(conventional);
	}

	if (!stopped) {
		for (const path of ["/llms.txt", "/llms-full.txt"]) {
			const indexUrl = new URL(path, root);
			const fetched = await fetchDocument(indexUrl, "llms");
			if (!fetched) continue;
			for (const link of markdownLinks(fetched.content, new URL(fetched.finalUrl))) {
				addUrl(link.url.href, "llms", fetched.finalUrl, link.title || null, null);
			}
		}
	}

	if (!stopped && result.urls.length === 0 && (request.includeRootLinks ?? true)) {
		const fetched = await fetchDocument(root, "html-root");
		if (fetched) {
			const markdown = extractDocument(fetched.content, fetched.finalUrl).markdown;
			for (const link of markdownLinks(markdown, new URL(fetched.finalUrl))) {
				addUrl(link.url.href, "html-link", fetched.finalUrl, link.title || null, null);
			}
		}
	}

	return result;
}
