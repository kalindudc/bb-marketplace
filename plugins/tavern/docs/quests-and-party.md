# Quests, party, and characters

Use this guide to start and steer quests, manage budgets and delegation, scale long-running work, and customize classes and characters. See [How Tavern works](design.md) for the architecture and term definitions.

## Starting, scouting, and greenlighting

Open **Tavern**, choose **Start a quest**, and give your Keeper the goal, what a checked result looks like, and anything the team must avoid.

During scouting, Rangers answer numbered questions inside timed check-in boxes. At check-in, a Ranger reports its findings, evidence, remaining work, and time estimate, then waits. Only the Keeper decides whether to accept the result, extend the Ranger for another box, or release it.

Using that evidence, the Keeper proposes a quest map with waypoints, owners, check methods, and an optional spend cap. The plan card puts the goal, done-when, and party alongside the route and what comes back to you. Open **Exact commands** to see the checks or **Quest map** to see the drawn route. Explicit approval is the default before planned building starts. Plans with only Rangers skip the staffing greenlight when they have no user or outside waypoint, though proposed budgets and weaker checks still ask.

Updated cards and the quest page show changes since the last plan, starting with the Keeper's note. Revisions show every change and repeat only the done-when sentences that changed.

When the Keeper needs you to finish a move, answer its ask instead of ticking a Journal entry. The ask shows which choices finish the move. Declining or choosing another direction leaves it open. Existing Journal entries still work.

## Steering and verbatim wording

Keep talking in the same Keeper thread to steer its quest. If an older Keeper holds more than one quest, name the quest you mean. Tavern keeps questions, asides and standing rules separate from plan changes.

For an outside goal, the Keeper offers a choice: **Side quest** records the goal under the named parent for the Keeper to handle. **New Keeper thread** opens a same-project draft with your goal. You can edit it before sending. If there is no open parent, the card offers only the new thread. If the parent ends while you’re deciding, the new-thread choice stays open. Folding the card starts nothing. A returned, stopped or cellared quest still takes that thread’s one slot. Reopen the same quest for follow-up work.

Standing rules remain local to that Keeper until you widen them in the Ledger. To send one unchanged message to several Keepers at once, use **Tell selected Keepers** on the Common room.

Open **Answers** on a quest to see the Keeper’s recorded replies and unanswered questions or steers. A new answer appears in the Ledger with a link to its place on the quest page. **Search answers** in Tavern looks across Keepers and quests, including the original words quoted by an answer. Device notifications for answers are off by default. In **Settings → Your attention**, you can turn them on or change how many answers load per page.

When a Keeper hires or re-briefs a member, Tavern attaches your exact opening request and routed steers in order, omitting unrelated questions and asides. Builders and checkers always read your literal words rather than a paraphrase. Requests up to 4,000 characters appear inline, and longer ones page cleanly without clipping. If you steer a quest after a member starts work, the Ledger and quest page flag that member until a fresh brief is delivered. Quoted chat text never grants tools, widens scopes, or bypasses approvals.

## Quest controls

| Control | Where | What it does |
| --- | --- | --- |
| Hold and Resume | Quest page or chat | Pauses new hires and briefs without stopping running members or releasing machines. Resume restores the prior phase. |
| Rename quest | Quest page or Keeper | Updates an unarchived quest's title and short name without altering its plan or history. |
| Conclude or Close early | Closing ask | A quest never closes itself. Conclude writes the tale and archives the party; Close early names unfinished waypoints first. Both let you keep, take over, or close open pull requests, with keeping as the default. |
| Reopen | Quest page or chat | Reopens a returned or stopped quest for follow-up commits while keeping its plan and greenlight. Restore cellared or deleted quests first. |
| Stop quest | Quest page | Stops the quest's party, withdraws its open asks, and records an optional reason. Stopping a Keeper thread in chat only quiets its ticks. |
| Send to the cellar | Finished quest page | Archives the quest and its party, plus the Keeper if it holds no other live work. Deleted quests can be restored from the Cellar at any time. |

## Checking work and managing members

Smiths and Wanderers who change files in their own worktrees commit as they go and leave no uncommitted work at the end of a turn. Keepers do the same when they build in their own worktree. When a member's branch falls behind or conflicts, its owner rebases or merges into it, keeps both intents, and reports what they resolved. Pushing, merging into a shared branch, and publishing still need their usual approvals. If your agent rules forbid commits, allow them in member worktrees so members can commit there and keep their work from being lost.

Rangers leave the work unchanged. Wardens never edit tracked files, commit, or switch refs in the maker's checkout. Tavern's preservation before archive remains a safety net, not a substitute for commits.

