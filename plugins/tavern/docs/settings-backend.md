# Settings and Insights backend

Tavern keeps its settings in its plugin database. The defaults preserve the existing orchestration behavior. Machine tuning is off until the user enables it, and memory limits cannot be reduced or tuned.

## Settings and precedence

`src/shared/settings.ts` is the strict schema for every settings section. Unknown keys and values outside the declared bounds are rejected. Mutations carry the settings revision; a stale revision returns `code: "stale"` without applying the change.

The effective value comes from the defaults, explicit user settings, saved tuning, and an active quest override, in that order. User pins win over all tuning and overrides. Tuning mode `off` ignores tuned values and Keeper overrides. In `suggest` mode the daily tuner writes suggestions, not settings; accepting a suggestion is an explicit, audited user action. Existing accepted tuning remains effective until tuning is switched off, undone, or superseded.

Stored settings use a tolerant reader at the database boundary. Obsolete keys and invalid individual values are ignored with one logged warning per affected path; valid siblings remain and defaults or inheritance fill the gaps. This also covers obsolete saved suggestions and invalid JSON. Machine placement is the exception: present invalid policy or unreadable settings produce a placement blocker, never empty routing defaults. Other settings remain readable. New edits and TOML imports remain strict. Reads do not rewrite the original stored data.

Each change records its actor (`user`, `tavern`, or `keeper`), reason, optional measured evidence, affected paths, and Undo state. Undo refuses to overwrite a newer change to the same paths. Ending a quest expires its overrides irreversibly, so Undo cannot resurrect them later.

### Defaults and limits

| Control | Default | Allowed range |
| --- | --- | --- |
| Keeper tick interval | 60 seconds | 30–300 seconds |
| Hold while the user types | 45 seconds | 15–180 seconds |
| Hold after the user's message | 60 seconds | 15–180 seconds |
| Quiet member interval | 20 minutes | 10–120 minutes |
| Report batch interval | 60 seconds | 30–300 seconds |
| Ranger time-box ceiling, user-only budget | 12 minutes | 3–30 minutes |
| Stale strikes | 2 | 1–4 |
| Review budget | 3 | 1–30 |
| Live party ceiling | 5 | 1–1,000 |
| Rule-placed makers per Keeper | 2 | 1–1,000 |
| Rule-placed checkers per Keeper | 2 | 1–1,000 |
| Decision timer maximum | 10,080 minutes | 1–10,080 minutes |
| Journal quiet interval | 10 minutes | 1–120 minutes |
| Optional sample history | 0, keep forever | 0–3,650 days |
| Automatic archive age | 0, disabled | 0–3,650 days |
| Managed backups to keep | 14 | 0–365; 0 keeps all |

There is no implicit decision timer. Each eligible reversible decision ask must supply its own wait. Production, merge, destructive, credential, send-as-user, scope-widening, blocker, and greenlight asks do not gain timed consent from these settings.

The party ceiling retains the existing counting across a Keeper's live party, including reservations. Custom class-file budgets still apply. Ranger briefs must choose their own time box; the ceiling is not a default brief duration.

The Keeper restatement remains fixed at 28,000 UTF-8 bytes. Tick facts remain fixed at 14,000 characters. Both appear read-only with an explanation. The outer configure packet has its existing 32,000-byte bound.

The following safety and plumbing values remain fixed in `src/server/limits.ts`: a five-second sweep, five-minute uncertain-hire grace, 60-second retry waits, two-second registry cache, 30-second journal ownership/import cache, five-second journal-read backoff, 60-second activity-write throttle, two replacements per slot, and Ranger capacity of three. Class files can retain their explicit class budgets. Durable rebrief delivery has five attempts with exponential waits from one to fifteen minutes, followed by a durable Retry/Release blocker. It never silently abandons the allocation.

The additional configurable controls are pause, the default class, row visibility, presentation voice and levels, Ambient motion and its repeat interval in the Motion group, notification eligibility and quiet hours, explicit versus eligible by-size greenlight, class execution overrides, scope mode, journal reminders, archival, retention, and tuning mode. Presentation settings do not remove orchestration instructions or memory.

Character voice has three modes. Full is the unchanged default: one optional short greeting or closing line. Light permits at most one optional character line after successful completion, not in greetings or progress remarks. Off asks for plain replies, stores new reports with `voice: null`, and hides stored optional voice lines on the page without rewriting their history. Blockers, failures, asks and trouble stay plain in every mode. Work, checks, evidence, exact literals, class instructions, identity, scope, holds and orchestration stay the same. The instructions reserve the legacy Full-mode data budget in every mode so a shorter voice rule cannot change which ledger facts fit. Changes apply at the next instruction assembly and report write; existing chat messages are not rewritten.

