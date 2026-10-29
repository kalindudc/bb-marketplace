# Changelog

## 0.2.0

- Added one shared tool/CLI runtime with six strict operations, privacy ceilings, cancellation and redacted bounded diagnostics.
- Added scoped immutable source capture before rendering, hash-bound snapshot continuation, deterministic extraction/discovery, durable bounded crawls, source comparison and Sources UI.
- Added zero-model-turn search/fetch/map/extract/diff/crawl CLI commands, source management and streamed export, offline doctor and bundled local benchmarks.
- Added direct/raw retrieval, structured views, fair two-phase search deadlines, shared payload budgets, safe revalidation and explicit partial results.
- Added optional provider/readers with non-widening policy. Restricted thread capture remains default-off; sensitive URL checks reject capture conservatively.
- Local crawls now validate restrictive robots/path policy before redirect targets. Firecrawl subdomain discovery is rejected until a verified adapter mapping exists. Lost remote-start acknowledgements persist as visible uncertainty and cannot be silently restarted or claimed cancelled.
- Requires BB >=0.47 and Plugin SDK >=0.6.79.

## 0.1.0

- **Web search and web fetch for every provider.** `web_search` returns ranked results with title, URL and snippet; `web_fetch` returns a URL as readable markdown, raw text, JSON, or PDF text when `pdftotext` is installed. bb hands a plugin's tools to pi, Codex, Claude Code and ACP threads alike, so every agent in bb can search the web and read a page.
- **Nothing to configure.** DuckDuckGo answers keyword queries and Exa answers semantic ones, both without a key, and a provider that fails falls through to the next. The output names the provider that answered and any that failed first, so a fallback is visible rather than silent. Add a Brave API key or a self-hosted SearXNG URL and Auto prefers it.
- **Batch queries and filters.** One query or up to eight at once, a recency filter (day, week, month, year), domain include and exclude filters such as `["docs.python.org", "-pinterest.com"]`, and `includeContent` to read the top pages in the same call.
- **Fetches built for long documents.** A GitHub URL resolves to the README, the raw file, a directory listing, or a full issue or pull request thread. `offset` pages a long document using the process cache when available (URL-only continuation can re-download after expiry), and `find` returns only the matching passages with line numbers.
- **Settings and diagnostics.** Provider, Brave API key (stored in a 0600 file, never in the database or the frontend), SearXNG URL, per-page character cap, request timeout, concurrency, User-Agent, and whether `web_fetch` may reach private addresses, under Settings → Installed plugins → Forage. `bb forage status` prints the resolved provider chain, the settings in effect and the cache size; `bb forage clear` empties the cache.
- **The pi-web extension stands down under bb.** It reads the tool list bb passes to pi and skips `web_search` and `web_fetch` when bb already provides them, so a thread never sees two copies of the same tool.
- Search results are written as plain text for bb's monospace row body rather than markdown. bb 0.47.1 does not yet forward a plugin tool's `presentation` on the pi provider, so a pi thread shows bb's standard tool row; Codex, Claude Code and ACP show the label, icon and tint.
