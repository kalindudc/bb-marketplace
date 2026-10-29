# Forage

Forage 0.2.0 gives every BB agent six web-research tools and a zero-model-turn CLI. It requires BB 0.47 or newer and Plugin SDK 0.6.79.

## Tools and one shared runtime

- `web_search` searches one query or up to eight queries. It supports domain/date filters, profiles, explicit providers and fair, host-diverse `includeContent`.
- `web_fetch` reads up to ten URLs or an immutable `snapshotId`. It supports `readable` and exact textual `raw` responses, independent `resolve: auto|direct|smart`, passage search, and `view: content|outline|links|lines|focus`. Raw auto is direct, not GitHub-smart or a cloud reader.
- `web_map` discovers same-site URLs from robots, sitemap indexes, llms.txt and optional root links, with provenance and explicit partial limits.
- `web_extract` returns deterministic title, description, canonical URL, language, headings, links, tables and JSON-LD. It does not infer arbitrary schemas or call a model.
- `web_crawl` starts and controls durable bounded jobs. Use `action: start|status|list|cancel|resume`. Defaults are 25 pages, depth two, 20 MiB accepted payload, five minutes and two workers; hard caps are 200 pages, depth five, 100 MiB, 30 minutes and four workers.
- `web_diff` compares two visible snapshots, the latest pair for a source, or a fresh URL against a stored baseline. A refused capture can still be compared in memory; no persistent source IDs are invented.

The server constructs one source repository, one job engine and one runtime. Tools and CLI invoke the same strict schemas and operations. The Sources project page and thread tab use typed RPC and local-auth streamed export over that same graph.

## Evidence and continuation

Public, uncredentialed content is captured in the calling thread before output is shortened. Search queries, search metadata and raw provider payloads are not automatically saved. A retrieval attempt is separate from an immutable snapshot: unchanged reads add attempts without manufacturing changed versions. A 304 preserves the original body, hash and fetch time.

Use `snapshotId`, `contentHash` and `offset` from a result for immutable continuation. Offsets are UTF-16 string indices, not byte offsets; surrogate pairs are not split. URL-only offset reads use the process cache when available but may download again after expiry. A mismatched hash fails with `STALE_CONTENT`; an evicted snapshot does not silently refetch. Citations use the URL, source/snapshot IDs and one-based line ranges. Outline, links and focus are derived views, not offsets into the original snapshot.

IDs from another thread are invisible. Share URLs and findings across threads, or explicitly copy a public source to the project through Sources. Restricted snapshots cannot be promoted. Thread retention defaults to 30 days, project retention to 180 days, completed-job metadata to 30 days and failed/cancelled-job metadata to seven days. Retained content is capped at 128 MiB; snapshots at 8 MiB UTF-8 and structured data at 1 MiB. Active jobs protect their snapshots; cancel the job before deleting one. Retention removes inactive/expired data first. Storage refusal is explicit, not a fake saved page.

## Privacy and provider controls

Profiles are `auto`, `fast`, `fresh`, `docs`, `private` and `deep`. Setting-level allowed providers, readers, backends and privacy are ceilings. Tool and CLI selectors can narrow them, never widen them. A configured key does not itself enable paid fallback.

Private uses only configured SearXNG search, direct readers and the local crawl backend. It does not make claims about SearXNG's upstream engines or airgapping. Requested direct page reads still obey the network policy. Public cloud search providers include keyless DuckDuckGo/Exa and optional Brave, Exa account and Tavily. Explicit remote readers are Tavily, Firecrawl and Jina; Firecrawl is an optional explicit crawl backend.

Every direct redirect is revalidated and DNS-pinned. Private/loopback/link-local targets are blocked by default. Enabling local private-network access is NOT consent to forward those URLs to vendors. Remote adapters reject sensitive query keys, userinfo, local names and non-public locally resolved addresses before forwarding. Vendor-side redirects cannot be DNS-pinned by Forage.

Restricted same-thread capture is a separate setting, OFF by default. Enabling it is a storage choice, not a human-identity security boundary. Disabling it blocks restricted reads until re-enabled or deleted. Export excludes restricted sources unless explicitly selected in their thread. Credentials, headers and cookies are never stored. Capture rejects sensitive URL keys (`token,key,secret,signature,sig,auth,access_token,code,session`, decoded and case-insensitive) in provenance, structured links and bounded content URL tokens. This conservative heuristic may reject benign code parameters and is not a general secret detector. Scope isolation is product isolation, not protection from a shell-capable agent or a local user reading SQLite.

## Managed crawl limits

Local crawls check path prefixes and robots before each same-origin redirect target. Cross-origin redirects remain fail-closed, even when subdomains are eligible as separately discovered pages. Firecrawl `includeSubdomains: true` is rejected before sending a request because this adapter has no verified mapping for vendor discovery; filtering captured URLs is not presented as vendor-side control.

