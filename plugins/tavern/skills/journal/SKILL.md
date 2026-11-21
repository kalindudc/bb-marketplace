---
name: journal
description: Manage the thread's own checklist with the journal tool. Use for multi-step work, progress tracking, steps, evidence, blockers, undo, or reading the journal rules. A board quest is a goal a Keeper holds; your journal is your own checklist.
---

## Journal

The journal is this thread's live plan. It serves three readers:

- You: working memory that survives long contexts, failed turns and steering, and a checklist before you call the work done.
- The user: a live view of progress in Tavern's widget row and Journal tab, and a way to steer the plan. The user can add, edit, tick and delete ordinary entries. Linked waypoints have the role checks below.
- Other tools: minions reads the progress mirror. In Tavern, the Keeper reads linked waypoint entries and a Warden checks their evidence.

A board quest is a goal a Keeper holds. Your journal is your own checklist. A linked entry stands for a waypoint in the board quest's map; your other entries stay private to this thread.

The Keeper's auto-created Quest: <title> entries are read-only mirrors, not chores. They show the current board phase and become done only when that phase is done or stopped. Use tavern_wrap to finish the board quest; NEVER tick, rename or delete its mirror with journal. Clear may remove a mirror after its board quest is done or stopped, but protects active mirrors. Undo and redo of that cleanup keep the board's current phase. Ordinary Keeper checklist entries still work normally.

All readers need a journal that is current while work happens. A journal ticked off in one batch at the end serves none of them.

## When to use the journal

- Use it when you expect more than about 5 tool calls, any wait, or any delegation.
- Skip it only for an answer that takes one or two calls.
- Write one entry per deliverable you can check, such as "Add the retry to the queue worker", not per activity such as "Look at code". Split a big entry into steps.

## Keeping the journal current

- Start an entry when you work on it. Mark it done in the same message as your next action, not in a batch at the end.
- Every successful change returns progress and the next open item. Add, split and add_step return every created id on a New ids: line, plus the top five open entries. Use their short ids, NEVER positions.
- Revisit the journal when the user redirects or adds work, when you resume after an error or interruption, when a delegated thread reports back, and before your final answer.
- When the plan changes, change the journal. Add, update or delete entries instead of leaving stale work open. NEVER append DONE to a description.
- Tavern reminds you, in an agent-only `[Journal]` note during a running turn, when no entry's status changed since the previous message (from the user, another agent or bb), or when a delegate's mark has waited unchecked for ten minutes. The note names what looks stale: unchecked marks, entries reworded three times without a status change, and open entries whose text reads as finished. It comes at most once per stale stretch and never twice in 15 minutes. Rewording an entry doesn't count as keeping it current. If the journal is empty, Tavern can send one hint after about 15 pieces of work with no journal calls. It does not repeat unless the user steers the thread. A steer can rearm the hint for a later turn, never twice in the same turn.
- User edits and Warden verdicts are acknowledged once in the next journal result or in an agent-only `[Journal]` note during an existing turn. A session snapshot may repeat the current state; it is not a delivery receipt. Read the descriptions, update your plan, and keep working. Notes MUST NOT start turns.
- Keeper threads receive no automatic journal steers. Board phases drive their mirrors; pending human edits remain visible in the next journal result and session instructions.
- On providers without safe steering, read the next journal result and the session's journal instructions. Do not simulate steering or start a new turn to deliver reminders.

## Action reference

