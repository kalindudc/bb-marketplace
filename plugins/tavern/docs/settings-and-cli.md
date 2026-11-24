# Settings and CLI

Configure Tavern on the **Settings** page or with `bb tavern` commands. Every Settings row shows its default and a reset control; Keeper pacing and memory knobs show who last changed them and let you end live quest overrides.

For the complete key-by-key schema (every default, bound, TOML path, and edit permission), see [`skills/tavern/settings.md`](../skills/tavern/settings.md) and [Settings and Insights backend](settings-backend.md).

## Settings sections

| Section | What you configure |
| --- | --- |
| **General & Atmosphere** | Pause Keepers (`tavern.paused`), default class, widget row, character visibility, speech level (`full`, `light`, `off`), Quiet timer, ambient motion (`calm`, `lively`, `off`), lantern/hearth light (`lantern_light`, `lantern_strength`, `lantern_light_bb`), levels, and wake batching (`batch_wake_events`). |
| **Your attention** | Review budget (`attention.review_budget`, default `3`), notifications (`consequential`, `all`, `none`), quiet hours, and **Send a test alert** (sends a bb push notification and records whether it arrived on your device). |
| **Keepers and decisions** | Plan greenlight (`explicit` or `by-size`), `always_ask` kinds, hard party ceiling (`party_max`, default `5`), chain limits (`chain_depth` default `1`, `chain_members` default `12`), resting reminder (`rest_minutes`, default `30`), stale strikes, cluster confirmation expiry (`cluster_grant_minutes`, default `15`), succession recovery wait (`succession_recovery_seconds`, default `600`), and memory limits. |
| **Classes and models** | Per-class `provider`, `model`, and `reasoning` overrides, plus Warden verification reopen rates by model. |
| **Guardrails** | Scope mode (`enforce`, `watch`, `off`), `scopes.send_tools` patterns/prefixes, Closing time defaults, and whether agents may change non-guardrail settings via CLI (`tavern.agents_may_change_settings`, default `true`). |
| **Where work runs** | Maker/checker remote slot ceilings (`max_makers` / `max_checkers`, default `2` each), machine placement rules with per-class model overrides, and forge profiles (`machines.forges`). |
| **Journal, Data & Tuning** | Journal reminders and grace windows, Insights sample retention (`history_days`), auto-archive (`auto_archive_days`), backup retention (`backup_keep`, default `14`), and deterministic pacing tuning (`off` by default; `suggest` or `apply`). |

## Contextual speech

Contextual speech is off by default. Open **Settings → Atmosphere → Contextual speech** to turn it on, choose the Pi model and thinking, and edit the two limits. The defaults are 12 attempts per thread and 100 for the whole install. The read-only count shows how many attempts the install has used today. Both limits reset at midnight UTC. An attempt counts even if the reply never appears.

Tavern runs Pi for each attempt without tools or a saved session. It sends only the class, work stage and kind of change, not chat, titles or reports from the member. No bb thread is created. Pi must be installed and signed in where Tavern runs. Leave **Pi program** empty to use Pi from PATH, or set its absolute path. Only you can change the executable path. The character's usual line shows first. A valid reply can replace it only while the same bubble is still showing. Turning off ordinary speech also suppresses contextual speech.

The CLI can set these just like other Atmosphere settings. For example:

```sh
bb tavern settings set tavern.contextualSpeech=true tavern.speechThreadLimit=8 tavern.speechInstallLimit=60 --apply
```

## Guided setup with an agent

Click **Ask an agent to set up Tavern** at the top of Settings to open a bb composer thread with a setup prompt (even if you have a default class, you can start it as a plain thread):

1. The agent runs `bb tavern setup discover [--project ID] [--host ID]` to inspect your checkouts, providers, model catalogs, and current placement settings.
2. It runs `bb tavern setup propose --toml '<patch>' --reasons '<json>' [--project ID]` to stage a reviewed proposal (up to 50 open proposals).
3. Review the diff, reasons, and preflight checks in the thread or at the top of Settings, then click **Apply** (which runs forge `--help` checks before saving) or **Dismiss**.

## Tuning and Insights

- **Deterministic tuning** (`tuning.mode`, default `off`) can suggest or adjust five pacing knobs (`tick_seconds`, `typing_hold_seconds`, `after_message_hold_seconds`, `stale_minutes`, `report_batch_seconds`) once enough samples accumulate (`tuning.min_samples`, default `20`). Memory limits (`restatement_bytes`, `tick_fact_chars`) are never tuned down. Pin any knob to freeze your value.
- **Insights** shows phase timing, Warden verification reopen rates by model (showing counts rather than rates for small samples, and counting waived early-close rejections separately), character records, and recorded usage costs when Burn is installed.

## `bb tavern` CLI reference

Run `bb tavern <command> --help` for full flags. User-only controls refuse execution inside agent threads.

### Board and threads

| Command | Purpose |
| --- | --- |
| `bb tavern status [--thread ID]` | Read the party, review queue, and Needs you queue (valid JSON; summarizes omitted old rows when large). |
| `bb tavern quests` | List board quests. |
| `bb tavern ask <id> <option>` | Answer an ask from a user terminal (refused in agent threads). |
| `bb tavern journal export [thread] [--markdown]` | Print a thread's journal grouped as Markdown. |
| `bb tavern stop-all` / `stop-all status` | Pull the emergency brake or inspect its stored receipt. |
| `bb tavern steer-test` | Print the two-goal steer replay script (see [Steer replay](steer-test.md)). |

### Scopes and Pi guard

| Command | Purpose |
| --- | --- |
| `bb tavern scope <thread>` | Show a thread's effective scope, guard posture, and arming state. |
| `bb tavern violations [thread]` | Show recorded scope violations with evidence, stop results, and latency. |
| `bb tavern guard status\|install\|uninstall` | Inspect, install/update, or remove Tavern's marked Pi guard shim (user terminal only for install/uninstall). |

### Settings, setup and backups

| Command | Purpose |
| --- | --- |
| `bb tavern settings get [key]` | Read effective settings or one dotted camelCase key. |
| `bb tavern settings set <key=value...> [--apply]` | Preview dotted edits; `--apply` writes (guardrails require a user terminal or plain thread; forge profiles cannot be set here). |
| `bb tavern settings export [--file PATH --host ID] [--with-tuned] [--overwrite]` | Export explicit settings and pins as TOML (`--with-tuned` adds `[tuned]`). |
| `bb tavern settings import [path] [--toml TEXT] [--host ID] [--json] [--apply]` | Preview or apply a TOML import (preserves forge profiles). |
| `bb tavern setup discover [--project ID] [--host ID]` | Inspect checkouts, providers, model catalogs, and placement state. |
| `bb tavern setup propose --toml TOML --reasons JSON [--project ID]` | Stage a settings proposal card for user review. |
| `bb tavern backup save\|export\|list\|show\|restore` | Manage private backups (see [Backups](backups.md)). |