If a managed start is dispatched but its job-ID acknowledgement is lost, the durable job reports `REMOTE_START_UNKNOWN`. It cannot be safely resumed, and cancellation is not claimed. Inspect the provider account manually. A crash during the start request recovers into that same visible uncertainty instead of automatically starting another vendor job. Known IDs retain durable cleanup reservations. Vendor-side redirects, robots and concurrency cannot be enforced locally.

## CLI: no model turns

Pass explicit SDK-validated scope IDs. Web operations require a thread; source operations can use project scope by omitting `--thread`. `--input` accepts the SAME strict JSON parameters as tools, including arrays and limits; `--input-stdin` avoids shell quoting. Profile/provider/reader/backend flags are also accepted and cannot conflict with JSON.

```sh
bb forage search --project PROJECT --thread THREAD --input '{"queries":["API migration guide","API known issues"],"profile":"docs"}'
bb forage fetch --project PROJECT --thread THREAD --input '{"url":"https://example.org/docs","resolve":"direct"}'
bb forage map --project PROJECT --thread THREAD --input '{"url":"https://example.org","maxUrls":50}'
bb forage extract --project PROJECT --thread THREAD --input '{"url":"https://example.org","fields":["headings","links"]}'
bb forage diff --project PROJECT --thread THREAD --input '{"beforeSnapshotId":"BEFORE","afterSnapshotId":"AFTER"}'
bb forage crawl start --project PROJECT --thread THREAD --input '{"url":"https://example.org","limits":{"maxPages":5}}'
bb forage crawl status --project PROJECT --thread THREAD --input '{"jobId":"JOB"}'
bb forage crawl list --project PROJECT --thread THREAD
bb forage crawl cancel --project PROJECT --thread THREAD --input '{"jobId":"JOB"}'
bb forage crawl resume --project PROJECT --thread THREAD --input '{"jobId":"JOB"}'
bb forage sources list --project PROJECT --thread THREAD --input '{"limit":20}'
bb forage sources show --project PROJECT --thread THREAD --input '{"sourceId":"SOURCE"}'
bb forage sources export --project PROJECT --thread THREAD --input '{"sourceIds":["SOURCE"]}'
bb forage sources delete --project PROJECT --thread THREAD --input '{"sourceId":"SOURCE"}' --confirm 'delete-source:thread:PROJECT:THREAD:SOURCE'
bb forage sources prune --confirm 'prune-sources:all'
bb forage status
bb forage diagnostics
bb forage clear
bb forage doctor
bb forage bench
```

Scope deletion needs `delete-scope:<scopeKey>`; a source deletion needs `delete-source:<scopeKey>:<sourceId>`. Global prune requires the exact `prune-sources:all` token. Clear empties process caches, not saved evidence. Export returns an authenticated streamed NDJSON HTTP route, not giant stdout or a server file path. Export is bounded to 32 MiB, 1,000 records, 30 seconds and two concurrent downloads.

## Budgets and diagnostics

Tool and CLI text is at most 32,000 characters. Each batch item remains visible, including failures. A logical query/page gets its deadline when a worker dispatches it, before provider queueing. The fetch outer deadline is `ceil(items/concurrency) * timeoutMs + 500ms`. Search adds a separate content phase: `[ceil(queries/concurrency) + ceil(targetCap/concurrency)] * timeoutMs + 500ms`, capped at five minutes. Target cap is `min(8,max(3,queryCount))`; each selected content page gets a fresh deadline after searches finish. One byte budget covers both phases. Accepted decoded payload, including failed subrequests and cached artifacts, counts toward budgets; this is not a TCP wire-byte guarantee.

Diagnostics retain at most 200 records for 24 hours, in memory only: operation, provider, status, stage timing, cache state, counts and warning codes. They contain no query, URL, content or credential values. Tool records are visible in CLI status. Settings changes synchronously fence in-flight operations and active crawl jobs; resume explicitly after reconfiguration. Doctor is offline by default. Explicit `doctor --live` makes at most one query per allowed keyless DDG/Exa or configured self-hosted SearXNG, at most five seconds per provider and 20 seconds total. It strips account keys. Bench uses a bundled local corpus, not runtime fixture-file reads.

## Development and guarded acceptance

`npm test`, `npm run typecheck` and `npm run build` run in the plugin directory. Root `npm run build` regenerates marketplace metadata; the marketplace release range intentionally does not opt into prereleases. The SDK fake host exercises native registration, validation, context, cancellation and compiled CLI. It does not prove that an LLM chose a tool.

`scripts/fixture-check.sh` requires an OS egress sandbox profile. `scripts/smoke-isolated.sh` and `scripts/smoke-keyless.sh` require an explicitly supplied, already-isolated corrected harness run and never install, reload or launch the active BB profile. Do not run live acceptance against a normal profile. The corrected harness must verify server/host identity, suppress credential-aware helper executables, retain active-plugin before/after evidence and clean up all owned descendants. Credentialed-provider live checks are not part of keyless acceptance.
