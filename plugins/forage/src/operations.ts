import { z } from "zod";
import {
	boundOutput,
	clip,
	type FetchDetails,
	formatSearchText,
	OUTPUT_BUDGET,
	renderFetchedPage,
	seconds,
	type SearchDetails,
	type SearchQueryDetail,
	toList,
} from "./format.ts";
import { SEARCH_PROVIDERS, type SearchProviderName, type WebConfig } from "./web/config.ts";
import { fetchContent } from "./web/fetch.ts";
import { createByteBudget, createDeadline } from "./web/deadline.ts";
import { sourceScopeKey, type Deadline, type SourceScope } from "./web/contracts.ts";
import { PROFILE_NAMES, resolvePolicy } from "./profiles.ts";
import { CRAWL_BACKENDS, READER_PROVIDERS } from "./web/config.ts";
import { DiagnosticRing, type DiagnosticRecord, type OperationName } from "./diagnostics.ts";
import type { SourceRepository, RetrievalReceipt, SnapshotDocument } from "./sources/model.ts";
import type { CrawlJobService } from "./jobs/model.ts";
import { sourceScopeSchema, crawlLimitsSchema } from "./contract.ts";
import { discoverSite } from "./web/discovery.ts";
import { extractDeterministic } from "./web/extract.ts";
import { diffSnapshots } from "./sources/diff.ts";
import { cacheClear, cacheStats, type FetchedContent, type FetchOptions } from "./web/fetch.ts";
import { clearSearchCache } from "./web/search.ts";
import { isRestrictedAccess } from "./sources/policy.ts";
import {
	RECENCY_VALUES,
	type Recency,
	search,
	type SearchResponse,
} from "./web/search.ts";

const MAX_QUERIES = 8;
const MAX_URLS = 10;
const MAX_BATCH_TIMEOUT_MS = 5 * 60 * 1000;

function batchTimeoutMs(phaseItems: readonly number[], concurrency: number, itemTimeoutMs: number): number {
	const workers = Math.max(1, concurrency);
	const waves = phaseItems.reduce((total, count) => total + Math.ceil(count / workers), 0);
	return Math.min(MAX_BATCH_TIMEOUT_MS, waves * itemTimeoutMs + 500);
}

export async function runDispatchedBatch<T, R>(
	items: readonly T[],
	concurrency: number,
	itemTimeoutMs: number,
	outerDeadline: Deadline,
	signal: AbortSignal,
	run: (item: T, deadline: Deadline, index: number) => Promise<R>,
	failed: (item: T, error: unknown, index: number) => R,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const worker = async () => {
		for (;;) {
			if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Batch cancelled");
			const index = nextIndex++;
			if (index >= items.length) return;
			const item = items[index]!;
			if (outerDeadline.remainingMs() <= 0) {
				results[index] = failed(item, new Error("Batch deadline expired before dispatch"), index);
				continue;
			}
			const deadline = createDeadline(itemTimeoutMs, outerDeadline.signal);
			try {
				results[index] = await run(item, deadline, index);
			} catch (error) {
				if (signal.aborted) throw error;
				results[index] = failed(item, error, index);
			} finally {
				deadline.dispose();
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, () => worker()));
	return results;
}

export interface ContentTarget {
	title: string;
	url: string;
}

export function selectContentTargets(outcomes: readonly SearchQueryDetail[], cap: number): ContentTarget[] {
	const queues = outcomes.map((outcome) => [...outcome.results]);
	const selected: ContentTarget[] = [];
	const seenUrls = new Set<string>();
	const seenHosts = new Set<string>();
	const take = (queue: SearchQueryDetail["results"], preferNewHost: boolean): ContentTarget | undefined => {
		let fallback = -1;
		for (let index = 0; index < queue.length; index++) {
			const result = queue[index]!;
			const key = result.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
			if (seenUrls.has(key)) continue;
			const host = domainOfUrl(result.url);
			if (!preferNewHost || !seenHosts.has(host)) {
				queue.splice(index, 1);
				seenUrls.add(key);
				seenHosts.add(host);
				return { title: result.title, url: result.url };
			}
			if (fallback === -1) fallback = index;
		}
		if (fallback === -1) return undefined;
		const result = queue.splice(fallback, 1)[0]!;
		const key = result.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
		seenUrls.add(key);
		seenHosts.add(domainOfUrl(result.url));
		return { title: result.title, url: result.url };
	};
	for (const queue of queues) {
		if (selected.length >= cap) break;
		const target = take(queue, true);
		if (target) selected.push(target);
	}
	while (selected.length < cap) {
		let added = false;
		for (const queue of queues) {
			if (selected.length >= cap) break;
			const target = take(queue, true) ?? take(queue, false);
			if (!target) continue;
			selected.push(target);
			added = true;
		}
		if (!added) break;
	}
	return selected;
}

function domainOfUrl(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return url;
	}
}

