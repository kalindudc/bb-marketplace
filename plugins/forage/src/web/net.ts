/**
 * Network layer: SSRF-guarded fetch with manual redirect following,
 * timeouts, and size-limited body reads. Node built-ins only.
 *
 * Every hop (initial request and each redirect) is validated:
 *   - scheme must be http: or https:
 *   - hostname must resolve only to public addresses (unless allowPrivateNetwork)
 *   - the TCP connection is pinned to the addresses that passed validation
 *     (no second DNS lookup), so DNS rebinding cannot bypass the check
 */

import { lookup } from "node:dns/promises";
import { type ClientRequest, type IncomingMessage, request as httpRequest } from "node:http";
import { type RequestOptions as HttpsRequestOptions, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable, type Transform } from "node:stream";
import * as zlib from "node:zlib";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { AccessDescriptor, ByteBudget, Deadline } from "./contracts.ts";
import { ByteBudgetError, createDeadline, DeadlineError } from "./deadline.ts";

export interface SafeFetchOptions {
	signal?: AbortSignal;
	timeoutMs: number;
	maxBytes: number;
	headers?: Record<string, string>;
	method?: "GET" | "POST";
	body?: string;
	allowPrivateNetwork?: boolean;
	maxRedirects?: number;
	deadline?: Deadline;
	byteBudget?: ByteBudget;
	credentialed?: boolean;
	requestScopeKey?: string | null;
	allowedRedirectOrigins?: readonly string[];
	beforeRedirect?: (input: { fromUrl: string; toUrl: string; status: number; signal: AbortSignal; deadline: Deadline }) => Promise<void>;
	/** Custom DNS resolver (tests). Connections are pinned to whatever it returns. */
	resolver?: Resolver;
}

export interface SafeFetchResult {
	response: Response;
	/** Final URL after redirects. */
	finalUrl: string;
	redirects: number;
	access: AccessDescriptor;
	acceptedRedirectBytes: number;
}

export type NetErrorKind = "blocked" | "timeout" | "too-large" | "budget" | "redirect" | "network" | "aborted";

