/** Resolved web configuration. This module never reads process environment or files. */

import { PROFILE_NAMES, PRIVACY_PROFILES, type PrivacyProfileName, type SearchProfileName } from "../profiles.ts";

export const SEARCH_PROVIDERS = ["auto", "duckduckgo", "exa", "brave", "searxng", "tavily"] as const;
export type SearchProviderName = (typeof SEARCH_PROVIDERS)[number];
export type ConcreteSearchProvider = Exclude<SearchProviderName, "auto">;

export const READER_PROVIDERS = ["direct", "tavily", "firecrawl", "jina"] as const;
export type ReaderProviderName = (typeof READER_PROVIDERS)[number];

export const CRAWL_BACKENDS = ["local", "firecrawl"] as const;
export type CrawlBackendName = (typeof CRAWL_BACKENDS)[number];

export interface WebConfig {
	provider: SearchProviderName;
	profile: SearchProfileName;
	privacyProfile: PrivacyProfileName;
	allowedProviders: ConcreteSearchProvider[];
	allowedReaders: ReaderProviderName[];
	allowedBackends: CrawlBackendName[];
	allowPaidProviderFallback: boolean;
	braveApiKey?: string;
	exaApiKey?: string;
	tavilyApiKey?: string;
	firecrawlApiKey?: string;
	jinaApiKey?: string;
	searxngUrl?: string;
	allowPrivateNetwork: boolean;
	allowRestrictedThreadCapture: boolean;
	timeoutMs: number;
	maxChars: number;
	maxResponseBytes: number;
	userAgent: string;
	concurrency: number;
	searchCacheTtlMs: number;
	searchCacheMaxEntries: number;
	warnings: string[];
}

export const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 forage/0.2";

export const CONFIG_DEFAULTS = {
	provider: "auto" as SearchProviderName,
	profile: "auto" as SearchProfileName,
	privacyProfile: "standard" as PrivacyProfileName,
	allowedProviders: ["duckduckgo", "exa", "brave", "searxng", "tavily"] as ConcreteSearchProvider[],
	allowedReaders: ["direct", "tavily", "firecrawl", "jina"] as ReaderProviderName[],
	allowedBackends: ["local", "firecrawl"] as CrawlBackendName[],
	allowPaidProviderFallback: false,
	allowPrivateNetwork: false,
	allowRestrictedThreadCapture: false,
	timeoutMs: 20_000,
	maxChars: 30_000,
	maxResponseBytes: 5 * 1024 * 1024,
	userAgent: DEFAULT_USER_AGENT,
	concurrency: 4,
	searchCacheTtlMs: 5 * 60_000,
	searchCacheMaxEntries: 128,
};

export interface WebConfigValues {
	provider?: unknown;
	profile?: unknown;
	privacyProfile?: unknown;
	allowedProviders?: unknown;
	allowedReaders?: unknown;
	allowedBackends?: unknown;
	allowPaidProviderFallback?: unknown;
	braveApiKey?: unknown;
	exaApiKey?: unknown;
	tavilyApiKey?: unknown;
	firecrawlApiKey?: unknown;
	jinaApiKey?: unknown;
	searxngUrl?: unknown;
	allowPrivateNetwork?: unknown;
	allowRestrictedThreadCapture?: unknown;
	timeoutMs?: unknown;
	maxChars?: unknown;
	concurrency?: unknown;
	userAgent?: unknown;
	searchCacheTtlMs?: unknown;
	searchCacheMaxEntries?: unknown;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asPositiveInt(value: unknown, warnings: string[], field: string): number | undefined {
	if (value === undefined || value === "") return undefined;
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n === "number" && Number.isFinite(n) && n > 0) return Math.floor(n);
	warnings.push(`${field}: expected a positive number, got ${JSON.stringify(value)}`);
	return undefined;
}

function boundedInt(value: unknown, warnings: string[], field: string, fallback: number, min: number, max: number): number {
	const parsed = asPositiveInt(value, warnings, field);
	if (parsed === undefined) return fallback;
	if (parsed < min || parsed > max) warnings.push(`${field}: clamped ${parsed} to ${Math.min(max, Math.max(min, parsed))}`);
	return Math.min(max, Math.max(min, parsed));
}

function asBool(value: unknown, warnings: string[], field: string): boolean | undefined {
	if (value === undefined || value === "") return undefined;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const v = value.trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(v)) return true;
		if (["0", "false", "no", "off"].includes(v)) return false;
	}
	warnings.push(`${field}: expected a boolean, got ${JSON.stringify(value)}`);
	return undefined;
}

function asEnum<T extends string>(value: unknown, choices: readonly T[], warnings: string[], field: string): T | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if ((choices as readonly string[]).includes(normalized)) return normalized as T;
	}
	warnings.push(`${field}: expected one of ${choices.join("|")}, got ${JSON.stringify(value)}`);
	return undefined;
}

