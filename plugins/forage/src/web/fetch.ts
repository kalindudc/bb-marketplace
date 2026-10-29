/**
 * URL → readable content pipeline.
 *
 *   normalize → GitHub rewrites → SSRF-guarded fetch → dispatch by content type
 *     html      → markdown (main-content selection)
 *     json      → pretty-printed text
 *     text/*    → as-is
 *     pdf       → text via `pdftotext` when installed (poppler); no npm deps
 *
 * Direct results are cached in memory. URL-only continuation may download again
 * after expiry; persisted snapshot IDs provide immutable no-network paging.
 */

import { createHash } from "node:crypto";
import type { AccessDescriptor, ByteBudget, Deadline, OperationContext, RetrievalArtifact, RetrievalAttempt, RetrievalWarning, StructuredDocument } from "./contracts.ts";
import { sourceScopeKey } from "./contracts.ts";
import type { ReaderProviderName, WebConfig } from "./config.ts";
import { resolvePolicy, type SearchProfileName } from "../profiles.ts";
import { readWithRemoteReader } from "./readers/index.ts";
import { assertRemoteForwardableUrl } from "./readers/policy.ts";
import type { ProviderTransport } from "./providers/http.ts";
import { extractDeterministic } from "./extract.ts";
import { ByteBudgetError, createByteBudget, createDeadline, DeadlineError } from "./deadline.ts";
import { collectGithubCollection, formatGithubIssueDocument, type GithubComment, type GithubIssue, type GithubReview, type GithubReviewComment } from "./github.ts";
import { extractDocument, findHtmlMarkdownAlternates, quickTitle } from "./html.ts";
import { BoundedProcessTimeoutError, runBoundedProcess, runRegexPassages } from "./isolate.ts";
import { NetError, decodeText, formatBytes, mergeNetworkAccess, mimeType, readBodyLimited, safeFetch, type NetErrorKind, type Resolver, type SafeFetchOptions } from "./net.ts";

export type FetchMode = "readable" | "raw";
export type FetchResolution = "auto" | "direct" | "smart";
export type ContentKind = "html" | "markdown" | "text" | "json" | "pdf" | "github-api" | "error";

export interface FetchedContent {
	/** URL as requested (after normalization). */
	url: string;
	/** URL actually fetched after rewrites and redirects. */
	finalUrl: string;
	title: string;
	/** Full extracted content. */
	content: string;
	kind: ContentKind;
	contentType: string;
	status: number;
	bytes: number;
	durationMs: number;
	redirects: number;
	cached: boolean;
	description?: string;
	/** Which HTML root was used ("main", "article", "body", ...). */
	contentRoot?: string;
	/** Original URL when a rewrite happened (e.g. GitHub blob → raw). */
	rewrittenFrom?: string;
	warning?: string;
	error?: string;
	errorCode?: NetErrorKind;
	access?: AccessDescriptor;
	contentHash?: string;
	artifact?: RetrievalArtifact;
	fetchedAt?: string;
	checkedAt?: string;
	cache?: "miss" | "hit" | "revalidated";
	attempt?: RetrievalAttempt;
	acceptedBytes?: number;
	cacheControl?: string;
	etag?: string;
	lastModified?: string;
	completeness?: RetrievalArtifact["completeness"];
	structured?: StructuredDocument;
	warnings?: RetrievalWarning[];
	alternate?: {
		source: "content-negotiation" | "http-link" | "html-link";
		url: string;
		contentType: string;
	};
}

export interface FetchOptions {
	mode: FetchMode;
	reader?: ReaderProviderName;
	profile?: SearchProfileName;
	resolve?: FetchResolution;
	signal?: AbortSignal;
	config: WebConfig;
	/** Bypass and refresh the cache. */
	noCache?: boolean;
	deadline?: Deadline;
	operation?: OperationContext;
	byteBudget?: ByteBudget;
	requestScopeKey?: string | null;
	credentialed?: boolean;
	allowedRedirectOrigins?: readonly string[];
	beforeRedirect?: SafeFetchOptions["beforeRedirect"];
}

// ---------------------------------------------------------------------------
// URL normalization & rewrites
// ---------------------------------------------------------------------------

/**
 * Normalize user/model-supplied URLs: trim, strip <>, add https:// when the
 * scheme is missing, drop the fragment. A leading `name:` is only treated as a
 * scheme when it is not followed by a port number, so `example.com:8080/x`
 * and `localhost:3000` get `https://` prepended instead of being rejected.
 */
export function normalizeUrl(input: string): string {
	let raw = input.trim().replace(/^<|>$/g, "");
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
		if (/^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(raw)) {
			throw new NetError(`Unsupported URL scheme in "${input}" (only http/https are allowed)`, "blocked");
		}
		raw = `https://${raw}`;
	}
	const url = new URL(raw);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new NetError(`Unsupported URL scheme "${url.protocol}" in "${input}" (only http/https are allowed)`, "blocked");
	}
	url.hash = "";
	return url.href;
}

/** First path segments on github.com that are not user/org names. */
const GITHUB_RESERVED = new Set([
	"about", "apps", "codespaces", "collections", "customer-stories", "enterprise", "events", "explore", "features", "issues",
	"login", "marketplace", "new", "notifications", "organizations", "orgs", "pricing", "pulls", "search", "security",
	"settings", "site", "sponsors", "team", "topics", "trending", "users",
]);

export interface Rewrite {
	url: string;
	kind: "github-raw" | "github-readme" | "github-tree" | "github-issue" | "none";
	/** Fallback URL (usually the original HTML page) if the rewritten target fails. */
	fallback?: string;
	meta?: Record<string, string>;
}

/** Rewrite well-known URL shapes into lighter, text-first equivalents. */
export function rewriteUrl(href: string): Rewrite {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return { url: href, kind: "none" };
	}
	const host = url.hostname.toLowerCase().replace(/^www\./, "");
	if (host !== "github.com") return { url: href, kind: "none" };

	// Segments are already percent-encoded by the URL parser; pass them through untouched.
	const parts = url.pathname.split("/").filter(Boolean);
	const [owner, repo, section, ...rest] = parts;
	if (!owner || !repo || owner.startsWith("-") || GITHUB_RESERVED.has(owner.toLowerCase())) return { url: href, kind: "none" };
	const encode = (s: string) => s;

	if (parts.length === 2) {
		return {
			url: `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`,
			kind: "github-readme",
			fallback: href,
			meta: { owner, repo },
		};
	}
	if ((section === "blob" || section === "raw") && rest.length >= 2) {
		const [ref, ...path] = rest;
		return {
			url: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${encode(path.join("/"))}`,
			kind: "github-raw",
			fallback: href,
		};
	}
	if (section === "tree" && rest.length >= 1) {
		const [ref, ...path] = rest;
		const api = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${encode(path.join("/"))}`);
		api.searchParams.set("ref", safeDecode(ref!));
		return { url: api.href, kind: "github-tree", fallback: href, meta: { owner, repo, ref: safeDecode(ref!), path: safeDecode(path.join("/")) } };
	}
	if ((section === "issues" || section === "pull") && /^\d+$/.test(rest[0] ?? "")) {
		return {
			url: `https://api.github.com/repos/${owner}/${repo}/${section === "pull" ? "pulls" : "issues"}/${rest[0]}`,
			kind: "github-issue",
			fallback: href,
			meta: { owner, repo, number: rest[0]!, type: section },
		};
	}
	return { url: href, kind: "none" };
}

