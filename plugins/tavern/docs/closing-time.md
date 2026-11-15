# Closing time

Closing time records an away window and holds work that cannot safely continue. It is open by default. This is the source contract; a combined build and live verification are still required before treating it as shipped.

## Closing and returning

Choose a Back at time, an optional note of at most 500 characters, and one end state for each included quest:

- Drafts-ready permits private work where the current local guard can apply the temporary stop list.
- Pause interrupts member turns and holds further work. It does not stop the quest, release a slot or machine, cancel a generation, or change the Keeper's manual quiet state.

Party members of quests left out of the closing selection are held. Side quests and errands follow their parent quest's selection: pause is held, and drafts-ready permits guarded private work or explicitly opted-in watched work. An errand with no parent quest is held even when watched work is permitted.

Solo threads are not interrupted or held by Closing time. Locally guarded solos still receive the temporary stop-list checks, but unguarded or watched solos keep running without that prevention promise. Solos are not included in the party's watched-member counts. The closing confirmation must not describe them as paused.

The fixed stop list is merge, deploy, production, sends-as-you and delete. Closing time never grants new consent or widens a scope.

Back at is not an automatic reopening time. After it passes the window is due back, with the same holds and stop list. Explicit Return, a genuine new user message in a Tavern thread, or an accepted client ask answer ends the window and records its cause. Ticks, plugin messages, agent-only messages and page reads do not end it. Old queued user rows do not count as a new return.

