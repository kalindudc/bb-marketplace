# Settings and Insights backend

Contributor reference for Tavern's settings schema, precedence, TOML persistence, deterministic tuning, Insights data coverage, and public RPCs. For the complete per-key table (TOML paths, defaults, and edit permissions), see [`skills/tavern/settings.md`](../skills/tavern/settings.md).

## Schema and precedence

`src/shared/settings.ts` defines the strict Zod schema (`settingsSchema`, `settingsPatchSchema`, `settingsUpdateSchema`). Unknown keys and out-of-range values are rejected. Mutations require the current integer `revision`; a mismatch returns `code: "stale"` without writing.

Effective values resolve in this order (later wins):
1. Code defaults (`DEFAULT_SETTINGS`).
2. Explicit user settings saved in the plugin SQLite database.
3. Saved deterministic `[tuned]` values (applied only when `tuning.mode !== "off"` and the knob is not pinned).
4. Active per-quest overrides for `staleMinutes` and `reportBatchSeconds` (only while tuning is enabled and the knob is unpinned; users can end live overrides via `settingsEndOverride`).
5. User pins (`[tuning.pinned]`) always freeze the five tunable knobs against tuning and quest overrides.

### Guardrail keys

`GUARDRAIL_SETTING_KEYS` in `src/shared/settings.ts` defines settings that Tavern-managed threads cannot modify even when `tavern.agents_may_change_settings` is enabled:

- `scopes.*`, `away.*`, `machines.*`
- `keepers.alwaysAsk`, `keepers.greenlight`, `keepers.partyMax`, `keepers.decisionTimerMax`
- `tavern.agentsMayChangeSettings`, `tavern.paused`
- `attention.reviewBudget`, `attention.notify`, `attention.quietHours`
- `tuning.mode`, `knobs.typingHoldSeconds`, `knobs.afterMessageHoldSeconds`, `knobs.rangerTimeboxMaxMinutes`

`machines.forges` is stricter still: editable only through Settings UI or an applied setup proposal, never via `bb tavern settings set`, TOML import, or backup restore.

### Bounds for key numeric controls

| Control | Default | Range | Tunable / Quest override |
| --- | --- | --- | --- |
| `knobs.tickSeconds` | `60` s | `30–300` | Tunable |
| `knobs.typingHoldSeconds` | `45` s | `15–180` | Tunable |
| `knobs.afterMessageHoldSeconds` | `60` s | `15–180` | Tunable |
| `knobs.staleMinutes` | `20` min | `10–120` | Tunable + quest override |
| `knobs.reportBatchSeconds` | `60` s | `30–300` | Tunable + quest override |
| `knobs.rangerTimeboxMaxMinutes` | `12` min | `3–30` | No |
| `knobs.ledgerRefreshMinutes` | `10` min | `2–60` | No |
| `keepers.partyMax` / `chainMembers` | `5` / `12` | `1–1,000` | No |
| `keepers.chainDepth` | `1` | `1–3` | No |
| `keepers.restMinutes` / `decisionTimerMax` | `30` / `10,080` min | `1–10,080` | No |
| `keepers.restatementBytes` / `tickFactChars` | `28,000` / `14,000` | `8,000–32,000` / `4,000–32,000` | Never tuned down |
| `keepers.clusterGrantMinutes` | `15` min | `1–30` | No |
| `keepers.successionRecoverySeconds` | `600` s | `30–3,600` | No |
| `attention.reviewBudget` | `3` | `1–30` | No |
| `machines.maxMakers` / `maxCheckers` | `2` / `2` | `1–1,000` | No |
| `data.historyDays` / `autoArchiveDays` | `0` / `0` | `0–3,650` | No |
| `data.backupKeep` | `14` | `0–365` (`0` = keep all) | No |

Internal plumbing stays in code constants (5-second loop sweep, retry backoffs, pagination bounds, guard/stop timeouts, and verification semantics).

## TOML, dotfiles and setup proposals

- TOML files use `snake_case` keys; CLI commands use `camelCase`. Export includes explicit user settings and `[tuning.pinned]`; `[tuned]` is emitted only with `--with-tuned`.
- Import (`settingsImport` / `bb tavern settings import`) previews by default (max 128 KiB TOML), reports added/changed/reset keys, and preserves existing `machines.forges`.
- Setup proposals (`src/server/settings/setup.ts`) stage a minimal TOML patch plus one-line reasons per key (cap: 50 pending proposals). Applying verifies that no targeted setting changed since proposal creation and runs forge `--help` preflight checks before committing in one transaction.

## Deterministic tuning

`src/server/settings/tuner.ts` runs only when `tuning.mode` is `"suggest"` or `"apply"`, respecting `tuning.minSamples` (default `20`), `tuning.windowDays` (`30`), and `tuning.cooldownDays` (`7`). Every change writes an audited `SettingDecision` with `Undo`.

| Knob | Trigger and adjustment |
| --- | --- |
| `tickSeconds` | ≥20 attempts with ≥30% held/deferred, or ≥20 turns with P90 > 75% of interval → `max(1.25 × interval, P90 + 5s)`. |
| `typingHoldSeconds` | ≥20 attempts with ≥25% held for typing → `+15s`. |
| `afterMessageHoldSeconds` | ≥20 attempts with ≥25% held after a user message → `+15s`. |
| `staleMinutes` | Per class with ≥20 report intervals → `max(current, 2 × P95)` (never shortened). |
| `reportBatchSeconds` | ≥20 report-minute buckets with P95 ≥ 4 reports → `+25%`. |

## Insights and data coverage

- `src/server/insights/` aggregates recorded phase transitions, Warden verification reopen rates by model (showing counts instead of rates on small samples; waived early-close rejections counted separately), lasting character service records, and optional Burn cost data when Burn is installed.
- `data.historyDays` prunes only optional Insights samples—never quests, decisions, journals, or service records.

## Public RPCs

- **Settings (`src/shared/settings.ts`):** `settings`, `settingsUpdate`, `settingsUndo`, `settingsExport`, `settingsImport`, `settingsFile`, `settingsEndOverride`, `settingsApplySuggestion`.
- **Setup (`src/shared/setup.ts`):** `setupProposal`, `setupPending`, `setupApply`, `setupDismiss`.
- **Insights (`src/shared/insights.ts`):** `insights`.
- **Backups (`src/shared/backup.ts`):** `backupList`, `backupSave`, `backupExport`, `backupRestore`, `registryFile`, `registryExportFolder` (see [Backups](backups.md)).
