# Journal actions, evidence, and limits

Use this reference for the full `journal` tool action table, evidence schema, rejection re-proof rule, size limits, and undo/redo gates.

## Action reference

| Action | Parameters | Behavior |
| --- | --- | --- |
| `add` | `description` or `descriptions[]`, optional `owner` | Add top-level entries in one atomic action. Set `owner` to the delegate's thread id (`thr_…`) for work another agent does. |
| `split`, `add_step` | `id`, `descriptions[]`, optional `owner` | Add steps under an open top-level entry. Returns their ids on a `New ids:` line. |
| `list` | optional `filter: open, mine, blocked` | Read all entries or a filtered view. |
| `get` | `id` | Read one entry with notes and evidence. A Keeper can target another thread with `threadId` for linked entries on its own quests. |
| `start` | `id` or `ids[]`, optional `owner` | Set doing. To hand several entries to the same delegate at once, pass `ids` and the delegate's thread id as `owner`. Start your own work one entry at a time: your other unowned doing entry returns to todo. Delegated entries with an owner stay doing side by side. Dependencies must be complete. |
| `done` | `id` or `ids[]`, optional `evidence[]` | Set done idempotently. Linked entries REQUIRE evidence and are reported done, not yet verified. Unlinked entries can finish without evidence; attach proof when available. |
| `block` | `id` or `ids[]`, `reason` | Set blocked and record why. |
| `reopen` | `id` or `ids[]` | Set todo idempotently. A completed parent reopens too. Reopening verified work needs the assigned Warden or the Keeper. To reopen Keeper-accepted or skipped work, give one `id`, `threadId` if needed, and a `reason`. |
| `toggle` | `id` or `ids[]` | Compatibility action: open becomes done, done or verified becomes todo. Unlike `done`, repeating it flips again. |
| `verify` | `id`, optional `threadId`, `evidence[]` for a Warden or `reason` for a Keeper | The Keeper can accept a done entry when the plan calls for a Keeper check. An active Warden on the same quest can verify another maker's done entry awaiting review, without a checker slot for that waypoint. A new verdict cannot overwrite an existing verification. Include your own evidence. Same-family checks refuse; unknown independence is labelled. Machine-placed work needs a Warden with its pinned snapshot. Placed Wardens can only check their pinned targets. |
| `reject` | `id`, `reason`, optional `threadId` | The same Warden rules apply to rejection of a submitted entry. The journal preserves the previous note, records the reason, and notifies the owner. `start` or `done` moves the entry on. |
| `update` | `id`, `description`, optional `owner`, `after[]`, `links[]` | Update text, ownership, dependencies, or artifact links. Dependencies cannot cycle. Changing verified work reopens it, so it requires the assigned Warden or the Keeper. |
| `note` | `id`, `note` or `null`, optional `mode: replace` | Add a timed line to the entry's running note (keeps the newest 2,000 characters). Use it for progress, decisions, and follow-ups. `replace` rewrites the whole note; `null` clears it. |
| `settle` | `id` or `ids[]`, optional `reason`, `evidence[]` | Record that a delegate reported (for example its "SOURCE SETTLED" message). The entry stays doing and shows as awaiting your check, with the reason quoted. Then close it with `done` or `reopen` it. |
| `wait` | `id` or `ids[]` | Clear a delegate's mark without closing anything when its message was an acknowledgement or a question. |
| `link` | `id`, `link: {boardQuestId, waypointId}` or `null` | An active member can link an unlinked entry of their own to an assigned waypoint on their quest. Only the Keeper or Tavern can change or remove the link. A link cannot change staffing or scope. Artifact references go in `links` or `evidence`. |
| `skip` | `id` and optional `threadId`, or `link` when no entry exists; `reason` | The Keeper can skip unfinished optional waypoint work. A skip closes work without verifying it. |
| `delete` | `id` or `ids[]` | Remove entries and their steps. Include all open steps explicitly or complete them first. Only the Keeper or Tavern can delete a linked entry in any status. |
| `clear` | optional `all: true` | Remove completed entries; `all` also removes open entries. Linked entries in any status and their required parents stay unless the Keeper or Tavern clears them. Active board mirrors stay; terminal board mirrors may be cleared. |
| `reorder` | `id`, `targetId` (`null` for last) | Move an entry before a sibling, including steps. |
| `reparent` | `id`, optional `parentId` | Move a childless entry under an open top-level parent, or promote a step when `parentId` is omitted. |
| `undo`, `redo` | none | Reverse or replay one whole action, including batch `add` and `split`. User and agent share the latest 50 actions. New changes clear redo. Restoring verification needs an eligible Warden; demoting verified work needs an eligible Warden or the Keeper. Link changes and deletion through history keep the same Keeper-only gates. |
| `rules`, `skill` | none | Return the journal guide. |

## Evidence format and post-rejection rule

Evidence items have `kind` (`command`, `file`, `url`, `pr`, `query`, or `note`), `ref`, optional `detail`, and optional `exitCode`. Record what you observed, never what you expected:

```json
{"action":"done","id":"00","evidence":[{"kind":"command","ref":"npm test","detail":"12 tests passed","exitCode":0}]}
```

After a Warden rejection, submit fresh evidence checked since that rejection before marking the journal entry done again. Evidence attached before the rejection does not satisfy this gate, even after `start`, `reopen`, or `undo`. Submitting fresh proof with `start` also counts; never claim to have rerun a check you did not run.

For a planned Warden check, a submitted entry stays reported until an eligible Warden verifies it. Never claim verification on the Warden's behalf.

## Limits and IDs

- Each entry holds at most 30 member evidence items, plus up to 30 separate Warden review evidence items with reviewer and timestamp.
- Each `ref` and `detail` holds at most 2,000 characters; descriptions hold at most 500 characters; active journals hold at most 200 entries. Legacy overflow and full over-long descriptions stay preserved in the import archive.
- IDs are never reused, even after `delete` and `undo`. New IDs are two-digit lowercase hex through `ff`, then grow to three or more characters; imported hex and previously issued base36 IDs keep their spelling.
