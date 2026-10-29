import type { ForageRuntime } from "./operations.ts";
import { resolvePolicy } from "./profiles.ts";
import { createByteBudget, createDeadline } from "./web/deadline.ts";
import { search } from "./web/search.ts";
import type { ConcreteSearchProvider } from "./web/config.ts";

export async function doctor(runtime: ForageRuntime, live = false, signal?: AbortSignal, probe: typeof search = search) {
 const config = await runtime.getConfig();
 const offline = { mode: live ? "live-keyless" : "offline", configuredSearchProvider: config.provider, policy: resolvePolicy(config, {}, "retrieval"), privateNetwork: config.allowPrivateNetwork, restrictedCapture: await runtime.allowRestrictedThreadCapture(), cache: runtime.cache.stats(), diagnostics: runtime.diagnostics.snapshot().length, configured: { brave: Boolean(config.braveApiKey), exaAccount: Boolean(config.exaApiKey), tavily: Boolean(config.tavilyApiKey), firecrawl: Boolean(config.firecrawlApiKey), jina: Boolean(config.jinaApiKey), searxng: Boolean(config.searxngUrl) } };
 if (!live) return offline;
 const deadline = createDeadline(20000, signal);
 const probes: Array<{ provider: ConcreteSearchProvider; status: string; results?: number }> = [];
 const allowed = resolvePolicy(config, {}, "retrieval").providers;
 try {
  for (const provider of ["duckduckgo", "exa", "searxng"] as const) {
   if (deadline.signal.aborted || deadline.remainingMs() === 0) break;
   if (!allowed.includes(provider) || !config.allowedProviders.includes(provider) || (provider === "searxng" && !config.searxngUrl)) continue;
   const item = createDeadline(Math.min(5000, deadline.remainingMs()), deadline.signal);
   try {
    const response = await probe("Forage web search documentation", { numResults: 1, fallback: false, signal: item.signal, context: { deadline: item, byteBudget: createByteBudget(1024 * 1024) } }, { ...config, exaApiKey: undefined, braveApiKey: undefined, tavilyApiKey: undefined, firecrawlApiKey: undefined, jinaApiKey: undefined, timeoutMs: 5000 }, provider);
    probes.push({ provider, status: "success", results: response.results.length });
   } catch { probes.push({ provider, status: item.signal.aborted ? "timeout-or-cancelled" : "failed" }); }
   finally { item.dispose(); }
   if (deadline.remainingMs() === 0 || signal?.aborted) break;
  }
 } finally { deadline.dispose(); }
 return { ...offline, probes };
}
