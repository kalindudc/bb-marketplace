# Changelog

Notable changes to Tavern, newest first. Releases are tagged `tavern/vX.Y.Z` in this repository.

## Unreleased

A returned or stopped quest reopens for deviations without a new quest, the checker recognises the check runners a repository actually uses, the pages and composer lose their rough edges, and the party is drawn as animated pixel art.

### Added

- Tavern's party is drawn as animated pixel-art characters. Every member is a small sprite with its own look (build, hair, hair colour, skin and a hat), seeded from the character's id and overridable in its character file's `look` block. The sprite walks, works and rests with the thread, follows the Keeper's state, and turns to face an ask.
- A continuous motion mode: with motion set to Lively, an unbounded ambient loop runs the sprites whenever their surface is visible. The strong stops still apply (reduced motion, a hidden or paused tab, and the typing hold), and an ask holds the widget row without freezing a standing sprite.
- A returned or stopped quest can be re-opened for deviations and follow-up commits without opening a new quest. `tavern_reopen` returns it to build, keeps its plan version and greenlight, clears its end and stop state, records `quest.reopened`, and reanchors the Keeper's thread. A live quest is refused; an archived quest must be brought up from the cellar first, and a deleted one restored from there.

### Changed

- The checker recognises the check runners a repository actually uses while keeping worktree confinement and the deny rules: any `npm`, `pnpm`, `yarn` or `bun run <script>`, `npx tsc` with or without `--noEmit`, a project binary reached directly (`tsc`, `vitest run`, `jest`), and a project binary reached through `node node_modules/…`. Other work (`npm install`, `npm publish`, `npx vitest` without `run`, `npx eslint`, scripts under `node scripts/…`, and path escapes) still needs exact-command metadata.
- The class page's records fold and remember what is open, the quest map's notes float over the map instead of reserving a band, and the rail keeps its calm order.
- The composer's ask row shows the whole question, a decision reads its note in place, and the composer no longer swallows the first click.

## 0.1.2 (2026-11-15)

### Added

- A returned quest's tale shows the Keeper's full delivery as bb draws it in chat, interactive blocks from installed renderers included. Tavern adds a renderer that runs no model and draws the Keeper's final message in a hidden thread, with today's rendering as the fallback until it answers.
- Keepers can attach results to a tale, up to four figures and one chart, which Tavern draws on the tale page and on the tale card in the thread. A block the page cannot draw shows as a card that opens the Keeper's thread.
- Send a returned or stopped quest to the cellar, or delete it, from the quest page. Both archive the party's threads, and the Keeper's thread when it has nothing else on the board or out as a side quest. A deleted quest can be restored from the cellar's Deleted view at any time; credits stay on the character sheets. Bringing a quest back unarchives only its Keeper, and Keepers can bring archived members back with a new tool.
- The widget's Member panel shows who the member is and its scope as chips, an at-a-glance card, and the brief, context and follow-ups in remembered folds. The composer widget takes Tavern's warm surface with a character-colour edge.
- The sidebar's Common room link shows the hearth, lit, while quests are running.
- Tuned values can be edited by hand. Tavern keeps adapting from your value unless you pin it, and each value says what it does.

### Changed

- Keepers have full access: new and existing Keepers use the open scope preset, and Tavern keeps your trusted scope policy, `~/.agents/tavern/scopes.yml`, protected in every open scope. Members keep their presets and can use read-only renderer checks such as `check_ui`.
- Settings are grouped into fewer sections with cards that say what each group is for. Settings history is folded by default and each change reads in words.
- The map fills the page's height, and its notes float over the map instead of reserving a band.
- When nothing needs you, the common room shows one short line and moves What happened up.
- Every scope Tavern writes records the preset it came from. A pi session started before this release must restart to read the new field.

### Fixed

- The widget no longer fails to load for members whose Keeper sent long follow-ups.
- A stored event with an unrecognised actor no longer breaks the common room, Closing time's digest or backups; new events are checked when written.
- The member panel's guard words match what the member actually had, including for finished, released and archived members.

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
