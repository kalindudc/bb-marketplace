# Press

Press schedules context compaction for bb threads so you can shorten the conversation the model has to carry into the next turn. It asks the provider to compact when an eligible point fires or when the context reaches the hard threshold you set. For pi threads, a companion [composer extension](./composer/README.md) writes the summary with selected user constraints verbatim and state extracted by rules.

## Install

Press requires bb 0.48.1 or later. Add the marketplace if it is not already configured, then install Press:

```sh
bb marketplace add git:github.com/kalindudc/bb-marketplace@main
bb plugin install press@kalindudc
```

With `autoInstallComposer` on (the default), Press copies its bundled pi extension to `~/.pi/agent/extensions/press-composer/` on startup and on settings changes, skipping the copy when its recorded digest matches. Run `bb press composer --status` to check the bundled install and list duplicate copies found in pi's extensions directory or configured packages. Do not also use `pi install` for the composer. If you did, find the original package source with `pi list` and run `pi remove <source>` (add `--local` for a project install). Keep the bundled copy: current copies guard against duplicate registration, but an older copy can still run a second summariser.

## How a compaction happens

A compaction point is a rule for when it makes sense to compact. Press evaluates points when a turn ends and periodically while a thread is idle. By default, the enabled points are a detected phase boundary (such as tests passing), an agent hint, and tool-output volume. Points based on turn count, idle time, and repeated work such as the same file reads or failed commands are off by default. A regular point only counts at or above the soft line (55% by default), unless the point sets its own minimum. Crossing the soft line alone does not trigger compaction.

A phase point can fire only on a boundary in the turn that just ended, and only once per boundary. Press looks at the newest turn that did work, not a queued message for the next turn. `plan.approved` requires a nonempty plan with every step completed. `tests.green` requires a successful command row with a recognised test runner in command position, not just text that mentions one: `npm test`, `pnpm test`, `yarn test`, or `bun test` (with or without `run`), `vitest run` (with or without `npx`), `pytest`, `go test`, `cargo test`, or `jest`.

A veto is a reason to wait. Regular points respect the idle check, cooldown, minimum turns since the last successful compaction, token floor, and a 30-minute failure backoff. A thread in `error` counts as idle because its last turn ended, so Press can compact it before the follow-up. The hard window, **Force at** (80% by default), does not need a point. It waits for the thread to become idle and for cooldown to end, but bypasses the minimum-turn, token-floor, and previous-failure vetoes. After a failed attempt, the automatic cooldown is at least 60 seconds, even if the configured cooldown is zero. A successful compaction, including a native one, clears the failure flag and resets the turn counter.

In `observe` mode Press records what it would do. In `advisor` mode it records a proposal and leaves the action to you. In `auto` mode (the default) it requests compaction through bb's `threads.compact` API. The `compaction_point` tool and `bb press point` record hints for the turn-end evaluation. The tool saves its `note` as the hint's reason. Neither compacts from inside the turn that records it.

When bb dispatches a message that would start a turn, Press can hold it through the `message.dispatch` hook. Auto mode can start a compaction first, and the hook can also wait for a Press request already in progress, including a manual one. A hold waits for one compaction attempt. Once it settles, Press does not start another compaction for the same message. The hold lasts at most 10 minutes, with dispatch retried every 60 seconds while it waits. The hook lets the message proceed on error or if its check takes 2 seconds, rather than failing it.

A message dispatched the moment a turn ends may instead show “Press is checking this thread before the next turn”. Press is waiting for the timeline to decide whether a point can fire, not yet compacting. It asks bb to retry in about 3 seconds and can ask it to recheck sooner once the timeline arrives.

When resolved policy switches a provider off, Press starts no automatic compactions and does not hold messages to check or start one. An in-flight Press request can still hold the next message until that request settles or the hold expires.

## What you see in bb