function errText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const selectors = { profile: z.enum(PROFILE_NAMES).optional(), provider: z.enum(SEARCH_PROVIDERS).optional(), reader: z.enum(READER_PROVIDERS).optional(), backend: z.enum(CRAWL_BACKENDS).optional(), fallback: z.boolean().optional() };
export const searchParams = z.object({
 ...selectors,
 strictFilters: z.boolean().optional(), language: z.string().max(30).optional(), country: z.string().max(30).optional(), category: z.string().max(100).optional(), content: z.enum(["snippets", "chunks"]).optional(), maxPerHost: z.number().int().min(1).max(20).optional(),
	query: z.string().optional().describe("A single search query. For research, prefer `queries` with 2-4 varied angles."),
	queries: z
		.array(z.string())
		.max(MAX_QUERIES)
		.optional()
		.describe(
			`Multiple queries run concurrently (max ${MAX_QUERIES}). Vary phrasing and scope for coverage, e.g. ["X vs Y benchmarks 2025", "X migration guide", "X known issues"].`,
		),
	numResults: z.number().int().min(1).max(20).optional().describe("Results per query (default 5, max 20)."),
	recency: z.enum(RECENCY_VALUES).optional().describe("Only results from the last day, week, month or year."),
	domains: z
		.array(z.string())
		.optional()
		.describe('Restrict to domains, e.g. ["docs.python.org"]. Prefix with "-" to exclude, e.g. ["-pinterest.com"].'),
	provider: z
		.enum(SEARCH_PROVIDERS)
		.optional()
		.describe(
			"Search backend. Omit for the configured default (auto = brave → searxng → duckduckgo → exa, skipping anything unconfigured and falling through on errors).",
		),
	includeContent: z.boolean().optional().describe("Also fetch and include the readable content of the top results (bounded). Slower; use when snippets are not enough."),
}).strict();

export const fetchParams = z.object({
 ...selectors,
 snapshotId: z.string().min(1).max(200).optional(), sourceId: z.string().min(1).max(200).optional(),
 view: z.enum(["content", "outline", "links", "lines", "focus"]).optional(), startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional(), focus: z.string().max(500).optional(),
	url: z.string().optional().describe("URL to fetch (http/https; scheme optional)."),
	urls: z.array(z.string()).max(MAX_URLS).optional().describe(`Multiple URLs fetched concurrently (max ${MAX_URLS}); each gets a share of the output budget.`),
	mode: z.enum(["readable", "raw"]).optional().describe("readable (default): main content as markdown. raw: the exact textual response body without extraction or JSON formatting."),
	resolve: z.enum(["auto", "direct", "smart"]).optional().describe("Resolution strategy. auto uses direct retrieval for raw mode and GitHub-smart resolution for readable mode; direct never rewrites; smart explicitly enables supported rewrites."),
	maxChars: z.number().int().min(200).max(200_000).optional().describe("Max characters of content to return per URL (default from settings, 30000)."),
	offset: z.number().int().min(0).optional().describe("Character offset to continue from (for paging long documents). Uses an immutable snapshot when snapshotId is provided; URL-only paging may re-download after cache expiry. Bind contentHash to detect changed content."),
	contentHash: z.string().regex(/^[0-9a-f]{64}$/i).optional().describe("Expected SHA-256 content hash from a prior continuation. A mismatch fails instead of paging changed content."),
	find: z
		.string()
		.optional()
		.describe(
			'Return only matching passages (up to 20, ~300 characters of context each) instead of the whole page. Plain text matches case-insensitively; use /pattern/flags for a regex (g and m are always on, so ^ and $ anchor to lines; add i for case-insensitive), e.g. find: "/^## Install/".',
		),
	refresh: z.boolean().optional().describe("Bypass the 15-minute cache and re-download."),
}).strict().superRefine((value, context) => {
 if ((value.snapshotId || value.sourceId) && (value.url || value.urls?.length)) context.addIssue({ code: "custom", message: "Snapshot/source IDs and URL inputs are mutually exclusive." });
 if (value.snapshotId && value.sourceId) context.addIssue({ code: "custom", message: "Choose snapshotId or sourceId, not both." });
 if (value.view === "focus" && !value.focus?.trim()) context.addIssue({ code: "custom", path: ["focus"], message: "Focus view requires a nonempty focus string." });
 if (value.endLine !== undefined && value.endLine < (value.startLine ?? 1)) context.addIssue({ code: "custom", path: ["endLine"], message: "endLine must not precede startLine." });
});

