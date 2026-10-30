# Changelog

Notable changes to Forage, newest first. Releases are tagged `forage/vX.Y.Z` in this repository.

## 0.3.1 (2026-10-29)

### Fixed

- `bb plugin list` no longer reports `rpc health failed`. bb probes a plugin's `health` RPC with no input, and Forage now accepts that.
- `web_diff` with a `url` always downloads a fresh copy instead of using the 15-minute page cache, so it reports changes made since the last read. With a `url` and no baseline it refuses before fetching anything.
- A page read in raw mode keeps its title, headings, canonical address and other fields, as in readable mode, so `web_extract` on its snapshot returns them instead of the file name and empty fields. Pages read in raw mode before 0.3.1 get them when they are read again.

## 0.3.0 (2026-10-29)

### Added

- Forage is per thread now. The Sources tab becomes Research: Activity (searches with the results seen, pages read, maps, crawls and problems, grouped by who did them), Sources grouped by how they arrived, a line-numbered reader with versions, comparison, quoting and citations, and Crawls with limits as progress bars, Stop, Resume and a form to map or crawl a site.
- Search the web or read a link from the tab with no model turn, and Read now on a search result the agent did not open. These are labelled as yours.
- Citation cards in replies (`::forage-cite`, `::forage-sources`), Check in sources on a message or a selection, a header chip, a composer segment, an Info section, Save to research in bb's Browser and palette commands.
- A source counts as cited when a finished reply cites it, whether or not anyone opens the reply. Check in sources matches word forms ("retries" finds "retry"), leaves numbers out, and shows a passage once when several pages repeat it.
- Versions count distinct kept text, so reading an unchanged page again adds no version.
- Web research per thread from the thread menu: Use Forage settings, Docs first, Fresh results, Private or Off. A thread can only narrow Forage settings. Every entry point (tools, CLI, the Research tab) follows it; Off refuses web operations and removes the web tools from the agent, and Private or Off stops crawls they would not allow.
- The rail page becomes Research: threads with research, each thread's Activity and Sources, sources shared with projects, and Health and storage.
- A per-thread activity log, kept for 30 days, with Clear in the tab and a Keep a research activity log setting that stops recording and deletes every log.
- A new leaf icon.

## 0.2.0 (2026-10-28)

### Added

- Added one shared tool/CLI runtime with six strict operations, privacy ceilings, cancellation and redacted bounded diagnostics.
- Added scoped immutable source capture before rendering, hash-bound snapshot continuation, deterministic extraction/discovery, durable bounded crawls, source comparison and Sources UI.
- Added zero-model-turn search/fetch/map/extract/diff/crawl CLI commands, source management and streamed export, offline doctor and bundled local benchmarks.
- Added direct/raw retrieval, structured views, fair two-phase search deadlines, shared payload budgets, safe revalidation and explicit partial results.
- Added optional provider/readers with non-widening policy. Restricted thread capture remains default-off; sensitive URL checks reject capture conservatively.

### Security

- Local crawls now validate restrictive robots/path policy before redirect targets. Firecrawl subdomain discovery is rejected until a verified adapter mapping exists. Lost remote-start acknowledgements persist as visible uncertainty and cannot be silently restarted or claimed cancelled.

### Compatibility

- Requires BB >=0.47 and Plugin SDK >=0.6.79.

## 0.1.0 (2026-10-28)

### Added

- Web search and web fetch for every provider. `web_search` returns ranked results with title, URL and snippet; `web_fetch` returns a URL as readable markdown, raw text, JSON, or PDF text when `pdftotext` is installed. bb hands a plugin's tools to pi, Codex, Claude Code and ACP threads alike, so every agent in bb can search the web and read a page.
- Nothing to configure. DuckDuckGo answers keyword queries and Exa answers semantic ones, both without a key, and a provider that fails falls through to the next. The output names the provider that answered and any that failed first, so a fallback is visible rather than silent. Add a Brave API key or a self-hosted SearXNG URL and Auto prefers it.
- Batch queries and filters. One query or up to eight at once, a recency filter (day, week, month, year), domain include and exclude filters such as `["docs.python.org", "-pinterest.com"]`, and `includeContent` to read the top pages in the same call.
- Fetches built for long documents. A GitHub URL resolves to the README, the raw file, a directory listing, or a full issue or pull request thread. `offset` pages a long document using the process cache when available (URL-only continuation can re-download after expiry), and `find` returns only the matching passages with line numbers.
- Settings and diagnostics. Provider, Brave API key (stored in a 0600 file, never in the database or the frontend), SearXNG URL, per-page character cap, request timeout, concurrency, User-Agent, and whether `web_fetch` may reach private addresses, under Settings → Installed plugins → Forage. `bb forage status` prints the resolved provider chain, the settings in effect and the cache size; `bb forage clear` empties the cache.
- The pi-web extension stands down under bb. It reads the tool list bb passes to pi and skips `web_search` and `web_fetch` when bb already provides them, so a thread never sees two copies of the same tool.

### Changed

- Search results are written as plain text for bb's monospace row body rather than markdown. bb 0.47.1 does not yet forward a plugin tool's `presentation` on the pi provider, so a pi thread shows bb's standard tool row; Codex, Claude Code and ACP show the label, icon and tint.
