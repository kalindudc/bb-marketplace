---
name: journal
description: 'Manage this thread checklist with the journal tool. Use for multi-step work (more than about 5 tool calls), any wait, or any delegation. Covers steps, evidence, blockers, undo, and tracking delegated agents.'
---

# Journal

The journal is this thread's live plan. It serves you as working memory across long contexts and steers, gives the user a live checklist in the widget row and Journal tab, and feeds progress and waypoint verification to minions, Keepers, and Wardens.

A board quest is a goal a Keeper holds; your journal is your own checklist. Members may link their own entries to assigned waypoints. Linked work needs evidence and follows the waypoint's planned check; unlinked entries stay private to this thread.

Keeper auto-created `Quest: <title>` entries are read-only mirrors of board phases, not chores. Never tick, rename, or delete an active mirror with `journal`; use `tavern_wrap` to close a board quest.

## When and how to keep it current

- Use the journal when you expect more than about 5 tool calls, any wait, or any delegation. Skip it only for an answer that takes one or two calls.
- Write one entry per checkable deliverable (such as "Add retry logic to the queue worker"), not per activity (such as "Look at code"). Split large deliverables into steps.
- Start the entry you are doing and mark it done in the same turn as your next action, never in one batch at the end. Every successful change returns progress and the next open item; use the short IDs in brackets, NEVER positions.
- Revisit the journal on user redirects, after errors or interruptions, when delegates report back, and before your final answer. When the plan changes, add, update, or delete entries; NEVER append `DONE` to a description.
- Add deliverables, split big ones, work through steps marking each done with observed evidence, and mark a parent done only after all its steps finish.

## Load the reference for your task

| Task | Read |
| --- | --- |
| Full action table, evidence JSON format, post-rejection proof, limits, and undo/redo gates | [references/actions-and-evidence.md](references/actions-and-evidence.md) |
| Tracking delegated agents with `owner`, idle marks, `settle`, and `wait` | [references/coordinating-agents.md](references/coordinating-agents.md) |
| Authorization invariants, quiet timers, reminders, `pi-quests` coexistence, and `journal-audit.mjs` | [references/rules-and-audit.md](references/rules-and-audit.md) |