Only a Warden verdict counts as verified work. Keeper reviews, outside replies, and optional skips are recorded in the journal. Reports deliver news without moving the waypoint. A Keeper can also record an existing branch, pull request, or path for a Warden to check without hiring a builder. After a rejection, the Keeper re-briefs the builder with the Warden's evidence, and the Warden can re-check corrected work across multiple rounds without a new plan version.

Finished members rest rather than being released on a timer. Keepers must reuse an eligible resting member before hiring a new one, can keep a working or resting member for expected follow-ups (up to seven days by default), and archive a member's thread once it is released and its work is preserved.

For ongoing duties, a Keeper can mark a planned slot or active member as permanent with a recorded reason. Permanent members skip rest reminders and stale alarms while staying subject to release, Stop all, and quest cleanup. A Keeper can also exempt a locally guarded permanent member from an explicit Closing time Pause so it keeps running under the window's stop list.

A permanent member can have up to three daily or weekly schedules, set in the server’s local time. Approve them in the plan or in a separate ask for an active permanent member. Tavern waits for the member to be idle, runs at most one overdue round per schedule, and respects Stop all, Closing time, quest holds and spend caps. The member row and Ledger show the next run. Use the member row to pause or remove a schedule.

## Spend, review, and party limits

- **Spend budget:** Set a dollar cap on the quest page or approve one with the plan. At the cap, Tavern holds new hires, briefs and scheduled rounds until you raise or remove it. Budgets count only measured spend (guarded local Pi receipts and Burn-reported sessions); uncovered remote sessions show as unknown, and already-admitted work can push spend past the cap.
- **Review budget:** Caps open review-bound items (default 3). When full, builder hires pause until reviews clear or you click **Allow one more review** on the quest page.
- **Party limits:** Settings enforce a hard per-Keeper party ceiling (default 5). Class limits and concurrent Ranger limits (default 3) are soft caps a Keeper can exceed by one with an undoable decision, never past the hard ceiling.

## Delegation, Always ask, and Undo brakes

On a greenlight or consequential ask card, you can delegate chosen kinds for that quest: production changes, merges, credentials, destructive actions, or named-target drafts. Delegated merges and production changes still require a Warden verdict on the exact commit or command, or a proven clean rebase. Cluster writes always ask you in two steps, and messages sent as you are never delegated.

Your **Always ask** list in Settings sets which kinds come to you by default. Every reversible call a Keeper makes appears in **Decided for you** with **Undo**. Undoing two of a Keeper's last ten calls of the same kind pauses that Keeper's autonomy for that kind across every quest until you press **Reset** in the Ledger.

## Refreshing a Keeper and Keeper chains

When a Keeper's context grows long, click **Refresh Keeper** on its Common room card. Tavern moves its quests and open asks to a fresh Keeper thread and records the handover in the Ledger. Keep the old thread unarchived until its members finish. If bb never confirms the new thread in time, control returns to the original Keeper.

If you choose **Side quest**, the hiring Keeper reserves a greenlit waypoint and briefs another Keeper with your exact goal. The side Keeper holds one party seat and shares the linked party ceiling and the parent spend cap. It cannot hire another Keeper. The hiring Keeper approves fitting plans; wider or user-only decisions keep their original card. Keep talking to the hiring Keeper. It forwards the exact steer and posts the answer with a link to the child result. Stop a side quest to stop only its party and Keeper; stop the parent to stop both. The parent cannot return while a side quest is still running.

## Classes, characters, and service records

Open **Classes** to view effective models and scopes, or edit a class in the side panel to save a global override under `~/.agents/tavern/classes/`. Project overrides under `<project>/.agents/tavern/classes/` take precedence, but can only narrow shipped scope presets.

The transparent strip above the composer shows a quest as a road with pixel-art stops for planning, reading, making, review, and reports. Characters work and wait at their stops. Click or tap a stop to see why it is there. On long roads, earlier stops fold into milestones. At night each class carries its own light; by day they carry tools under soft daylight. See [Contextual speech](settings-and-data.md#contextual-speech) to let Pi write optional remarks. Right-click a character (long-press on touch) to change motion or speech, quiet characters for an hour, hide the strip, or open its character sheet to edit lines and roll a new avatar seed.

Returned and stopped quests record permanent character credits that survive archiving and deletion: verified waypoints for builders, checks and catches for Wardens, and verified returns for Keepers. Characters gain one presentation-only level per eight earned results; levels are never shown to agents. Click **Keep** on a returned tale to pin it to a character's sheet history.
