# Tavern settings reference

Paths use the snake_case spelling for TOML. The settings CLI uses camelCase. A value omitted from a settings file normally inherits its default. Use Tavern Settings for user changes; the CLI's preview does not change anything.

- User: only the user can make the change. You can set forge commands on the Settings page or by applying a setup proposal, not through the settings CLI or a backup restore. Every setup proposal waits for your Apply, whatever its keys.
- Granted: the user can change it, and the settings CLI accepts an agent write while `tavern.agents_may_change_settings` is on. The thread’s shell scope still applies.
- Plain: like Granted, but only a plain bb thread can apply it as an agent. Tavern-managed and archived member threads cannot apply guardrail changes.
- Tuned: Tavern can also change the effective value when tuning applies. A pin keeps the user's value. A per-quest override is available for only the two rows that name it.

| Setting | What it does | Default | Who can change it |
| --- | --- | --- | --- |
| `tavern.paused` | Holds new Keeper work while current turns finish. | `false` | User; Plain |
| `tavern.git_program` | Sets an absolute Git path on Tavern's server machine. Empty uses PATH. | `""` | User |
| `tavern.default_class` | Starts new eligible threads as this class. None starts a plain thread. | `"none"` | User; Granted |
| `tavern.widget_row` | Shows the Tavern widget above the composer. | `true` | User; Granted |
| `tavern.voice` | Sets full, light or off voice for Tavern's character presentation. | `"full"` | User; Granted |
| `tavern.contextual_speech` | Run Pi without tools or sessions to write character remarks on clicks, at watched milestones, and when a timed remark is due. | `false` | User; Granted |
| `tavern.speech_extensions` | Absolute paths to trusted Pi extensions for speech. Normally only these load. If Pi refuses `--no-extensions`, Tavern uses a separate agent folder so Pi can load required extensions too. Not changed by imports or backup restores. | `[]` | User only |
| `tavern.speech_instructions` | System instructions for speech, 1–2,000 characters. Not changed by imports. | `"Write only a brief in-character remark. Do not use tools."` | User only |
| `tavern.pi_program` | Absolute executable path on the machine running Tavern. Empty uses Pi from PATH. | `""` | User only |
| `tavern.speech_model` | Model for contextual speech. | `"openai/gpt-5-nano"` | User; Granted |
| `tavern.speech_reasoning` | Thinking level for contextual speech. | `"low"` | User; Granted |
| `tavern.speech_gap_minutes` | Average time between unprompted remarks, 1–120 minutes. Each wait varies by up to 40%, with or without contextual speech. | `5` | User; Granted |
| `tavern.voice_before_off` | Remembers the last speech level when you turn speech off from the character menu or Atmosphere. Turning speech back on from the menu restores this level. | `"full"` | User; Granted |
| `tavern.levels` | Shows character levels. | `true` | User; Granted |
| `tavern.characters` | Shows the animated character strip without changing class membership. | `true` | User; Granted |
| `tavern.hearth_flicker` | Keeps the legacy hearth motion preference. Saving ambient motion also updates this value. | `true` | User; Granted |
| `tavern.agents_may_change_settings` | Lets an agent preview and then apply allowed CLI settings edits when asked. Turning this off leaves previews available. | `true` | User; Plain while the grant is on |
| `tavern.ambient_motion` | Chooses calm motion, lively motion or still characters. | `"calm"` | User; Granted |
| `tavern.character_quiet_until` | Holds characters still and silent until this Unix time in milliseconds. Right-click a character for an hour of Quiet, or edit its end time in Settings, Atmosphere. `0` turns Quiet off; an elapsed time does not hold characters. | `0` | User; Granted |
| `tavern.repeat_seconds` | Sets the gap between ambient motion repeats. | `20` | User; Granted |
| `tavern.lantern_light` | Draws a pixel halo and a pool of light near the flame, plus nearby rim light. Off removes the light, not the character. | `true` | User; Granted |
| `tavern.lantern_strength` | Sets how strongly the light tints nearby surfaces: low, medium or high. | `"medium"` | User; Granted |
| `tavern.lantern_light_bb` | Lights nearby edges on the composer box and message bubbles. Off keeps the light on Tavern's surfaces only. | `true` | User; Granted |
| `tavern.batch_wake_events` | Lets wake-delivered Keeper ticks briefly gather more events; does not affect regular sweeps. | `false` | User; Granted |
| `tavern.reported_pose_seconds` | Sets how long a character holds the reported pose. | `60` | User; Granted |
| `tavern.verified_pose_minutes` | Sets how long a character holds the verified pose. | `10` | User; Granted |
| `away.never_while_closed` | Lists kinds to stop in the next Closing time window. | `["merge","deploy","production","sends-as-you","delete","other-writes"]` | User |
| `away.default_end_state` | Preselects the outcome to aim for at the next Closing time. | `"drafts-ready"` | User; Plain |
| `away.default_allow_watched` | Preselects whether watched work can continue while closed. | `false` | User; Plain |
| `away.default_wake_blockers` | Preselects whether consequential blockers can wake you while closed. | `true` | User; Plain |
| `away.default_wake_production` | Preselects whether production asks can wake you while closed. | `false` | User; Plain |
| `away.production_wake_hours` | Sets how long a production ask waits before it can wake you. | `2` | User; Plain |
| `away.default_back_at_hour` | Sets the local hour for the suggested Back at time. | `8` | User; Plain |
| `attention.review_budget` | Caps reviews unless the user explicitly allows another. | `3` | User; Plain |
| `attention.notify` | Chooses whether to notify for consequential asks, all asks or none. | `"consequential"` | User; Plain |
| `attention.quiet_hours` | Suppresses ordinary notifications during a period with `start`, `end` and an IANA `time_zone`. In TOML, use `"none"` to clear it. | `null` | User; Plain |
| `keepers.rest_minutes` | Waits this many minutes before reminding the Keeper about a resting member. | `30` | User; Granted |
| `keepers.greenlight` | Chooses explicit plan approval or the policy based on size. | `"explicit"` | User; Plain |
| `keepers.decision_timer_max` | Caps the length of a Keeper decision timer, in minutes. | `10080` | User; Plain |
| `keepers.party_max` | Sets the hard party ceiling. | `5` | User; Plain |
| `keepers.stale_strikes` | Sets how many stale turns a member can have before the Keeper raises the issue. | `2` | User; Granted |
| `keepers.always_ask` | Selects kinds that go to the user by default, without changing verdict requirements. | `["production","merge","credential","sends-as-you","destructive"]` | User |
| `keepers.chain_depth` | Sets how many layers of leads a Keeper can hire below the root. | `1` | User; Granted |
| `keepers.chain_members` | Caps the whole linked party, including leads and reserved hires but not the root Keeper. | `12` | User; Granted |
| `keepers.cluster_grant_minutes` | Sets how many minutes a confirmed cluster command can wait before it needs a new ask. | `15` | User; Granted |
| `keepers.restatement_bytes` | Caps how much Keeper memory fits in a restatement. Lowering this can lose important context. | `28000` | User; Granted |
| `keepers.tick_fact_chars` | Caps the number of characters of facts in a Keeper tick. | `14000` | User; Granted |
| `keepers.failures_before_ask` | Sets how many failures a Keeper sees before it asks the user. | `2` | User; Granted |
| `keepers.stop_ask_after_seconds` | Sets when to ask about a stop that has no confirmation. | `120` | User; Granted |
| `keepers.retry_after_seconds` | Sets when a refused Keeper tick can be retried. | `60` | User; Granted |
| `keepers.brief_retry_attempts` | Caps attempts to deliver a brief. | `5` | User; Granted |
| `keepers.replacements_per_slot` | Caps replacements in the same party slot. | `2` | User; Granted |
| `keepers.ranger_max` | Sets the soft Ranger concurrency default when the class file does not say. | `3` | User; Granted |
| `keepers.keep_max_hours` | Caps the time a Keeper can actively keep a resting member. | `168` | User; Granted |
| `keepers.registry_wait_seconds` | Sets how long a Keeper waits for class files. | `30` | User; Granted |
| `keepers.succession_recovery_seconds` | Sets how long Tavern checks an uncertain refresh before returning control to the current Keeper. | `600` | User; Granted |
| `keepers.registry_blocker_minutes` | Sets when a class-file problem becomes an ask. | `5` | User; Granted |
| `classes.<id>.provider` | Overrides the provider for this class. | Inherits | User; Granted |
| `classes.<id>.model` | Overrides the model for this class. | Inherits | User; Granted |
| `classes.<id>.reasoning` | Overrides the model’s reasoning level. Use `"default"` in TOML to request the model default. | Inherits | User; Granted |
| `scopes.mode` | Selects Enforce, Watch or Off for ordinary scope checks. Host capabilities still constrain containment. | `"enforce"` | User; Plain |
| `scopes.send_tools` | Names tool patterns that send or draft as you. Each has a `pattern`, `act` (`send` or `draft`) and optional `target_key`. An asterisk matches any part of the name. The send guard remains active in Watch and Off. | `[]` | User |
| `machines.max_makers` | Caps machine slots for makers per Keeper. | `2` | User; Plain |
| `machines.max_checkers` | Caps machine slots for checkers per Keeper. | `2` | User; Plain |
| `machines.rules` | Lists placement rules in match order, with their target, inputs, consent, draft location and per-class model overrides. | `[]` | User; Plain |
| `machines.forges` | Lists named forge profiles and their commands for draft pull requests from home. | `[]` | User |
| `journal.journal_reminders` | Enables Journal reminders. | `true` | User; Granted |
| `journal.journal_quiet_minutes` | Waits for thread quiet before offering a Journal reminder. | `10` | User; Granted |
| `journal.remind_every_minutes` | Sets the shortest time between Journal reminders. | `15` | User; Granted |
| `journal.report_grace_minutes` | Gives a reported entry this long before reminding its assigned checker. | `10` | User; Granted |
| `data.history_days` | Retains optional Insights samples for this many days. Zero never prunes samples. It does not prune work records. | `0` | User; Granted |
| `data.auto_archive_days` | Sets the age in days before eligible old work can be archived. Zero disables this. | `0` | User; Granted |
| `data.backup_keep` | Keeps this many saved backups. Zero keeps them all. It does not prune work records. | `14` | User; Granted |
| `tuning.mode` | Chooses automatic measured tuning, suggestions for review, or off. | `"off"` | User; Plain |
| `tuning.min_samples` | Sets how much evidence tuning needs before it suggests a change. | `20` | User; Granted |
| `tuning.window_days` | Sets how many days of evidence tuning reads. | `30` | User; Granted |
| `tuning.cooldown_days` | Sets how long to wait between automatic changes. | `7` | User; Granted |
| `knobs.tick_seconds` | Sets the Keeper tick interval. | `60` | User; Granted; Tuned |
| `knobs.typing_hold_seconds` | Holds ticks while you type. | `45` | User; Plain; Tuned |
| `knobs.after_message_hold_seconds` | Holds ticks for a time after your message. | `60` | User; Plain; Tuned |
| `knobs.stale_minutes` | Sets how long a quiet member has before it is stale. A Keeper can set a bounded quest override. | `20` | User; Granted; Tuned |
| `knobs.report_batch_seconds` | Sets how long to gather reports before delivery. A Keeper can set a bounded quest override. | `60` | User; Granted; Tuned |
| `knobs.ranger_timebox_max_minutes` | Ranger check-in interval: how long a Ranger scouts before it reports to its Keeper, who continues it or accepts the work. | `12` | User; Plain |
| `knobs.ledger_refresh_minutes` | Sets the time between full ledger refreshes. | `10` | User; Granted |

