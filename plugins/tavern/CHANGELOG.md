# Changelog

Notable changes to Tavern, newest first. Releases are tagged `tavern/vX.Y.Z` in this repository.

## Unreleased

Machine rules put a project's party members on their own new machines (for example, any work in shop/world on an Aquifer World machine), a returned or stopped quest reopens for deviations without a new quest, the checker recognises the check runners a repository actually uses, the pages and composer lose their rough edges, and the party is drawn as animated pixel art.

### Added

- The composer party reacts to reports and waypoint verdicts and says short, authored lines from its character files. Full voice adds occasional words and greetings; Light speaks after a verification, at a quest’s wrap or on a click. Off keeps the party quiet. Typing, asks and blockers silence the strip. Automatic speech also gives reports and evidence room to read, including the first minute after a report arrives; clicking can still speak. Each line shows in a small pixel bubble with a filled tail, beside the speaker and inside the strip.
- The composer draws its character on a single pixel-art canvas above the widget row, which keeps its class crest. Calm idles in place; Lively walks across the composer when the character is idle or working. Typing stops travel but keeps a quiet idle. An ask in the widget row holds the character still. Motion Off and reduced motion also show a still pose.
- Characters on the page share one animation scheduler. It pauses off screen and in hidden tabs and reduces physics updates if drawing and updating go over budget. The Characters setting still removes the strip without removing the class crest.
- The live character strip draws seeded avatars with rounded faces, varied hairstyles, and period clothing and tools chosen by class. The character file's avatar seed, or its id when no seed is set, keeps each look stable. The class tools and hats have distinct silhouettes. Verified characters give a small, warm smile and lift their tools; waiting, blocked and failed characters show a still pose.
- The character sheet groups bubble lines by mood and explains the tokens Tavern fills in. You can edit those lines in the voice editor and save them to your character override. The older voice slots are unchanged.
- The character sheet and its editor show the character's live avatar. Roll draws a new look, Put back returns to the saved one, and Keep saves the seed as `avatar` in your character override, so the composer and every other surface draw the same character. Traits pinned in the file's `look` stay fixed.
- Machine rules place a Keeper's newly hired working members on their own new machines. An enabled rule in Settings, Where work runs, that matches a project puts every new Ranger, Smith, Warden and Wanderer of that project on its own new machine, through the environment and machine providers bb's catalog offers; Tavern has no provider of its own and depends on no other plugin. Keepers stay wherever the user started them and are never moved. A lead runs where its hiring Keeper runs, unless the Keeper names an enabled rule for that project with `placementRuleId`. Maker and checker slots per Keeper cap the machines in use, and waiting for a slot is a visible hold, never a quiet fallback to this machine. Only rules that ask for a new machine with a dedicated checkout run in this version; other targets save, preview, and block the hire with a plain reason.
- A placed member starts from the Keeper's exact source: the pushed base, the unpushed commits and, when the Keeper's checkout has uncommitted changes, its changed tracked and untracked files. The snapshot is read through a temporary index, so the user's index, worktree, HEAD, refs, branches and stash are never touched; sparse checkouts are supported. The hire result's first line says where the member went, which rule placed it, and whether uncommitted changes came along and from where. The member's first turn calls `tavern_ready`, which binds its machine, carries the source in and delivers its scope. A placed member is labelled "Detection only (remote)"; when its scope changes, Tavern delivers the new scope to the machine itself and shows "Scope update pending" until the machine acknowledges it.
- A Warden checks a placed Smith's work on a machine of its own. Tavern waits for the Smith to finish its turn (it never interrupts it), brings the Smith's committed and uncommitted work home under a private ref, and carries that exact tree into the Warden's checkout. A verify or reject counts only while the Warden's checkout is clean and holds the submitted tree, and the maker's journal entries, submission, waypoint and assignment are unchanged; a newer submission supersedes the review. A placed Smith with a Warden whose rule gives it no separate machine blocks the hire and names the rule to add.
- Before Tavern lets a placed member's machine go (release, wrap, quest stop, archive, a finished errand, a cancelled hire), it saves the member's work and its declared file evidence home, then archives the thread so bb's normal cleanup removes the machine. A failed save keeps the thread and the machine and shows a blocker with Retry. Declared files that live outside the member's checkout and thread storage, or no longer exist, are listed as not saved with the reason. A member whose thread or machine was lost outside Tavern is released with a plain note that its work was not saved, never recorded as saved. The private snapshot refs Tavern keeps in the home checkout are described in `docs/machines-snapshots.md`.
- Every member surface (the ledger row, the quest page's member card, the widget and the member brief) shows where a placed member runs, the rule that placed it, its setup phase or blocker with Retry, and its posture. A machine that is still starting shows its provider's name, never an invented host name. The Keeper's ledger says where its party would run when a rule could apply to its project, and `tavern_status section=placement` gives the full picture per class with the slots in use.
- A returned or stopped quest can be re-opened for deviations and follow-up commits without opening a new quest. `tavern_reopen` returns it to build, keeps its plan version and greenlight, clears its end and stop state, records `quest.reopened`, and reanchors the Keeper's thread. A live quest is refused; an archived quest must be brought up from the cellar first, and a deleted one restored from there.

### Changed

- The checker recognises the check runners a repository actually uses while keeping worktree confinement and the deny rules: any `npm`, `pnpm`, `yarn` or `bun run <script>`, `npx tsc` with or without `--noEmit`, a project binary reached directly (`tsc`, `vitest run`, `jest`), and a project binary reached through `node node_modules/…`. Other work (`npm install`, `npm publish`, `npx vitest` without `run`, `npx eslint`, scripts under `node scripts/…`, and path escapes) still needs exact-command metadata.
- The class page's records fold and remember what is open, the quest map's notes float over the map instead of reserving a band, and the rail keeps its calm order.
- The composer's ask row shows the whole question, a decision reads its note in place, and the composer no longer swallows the first click.
- A quest never concludes itself. The Keeper's final summary opens a conclude ask with three options: conclude the quest, hold it for other work, or open extensions and side quests. The tale is told and the party archived only after your answer, and holding keeps the quest and its party open. Retelling an already returned quest asks nothing new.
- A hire result names the resting party you could reuse, with thread ids, as advice rather than a refusal: re-brief a resting scout for a bounded follow-up, re-brief a resting builder only for the work it just finished, and never while a Warden is checking that work. A Warden is never re-briefed.
- A Keeper is woken by its own news, not only by the sweep. Filing a report, dispatching a party's hires, or answering an ask runs the same gated tick the sweep uses, so a routine report no longer waits out the interval. The Keeper's widget gains a new-event bubble counting what it has not seen, and a Batch wake events setting (off by default) may hold a wake briefly to gather a burst. Batching now belongs to the wake path alone: a regular sweep tick ignores the setting and always carries every unread event up to the packet limit.

### Fixed

- Changing a class model no longer floods settings with repeated saves or leaves every class picker disabled. Each completed choice saves once after its menu closes, keeps the picker mounted and shows progress only on that row.
- Quests on the new-thread page use the same styled rows as the common room, with their Keeper, phase, path progress and whose move comes next. Quests with open asks or checker-handoff holds come first, newest first, and show how many things need you; greenlights count too, and a hold with a release ask counts once. The header includes holds in its count. Keeper labels stay off in the room and Ledger, and the homepage rows fit a phone without sideways scrolling.
- Hovering a walker no longer paints a square background behind it. The strip has a transparent button that follows the actor and provides a visible focus outline for keyboard users.
- The walking strip sits where it should. Its CSS selector was a descendant rule that never matched the strip's own element (the element carries both classes), so the strip lost its height and position and the absolutely-placed sprite anchored to an ancestor and overlapped the composer and the ask row. The selector is corrected and the row plus strip share one banner root.
- A dark-mode character's eyes are dark again. The sprite's ink is a fixed dark in both themes, not bb's near-white dark foreground, so the eyes no longer turn white in dark mode.
- A member's own thread storage no longer opens a spurious hire-time scope ask. A `$BB_THREAD_STORAGE/**` or `${threadStorage}/**` write grant is already in effect, the same way temporary paths are, while star patterns, `..` and relative paths are still refused and a scope with no bound storage still asks.
- A Warden's checker model selection respects the configured class model: a model that is already a different family from the maker is kept, a replacement made to keep the check independent says so in the hire result, and a model the provider does not offer refuses before spawning with the class setting to change. The maker's own model is never counted as a different family, whatever the catalog calls it.
- A report's batch hold can no longer stack past one tick interval. The hold is capped at the Keeper's tick interval on the wake path, and every hold reason is logged, including the report batch that was previously silent. A report's reaction time from filing to delivery is now recorded.

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