- The Press chip shows a usage ring and a rounded percentage. The ring is amber at the soft line and red at Force at. It spins while Press is compacting or holding a message, unless reduced motion is enabled. The tooltip shows tokens used and the window size, mode and thresholds, the next candidate if known, the last successful compaction, and any current hold or compaction. In the footer, the chip replaces bb's context circle; look in the thread context controls if the footer chip is unavailable.
- The Press tab opens the Runway side panel. Its gauge marks the floor, the soft line (shown as Compact at), and Force at. The next-step block shows what Press expects to do and the elapsed time during a hold or compaction. At Force at in auto mode, it says “Compacts after this turn and the cooldown” when both still apply. **Blocked** names the current veto, and **Off** shows when policy disables the provider and no compaction or hold is in progress. The Points gate and range use the lowest minimum among enabled points. When that differs from the soft line, the panel counts “tokens until points open”. The decision path shows which vetoes still apply and lists recent decisions. History shows totals, a chart of recorded before-and-after drops, and expandable rows with the reason, timing, errors, and saved summaries where available. Use the mode control, **Compact now**, and the **Points and model** section to manage the thread. **Reset to settings** clears the thread override.
- The **Pressed** line marks the first visible message after a compaction when Press can locate it. It shows the point and any available before-and-after token counts and duration. **Show summary** appears when a summary was saved and matched to that compaction.
- Submitting `/compact` by itself in bb's follow-up composer, without attachments or mentions, invokes the same action as **Compact now** rather than sending the command as a chat message. Both bypass the automatic mode, points, and vetoes, but still require an idle thread, no compaction already in progress, and a provider not disabled by policy.

## Commands

```text
bb press status [thread] [--limit n] [--json]
bb press policy [show|set|reset] [value] [--thread <id>] [--json]
bb press log [--thread <id>] [--limit n] [--json]
bb press compact [thread] [--point <id>] [--dry-run] [--json]
bb press point [--reason <text>] [--thread <id>] [--json]
bb press ledger [thread] [--json]
bb press composer [--status|--install] [--json]
```

`status` lists idle threads, including threads in `error`, when no thread is named and returns detailed JSON for a named thread. `log` lists recorded decisions and their outcomes when available. `compact` evaluates now and only acts in auto mode; `--point` supplies a candidate without bypassing the window rules or vetoes, and `--dry-run` records without acting. `point` records an agent hint, `ledger` reads the current or named thread's saved ledger, and `composer --install` forces a fresh copy of the bundled extension.

## Policy and settings

Press resolves policy in this order, with later layers taking precedence:

1. Built-in defaults.
2. `<dataDir>/press/policy.json`, under the bb server's data directory.
3. `<workspace>/.bb/press/policy.json`.
4. Press settings in bb or `bb plugin config press`.
5. The per-thread override in Press's database.

Objects merge and arrays replace. The settings control the mode, window, cooldown, minimum turns, summary model and budget, and the toggles and thresholds of built-in points present in the file. The files can still define the point list, order, signal names, point-specific minimums, provider switches, and other policy fields. Press logs and skips invalid file layers, including ones with unrecognised boundary signals or malformed threshold expressions. An otherwise valid 0.1.0 policy that lists `journal.entry.done` still loads: Press drops that retired signal and logs a warning. If the soft percentage exceeds the hard percentage, Press clamps it to the hard percentage and logs the adjustment. It suppresses repeated warnings from the same policy source while the warning is unchanged.

Press rereads a hand-edited workspace policy at the next turn-end evaluation or status read. The background sweep can reuse a policy for up to 5 minutes before rereading it on its next eligible pass. A configured summary model must be `provider/modelId`. Use an empty setting or `null` in policy to select the thread's own model.

