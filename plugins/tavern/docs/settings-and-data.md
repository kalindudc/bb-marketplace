# Settings, memory, backups, and CLI

Configure Tavern on the **Settings** page or with `bb tavern` commands. Search Settings by label, help text, or key (Escape clears); every row shows its default and a reset control. See [How Tavern works](design.md) for concepts, and [`skills/tavern/references/settings.md`](../skills/tavern/references/settings.md) for the complete key-by-key schema.

## Settings sections

| Section | What you configure |
| --- | --- |
| **Setup** | Start a guided setup agent thread and review pending setup proposals. |
| **Tavern** | Pause every Keeper, choose a default class, set a direct local Git path (empty uses `PATH`), and control whether agents may edit non-guardrail settings. |
| **Your attention** | Review budget (default 3), notifications (`consequential`, `all`, or `none`), quiet hours, and **Send a test alert** to verify device delivery. |
| **Keepers and decisions** | Plan greenlight (`explicit` or `by-size`), Always ask kinds, party ceiling (default 5), chain depth (1) and linked party ceiling (12), resting reminder, stale strikes, cluster expiry (15 minutes), refresh wait, and memory limits. |
| **Classes and models** | Per-class provider, model, and reasoning overrides, plus Warden reopen counts and rates by model. |
| **Scopes** | Scope mode (`enforce`, `watch`, or `off`) and `scopes.send_tools` patterns or prefixes. |
| **Where work runs** | Remote maker and checker slots (default 2 each), machine placement rules, and forge profiles. |
| **Memory profiles** | Switch between built-in Durable memory and an external command store. |
| **Atmosphere** | Widget row, character strip, speech level, Quiet timer, contextual speech, ambient motion, lantern light, and character levels. |
| **Closing time** | Default end state, stop list, Back at hour, watched-work toggle, and wake rules. |
| **Journal** | Reminder toggle, quiet delay, reminder interval, and report grace window. |
| **Tuning** | Deterministic pacing tuning (`off`, `suggest`, or `apply`), sample thresholds, and user pins. |
| **Data and backups** | Insights retention, auto-archive age, TOML import and export, and private backups (default retention 14). |
| **Settings history** | Audit log of settings changes with Undo. |

## Guided setup and tuning

- **Guided setup:** Click **Ask an agent to set up Tavern** under **Setup**. The agent discovers checkouts, providers, and models, then stages a minimal TOML patch with per-key reasons (up to 50 open proposals) for you to **Apply** (running forge `--help` checks first) or **Dismiss**.
- **Tuning and Insights:** Automatic tuning (`tuning.mode`, default `off`) suggests or applies measured edits to five pacing knobs after 20 samples while respecting user pins and never lowering memory limits. **Insights** reports phase timing, Warden reopen stats by model, service records, and Burn costs when installed.

## Contextual speech

Turn on **Contextual speech** under **Atmosphere** to choose a Pi model and thinking level. It is off by default. Pi writes only while you are looking at the thread, on character clicks, at certain events, or when a timed remark is due. **Time between remarks** sets the average gap between unprompted remarks with or without Pi. The default is five minutes, varying between three and seven. The read-only attempt count resets at midnight UTC and counts every Pi request, even if its reply never appears. The character's usual line shows while Tavern waits up to ten seconds. A reply that arrives in time replaces it for four and a half seconds; late replies are ignored. Turning off ordinary speech suppresses contextual remarks too.

Pi must be installed and signed in where Tavern runs. Leave **Pi program** empty to use Pi from `PATH`, or set its absolute path. Tavern reuses one Pi process without tools, saved sessions, or new bb threads. It starts fresh for each remark, supplying class, work stage, and the kind of remark, never chat, titles, or reports. The worker closes when Tavern stops, contextual speech is turned off, or no one has watched a strip for ten minutes.

**Speech instructions** sets Pi's system prompt. **Extensions for speech** is empty by default; add only absolute paths to trusted extensions such as one your model needs for sign-in. Extensions run code and can supply their own context. Only you can edit those settings and **Pi program**; imports and backup restores cannot change the speech instructions or extensions.

