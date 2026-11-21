# Backups

Use `bb tavern backup save --with-data` (or **Settings → Backups**) to write a private, server-local backup of Tavern's configuration and ledger. Tavern never schedules backups or commits files on its own.

> **Privacy:** Data backups include user-authored notes, routing text, reports, and ledger history. Keep them out of shared repositories unless reviewed. Backups never include bb credentials, core thread transcripts, or live machine-allocation authority.

## Save, inspect and export

```sh
bb tavern backup save --with-data --json
bb tavern backup list --json
bb tavern backup show 2026-11-21-0412 --json
bb tavern backup export > tavern-backup.json
bb tavern backup export --with-data --projects > tavern-backup-with-data.json
bb tavern backup export --parts classes > tavern-classes.json
```

Managed backups save to `~/.agents/tavern/backups/YYYY-MM-DD-HHMM/` on the bb server (mode `0700` dirs, `0600` files, numeric suffix on collision).

### What a `tavern-backup/1` bundle contains

| Part | Included | Excluded / stripped |
| --- | --- | --- |
| `settings.toml` | Explicit user settings and tuning pins | Automatic `[tuned]` state, live quest overrides, `machines.forges` (preserved on restore) |
| Overrides | Global class/character overrides, global `scopes.yml`, plus registered local project overrides with `--projects` | Remote-host paths; shipped defaults are stored under `effective/` for reference only and never overwrite overrides on restore |
| `records.json` (`--with-data`) | Quests, plans, members, asks, decisions, rules, notes, gates, routes, reports, journals, events, setting history, Insights samples, service records, Keep flags, verdict receipts | Private machine/placement tables (`tavern_placements`, `tavern_source_snapshots`, `tavern_placement_discoveries`, `tavern_snapshot_owners`), live Stop all state, and local tick-delivery retry state |
| Manifest | Tavern/schema version, migration hashes, counts, sizes, SHA-256 per payload file | — |

### Size limits

| Surface | Limit |
| --- | --- |
| Settings page download | 8 MiB |
| `bb tavern backup export` stdout | 31 MiB |
| Managed disk bundle (`backup save`) | 128 MiB |
| Individual definition file / total files | 1 MiB / 2,000 files |

## Preview and restore

Restore previews by default; only `--apply` writes changes.

```sh
bb tavern backup restore 2026-11-21-0412 --json
bb tavern backup restore 2026-11-21-0412 --apply --json
bb tavern backup restore --bundle "$(< tavern-backup.json)" --json
bb tavern backup restore --bundle "$(< tavern-backup.json)" --preview-hash HASH --apply --json
```

- **Trust and authority:** SHA-256 checks integrity, not intent—review settings, file paths, and `scopes.yml` before applying. Agents may save, export, and preview, but `--apply` is refused inside agent threads; apply from an ordinary terminal or Settings.
- **Empty database for records:** Restoring `records.json` requires a completely empty Tavern database (including journals, setting history, and private placement tables) and compatible migrations. If the database is nonempty, records are refused with counts while configuration can still restore.
- **Safe writes:** Restore writes original overrides (never `effective/` copies), never deletes absent files, preserves forge profiles, and rolls back failed transactions atomically. Restoring records restores Tavern's ledger, not bb transcripts, worktrees, or live machines; any pending Keeper succession shows **Finish handover** to verify before resuming.
- **Large cross-machine restores:** Copy the managed folder into `~/.agents/tavern/backups/` on the target server and restore by name to avoid OS shell argument-size limits.

## Retention and exit codes

`data.backup_keep` defaults to `14` (range `0–365`; `0` keeps all). `backup save` prunes only recognized healthy managed folders and never follows symlinks or deletes the backup just written.

| Exit | Meaning |
| --- | --- |
| `0` | Success (check `records.action` on restore because refused records do not fail a config restore) |
| `1` | Operational failure (missing backup, storage error, refused source file) |
| `2` | Invalid input/parts, agent `--apply` refusal, or export above stdout limit |
| `3` | Stale `--preview-hash`; nothing written |

## Daily script automation (optional)

Tavern does not install schedules itself. To run a daily server-local backup with bb's Automations plugin (no model turns):

```sh
bb automation create --project PROJECT_ID \
  --name "Daily Tavern backup" \
  --cron '0 3 * * *' --timezone UTC \
  --interpreter bash --timeout 5m \
  --working-directory automation-storage \
  --script 'set -euo pipefail; bb tavern backup save --with-data --json'
```

Add `--projects` to include registered local project overrides, then verify with `bb automation runs AUTOMATION_ID --project PROJECT_ID`.
