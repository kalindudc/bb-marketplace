# Durable memory

Use **The tavern → Memory** to find decisions, verified findings, outcomes and references from earlier work. Choose a project, then search by text, kind or status. Built-in memory works without setup.

## Save, review and find

| Who | What they do |
| --- | --- |
| Any Tavern class | Find notes for its project or save one with `tavern_memory`. A note names its evidence and when it applies. Saving is a judgment call, not a step every quest must take. |
| Keeper | Review notes shown in the ledger. Keep a useful note, exclude it with a reason, or replace it with a superseding note. Member notes are searchable before review and marked **Unreviewed**. |
| You | Open a built-in note to edit its title or body, exclude it, re-include it, supersede it or retire it. Excluded, superseded and retired notes stay in history. Choose **Excluded from memory** to see excluded notes. |

Agent searches return only included, current notes. Built-in search matches all words in any order and returns a next offset when more results match. A saved note is evidence to check, never permission to act. The ledger still governs quests, rules and approvals. Data backups include built-in notes; they do not install external profiles or move notes between stores.

## Connect another note store

1. Put three trusted executables on bb's primary host outside project checkouts and thread storage. Each must exit successfully on `--help` without reading or writing notes.
2. In **Settings → Memory profiles**, add a profile. For example: ID `field-notes`, name `Field notes`, paths `/opt/notes/save`, `/opt/notes/find` and `/opt/notes/curate`, timeout 15 seconds per command.
3. Choose the profile as **Active store** and save. Tavern checks the paths and probes help before approving the commands. Set **Built-in** to switch back; notes stay where they were saved. Settings imports and restores cannot change the approved commands.

Commands run directly from the host user's home directory, with no shell arguments. They receive JSON on stdin and return results on stdout. Send a short, safe diagnostic on stderr when exiting nonzero.

| Command | Input | Output |
| --- | --- | --- |
| Save | A complete note | One nonempty reference (at most 300 characters) |
| Find | `{ text, project, kind, limit }`. Empty text means recent notes; `kind` can be null. | One complete included, current note per line, within `limit`. No matches means empty stdout. |
| Curate | `{ action, note, reference, replacement }`. `note` describes the resulting state of the existing note; `replacement` is present for `supersede`, otherwise null. | The affected note's reference, or the replacement reference for `supersede`. Support `include`, `exclude` and `supersede`. |

The shared `memoryNote` schema defines the wire format. A note contains `id`, `kind`, `title`, `body`, `project`, `quest`, `source`, `appliesTo`, `tags`, `author`, `curator`, `status`, `supersedes`, `memory`, `exclusionReason`, `reviewedBy`, `reviewedAt`, `createdAt` and `updatedAt`. `source` and `appliesTo` are `{ kind, value }`; times are Unix milliseconds. `author` is `{ thread, classId }`. Status is `accepted`, `superseded` or `retired`; memory is `included` or `excluded`.

For an external store, the Memory page shows fresh search results and separately labels previous exclusions or replacements recorded by Tavern. Re-including a note recorded by Tavern uses the profile; edit or retire external notes in the external tool. Neither the tool nor the Memory page can use a different store when a command fails.

Closing time holds agent writes, not your own Memory and Settings controls. **Stop all** holds agent memory calls and cancels running commands. Guarded shells refuse direct calls to the configured executables in Enforce mode; Watch remains detection only. This does not block other routes to the same store or turn scripts into a sandbox. Tavern records the operation and outcome without putting note bodies or queries in the ledger. An interrupted or failed external write may already have changed the store. Inspect it before retrying; Tavern never retries or replays writes for you.