async function runSearch(
	params: z.output<typeof searchParams>,
	config: WebConfig,
	signal: AbortSignal,
	requestScopeKey: string,
 hooks: OperationHooks,
): Promise<{ text: string; details: SearchDetails }> {
	const queries = toList(params.query, params.queries, MAX_QUERIES, "queries");
	if (queries.length === 0) throw new Error("No query provided. Pass `query` or `queries`.");
	const numResults = params.numResults ?? 5;
	const recency = params.recency as Recency | undefined;
	const provider = params.provider as SearchProviderName | undefined;
	const chain = resolvePolicy(config, params).providers;
	const startedAt = Date.now();
	const targetCap = params.includeContent ? Math.min(8, Math.max(3, queries.length)) : 0;
	const byteBudget = createByteBudget(config.maxResponseBytes * Math.max(1, config.concurrency));
 const outerDeadline = createDeadline(batchTimeoutMs([queries.length, targetCap], config.concurrency, config.timeoutMs), signal);
	try {
	const outcomes = await runDispatchedBatch(
		queries,
		config.concurrency,
		config.timeoutMs,
		outerDeadline,
		signal,
		async (query, deadline): Promise<SearchQueryDetail> => {
			const startedQueryAt = Date.now();
			try {
				const response: SearchResponse = await hooks.search(query, { ...params, numResults, recency, domains: params.domains, signal: deadline.signal, context: { scope: hooks.scope, deadline, byteBudget } }, config, provider);
				return {
					query,
					provider: response.provider,
					results: response.results,
					rawCount: response.rawCount,
					durationMs: response.durationMs,
					attempts: response.attempts,
					note: response.note,
				};
			} catch (error) {
				if (signal.aborted) throw error;
				return { query, provider: null, results: [], rawCount: 0, durationMs: Date.now() - startedQueryAt, error: errText(error), attempts: [] };
			}
		},
		(query, error) => ({ query, provider: null, results: [], rawCount: 0, durationMs: 0, error: errText(error), attempts: [] }),
	);

	const details: SearchDetails = {
		queries: outcomes,
		totalResults: outcomes.reduce((total, outcome) => total + outcome.results.length, 0),
		durationMs: Date.now() - startedAt,
	};

	const usedProviders = [...new Set(outcomes.map((outcome) => outcome.provider).filter((value): value is string => Boolean(value)))];
	const providerLabel = usedProviders.join("+") || chain.join("→");
	if (!params.includeContent || details.totalResults === 0) {
		return { text: formatSearchText(details, providerLabel, OUTPUT_BUDGET), details };
	}

	const targets = selectContentTargets(outcomes, targetCap);
	const pages = await runDispatchedBatch(
		targets,
		config.concurrency,
		config.timeoutMs,
		outerDeadline,
		signal,
		(target, deadline) => hooks.fetch(target.url, { mode: "readable", signal: deadline.signal, deadline, byteBudget, config, requestScopeKey, reader: params.reader, profile: params.profile }, "search-content"),
		(target, error) => ({
			url: target.url,
			finalUrl: target.url,
			title: target.title,
			content: "",
			kind: "error" as const,
			contentType: "",
			status: 0,
			bytes: 0,
			durationMs: 0,
			redirects: 0,
			cached: false,
			error: errText(error),
		}),
	);
	const eligible = new Set(outcomes.flatMap((outcome) => outcome.results.map((result) => result.url))).size;
	const baseBudget = Math.floor(OUTPUT_BUDGET * 0.55);
	const baseText = formatSearchText(details, providerLabel, baseBudget);
	const intro = `Content fetches: selected ${targets.length} of ${eligible} unique search results with round-robin query and host diversity${eligible > targets.length ? `; ${eligible - targets.length} omitted by the ${targetCap}-target cap` : ""}.`;
	const separators = Math.max(0, pages.length - 1) * 7;
	const remaining = Math.max(500 * Math.max(1, pages.length), OUTPUT_BUDGET - baseText.length - intro.length - 6 - separators);
	const perPageBudget = Math.max(500, Math.floor(remaining / Math.max(1, pages.length)));
	const sections: string[] = [];
	details.fetched = [];
	for (const [index, page] of pages.entries()) {
		const target = targets[index]!;
		const heading = `### ${clip(page.title || target.title, 500)}`;
		const rendered = await hooks.render(page, {}, { offset: 0, maxChars: config.maxChars, maxOutputChars: Math.max(500, perPageBudget - heading.length - 1), showTitle: false, signal });
		details.fetched.push({
			url: target.url,
			title: page.title || target.title,
			chars: page.content.length,
			shown: rendered.detail.shown,
			...(page.error ? { error: page.error } : {}),
		});
		sections.push(`${heading}\n${rendered.text}`);
	}
	const text = `${baseText}\n\n---\n\n${intro}${sections.length ? `\n\n${sections.join("\n\n---\n\n")}` : ""}`;
	return { text: boundOutput(text, "Use snapshotId, contentHash, offset or find for continuation.").text, details };
	} finally {
		outerDeadline.dispose();
	}
}

