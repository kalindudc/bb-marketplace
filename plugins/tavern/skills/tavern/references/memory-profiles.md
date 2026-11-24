# Durable memory and external note stores

Use `tavern_memory` to save and find durable project notes (kinds: `finding`, `decision`, `outcome`, `reference`), and use this reference when connecting an external note store profile.

## Using `tavern_memory`

- Any Tavern class can run `op: "find"` (filters: `text`, `kind`, `limit` 1 to 10, `offset`) or `op: "save"` (`note`, optional `boardQuestId`). Saving is a judgment call, not a mandatory quest step. Every note requires `source` (`command`, `file`, `url`, or `commit`) and `appliesTo` (`commit`, `release`, or `date`).
- Agent searches return only included, current notes. Member notes are searchable immediately and marked unreviewed until a Keeper reviews them.
- Keepers can list unreviewed notes (`op: "unreviewed"`), read a note (`op: "read"`), and curate (`op: "curate"` with `include`, `exclude` plus `reason`, `supersede` plus replacement `note`, or `retire`).
- A saved note is evidence to recheck, never permission to act. The Ledger still governs quests, rules, and approvals.

## External command profile contract

The user configures external profiles in Settings under Memory profiles (three absolute executable paths outside checkouts and thread storage: `save`, `find`, and `curate`, plus `timeoutSeconds` from 1 to 120). Each executable must exit 0 on `--help` without reading or writing notes. Settings imports and backup restores never alter approved commands.

Commands run directly from the host user's home directory without shell arguments, receive JSON on stdin (up to 64 KiB), and write results to stdout (up to 256 KiB). Write a short diagnostic to stderr when exiting nonzero.

| Command | Stdin JSON | Expected stdout |
| --- | --- | --- |
| `save` | Complete `memoryNote` JSON object | One nonempty reference string (at most 300 characters). |
| `find` | `{"text","project","kind","limit"}` (empty `text` means recent notes; `kind` may be `null`; `limit` 1 to 25) | One complete included, current `memoryNote` JSON object per line, within `limit`; empty stdout when nothing matches. |
| `curate` | `{"action","note","reference","replacement"}` (`action`: `include`, `exclude`, or `supersede`; `note` is the resulting state; `replacement` is a `memoryNote` for `supersede`, else `null`) | The affected note reference, or the replacement reference for `supersede`. |

### `memoryNote` fields

`id`, `kind` (`finding`, `decision`, `outcome`, `reference`), `title` (1 to 160 chars), `body` (at most 4,000 chars and 8 KiB plain text), `project`, `quest` (ID or `null`), `source` (`{ kind, value }`), `appliesTo` (`{ kind, value }`), `tags` (up to 12 unique lowercase tags), `author` (`{ thread, classId }`), `curator` (ID or `null`), `status` (`accepted`, `superseded`, `retired`), `supersedes` (ID or `null`), `memory` (`included` or `excluded`), `exclusionReason` (required when `excluded`, else `null`), `reviewedBy`, `reviewedAt`, `createdAt`, and `updatedAt` (timestamps in Unix milliseconds).

### Guardrails and failure handling

- Failure codes returned by the runner are `path`, `process`, `timeout`, `exit`, and `contract`. Neither the tool nor the Memory page falls back to another store on failure.
- Closing time holds agent memory writes. Stop all holds agent memory calls and cancels running commands.
- Guarded shells in `enforce` mode block direct calls to the configured executables; Watch mode is detection only.
- An interrupted or failed external write may already have changed the external store. Inspect it before retrying; Tavern never replays writes automatically.