| Action | Parameters | Behavior |
| --- | --- | --- |
| `add` | `description` or `descriptions[]`, optional `owner` | Add top-level entries in one atomic action. Set `owner` to the delegate's thread id (`thr_…`) for work another agent does. |
| `split`, `add_step` | `id`, `descriptions[]`, optional `owner` | Add steps under an open top-level entry. Returns their ids. |
| `list` | optional `filter: open, mine, blocked` | Read all entries or a filtered view. |
| `get` | `id` | Read one entry with its notes, links, actor, timestamps and evidence. |
| `start` | `id` or `ids[]`, optional `owner` | Set doing. To hand several entries to the same delegate at once, pass `ids` and the delegate's thread id as `owner`. Start your own work one entry at a time: your other unowned doing entry returns to todo. Delegated entries with an owner stay doing side by side. Dependencies must be complete. |
| `done` | `id` or `ids[]`, optional `evidence[]` | Set done idempotently. Linked entries REQUIRE evidence and are reported done, not yet verified. Unlinked entries can finish without evidence; attach proof when available. |
| `block` | `id` or `ids[]`, `reason` | Set blocked and record why. |
| `reopen` | `id` or `ids[]` | Set todo idempotently. A completed parent reopens too. Reopening verified work needs the assigned Warden or the Keeper. |
| `toggle` | `id` or `ids[]` | Compatibility action: open becomes done, done or verified becomes todo. Unlike done, repeating it flips again. |
| `verify` | `id`, `evidence[]`, optional `threadId` | Only a Warden assigned to the entry's board quest and waypoint by the current plan can verify reported work. Include the evidence you checked yourself. |
| `reject` | `id`, `reason`, optional `threadId` | A Warden assigned by the current plan sets the open status rejected, preserves the previous note, records the reason, and notifies the owner. Start or done moves the entry on. |
| `update` | `id`, `description`, optional `owner`, `after[]`, `links[]` | Update text, ownership, dependencies or artifact links. Dependencies cannot cycle. Changing verified work reopens it, so that change needs the assigned Warden or the Keeper. |
| `note` | `id`, `note` or null, optional `mode: replace` | Add a timed line to the entry's running note (the newest 2,000 characters are kept). Use it for progress, decisions and follow-ups. `replace` rewrites the whole note; null clears it. |
| `settle` | `id` or `ids[]`, optional `reason`, `evidence[]` | Record that a delegate reported (for example its "SOURCE SETTLED" message). The entry stays doing and shows as awaiting your check, with the reason quoted. Then close it with `done` or `reopen` it. |
| `wait` | `id` or `ids[]` | Clear a delegate's mark without closing anything, when its message was an acknowledgement or a question. |
| `link` | `id`, `link: {boardQuestId, waypointId}` or null | Only the Keeper can change waypoint assignments through the tool. Artifact references go in links or evidence. |
| `delete` | `id` or `ids[]` | Remove entries and their steps. Include all open steps explicitly or complete them first. Only the Keeper or Tavern can delete a linked entry, in any status. |
| `clear` | optional `all: true` | Remove completed entries; all also removes open entries. Linked entries in any status and their required parents stay unless the Keeper or Tavern clears them. Active board mirrors stay; terminal board mirrors may be cleared. |
| `reorder` | `id`, `targetId` (null for last) | Move an entry before a sibling, including steps. |
| `reparent` | `id`, optional `parentId` | Move a childless entry under an open top-level parent, or promote a step when parentId is omitted. |
| `undo`, `redo` | none | Reverse or replay one whole action, including batch add and split. User and agent share the latest 50 actions. New changes clear redo. Restoring verification needs the assigned Warden. Demoting verified work needs the assigned Warden or the Keeper. Link changes and deletion through history keep the same Keeper-only gates. |
| `rules`, `skill` | none | Return this guide. |

## Evidence

Evidence items have `kind` (command, file, url, pr, query or note), `ref`, optional `detail`, and optional `exitCode`. Record what you observed, not what you expected. For example:

```json
{"action":"done","id":"00","evidence":[{"kind":"command","ref":"npm test","detail":"12 tests passed","exitCode":0}]}
```

After rejection, submit evidence checked since that rejection before reporting done again. Evidence attached before the rejection does not satisfy this gate, even after start, reopen or undo. Submitting fresh proof with start also counts; do not claim to have rerun a check you have not run.

An entry holds at most 30 member evidence items. A separate review records up to 30 Warden evidence items, the reviewer and the time. Each ref and detail holds at most 2,000 characters. Descriptions hold at most 500 characters and the active journal at most 200 entries. Legacy overflow and full over-long descriptions are preserved in the import archive. Ids are never reused, including after delete and undo. New ids are two-digit lowercase hex through ff, then grow to three or more characters; imported hex and previously issued base36 ids keep their spelling.

