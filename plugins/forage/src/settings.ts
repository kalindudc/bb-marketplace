/**
 * Plugin settings → `WebConfig`.
 *
 * bb stores these in its database (secrets in a 0600 file, never in the
 * database or the frontend). Values are read fresh on every tool call, so an
 * edit in Settings applies to the next call without a reload.
 */

import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { SEARCH_PROVIDERS, type WebConfigValues, resolveConfig, type WebConfig } from "./web/config.ts";

export const SETTINGS = {
	provider: {
		type: "select",
		label: "Search provider",
		description:
			"Auto prefers Brave when a key is set, then SearXNG when a URL is set, then DuckDuckGo, then Exa. DuckDuckGo and Exa need no key; any provider that fails falls through to the next.",
		options: [...SEARCH_PROVIDERS],
		experimental_optionLabels: {
			auto: "Auto (recommended)",
			duckduckgo: "DuckDuckGo (keyless)",
			exa: "Exa (keyless, semantic)",
			brave: "Brave (API key)",
			searxng: "SearXNG (self-hosted)",
		},
		default: "auto",
	},
	braveApiKey: {
		type: "string",
		label: "Brave API key",
		description: "https://brave.com/search/api/ — enables the Brave provider and recency filters.",
		secret: true,
		default: "",
	},
	searxngUrl: {
		type: "string",
		label: "SearXNG URL",
		description: "Base URL of a SearXNG instance with the JSON format enabled, e.g. http://searx.lan:8080",
		default: "",
	},
	maxChars: {
		type: "number",
		label: "Max characters per page",
		description: "Default cap on the readable content returned for one fetched URL.",
		default: 30_000,
		experimental_schema: z.number().int().min(200).max(200_000),
	},
	timeoutMs: {
		type: "number",
		label: "Request timeout (ms)",
		description: "How long one search or fetch request may take before it is abandoned.",
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
	allowPrivateNetwork: {
		type: "boolean",
		label: "Allow private network",
		description:
			"Let web_fetch reach loopback, private and link-local addresses such as a local dev server. Hostnames are still resolved and pinned, and every address is still checked.",
		default: false,
	},
	userAgent: {
		type: "string",
		label: "User-Agent",
		description: "Override the User-Agent sent with requests. Leave empty for the built-in browser string.",
		default: "",
	},
} satisfies Record<string, PluginSettingDescriptor>;

export function configFromSettings(values: Record<string, unknown>): WebConfig {
	return resolveConfig(values as WebConfigValues);
}
