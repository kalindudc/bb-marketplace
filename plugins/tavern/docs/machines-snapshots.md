# Shared machine snapshots

A source capture now has two identities. The content owner identifies immutable Git content and its transport provenance. A source descriptor identifies the Keeper or submission that captured that content. Two descriptors can share one owner without sharing their thread or review bindings.

This is a dormant controller transport boundary. Owner-backed descriptors share one native import authority, receipt and private home ref. It does not activate machine routing, free native refs or endpoints, or implement transfer-slot waiting. Full member delivery still needs native cleanup, capacity waiting, ready and lifecycle integration.

## Read-only working-tree capture

Initial and submission captures include the working versions of tracked files, tracked deletions, and untracked files that Git does not ignore. A staged file whose working version differs contributes its working version. Ignored, untracked build output and scratch files outside the repository are not included. Declared artifacts have a separate preservation path; source capture is not a promise to save them.

The host copies the real index and its access and modification times to a private temporary index, preserving Git’s same-second edit detection. It scans candidates with `git diff-files` and `git ls-files --others` against the temporary index, expands any split index privately, and runs `git add -A --sparse`, `git write-tree` and, if needed, `git commit-tree` against that copy. Non-ignored untracked paths outside a sparse-checkout cone are included without expanding the user’s checkout. Modified-path counts come from `git diff-index --cached` on the temporary index; no working-tree porcelain diff reads or refreshes the real index. When no index exists, it starts the temporary index from HEAD. These operations add only Git objects to the source repository. They never change the user’s index, worktree, HEAD, refs, branches or stash, never run hooks, and disable automatic garbage collection and maintenance. The temporary index is removed on success or failure. A clean checkout returns HEAD itself.

The synthetic commit is a child of the real HEAD. Its message is fixed and its author, committer and dates come from that HEAD, so the same content over the same HEAD yields the same commit and owner address. The snapshot records the real `userHead`, `includesUncommitted`, modified and untracked path counts, and, when dirty content was included, `uncommittedOrigin` with its host, environment and native path. `sourceHead` and `tree` identify the synthetic commit and its exact tree, not the real HEAD’s older tree.

Submodules and nested repositories, including Git’s trailing-slash untracked directory entries, refuse with `submodule-unsupported`. Unfinished merges, cherry-picks, reverts and rebases are also refused. The existing transfer bounds apply to the entire delta from the fetchable base: at most 50,000 paths, 100 MiB per blob and an 8 MiB manifest. The snapshot host RPC returns expected refusals as `unavailable` with the native code, message and `retryable` value, so transient source changes retain Retry across the host boundary. Failures never fall back to HEAD or a laptop checkout. Snapshotting is not a filesystem freeze: the host checks for changes during capture, and submission capture also checks thread activity under a content hold.

## Submission binding

`PlacementSubmissions.capture(makerThreadId, waypointId)` first waits for an idle, active maker. A working maker returns a visible waiting result without requesting an interruption. Its persisted idle-only content hold blocks Tavern’s own sends before confirmation; confirmation and sweep observe idle state without stopping a turn. Finishing the last idle-only reason clears the resume requirement that the hold introduced. A pre-existing fresh-brief requirement, or one introduced by an overlapping away or interrupting hold, remains in force. An external user message can still start a turn. The capture checks SDK status and activity again before and after the snapshot and home transfer; a changed turn discards the result rather than publishing it for review.

Each submission gets a fresh server-minted submission ID and review key. The descriptor records all linked done journal targets and their SHA-256 fingerprints in `journalTargets`; `journalTarget` remains the first entry for existing transport checks. The review key lives only in the maker’s private `submissionTarget` and the resulting `ReviewTarget`, not in the snapshot or its content address. The current placement generation, held token, journal entries and SDK endpoints are rechecked around host calls and before publication. Only the owner-backed, verified home import yields a published review target. During import, a capture-scoped read capability is fenced by its placement generation and active hold and is removed when the transfer settles. After the final activity and journal checks, the placement’s `submissionSnapshotId` records the successful submission. Failed captures leave both snapshot references unchanged. The original `sourceSnapshotId` always identifies the carried starting tree, so another `tavern_ready` call does not mistake a submission for a new source carry. `journalEntryFingerprint(entry)` normalizes the entry through the journal schema before hashing, giving submission capture and the verdict gate the same fingerprint. No step changes the member’s remote detection-only label.

## Preservation before controlled release

`PlacementPreservation.beforeRelease(memberThreadId, reason)` saves a placed member while its unarchived thread still owns its machine. Ordinary capture waits for idle without interruption. Tavern release and quest stop retain their existing stop first; an unconfirmed stop remains visible and does not authorize saving a changing checkout. Finished quests can take preservation-only idle holds without reopening ordinary work.

Preservation takes the same read-only snapshot with purpose `wip`, then verifies and pins its exact tree at home through the content owner. An unchanged, already-pinned initial or submission tree needs no new source transfer. Journal evidence of kind `file` is separate: relative paths resolve from the checkout, and absolute paths must stay inside the checkout or the SDK's thread-storage root. Thread storage may belong to a different host. Explicitly declared ignored files are included; undeclared ignored files and outside scratch paths are not promised. Host checks reject missing files, symlinks and unsafe traversal. File chunks and durable home receipts must match their declared size and SHA-256.

A strict private `placementArtifactManifests` record contains the declarations, file identities, saved storage keys, reasons for anything not preserved, and the thread activity baseline observed under the hold. The placement references this row by `artifactManifestId`. Portable backups exclude these host-local manifests and reject imported copies. A missing, outside or failed declared file blocks release rather than treating the source tree alone as complete evidence. Retry re-inspects and saves the declarations while retaining the live owner.

