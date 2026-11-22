# Press

A compaction governor for bb threads. Press decides **when** a thread should compact, records
every decision, and asks the provider to compact. A companion pi extension, the
[composer](./composer/README.md), decides **what the summary is**.

Compaction normally fires when the window is nearly full, which makes it the most expensive
request of the session and the most likely to lose what matters. Press moves it to the points
you choose and keeps the parts that must survive outside the summary.

## Install

```sh
bb plugin install <this-directory>          # the governor
```

The governor installs the composer for you: with `autoInstallComposer` on (the default), it copies
its own `composer/` directory to `~/.pi/agent/extensions/press-composer/` on start and whenever the
setting changes, skipping when the installed version already matches. `pi install
<this-directory>/composer` still works, and `bb press composer --status` reports the install.

The governor works without the composer: it still decides, records and requests. The composer
works without the governor: pi's own threshold still triggers it. Together they are the whole
design.

## What it does

- **Compaction points.** `window` (soft and hard percentage), `phase` (a plan approved, tests
  green, a pull request opened, a journal entry done), `agent` (`bb press point`), `volume`
  (tool-output bytes), `turns`, `idle`, and `thrash` (the same file read repeatedly, the same
  command failing repeatedly).
- **Vetoes.** Never mid-turn, a cooldown, a minimum number of turns between compactions, a
  token floor, and no retry after a failed compaction. The hard window percentage outranks
  every veto, because it is the backstop.
- **Three modes.** `observe` records what it would have done, `advisor` proposes and waits for
  you, `auto` acts. The default is `advisor`.
- **A decision log.** One row per evaluation that reached a trigger or a veto, with the point,
  the reason, the percentage, the estimate, and the outcome once the compaction lands or fails.
- **A ledger per workspace.** `.bb/press/ledger.json`: the constraints the user stated
  verbatim, the files and commands that matter, the failing tests, a three-line resume
  contract, and one row per compaction.
- **A row in the thread context card.** Where the thread stands against its window and which
  point would fire next.

## Commands

```
bb press status [thread] [--limit n] [--json]
bb press policy [show|set|reset] [value] [--thread <id>] [--json]
bb press log [--thread <id>] [--limit n] [--json]
bb press compact [thread] [--point <id>] [--json]
bb press point [--reason <text>] [--thread <id>] [--json]
bb press ledger [thread] [--json]
bb press composer [--status|--install] [--json]
```

`bb press status` prints one line per idle thread:

```
thr_fcqqujv3d8  77%  mode=advisor  next=window  last=never
```

`bb press point` is the agent hint: any agent, on any provider, can run it through bash when a
phase of work finishes. It writes a hint the service consumes on its next evaluation, so the
`agent` point fires once.

## Policy and settings

Resolved in this order, each layer over the last:

1. built-in defaults
2. `<dataDir>/press/policy.json` (the user's own, usually `~/.bb/press/policy.json`)
3. `<workspace>/.bb/press/policy.json`
4. the plugin settings — the settings page, `bb plugin config press`, everything the UI covers
5. a per-thread override in the plugin database, which wins over everything

Deep merge; arrays replace. The settings sit above the files on purpose: a stale committed
workspace file cannot silently override what you set in the UI. The files still own what the UI
cannot express — signal arrays, `minPercent`, per-provider switches, custom points, and every
field of `composer` except `model` and `maxSummaryTokens`.

The settings (all with the defaults shown):

| Setting | Default | What it is |
| --- | --- | --- |
| `mode` | `advisor` | `observe` records, `advisor` proposes, `auto` compacts |
| `softPercent` | 35 | compact at (percent of window) |
| `hardPercent` | 55 | force at (percent of window), the backstop |
| `floorTokens` | 60000 | never compact below (tokens) |
| `phasePoint` | true | compact at phase boundaries |
| `agentPoint` | true | compact when an agent marks a point |
| `volumePoint` / `volumeBytes` | true / 1500000 | compact on a large tool result |
| `turnsPoint` / `turnsBetween` | true / 60 | compact after many turns |
| `idlePoint` / `idleSeconds` | true / 300 | compact after idle time |
| `thrashPoint` | true | compact on thrash |
| `cooldownSeconds` | 600 | cooldown after a compaction |
| `minTurnsBetween` | 5 | minimum turns between compactions |
| `composerModel` | "" (the thread's own model) | model that writes the summary |
| `maxSummaryTokens` | 3000 | summary budget (tokens) |
| `autoInstallComposer` | true | keep the composer installed into pi |

A `policy.json` still looks like this:

```jsonc
{
  "window": { "floorTokens": 60000 },
  "points": [
    { "id": "phase",  "enabled": true, "when": "boundary",
      "signals": ["plan.approved", "tests.green", "pr.opened", "journal.entry.done"] },
    { "id": "agent",  "enabled": true, "when": "agentHint" },
    { "id": "volume", "enabled": true, "when": "toolResultBytes", "value": 1500000 },
    { "id": "turns",  "enabled": true, "when": "turnsSinceCompaction", "value": 60 },
    { "id": "idle",   "enabled": true, "when": "idleSeconds", "value": 300, "minPercent": 25 },
    { "id": "thrash", "enabled": true, "when": "signal",
      "signals": ["sameFileRead>=3", "sameCommandFailed>=2", "subagentReportBytes>40000"] }
  ],
  "vetoes": {
    "midTurn": true,
    "belowFloor": true,
    "previousCompactionFailed": true
  },
  "composer": { "keepRecentTurns": 6 },
  "providers": { "pi": { "enabled": true } }
}
```

`bb press policy set '{"mode":"auto"}' --thread <id>` writes a per-thread override;
`bb press policy reset --thread <id>` clears it. Fields the settings own (mode, window percentages,
point toggles and thresholds, the cooldown, the summary model and budget) are best changed through
the UI or `bb plugin config press set <key> <value>`, because the settings win over the files.

## How a compaction happens

```
bb press status / sweep / event
        │
        ▼
   decide(policy, snapshot)  ── veto ──▶ decision log, nothing else
        │ compact
        ▼
   threads.compact({ threadId })
        │
        ▼
   provider compacts ──▶ pi: session_before_compact ──▶ composer writes the summary
        │                                              └─▶ ledger row
        ▼
   outcome recorded, ledger read back into status
```

Every provider goes through `threads.compact`, pi included. Sending the text `/compact` as a
message does **not** compact: bb delivers it as an ordinary user message and the agent just
talks about it. That was verified against a live bb pi thread.

## Compaction always goes through Press

pi does not let an extension take over a built-in command name: a command called `compact` is
dropped from autocomplete and the built-in wins. So Press owns the deliberate path under its
own name, and every compaction still runs through Press:

- `/press [focus]` in a pi session is Press's command. It compacts through the same hook, with
  an optional focus for the summary.
- `/compact` still works, and still produces a Press summary, because the composer hooks
  `session_before_compact` for manual, threshold and overflow compactions alike.
- Press's `window.hardPercent` (55% by default) fires well before pi's own threshold, so in
  practice Press is the trigger, and pi's threshold is the backstop.
- The composer writes a ledger row for every compaction it produces, and `bb press status`
  reads the newest of the store and the ledger, so a compaction Press did not request still
  shows up.

## The ledger

`<workspace>/.bb/press/ledger.json`, written atomically with the previous copy kept as `.bak`,
capped at 24 KB, unknown fields preserved. The composer writes it; the governor reads it, merges
its own history rows, and publishes the resolved composer config into `ledger.composer` (the
model and summary budget settled for the thread) on every evaluation, so the composer — a pi
extension that cannot read bb's settings — sees what you chose in the UI. Add `.bb/press/` to the
workspace `.gitignore` unless you want it committed.

## Limits

- Press asks the provider to compact; it never rewrites a transcript itself. A provider that
  refuses the request is logged as `skip: unsupported` and never retried.
- The composer is a pi extension. Codex and Claude Code compact inside their own runtimes.
- `keepRecentTurns` is advisory: pi still chooses the cut point.
- Needs bb 0.48.1 or later.

## Development

```sh
npm install
npm test          # vitest, 71 cases
npm run typecheck # tsc --noEmit
bb plugin build
```

The composer has its own package and tests; see [composer/README.md](./composer/README.md).