## Structured values

Read the machine-rule and forge controls in Settings, Where work runs. A rule has an `id`, a `label`, an `enabled` switch, and a `match` table. Match criteria include project IDs, repository remotes, Keeper path globs, Keeper environment providers, class IDs and quest IDs; omitted criteria do not constrain the match. A `target` uses the current hire path or names an environment provider, input values, machine choice and workspace kind. For a provisioned destination, read the destination provider’s input schema and review the rule’s guard installation, remote detection and Linux check consent with the user.

A rule's `class_models` map defaults to empty. Each class row specifies a model and can override its provider and reasoning. `pull_requests` defaults to the member's machine; the home option requires an enabled profile. A profile has an ID, a name, its enabled state and a kind. A command profile adds an open command, and can add state and close commands. See [the forge command contract](forges.md).

`[tuning.pinned]` in TOML contains the user’s fixed values for the five tunable knobs. `[tuned]` is optional machine tuning state, not an ordinary preference. Both default to empty. Use Settings to pin or reset a value and to inspect any live quest override.

In Settings, Your attention, use "Send a test alert" to check the route to your devices. The test uses bb push notifications but is not held by Tavern's ordinary notification settings. Confirm what actually happened on your device. The test and its answer are receipts, not settings values.

## Setup examples

Use an executable outside agent checkouts and thread storage. This example uses an open script that supports read-only `--help`.