async function runFetch(
	params: z.output<typeof fetchParams>,
	config: WebConfig,
	signal: AbortSignal,
	requestScopeKey: string,
 hooks: OperationHooks,
): Promise<{ text: string; details: FetchDetails }> {
	const urls = toList(params.url, params.urls, MAX_URLS, "URLs");
	if (urls.length === 0) throw new Error("No URL provided. Pass `url` or `urls`.");
	const mode = params.mode ?? "readable";
	const resolve = params.resolve ?? "auto";
	const offset = params.offset ?? 0;
	const find = params.find?.trim() || undefined;
	const maxChars = params.maxChars ?? config.maxChars;
	if (params.contentHash && !/^[0-9a-f]{64}$/i.test(params.contentHash)) throw new Error("contentHash must be a 64-character hexadecimal SHA-256 value.");
	if (params.contentHash && urls.length !== 1) throw new Error("contentHash can only be used with one URL.");
	const expectedContentHash = params.contentHash?.toLowerCase();
	const startedAt = Date.now();
	const byteBudget = createByteBudget(config.maxResponseBytes * Math.max(1, config.concurrency));
 const outerDeadline = createDeadline(batchTimeoutMs([urls.length], config.concurrency, config.timeoutMs), signal);
	try {
	const pages = await runDispatchedBatch(
		urls,
		config.concurrency,
		config.timeoutMs,
		outerDeadline,
		signal,
		(url, deadline) => hooks.fetch(url, { mode, resolve, signal: deadline.signal, deadline, byteBudget, config, noCache: params.refresh, requestScopeKey, reader: params.reader, profile: params.profile }, "fetch"),
		(url, error) => ({
			url,
			finalUrl: url,
			title: "",
			content: "",
			kind: "error" as const,
			contentType: "",
			status: 0,
			bytes: 0,
			durationMs: 0,
			redirects: 0,
			cached: false,
			error: errText(error),
		}),
	);

	const checkedPages = pages.map((page) => {
		if (!page.error && expectedContentHash && page.contentHash !== expectedContentHash) {
			return { ...page, content: "", kind: "error" as const, error: `STALE_CONTENT: expected content hash ${expectedContentHash}, received ${page.contentHash ?? "none"}.` };
		}
		return page;
	});
	const durationMs = Date.now() - startedAt;
	const prefixReserve = urls.length > 1 ? `Fetched ${urls.length}/${urls.length} URLs in ${seconds(durationMs)}.` : "";
	const separators = Math.max(0, urls.length - 1) * 7;
	const available = OUTPUT_BUDGET - prefixReserve.length - (prefixReserve ? 2 : 0) - separators;
	const perSectionBudget = Math.max(500, Math.floor(available / urls.length));
	const details: FetchDetails = { results: [], urlCount: urls.length, successful: 0, durationMs, mode, find };
	const sections: string[] = [];
	for (const page of checkedPages) {
		const { text, detail } = await hooks.render(page, params, { offset, maxChars, maxOutputChars: perSectionBudget, find, showTitle: true, signal, hashBound: Boolean(expectedContentHash) });
		details.results.push(detail);
		if (!detail.error) details.successful += 1;
		sections.push(text);
	}

	let text = sections.join("\n\n---\n\n");
	const prefix = urls.length > 1 ? `Fetched ${details.successful}/${urls.length} URLs in ${seconds(details.durationMs)}.` : "";
	if (prefix) text = `${prefix}\n\n${text}`;
	return { text, details };
	} finally {
		outerDeadline.dispose();
	}
}


export const mapParams = z.object({
 ...selectors, url: z.string().min(1), sitemapUrl: z.string().optional(), includePaths: z.array(z.string()).max(50).optional(), excludePaths: z.array(z.string()).max(50).optional(), includeSubdomains: z.boolean().optional(), maxUrls: z.number().int().min(1).max(5000).optional(), maxIndexDocuments: z.number().int().min(1).max(64).optional(), maxBytes: z.number().int().min(1).max(50 * 1024 * 1024).optional(), maxDepth: z.number().int().min(0).max(8).optional(), includeRootLinks: z.boolean().optional(),
}).strict();
export const extractParams = z.object({
 ...selectors, url: z.string().min(1).optional(), urls: z.array(z.string().min(1)).min(1).max(10).optional(), snapshotId: z.string().min(1).optional(), fields: z.array(z.enum(["title", "description", "canonicalUrl", "language", "headings", "links", "tables", "jsonLd"])).min(1).optional(),
}).strict();
export const crawlParams = z.object({
 ...selectors, action: z.enum(["start", "status", "list", "cancel", "resume"]).default("start"), url: z.string().min(1).optional(), jobId: z.string().min(1).optional(), cursor: z.string().max(1000).optional(), limit: z.number().int().min(1).max(100).optional(), limits: crawlLimitsSchema.partial().optional(), includePaths: z.array(z.string()).max(50).optional(), excludePaths: z.array(z.string()).max(50).optional(), includeSubdomains: z.boolean().optional(),
}).strict();
export const diffParams = z.object({
 ...selectors, sourceId: z.string().min(1).optional(), beforeSnapshotId: z.string().min(1).optional(), afterSnapshotId: z.string().min(1).optional(), url: z.string().min(1).optional(), maxHunks: z.number().int().min(1).max(200).optional(), maxChars: z.number().int().min(200).max(30000).optional(),
}).strict();
export const operationSchemas = { search: searchParams, fetch: fetchParams, map: mapParams, extract: extractParams, crawl: crawlParams, diff: diffParams };
export interface ForageContext { scope: SourceScope; signal: AbortSignal }
export interface OperationResult { text: string; details: unknown; isError?: boolean }
type AcquisitionOptions = FetchOptions & { reader?: z.infer<typeof selectors.reader>; profile?: z.infer<typeof selectors.profile> };
export interface RuntimeDependencies {
 getConfig(): Promise<WebConfig>;
 sources: SourceRepository;
 jobs: CrawlJobService;
 resolveScope(scope: SourceScope, signal?: AbortSignal): Promise<SourceScope>;
 allowRestrictedThreadCapture(): boolean | Promise<boolean>;
 fetch?: (url: string, options: AcquisitionOptions) => Promise<FetchedContent>;
 search?: typeof search;
 onChanged?(scope: SourceScope): void;
 onInvalidateAll?(): void;
}
interface CapturedPage extends FetchedContent { receipt?: RetrievalReceipt }
interface OperationHooks {
 scope: SourceScope;
 search: typeof search;
 fetch(url: string, options: AcquisitionOptions, origin: "fetch" | "search-content" | "extract" | "map" | "diff"): Promise<CapturedPage>;
 render: typeof renderOperationPage;
}
export interface ForageRuntime {
 getConfig: RuntimeDependencies["getConfig"];
 resolveScope: RuntimeDependencies["resolveScope"];
 allowRestrictedThreadCapture: RuntimeDependencies["allowRestrictedThreadCapture"];
 sources: SourceRepository;
 jobs: CrawlJobService;
 invalidate(scope: SourceScope): void;
 invalidateAll(): void;
 fenceScope(scope: SourceScope): void;
 fenceAll(): void;
 diagnostics: DiagnosticRing;
 cache: { stats: typeof cacheStats; clear(): void };
 executeSearch(input: unknown, context: ForageContext): Promise<OperationResult>;
 executeFetch(input: unknown, context: ForageContext): Promise<OperationResult>;
 executeMap(input: unknown, context: ForageContext): Promise<OperationResult>;
 executeExtract(input: unknown, context: ForageContext): Promise<OperationResult>;
 executeCrawl(input: unknown, context: ForageContext): Promise<OperationResult>;
 executeDiff(input: unknown, context: ForageContext): Promise<OperationResult>;
 dispose(): Promise<void>;
}

