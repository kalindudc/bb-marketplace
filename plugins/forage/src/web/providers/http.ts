import type { OperationContext } from "../contracts.ts";
import type { WebConfig } from "../config.ts";
import { mimeType, readBodyLimited, safeFetch, type SafeFetchOptions, type SafeFetchResult } from "../net.ts";

export const MAX_RETRY_AFTER_MS = 10 * 60_000;

export class ProviderHttpError extends Error {
	constructor(
		readonly provider: string,
		readonly status: number,
		message: string,
		readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = "ProviderHttpError";
	}
}

function capRetryAfter(value: number): number {
	return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, value));
}

export function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
	if (!value) return undefined;
	if (/^\d+(?:\.\d+)?$/.test(value.trim())) return capRetryAfter(Math.ceil(Number(value) * 1_000));
	const at = Date.parse(value);
	return Number.isFinite(at) ? capRetryAfter(at - now) : undefined;
}

export interface ProviderTransportOptions extends Omit<SafeFetchOptions, "method"> {
	method?: "GET" | "POST" | "DELETE";
}

export type ProviderTransport = (url: string, options: ProviderTransportOptions) => Promise<SafeFetchResult>;

const defaultProviderTransport: ProviderTransport = (url, options) => safeFetch(url, options as SafeFetchOptions);

export interface ProviderHttpRequest {
	provider: string;
	url: string;
	method?: "GET" | "POST" | "DELETE";
	headers?: Record<string, string>;
	body?: string;
	context: OperationContext;
	config: WebConfig;
	allowedRedirectOrigins: readonly string[];
}

export interface ProviderHttpResponse {
	status: number;
	text: string;
	contentType: string;
	headers: Headers;
	finalUrl: string;
}

export async function providerHttp(request: ProviderHttpRequest, transport: ProviderTransport = defaultProviderTransport): Promise<ProviderHttpResponse> {
	request.context.deadline.throwIfExpired(`${request.provider} dispatch`);
	const { response, finalUrl } = await transport(request.url, {
		method: request.method,
		body: request.body,
		signal: request.context.deadline.signal,
		deadline: request.context.deadline,
		byteBudget: request.context.byteBudget,
		timeoutMs: request.config.timeoutMs,
		maxBytes: request.config.maxResponseBytes,
		headers: { "User-Agent": request.config.userAgent, ...request.headers },
		credentialed: Object.keys(request.headers ?? {}).some((name) => /authorization|api-key|subscription-token/i.test(name)),
		allowedRedirectOrigins: request.allowedRedirectOrigins,
	});
	const bytes = await readBodyLimited(response, request.config.maxResponseBytes, request.context.deadline.signal, request.context.byteBudget);
	const text = new TextDecoder().decode(bytes);
	if (response.status < 200 || response.status >= 300) {
		const retryAfterMs = response.status === 429 ? parseRetryAfterMs(response.headers.get("retry-after")) ?? 60_000 : undefined;
		throw new ProviderHttpError(request.provider, response.status, `${request.provider} returned HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`, retryAfterMs);
	}
	return { status: response.status, text, contentType: mimeType(response.headers.get("content-type")), headers: response.headers, finalUrl };
}

export async function providerJson<T>(request: ProviderHttpRequest, transport?: ProviderTransport): Promise<{ data: T; response: ProviderHttpResponse }> {
	const response = await providerHttp(request, transport);
	if (!response.contentType.includes("json") && !response.text.trim().startsWith("{") && !response.text.trim().startsWith("[")) {
		throw new ProviderHttpError(request.provider, response.status, `${request.provider} returned a non-JSON response`);
	}
	try {
		return { data: JSON.parse(response.text) as T, response };
	} catch {
		throw new ProviderHttpError(request.provider, response.status, `${request.provider} returned invalid JSON`);
	}
}
