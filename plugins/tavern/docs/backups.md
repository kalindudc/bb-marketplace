# Back up Tavern

Use `bb tavern backup save --with-data` for a private, server-local backup. Tavern does not schedule backups or commit files on its own. The settings page offers the same save, export and previewed restore operations.

User-authored notes can be private. A data backup also contains Tavern's routing text, reports and ledger history. Keep it out of shared repositories unless you have reviewed it. Backups never request bb's credential stores or core thread transcripts.

## Save, inspect and export

```sh
bb tavern backup save --with-data --json
bb tavern backup list --json
bb tavern backup show 2026-11-14-0412 --json
bb tavern backup export > tavern-backup.json
bb tavern backup export --with-data --projects > tavern-backup-with-data.json
bb tavern backup export --parts classes > tavern-classes.json
```

Save writes `~/.agents/tavern/backups/YYYY-MM-DD-HHMM/` on the machine running the bb server. If that folder already exists, the next save adds a numeric suffix. Ordinary output includes the path and manifest; `--json` supplies the structured result. Directories are mode 0700 and files are mode 0600.

A bundle uses format `tavern-backup/1`. It contains:

- `settings.toml`, containing explicit user settings and pins, not automatic tuning or temporary quest overrides.
- The original global class and character overrides, verbatim, plus each registered server-local project's overrides when `--projects` is supplied.
- An `effective/` reference copy of each resolved class and character, with its shipped, global or project source recorded in the manifest.
- The global `scopes.yml`, when present.
- Optional `records.json`: Tavern's quests, plans, members, asks, decisions, rules, notes, gates, routes, reports, journals, events, delivery bookkeeping, setting history and samples. Terminal service records, frozen level snapshots, per-tale character Keep flags and private verdict receipts preserve character achievements, preferences and attribution. These travel only with record data; configuration-only backups contain neither tales nor their Keep flags. They are portable history, not delivery or execution authority. Older members' verified wins remain available to the conservative one-time backfill. Journal id reservations and SQLite id high-water marks survive history pruning.
- A manifest with the Tavern version, schema version, migration hashes, creation time, machine, project identities, counts, data-included flag and data byte size. Every payload file has its byte length and SHA-256 hash.

Portable records exclude `tavern_placements`, `tavern_source_snapshots`, `tavern_placement_discoveries` and `tavern_snapshot_owners`. These private tables carry live generation, hire and allocation authority, host-local source/ref pins, and cached source-read authorization. Discovery generations remain private per-Keeper authority, not portable Keeper runtime. An import that supplies any of these tables is refused, even with no rows. Member reports and ledger history remain portable; private source and artifact refs are not a backup of their bytes. Save the actual work through the placement preservation flow or a separate repository/file backup.

Tick delivery state is local, not portable. Capture strips `sendPending`, `resendCount`, `lastSendAt`, `measurements` and `admittedResendCount` from outbox batches, and `tickDeliveryAskId`, `tickRefusalCount`, `queuedTickResetId` and `tickRetryAt` from runtime records. Prepared and queued batches become cancelled tombstones with empty text; delivered and cancelled batches remain terminal. Capture never changes the live database.

Restore applies the same projection to older bundles too. It never resends an old batch or records its old delivery measurements. Undelivered facts and cursors remain available for a fresh update built from current state. The corresponding open delivery asks become withdrawn with cause `backup-restored`; the receiving clock supplies their actual withdrawal time when restore runs, not when the backup or preview was made. Unrelated asks and existing withdrawal history remain intact. Any future local-only delivery fields must be added to this projection before shipping.

`--projects` never reads remote-host paths as if they were local. Projects with no registered server-local checkout produce a manifest warning. Exporting only one part excludes diagnostics from unselected parts too.

Stdout export is one complete JSON document, never a truncated fragment. The page download limit is 8 MiB; CLI stdout export has a 31 MiB limit below bb's 32 MiB stdout ceiling. Managed disk bundles have a 128 MiB safety limit. An individual definition file is limited to 1 MiB and a bundle to 2,000 payload files. If a download is too large, use Save backup to keep it on disk. `backupList` supplies an estimate before the click; export checks the actual size again.

## Preview and restore

```sh
bb tavern backup restore 2026-11-14-0412 --json
bb tavern backup restore 2026-11-14-0412 --apply --json
bb tavern backup restore --bundle "$(< tavern-backup.json)" --json
bb tavern backup restore --bundle "$(< tavern-backup.json)" --apply --json
```

Restore previews by default. `--apply` makes a fresh preview and applies only that state. To bind an earlier preview explicitly, pass its `previewHash` as `--preview-hash HASH --apply`; a changed bundle, settings revision, destination or data eligibility returns `stale` without writing.