The SDK labels the app, CLI and agents alike as client. RPC mutations refuse plugin callers, but client identity cannot prove a human made the request. The explicit Return and ask-answer paths share that host limitation; see [host ask 2](host-asks.md#2-distinguish-human-driven-clients-from-agents). Genuine dispatch returns additionally require the user initiator and real user authorship.

## Guarded and watched work

A local Pi member counts as guarded only with an installed, non-stale shim, enforce mode, pre-exec posture, a local scope record, and the exact current-window denials. The contributor appends tool and shell denials to the final bound copy. It does not change the base template, original grants, roots or environment. Closing and returning await local rebinding; failed binds are logged and retried. Without the current restrictions, the member is watched and held by default.

The closing form can explicitly permit watched work, labelled watched, not prevented. That choice is off by default and does not change a scope. Native host-bound members remain watched even when an older native policy has an ACK. A separate delivery revision and receipt for the exact current-away policy are not implemented here.

New guarded local Pi hires are admitted only through the existing local execution path and receive their temporary scope before their first dispatch proceeds. Unknown or remote targets do not inherit that claim. Active machine rules retain conservative admission until the machine integration supplies its own proven posture.

These are pre-exec checks of named tools and inspected shell actions, not operating-system isolation or a universal analysis of arbitrary code and network effects.

## Holds and cleanup

A held member retains its ownership and files. Interruption uses the normal threads.stop API and confirms the resulting thread state. One shared eligibility rule drives watched counts, hold staging, interruption retries and content-hold admission: completed, stopped, archived, released or cleaning-up members and members of a finished, archived or missing quest are ineligible. A pending brief does not override a completed state; actual resumed activity must make the member eligible again. Interruption checks fresh SDK archive/deletion state before stopping and rechecks eligibility and the hold token after awaits and before clearing each queued message. Failures for eligible members remain durable and visible in pendingStops and retry from the sweep.

Closing and returning do not re-anchor archived Keepers. Tick creation, queue recovery and queued-tick admission also skip archived Keepers, including when fresh SDK metadata or an archival during an awaited read reveals the archive. A late member report or restart cannot authorize a tick to them.

The read-only closed-window dispatch fence applies to every queued turn, including inactive targets: new work waits until return. It does not create an inactive member hold, interrupt it or delete its queue. An untouched brief queued for a completed member can receive its first normal delivery once after Return; it is not delivered twice and does not become a permanent resume latch. If the thread was archived meanwhile, neither queued dispatch nor pending-brief retries send it work. This is separate from an active member's durable interruption hold, which still needs fresh Keeper instructions.

Returning does not replay a held member's old brief. Only Tavern's own queued messages are removed; user and other-plugin rows remain and must be reviewed before a fresh Keeper instruction can be sent. Keepers continue to receive facts and handle other quests. Their next eligible tick includes the reopening digest; manually quiet Keepers stay quiet.

A drafts-ready quest can wrap while closed once its waypoints meet the existing verification or explicit optional-skip requirements. This is internal completion only: save the tale, mark the quest done, close its open asks with withdrawnCause=quest-returned, and leave archivePending durable on its members. The wrap receipt records the away window and deferred member IDs. A paused quest cannot wrap.

No member archive call runs while closed, including archive retries. Finished members remain fenced against queued work after return until archival. Cleanup becomes eligible through the existing retry path after return. Any provider worktree or machine cleanup associated with archival is therefore deferred too; away mode adds no machine-release API and supplies no preservation proof.

## Shared content-transfer holds

Content transfers use the same durable member latch and dispatch fence, not a second idle flag or a fake away window. The server-only API on runtime.away is:

- requestContentHold(memberThreadId, {operationId}) returns an opaque ContentHoldToken synchronously, before interruption. Repeating the same active operation returns the same token. Inactive members are refused; an existing token inspects as stale if its member becomes ineligible.
- confirmHeld(token) interrupts through the shared sender and returns {state: pending | confirmed | stale, error}. inspectHeld(token) reads that state without interrupting.
- finishContentHold(token) returns {state: finished | stale} and removes only that content reason. It never resumes a member or clears an away reason.

Each reason has its own identity. A content token survives another reason being added, but a removed token cannot confirm or finish a replacement. Each row also has a monotonic version and a fresh mutation token. Stop completion updates the row only when that version and token still match, so a late success or failure cannot overwrite newer reasons. Legacy window-only rows are read without a migration and receive a persisted token before their next interruption.

Return removes only the returning window's reason from still-eligible members; inactive rows and their queues are left untouched. Transfers and away holds can end in either order; the other reason and resumeRequired remain. A fresh content request inherits an away window only while a previous stop or resume obligation remains. Once the member has fully resumed, a new content request clears that stale window metadata without changing any token or reason policy. A fresh Keeper instruction is refused while a content reason is active, while an interruption is pending, or while the away policy still holds the member. Once every reason permits work, the existing queue review and fresh-brief path applies. Old briefs never replay. Pending interruptions retry through the existing sweep even without an away window; the same eligibility rule used by the watched counts also excludes completed, archived, released, releasing, archiving, stopped and solo threads and members of finished or unavailable quests.

A confirmed interruption is not permission to transfer content, a placement-ready receipt, a preservation receipt or a machine lease. The consumer must persist its token in the private operation record and separately validate that operation, its current placement generation and lifecycle before and after every await. The portable latch contains only reason identities and interruption state. Restoring it cannot reconstruct missing private operation authority, authorize a transfer, allocate a placement or release a machine. All three private placement, source and discovery tables remain excluded from portable capture and restore, and still make a restore destination nonempty.

## Wakes and digest

Blocker wakes default on. Production asks older than two hours are opt-in. Both still respect existing notification preferences, quiet hours and Tavern's pause. A delivered wake is recorded once per window and ask, including across reload. An expected closing-time hold is not itself a blocker.

The digest uses event IDs, not wall-clock comparisons, to bound activity between close and return. It pages events and asks independently, includes asks already waiting at close, and records which were waiting at the return boundary even if answered later. It groups reports and decisions by quest.

For an internally returned quest, its digest row includes returnedWhileAway=true and deferredCleanup rows with threadId, action=archive-member-thread, pending and error. The page can say returned while you were away and list cleanup that remains pending. Missing cleanup state is not called completed.

## Contract

- room.away is {closed, until, dueBack, windowId, followUp?}; until is epoch milliseconds while closed and null while open. The current server always supplies followUp: true only for eligible pending stops or resume work associated with this window. A returned window keeps its id, but its followUp becomes false once that work is cleared. Content-only holds and holds from another window do not keep it lit. The page can read the full away control only while closed or followUp is true; older servers can fall back to windowId. Room reads derive the flag without calling the full away/scopes aggregation or changing state.
- away({}) reads the current window, revision, watchedCount, watchedByQuest, heldCount, pendingStops and resumeRequired members. watchedByQuest is an array of {questId, watchedCount}, with a null questId for unattached party errands. It includes zero-count rows for groups whose eligible members are all guarded; no row means no eligible party members and a count of zero. Released, releasing, archiving, archived and stopped members, Keepers and solos are excluded. Completed members remain excluded even with a pending brief, until actual activity resumes. Members whose quest is done, stopped, archived or missing are excluded even if their cached member state still says working. This filters the watched counts only; pending interruption and content-hold recovery remain visible through the existing hold fields. The field is optional for compatibility with older backend responses, but the new backend always supplies it. If the whole field is absent, per-quest counts are unavailable, not zero. These are current advisory counts, not a close dry-run or an authorization receipt; close rechecks actual guard availability.
- awayClose(input) returns closed, pending or stale with the new state. The request carries the expected revision.
- awayReturn({windowId}) returns returned, unchanged or stale with the new state.
- awayDigest({windowId?, cursor?, askCursor?, limit?}) reads current or completed-window activity. The limit is 1 to 100, default 30.

State, holds, wake receipts and history use existing Tavern records. No new SQL migration is needed. Portable backups validate these records and their window links. Live placement, source and discovery authority remain excluded from backups; a private source reference is not a byte backup.

The source verification covers store and policy boundaries, real local scope rebinding, first-turn admission, durable holds, wrap cleanup deferral and reload behavior. It is not evidence of a live native policy delivery, a live provider interruption or the next reliability run.
