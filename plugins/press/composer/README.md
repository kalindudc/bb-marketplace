# Press composer

The composer is the pi extension that writes summaries for [Press](../README.md). It runs only when `BB_THREAD_ID` is set. Press installs it automatically by default; do not also install it through `pi install`. Run `bb press composer --status` to check for duplicates. An older copy may still run alongside the bundled one. Find its package source with `pi list` and remove it with `pi remove <source>` (add `--local` for a project install).

## How it handles a compaction

The composer uses pi's `session_before_compact` hook for manual compaction, threshold compaction, and overflow recovery. Pi still chooses the cut point and the conversation that stays verbatim. In pi itself, `/press [focus]` passes optional instructions to the summariser through the same hook. Pi's built-in `/compact` is not replaced.

The summary starts with the pre-compaction token count. It includes the ledger block, with selected constraints quoted verbatim and state extracted by rules, a working summary written by the model, and a three-line resume contract: `state`, `next`, and `verify`. The ledger block and resume section are configurable.

The summary prompt uses the configured token budget as its target. The model call gets more room: the larger of twice that budget or 8,000 tokens, capped by the model's output limit. A cut-off response (`stopReason: "length"`) or an empty normal response gets one retry if the model allows a larger cap. The retry doubles the first cap up to the model's limit. The composer only applies nonempty text from a normal stop (`stopReason: "stop"`). Otherwise it returns no replacement and lets pi handle compaction. If it cannot resolve a configured model, it logs the problem and uses the thread's model if available.

The composer prepares the result in memory and writes the extracted constraints and state when pi emits `session_compact`, even if pi applied its own summary or another extension's. It only saves Markdown, adds a history row, or updates the resume contract when pi applied the matching Press summary. It discards prepared work on `session_compact_failed`. A file-write failure is logged; it does not undo pi's compaction.

The composer sets `tokensAfter` to `null` because pi does not yet know the post-compaction count. Press fills it in the plugin history, not the ledger, from the next non-estimated usage reading it sees within 15 minutes of compaction. If the pre-compaction count is known, the new reading must be lower.

## Configuration

The composer reads `~/.bb/press/policy.json`, then `<workspace>/.bb/press/policy.json`. The governor's per-thread `composer.json` takes precedence for the model, summary token budget, and whether to include the ledger block and resume contract. Use `provider/modelId` to choose a summary model. Press settings and policy reject other model names. Leave the setting empty or use `null` in policy for the thread's own model. By default the composer uses that model and a 3,000-token target, with both sections included. Set `providers.pi.enabled` to `false` in the workspace policy to disable the composer there without uninstalling it.

The ledger block switch controls what appears in the summary; it does not turn off the ledger file. Pi controls how much recent context to keep verbatim with `compaction.keepRecentTokens`.

## Files and limits

| Path, relative to the workspace | What it holds |
| --- | --- |
| `.bb/press/threads/<threadId>/ledger.json` | The composer's extracted constraints and state, plus resume information and history for matching Press summaries that pi applied. |
| `.bb/press/threads/<threadId>/composer.json` | Settings published by the Press plugin. The composer only reads this file. |
| `.bb/press/threads/<threadId>/summaries/<compactionId>.md` | Markdown saved after pi applies the matching summary. |
| `.bb/press/composer.log` and `.bb/press/composer.log.1` | Workspace-wide JSON Lines diagnostics. The active file rotates before an append would put it over 256 KB (256,000 bytes); one rotated file is kept. |

The composer replaces the ledger and summary files atomically using uniquely named temporary files. It ignores the old workspace ledger at `.bb/press/ledger.json`; there is no migration.

The ledger keeps at most 40 distinct explicit constraints, with a 6 KB budget for their text. It favours recent constraints and retains the original user goal. A recognised passing test or successful rerun clears matching previous failures. The full ledger is capped at 24 KB (24,000 bytes), so it can keep fewer than the 50 allowed history rows. To fit the cap, the composer trims old history down to ten rows before trimming extracted state. If it still needs room, it can drop more history and constraints. It prunes summaries when their rows are dropped.

## Development

With dependencies installed, run `npm test` from this directory. It runs 52 tests on Node 24, including the pi hook lifecycle, configuration, extraction, prompt, and ledger tests.