| Label in bb | Key | Default |
| --- | --- | --- |
| Mode | `mode` | `auto` |
| Points can fire from (percent of window) | `softPercent` | `55` |
| Force at (percent of window) | `hardPercent` | `80` |
| Never compact below (tokens) | `floorTokens` | `150000` |
| Compact at phase boundaries (plan approved, tests green, PR opened) | `phasePoint` | `true` |
| Compact when an agent marks a point | `agentPoint` | `true` |
| Compact on a large tool result | `volumePoint` | `true` |
| A large tool result (bytes) | `volumeBytes` | `1500000` |
| Compact after many turns | `turnsPoint` | `false` |
| Turns between compactions | `turnsBetween` | `60` |
| Compact after idle time | `idlePoint` | `false` |
| Idle time (seconds) | `idleSeconds` | `300` |
| Compact on thrash (the same file re-read, the same command failing) | `thrashPoint` | `false` |
| Cooldown after a compaction attempt (seconds) | `cooldownSeconds` | `600` |
| Minimum turns between compactions | `minTurnsBetween` | `2` |
| Model that writes the summary | `composerModel` | `""` (the thread's own model) |
| Summary budget (tokens) | `maxSummaryTokens` | `3000` |
| Install the composer into pi automatically | `autoInstallComposer` | `true` |

This workspace `policy.json` keeps the six built-in points and gives phase boundaries their own 60% minimum. The built-in point toggles and numeric thresholds still come from settings.

```json
{
  "points": [
    { "id": "phase", "when": "boundary", "signals": ["plan.approved", "tests.green", "pr.opened"], "minPercent": 60 },
    { "id": "agent", "when": "agentHint" },
    { "id": "volume", "when": "toolResultBytes" },
    { "id": "turns", "when": "turnsSinceCompaction" },
    { "id": "idle", "when": "idleSeconds", "minPercent": 25 },
    { "id": "thrash", "when": "signal", "signals": ["sameFileRead>=3", "sameCommandFailed>=2", "subagentReportBytes>40000"] }
  ]
}
```

Without `--thread`, `bb press policy set` writes the current thread's workspace policy. It refuses a file that sets only fields the settings always overwrite, such as `{"mode":"advisor"}`, because the write would change nothing. A refusal suggests the setting keys to use instead. A mixed policy is saved, but Press prints each detected overwritten path with its setting key, for example `points[volume].value (volumeBytes)`. Use `bb plugin config press set <key> <value>` to change a setting, or `bb press policy set '{"mode":"advisor"}' --thread <id>` to override it for one thread. `bb press policy reset --thread <id>` clears that override.

## Files Press writes

| File | What it holds |
| --- | --- |
| `<workspace>/.bb/press/threads/<id>/ledger.json` | The pi composer's constraints and extracted state, plus resume information and history for matching Press summaries that pi applied. The governor only reads it. The old workspace ledger is ignored, not migrated. |
| `<workspace>/.bb/press/threads/<id>/composer.json` | The resolved summary model and budget, and whether to include the ledger block and resume contract in the summary. The governor writes it and the composer reads it. |
| `<workspace>/.bb/press/threads/<id>/summaries/<id>.md` | Markdown summaries saved by the composer after pi applies them. The filename uses the composer's compaction ID. |
| `<workspace>/.bb/press/composer.log` and `composer.log.1` in the same directory | Composer diagnostics. The log rotates at 256 KB. |
| `<dataDir>/plugins/press/data.db` | Press's SQLite database: compaction history and chat markers, decision log, agent hints, and per-thread overrides. The background sweep prunes decisions older than 14 days. |

## Limits

Press cannot compact inside a running turn. In pi, only pi's own `compaction.reserveTokens` threshold can trigger preventive mid-turn compaction; pi also handles overflow recovery. For a long-context model that should compact earlier, raise its reserve in `~/.pi/agent/settings.json`. Replace `provider/model-id` with your model's actual provider and ID:

```json
{
  "compaction": {
    "modelOverrides": {
      "provider/model-id": { "reserveTokens": 80000 }
    }
  }
}
```

With automatic compaction enabled, pi's threshold checks whether used tokens exceed the context window minus that reserve. Changing Force at in Press does not change pi's threshold. Codex and Claude Code do their own compaction inside their runtimes; the Press composer runs only in pi sessions inside bb.

## Development

From this directory with dependencies installed, run `npx vitest run` (318 tests across 19 files). From `composer/`, run `npm test` (52 tests). See the [composer README](./composer/README.md) for the extension's configuration and tests.
