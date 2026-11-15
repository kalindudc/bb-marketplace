# Changelog

Notable changes to Tavern, newest first. Releases are tagged `tavern/vX.Y.Z` in this repository.

## 0.1.1 (2026-11-15)

### Added

- Every character's own name, with Roman numerals for repeats (Vex, Vex II), in thread titles, the composer widget, the map and the Keeper's ledger. Keepers can name party members in their tools, and names stay unique while a thread is live.
- A quest's tale leads with what the Keeper brought back: its final message, drawn with bb's own message renderer, then a "What to do now" list. A Keeper can retell the tale of a returned quest without repeating any of the wrap.
- One quest page for live, returned and stopped quests, with a wider rail whose sections fold and remember it, and a road through the five phases that shows where the quest is or where it stopped.
- A member's class and scope at a glance: the widget row reads "Pip · Wanderer", and the Member panel opens with who the member is and what its scope lets it do.
- The review queue expands each item to show its quest, waypoint, report and who it is waiting for.
- Archived Keepers' quests on the map, behind "Show archived Keepers".
- Motion settings with Calm, Lively and Off, including continuous ambient motion and its intervals.
- Agents can preview and apply Tavern settings from a thread, such as character models, reasoning, motion and voice.
- Every class may write to temporary folders.

### Changed

- Guardrail settings (scopes, machine rules, greenlight and decision timers, notifications and quiet hours, and the switch that lets agents change settings) apply only from a plain thread or the Settings page, never from a Keeper or party member.
- The member brief panel renders the brief as readable fields.

### Fixed

- A returned or stopped quest archives its whole party, including members released mid-quest. A one-time repair archives members stranded by earlier quests and leaves any thread you archived or unarchived yourself alone.
- Skipped waypoints are never counted as verified.
- The needs-you section of the composer widget stays collapsed when you switch threads.
- The Keeper's status and the CLI keep review items short, so long report outcomes no longer crowd out its quests and asks.

## 0.1.0 (2026-11-15)

The initial release.

### Added

- Delegate a goal through a Keeper, scouting, an approved quest map, builders and a separate checker, with asks and standing rules recorded in a ledger.
- Follow quests from the common room, connection map and quest pages, open reports in a side panel and read returned results with evidence and credits.
- Keep a journal in every thread, with steps, blockers, linked evidence, assigned verification and grouped Undo.
- Inspect classes, edit character presentation fields, configure providers and pacing, inspect Insights and save private backups from the page or CLI.
