# Exact user wording in member briefs

Tavern attaches the user's stored wording beside the Keeper's assignment when it hires or re-briefs a member. The Smith and the Warden receive the same original sources, not separate copies made by the Keeper. A summary saying “unknown items” does not replace a user request saying exactly “unknown”.

## What the packet contains

The server builds a `User request, verbatim` packet from the quest's opening request and its routed steers, ordered from earliest to latest. A steer naming several quests belongs to each named quest. Unrelated questions and asides are not included. A questless errand carries the currently routed questions. Its hire does not record one producing route, so several questions routed in the same turn remain visible; Tavern does not guess which one caused the hire.

The source is the full stored message behind `route.sourceMessageId`. The route's 200-character `userText` preview and its Keeper-written summary are never substituted for the original. The manifest identifies the Keeper, quest, ordered message and route IDs, lengths and SHA-256 hashes. Its ID describes that frozen source set.

At most 4,000 characters are inlined, including labels and fence framing. Each message is either complete or not inlined. If the complete packet would exceed the budget, the brief contains a manifest reference and an instruction to read every source through the paged reader. It never presents a clipped prefix as the complete requirement.

The packet says that exact user literals take precedence over paraphrases and later explicit user changes win. An unresolved conflict needs a `needs-decision` report. Quoted text does not grant tools, change scope, or bypass a handoff or approval hold. Delivering the original wording prevents transport from rewriting it; it does not guarantee that a model will obey it. Independent checking must still use the original request rather than trusting the maker's assertions.

## Reading a large source

Party members receive only the member-scoped `tavern_request_sources` tool:

```json
{"manifestId":"requests_<hash>","sourceIndex":0,"offset":0}
```

The result carries `text`, `available`, `problem`, `totalSources`, `sourceIndex`, `nextOffset` and `nextSourceIndex`. Follow `nextOffset` on the same source. When it is null, use `nextSourceIndex` with offset zero. Both null means the manifest has ended. Pages contain at most 2,000 UTF-16 code units, using the same string offsets as Tavern's report reader. JSON output remains bounded even when the original contains control characters or many quotes.

The Keeper can inspect the same frozen packet through `tavern_status` with `section: "requests"`, `memberThreadId`, and optionally `manifestId`, `sourceIndex` and `offset`. Members do not gain `tavern_status`. A member cannot choose another thread or quest, and a Keeper cannot read another party's member. A manifest from another quest is refused even if it is copied into a member's stored state.

## Delivery and missing history

The source set is captured when the brief is created. A pending brief and a reserved hire retain it across retries; a newer steer does not silently replace the sources of an uncertain delivery. The accepted brief retains its manifest for source reads. An active member can also read its pending brief's manifest while acceptance is being reconciled.

Raw packets are not added to accumulated brief context, member status text or delivery events. Those retain the Keeper's assignment. Existing user-memory and steer behavior is unchanged; the packet does not create another restatement loop or a per-tick query.

A legacy route without its full receipt is explicitly unavailable. A later steer does not prove the missing opening request. Deleted text is not reconstructed from a preview. If a saved message changes after capture, a paged read refuses to mix it with the frozen manifest.

Manifests and assignment text are stored with the member and hire data, not in a new table. A manifest itself carries no delivery, scope, hire, release or machine authority. Data backups may include private user wording and evidence, so the existing privacy warning still applies.