function pageFromSnapshot(doc: SnapshotDocument): CapturedPage {
 return { url: "", finalUrl: "", title: doc.structured.title, content: doc.content, contentHash: doc.contentHash, kind: doc.kind === "github-api" ? "json" : doc.kind, contentType: doc.contentType, structured: doc.structured, status: 200, bytes: doc.bytes, durationMs: 0, redirects: 0, cached: true, receipt: { sourceId: doc.sourceId, snapshotId: doc.id, retrievalId: null, contentHash: doc.contentHash, snapshotHash: doc.snapshotHash, changed: false, persisted: true, warning: null } };
}
async function renderOperationPage(page: CapturedPage, params: z.infer<typeof fetchParams>, options: Parameters<typeof renderFetchedPage>[1]) {
 let viewPage = page;
 const structured = page.artifact?.structured ?? page.structured;
 if (!page.error && params.view && params.view !== "content") {
  const document = structured ?? extractDeterministic({ finalUrl: page.finalUrl || "https://snapshot.invalid", contentType: "text/markdown", body: page.content }).structured;
  let content = page.content;
  if (params.view === "outline") content = document.headings.map(h => `L${h.line} ${"#".repeat(h.level)} ${h.text}`).join("\n");
  if (params.view === "links") content = document.links.map(link => `${link.text} — ${link.url}`).join("\n");
  if (params.view === "lines" || params.view === "focus") {
   const lines = content.split("\n");
   const matched = params.view === "focus" ? lines.findIndex(line => line.toLowerCase().includes((params.focus ?? "").toLowerCase())) : -1;
   const start = params.view === "focus" ? Math.max(0, matched - 3) : (params.startLine ?? 1) - 1;
   const end = params.view === "focus" ? Math.min(lines.length, matched + 20) : Math.min(lines.length, params.endLine ?? start + 100);
   content = matched < 0 && params.view === "focus" ? "No matching focus section." : lines.slice(start, end).map((line, i) => `L${start + i + 1}: ${line}`).join("\n");
  }
  viewPage = { ...page, content, contentHash: undefined };
  options = { ...options, offset: 0, hashBound: false };
 }
 const budget = options.maxOutputChars ?? OUTPUT_BUDGET;
 const receipt = page.receipt;
 const citation = receipt?.persisted && receipt.sourceId && receipt.snapshotId ? `\nSource ID: ${receipt.sourceId}; snapshotId=${receipt.snapshotId}; contentHash=${receipt.contentHash}\n` : receipt?.warning ? `\nNot persisted: ${receipt.warning.code}: ${receipt.warning.message}\n` : "";
 const rendered = await renderFetchedPage(viewPage, { ...options, maxOutputChars: Math.max(500, budget - citation.length) });
 return { ...rendered, text: rendered.text + citation };
}
function jsonResult(details: unknown, isError = false): OperationResult {
 const json = JSON.stringify(details, null, 2);
 return { text: boundOutput(json, "Narrow the request or use a cursor.").text, details, ...(isError ? { isError: true } : {}) };
}
const NOT_VISIBLE = "SOURCE_NOT_VISIBLE: The requested scope or record is unavailable.";
export function createForageRuntime(deps: RuntimeDependencies): ForageRuntime {
 const diagnostics = new DiagnosticRing();
 const controller = new AbortController();
 const pending = new Set<Promise<unknown>>();
 const scopes = new Map<string, { scope: SourceScope; controller: AbortController; active: number }>();
 function fenceScope(scope: SourceScope): void {
  for (const entry of scopes.values()) if (entry.scope.projectId === scope.projectId && (scope.kind === "project" || (entry.scope.kind === "thread" && entry.scope.threadId === scope.threadId))) entry.controller.abort(new Error("Scope was cleared or deleted"));
 }
 let disposed = false;
 async function readableSnapshot(scope: SourceScope, id: string, config: WebConfig): Promise<SnapshotDocument> {
  const doc = deps.sources.getSnapshot(scope, id);
  if (!doc && deps.sources.readSnapshot(scope, id, { offset: 0, maxChars: 1 }).status === "evicted") throw new Error("SNAPSHOT_EVICTED: The snapshot is no longer retained.");
  const source = doc && deps.sources.get(scope, doc.sourceId);
  if (!doc || !source || (source.access.network === "private" && !config.allowPrivateNetwork) || (isRestrictedAccess(source.access) && !(scope.kind === "thread" && await deps.allowRestrictedThreadCapture()))) throw new Error(NOT_VISIBLE);
  return doc;
 }
 async function execute(name: OperationName, input: unknown, context: ForageContext): Promise<OperationResult> {
  const started = Date.now();
  const counts: DiagnosticRecord["counts"] = {};
  const cache: DiagnosticRecord["cache"] = {};
  const stageMs: DiagnosticRecord["stageMs"] = {};
  let status: DiagnosticRecord["status"] = "failure";
  let provider: DiagnosticRecord["provider"];
  const warnings: NonNullable<DiagnosticRecord["warnings"]> = [];
  const key = sourceScopeKey(context.scope);
  let scopeEntry = scopes.get(key);
  if (!scopeEntry || scopeEntry.controller.signal.aborted) {
   scopeEntry = { scope: context.scope, controller: new AbortController(), active: 0 };
   scopes.set(key, scopeEntry);
  }
  scopeEntry.active++;
  const signal = AbortSignal.any([context.signal, controller.signal, scopeEntry.controller.signal]);
  const work = async (): Promise<OperationResult> => {
   if (disposed) throw new Error("Forage runtime is disposed");
   signal.throwIfAborted();
   const params = operationSchemas[name].parse(input);
   const scope = await deps.resolveScope(sourceScopeSchema.parse(context.scope), signal);
   stageMs.scope = Date.now() - started;
   if (deps.sources.storageSummary(scope).deleting) throw new Error("SOURCE_NOT_VISIBLE: Scope cleanup is in progress.");
   const config = await deps.getConfig();
   resolvePolicy(config, params, name === "search" ? "search" : "retrieval");
   provider = name === "search" ? (params.provider !== "auto" ? params.provider : undefined) : params.reader ?? (name === "crawl" ? params.backend ?? "local" : "direct");
   stageMs.policy = Date.now() - started - stageMs.scope;
   const requestScopeKey = sourceScopeKey(scope);
   const hooks: OperationHooks = { scope, search: deps.search ?? search,
    async render(...args) { const at = Date.now(); try { return await renderOperationPage(...args); } finally { stageMs.render = (stageMs.render ?? 0) + Date.now() - at; } },
    async fetch(url, options, origin) {
    signal.throwIfAborted();
    const at = Date.now();
    const page: CapturedPage = await (deps.fetch ?? fetchContent)(url, options);
    stageMs.acquisition = (stageMs.acquisition ?? 0) + Date.now() - at;
    signal.throwIfAborted();
    if (page.artifact && page.artifact.completeness.state !== "complete") warnings.push("partial");
    counts.items = (counts.items ?? 0) + 1;
    counts.bytes = (counts.bytes ?? 0) + (page.acceptedBytes ?? page.bytes);
    counts[page.error ? "failed" : "successful"] = (counts[page.error ? "failed" : "successful"] ?? 0) + 1;
    cache[page.cache ?? (page.cached ? "hit" : "miss")] = (cache[page.cache ?? (page.cached ? "hit" : "miss")] ?? 0) + 1;
    if (page.error && page.access && page.attempt) {
     const allowRestrictedThreadCapture = await deps.allowRestrictedThreadCapture(); signal.throwIfAborted();
     page.receipt = deps.sources.recordRetrieval({ scope, origin, artifact: null, requestedUrl: page.url, access: page.access, attempt: { ...page.attempt, error: page.error }, allowRestrictedThreadCapture });
     if (page.receipt.persisted) deps.onChanged?.(scope);
    }
    if (page.artifact && page.attempt && !page.error) {
     const captureAt = Date.now();
     const allowRestrictedThreadCapture = await deps.allowRestrictedThreadCapture(); signal.throwIfAborted();
     page.receipt = deps.sources.recordRetrieval({ scope, origin, artifact: page.artifact, attempt: page.attempt, allowRestrictedThreadCapture });
     stageMs.capture = (stageMs.capture ?? 0) + Date.now() - captureAt;
     if (page.receipt.persisted) { counts.persisted = (counts.persisted ?? 0) + 1; deps.onChanged?.(scope); }
     else if (page.receipt.warning) warnings.push(page.receipt.warning.code === "STORAGE_LIMIT" ? "storage-limit" : "policy-blocked");
    }
    return page;
   }};
   let result: OperationResult;
   if (name === "search") {
    const response = await runSearch(searchParams.parse(params), config, signal, requestScopeKey, hooks);
    provider = response.details.queries.find(q => q.provider)?.provider as DiagnosticRecord["provider"];
    counts.items = (counts.items ?? 0) + response.details.queries.length;
    counts.failed = (counts.failed ?? 0) + response.details.queries.filter(q => q.error).length;
    counts.successful = (counts.successful ?? 0) + response.details.queries.filter(q => !q.error).length;
    result = response;
   } else if (name === "fetch" && !("snapshotId" in params && params.snapshotId) && !("sourceId" in params && params.sourceId)) {
    const response = await runFetch(fetchParams.parse(params), config, signal, requestScopeKey, hooks);
    counts.successful = response.details.successful;
    counts.failed = response.details.urlCount - response.details.successful;
    result = response;
   } else {
    const deadline = createDeadline(Math.min(300000, config.timeoutMs * 3 + 500), signal);
    const byteBudget = createByteBudget(config.maxResponseBytes * Math.max(1, config.concurrency));
    const acquire = (url: string, origin: "extract" | "map" | "diff") => hooks.fetch(url, { mode: "readable", config, deadline, byteBudget, signal: deadline.signal, requestScopeKey, reader: params.reader, profile: params.profile }, origin);
    try {
     if (name === "fetch") {
      const p = fetchParams.parse(params);
      const id = p.snapshotId ?? (p.sourceId ? deps.sources.get(scope, p.sourceId)?.latestSnapshot?.id : undefined);
      if (!id) throw new Error(NOT_VISIBLE);
      const doc = await readableSnapshot(scope, id, config);
      if (p.contentHash && p.contentHash.toLowerCase() !== doc.contentHash) throw new Error("STALE_CONTENT: Snapshot content hash does not match.");
      const page = pageFromSnapshot(doc);
      page.finalUrl = deps.sources.get(scope, doc.sourceId)!.url;
      result = { text: (await hooks.render(page, p, { offset: p.offset ?? 0, maxChars: p.maxChars ?? config.maxChars, maxOutputChars: OUTPUT_BUDGET, find: p.find, showTitle: true, signal, hashBound: true })).text, details: { snapshotId: doc.id, contentHash: doc.contentHash } };
     } else if (name === "map") {
      const p = mapParams.parse(params);
      if (p.reader && p.reader !== "direct") throw new Error("POLICY_BLOCKED: Map supports only local direct discovery.");
      if (p.backend && p.backend !== "local") throw new Error("POLICY_BLOCKED: Map supports only local discovery.");
      const discovered = await discoverSite({ ...p, rootUrl: p.url, signal: deadline.signal, operation: { scope, deadline, byteBudget } }, { fetch: async (url, options) => {
       const page = await hooks.fetch(url, { mode: "raw", resolve: "direct", config, deadline, byteBudget, signal: options.signal, requestScopeKey }, "map");
       return { requestedUrl: page.url, finalUrl: page.finalUrl, status: page.status, contentType: page.contentType, content: page.content, bytes: page.bytes, error: page.error };
      }});
      if (discovered.truncated) warnings.push("partial");
      const observedAt = Date.now();
      for (const method of new Set(discovered.urls.map(url => url.method))) {
       deps.sources.recordDiscovery({ scope, fromSourceId: null, method, urls: discovered.urls.filter(url => url.method === method), observedAt });
      }
      deps.onChanged?.(scope);
      result = jsonResult(discovered);
     } else if (name === "extract") {
      const p = extractParams.parse(params);
      const items: unknown[] = [];
      const urls = toList(p.url, p.urls, 10, "URLs");
      if (!p.snapshotId && urls.length === 0) throw new Error("Pass url, urls or snapshotId.");
      if (p.snapshotId && urls.length) throw new Error("snapshotId and URL inputs are mutually exclusive.");
      if (p.snapshotId) {
       const doc = await readableSnapshot(scope, p.snapshotId, config);
       items.push({ snapshotId: doc.id, contentHash: doc.contentHash, fields: Object.fromEntries((p.fields ?? Object.keys(doc.structured)).map(field => [field, doc.structured[field as keyof typeof doc.structured]])) });
      } else {
       const outer = createDeadline(batchTimeoutMs([urls.length], config.concurrency, config.timeoutMs), signal);
       try {
        items.push(...await runDispatchedBatch(urls, config.concurrency, config.timeoutMs, outer, signal, async (url, itemDeadline) => {
         const page = await hooks.fetch(url, { mode: "readable", config, deadline: itemDeadline, byteBudget, signal: itemDeadline.signal, requestScopeKey, reader: p.reader, profile: p.profile }, "extract");
         if (page.error) return { url, error: page.error };
         const structured = page.artifact?.structured ?? extractDeterministic({ finalUrl: page.finalUrl, contentType: "text/markdown", body: page.content }).structured;
         return { url, receipt: page.receipt ?? null, fields: Object.fromEntries((p.fields ?? Object.keys(structured)).map(field => [field, structured[field as keyof typeof structured]])) };
        }, (url, error) => ({ url, error: errText(error) })));
       } finally { outer.dispose(); }
       counts.items = urls.length;
       counts.failed = items.filter(item => item !== null && typeof item === "object" && "error" in item).length;
       counts.successful = urls.length - counts.failed;
      }
      result = jsonResult({ items });
     } else if (name === "crawl") {
      const p = crawlParams.parse(params);
      if (p.action === "list") result = jsonResult(deps.jobs.list({ scope, cursor: p.cursor, limit: p.limit ?? 20 }));
      else if (p.action === "start") {
       if (!p.url) throw new Error("Crawl start requires url.");
       const job = deps.jobs.create({ scope, rootUrl: p.url, includePaths: p.includePaths ?? [], excludePaths: p.excludePaths ?? [], includeSubdomains: p.includeSubdomains ?? false, backend: p.backend ?? "local", limits: { maxPages: 25, maxDepth: 2, maxBytes: 20 * 1024 * 1024, maxDurationMs: 300000, concurrency: Math.min(2, config.concurrency), ...p.limits } });
       deps.jobs.wake(); deps.onChanged?.(scope); result = jsonResult(job);
      } else {
       if (!p.jobId) throw new Error("Crawl action requires jobId.");
       const job = deps.jobs.status(scope, p.jobId);
       if (!job) throw new Error(NOT_VISIBLE);
       if (p.action !== "cancel") resolvePolicy(config, { ...p, backend: job.backend }, "retrieval");
       result = jsonResult(p.action === "cancel" ? deps.jobs.cancel(scope, p.jobId) : p.action === "resume" ? deps.jobs.resume(scope, p.jobId, p.limits) : job);
       if (p.action !== "status") { deps.jobs.wake(); deps.onChanged?.(scope); }
      }
     } else {
      const p = diffParams.parse(params);
      let before: SnapshotDocument | undefined, after: SnapshotDocument | undefined;
      if (p.beforeSnapshotId) before = await readableSnapshot(scope, p.beforeSnapshotId, config);
      if (p.afterSnapshotId) after = await readableSnapshot(scope, p.afterSnapshotId, config);
      if (p.sourceId && !before && !p.url) {
       const pair = deps.sources.snapshotPair(scope, { sourceId: p.sourceId, afterId: p.afterSnapshotId });
       if (pair) { before = await readableSnapshot(scope, pair.before.id, config); after = await readableSnapshot(scope, pair.after.id, config); }
      } else if (p.sourceId && !before) {
       const id = deps.sources.get(scope, p.sourceId)?.latestSnapshot?.id;
       if (id) before = await readableSnapshot(scope, id, config);
      }
      if (p.url) {
       const page = await acquire(p.url, "diff");
       if (page.error || !page.artifact) throw new Error(page.error ?? "No retrieval artifact.");
       if (page.receipt?.snapshotId) after = await readableSnapshot(scope, page.receipt.snapshotId, config);
       else {
        const artifact = page.artifact;
        after = { id: "", sourceId: "", scope, contentHash: artifact.contentHash, snapshotHash: "", extractorId: artifact.extraction.id, extractorVersion: artifact.extraction.id, chars: artifact.content.length, bytes: artifact.bytes, truncated: artifact.completeness.state !== "complete", fetchedAt: Date.parse(artifact.fetchedAt), checkedAt: Date.now(), kind: artifact.kind, contentType: artifact.contentType, content: artifact.content, structured: artifact.structured ?? extractDeterministic({ finalUrl: artifact.finalUrl, contentType: "text/markdown", body: artifact.content }).structured, completeness: artifact.completeness, warnings: artifact.warnings };
       }
      }
      if (!before || !after) throw new Error("Diff requires two visible snapshots, a source with two snapshots, or a baseline and URL.");
      const diff = diffSnapshots(before, after, { maxHunks: p.maxHunks, maxChars: p.maxChars ?? 24000, signal: deadline.signal, deadlineAt: deadline.expiresAt });
      result = jsonResult({ ...diff, persisted: Boolean(after.id), ...(after.id ? {} : { afterSnapshotId: null, warning: "Comparison used in-memory content because capture was refused." }) });
     }
    } finally { deadline.dispose(); }
   }
   signal.throwIfAborted();
   status = counts.failed ? (counts.successful ? "partial" : "failure") : warnings.some(code => ["partial", "storage-limit", "policy-blocked"].includes(code)) ? "partial" : "success";
   return { ...result, text: boundOutput(result.text, "Narrow the request or use snapshot paging.").text, ...(status === "failure" ? { isError: true } : {}) };
  };
  const promise = work();
  pending.add(promise);
  try { return await promise; }
  catch (error) { if (signal.aborted) status = "cancelled"; warnings.push(signal.aborted ? "cancelled" : errText(error).includes("POLICY_BLOCKED") ? "policy-blocked" : "failure"); throw error; }
  finally { pending.delete(promise); scopeEntry.active--; if (scopeEntry.active === 0 && scopes.get(key) === scopeEntry) scopes.delete(key); diagnostics.record({ operation: name, status, provider, warnings, durationMs: Date.now() - started, stageMs: { ...stageMs, total: Date.now() - started }, counts, cache }); }
 }
 return {
  getConfig: deps.getConfig, resolveScope: deps.resolveScope, sources: deps.sources, jobs: deps.jobs, fenceScope, fenceAll() { for (const entry of scopes.values()) entry.controller.abort(new Error("Forage policy changed")); }, invalidate(scope) { deps.onChanged?.(scope); }, invalidateAll() { deps.onInvalidateAll?.(); }, allowRestrictedThreadCapture: deps.allowRestrictedThreadCapture, diagnostics,
  cache: { stats: cacheStats, clear() { cacheClear(); clearSearchCache(); } },
  executeSearch: (input, ctx) => execute("search", input, ctx), executeFetch: (input, ctx) => execute("fetch", input, ctx), executeMap: (input, ctx) => execute("map", input, ctx), executeExtract: (input, ctx) => execute("extract", input, ctx), executeCrawl: (input, ctx) => execute("crawl", input, ctx), executeDiff: (input, ctx) => execute("diff", input, ctx),
  async dispose() { disposed = true; controller.abort(new Error("Forage runtime disposed")); await Promise.allSettled([...pending]); cacheClear(); clearSearchCache(); },
 };
}