export class NetError extends Error {
	readonly kind: NetErrorKind;
	constructor(message: string, kind: NetErrorKind) {
		super(message);
		this.name = "NetError";
		this.kind = kind;
	}
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

/** True when an IPv4 address is loopback/private/link-local/multicast/reserved. */
export function isBlockedIPv4(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
	const [a, b] = parts as [number, number, number, number];
	return (
		a === 0 || // "this" network
		a === 10 || // private
		a === 127 || // loopback
		(a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
		(a === 169 && b === 254) || // link-local / cloud metadata
		(a === 172 && b >= 16 && b <= 31) || // private
		(a === 192 && b === 0 && parts[2] === 0) || // IETF protocol assignments
		(a === 192 && b === 0 && parts[2] === 2) || // TEST-NET-1
		(a === 192 && b === 168) || // private
		(a === 198 && (b === 18 || b === 19)) || // benchmarking
		(a === 198 && b === 51 && parts[2] === 100) || // TEST-NET-2
		(a === 203 && b === 0 && parts[2] === 113) || // TEST-NET-3
		a >= 224 // multicast + reserved + broadcast
	);
}

/** Expand an IPv6 address into 8 16-bit groups. Returns null when malformed. */
export function parseIPv6(address: string): number[] | null {
	let addr = address;
	const zone = addr.indexOf("%");
	if (zone !== -1) addr = addr.slice(0, zone);

	// Embedded IPv4 tail (e.g. ::ffff:127.0.0.1)
	if (addr.includes(".")) {
		const lastColon = addr.lastIndexOf(":");
		const v4 = addr.slice(lastColon + 1);
		if (isIP(v4) !== 4) return null;
		const o = v4.split(".").map(Number);
		addr = `${addr.slice(0, lastColon)}:${(((o[0] ?? 0) << 8) | (o[1] ?? 0)).toString(16)}:${(((o[2] ?? 0) << 8) | (o[3] ?? 0)).toString(16)}`;
	}

	const halves = addr.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
	const groups = [...head, ...Array(missing).fill("0"), ...tail].map((g) => parseInt(g, 16));
	if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
	return groups;
}

/** True when an IPv6 address is loopback/unspecified/ULA/link-local/multicast or maps to a blocked IPv4. */
export function isBlockedIPv6(address: string): boolean {
	const g = parseIPv6(address);
	if (!g) return true;
	if (g.every((x) => x === 0)) return true; // ::
	if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
	const first = g[0] ?? 0;
	if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
	if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
	if (first === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation
	const hasIPv4Tail = g.slice(0, 6).every((x) => x === 0)
		|| (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)
		|| (first === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0));
	if (hasIPv4Tail) {
		const v4 = [(g[6] ?? 0) >> 8, (g[6] ?? 0) & 0xff, (g[7] ?? 0) >> 8, (g[7] ?? 0) & 0xff].join(".");
		return isBlockedIPv4(v4);
	}
	if (first === 0x2002) {
		const v4 = [(g[1] ?? 0) >> 8, (g[1] ?? 0) & 0xff, (g[2] ?? 0) >> 8, (g[2] ?? 0) & 0xff].join(".");
		return isBlockedIPv4(v4);
	}
	return false;
}

export function isBlockedAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return isBlockedIPv4(address);
	if (family === 6) return isBlockedIPv6(address);
	return true;
}

export function mergeNetworkAccess(current: "public" | "private", next: "public" | "private"): "public" | "private" {
	return current === "private" || next === "private" ? "private" : "public";
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

export type LookupAddress = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolver: Resolver = async (hostname) => lookup(hostname, { all: true, verbatim: true });

export interface VettedUrl {
	url: URL;
	/**
	 * Addresses the hostname resolved to (and was validated against). The
	 * connection is pinned to exactly these, so a second, independent DNS
	 * answer (rebinding) can never redirect the request.
	 */
	addresses: LookupAddress[];
	network: "public" | "private";
}

function bareHostname(url: URL): string {
	const h = url.hostname.toLowerCase();
	return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

/**
 * Validate that a URL is safe to request and resolve its addresses once.
 * Throws NetError("blocked") for disallowed schemes/hosts/addresses.
 */
export async function vetUrl(
	rawUrl: string | URL,
	options: { allowPrivateNetwork?: boolean; resolver?: Resolver; signal?: AbortSignal; deadline?: Deadline } = {},
): Promise<VettedUrl> {
	let url: URL;
	try {
		url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
	} catch {
		throw new NetError(`Invalid URL: ${String(rawUrl)}`, "blocked");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new NetError(`Unsupported URL scheme "${url.protocol}" (only http/https are allowed)`, "blocked");
	}
	if (url.username || url.password) {
		throw new NetError("URLs with embedded credentials are not allowed", "blocked");
	}
	const allowPrivate = options.allowPrivateNetwork ?? false;
	const hostname = bareHostname(url);

	const literal = isIP(hostname);
	if (literal) {
		if (!allowPrivate && isBlockedAddress(hostname)) {
			throw new NetError(`Blocked address ${hostname} (private/loopback/link-local). Set allowPrivateNetwork to permit.`, "blocked");
		}
		return { url, addresses: [{ address: hostname, family: literal }], network: isBlockedAddress(hostname) ? "private" : "public" };
	}

	if (!allowPrivate && (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal"))) {
		throw new NetError(`Blocked hostname "${hostname}" (local network). Set allowPrivateNetwork to permit.`, "blocked");
	}

	let addresses: LookupAddress[];
	try {
		addresses = await awaitStage((options.resolver ?? defaultResolver)(hostname), options.signal, options.deadline, "DNS lookup");
	} catch (err) {
		if (err instanceof DeadlineError || (options.deadline?.signal.aborted && options.deadline.remainingMs() <= 0)) {
			throw new NetError(`Request timed out during DNS lookup for ${hostname}`, "timeout");
		}
		if (options.signal?.aborted || options.deadline?.signal.aborted) throw new NetError("Request cancelled", "aborted");
		throw new NetError(`DNS lookup failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`, "network");
	}
	addresses = addresses.filter((a) => isIP(a.address));
	if (addresses.length === 0) throw new NetError(`DNS lookup returned no addresses for ${hostname}`, "network");
	if (!allowPrivate) {
		for (const { address } of addresses) {
			if (isBlockedAddress(address)) {
				throw new NetError(
					`Blocked: ${hostname} resolves to ${address} (private/loopback/link-local). Set allowPrivateNetwork to permit.`,
					"blocked",
				);
			}
		}
	}
	return { url, addresses, network: addresses.some(({ address }) => isBlockedAddress(address)) ? "private" : "public" };
}

/** Validate a URL (see vetUrl) and return the parsed URL. */
export async function validateUrl(
	rawUrl: string | URL,
	options: { allowPrivateNetwork?: boolean; resolver?: Resolver; signal?: AbortSignal; deadline?: Deadline } = {},
): Promise<URL> {
	return (await vetUrl(rawUrl, options)).url;
}

// ---------------------------------------------------------------------------
// Fetch (node:http/https with pinned DNS)
// ---------------------------------------------------------------------------
//
// Node's global fetch offers no hook to pin the connection to the addresses we
// validated, so a hostname could resolve to a public IP during validation and
// to 127.0.0.1 at connect time (DNS rebinding). Using http/https.request with a
// custom `lookup` closes that gap without any dependency: the socket connects
// to exactly the vetted addresses while Host/SNI/certificate checks still use
// the hostname.

function awaitStage<T>(promise: Promise<T>, signal?: AbortSignal, deadline?: Deadline, stage = "operation"): Promise<T> {
	if (!signal && !deadline) return promise;
	return new Promise((resolve, reject) => {
		let settled = false;
		const activeSignal = signal && deadline ? AbortSignal.any([signal, deadline.signal]) : signal ?? deadline?.signal;
		const finish = (error?: unknown, value?: T) => {
			if (settled) return;
			settled = true;
			activeSignal?.removeEventListener("abort", onAbort);
			if (error !== undefined) reject(error);
			else resolve(value as T);
		};
		const onAbort = () => {
			if (deadline && deadline.remainingMs() <= 0) finish(new DeadlineError(stage));
			else finish(activeSignal?.reason instanceof Error ? activeSignal.reason : new Error(`${stage} cancelled`));
		};
		if (activeSignal?.aborted) onAbort();
		else activeSignal?.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => finish(undefined, value), (error) => finish(error));
	});
}

type LookupCallback = ((err: Error | null, address: string, family: number) => void) & ((err: Error | null, addresses: LookupAddress[]) => void);
type LookupFunction = (hostname: string, options: { all?: boolean; family?: number | string }, callback: LookupCallback) => void;

/** A `lookup` implementation for net.connect that only ever answers with the vetted addresses. */
export function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
	return (_hostname, options, callback) => {
		const wantFamily = options?.family === 4 || options?.family === "IPv4" ? 4 : options?.family === 6 || options?.family === "IPv6" ? 6 : 0;
		const filtered = wantFamily ? addresses.filter((a) => a.family === wantFamily) : addresses;
		const list = (filtered.length ? filtered : addresses).map((a) => ({ address: a.address, family: a.family }));
		if (options?.all) {
			callback(null, list);
		} else {
			const first = list.find((a) => a.family === 4) ?? list[0]!;
			callback(null, first.address, first.family);
		}
	};
}

/** Signals associated with responses so body readers can classify aborts. */
const responseSignals = new WeakMap<Response, { combined: AbortSignal; external?: AbortSignal; timeoutMs: number; ownedDeadline?: Deadline }>();

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function decodeStream(res: IncomingMessage, headers: Headers): Readable {
	const encoding = (res.headers["content-encoding"] ?? "").toLowerCase().trim();
	let decoder: Transform | null = null;
	if (encoding === "gzip" || encoding === "x-gzip") decoder = createGunzip();
	else if (encoding === "deflate") decoder = createInflate();
	else if (encoding === "br") decoder = createBrotliDecompress();
	else if (encoding === "zstd" && typeof (zlib as { createZstdDecompress?: () => Transform }).createZstdDecompress === "function") {
		decoder = (zlib as unknown as { createZstdDecompress: () => Transform }).createZstdDecompress();
	}
	if (!decoder) return res;
	headers.delete("content-encoding");
	headers.delete("content-length");
	res.on("error", (err) => decoder!.destroy(err));
	res.pipe(decoder);
	// Destroying the decoded stream (consumer cancel) must also release the socket.
	decoder.on("close", () => {
		if (!res.destroyed) res.destroy();
	});
	return decoder;
}

interface RequestInit {
	method: "GET" | "POST";
	headers: Record<string, string>;
	body?: string;
	signal: AbortSignal;
}

function performRequest(vetted: VettedUrl, init: RequestInit): Promise<Response> {
	const { url, addresses } = vetted;
	const isHttps = url.protocol === "https:";
	const hostname = bareHostname(url);
	const headers: Record<string, string> = { "accept-encoding": "gzip, deflate, br" };
	for (const [k, v] of Object.entries(init.headers)) headers[k.toLowerCase()] = v;
	if (init.body !== undefined) headers["content-length"] = String(Buffer.byteLength(init.body));

	return new Promise((resolve, reject) => {
		if (init.signal.aborted) {
			reject(init.signal.reason instanceof Error ? init.signal.reason : new Error("aborted"));
			return;
		}
		const requestOptions: HttpsRequestOptions = {
			protocol: url.protocol,
			hostname,
			port: url.port ? Number(url.port) : isHttps ? 443 : 80,
			path: `${url.pathname}${url.search}`,
			method: init.method,
			headers,
			signal: init.signal,
			lookup: pinnedLookup(addresses) as unknown as HttpsRequestOptions["lookup"],
			...(isHttps && !isIP(hostname) ? { servername: hostname } : {}),
		};
		let req: ClientRequest;
		try {
			req = (isHttps ? httpsRequest : httpRequest)(requestOptions, (res) => {
				const status = res.statusCode ?? 0;
				if (status < 200 || status > 599) {
					res.destroy();
					reject(new NetError(`Unexpected HTTP status ${status} from ${url.host}`, "network"));
					return;
				}
				const responseHeaders = new Headers();
				for (const [key, value] of Object.entries(res.headers)) {
					if (value === undefined) continue;
					if (Array.isArray(value)) for (const v of value) responseHeaders.append(key, v);
					else responseHeaders.set(key, value);
				}
				if (NULL_BODY_STATUSES.has(status)) {
					res.resume();
					resolve(new Response(null, { status, statusText: res.statusMessage ?? "", headers: responseHeaders }));
					return;
				}
				const stream = decodeStream(res, responseHeaders);
				resolve(new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, statusText: res.statusMessage ?? "", headers: responseHeaders }));
			});
		} catch (err) {
			reject(err);
			return;
		}
		req.on("error", reject);
		if (init.body !== undefined) req.write(init.body);
		req.end();
	});
}