function asList<T extends string>(
	value: unknown,
	choices: readonly T[],
	warnings: string[],
	field: string,
	defaultValue: readonly T[],
	invalidFallback: readonly T[],
): T[] {
	if (value === undefined) return [...defaultValue];
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const normalized = raw.map((item) => typeof item === "string" ? item.trim().toLowerCase() : "").filter(Boolean);
	const valid = normalized.filter((item): item is T => (choices as readonly string[]).includes(item));
	if (normalized.length === 0 || valid.length !== normalized.length) {
		warnings.push(`${field}: expected a comma-separated subset of ${choices.join("|")}, got ${JSON.stringify(value)}`);
	}
	return [...new Set(valid.length > 0 ? valid : invalidFallback)];
}

export function resolveConfig(values: WebConfigValues = {}): WebConfig {
	const warnings: string[] = [];
	const rawSearxngUrl = asString(values.searxngUrl);
	const searxngUrl = rawSearxngUrl && /^https?:\/\//i.test(rawSearxngUrl) ? rawSearxngUrl.replace(/\/+$/, "") : undefined;
	if (rawSearxngUrl && !searxngUrl) warnings.push("searxngUrl must start with http:// or https://");
	return {
		provider: asEnum(values.provider, SEARCH_PROVIDERS, warnings, "provider") ?? CONFIG_DEFAULTS.provider,
		profile: asEnum(values.profile, PROFILE_NAMES, warnings, "profile") ?? CONFIG_DEFAULTS.profile,
		privacyProfile: values.privacyProfile === undefined
			? CONFIG_DEFAULTS.privacyProfile
			: asEnum(values.privacyProfile, PRIVACY_PROFILES, warnings, "privacyProfile") ?? "private",
		allowedProviders: asList(
			values.allowedProviders,
			SEARCH_PROVIDERS.slice(1) as readonly ConcreteSearchProvider[],
			warnings,
			"allowedProviders",
			CONFIG_DEFAULTS.allowedProviders,
			["duckduckgo", "exa"],
		),
		allowedReaders: asList(values.allowedReaders, READER_PROVIDERS, warnings, "allowedReaders", CONFIG_DEFAULTS.allowedReaders, ["direct"]),
		allowedBackends: asList(values.allowedBackends, CRAWL_BACKENDS, warnings, "allowedBackends", CONFIG_DEFAULTS.allowedBackends, ["local"]),
		allowPaidProviderFallback: asBool(values.allowPaidProviderFallback, warnings, "allowPaidProviderFallback") ?? CONFIG_DEFAULTS.allowPaidProviderFallback,
		braveApiKey: asString(values.braveApiKey),
		exaApiKey: asString(values.exaApiKey),
		tavilyApiKey: asString(values.tavilyApiKey),
		firecrawlApiKey: asString(values.firecrawlApiKey),
		jinaApiKey: asString(values.jinaApiKey),
		searxngUrl,
		allowPrivateNetwork: asBool(values.allowPrivateNetwork, warnings, "allowPrivateNetwork") ?? CONFIG_DEFAULTS.allowPrivateNetwork,
		allowRestrictedThreadCapture: asBool(values.allowRestrictedThreadCapture, warnings, "allowRestrictedThreadCapture") ?? false,
		timeoutMs: boundedInt(values.timeoutMs, warnings, "timeoutMs", CONFIG_DEFAULTS.timeoutMs, 1_000, 120_000),
		maxChars: boundedInt(values.maxChars, warnings, "maxChars", CONFIG_DEFAULTS.maxChars, 200, 200_000),
		maxResponseBytes: CONFIG_DEFAULTS.maxResponseBytes,
		userAgent: asString(values.userAgent) ?? CONFIG_DEFAULTS.userAgent,
		concurrency: boundedInt(values.concurrency, warnings, "concurrency", CONFIG_DEFAULTS.concurrency, 1, 8),
		searchCacheTtlMs: boundedInt(values.searchCacheTtlMs, warnings, "searchCacheTtlMs", CONFIG_DEFAULTS.searchCacheTtlMs, 1_000, 60 * 60_000),
		searchCacheMaxEntries: boundedInt(values.searchCacheMaxEntries, warnings, "searchCacheMaxEntries", CONFIG_DEFAULTS.searchCacheMaxEntries, 1, 256),
		warnings,
	};
}

export function maskSecret(secret: string | undefined): string {
	if (!secret) return "(not set)";
	if (secret.length <= 8) return "*".repeat(secret.length);
	return `${secret.slice(0, 4)}${"*".repeat(Math.min(12, secret.length - 6))}${secret.slice(-2)}`;
}
