# Changelog

Notable changes to Press, newest first. Releases are tagged `press/vX.Y.Z` in this repository.

## Unreleased

### Added

- A real settings surface: 18 settings on the plugin's settings page and in `bb plugin config press`, covering the mode, the window percentages and floor, every compaction-point toggle and threshold, the vetoes' cooldown and minimum turns, the summary model and budget, and the composer auto-install. All have defaults, with integer and range validation.
- `bb press composer [--status|--install] [--json]`: the composer's install state (installed version, path, source version) and a forced install.

### Changed

- Policy resolution is now defaults → `<dataDir>/press/policy.json` → `<workspace>/.bb/press/policy.json` → settings → per-thread override. The settings win over the files for everything the UI covers, so a stale committed file cannot silently override what you set in the UI; `policy.json` still owns what the UI cannot express (signal arrays, per-provider switches, custom points). The per-thread override still wins over everything.
- The resolved composer config is published into `ledger.composer` in the workspace ledger on every evaluation, so the composer (a pi extension) sees the model and summary budget chosen in the UI. The built-in composer default model is now the thread's own model (previously `z-ai/glm-5.3-flash`) and the default summary budget is 3000 tokens, matching the composer's own defaults.
- The composer installs itself: with `autoInstallComposer` on (the default), the governor copies its own `composer/` directory to `~/.pi/agent/extensions/press-composer/` on start and on a settings change, skipping when the installed version already matches. A `.press-composer.json` marker records the installed version; unrelated files in the target are never touched.

## 0.1.0 (2026-11-22)

First release: the governor and the composer.

### Added

- Compaction points: `window` (soft and hard percentage), `phase` (plan approved, tests green, pull request opened, journal entry done), `agent` (`bb press point`), `volume` (tool-output bytes), `turns`, `idle`, and `thrash` (the same file read repeatedly, the same command failing repeatedly).
- Vetoes: mid-turn, cooldown, minimum turns between compactions, token floor, and no retry after a failed compaction.
- Modes: `observe`, `advisor` (the default) and `auto`.
- A decision log in the plugin database, read by `bb press log`, and one line per thread from `bb press status`.
- A per-workspace ledger at `.bb/press/ledger.json`: verbatim constraints, mechanical state, a resume contract, and the compaction history.
- `bb press policy` to read and change the policy, and `bb press compact` to force a point.
- `bb press point`, the agent hint any agent can run through bash when a phase of work finishes.
- A row in the thread context card: the thread's context percentage and the point that would fire next.
- `bb press status` reads the newest of the plugin's own compaction record and the workspace ledger, so a compaction Press did not request still shows up.
- The composer, a pi extension that writes the summary from the ledger: constraints verbatim, state extracted by rules, the model's narrative, and a resume block, with pi's own summary as the fallback on any error.
- `/press [focus]` in a pi session, Press's own compaction command. `/compact` still works and still produces a Press summary, because the composer hooks every compaction pi runs.

### Fixed

- Compaction requests go through `threads.compact` for every provider, pi included. Sending the text `/compact` as a message does not compact: bb delivers it as an ordinary user message and the agent just talks about it.