function describeNetworkError(err: unknown): string {
	const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
	return e?.code ?? e?.cause?.code ?? e?.cause?.message ?? (err instanceof Error ? err.message : String(err));
}

function isDeadlineAbort(signal: AbortSignal | undefined): boolean {
	return signal?.reason instanceof DeadlineError;
}

/**
 * Fetch with SSRF validation and DNS pinning on every hop. Redirects are
 * followed manually so each Location is re-validated and re-pinned. The
 * returned Response body is unread.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
	const maxRedirects = options.maxRedirects ?? 5;
	const ownedDeadline = options.deadline ? undefined : createDeadline(options.timeoutMs, options.signal);
	const deadline = options.deadline ?? ownedDeadline!;
	const signal = options.signal && options.deadline ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
	const vetOptions = { allowPrivateNetwork: options.allowPrivateNetwork, resolver: options.resolver, signal, deadline };
	const allowedOrigins = options.allowedRedirectOrigins ? new Set(options.allowedRedirectOrigins.map((origin) => new URL(origin).origin)) : undefined;
	let headers = { ...(options.headers ?? {}) };
	const credentialed = options.credentialed === true || hasCredentialHeaders(headers);
	let method: "GET" | "POST" = options.method ?? "GET";
	let body = options.body;
	let redirects = 0;
	let acceptedRedirectBytes = 0;
	let network: "public" | "private" = "public";
	let handedOff = false;
	try {
		let vetted = await vetUrl(rawUrl, vetOptions);
		network = vetted.network;
		for (;;) {
			deadline.throwIfExpired("request");
			const url = vetted.url;
			let response: Response;
			try {
				response = await performRequest(vetted, { method, headers, body, signal });
			} catch (err) {
				if (err instanceof NetError) throw err;
				if (isDeadlineAbort(options.signal) || deadline.remainingMs() <= 0) throw new NetError(`Request timed out after ${Math.round(options.timeoutMs / 1000)}s: ${url.host}`, "timeout");
				if (options.signal?.aborted) throw new NetError("Request cancelled", "aborted");
				if (deadline.signal.aborted) throw new NetError(`Request timed out after ${Math.round(options.timeoutMs / 1000)}s: ${url.host}`, "timeout");
				throw new NetError(`Network error fetching ${url.host}: ${describeNetworkError(err)}`, "network");
			}

			if (REDIRECT_STATUSES.has(response.status)) {
				const location = response.headers.get("location");
				const redirectBytes = await readBodyLimited(response, options.maxBytes, signal, options.byteBudget);
				acceptedRedirectBytes += redirectBytes.byteLength;
				if (!location) throw new NetError(`Redirect (${response.status}) without Location header from ${url.host}`, "redirect");
				if (redirects >= maxRedirects) throw new NetError(`Too many redirects (>${maxRedirects}) starting from ${rawUrl}`, "redirect");
				let next: URL;
				try {
					next = new URL(location, url);
				} catch {
					throw new NetError(`Invalid redirect Location "${location}"`, "redirect");
				}
				const originChanged = next.origin !== url.origin;
				if (allowedOrigins && !allowedOrigins.has(next.origin)) throw new NetError(`Redirect origin ${next.origin} is outside the allowed redirect origin ceiling`, "redirect");
				if (originChanged && (response.status === 307 || response.status === 308) && body !== undefined) {
					throw new NetError(`Cross-origin body-preserving redirect (${response.status}) is not allowed`, "redirect");
				}
				if (credentialed && url.protocol === "https:" && next.protocol === "http:") {
					throw new NetError("Credentialed HTTPS requests cannot redirect to HTTP", "redirect");
				}
				if (originChanged) headers = crossOriginHeaders(headers);
				vetted = await vetUrl(next, vetOptions);
				if (options.beforeRedirect) await awaitStage(options.beforeRedirect({ fromUrl: url.href, toUrl: vetted.url.href, status: response.status, signal, deadline }), signal, deadline, "redirect policy");
				deadline.throwIfExpired("redirect policy");
				network = mergeNetworkAccess(network, vetted.network);
				redirects++;
				if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
					method = "GET";
					body = undefined;
				}
				continue;
			}

			responseSignals.set(response, { combined: signal, external: options.signal, timeoutMs: options.timeoutMs, ownedDeadline });
			handedOff = true;
			return {
				response,
				finalUrl: url.href,
				redirects,
				access: { network, credentialed, requestScopeKey: options.requestScopeKey ?? null },
				acceptedRedirectBytes,
			};
		}
	} catch (err) {
		if (err instanceof DeadlineError) throw new NetError(`Request timed out during ${err.stage}`, "timeout");
		throw err;
	} finally {
		if (!handedOff) ownedDeadline?.dispose();
	}
}

/**
 * Read a response body as bytes, aborting once `maxBytes` is exceeded.
 */