If Pi refuses `--no-extensions`, Tavern uses a separate Pi agent folder in its data directory. It links `auth.json` and `models.json` when present and writes its own settings to disable built-in extensions. It does not copy your normal settings, packages, or extensions. Pi can still install and load extensions it requires, plus the ones you selected for speech. If Pi exits before it can serve requests, **Pi program** can show the first line of its startup error.

```sh
bb tavern settings set tavern.contextualSpeech=true tavern.speechGapMinutes=8 --apply
```

## Durable memory

Open **Memory** in Tavern to browse or search project notes (findings, decisions, outcomes, and references) by project, text, kind, or status. Built-in memory works with no setup. Tavern classes save notes with evidence and search included, current notes; Keepers review **Unreviewed** member notes; and you can edit, exclude, re-include, supersede, or retire built-in notes while keeping full history. Saved notes are evidence to check, never permission to act.

To use an external note store, place three trusted `--help`-safe executables (`save`, `find`, and `curate`) outside checkouts and thread storage, add the profile in **Settings** under **Memory profiles**, and select it as **Active store**. Imports and restores never alter approved commands; Closing time holds agent writes, Stop all cancels running commands, and `enforce` mode blocks direct shell calls to the executables. See [`skills/tavern/references/memory-profiles.md`](../skills/tavern/references/memory-profiles.md) for the JSON wire format.

## Backups

Save private, server-local backups from **Settings** under **Data and backups** or via `bb tavern backup save --with-data --json`. Managed backups live in `~/.agents/tavern/backups/YYYY-MM-DD-HHMM/` (mode `0700` dirs, `0600` files) and never run automatically.

> Data backups include user-authored notes, routing text, reports, and ledger history; keep them out of shared repositories unless reviewed. They never contain bb credentials, core thread transcripts, live Stop all state, or private placement tables.

Bundles store explicit settings and pins (preserving forge profiles on restore), global overrides (plus local project overrides with `--projects`), and ledger records with `--with-data`. Limits are 8 MiB for UI downloads, 31 MiB for CLI export stdout, and 128 MiB for managed disk bundles; `data.backup_keep` defaults to 14 (0 keeps all).

Restore previews by default; `--apply` requires a user terminal or Settings. Restoring records requires an empty Tavern database with compatible migrations (otherwise config still restores while records are refused with counts) and shows **Finish handover** for any pending Keeper refresh.

To schedule a daily local backup with bb's Automations plugin (no model turns):

```sh
bb automation create --project PROJECT_ID \
  --name "Daily Tavern backup" \
  --cron '0 3 * * *' --timezone UTC \
  --interpreter bash --timeout 5m \
  --working-directory automation-storage \
  --script 'set -euo pipefail; bb tavern backup save --with-data --json'
```

## Command-line reference (`bb tavern`)

Run `bb tavern <command> --help` for full options. User-only controls refuse execution inside agent threads.

| Command | Purpose |
| --- | --- |
| `bb tavern status [--thread ID]` | Print the party, review queue, and Needs you queue as JSON. |
| `bb tavern quests` | List board quests. |
| `bb tavern ask <id> <option>` | Answer an ask from a user terminal. |
| `bb tavern journal export [thread] [--markdown]` | Print a thread's journal as Markdown. |
| `bb tavern stop-all` / `stop-all status` | Pull Stop all or read the last receipt. |
| `bb tavern scope <thread>` | Show effective scope, guard posture, and arming state. |
| `bb tavern violations [thread]` | Show recorded scope violations and stop results. |
| `bb tavern guard status\|install\|uninstall` | Inspect, install, or remove the local Pi guard shim. |
| `bb tavern settings get\|set\|export\|import` | Read, preview, or apply dotted edits, or export and import TOML settings. |
| `bb tavern setup discover\|propose` | Discover environment facts or stage a settings proposal. |
| `bb tavern backup save\|export\|list\|show\|restore` | Manage private server-local backups. |
| `bb tavern steer-test` | Print the two-goal steer replay script. |
