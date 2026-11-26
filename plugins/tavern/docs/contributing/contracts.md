# Contracts: SDK, settings backend, and public RPCs

Contributor reference for Tavern's audited bb SDK usage (`@get-bb/plugin-sdk` 0.6.132+), settings backend, deterministic tuning, Insights coverage, and public RPCs. For the full key-by-key settings table, see [`skills/tavern/references/settings.md`](../../skills/tavern/references/settings.md); for open upstream host requests, see [Requests for bb](host-asks.md).

## Audited bb SDK call inventory

`test/server/sdk-call-inventory.test.ts` parses every TypeScript file in `src/server/`, `src/scope/watch.ts`, and `server.ts` with the TypeScript compiler API and fails if production code calls an SDK method absent from `SDK_CONTRACTS` in `test/server/sdk-contract.ts` or aliases `.sdk` without an explicit audit.

`SDK_CONTRACTS` currently covers **39 backend SDK methods**:

| Namespace | Audited methods |
| --- | --- |
| `threads` | `spawn`, `send`, `get`, `list`, `output`, `conversationOutline`, `update`, `stop`, `delete`, `archive`, `unarchive`, `defaultExecutionOptions`, `storageLocation`, `getPluginMetadata`, `experimental_listPluginMetadata`, `updatePluginMetadata` |
| `threads.*` | `queuedMessages.list`, `queuedMessages.delete`, `queuedMessages.update`, `queuedMessages.send`, `interactions.list`, `events.list` |
| `environments` | `get`, `list`, `listProviders` |
| `hosts` | `get`, `list`, `experimental_listProviders` |
| `projects` | `get`, `list`, `defaultExecutionOptions` |
| `providers` | `list`, `models` |
| `plugins` | `list`, `callRpc` |
| `files` | `mkdir`, `read`, `write` |
| `system` | `config` |

The shared test host validates every SDK call's arguments before fixture handlers run. Key SDK invariants enforced by Tavern:

- `threads.spawn` (non-fork) and `threads.send` require a non-empty `input` array and accept either `prompt` or `input`, never both. Scope admission holds the first input before provider execution rather than sending a duplicate brief.
- Tavern sends tells and ticks with `queue-if-active`, never `steer`, so running tools are not interrupted mid-call.
- `threads.stop` returns only `{ ok: true }`; Tavern reads thread status afterwards and treats `stopping` as unconfirmed.
- Thread plugin metadata (capped at 256 KiB JSON) is a mirror, never authority; role, scope, and authorization come strictly from Tavern's SQLite database.
- The `configure` hook selects `journal` and `quest-management` for every thread while keeping the legacy `quest` tool registered but unselected.
- `threads.conversationOutline` is read-only. Tavern fetches previews only for the watched thread on screen and only when it asks Pi for a remark. It passes at most the user-set number of previews to Pi (0 to 10); at 0 it does not fetch the outline.
- `threads.storageLocation` requires an attached environment (returns HTTP 409 otherwise).
- Every registered RPC schema is tested for strict lossless JSON round-tripping in `test/server/sdk-contract.test.ts`.

To add a new SDK call, add its Zod validator to `SDK_CONTRACTS` in `test/server/sdk-contract.ts` against `node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts`, add coverage in `test/server/sdk-contract.test.ts`, run `node node_modules/vitest/vitest.mjs run test/server/sdk-call-inventory.test.ts test/server/sdk-contract.test.ts`, and update this table.

## Class and character definition files

A full Markdown definition replaces the lower layer and can define a custom ID. New editor saves for shipped definitions use explicit patches:

```yaml
---
format: tavern-registry-patch/1
id: smith
fields:
  description: Build and test one change.
  body: ""
---
```

Missing keys inherit from the next layer down. Lists and objects replace the field as a whole. Explicit `false`, `[]`, an empty prompt, and `null` on nullable fields are saved values. A patch requires a lower definition. Legacy full files are not converted on read, edit or restore. A reset of the last patch field removes that patch file. Duplicate parsed IDs in a layer must be resolved before editing or resetting the ID.

## Settings schema, precedence, and guardrails

`src/shared/settings.ts` defines strict Zod schemas (`settingsSchema`, `settingsPatchSchema`, `settingsUpdateSchema`). Unknown keys and out-of-range values are rejected, and mutations require the current integer `revision` (mismatches return `code: "stale"` without writing).

Effective values resolve in order (later wins): code defaults (`DEFAULT_SETTINGS`), explicit user settings in SQLite, saved `[tuned]` values (when `tuning.mode !== "off"` and unpinned), active per-quest overrides for `staleMinutes` and `reportBatchSeconds`, and user pins (`[tuning.pinned]`), which always freeze the five tunable knobs.

`GUARDRAIL_SETTING_KEYS` blocks Tavern-managed threads from modifying sensitive keys even when `tavern.agents_may_change_settings` is enabled: `scopes.*`, `away.*`, `machines.*`, `keepers.alwaysAsk`, `keepers.greenlight`, `keepers.partyMax`, `keepers.decisionTimerMax`, `tavern.agentsMayChangeSettings`, `tavern.paused`, `tavern.gitProgram`, `tavern.piProgram`, `attention.reviewBudget`, `attention.notify`, `attention.quietHours`, `tuning.mode`, `knobs.typingHoldSeconds`, `knobs.afterMessageHoldSeconds`, and `knobs.rangerTimeboxMaxMinutes`. `machines.forges` is stricter still: editable only in Settings or through an applied setup proposal, never via `bb tavern settings set`, TOML import, or backup restore.

