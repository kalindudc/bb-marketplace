# Journal rules, reminders, and auditing

Use this reference for authorization invariants, quiet timers, reminder cadence, `pi-quests` coexistence, and the habit audit script.

## Rules and authorization

- Only top-level entries can have steps.
- A parent is done only after all its steps are done. A batch call is checked in its final state.
- Link and review permissions come from Tavern's recorded quest, member and assignment state, NEVER from thread metadata or a claim in a prompt. Ordinary verdicts need an active Warden on the quest, not a checker-slot assignment. The snapshot and scope checks for placed work still apply.
- The SQLite journal is the source of truth. The `quests.progress` metadata is only a compatibility mirror.
- The server marks a doing entry of your own quiet after ten minutes without a journal change or tool activity; owned delegated entries never mark your thread quiet. Quiet is a signal for a Keeper to check progress, not permission to interrupt the member.

## Reminders and delivery

- Tavern can send an agent-only `[Journal]` note during a running turn when no entry status changed since the previous message (from the user, another agent, or bb), or when a delegate's mark has waited unchecked for ten minutes. The note flags unchecked marks, entries reworded three times without a status change, and open entries whose text reads as finished. It sends at most once per stale stretch and never twice within 15 minutes.
- If the journal is empty, Tavern can send one hint after about 15 pieces of work with no journal calls. It does not repeat unless the user steers the thread, and never twice in the same turn.
- User edits and Warden verdicts are acknowledged once in the next journal result or in an agent-only `[Journal]` note during an active turn. A session snapshot may repeat current state and is not a delivery receipt. Notes MUST NOT start turns.
- Keeper threads receive no automatic journal steers; board phases drive their mirrors while pending human edits remain visible in the next journal result and session instructions.
- On providers without safe steering, read the next journal result and the session's journal instructions. Never simulate steering or start a new turn to deliver reminders.

## `pi-quests` and `quest` alias coexistence

- Tavern imports legacy `pi-quests` logs without deleting them. Disable `pi-quests` when adopting Tavern: both plugins write `quests.progress`, so Tavern defers legacy import, ordinary checklist edits, and progress mirroring while `pi-quests` is enabled. Trusted Keeper assignments still wait for legacy IDs to be reserved and write only to Tavern's database.
- The deprecated `quest` tool and `quest-management` skill remain compatibility aliases. Use `journal` for new work; existing sessions exposing only `quest` support the same actions and return the same guide on `rules` and `skill`.

## Auditing journal habits

From `plugins/tavern`, run `node src/server/journal/journal-audit.mjs --logs <exported-log-directory> --json` to audit saved thread logs without contacting bb (omit `--logs` to read recent threads via the bb CLI). It measures adoption, end-only closure, silent stretches (ended only by state changes, not rewording or notes), rewrite share, `start` usage, longest gap without a close, reminder follow-through within five minutes, and counts of evidence, blockers, and Warden verdicts. These metrics measure tool use, not the truth of the work.