The existing registry read carries `voice: "full" | "light" | "off"`; a missing field from an older server means Full. It subscribes to the existing settings-change signal. An Off-mode duplicate report returns its existing identity and proof with `voice: null` while preserving deduplication, the saved row and its old voice. The manual voice check remains an explicit preview of the selected character's style.

### Display preferences on existing reads

All three display switches default to on and are user preferences, not tuner knobs:

| Setting | UI read | Effect |
| --- | --- | --- |
| `tavern.levels` | `registry({projectId?}).levels` | Controls level notches, level words and the tale's level line without removing earned counts or frozen snapshots. |
| `tavern.widgetRow` | `decor({threadId}).widgetRow` | Controls the widget row globally; the existing per-thread `hidden` flag still wins. |
| `tavern.ambientMotion`, `tavern.repeatSeconds` | Room and decor motion fields | Motion’s Ambient motion control selects Calm, Lively or Off and a repeat interval; reduced-motion preferences still hold. `hearthFlicker` is the legacy compatibility flag. |

The RPC fields are optional for older servers and fixtures; absent means the existing on behavior. The current backend always emits a boolean. These fields are added only to UI RPC responses, never to the registry snapshot used by agents, their configuration, briefs or restatements. Each read subscribes to the existing `tavern:settings` invalidation, so changes reach already-mounted views and untyped-thread decor without polling or reloading. TOML uses `levels`, `widget_row` and `hearth_flicker` in `[tavern]`.

## TOML and dotfiles

Export writes only explicit user settings and pins by default. `--with-tuned` also includes saved tuned values. Quest-scoped overrides and change history are not dotfile settings.

```sh
bb tavern settings export > settings.toml
bb tavern settings export --with-tuned > settings-with-tuning.toml
bb tavern settings import --toml "$(< settings.toml)"
bb tavern settings import --toml "$(< settings.toml)" --apply
```

The first import previews the changes. Import replaces explicit settings and pins rather than merging them: the page and CLI lead with the number of unset entries returning to defaults, followed by other changes. `--apply` explicitly applies the supplied input and reports those counts in the past tense. CLI output starts with the summary and then JSON details; add `--json` for one JSON document containing `summary` and the result. Both directions above work without a host selector. SDK-backed file paths require an absolute path and a known host; Tavern does not guess where an ordinary terminal runs.

The current public bb CLI does not forward raw multiline stdin to a plugin command. Its declared `--toml-stdin` adapter supports a single-line value. `import -` and `--stdin` return a clear explanation instead of reading the server's stdin. Use shell capture above for a complete TOML file. Native multiline stdin remains an SDK limitation, not a working interface.

The settings page uses `~/.agents/tavern/settings.toml` without a path argument. It can preview/load the file or save an atomic, mode-0600 copy. Previewed file hashes detect replacement before applying. Saving through a symlink preserves the symlink and updates its target; a broken symlink is refused. The file-diff indicator compares settings meaning, not whitespace or comments.

TOML keys use snake case. Class identifiers keep their spelling. In a class override, omitted `reasoning` inherits the class file; `reasoning = "default"` explicitly chooses the provider's default thinking and becomes JSON `null`. An empty class override clears it. `quiet_hours = "none"` represents an explicitly disabled quiet-hours value.

```toml
[attention]
review_budget = 3
quiet_hours = "none"

[tuning]
mode = "suggest"

[tuning.pinned]
stale_minutes = 30

[classes.smith]
provider = "openai"
model = "your-model-id"
reasoning = "default"
```

Global mutation commands reject agent-thread callers. A Keeper uses the bounded `tavern_tune` tool instead.

## Agent settings and motion

Tavern-managed callers, including archived members and Keepers, cannot apply scope, greenlight, staffing, decision-timer, machine-placement or agent-permission guardrails. Pause, review budget, tuning mode, user typing/message hold intervals and the Ranger time-box ceiling are also protected. Tuning mode is protected because it selects whether saved hold intervals apply. CLI imports check both explicit keys and guardrails reset by omission, including pinned or tuned hold intervals. Previews stay allowed. Plain threads may apply every setting while agent changes are enabled. Away timers are not global settings in this schema; their separate policy path is unchanged.

