# Draft pull requests from home

A machine rule chooses where its Smith opens pull requests. Existing rules default to the member’s machine. On Where work runs, choose a forge profile to open drafts from home instead. A rule that names a missing or disabled profile cannot be saved. Forge profiles are under `machines.forges`. The user writes their commands in Tavern’s Settings page, Where work runs, or by applying a setup proposal. CLI settings imports and every backup restore preserve the current profiles, skip imported profiles and report their IDs; CLI settings set refuses forge changes even without a thread ID.

A profile has an ID, name, enabled switch and kind. The GitHub kind uses `gh`. The command kind requires an `open` shell string and may have a `state` shell string. Keep your scripts outside the plugin installation. No profile is configured by default.

## The Smith’s tool

For a from-home placement, commit the work and call `tavern_draft_pr` with `title`, `body` and optional `base`. Tavern reads the committed head and carries its tree through the existing snapshot transport without stopping the member. At home it builds a single commit with the source base as parent and the member head’s message and author. It verifies the tree before pushing to the member’s own branch. The result names excluded uncommitted files and both commit IDs. This does not preserve the member’s history.

The first push is plain. Later pushes use `--force-with-lease=refs/heads/<member-branch>:<last-pushed-sha>`. Tavern never pushes to the base or another member’s branch. The push receipt is saved before opening the PR, so a failed open does not lose the lease. No command is automatically retried.

For a member-machine placement or an unplaced Smith, open the draft with your own tools as your scope permits. Then call `tavern_draft_pr` with `url`, `title` and optional `base` to record it without pushing. An optional `forge` is `gh` or an enabled profile ID. If omitted, the forge is unknown; Tavern never infers it from the URL.

## Command contract

Commands run on the source host through the native host entry, with `/bin/sh -c`, the source checkout as cwd, the bb host process’s environment (not a login shell) and a 120-second limit. Use absolute paths in scripts. Open receives the description on stdin and these variables:

| Neutral name | Compatibility name | Value |
| --- | --- | --- |
| `FORGE_REMOTE` | `LOOM_REMOTE` | Remote URL |
| `FORGE_BASE` | `LOOM_BASE` | Base branch |
| `FORGE_HEAD` | `LOOM_HEAD` | Member branch |
| `FORGE_TITLE` | `LOOM_TITLE` | Title |
| `FORGE_DRAFT` | `LOOM_DRAFT` | Always `1` |

Print the new draft’s URL, or the existing open PR for the head. Tavern takes the last HTTP or HTTPS URL on stdout. A configured state command receives `FORGE_URL` and `FORGE_PR_NUMBER`, with matching `LOOM_` names. The number is the URL’s last run of digits. Its last line begins with `open`, `merged` or `closed`; open drafts remain `draft` in Tavern. The state command is read at open in this slice; hand-back state refresh is deferred. There is no polling.

A network failure, HTTP 429 or HTTP 500, 502, 503 or 504 is temporary. Other nonzero exits and timeouts are lasting. Exit zero without the required URL or state is a broken contract. The result and quest event name the profile, classification and output tail. A failed call leaves the member working, not waiting on a blocker ask.

## Setup preflight

For a setup proposal, give one absolute executable path without arguments for each new or changed command. Before Apply, Tavern checks the path without running it. It rejects scripts inside known environments, registered project checkouts or agent thread storage, including symlinks that resolve there. The proposal saves the resolved path and checks it again before running. This is a tripwire, not a security boundary: agents run as you, and Tavern does not pin the script’s contents. Apply asks each script for `--help` with no other arguments. Implement that flag as a read-only exit before any normal operation, including for the state and close scripts. The built-in profile checks its CLI's help instead. The native worker uses the home forge call’s Git mode and environment, but has no actual member checkout or pull request yet. The probe runs in the registered checkout when available, otherwise its home directory, with empty values for the operation’s usual inputs. Never treat those as an instruction to open, inspect or close a pull request. If a check fails, no settings are saved.

Apply is yours to press. Tavern blocks agents it can recognise, but it can’t tell every agent’s call from your click. The receipt records that limit.

## Recorded ownership

Each project head branch has one PR record, with its quest, URL, forge, head, base, owner, member head, pushed head, verification commit and state. Reopening the same draft reuses the record. Every change records an event. Verification is null in this slice. The states are `draft`, `ready`, `merged` and `closed`; this slice does not expose ready, merge or close actions.

The hand-back and member card show the URL, state and owner. Releasing or archiving a Smith moves its open PRs to the Keeper without closing them. The PR record outlives the Smith. Undoing a release does not transfer ownership back; the Keeper remains responsible. Member-machine registration records the observed local head and leaves the pushed head unknown (`null`). Reuse matches the head branch and refuses a changed base. The same URL keeps its state. A new URL is a new pull request and resets the record to draft, with an event.