export function resolveFetchTarget(href: string, mode: FetchMode, requested: FetchResolution = "auto"): {
	target: string;
	rewrite?: Rewrite;
	resolution: Exclude<FetchResolution, "auto">;
} {
	const smart = requested === "smart" || (requested === "auto" && mode === "readable");
	if (!smart) return { target: href, rewrite: undefined, resolution: "direct" };
	const rewrite = rewriteUrl(href);
	if (rewrite.kind === "none") return { target: href, rewrite: undefined, resolution: "direct" };
	return { target: rewrite.url, rewrite, resolution: "smart" };
}

/** decodeURIComponent that tolerates malformed %-escapes (returns the input unchanged). */
function safeDecode(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

export function hasGithubCredential(): boolean {
	return Boolean(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN);
}

function githubHeaders(config: WebConfig): Record<string, string> {
	const headers: Record<string, string> = {
		"User-Agent": config.userAgent,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_BYTES = 48 * 1024 * 1024;
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_STALE_MS = 60 * 60 * 1000;

interface CacheEntry {
	value: FetchedContent;
	at: number;
	expiresAt: number;
	size: number;
	key: string;
}

export interface CacheAccessContext {
	allowPrivateNetwork?: boolean;
	credentialed?: boolean;
	requestScopeKey?: string | null;
}

const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;

function cacheNamespace(access: AccessDescriptor, restrictedResponse = false): string | null {
	if (access.network === "public" && !access.credentialed && !restrictedResponse) return "public";
	if (!access.requestScopeKey) return null;
	return `restricted:${access.requestScopeKey}:${access.network}:${access.credentialed ? 1 : 0}`;
}

function cacheKey(url: string, mode: FetchMode, resolution: FetchResolution, namespace: string): string {
	return `${mode}:${resolution}:${url}:${namespace}`;
}

function cacheCandidates(url: string, mode: FetchMode, resolution: FetchResolution, context: CacheAccessContext): string[] {
	const scope = context.requestScopeKey ?? null;
	if (context.credentialed) {
		if (!scope) return [];
		return [
			cacheKey(url, mode, resolution, `restricted:${scope}:public:1`),
			...(context.allowPrivateNetwork ? [cacheKey(url, mode, resolution, `restricted:${scope}:private:1`)] : []),
		];
	}
	return [
		cacheKey(url, mode, resolution, "public"),
		...(scope ? [cacheKey(url, mode, resolution, `restricted:${scope}:public:0`)] : []),
		...(scope && context.allowPrivateNetwork ? [cacheKey(url, mode, resolution, `restricted:${scope}:private:0`)] : []),
	];
}

function cacheDelete(key: string): void {
	const entry = cache.get(key);
	if (!entry) return;
	cache.delete(key);
	cacheBytes -= entry.size;
}

function cacheLookup(url: string, mode: FetchMode, resolution: FetchResolution, context: CacheAccessContext): CacheEntry | undefined {
	const now = Date.now();
	for (const key of cacheCandidates(url, mode, resolution, context)) {
		const entry = cache.get(key);
		if (!entry) continue;
		if (now - entry.at > CACHE_MAX_STALE_MS) {
			cacheDelete(key);
			continue;
		}
		cache.delete(key);
		cache.set(key, entry);
		return entry;
	}
	return undefined;
}

export function cacheGet(url: string, mode: FetchMode, context: CacheAccessContext = {}, resolution: FetchResolution = "auto"): FetchedContent | undefined {
	const entry = cacheLookup(url, mode, resolution, context);
	return entry && entry.expiresAt > Date.now() ? entry.value : undefined;
}

function cacheMaxAge(cacheControl: string | undefined): number {
	if (/(?:^|,)\s*no-cache\b/i.test(cacheControl ?? "")) return 0;
	const match = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cacheControl ?? "");
	return match ? Math.min(CACHE_MAX_STALE_MS, Number(match[1]) * 1000) : CACHE_TTL_MS;
}

export function cacheSet(url: string, mode: FetchMode, value: FetchedContent, resolution: FetchResolution = "auto"): void {
	if ((value.error && !value.content) || !value.access) return;
	const completeness = value.artifact?.completeness.state ?? value.completeness?.state;
	if (completeness && completeness !== "complete") return;
	const cacheControl = value.cacheControl ?? "";
	const restrictedResponse = /(?:^|,)\s*private\b/i.test(cacheControl);
	const namespace = cacheNamespace(value.access, restrictedResponse);
	if (!namespace) return;
	const key = cacheKey(url, mode, resolution, namespace);
	if (/(?:^|,)\s*no-store\b/i.test(cacheControl)) {
		cacheDelete(key);
		return;
	}
	const size = value.content.length * 2 + 1024;
	cacheDelete(key);
	const at = Date.now();
	cache.set(key, { value, at, expiresAt: at + cacheMaxAge(cacheControl), size, key });
	cacheBytes += size;
	while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cacheDelete(oldest);
	}
}

export function cacheStats(): { entries: number; bytes: number } {
	return { entries: cache.size, bytes: cacheBytes };
}

export function cacheClear(): void {
	cache.clear();
	cacheBytes = 0;
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

function looksLikeText(bytes: Uint8Array): boolean {
	const sample = bytes.subarray(0, Math.min(bytes.length, 2048));
	let suspicious = 0;
	for (const b of sample) {
		if (b === 0) return false;
		if (b < 7 || (b > 14 && b < 32)) suspicious++;
	}
	return suspicious < sample.length * 0.05;
}

function looksLikeHtml(text: string): boolean {
	return /^\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(text.slice(0, 1024));
}

function isPdf(bytes: Uint8Array, contentType: string, url: string): boolean {
	if (contentType === "application/pdf" || contentType === "application/x-pdf") return true;
	if (/\.pdf($|[?#])/i.test(url) && bytes.length > 4) {
		return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
	}
	return false;
}

function titleFromText(text: string, url: string): string {
	const heading = /^#{1,2}\s+(.+)$/m.exec(text);
	if (heading?.[1]) return heading[1].replace(/[*_`]/g, "").trim();
	try {
		const { pathname, hostname } = new URL(url);
		const last = pathname.split("/").filter(Boolean).pop();
		return last ? safeDecode(last) : hostname;
	} catch {
		return url;
	}
}

function combinedCacheControl(primary: string | undefined, alternate: string | undefined): string | undefined {
	const restrictive = (primary ?? "")
		.split(",")
		.map((directive) => directive.trim())
		.filter((directive) => /^(?:no-store|no-cache|private)(?:\s*=|$)/i.test(directive));
	const combined = [alternate, ...restrictive].filter((value): value is string => Boolean(value));
	return combined.length ? combined.join(", ") : undefined;
}

interface MarkdownAlternateCandidate {
	source: "http-link" | "html-link";
	url: string;
}

function isMarkdownMime(contentType: string): boolean {
	return /^(?:text|application)\/markdown$/i.test(contentType);
}

function httpMarkdownAlternates(header: string | null, baseUrl: string): MarkdownAlternateCandidate[] {
	if (!header) return [];
	const candidates: MarkdownAlternateCandidate[] = [];
	const seen = new Set<string>();
	for (const part of header.split(/,(?=\s*<)/)) {
		const target = /^\s*<([^>]+)>/.exec(part)?.[1];
		if (!target) continue;
		const rel = /;\s*rel\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(part);
		const type = /;\s*type\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(part);
		const relations = (rel?.[1] ?? rel?.[2] ?? rel?.[3] ?? "").toLowerCase().split(/\s+/);
		const mediaType = mimeType(type?.[1] ?? type?.[2] ?? type?.[3] ?? "");
		if (!relations.includes("alternate") || !isMarkdownMime(mediaType)) continue;
		try {
			const url = new URL(target, baseUrl);
			if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) continue;
			url.hash = "";
			if (seen.has(url.href)) continue;
			seen.add(url.href);
			candidates.push({ source: "http-link", url: url.href });
			if (candidates.length >= 8) break;
		} catch {
			continue;
		}
	}
	return candidates;
}

export async function pdfToText(bytes: Uint8Array, signal?: AbortSignal, timeoutMs = 30_000, maxOutputBytes = 16 * 1024 * 1024): Promise<string> {
	try {
		const result = await runBoundedProcess("pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], {
			timeoutMs,
			maxStdoutBytes: maxOutputBytes,
			maxStderrBytes: 64 * 1024,
			signal,
			stdin: bytes,
		});
		if (signal?.aborted) throw new NetError("Request cancelled", "aborted");
		if (result.code !== 0 && result.stdout.byteLength === 0) {
			throw new Error(`pdftotext exited with code ${result.code}: ${new TextDecoder().decode(result.stderr).trim().slice(0, 300)}`);
		}
		return new TextDecoder().decode(result.stdout).replace(/\f/g, "\n\n---\n\n").replace(/[ \t]+\n/g, "\n").trim();
	} catch (error) {
		if (error instanceof Error && error.message === "Executable not found: pdftotext") {
			throw new Error("PDF extraction requires `pdftotext` (poppler). Install with `brew install poppler` or `apt install poppler-utils`.");
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------
// GitHub API formatters
// ---------------------------------------------------------------------------

interface GhContentEntry {
	name: string;
	path: string;
	type: "file" | "dir" | "symlink" | "submodule";
	size: number;
	html_url?: string;
}

function formatGithubTree(payload: unknown, meta: Record<string, string>): { title: string; content: string } {
	const entries = Array.isArray(payload) ? (payload as GhContentEntry[]) : [payload as GhContentEntry];
	const title = `${meta.owner}/${meta.repo}${meta.path ? `/${meta.path}` : ""} @ ${meta.ref}`;
	const sorted = [...entries].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
	const lines = sorted.map((e) => {
		const icon = e.type === "dir" ? "📁" : e.type === "submodule" ? "🔗" : "📄";
		const size = e.type === "file" ? ` (${formatBytes(e.size)})` : "";
		const link = e.type === "dir"
			? `https://github.com/${meta.owner}/${meta.repo}/tree/${meta.ref}/${e.path}`
			: `https://github.com/${meta.owner}/${meta.repo}/blob/${meta.ref}/${e.path}`;
		return `- ${icon} [${e.name}](${link})${size}`;
	});
	return { title, content: `# ${title}\n\n${lines.join("\n")}\n\n_${entries.length} entries. Fetch a file with its blob URL to read it._` };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function githubHasNextPage(link: string | null): boolean {
	return Boolean(link?.split(",").some((part) => /rel="next"/.test(part)));
}

async function fetchGithubApi(rewrite: Rewrite, options: FetchOptions, startedAt: number, requestedUrl: string): Promise<FetchedContent | null> {
	const { config, signal } = options;
	const headers = githubHeaders(config);
	const deadline = requestDeadline(options);
	if (!deadline) throw new Error("GitHub smart resolution requires a request deadline");
	const byteBudget = requestBudget(options);
	const requestScope = requestScopeKey(options);
	const fetchJsonPage = async <T>(url: string): Promise<{ items: T[]; hasNext: boolean; acceptedBytes: number }> => {
		const fetched = await safeFetch(url, {
			signal,
			timeoutMs: config.timeoutMs,
			maxBytes: config.maxResponseBytes,
			headers,
			deadline,
			byteBudget,
			credentialed: options.credentialed,
			requestScopeKey: requestScope,
			allowedRedirectOrigins: options.allowedRedirectOrigins,
			beforeRedirect: options.beforeRedirect,
		});
		const pageBytes = await readBodyLimited(fetched.response, config.maxResponseBytes, signal, byteBudget);
		const acceptedBytes = fetched.acceptedRedirectBytes + pageBytes.byteLength;
		if (fetched.response.status !== 200) throw new Error(`HTTP ${fetched.response.status} on page ${new URL(url).searchParams.get("page") ?? "1"}`);
		const payload: unknown = JSON.parse(new TextDecoder().decode(pageBytes));
		if (!Array.isArray(payload)) throw new Error("GitHub collection response was not an array");
		return { items: payload as T[], hasNext: githubHasNextPage(fetched.response.headers.get("link")), acceptedBytes };
	};
	const primary = await safeFetch(rewrite.url, {
		signal,
		timeoutMs: config.timeoutMs,
		maxBytes: config.maxResponseBytes,
		headers,
		deadline,
		byteBudget,
		credentialed: options.credentialed,
		requestScopeKey: requestScope,
		allowedRedirectOrigins: options.allowedRedirectOrigins,
		beforeRedirect: options.beforeRedirect,
	});
	const { response, finalUrl, redirects, access } = primary;
	const bytes = await readBodyLimited(response, config.maxResponseBytes, signal, byteBudget);
	let acceptedBytes = primary.acceptedRedirectBytes + bytes.byteLength;
	if (response.status === 403 || response.status === 429 || response.status === 404 || response.status === 401) return null;
	if (response.status !== 200) return null;
	const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
	const meta = rewrite.meta ?? {};
	let formatted: { title: string; content: string };
	let completeness: RetrievalArtifact["completeness"] = {
		state: "complete",
		parts: [{ name: "document", state: "complete", fetched: 1, expected: 1 }],
	};
	let warnings: RetrievalWarning[] = [];
	if (rewrite.kind === "github-tree") {
		if (!Array.isArray(payload)) return null;
		formatted = formatGithubTree(payload, meta);
	} else {
		const issue = payload as GithubIssue;
		if (meta.type === "pull" && !issue.pull_request) issue.pull_request = {};
		const issueCommentsUrl = `https://api.github.com/repos/${meta.owner}/${meta.repo}/issues/${meta.number}/comments`;
		const comments = issue.comments > 0
			? await collectGithubCollection<GithubComment>({
				name: "comments",
				expected: issue.comments,
				deadline,
				loadPage: (page) => fetchJsonPage(`${issueCommentsUrl}?per_page=100&page=${page}`),
			})
			: { items: [], pages: 0, acceptedBytes: 0, part: { name: "comments", state: "complete" as const, fetched: 0, expected: 0 }, warnings: [] };
		const reviews = issue.pull_request
			? await collectGithubCollection<GithubReview>({
				name: "reviews",
				deadline,
				loadPage: (page) => fetchJsonPage(`https://api.github.com/repos/${meta.owner}/${meta.repo}/pulls/${meta.number}/reviews?per_page=100&page=${page}`),
			})
			: { items: [], pages: 0, acceptedBytes: 0, part: { name: "reviews", state: "complete" as const, fetched: 0 }, warnings: [] };
		const reviewComments = issue.pull_request
			? await collectGithubCollection<GithubReviewComment>({
				name: "review-comments",
				expected: issue.review_comments,
				deadline,
				loadPage: (page) => fetchJsonPage(`https://api.github.com/repos/${meta.owner}/${meta.repo}/pulls/${meta.number}/comments?per_page=100&page=${page}`),
			})
			: { items: [], pages: 0, acceptedBytes: 0, part: { name: "review-comments", state: "complete" as const, fetched: 0 }, warnings: [] };
		acceptedBytes += comments.acceptedBytes + reviews.acceptedBytes + reviewComments.acceptedBytes;
		warnings = [...comments.warnings, ...reviews.warnings, ...reviewComments.warnings];
		const parts = [
			{ name: "issue", state: "complete" as const, fetched: 1, expected: 1 },
			comments.part,
			...(issue.pull_request ? [reviews.part, reviewComments.part] : []),
		];
		completeness = { state: parts.some((part) => part.state === "partial") ? "partial" : "complete", parts };
		formatted = formatGithubIssueDocument({
			issue,
			comments: comments.items,
			reviews: reviews.items,
			reviewComments: reviewComments.items,
			meta,
			warnings: warnings.map((warning) => warning.message),
		});
	}
	return {
		url: requestedUrl,
		finalUrl,
		title: formatted.title,
		content: formatted.content,
		kind: "github-api",
		contentType: "application/json",
		status: response.status,
		bytes: acceptedBytes,
		durationMs: Date.now() - startedAt,
		redirects,
		cached: false,
		rewrittenFrom: requestedUrl,
		access,
		acceptedBytes,
		cacheControl: response.headers.get("cache-control") ?? undefined,
		completeness,
		warnings,
		...(warnings.length ? { warning: warnings.map((warning) => warning.message).join("; ") } : {}),
	};
}

interface NotModifiedResult {
	notModified: true;
	finalUrl: string;
	redirects: number;
	access: AccessDescriptor;
	acceptedRedirectBytes: number;
	cacheControl?: string;
	etag?: string;
	lastModified?: string;
}

interface InFlightFetch {
	controller: AbortController;
	promise: Promise<FetchedContent>;
	waiters: number;
	settled: boolean;
}

const inFlight = new Map<string, InFlightFetch>();
const budgetIds = new WeakMap<object, number>();
let nextBudgetId = 1;

function objectId(value: object | undefined): string {
	if (!value) return "none";
	let id = budgetIds.get(value);
	if (!id) {
		id = nextBudgetId++;
		budgetIds.set(value, id);
	}
	return String(id);
}

function requestScopeKey(options: FetchOptions): string | null {
	if (options.requestScopeKey !== undefined) return options.requestScopeKey;
	return options.operation?.scope ? sourceScopeKey(options.operation.scope) : null;
}

function requestBudget(options: FetchOptions): ByteBudget | undefined {
	return options.byteBudget ?? options.operation?.byteBudget;
}

function requestDeadline(options: FetchOptions): Deadline | undefined {
	return options.deadline ?? options.operation?.deadline;
}

interface VerifiedMarkdownAlternate {
	candidate: MarkdownAlternateCandidate;
	finalUrl: string;
	content: string;
	contentType: string;
	status: number;
	acceptedBytes: number;
	redirects: number;
	access: AccessDescriptor;
	cacheControl?: string;
	etag?: string;
	lastModified?: string;
}

async function fetchVerifiedMarkdownAlternate(
	candidate: MarkdownAlternateCandidate,
	sourceUrl: string,
	options: FetchOptions,
): Promise<VerifiedMarkdownAlternate> {
	const sourceOrigin = new URL(sourceUrl).origin;
	const target = new URL(candidate.url);
	if (target.origin !== sourceOrigin) throw new Error(`Markdown alternate origin ${target.origin} differs from source origin ${sourceOrigin}`);
	const fetched = await safeFetch(target.href, {
		signal: options.signal,
		timeoutMs: options.config.timeoutMs,
		maxBytes: options.config.maxResponseBytes,
		allowPrivateNetwork: options.config.allowPrivateNetwork,
		deadline: requestDeadline(options),
		byteBudget: requestBudget(options),
		credentialed: options.credentialed,
		requestScopeKey: requestScopeKey(options),
		allowedRedirectOrigins: [sourceOrigin],
		beforeRedirect: options.beforeRedirect,
		headers: {
			"User-Agent": options.config.userAgent,
			Accept: "text/markdown,application/markdown;q=0.9,text/plain;q=0.2",
			"Accept-Language": "en-US,en;q=0.9",
			"Cache-Control": "no-cache",
		},
	});
	const bytes = await readBodyLimited(fetched.response, options.config.maxResponseBytes, options.signal, requestBudget(options));
	const contentTypeHeader = fetched.response.headers.get("content-type");
	const contentType = mimeType(contentTypeHeader);
	if (!fetched.response.ok) throw new Error(`Markdown alternate returned HTTP ${fetched.response.status}`);
	if (!isMarkdownMime(contentType)) throw new Error(`Markdown alternate returned ${contentType || "an unknown content type"}`);
	return {
		candidate,
		finalUrl: fetched.finalUrl,
		content: decodeText(bytes, contentTypeHeader).replace(/\r\n?/g, "\n"),
		contentType,
		status: fetched.response.status,
		acceptedBytes: fetched.acceptedRedirectBytes + bytes.byteLength,
		redirects: fetched.redirects,
		access: fetched.access,
		cacheControl: fetched.response.headers.get("cache-control") ?? undefined,
		etag: fetched.response.headers.get("etag") ?? undefined,
		lastModified: fetched.response.headers.get("last-modified") ?? undefined,
	};
}

function githubRequestIsCredentialed(rewrite: Rewrite | undefined, options: FetchOptions): boolean {
	return options.credentialed === true || Boolean(rewrite && hasGithubCredential());
}

function cloneCacheResult(value: FetchedContent, startedAt: number, cache: "hit" | "revalidated", status = value.status): FetchedContent {
	const finishedAt = Date.now();
	return {
		...value,
		cached: true,
		cache,
		checkedAt: new Date(finishedAt).toISOString(),
		durationMs: finishedAt - startedAt,
		attempt: { startedAt, finishedAt, httpStatus: status, transferredBytes: 0, cache },
	};
}

function decorateResult(value: FetchedContent, startedAt: number, representation: FetchMode): FetchedContent {
	const finishedAt = Date.now();
	const timestamp = new Date(finishedAt).toISOString();
	const attempt: RetrievalAttempt = {
		startedAt,
		finishedAt,
		httpStatus: value.status,
		transferredBytes: value.acceptedBytes ?? value.bytes,
		cache: "miss",
		...(value.error ? { error: value.error } : {}),
	};
	if (value.error || value.kind === "error") return { ...value, checkedAt: timestamp, cache: "miss", attempt };
	const contentHash = createHash("sha256").update(value.content, "utf8").digest("hex");
	const fetchedAt = value.fetchedAt ?? timestamp;
	const warnings: RetrievalWarning[] = value.warnings ?? (value.warning
		? [{ code: "extraction-warning", stage: "extract", message: value.warning }]
		: []);
	const artifact: RetrievalArtifact | undefined = value.access ? {
		schemaVersion: 1,
		requestedUrl: value.url,
		resolvedUrl: value.alternate?.url ?? (value.rewrittenFrom ? rewriteUrl(value.url).url : value.url),
		finalUrl: value.finalUrl,
		transport: value.rewrittenFrom ? "github-smart" : "direct",
		representation,
		kind: value.kind,
		status: value.status,
		contentType: value.contentType,
		bytes: value.acceptedBytes ?? value.bytes,
		fetchedAt,
		title: value.title,
		content: value.content,
		contentHash,
		...(value.structured ? { structured: value.structured } : representation === "readable" ? { structured: extractDeterministic({ finalUrl: value.finalUrl, contentType: value.kind === "json" ? "application/json" : "text/markdown", body: value.content }).structured } : {}),
		extraction: { id: `forage:${value.kind}:1`, ...(value.contentRoot ? { contentRoot: value.contentRoot } : {}) },
		access: value.access,
		completeness: value.completeness ?? {
			state: "complete",
			parts: [{ name: "content", state: "complete", fetched: value.bytes, expected: value.bytes }],
		},
		warnings,
		diagnostics: { durationMs: value.durationMs, redirects: value.redirects, stageMs: { total: value.durationMs } },
	} : undefined;
	return {
		...value,
		contentHash,
		fetchedAt,
		checkedAt: timestamp,
		cache: "miss",
		attempt,
		...(artifact ? { artifact } : {}),
	};
}

function coalescingKey(url: string, options: FetchOptions, credentialed: boolean, scopeKey: string | null): string {
	const budget = requestBudget(options);
	const isolatedRequest = !scopeKey && (credentialed || options.config.allowPrivateNetwork) ? objectId(options) : null;
	return JSON.stringify([
		url,
		options.mode,
		options.resolve ?? "auto",
		options.noCache === true,
		options.config.allowPrivateNetwork,
		options.config.maxResponseBytes,
		options.config.timeoutMs,
		options.config.userAgent,
		credentialed,
		scopeKey,
		isolatedRequest,
		objectId(budget as object | undefined),
		options.allowedRedirectOrigins ?? null,
		objectId(options.beforeRedirect),
	]);
}

function joinInFlight(key: string, options: FetchOptions, start: (signal: AbortSignal) => Promise<FetchedContent>): Promise<FetchedContent> {
	let entry = inFlight.get(key);
	if (entry?.controller.signal.aborted) {
		if (inFlight.get(key) === entry) inFlight.delete(key);
		entry = undefined;
	}
	if (!entry) {
		const controller = new AbortController();
		const created: InFlightFetch = { controller, waiters: 0, settled: false, promise: Promise.resolve(undefined as never) };
		created.promise = start(controller.signal).finally(() => {
			created.settled = true;
			if (inFlight.get(key) === created) inFlight.delete(key);
		});
		inFlight.set(key, created);
		entry = created;
	}
	const joined = entry;
	joined.waiters++;
	const explicitDeadline = requestDeadline(options);
	const ownedDeadline = explicitDeadline ? undefined : createDeadline(options.config.timeoutMs, options.signal);
	const deadline = explicitDeadline ?? ownedDeadline!;
	const signal = options.signal && explicitDeadline ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: unknown, value?: FetchedContent) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			ownedDeadline?.dispose();
			joined.waiters--;
			if (joined.waiters === 0 && !joined.settled) {
				if (inFlight.get(key) === joined) inFlight.delete(key);
				joined.controller.abort(new Error("All coalesced waiters cancelled"));
			}
			if (error !== undefined) reject(error);
			else resolve(value!);
		};
		const onAbort = () => {
			const timedOut = deadline.remainingMs() <= 0 || signal.reason instanceof DeadlineError;
			finish(new NetError(timedOut ? "Request timed out" : "Request cancelled", timedOut ? "timeout" : "aborted"));
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		joined.promise.then((value) => finish(undefined, value), (error) => finish(error));
	});
}

export interface FetchDependencies {
	resolver?: Resolver;
	readerTransport?: ProviderTransport;
}

async function fetchWithRemoteReader(url: string, options: FetchOptions, dependencies: FetchDependencies, startedAt: number): Promise<FetchedContent> {
	const reader = options.reader!;
	const { config } = options;
	const parentDeadline = requestDeadline(options);
	const parentSignal = parentDeadline && options.signal ? AbortSignal.any([parentDeadline.signal, options.signal]) : parentDeadline?.signal ?? options.signal;
	const deadline = createDeadline(Math.min(config.timeoutMs, parentDeadline?.remainingMs() ?? config.timeoutMs), parentSignal);
	const byteBudget = requestBudget(options) ?? createByteBudget(config.maxResponseBytes);
	const remaining = byteBudget.remaining();
	try {
		if (reader === "direct") throw new Error("POLICY_BLOCKED: Expected an explicit remote reader.");
		resolvePolicy(config, { reader, profile: options.profile }, "retrieval");
		if (options.mode === "raw" || options.resolve === "smart" || options.credentialed) throw new Error("POLICY_BLOCKED: Remote readers require readable direct URLs without website credentials; raw and smart resolution remain direct-only.");
		deadline.throwIfExpired("reader dispatch");
		options.signal?.throwIfAborted();
		const target = await assertRemoteForwardableUrl(url, { resolver: dependencies.resolver, signal: deadline.signal, deadline });
		const context: OperationContext = { ...(options.operation?.scope ? { scope: options.operation.scope } : {}), deadline, byteBudget };
		const result = await readWithRemoteReader({ url: target.href, reader, config, context, resolver: dependencies.resolver, transport: dependencies.readerTransport });
		deadline.throwIfExpired("reader result");
		options.signal?.throwIfAborted();
		const finalUrl = await assertRemoteForwardableUrl(result.finalUrl || target.href, { resolver: dependencies.resolver, signal: deadline.signal, deadline });
		if (!Number.isInteger(result.statusCode) || result.statusCode < 200 || result.statusCode >= 300) throw new Error(`Remote reader returned HTTP ${result.statusCode}`);
		if (Buffer.byteLength(result.content, "utf8") > config.maxResponseBytes) throw new ByteBudgetError("Remote reader expanded content exceeds the response limit");
		const extraction = extractDeterministic({ finalUrl: finalUrl.href, contentType: "text/markdown", body: result.content });
		deadline.throwIfExpired("reader extraction");
		const acceptedBytes = remaining - byteBudget.remaining();
		const page = decorateResult({ url, finalUrl: finalUrl.href, title: result.title || extraction.structured.title, content: result.content, kind: "markdown", contentType: "text/markdown", status: result.statusCode, bytes: acceptedBytes, acceptedBytes, durationMs: Date.now() - startedAt, redirects: 0, cached: false, access: { network: "public", credentialed: false, requestScopeKey: requestScopeKey(options) }, warnings: [{ code: "remote-redirect-limitation", stage: "reader", message: "Vendor-side redirects cannot be DNS-pinned by Forage; requested and returned target URLs were locally checked." }, ...extraction.warnings] }, startedAt, "readable");
		if (page.artifact) {
			page.artifact.transport = "provider";
			page.artifact.structured = extraction.structured;
			page.artifact.extraction.id = `forage:reader:${reader}:${extraction.extractorVersion}`;
		}
		return page;
	} catch (error) {
		const failed = errorResult("[redacted remote target]", "[redacted remote target]", error, startedAt);
		const acceptedBytes = remaining - byteBudget.remaining();
		return { ...failed, bytes: acceptedBytes, acceptedBytes, attempt: failed.attempt ? { ...failed.attempt, transferredBytes: acceptedBytes } : undefined };
	} finally { deadline.dispose(); }
}

export async function fetchContent(input: string, options: FetchOptions, dependencies: FetchDependencies = {}): Promise<FetchedContent> {
	const startedAt = Date.now();
	const { config, mode } = options;
	let url: string;
	try {
		url = normalizeUrl(input);
	} catch (err) {
		return errorResult(input, input, err, startedAt);
	}
	if (options.reader && options.reader !== "direct") return fetchWithRemoteReader(url, options, dependencies, startedAt);
	if (!config.allowedReaders.includes("direct")) return errorResult(url, url, new Error("POLICY_BLOCKED: Direct reader is outside the configured reader ceiling."), startedAt);
	if ((config.privacyProfile === "private" || config.profile === "private") && options.profile && options.profile !== "private") return errorResult(url, url, new Error("POLICY_BLOCKED: Requested profile cannot widen the private ceiling."), startedAt);
	const requestedResolution = options.resolve ?? "auto";
	const resolved = resolveFetchTarget(url, mode, requestedResolution);
	const rewrite = resolved.rewrite;
	const scopeKey = requestScopeKey(options);
	const credentialed = githubRequestIsCredentialed(rewrite, options);
	const context: CacheAccessContext = { allowPrivateNetwork: config.allowPrivateNetwork, credentialed, requestScopeKey: scopeKey };
	const budget = requestBudget(options);
	const stale = options.noCache || options.beforeRedirect ? undefined : cacheLookup(url, mode, requestedResolution, context);
	if (stale && stale.expiresAt > Date.now()) {
		try {
			budget?.consume(stale.value.acceptedBytes ?? stale.value.bytes);
			return cloneCacheResult(stale.value, startedAt, "hit");
		} catch (error) {
			return errorResult(url, url, error, startedAt);
		}
	}

	let target = resolved.target;
	try {
		return await joinInFlight(coalescingKey(url, options, credentialed, scopeKey), options, async (sharedSignal) => {
			const transportDeadline = createDeadline(config.timeoutMs, sharedSignal);
			try {
				const sharedOptions: FetchOptions = {
					...options,
					signal: sharedSignal,
					deadline: transportDeadline,
					operation: undefined,
					byteBudget: budget,
					requestScopeKey: scopeKey,
					credentialed,
				};
				let rewrittenFrom: string | undefined = rewrite ? url : undefined;
				if (mode === "readable" && (rewrite?.kind === "github-tree" || rewrite?.kind === "github-issue")) {
					const viaApi = await fetchGithubApi(rewrite, sharedOptions, startedAt, url);
					if (viaApi) {
						const decorated = decorateResult(viaApi, startedAt, mode);
						cacheSet(url, mode, decorated, requestedResolution);
						return decorated;
					}
					target = rewrite.fallback ?? url;
					rewrittenFrom = undefined;
				}

				const conditionalHeaders: Record<string, string> = {};
				if (stale?.value.etag) conditionalHeaders["If-None-Match"] = stale.value.etag;
				if (stale?.value.lastModified) conditionalHeaders["If-Modified-Since"] = stale.value.lastModified;
				const requestHeaders = mode === "raw" && (rewrite?.kind === "github-tree" || rewrite?.kind === "github-issue")
					? { ...githubHeaders(config), ...conditionalHeaders }
					: conditionalHeaders;
				let result = await fetchAndExtract(url, target, sharedOptions, startedAt, requestHeaders);
				if ("notModified" in result) {
					if (!stale) throw new Error("Received HTTP 304 without a matching cache entry");
					budget?.consume(stale.value.acceptedBytes ?? stale.value.bytes);
					cacheDelete(stale.key);
					const revalidated = cloneCacheResult({
						...stale.value,
						finalUrl: result.finalUrl,
						redirects: result.redirects,
						access: result.access,
						cacheControl: result.cacheControl ?? stale.value.cacheControl,
						etag: result.etag ?? stale.value.etag,
						lastModified: result.lastModified ?? stale.value.lastModified,
					}, startedAt, "revalidated", 304);
					cacheSet(url, mode, revalidated, requestedResolution);
					return revalidated;
				}
				if (mode === "readable" && result.error && rewrite?.fallback && target !== rewrite.fallback && (result.status === 404 || result.status === 0)) {
					result = await fetchAndExtract(url, rewrite.fallback, sharedOptions, startedAt);
					rewrittenFrom = undefined;
				}
				if ("notModified" in result) throw new Error("Fallback returned HTTP 304 without a matching representation");
				result.rewrittenFrom = rewrittenFrom;
				const decorated = decorateResult(result, startedAt, mode);
				if (stale) cacheDelete(stale.key);
				cacheSet(url, mode, decorated, requestedResolution);
				return decorated;
			} finally {
				transportDeadline.dispose();
			}
		});
	} catch (err) {
		return errorResult(url, target, err, startedAt);
	}
}

function errorResult(url: string, finalUrl: string, err: unknown, startedAt: number): FetchedContent {
	const message = err instanceof Error ? err.message : String(err);
	const errorCode: NetErrorKind | undefined = err instanceof NetError
		? err.kind
		: err instanceof ByteBudgetError
			? "budget"
			: err instanceof DeadlineError || err instanceof BoundedProcessTimeoutError
				? "timeout"
				: undefined;
	const finishedAt = Date.now();
	return {
		url,
		finalUrl,
		title: "",
		content: "",
		kind: "error",
		contentType: "",
		status: 0,
		bytes: 0,
		durationMs: finishedAt - startedAt,
		redirects: 0,
		cached: false,
		cache: "miss",
		attempt: { startedAt, finishedAt, httpStatus: 0, transferredBytes: 0, cache: "miss", error: message },
		error: message,
		...(errorCode ? { errorCode } : {}),
	};
}

async function fetchAndExtract(
	requestedUrl: string,
	target: string,
	options: FetchOptions,
	startedAt: number,
	additionalHeaders: Record<string, string> = {},
): Promise<FetchedContent | NotModifiedResult> {
	const { config, signal, mode } = options;
	const byteBudget = requestBudget(options);
	const fetched = await safeFetch(target, {
		signal,
		timeoutMs: config.timeoutMs,
		maxBytes: config.maxResponseBytes,
		allowPrivateNetwork: config.allowPrivateNetwork,
		deadline: requestDeadline(options),
		byteBudget,
		credentialed: options.credentialed,
		requestScopeKey: requestScopeKey(options),
		allowedRedirectOrigins: options.allowedRedirectOrigins,
		beforeRedirect: options.beforeRedirect,
		headers: {
			"User-Agent": config.userAgent,
			Accept: mode === "readable"
				? "text/markdown,application/markdown;q=0.95,text/html;q=0.9,application/xhtml+xml;q=0.9,application/xml;q=0.8,text/plain;q=0.8,application/json;q=0.8,application/pdf;q=0.7,*/*;q=0.5"
				: "text/html,application/xhtml+xml,application/xml;q=0.9,text/markdown;q=0.9,text/plain;q=0.8,application/json;q=0.8,application/pdf;q=0.7,*/*;q=0.5",
			"Accept-Language": "en-US,en;q=0.9",
			"Cache-Control": "no-cache",
			...additionalHeaders,
		},
	});
	const { response, finalUrl, redirects, access } = fetched;
	const cacheControl = response.headers.get("cache-control") ?? undefined;
	const etag = response.headers.get("etag") ?? undefined;
	const lastModified = response.headers.get("last-modified") ?? undefined;
	if (response.status === 304) {
		await readBodyLimited(response, config.maxResponseBytes, signal, byteBudget);
		return { notModified: true, finalUrl, redirects, access, acceptedRedirectBytes: fetched.acceptedRedirectBytes, cacheControl, etag, lastModified };
	}
	const contentTypeHeader = response.headers.get("content-type");
	const contentType = mimeType(contentTypeHeader);
	const bytes = await readBodyLimited(response, config.maxResponseBytes, signal, byteBudget);
	const base: Omit<FetchedContent, "title" | "content" | "kind"> = {
		url: requestedUrl,
		finalUrl,
		contentType,
		status: response.status,
		bytes: bytes.byteLength,
		durationMs: Date.now() - startedAt,
		redirects,
		cached: false,
		access,
		acceptedBytes: fetched.acceptedRedirectBytes + bytes.byteLength,
		cacheControl,
		etag,
		lastModified,
	};

	// --- Raw representation -----------------------------------------------
	if (mode === "raw") {
		if (isPdf(bytes, contentType, finalUrl)) {
			return { ...base, title: "", content: "", kind: "error", error: `Raw mode requires a textual response; received ${contentType || "application/pdf"}. Use readable mode for PDF text extraction.` };
		}
		const textual =
			contentType.startsWith("text/") ||
			/json|xml|javascript|ecmascript|yaml|toml|csv|x-sh|x-www-form|graphql|markdown|x-python|x-ruby|x-perl|x-httpd-php|x-ndjson/i.test(contentType) ||
			((contentType === "" || contentType === "application/octet-stream") && looksLikeText(bytes));
		if (!textual) {
			return { ...base, title: "", content: "", kind: "error", error: `Raw mode requires a textual response; received ${contentType || "unknown type"} (${formatBytes(bytes.byteLength)}).` };
		}
		const text = decodeText(bytes, contentTypeHeader);
		const isHtml = contentType === "text/html" || contentType === "application/xhtml+xml" || ((contentType === "" || contentType === "application/octet-stream") && looksLikeHtml(text));
		if (!isHtml) return { ...base, title: titleFromText(text, finalUrl), content: text, kind: contentType.includes("json") ? "json" : "text" };
		// Raw HTML keeps its markup as the content, and its fields are read from that markup as in readable mode.
		const structured = extractDeterministic({ finalUrl, contentType: "text/html", body: text }).structured;
		return { ...base, title: structured.title || titleFromText(text, finalUrl), content: text, structured, kind: "html" };
	}

	// --- PDF ---------------------------------------------------------------
	if (isPdf(bytes, contentType, finalUrl)) {
		if (!response.ok) return { ...base, title: "", content: "", kind: "error", error: `HTTP ${response.status} ${response.statusText}`.trim() };
		const extractionTimeout = Math.max(1, Math.min(30_000, requestDeadline(options)?.remainingMs() ?? 30_000));
		const text = await pdfToText(bytes, requestDeadline(options)?.signal ?? signal, extractionTimeout, config.maxResponseBytes);
		const pages = (text.match(/\n\n---\n\n/g)?.length ?? 0) + 1;
		return {
			...base,
			title: titleFromText(text, finalUrl),
			content: text,
			kind: "pdf",
			durationMs: Date.now() - startedAt,
			description: `PDF, ${pages} page${pages === 1 ? "" : "s"}, ${formatBytes(bytes.byteLength)}`,
		};
	}

	// --- Binary ------------------------------------------------------------
	const textual =
		contentType.startsWith("text/") ||
		/json|xml|javascript|ecmascript|yaml|toml|csv|x-sh|x-www-form|graphql|markdown|x-python|x-ruby|x-perl|x-httpd-php|x-ndjson/i.test(contentType) ||
		((contentType === "" || contentType === "application/octet-stream") && looksLikeText(bytes));
	if (!textual) {
		return {
			...base,
			title: "",
			content: "",
			kind: "error",
			error: `Unsupported binary content: ${contentType || "unknown type"} (${formatBytes(bytes.byteLength)}). Only HTML, text, JSON, XML, and PDF are supported.`,
		};
	}

	const text = decodeText(bytes, contentTypeHeader);
	const isHtml = contentType === "text/html" || contentType === "application/xhtml+xml" || ((contentType === "" || contentType === "application/octet-stream") && looksLikeHtml(text));

	// --- Error status ------------------------------------------------------
	if (!response.ok) {
		let hint = "";
		if (isHtml) {
			const title = quickTitle(text);
			hint = title ? ` — "${title}"` : "";
		}
		const guidance = response.status === 404
			? " The page does not exist; check the URL or search for the resource."
			: response.status === 403 || response.status === 401
				? " Access denied (login, paywall, or bot protection)."
				: response.status === 429
					? " Rate limited; retry later."
					: response.status >= 500
						? " Server error; retry later."
						: "";
		return { ...base, title: "", content: "", kind: "error", error: `HTTP ${response.status} ${response.statusText}`.trim() + hint + guidance };
	}

	// --- HTML --------------------------------------------------------------
	if (isHtml) {
		requestDeadline(options)?.throwIfExpired("HTML extraction");
		const doc = extractDocument(text, finalUrl);
		requestDeadline(options)?.throwIfExpired("HTML extraction");
		const alternateWarnings: RetrievalWarning[] = [];
		const candidates = [
			...httpMarkdownAlternates(response.headers.get("link"), finalUrl),
			...findHtmlMarkdownAlternates(text, doc.baseUrl ?? finalUrl).map((alternate) => ({ source: "html-link" as const, url: alternate.url })),
		].filter((candidate, index, all) => all.findIndex((other) => other.url === candidate.url) === index).slice(0, 8);
		for (const candidate of candidates) {
			try {
				const alternate = await fetchVerifiedMarkdownAlternate(candidate, finalUrl, options);
				const acceptedBytes = (base.acceptedBytes ?? base.bytes) + alternate.acceptedBytes;
				return {
					...base,
					finalUrl: alternate.finalUrl,
					title: titleFromText(alternate.content, alternate.finalUrl),
					content: alternate.content,
					kind: "markdown",
					contentType: alternate.contentType,
					status: alternate.status,
					bytes: acceptedBytes,
					acceptedBytes,
					redirects: base.redirects + alternate.redirects,
					access: {
						...alternate.access,
						network: mergeNetworkAccess(access.network, alternate.access.network),
						credentialed: access.credentialed || alternate.access.credentialed,
					},
					description: doc.description || undefined,
					contentRoot: doc.contentRoot,
					cacheControl: combinedCacheControl(base.cacheControl, alternate.cacheControl),
					etag: undefined,
					lastModified: undefined,
					alternate: { source: candidate.source, url: alternate.finalUrl, contentType: alternate.contentType },
					warnings: alternateWarnings,
					...(alternateWarnings.length ? { warning: alternateWarnings.map((item) => item.message).join("; ") } : {}),
					durationMs: Date.now() - startedAt,
				};
			} catch (error) {
				requestDeadline(options)?.throwIfExpired("markdown alternate");
				if (signal?.aborted) throw new NetError("Request cancelled", "aborted");
				if (error instanceof DeadlineError || error instanceof ByteBudgetError || error instanceof BoundedProcessTimeoutError
					|| (error instanceof NetError && ["timeout", "aborted", "budget"].includes(error.kind))
					|| (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) throw error;
				alternateWarnings.push({
					code: "markdown-alternate-rejected",
					stage: "alternate",
					message: `${candidate.url}: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
		let warning: string | undefined;
		if (doc.markdown.length < 200) {
			warning = doc.likelyJsRendered
				? "Page appears to be JavaScript-rendered; little static content was available. Try the site's API, an alternate URL (docs/raw/print view), or a search for the same content."
				: "Very little readable text was extracted from this page.";
		}
		const warnings = [
			...alternateWarnings,
			...(warning ? [{ code: "extraction-warning", stage: "extract", message: warning }] : []),
		];
		return {
			...base,
			title: doc.title || titleFromText(doc.markdown, finalUrl),
			content: doc.markdown,
			structured: extractDeterministic({ finalUrl, contentType: "text/html", body: text }).structured,
			kind: "html",
			description: doc.description || undefined,
			contentRoot: doc.contentRoot,
			warning: warnings.length ? warnings.map((item) => item.message).join("; ") : undefined,
			warnings,
			durationMs: Date.now() - startedAt,
		};
	}

	// --- JSON / text -------------------------------------------------------
	if (contentType.includes("json") || /^\s*[[{]/.test(text.slice(0, 64)) && contentType === "") {
		return { ...base, title: titleFromText("", finalUrl), content: text, kind: "json" };
	}
	const isMarkdown = contentType.includes("markdown") || /\.(md|markdown|mdx)$/i.test(new URL(finalUrl).pathname);
	const negotiatedMarkdown = isMarkdownMime(contentType) && /(?:^|,)\s*accept\s*(?:,|$)/i.test(response.headers.get("vary") ?? "");
	return {
		...base,
		title: titleFromText(text, finalUrl),
		content: text.replace(/\r\n?/g, "\n"),
		kind: isMarkdown ? "markdown" : "text",
		...(negotiatedMarkdown ? { alternate: { source: "content-negotiation" as const, url: finalUrl, contentType } } : {}),
	};
}

// ---------------------------------------------------------------------------
// Paging and search within content
// ---------------------------------------------------------------------------

export interface ContentSlice {
	text: string;
	offset: number;
	end: number;
	total: number;
	truncated: boolean;
}

/** Slice content for output, preferring to cut at a line boundary. */
export function sliceContent(content: string, offset: number, maxChars: number): ContentSlice {
	const total = content.length;
	let start = Math.max(0, Math.min(offset, total));
	if (start > 0 && start < total && /[\uDC00-\uDFFF]/.test(content[start]!) && /[\uD800-\uDBFF]/.test(content[start - 1]!)) start--;
	let end = Math.min(total, start + Math.max(1, maxChars));
	if (end < total) {
		const window = content.lastIndexOf("\n", end);
		if (window > start + maxChars * 0.7) end = window + 1;
		if (end > start && /[\uD800-\uDBFF]/.test(content[end - 1]!) && /[\uDC00-\uDFFF]/.test(content[end]!)) end--;
		if (end === start && /[\uD800-\uDBFF]/.test(content[start]!) && /[\uDC00-\uDFFF]/.test(content[start + 1]!)) end = Math.min(total, start + 2);
	}
	return { text: content.slice(start, end), offset: start, end, total, truncated: end < total };
}

export interface Passage {
	/** Character offset of the match in the full content. */
	index: number;
	/** 1-based line number. */
	line: number;
	excerpt: string;
}

/**
 * Find passages matching `needle`.
 *
 * Plain text matches case-insensitively. `/pattern/flags` is a JS regex; the
 * `g` and `m` flags are always on (so `^`/`$` anchor to lines, which is what
 * you want in a document), add `i` yourself for case-insensitive regexes.
 */
export async function findPassages(
	content: string,
	needle: string,
	options: { context?: number; max?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Passage[]> {
	const context = Math.max(0, options.context ?? 300);
	const max = Math.max(0, Math.min(options.max ?? 20, 100));
	const trimmed = needle.trim();
	const regex = /^\/(.+)\/([gimsuy]*)$/.exec(trimmed);
	if (regex) {
		let flags: string;
		try {
			flags = [...new Set(`${regex[2]}gm`)].join("");
			new RegExp(regex[1]!, flags);
		} catch {
			return findLiteralPassages(content, trimmed, context, max);
		}
		return runRegexPassages({
			content,
			source: regex[1]!,
			flags,
			context,
			max,
			timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? 250, 2_000)),
			signal: options.signal,
		});
	}
	return findLiteralPassages(content, trimmed, context, max);
}

function findLiteralPassages(content: string, needle: string, context: number, max: number): Passage[] {
	if (!needle || max === 0) return [];
	const matcher = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
	const passages: Passage[] = [];
	let lastEnd = -1;
	let line = 1;
	let lineScanned = 0;
	let match: RegExpExecArray | null;
	while (passages.length < max && (match = matcher.exec(content)) !== null) {
		const index = match.index;
		if (index < lastEnd) continue;
		const start = Math.max(0, index - context);
		const end = Math.min(content.length, index + match[0].length + context);
		for (let i = lineScanned; i < index; i++) if (content.charCodeAt(i) === 10) line++;
		lineScanned = index;
		passages.push({
			index,
			line,
			excerpt: `${start > 0 ? "…" : ""}${content.slice(start, end).trim()}${end < content.length ? "…" : ""}`,
		});
		lastEnd = end;
	}
	return passages;
}