The CLI permits agent imports and dotted patches by default. `bb tavern settings get [key]` reads effective values. `bb tavern settings set <key>=<value> [...]` previews a strict patch; `--apply` merges it without resetting unrelated values. Values accept JSON or plain strings, and keys use camelCase dotted paths. Import retains its complete-replacement semantics.

`tavern.agentsMayChangeSettings` defaults to true. False refuses applied thread-origin imports and patches; previews remain available. Every applied agent import or patch records its calling thread in `tavern_setting_changes.thread_id`, uses the existing reversible user-change mechanism, and appears as "by an agent in <thread name or title>" with a thread link in Settings history. File export writes and backup restore with data remain user-only. RPC client-only mutation rules remain unchanged.

Motion uses `tavern.ambientMotion` (Calm by default, Lively, Off) and `tavern.repeatSeconds` (integer seconds, 3 to 60, default 20). The legacy `hearthFlicker=false` maps to Off when no mode is explicitly set. Setting a mode through CLI patches, imports or the UI synchronizes the legacy switch, so an explicit mode wins; selecting a mode in the UI updates that legacy switch too. Room and decor reads carry the effective mode and interval through their existing settings invalidation.

## Machine placement settings

`src/shared/placement-settings.ts` defines `machines`. Its default is two makers, two checkers and no rules. An absent section does not rewrite existing databases. The party ceiling still defaults to five; raising its upper bound does not change any user's existing party, class or approved-plan budget. The plan's eight-member per-quest approval bound remains separate.

Rules are an ordered array with at most 50 stable, unique IDs. A supplied array replaces the complete order atomically; a rules-only patch never injects cap defaults. Unknown provider IDs remain in the policy so unavailable targets can be reported rather than erased. Routing and cap changes use the existing revision checks, audit history and conflict-aware Undo.

Consent defaults to false. Enabling a new-machine rule requires explicit consent for its marked guard installation, remote detection-only execution and Linux checks without containment. This is one rule approval, not permission to push, publish, merge, deploy or widen a member's action scope.

Agent tools, the tuner and Keeper overrides cannot edit these values. CLI mutations reject an agent-thread context. RPC mutations reject plugin-origin callers and require an explicit client action. The pinned SDK labels the app, ordinary CLI and agents as clients; this is client authority, not a claim of human attestation.

The combined server registration and the standalone settings registration use the same caller-checked handler map. Update, Undo, applied imports, file saves, applied file loads and tuning-suggestion applies all require client context; a missing context is refused. Plugins can still read settings, export TOML and preview imports or file loads. The regression tests activate the actual server entry point and check that refused calls leave settings, audit history, suggestions and files unchanged.

Provider inputs are JSON values bounded to 32 levels and 32 KiB each. Tavern-owned TOML keys use snake_case; provider keys such as `memoryGb` and `fromLaptopBranch` keep their spelling, including inside arrays. TOML accepts native `inputs` or an exclusive `inputs_json` string at the environment target and new-machine selector. Export uses the JSON form when native TOML cannot round-trip the value. `inputs_json = "null"` preserves explicit null; omission stays absent. The complete canonical export, including optional tuned values, must fit 128 KiB before settings are committed.

Provider inputs cannot contain the reserved keys `__proto__`, `constructor` or `prototype` at any depth. Settings, CLI and TOML validation name the rejected key and its full rule/input path. The pinned SDK's RPC response normalizer drops an own `__proto__` data key by assigning through the prototype setter. This is a known core limitation, not a problem solved by Tavern's serializer; Tavern rejects these keys rather than escaping or silently dropping them. The official RPC regression records the limitation and checks rejection before storage.

`SettingsStore.placementPolicy()` is the authoritative admission reader. It returns `{state: "valid", revision, settings}` or `{state: "invalid", revision, problems}`. Snapshots also expose this result. Ordinary `read()` and `snapshot().effective` remain safe for ticks and display, but their salvaged/default values MUST NOT establish placement validity. Unrelated writes preserve corrupt policy instead of clearing it. Repair requires an explicit replacement rules array or a complete settings import; Undo cannot resurrect invalid policy.

## Deterministic tuning

The background maintenance checks daily and after each returned quest. Trigger ids are stored transactionally, so a restart does not repeat the same run. Rules use the previous 30 days, require at least 20 relevant observations, respect pins and declared bounds, and apply at most one automatic change per knob in seven days. They only increase pacing allowances.

