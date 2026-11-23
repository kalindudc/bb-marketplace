# Changelog

Notable changes to Press, newest first. Releases are tagged `press/vX.Y.Z` in this repository.

## 0.2.0 (2026-11-23)

### Added

- In auto mode, Press can start compaction before the next turn and hold the queued message while it waits. The hold waits for one compaction attempt and lasts at most 10 minutes. Dispatch retries every 60 seconds. An error or a 2-second dispatch check timeout lets the message proceed.
- A message that arrives right as a turn ends can wait about 3 seconds while Press checks the timeline. The queue says “Press is checking this thread before the next turn”.
- The Runway panel shows context against the thresholds, what Press expects to do next, active vetoes, recent decisions, and compaction history with a chart and saved summaries.
- `bb press composer --status` lists duplicate copies found in pi's extensions directory and configured packages.
- Reset to settings clears a thread's policy override from the Points and model section.
- Detailed thread status includes compaction and hold state, active vetoes, thresholds, and history totals.

### Changed

- The default mode is auto.
- The soft line is 55%, Force at is 80%, and the token floor is 150,000. The soft-line setting now says that it lets points fire rather than triggering compaction itself.
- Turn-count, idle-time, and thrash points are off by default.
- The default minimum between compactions drops from five turns to two for regular points.
- Force at waits for an idle thread and for cooldown after a successful or failed attempt, while still bypassing the other vetoes.
- A failed or timed-out request starts an automatic cooldown of at least 60 seconds, even if cooldown is set to zero. Regular points also respect the 30-minute failure backoff. A failed attempt does not reset the turn counter.
- `compaction_point` stores its note as the hint's reason and previews the turn-end decision instead of requesting compaction during the current turn.
- Settings and policy require summary models in `provider/modelId` form. An empty setting or `null` in policy uses the thread's model.
- The context chip shows only a ring and percentage, with threshold colours and a spinning ring during compaction or a hold.
- The plugin database is the single source for displayed compaction history and chat markers. Recent native landings and Press requests appear together, with composer details attached when found.
- Repeated decisions that do not start a compaction are deduplicated by decision, point, and reason. Compaction requests keep their own decision rows.
- The composer keeps a ledger and summaries under each thread's directory. `bb press ledger` reads that thread's ledger and reports its path.
- Press publishes summary settings in a separate per-thread `composer.json`, including the policy switches for the ledger block and resume contract.
- The composer keeps at most 40 explicit constraints within a 6 KB text budget and caps the full ledger at 24 KB. It trims older history before it trims extracted state.
- The composer rotates its diagnostic log at 256 KB.
- The composer prunes summaries when their history rows are dropped.

### Removed

- Removed `journal.entry.done` from the built-in phase signals because Press does not produce it.
- Removed the duplicate read-only settings section. The bb plugin settings form remains.
- Removed the separate Cost stat. History shows durations in its rows and totals.

### Fixed

- Phase, volume, and thrash points now read bb's timeline rows and count only work that began after the last landed compaction.
- A phase boundary only counts in the turn that just ended and can fire once. Plan completion requires every step to be finished. Tests count only when a recognised test runner ran successfully in command position.
- Press checks that a thread is idle before requesting compaction and does not consume an agent hint just because the thread is still running.
- A thread in `error` counts as idle and can compact before its follow-up.
- Press does not start new automatic compactions or hold messages to check for one when policy disables the provider. Runway shows Off when there is no request or hold in progress.
- When both still apply at Force at, the panel in auto mode says “Compacts after this turn and the cooldown”.
- The Blocked state names a veto that is still in force, not a stale decision.
- The panel's point range and Points gate open at the lowest minimum among enabled points.
- Native compaction resets the turn counter and clears the failure flag.
- The idle sweep respects workspace policy and reuses timeline signals while the thread and its last landing have not changed.
- A hand-edited workspace policy is reread at the next turn-end evaluation or status read. The sweep does not reuse policy older than five minutes.
- Inverted thresholds clamp the soft line to Force at instead of breaking policy resolution.
- Unknown boundary signals and malformed signal expressions are rejected rather than leaving points that silently never fire.
- `bb press policy set` rejects a workspace policy containing only fields overwritten by settings. For mixed policies it names the overwritten paths and their setting keys.
- Status refreshes during a running turn and when a compaction settles or a hold changes.
- Press checks for native compactions during running turns, not just when the thread goes idle.
- Decision and status duration estimates both use the thread's measured compaction times when available.
- The last compaction excludes pending, failed, and cancelled requests.
- The Pressed line anchors to the first visible message after a landing. It only offers Show summary when Press has an associated summary.
- Submitting `/compact` alone in bb's follow-up composer uses the same manual action as Compact now, regardless of mode. It respects bb's submission state, and its feedback now clears.
- The Press tab registers once.
- Panel controls keep keyboard focus during requests.
- Status updates use live regions that are already mounted.
- The composer gives summary calls more output room and retries truncated or empty output once if the model allows a larger cap. It never applies partial text.
- The composer logs unresolved summary models before falling back to the thread's own model.
- The composer saves extracted constraints and state even when pi applies another summary. Only an applied Press summary produces a new Press history row and Markdown file.
- Press fills the post-compaction token count from a subsequent non-estimated usage reading instead of asking pi for an immediate count.
- Ledger writes replace the previous file atomically.
- The composer preserves the original goal and drops recognised test failures when later output shows them passing.
- Current copies of the composer avoid registering twice in one pi runtime.
- The composer test command works on Node 24.

### Compatibility

- The old workspace ledger at `.bb/press/ledger.json` is ignored. Its history is not carried over.
- The new defaults apply only to settings you have never changed.
- The composer now runs only in bb threads. If you installed a separate composer through `pi install`, use `pi remove <source>` to remove that copy when using auto-install.
- An otherwise valid 0.1.0 `policy.json` that lists `journal.entry.done` still loads. Press drops that signal and warns instead of rejecting the policy.
- The decision log keeps 14 days of decisions.

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