Shell-captured JSON is subject to the operating system's argument-size limit. For large cross-machine data restores, transfer the managed backup folder into the receiving server's backups directory and restore it by name. Native multiline stdin is not a plugin CLI interface.

Only restore a bundle you trust: SHA-256 detects corruption, not the author's intent. Review the settings changes, file paths and scope policy before applying. Restore writes original user overrides, not the effective reference copies: restoring a shipped definition as a global override would otherwise freeze an old prompt. Files absent from the bundle are never deleted. Existing dotfile symlinks are preserved and their physical targets appear in the preview. A broken link, conflicting physical alias or a changed target is refused.

Project restores require the same project id to have a current registered server-local checkout. The old path in a manifest is informational, never a restore destination. If project identities differ, transfer those project override files manually after reviewing them.

Records restore only into an empty Tavern database. That check includes journal/import/delivery records, setting history and any private placement/source/discovery/snapshot-owner rows, not just visible quests. Private authority cannot make a destination appear empty merely because it is excluded from the portable bundle. A nonempty database or an incompatible migration history refuses records with a reason and counts; configuration can still restore. Every row is validated, including SQL constraints and journal references, before changes begin. Actual records insertion runs inside one transaction. A failed transaction rolls back records, settings and files written by that operation. An external edit is never overwritten during rollback. A failed post-commit UI notification is logged; it does not undo already committed data. Cross-file rollback handles ordinary failures; it is not a filesystem-wide power-loss transaction.

A data backup restores Tavern's ledger, not bb's conversations, environments or worktrees. It does not create replacement threads. Agents may save, export and preview. Applying global configuration or records through the CLI is refused in an agent thread; the user applies from an ordinary terminal or the settings page.

## Retention and exit codes

The Data section's `backupKeep` setting defaults to 14, accepts 0 to 365, and uses TOML key `backup_keep`. Zero keeps all backups. Save prunes only recognized, healthy managed backup folders. It never follows a backup-directory symlink or removes an unrelated directory. The just-saved backup is retained even if the system clock moved backwards. Incomplete, corrupt-size or unrecognized folders remain visible or untouched rather than being silently deleted. Show and restore additionally verify every content hash.

Every command accepts `--json`. Export always writes the raw JSON bundle, including with that flag.

| Exit | Meaning |
| --- | --- |
| 0 | Saved, exported, listed, shown, previewed or applied successfully. Read `records.action` because refused records do not prevent a configuration restore. |
| 1 | Operational failure, such as storage, missing backup or a refused source file. The JSON result carries the problem. |
| 2 | Invalid restore input, invalid parts, agent apply refusal or export above the stdout limit. |
| 3 | A stale restore preview; nothing was applied. |

The page contracts are in `src/shared/backup.ts`: `backupList`, `backupSave`, `backupExport`, `backupRestore`, `registryFile` and `registryExportFolder`. Too-large exports return `code: "too-large"`, actual `bytes` and `limit`, with no partial JSON. A save can succeed with a cleanup warning; read both `code` and `problem`.

## Daily script automation

This is a recipe for the user to run, not an automation Tavern installs. It uses bb's Automations plugin, records stdout and errors, and needs no model. Replace `PROJECT_ID` and choose the timezone you want.

```sh
bb automation create --project PROJECT_ID \
  --name "Daily Tavern backup" \
  --cron '0 3 * * *' --timezone UTC \
  --interpreter bash --timeout 5m \
  --working-directory automation-storage \
  --script 'set -euo pipefail; bb tavern backup save --with-data --json'
```

The script runs on the bb server, where Save writes the managed backup folder. Automations adds the discovered bb CLI to `PATH`; `BB_CLI` also identifies the selected executable when available. Add `--projects` to the inner command to include registered local project overrides. Check the first run with `bb automation runs AUTOMATION_ID --project PROJECT_ID` and inspect any failed run before relying on the schedule. No automation was created by this implementation.

For a dotfiles workflow that needs judgment, an agent automation can use this prompt. Supply an absolute repository path and a destination file. Creating that automation, writing to that repository and publishing anything remain the user's choices.

```text
Back up Tavern's configuration to the existing dotfiles repository at REPO_PATH.
Run `bb tavern backup export` without --with-data and require exit 0.
Validate that stdout is one tavern-backup/1 JSON document before replacing
DESTINATION_FILE inside that repository. Review the diff for private content.
Report the file and summary. Do not restore, commit, push or contact anyone.
If I later explicitly approve a commit, commit only the reviewed backup file
under my repository's commit rules. Do not push without separate approval.
User-authored notes can be private; never add --with-data unless I ask for it.
```