| Knob | Written rule |
| --- | --- |
| Tick interval | After 20 attempts, if at least 30% were held/deferred, or 20 measured turns have a P90 above 75% of the interval, use the larger of 125% of the interval and the measured P90 plus five seconds. |
| Typing hold | After 20 attempts, if at least 25% were held for typing, add 15 seconds. |
| After-message hold | After 20 attempts, if at least 25% were held after a message, add 15 seconds. |
| Quiet member interval | For each class with 20 report intervals, allow twice its P95 interval. Use the largest allowance and never shorten it. |
| Report batch interval | After 20 observed report-minute buckets, if their P95 has at least four reports, increase batching by 25%. |

P90 and P95 are the 90th and 95th percentiles. The rule text is exported as `TUNING_RULES`, and every rule cites a chart that the Insights contract exposes. No language-model call chooses these values.

`tavern_tune` requires a Keeper and one of its active quests. Only `staleMinutes` and `reportBatchSeconds` may be overridden. The Ranger time-box ceiling is a user-only budget, excluded from automatic tuning, suggestions, pins and Keeper overrides. Tick and conversation holds apply to the whole thread, so the tool refuses them with that explanation. Pins, bounds, mode, ownership and quest-end checks still apply.

## Reliability behavior

Pause holds all Keeper ticks, re-anchors, hires and automatic failure blockers; asks remain answerable. Unpause requests a full restatement but never resumes a Keeper that the user manually stopped. When quiet ends through a card answer or Resume, or when Tavern is unpaused, Tavern cancels only its own queued ticks before rebuilding from the current ledger. A manually stopped Keeper remains quiet until an explicit user action resumes it. It does not mark their facts or reports delivered. The reset marker survives a restart and a failed queue deletion. User and other-plugin messages are never removed.

A new child receives its real first brief in nonempty spawn input. Accepted spawn input increments the brief version once. Scope approval holds that original queued input before the provider starts; approval never sends a second initial brief. Only explicit pending rebriefs use the durable retry sender. Their exact text, attempts and retry time survive restart, and a lost acknowledgement is reconciled against accepted-input history before resending. The party slot and character remain reserved while a delivery is pending, even if the child fails; only an explicit confirmed release frees them.

## Insights and data coverage

The RPC supports 7, 30 and 90 days. Sections contain numeric series with an explicit shared unit enum and `null` for unavailable derived measurements. Money uses `usd`; rates use `ratio` with values from zero to one, never display percentages. Report trends are bucketed by UTC day. Chart points retain stable `x` ids and may add a human `label`. The server supplies quest titles, disambiguated when repeated; the page resolves class and character names from its registry. The page receives headline measures, reliability, phases and outside gates, attention, party, guardrails, tuning history, and actionable or informational Ideas.

New measurements record re-anchor causes, held/deferred/sent ticks, packet sizes and clipping, Keeper main-turn durations, interrupted Tavern turns, definite and uncertain spawn failures, review-budget holds, and completed Ranger runs. Ranger duration starts with acknowledgement of the initial brief; old runs without that timestamp are not invented. Existing durable events supply routes, corrections, reports, notes, commitments, promises, outside contacts, approvals, review verdicts, scope violations, releases and archival.

`historyDays > 0` prunes only optional Insights samples. It never deletes quests, plans, reports, rules, asks, decisions, notes, gates, routes, members or their orchestration events. Automatic archival uses the existing reversible archive path, only for returned or stopped quests.

Costs come only from Burn's public usage RPC, following Shuttle's integration. The section is absent when Burn is unavailable. Shared Keeper turns are allocated across overlapping quests and marked estimated; cache/budget gaps are also reported as partial or estimated. Native context-window estimates are not presented as spend. Cost reads are bounded and do not block orchestration.

## Public RPCs

The strict contracts are `src/shared/settings.ts`, `src/shared/insights.ts` and `src/shared/backup.ts`. The real server registers their handlers together with the core contract, so one feature cannot replace another's handlers.

- `settings`, `settingsUpdate`, and `settingsUndo` read or mutate with a revision.
- `settingsExport` and `settingsImport` transfer validated TOML with a preview.
- `settingsFile` reports, previews/loads, or saves the default file.
- `settingsApplySuggestion` applies one current measured suggestion as a user action.
- `insights` reads one of the three supported ranges.
- `backupList`, `backupSave`, `backupExport`, `backupRestore`, `registryFile` and `registryExportFolder` support the Backup section and definition-file exports.

## Backups

Save private configuration and optional Tavern records with `bb tavern backup save --with-data --json`. User-authored notes can be private. Restore previews first, applies only explicitly, never deletes absent files and restores records only into an empty database. Read [Back up Tavern](backups.md) for the format, CLI exit codes, retention, restore safeguards and daily automation recipe.