| Control | Default | Range | Tunable or quest override |
| --- | --- | --- | --- |
| `knobs.tickSeconds` | `60` s | `30–300` | Tunable |
| `knobs.typingHoldSeconds` | `45` s | `15–180` | Tunable |
| `knobs.afterMessageHoldSeconds` | `60` s | `15–180` | Tunable |
| `knobs.staleMinutes` | `20` min | `10–120` | Tunable and quest override |
| `knobs.reportBatchSeconds` | `60` s | `30–300` | Tunable and quest override |
| `knobs.rangerTimeboxMaxMinutes` | `30` min | `3–30` | No |
| `knobs.ledgerRefreshMinutes` | `10` min | `2–60` | No |
| `keepers.partyMax` / `chainMembers` | `5` / `12` | `1–1,000` | No |
| `keepers.restMinutes` / `decisionTimerMax` | `30` / `10,080` min | `1–10,080` | No |
| `keepers.keepMaxHours` | `168` h | `1–168` | No |
| `keepers.restatementBytes` / `tickFactChars` | `28,000` / `14,000` | `8,000–32,000` / `4,000–32,000` | Never tuned down |
| `keepers.clusterGrantMinutes` | `15` min | `1–30` | No |
| `keepers.successionRecoverySeconds` | `600` s | `30–3,600` | No |
| `attention.reviewBudget` | `3` | `1–30` | No |
| `machines.maxMakers` / `maxCheckers` | `2` / `2` | `1–1,000` | No |
| `tavern.speechThreadLimit` / `speechInstallLimit` | `12` / `100` | `1–100` / `1–500` | No |
| `data.historyDays` / `autoArchiveDays` | `0` / `0` | `0–3,650` | No |
| `data.backupKeep` | `14` | `0–365` (`0` keeps all) | No |

TOML files use `snake_case` keys while CLI commands use `camelCase`. Imports preview by default (128 KiB limit) and preserve `machines.forges`. Setup proposals (`src/server/settings/setup.ts`, cap 50 pending) verify no targeted setting changed since creation and run forge `--help` preflight checks before committing atomically.

## Deterministic tuning and Insights

`src/server/settings/tuner.ts` runs when `tuning.mode` is `"suggest"` or `"apply"`, respecting `tuning.minSamples` (default 20), `tuning.windowDays` (30), and `tuning.cooldownDays` (7). Every adjustment records an undoable `SettingDecision`.

| Knob | Trigger and adjustment |
| --- | --- |
| `tickSeconds` | At least 20 attempts with at least 30% held or deferred, or at least 20 turns with P90 above 75% of interval, moves to `max(1.25 * interval, P90 + 5s)`. |
| `typingHoldSeconds` | At least 20 attempts with at least 25% held for typing adds 15 seconds. |
| `afterMessageHoldSeconds` | At least 20 attempts with at least 25% held after a user message adds 15 seconds. |
| `staleMinutes` | Per class with at least 20 report intervals moves to `max(current, 2 * P95)` (never shortened). |
| `reportBatchSeconds` | At least 20 report-minute buckets with P95 of at least 4 reports increases by 25%. |

`src/server/insights/` aggregates phase transitions, Warden verification reopen rates by model, character service records, and optional Burn cost data. `data.historyDays` prunes only optional Insights samples, never quests, decisions, journals, or service records.

## Public RPC surfaces

- **Settings (`src/shared/settings.ts`):** `settings`, `settingsUpdate`, `settingsUndo`, `settingsExport`, `settingsImport`, `settingsFile`, `settingsEndOverride`, `settingsApplySuggestion`.
- **Setup (`src/shared/setup.ts`):** `setupProposal`, `setupPending`, `setupApply`, `setupDismiss`.
- **Insights (`src/shared/insights.ts`):** `insights`.
- **Memory (`src/shared/memory.ts`):** `memorySettings`, `memoryConfigure`, `memoryProjects`, `memoryList`, `memoryPrevious`, `memoryManage`.
- **Backups (`src/shared/backup.ts`):** `backupList`, `backupSave`, `backupExport`, `backupRestore`, `registryFile`, `registryExportFolder`.
- **Closing time (`src/shared/away-rpc.ts`):**

| RPC | Purpose |
| --- | --- |
| `away({})` | Current window, revision, `watchedCount`, `watchedByQuest`, `heldCount`, `pendingStops`, and `resumeRequired`. |
| `awayClose(input)` | Opens a window with optimistic `revision`; returns `closed`, `pending`, or `stale`. |
| `awayReturn({ windowId })` | Ends the window; returns `returned`, `unchanged`, or `stale`. |
| `awayDigest({ windowId?, cursor?, askCursor?, limit? })` | Reads current or completed-window activity (`limit` 1 to 100, default 30). |

Content transfers (machine snapshots and preservation) share the same durable member hold latch (`runtime.away.requestContentHold`, `confirmHeld`, and `finishContentHold`) with independent reason identities so away holds and snapshot transfers never overwrite each other.