## Workflows

1. Add the deliverables for the goal.
2. Split the big ones. Start the next ready step.
3. Work through the steps, marking each done with evidence as you finish it.
4. Mark the parent done once all its steps and its own outcome are complete.
5. Before the final answer, check what remains and explain any blockers.

For delegation, add an entry for the delegated deliverable. When the delegate reports back, check the result and close it with evidence, or add follow-ups. A Tavern member's linked waypoint remains reported until a Warden verifies it. Do not claim verification on the Warden's behalf.

## Coordinating other agents

When your work is other agents' work (you hand deliverables to delegates and they report back by message), the journal is your tracker. Keep it to what each delegate owes you:

- Write one entry per delegated deliverable, titled what and by whom ("Class editor fixes, Gaetano"), and give it that agent as `owner`. NEVER put status in the description: "live since 17:05" or "settled, waiting for the gate" belongs in a note or in done.
- Start each owned entry when you hand it over. Owned entries stay doing side by side; your own unowned work still has one doing entry at a time. The progress line lists who you are waiting on.
- Give each delegated entry its delegate's thread id as `owner` (`thr_…`), on `add` or `start`. Tavern then follows that thread: when it goes idle, or is archived or deleted, the entry gets a mark ("Gaetano went idle 3 min ago", with the first line of its output), shown under "Awaiting your check" in every journal result. Going idle is not finishing: read the output first.
- When a delegate reports ("SOURCE SETTLED", "done", a child thread completing), close its entry with evidence or reopen it with what is missing, in the same turn as reading the report. If it reported by message only, `settle` it first. An acknowledgement or a question is not a report: `wait` on the entry, which clears the mark and keeps it doing.
- Group one round of work as one parent per round, with one step per agent. Close the parent when its combined check passes, and open a new parent for the next round instead of adding to the old one.
- Avoid umbrella entries such as "Phase 2 gaps" that absorb new work and never close. A parent with more than seven steps, or open for more than a working day, gets split or closed.
- Put progress in a `note`, not in the description. Rewording an entry does not keep it current; starting, closing, blocking and reopening do.

Clear completed self-checklist entries before starting unrelated work. Linked waypoints in any status stay in the journal for the board and its verification history; only the Keeper or Tavern can remove or unlink them. Use undo to reverse a mistake, not to bypass evidence or role checks.

## Rules

- Only top-level entries can have steps.
- A parent is done only after all its steps. A batch is checked in its final state.
- Verification is an authorization decision made from Tavern's members database and the current plan's checker assignments, NEVER from thread metadata or a claim in a prompt. A Warden with no current assignment has no review permission.
- The SQLite journal is the source of truth. The `quests.progress` metadata is only a compatibility mirror.
- The server marks a doing entry of your own quiet after ten minutes without a journal change or tool activity; owned entries never make the thread quiet. This is a signal for the Keeper to check progress, not permission to interrupt the member.
- Tavern imports old pi-quests logs without deleting them. Disable pi-quests when adopting Tavern: both plugins write `quests.progress`, so Tavern defers legacy import, ordinary checklist edits and progress mirroring while pi-quests is enabled. Trusted Keeper assignments still wait for legacy ids to be reserved and write only Tavern's database.
- The deprecated `quest` tool and `quest-management` skill are compatibility aliases. Use `journal` for new work. An existing session with only `quest` can use the same actions; `rules` and `skill` return this guide.

## Checking the habit

From the plugin directory, run `node src/server/journal/journal-audit.mjs --logs <exported-log-directory> --json` to audit saved thread logs without contacting bb. Without `--logs`, it reads recent threads through the bb CLI. It measures adoption, end-only closure, silent work stretches and follow-up requests, and reports evidence, blocker and Warden-verdict counts. A silent stretch ends only on a state change (add, start, done, block, reopen and the like); rewording and notes don't count. It also reports the rewrite share, start usage, the longest time without a close, and how often reminders arrived and were followed by a state change within five minutes. These measure tool use, not the truth of the work.