```toml
[[machines.forges]]
id = "drafts"
name = "Drafts from home"
kind = "command"
open = "/opt/forge/bin/open-draft"
```

This disabled rule uses placeholder provider and model IDs. Replace them with IDs from discovery, and keep other rows when replacing a rule array. Each consent switch is the user's choice: never turn it on unless they ask for it in words, and show it first on the card as a guardrail.

```toml
[[machines.rules]]
id = "separate-checkout"
label = "Separate checkout for reviews"
enabled = false
match = { project_ids = ["review-project"] }
target = { kind = "provider", environment_provider_id = "checkout-provider", workspace = "dedicated-machine", machine = { type = "new", machine_provider_id = "machine-provider" } }
consent = { guard_install = false, remote_detection_only = false, linux_uncontained_checks = false }
pull_requests = { at = "home", profile = "drafts" }
class_models = { warden = { provider = "agent-provider", model = "review-model" } }
```

## Tune settings via CLI

Tavern-managed threads, including archived Keepers and members, may preview guardrails but cannot apply them; change guardrails on Tavern's Settings page or ask from a plain thread.

Change settings ONLY when the user asks. Preview first, show the user the preview, then run `--apply`.

1. Read effective settings with `bb tavern settings get` or `bb tavern settings get classes`.
2. Preview a patch with `bb tavern settings set classes.smith.model=model-id tavern.ambientMotion=lively tavern.repeatSeconds=20`. Keys use camelCase dotted paths; values are JSON (objects, arrays, numbers, booleans, or null) or unquoted strings.
3. Add `--apply` to write the patch. Untouched keys stay unchanged, and every agent apply records the calling thread in Settings history with Undo.
4. For a complete replacement, preview `bb tavern settings import --toml "<TOML>"`, then add `--apply`. Import resets omitted explicit settings and pins to defaults while preserving forge profiles.
5. Export explicit settings with `bb tavern settings export`. Agent file exports and backup restores with data remain user-only.

Agents may preview and apply allowed global settings while `tavern.agents_may_change_settings` is on (the default). When locked, previews stay available; ask the user to enable it before applying and NEVER try to bypass the lock. Settings changes never grant consent for asks, Return, production work, or other guarded actions.