Only after source and declared evidence are saved does preservation enter `releasing`, archive the member through core, release its placement-owned home grants, and record `released`. Private snapshot refs and their shared owner grants remain for the deferred cleanup described below. If a fresh turn starts before archive, the save is invalidated and the owner stays live. Any retry with a still-live thread recaptures; a cleanup retry after confirmed archive uses the saved receipts without reading a vanished source. Cleanup failures remain visible rather than claiming the machine is retained after archive.

A cancelled child with no provisioned environment, no queued or background work and no recorded turn can be released with source `not-needed` and reason `never provisioned`. A still-provisioning child does not qualify. External thread archive, deletion, environment removal or host deletion cannot be vetoed; unfinished preservation records `lost` or `unknown` and drops its live-owner claim. Previously verified source or artifact receipts remain useful evidence, not proof that the machine survived.

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

The caller cannot supply either ID through `SourceCapture.initial(source, signal?)`. Repeating the same capture preserves the original descriptor's creation time and diagnostic path counts. Staging an already captured file changes the index classification, not the captured tree or its identity; the existing descriptor keeps the counts observed at its first capture. Changed content or provenance creates a new owner; changed bindings create a new descriptor. Neither changes an existing record.

The private `tavern_snapshot_owners` table holds one home ref and one pinned import commit per owner. New descriptors name their owner with `ownerId`; their stored `homeCommit` stays null. Reading a descriptor resolves that commit from its owner, so pinning it through one descriptor is visible through every descriptor without copying the import state.

Owner-backed `PlacementTransport.bringHome` uses native placement authority `snapshot-<ownerId>` and the owner's generation. Its source-read, home-import and home-verification grants and transfer identity are deterministic for that owner and generation. The sole durable home-transfer receipt, exact manifest and upload handles live on the owner, not on each consuming placement. Original native registration thread labels stay immutable even when another descriptor resumes the operation.

Simultaneous requests share work within the same controller API lifetime, including across transport instances. Each requester independently checks its current placement, descriptor and home SDK endpoint before returning its own descriptor. The in-memory promise is not authority: a private persisted operation token, current owner generation and lifecycle fence all native awaits. A restarted controller can supersede an old token and reconcile the same immutable native transfer; an old continuation cannot publish through that replacement token. A cancelled operation retains its durable receipt and any native content for retry; it never releases another placement's reference or resets a user checkout.

The exact manifest is persisted before upload. After every blob has been uploaded, phase `applying` is persisted before the native import call. Applying and verified retries need only the home endpoint, so a lost import reply is recoverable even after the maker becomes unavailable. They replay the same native import identity and request, checking its completed-import receipt and exact private ref, then independently re-export the pinned home tree. This is reconciliation of one import, not a new per-placement import. Changed private refs are a visible hold, not permission to overwrite them. Only the native verified result can complete the owner receipt and expose its home commit; bringing content home never publishes member readiness or guard arming.

Legacy snapshots without `ownerId` remain readable and retain their existing pin and explicitly separate per-placement transport behavior. That compatibility path is not shared-import or terminal-lifetime proof. It does not silently promote legacy native grants into an owner or claim an old ref; new shared captures must use owner-backed descriptors.

## References and release boundary

References are derived from placement rows, not maintained in a second table. A non-terminal placement retains every owner named by any of its source descriptor, latest successful submission descriptor, review target, preservation descriptor, historical bring-home receipts or carry receipts. A placement is terminal only when its phase is `released`. Cancellation, a blocked state, preservation and release-in-progress all retain the owner. This deliberately retains historical snapshots until the placement is terminal.

`SnapshotStore.beginRelease` checks all descriptors of the owner and writes a `releasing` tombstone in one immediate database transaction only when no non-terminal placement names them. New captures and new or changed placement references refuse a non-retained owner. It does not call native cleanup or prove that operations have drained.

The next lifecycle slice must drain reads and carries, preserve source and declared artifacts, and confirm terminal placement state before native cleanup. The agreed native seam is `releaseSnapshotRef(TransferAuthority)`, which derives the exact ref and expected commit from a completed import and deletes by compare-and-set. Endpoint release is separate. These cleanup and capacity APIs are not consumed by this transport slice. A closed native generation must never be reopened or its endpoint IDs reused; reacquiring identical content after terminal cleanup needs a new owner authority generation while preserving the content address. That transition is not implemented here, and non-retained owners refuse capture rather than silently reviving.

## Retained private refs

This version deliberately leaves private refs in the Keeper’s home repository. Their exact namespace is `refs/tavern/snapshots/<full-owner-id>`, where the suffix is the 64-character lowercase owner hash described above. Each ref belongs to one private `tavern_snapshot_owners` row, not to a branch, a particular Warden or the user. Descriptors sharing that owner share the ref. Source-side synthetic commits have no source ref; the home ref pins the verified imported tree against garbage collection.

A later cleanup command can enumerate candidates read-only with:

```sh
git for-each-ref --format="%(refname) %(objectname)" refs/tavern/snapshots/
```

Enumeration is not deletion authority. Cleanup must resolve each full hash to its private owner, require every referencing placement to be released, drain current imports and carries, and verify the exact recorded home endpoint and completed native import receipt. Unknown refs or refs whose tips changed must remain untouched. The native `releaseSnapshotRef` seam derives the owned ref and expected commit and deletes by compare-and-set; it must precede separate endpoint release. Never delete by prefix, force-update a ref, or infer safety from its age. Owner-generation reuse after terminal cleanup remains deferred.

Owner, placement, discovery and source records are private authority. Portable record backups exclude them, reject forged imports of their tables and refuse restoration into a destination containing them. Unknown future Tavern tables remain fail-closed.
