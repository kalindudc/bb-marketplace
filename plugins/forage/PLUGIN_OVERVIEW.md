Web search and web fetch for every agent in bb, as bb's own tools.

bb gives a plugin's tools to pi, Codex, Claude Code and ACP agents alike, so the model in any thread can search the web and read a page. Because the tools belong to bb rather than to one agent's terminal, each call is a real timeline row: a search icon, "Searched the web" with its duration, and the results in the row body instead of a raw tool call.

## What you get

- `web_search` — ranked results with title, URL and snippet. One query or up to eight at once, a recency filter (day, week, month, year), and domain include or exclude filters such as `["docs.python.org", "-pinterest.com"]`. `includeContent` also reads the top pages.
- `web_fetch` — a URL to readable markdown, raw text or JSON, or PDF text when `pdftotext` is installed. GitHub URLs are resolved for you: a repo to its README, a blob to the raw file, a tree to a directory listing, an issue or pull request to its full thread. Long documents page with `offset`, and `find` returns only the matching passages with line numbers.
- Every call names the provider that answered and any that failed first, so a fallback is visible rather than silent.
- A 15-minute page cache, so paging through a document does not re-download it.

## Providers

Nothing needs configuring: DuckDuckGo answers keyword queries and Exa answers semantic ones, both without a key. Add a Brave API key or a self-hosted SearXNG URL in the settings and Auto prefers it, falling through to the next provider on any error.

## Commands and settings

`bb forage status` prints the resolved provider chain, the settings in effect and the cache size; `bb forage clear` empties the cache. Settings live in Settings → Installed plugins → Forage: provider, Brave API key (stored in a 0600 file, never in the database or the frontend), SearXNG URL, per-page character cap, request timeout, concurrency, User-Agent, and whether `web_fetch` may reach private addresses.

## With the pi extension

The pi-web extension registers the same two tools when pi runs on its own. Under bb it reads the tool list bb passes to pi and stands down for any tool bb already provides, so a thread never sees two copies and there is nothing to keep in sync by hand.

## How it works

The search, fetch, HTML-to-markdown, SSRF-guard and cache engine runs in the bb server process. The engine is a copy of the pi-web extension's, kept dependency-free (Node built-ins only) so both sides behave identically.

## Limits

- The row body is bb's generic tool output, which is monospace text. bb has no interface for a plugin to draw its own tool-row body, so Forage cannot show the richer web-search card that bb draws for Claude Code's native search.
- Tool output is capped at 32,000 characters, which is what bb keeps inline for a row; a longer result says where it was cut.
- `web_fetch` blocks loopback, private, link-local and metadata addresses on every redirect hop, and pins the connection to the addresses it validated. Turn the private-network setting on for a local dev server.
- Forage needs outbound HTTPS from the machine running the bb server.
