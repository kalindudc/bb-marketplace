# Shared machine snapshots

A source capture now has two identities. The content owner identifies immutable Git content and its transport provenance. A source descriptor identifies the Keeper or submission that captured that content. Two descriptors can share one owner without sharing their thread or review bindings.

This is a dormant controller transport boundary. Owner-backed descriptors share one native import authority, receipt and private home ref. It does not activate machine routing, free native refs or endpoints, or implement transfer-slot waiting. Full member delivery still needs native cleanup, capacity waiting, ready and lifecycle integration.

## Content address

The owner ID is the full lowercase hexadecimal SHA-256 of the UTF-8 JSON encoding of this array:

```text
["tavern-snapshot-owner/1", content]
```

`content` has these fields, serialized in this order:

1. `objectFormat`: `sha1` or `sha256`.
2. `base`: the pinned, read-only native source base commit.
3. `sourceHead`: the exact source commit.
4. `tree`: the exact source tree.
5. `fetch`: `via`, `remoteName`, `remoteUrl`, `trackingRef`, `fetchRef`, in that order.
6. `source`: `hostId`, `environmentId`, `root`, in that order.
7. `home`: `hostId`, `environmentId`, `root`, in that order.

The strict schemas normalize property order before hashing. The fetch URL is the safe native transport URL: credentials, queries and fragments are excluded, while the SSH username is retained. Endpoints include their canonical native root and SDK host and environment identities. Different endpoints or fetch provenance intentionally give a different owner, even when the Git tree is identical.

No thread ID, project ID, purpose, submission ID, journal binding, timestamp, request ID, home ref, or imported home commit enters the owner hash. Its private home ref is `refs/tavern/snapshots/<full-owner-id>`.

## Descriptor identity and import state

A descriptor ID is `source-` followed by the full SHA-256 of this UTF-8 JSON array:

```text
["tavern-source-descriptor/1", ownerId, bindings]
```

`bindings` contains, in order, `purpose`, `keeperThreadId`, `projectId`, `sourceThreadId`, `makerThreadId`, `makerSubmissionId` and `journalTarget`. A non-null journal target contains, in order, `boardQuestId`, `waypointId`, `makerThreadId`, `journalEntryId`, `entryFingerprint` and `reviewAssignmentId`. It is serialized through the strict journal schema.

The caller cannot supply either ID through `SourceCapture.initial(source, signal?)`. Repeating the same capture preserves the original descriptor's creation time. Changed content or provenance creates a new owner; changed bindings create a new descriptor. Neither changes an existing record.

The private `tavern_snapshot_owners` table holds one home ref and one pinned import commit per owner. New descriptors name their owner with `ownerId`; their stored `homeCommit` stays null. Reading a descriptor resolves that commit from its owner, so pinning it through one descriptor is visible through every descriptor without copying the import state.

Owner-backed `PlacementTransport.bringHome` uses native placement authority `snapshot-<ownerId>` and the owner's generation. Its source-read, home-import and home-verification grants and transfer identity are deterministic for that owner and generation. The sole durable home-transfer receipt, exact manifest and upload handles live on the owner, not on each consuming placement. Original native registration thread labels stay immutable even when another descriptor resumes the operation.

Simultaneous requests share work within the same controller API lifetime, including across transport instances. Each requester independently checks its current placement, descriptor and home SDK endpoint before returning its own descriptor. The in-memory promise is not authority: a private persisted operation token, current owner generation and lifecycle fence all native awaits. A restarted controller can supersede an old token and reconcile the same immutable native transfer; an old continuation cannot publish through that replacement token. A cancelled operation retains its durable receipt and any native content for retry; it never releases another placement's reference or resets a user checkout.

The exact manifest is persisted before upload. After every blob has been uploaded, phase `applying` is persisted before the native import call. Applying and verified retries need only the home endpoint, so a lost import reply is recoverable even after the maker becomes unavailable. They replay the same native import identity and request, checking its completed-import receipt and exact private ref, then independently re-export the pinned home tree. This is reconciliation of one import, not a new per-placement import. Changed private refs are a visible hold, not permission to overwrite them. Only the native verified result can complete the owner receipt and expose its home commit; bringing content home never publishes member readiness or guard arming.

Legacy snapshots without `ownerId` remain readable and retain their existing pin and explicitly separate per-placement transport behavior. That compatibility path is not shared-import or terminal-lifetime proof. It does not silently promote legacy native grants into an owner or claim an old ref; new shared captures must use owner-backed descriptors.

## References and release boundary

References are derived from placement rows, not maintained in a second table. A non-terminal placement retains every owner named by any of its source descriptor, review target, preservation descriptor, historical bring-home receipts or carry receipts. A placement is terminal only when its phase is `released`. Cancellation, a blocked state, preservation and release-in-progress all retain the owner. This deliberately retains historical snapshots until the placement is terminal.

`SnapshotStore.beginRelease` checks all descriptors of the owner and writes a `releasing` tombstone in one immediate database transaction only when no non-terminal placement names them. New captures and new or changed placement references refuse a non-retained owner. It does not call native cleanup or prove that operations have drained.

The next lifecycle slice must drain reads and carries, preserve source and declared artifacts, and confirm terminal placement state before native cleanup. The agreed native seam is `releaseSnapshotRef(TransferAuthority)`, which derives the exact ref and expected commit from a completed import and deletes by compare-and-set. Endpoint release is separate. These cleanup and capacity APIs are not consumed by this transport slice. A closed native generation must never be reopened or its endpoint IDs reused; reacquiring identical content after terminal cleanup needs a new owner authority generation while preserving the content address. That transition is not implemented here, and non-retained owners refuse capture rather than silently reviving.

Owner, placement, discovery and source records are private authority. Portable record backups exclude them, reject forged imports of their tables and refuse restoration into a destination containing them. Unknown future Tavern tables remain fail-closed.