export async function readBodyLimited(response: Response, maxBytes: number, signal?: AbortSignal, byteBudget?: ByteBudget): Promise<Uint8Array> {
	const meta = responseSignals.get(response);
	const declared = Number(response.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel().catch(() => {});
		meta?.ownedDeadline?.dispose();
		throw new NetError(`Response too large: ${formatBytes(declared)} exceeds limit of ${formatBytes(maxBytes)}`, "too-large");
	}
	if (!response.body) {
		meta?.ownedDeadline?.dispose();
		return new Uint8Array(0);
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			if (signal?.aborted) throw new NetError("Request cancelled", "aborted");
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				total += value.byteLength;
				if (total > maxBytes) {
					throw new NetError(`Response too large: exceeded limit of ${formatBytes(maxBytes)} while streaming`, "too-large");
				}
				byteBudget?.consume(value.byteLength);
				chunks.push(value);
			}
		}
	} catch (err) {
		if (err instanceof NetError) throw err;
		if (err instanceof ByteBudgetError) throw new NetError(err.message, "budget");
		if (isDeadlineAbort(signal) || isDeadlineAbort(meta?.external)) {
			throw new NetError(`Request timed out after ${Math.round((meta?.timeoutMs ?? 0) / 1000)}s while reading the response`, "timeout");
		}
		if (signal?.aborted || meta?.external?.aborted) throw new NetError("Request cancelled", "aborted");
		if (meta?.combined.aborted) throw new NetError(`Request timed out after ${Math.round(meta.timeoutMs / 1000)}s while reading the response`, "timeout");
		throw new NetError(`Failed reading response body: ${describeNetworkError(err)}`, "network");
	} finally {
		reader.cancel().catch(() => {});
		meta?.ownedDeadline?.dispose();
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

/** Decode bytes to text honoring the charset from Content-Type (falls back to UTF-8). */
export function decodeText(bytes: Uint8Array, contentType: string | null): string {
	const match = /charset=["']?([\w-]+)/i.exec(contentType ?? "");
	const charset = match?.[1]?.toLowerCase();
	if (charset && charset !== "utf-8" && charset !== "utf8") {
		try {
			return new TextDecoder(charset).decode(bytes);
		} catch {
			// unsupported label — fall through to UTF-8
		}
	}
	return new TextDecoder("utf-8").decode(bytes);
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Split Content-Type into a lowercase mime type (no parameters). */
export function mimeType(contentType: string | null): string {
	return (contentType ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

const CROSS_ORIGIN_HEADER_ALLOWLIST = new Set(["accept", "accept-language", "cache-control", "pragma", "user-agent"]);

function hasCredentialHeaders(headers: Record<string, string>): boolean {
	return Object.keys(headers).some((name) => {
		const key = name.toLowerCase();
		return key === "authorization" || key === "cookie" || key === "proxy-authorization" || key.includes("api-key") || key.includes("subscription-token") || key.includes("access-token");
	});
}

function crossOriginHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(headers).filter(([name]) => CROSS_ORIGIN_HEADER_ALLOWLIST.has(name.toLowerCase())));
}

export interface LimitOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	deadline?: Deadline;
}

/** Minimal concurrency limiter (replacement for p-limit). */
export function createLimiter(concurrency: number): <T>(task: () => Promise<T>, options?: LimitOptions) => Promise<T> {
	let active = 0;
	const queue: Array<() => void> = [];
	const next = () => {
		active--;
		queue.shift()?.();
	};
	return function limit<T>(task: () => Promise<T>, options: LimitOptions = {}): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const ownedDeadline = options.deadline || options.timeoutMs === undefined ? undefined : createDeadline(options.timeoutMs, options.signal);
			const deadline = options.deadline ?? ownedDeadline;
			const signal = options.signal && deadline ? AbortSignal.any([options.signal, deadline.signal]) : options.signal ?? deadline?.signal;
			let started = false;
			let settled = false;
			const finish = (error?: unknown, value?: T) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				ownedDeadline?.dispose();
				if (error !== undefined) reject(error);
				else resolve(value as T);
			};
			const onAbort = () => {
				if (!started) finish(deadline && deadline.remainingMs() <= 0 ? new DeadlineError("limiter queue") : new Error("Limiter task cancelled"));
			};
			const run = () => {
				if (settled) {
					queue.shift()?.();
					return;
				}
				try {
					deadline?.throwIfExpired("limiter queue");
				} catch (error) {
					finish(error);
					queue.shift()?.();
					return;
				}
				started = true;
				active++;
				task().then((value) => finish(undefined, value), (error) => finish(error)).finally(next);
			};
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			if (!settled) {
				if (active < Math.max(1, concurrency)) run();
				else queue.push(run);
			}
		});
	};
}
