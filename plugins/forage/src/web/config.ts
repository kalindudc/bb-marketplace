/**
 * Forage configuration.
 *
 * The web engine is configured from a single resolved `WebConfig`. The bb
 * plugin settings (see ../settings.ts) are the source of values; nothing here
 * reads the filesystem or the environment, so the engine stays portable and
 * testable on its own.
 */

export const SEARCH_PROVIDERS = ["auto", "duckduckgo", "exa", "brave", "searxng"] as const;
export type SearchProviderName = (typeof SEARCH_PROVIDERS)[number];

export interface WebConfig {
	/** Default search provider. `auto` = brave (if key) → searxng (if url) → duckduckgo → exa (both keyless). */
	provider: SearchProviderName;
	/** Brave Search API key (https://brave.com/search/api/). */
	braveApiKey?: string;
	/** Base URL of a SearXNG instance with the JSON format enabled. */
	searxngUrl?: string;
	/** Allow fetching loopback / private / link-local addresses (default false). */
	allowPrivateNetwork: boolean;
	/** Per-request timeout in milliseconds. */
	timeoutMs: number;
	/** Default max characters of page content returned per URL. */
	maxChars: number;
	/** Hard cap on downloaded response bytes. */
	maxResponseBytes: number;
	/** User-Agent header sent with every request. */
	userAgent: string;
	/** Max concurrent network operations per tool call. */
	concurrency: number;
	/** Non-fatal problems found while resolving settings (reported by `bb forage status`). */
	warnings: string[];
}

export const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 forage/0.1";

export const CONFIG_DEFAULTS = {
	provider: "auto" as SearchProviderName,
	allowPrivateNetwork: false,
	timeoutMs: 20_000,
	maxChars: 30_000,
	maxResponseBytes: 5 * 1024 * 1024,
	userAgent: DEFAULT_USER_AGENT,
	concurrency: 4,
};

/** Raw values as they arrive from bb settings (strings, numbers, booleans). */
export interface WebConfigValues {
	provider?: unknown;
	braveApiKey?: unknown;
	searxngUrl?: unknown;
	allowPrivateNetwork?: unknown;
	timeoutMs?: unknown;
	maxChars?: unknown;
	concurrency?: unknown;
	userAgent?: unknown;
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

function asProvider(value: unknown, warnings: string[], field: string): SearchProviderName | undefined {
	if (value === undefined || value === "") return undefined;
	if (typeof value === "string" && (SEARCH_PROVIDERS as readonly string[]).includes(value.trim().toLowerCase())) {
		return value.trim().toLowerCase() as SearchProviderName;
	}
	warnings.push(`${field}: expected one of ${SEARCH_PROVIDERS.join("|")}, got ${JSON.stringify(value)}`);
	return undefined;
}

/** Coerce raw settings into a complete config, collecting non-fatal problems. */
export function resolveConfig(values: WebConfigValues = {}): WebConfig {
	const warnings: string[] = [];
	const searxngUrl = asString(values.searxngUrl);
	if (searxngUrl && !/^https?:\/\//i.test(searxngUrl)) {
		warnings.push(`searxngUrl must start with http:// or https:// (got ${searxngUrl})`);
	}
	return {
		provider: asProvider(values.provider, warnings, "provider") ?? CONFIG_DEFAULTS.provider,
		braveApiKey: asString(values.braveApiKey),
		searxngUrl: searxngUrl?.replace(/\/+$/, ""),
		allowPrivateNetwork: asBool(values.allowPrivateNetwork, warnings, "allowPrivateNetwork") ?? CONFIG_DEFAULTS.allowPrivateNetwork,
		timeoutMs: asPositiveInt(values.timeoutMs, warnings, "timeoutMs") ?? CONFIG_DEFAULTS.timeoutMs,
		maxChars: asPositiveInt(values.maxChars, warnings, "maxChars") ?? CONFIG_DEFAULTS.maxChars,
		maxResponseBytes: CONFIG_DEFAULTS.maxResponseBytes,
		userAgent: asString(values.userAgent) ?? CONFIG_DEFAULTS.userAgent,
		concurrency: Math.min(8, asPositiveInt(values.concurrency, warnings, "concurrency") ?? CONFIG_DEFAULTS.concurrency),
		warnings,
	};
}

/** Mask a secret for display: keeps first 4 and last 2 characters. */
export function maskSecret(secret: string | undefined): string {
	if (!secret) return "(not set)";
	if (secret.length <= 8) return "*".repeat(secret.length);
	return `${secret.slice(0, 4)}${"*".repeat(Math.min(12, secret.length - 6))}${secret.slice(-2)}`;
}
