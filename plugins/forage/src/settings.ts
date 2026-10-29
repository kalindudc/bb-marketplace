/** Plugin settings mapped to the portable WebConfig. */

import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PRIVACY_PROFILES, PROFILE_NAMES } from "./profiles.ts";
import {
	CRAWL_BACKENDS,
	READER_PROVIDERS,
	SEARCH_PROVIDERS,
	type WebConfig,
	type WebConfigValues,
	resolveConfig,
} from "./web/config.ts";

export const SETTINGS = {
	provider: {
		type: "select",
		label: "Default search provider",
		description: "Choose a fixed provider, or Auto to use the selected profile within the configured provider ceiling.",
		options: [...SEARCH_PROVIDERS],
		experimental_optionLabels: {
			auto: "Auto (profile policy)",
			duckduckgo: "DuckDuckGo (keyless)",
			exa: "Exa (keyless; account API only when explicitly selected)",
			brave: "Brave (API key)",
			searxng: "SearXNG (self-hosted)",
			tavily: "Tavily (API key)",
		},
		default: "auto",
	},
	profile: {
		type: "select",
		label: "Search and retrieval profile",
		description: "Visible routing preset. Per-call profiles may narrow this policy but cannot widen a private ceiling.",
		options: [...PROFILE_NAMES],
		default: "auto",
	},
	privacyProfile: {
		type: "select",
		label: "Privacy ceiling",
		description: "Private permits only configured SearXNG search, direct readers and the local crawl backend.",
		options: [...PRIVACY_PROFILES],
		default: "standard",
	},
	allowedProviders: {
		type: "string",
		label: "Allowed search providers",
		description: "Comma-separated ceiling: duckduckgo,exa,brave,searxng,tavily. Calls can narrow but never add providers.",
		default: SEARCH_PROVIDERS.slice(1).join(","),
	},
	allowedReaders: {
		type: "string",
		label: "Allowed readers",
		description: `Comma-separated ceiling: ${READER_PROVIDERS.join(",")}. Remote readers always reject private or sensitive URLs.`,
		default: READER_PROVIDERS.join(","),
	},
	allowedBackends: {
		type: "string",
		label: "Allowed crawl backends",
		description: `Comma-separated ceiling: ${CRAWL_BACKENDS.join(",")}.`,
		default: CRAWL_BACKENDS.join(","),
	},
	allowPaidProviderFallback: {
		type: "boolean",
		label: "Allow paid provider fallback",
		description: "Off by default. Configuring a key alone never sends an automatic billable request.",
		default: false,
	},
	braveApiKey: {
		type: "string",
		label: "Brave API key",
		description: "Enables explicitly selected Brave Web Search and LLM Context requests.",
		secret: true,
		default: "",
	},
	exaApiKey: {
		type: "string",
		label: "Exa API key",
		description: "Optional account API key. Keyless MCP remains available; the key is used only for explicit account-API selection.",
		secret: true,
		default: "",
	},
	tavilyApiKey: {
		type: "string",
		label: "Tavily API key",
		description: "Enables explicitly selected Tavily search and extract requests.",
		secret: true,
		default: "",
	},
	firecrawlApiKey: {
		type: "string",
		label: "Firecrawl API key",
		description: "Enables explicitly selected Firecrawl v2 scrape, map and managed crawl requests.",
		secret: true,
		default: "",
	},
	jinaApiKey: {
		type: "string",
		label: "Jina API key",
		description: "Optional Reader API key. Remote reading is always explicit and subject to pre-send URL checks.",
		secret: true,
		default: "",
	},
	searxngUrl: {
		type: "string",
		label: "SearXNG URL",
		description: "Base URL of a SearXNG instance with JSON format enabled, for example http://searx.lan:8080.",
		default: "",
	},
	maxChars: {
		type: "number",
		label: "Max characters per page",
		description: "Default cap on readable content returned for one fetched URL.",
		default: 30_000,
		experimental_schema: z.number().int().min(200).max(200_000),
	},
	timeoutMs: {
		type: "number",
		label: "Request timeout (ms)",
		description: "Per-item deadline including provider queueing, DNS, redirects and body reads.",
		default: 20_000,
		experimental_schema: z.number().int().min(1_000).max(120_000),
	},
	concurrency: {
		type: "number",
		label: "Concurrency",
		description: "Maximum parallel network operations within one tool call (1–8).",
		default: 4,
		experimental_schema: z.number().int().min(1).max(8),
	},
	searchCacheTtlMs: {
		type: "number",
		label: "Search cache TTL (ms)",
		description: "Bounded in-process search cache lifetime. Cache age is always disclosed.",
		default: 300_000,
		experimental_schema: z.number().int().min(1_000).max(3_600_000),
	},
	searchCacheMaxEntries: {
		type: "number",
		label: "Search cache entries",
		description: "Maximum number of search responses retained by the in-process LRU cache.",
		default: 128,
		experimental_schema: z.number().int().min(1).max(256),
	},
	allowPrivateNetwork: {
		type: "boolean",
		label: "Allow private network",
		description: "Let direct web_fetch reach private addresses. This never permits forwarding those URLs to a remote reader or backend.",
		default: false,
	},
	allowRestrictedThreadCapture: {
		type: "boolean",
		label: "Allow restricted same-thread capture",
		description: "Off by default. Explicitly retain private-network or website-credentialed content only in its thread. Disabling blocks reads; restricted content cannot be copied to a project or exported unless explicitly selected in its thread. This is a storage choice, not a human-identity security boundary.",
		default: false,
	},
	userAgent: {
		type: "string",
		label: "User-Agent",
		description: "Override the User-Agent sent with direct requests. Leave empty for the built-in browser string.",
		default: "",
	},
} satisfies Record<string, PluginSettingDescriptor>;

export function configFromSettings(values: Record<string, unknown>): WebConfig {
	return resolveConfig(values as WebConfigValues);
}
