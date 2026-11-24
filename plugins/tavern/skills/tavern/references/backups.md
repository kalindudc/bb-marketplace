# Backups reference

Agents may save, list, inspect, export, and preview backups, but applying a restore (`--apply`) is user-only and refused inside agent threads. Backups are private: NEVER upload or commit a data backup without explicit user approval.

## Agent-allowed commands

```sh
bb tavern backup save --with-data --json
bb tavern backup list --json
bb tavern backup show <backup-name> --json
bb tavern backup export > tavern-backup.json
bb tavern backup export --with-data --projects > tavern-backup-with-data.json
bb tavern backup export --parts classes > tavern-classes.json
bb tavern backup restore <backup-name> --json
bb tavern backup restore --bundle "$(< tavern-backup.json)" --json
```

Managed backups save to `~/.agents/tavern/backups/YYYY-MM-DD-HHMM/` on the bb server (`0700` directories, `0600` files, numeric suffix on collision). Retention is controlled by `data.backup_keep` (default 14, range 0 to 365; 0 keeps all), pruning only recognized healthy managed folders without following symlinks.

## What `tavern-backup/1` includes and excludes

| Part | Included | Excluded or preserved |
| --- | --- | --- |
| `settings.toml` | Explicit user settings and tuning pins | Automatic `[tuned]` state, live quest overrides, and `machines.forges` (preserved on restore) |
| Overrides | Global class, character, and `scopes.yml` overrides, plus registered local project overrides with `--projects` | Remote-host paths; shipped defaults sit under `effective/` for reference and never overwrite overrides |
| `records.json` (`--with-data`) | Quests, plans, members, asks, decisions, rules, notes, gates, routes, reports, journals, events, setting history, Insights samples, service records, Keep flags, verdict receipts, built-in memory notes | Private placement tables (`tavern_placements`, `tavern_source_snapshots`, `tavern_placement_discoveries`, `tavern_snapshot_owners`), live Stop all state, and local tick-retry state |
| `manifest.json` | Tavern and schema version, migration hashes, counts, sizes, SHA-256 per payload file | No credentials or core thread transcripts |

## Size limits and exit codes

- Settings page download: 8 MiB.
- `bb tavern backup export` stdout: 31 MiB.
- Managed disk bundle (`backup save`): 128 MiB.
- Individual definition file: 1 MiB; maximum files per bundle: 2,000.

| Exit | Meaning |
| --- | --- |
| `0` | Success (on restore, inspect `records.action` because refused records do not fail a config restore). |
| `1` | Operational failure (missing backup, storage error, or refused source file). |
| `2` | Invalid input or parts, agent `--apply` refusal, or export above the stdout limit. |
| `3` | Stale `--preview-hash`; nothing written. |

Restoring `records.json` requires an empty Tavern database (including journals, setting history, and private placement tables) and compatible migrations. SHA-256 checks integrity, not intent; the user always reviews and applies restores from an ordinary terminal or Settings.
