---
name: forage
description: Configure or troubleshoot Forage's six web tools, provider/privacy ceilings, scoped sources, bounded crawls and zero-turn bb forage CLI.
---

# Forage

Forage registers `web_search`, `web_fetch`, `web_map`, `web_extract`, `web_crawl` and `web_diff` for every BB agent. Calls use one shared runtime with the CLI and the Research UI.

## Operations

- Search one query or up to eight queries. Use domain/date filters and optional includeContent.
- Fetch up to ten URLs or a snapshotId. Raw auto is direct exact textual retrieval. Resolution and reader selection are separate. Use outline, links, lines or focus for narrow views.
- Map discovers same-site URLs with provenance and bounded sitemap/robots/llms/root-link reads.
- Extract chooses deterministic title, description, canonicalUrl, language, headings, links, tables and jsonLd fields. It does not infer arbitrary schemas.
- Crawl starts or controls persisted bounded jobs with action start, status, list, cancel or resume.
- Diff compares two visible snapshots, the latest source pair, or a stored baseline against a fresh URL.

## Evidence and privacy

Public content is captured before formatting. Continue with snapshotId, contentHash and offset for immutable paging. URL-only offsets may re-download after cache expiry; NEVER promise otherwise. Hash mismatch fails rather than paging changed content. Offsets are UTF-16; citations use one-based line numbers and plain URL/source/snapshot identifiers.

Source IDs are scoped. Share URLs or findings across threads unless public evidence was explicitly copied to the project. Restricted same-thread capture is OFF by default, cannot be promoted and requires explicit selection for export. Disabling restricted capture revokes restricted reads. Scope is product isolation, not protection from local filesystem access.

Configured providers/readers/backends and privacy are ceilings. Profile/provider/reader/backend arguments can only narrow them. Private search uses configured SearXNG, direct readers and local crawl; it does not guarantee private upstream SearXNG engines. Local private-network permission NEVER grants remote-forwarding consent. Sensitive URLs are rejected before remote forwarding/capture. Do not retry a policy error through another provider.

## Research UI, activity log and per-thread policy

Each thread has a Research tab (Activity, Sources, Crawls, a reader and Check in sources), and the rail has a Research page with every thread's research and Health and storage. A person can search, read a link or crawl from the tab with no model turn; those entries are labelled as theirs.

The activity log keeps each thread's queries, results seen, pages read and crawls for 30 days. The person clears one thread's log from the tab menu. The `keepActivityLog` setting, on by default, stops recording and deletes every log when turned off.

Web research per thread lives in the thread menu: `settings`, `docs`, `fresh`, `private` or `off`, stored as `webResearch` in Forage's thread metadata. It only narrows settings. `off` removes the web tools from the next agent session and refuses web operations from tools, the CLI and the Research tab until then ("Web research is off in this thread"); tell the person and stop, never route around it, and never change the policy yourself. `private` needs a configured SearXNG search. Switching to Private or Off stops crawls the new policy would not allow.

## Commands

Web commands require explicit --project and --thread IDs and strict --input JSON (or --input-stdin). Their parameters match the tools. CLI calls do not start model turns.

```sh
bb forage search --project PROJECT --thread THREAD --input '{"queries":["migration guide","known issues"],"profile":"docs"}'
bb forage fetch --project PROJECT --thread THREAD --input '{"snapshotId":"SNAPSHOT","contentHash":"HASH","offset":1000}'
bb forage crawl status --project PROJECT --thread THREAD --input '{"jobId":"JOB"}'
bb forage sources list --project PROJECT --thread THREAD --input '{"limit":20}'
bb forage status
bb forage diagnostics
bb forage clear
bb forage doctor
bb forage bench
```

Sources list/show/export/delete accept project scope when --thread is omitted. Export returns a local-auth streamed NDJSON route, not a server file path. Delete needs exact delete-source:<scopeKey>:<sourceId> or delete-scope:<scopeKey>. Global prune requires prune-sources:all. Active-job sources require cancellation before deletion.

Doctor is offline by default. --live explicitly permits at most one query per allowed keyless DDG/Exa or configured SearXNG, five seconds/provider and 20 seconds total; account keys are stripped. Bench is bundled local data with no network. Diagnostics keep at most 200 redacted records for 24 hours, with no query/URL/content/credential values.

## Operating limits

Tool and CLI text is capped at 32,000 characters. Each batch item remains visible. Fetch deadlines start at dispatch, including provider queue time. Search content has a separate fair phase and fresh page deadlines. One decoded-payload byte budget spans subrequests; it is not a TCP-wire limit.

Default retention: thread 30 days, project 180 days, successful job metadata 30 days, failed/cancelled seven days; content cap 128 MiB. Storage refusal is explicit. Read the plugin README for full limits and guarded fixture/live scripts. NEVER install/reload/configure active Forage merely to inspect diagnostics.
