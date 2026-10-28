---
name: forage
description: Web search and web fetch in bb, provided by the Forage plugin. Use when the user asks about web_search or web_fetch, about why a search result did not render in the timeline, about search providers or API keys, or about the `bb forage` command and its settings.
---

# Forage

Forage registers bb's own `web_search` and `web_fetch` agent tools, so every provider in every thread has them. The tools run in the bb server process and their output appears in the timeline row that made the call.

## Tools

`web_search` takes one `query` or up to eight `queries`, `numResults` (default 5, max 20), `recency` (`day`, `week`, `month`, `year`), `domains` (include, or exclude with a leading `-`), `provider`, and `includeContent` to also read the top pages.

`web_fetch` takes one `url` or up to ten `urls`, `mode` (`readable` or `raw`), `maxChars`, `offset` to continue a long document from the cache, `find` for matching passages (plain text or `/regex/flags`), and `refresh` to bypass the 15-minute cache.

Prefer `web_search` with two to four varied queries over one broad query, and follow it with `web_fetch` on the most relevant URLs rather than relying on snippets.

## Commands

    bb forage status    # resolved provider chain, settings in effect, cache size
    bb forage clear     # empty the in-memory page cache

## Settings

Settings → Installed plugins → Forage, or `bb plugin config forage`:

- `provider` — `auto` (default), `duckduckgo`, `exa`, `brave` or `searxng`. Auto prefers Brave when a key is set, then SearXNG when a URL is set, then DuckDuckGo, then Exa, falling through on any error.
- `braveApiKey` — a secret, stored in a 0600 file. Needed only for the Brave provider.
- `searxngUrl` — a self-hosted instance with the JSON format enabled.
- `maxChars`, `timeoutMs`, `concurrency`, `userAgent` — request limits.
- `allowPrivateNetwork` — lets `web_fetch` reach loopback and private addresses, for a local dev server.

## Rules

- If a search returns nothing useful, change the query or the provider; do not retry the same call. `bb forage status` shows which providers are configured and which answered.
- A `web_fetch` error naming a blocked address is the SSRF guard, not a network problem. The private-network setting lifts the block for that machine only.
- Do not add a second web-search tool to a thread: the pi-web extension already stands down whenever bb provides `web_search` or `web_fetch`.
