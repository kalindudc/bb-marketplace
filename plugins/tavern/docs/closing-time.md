# Closing time

Open a Closing time window when you step away so Tavern pauses or restricts work and hands you a digest when you return. Tavern is open by default.

## Closing and returning

Open **Closing time** from the Common room and set:

1. **Back at** time (suggested from `away.default_back_at_hour`, default `8:00` local time) and an optional note (up to 500 characters).
2. **An end state for each included quest:**
   - **Drafts-ready** (default): lets guarded local work continue under the window's temporary stop list. A drafts-ready quest can complete internally while closed (saving its tale and closing open asks), while member thread archival waits until you return.
   - **Pause:** interrupts active member turns and holds new work. Does not stop the quest, release slots/machines, or change manual Keeper quiet state.
3. **Temporary stop list** (saved with the window; later Settings edits do not alter an open window). Default (`away.never_while_closed`):
   - `merge`, `deploy`, `production`, `sends-as-you`, `delete`, and `other-writes` (broad create/update/patch tools, pushes to non-main branches, and unattributed GitHub/HTTP writes).
4. **Watched work toggle** (`away.default_allow_watched`, default `false`): off by default. Turn on only if you explicitly want unguarded/watched members to keep running without pre-execution prevention.

### Who is held vs allowed

- **Excluded quests:** Held while closed. Side quests follow their parent quest; unattached errands are always held.
- **Guarded local Pi members** (installed, non-stale shim in `enforce` mode with the current window's denials applied): allowed in Drafts-ready quests under the temporary stop list.
- **Watched / remote / non-Pi members:** Held by default unless you explicitly enable watched work on the closing form.
- **Solo threads:** Never interrupted or held by Closing time; locally guarded solos still receive the temporary stop list.

### Returning

**Back at** is a reminder, not an automatic reopen—after it passes, the window shows **Due back** with holds still active. The window ends when you:
- Click **Return** on the Closing time page,
- Send a genuine new user message in a Tavern thread, or
- Answer an ask from a client.

Ticks, plugin messages, agent-only messages, and page reads never end the window. Returning does not replay held members' old briefs; Keepers receive a reopening digest on their next tick and issue fresh instructions, and deferred member archival resumes through the retry path.

## Wakes and reopening digest

| Setting | Default | Behavior while closed |
| --- | --- | --- |
| `away.default_wake_blockers` | `true` | Consequential blockers can notify you (respecting notification settings, quiet hours, and global pause). Expected closing-time holds do not count as blockers. |
| `away.default_wake_production` | `false` | Opt-in wake for production or cluster-write asks waiting longer than `away.production_wake_hours` (default `2` h, range `1–24`). |

Each wake is recorded once per window and ask, including across reloads. The digest bounds activity by event ID between close and return, groups reports and decisions by quest, lists asks waiting at return, and flags quests that returned while away with any pending member archival.

## RPC contract (contributors)

| RPC | Purpose |
| --- | --- |
| `away({})` | Current window, revision, `watchedCount`, `watchedByQuest`, `heldCount`, `pendingStops`, and `resumeRequired`. |
| `awayClose(input)` | Opens a window with optimistic `revision`; returns `closed`, `pending`, or `stale`. |
| `awayReturn({ windowId })` | Ends the window; returns `returned`, `unchanged`, or `stale`. |
| `awayDigest({ windowId?, cursor?, askCursor?, limit? })` | Reads current or completed-window activity (`limit` 1–100, default 30). |

Content transfers (machine snapshots and preservation) share the same durable member hold latch (`runtime.away.requestContentHold` / `confirmHeld` / `finishContentHold`) with independent reason identities so away holds and snapshot transfers never overwrite each other.
