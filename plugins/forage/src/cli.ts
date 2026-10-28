// `bb forage status` and `bb forage clear`.
import { cliCommand, defineCli } from "@get-bb/plugin-sdk";
import type { ToolDeps } from "./tools.ts";
import { cacheClear, cacheStats } from "./web/fetch.ts";
import { maskSecret, type WebConfig } from "./web/config.ts";
import { formatBytes } from "./web/net.ts";
import { resolveProviderChain } from "./web/search.ts";

function statusLines(config: WebConfig): string[] {
	const chain = resolveProviderChain(undefined, config);
	const cache = cacheStats();
	const lines = [
		"Forage status",
		`  search provider: ${config.provider}${config.provider === "auto" ? ` → ${chain.join(" → ")}` : ""}`,
		`  brave: ${config.braveApiKey ? `key ${maskSecret(config.braveApiKey)}` : "not configured (Settings → Forage → Brave API key)"}`,
		`  searxng: ${config.searxngUrl ?? "not configured (Settings → Forage → SearXNG URL)"}`,
		`  duckduckgo: keyless (fast; may bot-check on bursts)`,
		`  exa: keyless MCP endpoint (semantic; ~3 concurrent)`,
		`  private network: ${config.allowPrivateNetwork ? "ALLOWED" : "blocked"} · timeout ${config.timeoutMs}ms · maxChars ${config.maxChars.toLocaleString("en-US")} · concurrency ${config.concurrency}`,
		`  cache: ${cache.entries} page${cache.entries === 1 ? "" : "s"}, ${formatBytes(cache.bytes)} (15 min TTL) — bb forage clear to empty`,
		`  github token: ${process.env.GITHUB_TOKEN || process.env.GH_TOKEN ? "found (higher API rate limit)" : "none (60 requests/hour unauthenticated)"}`,
	];
	if (config.warnings.length) lines.push("  warnings:", ...config.warnings.map((warning) => `    - ${warning}`));
	return lines;
}

export function createCli(deps: ToolDeps) {
	return defineCli({
		name: "forage",
		summary: "Web search and fetch: provider, cache and settings diagnostics",
		commands: {
			status: cliCommand({
				summary: "Show the resolved provider chain, settings and page cache",
				options: {},
				async run() {
					return { exitCode: 0, stdout: statusLines(await deps.getConfig()).join("\n") };
				},
			}),
			clear: cliCommand({
				summary: "Empty the in-memory page cache",
				options: {},
				async run() {
					const before = cacheStats();
					cacheClear();
					return {
						exitCode: 0,
						stdout: `Cleared ${before.entries} cached page${before.entries === 1 ? "" : "s"} (${formatBytes(before.bytes)}).`,
					};
				},
			}),
		},
	});
}
