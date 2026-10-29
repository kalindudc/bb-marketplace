---
name: forage-research
description: Research current technical questions with Forage search, primary-source reading, scoped evidence, deterministic extraction and bounded site crawls.
---

# Research with Forage

Use the lightest set of operations that answers the question. A single factual lookup does not need a crawl.

## Find and read evidence

1. Search two to four varied angles when coverage matters. Narrow domains and date ranges deliberately; keep returned provider/filter warnings.
2. Fetch relevant primary sources in full, not only search snippets. Use snapshotId and contentHash for stable continuation; use find, outline, links, line ranges or focus to read a specific section.
3. Extract fixed fields when headings, links, tables or JSON-LD answer the question. This is deterministic extraction, not arbitrary AI schema inference.
4. Cite the URL and, when persisted, source/snapshot identifiers and one-based line ranges. Distinguish observed evidence from inference and stale or partial material.

## Site-wide work

Map first when a question spans a documentation site. Narrow includePaths/excludePaths and maxUrls. Start a crawl only if the user's scope warrants durable multi-page collection. Set page/depth/byte/time/concurrency limits explicitly when defaults are too broad. Inspect job status and partial stop reasons; cancel unwanted jobs. A page-count cap includes failed fetches and is not a success count.

Use diff on immutable snapshots to check changes. A fresh URL can be compared against a stored baseline even when new capture is refused, but do not report an in-memory comparison as a saved source.

## Preserve boundaries

- Setting-level privacy/provider/reader/backend ceilings ALWAYS apply. NEVER work around a blocked provider with another cloud reader.
- Private uses configured SearXNG/direct/local, not a guarantee about SearXNG upstream engines.
- Keep private/credentialed content out of project promotion and ordinary exports. Restricted thread capture is explicit and OFF by default.
- Source IDs from another thread are invisible. Share findings and URLs unless a public source was explicitly copied to the project.
- A sensitive URL rejection is a policy result, not a reason to print or forward the rejected URL.
- Report missing, failed, evicted, stale, partial and storage-refused evidence. NEVER invent source IDs or silently refetch an evicted snapshot.

Finish when the requested answer is supported. Do not start a crawl, export, live doctor, model turn or external write merely because the tool exists.
