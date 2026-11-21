# Draft pull requests from home

Configure a [forge profile](glossary.md#forge-profile) in **Settings → Where work runs** so Smiths running on separate machines can open draft pull requests from your home machine without needing forge credentials on the remote machine.

## Forge profiles

Forge profiles live under `machines.forges` (empty by default). Each profile has an `id`, `name`, `enabled` switch, and `kind`:

| Kind | Commands used | Supported actions |
| --- | --- | --- |
| `github` | Built-in `gh` CLI | Open draft, inspect state, mark ready, return to draft (`--undo`), request reviewers, comment, close |
| `command` | Custom `open` (required), optional `state` and `close` | Open draft, inspect state (when `state` set), close (when `close` set) |

Manage profiles only in **Settings → Where work runs** or by applying a reviewed setup proposal. `bb tavern settings set` refuses forge changes, and settings imports and backup restores preserve your existing profiles unchanged.

## Opening and recording drafts (`tavern_draft_pr`)

- **From-home placement:** The Smith commits its work and calls `tavern_draft_pr` with `title`, `body`, and optional `base`. Tavern carries the committed tree home without stopping the Smith, builds a single commit on top of the source base preserving the commit message and author, verifies the tree, pushes to the Smith's own assigned branch, and opens (or reuses) the draft PR.
  - First push is plain; later pushes use `--force-with-lease=refs/heads/<member-branch>:<last-pushed-sha>`. Tavern never pushes to the base or default branch.
  - Uncommitted files are excluded and listed in the tool result.
- **Member-machine or unplaced Smith:** Open the draft with your own tools as scope allows, then call `tavern_draft_pr` with `url`, `title`, optional `base`, and optional `forge` (`gh` or an enabled profile ID) to record it without pushing.

## Command profile contract

Commands run on the source host via `/bin/sh -c` in the source checkout with the bb host process environment (not a login shell), `GIT_OPTIONAL_LOCKS=0`, `GH_PROMPT_DISABLED=1`, and a 120-second timeout. Use absolute executable paths stored outside agent checkouts and thread storage.

| Operation | Stdin | Environment variables (also set with `LOOM_` prefix) | Expected stdout |
| --- | --- | --- | --- |
| `open` | PR description (`body`) | `FORGE_REMOTE`, `FORGE_BASE`, `FORGE_HEAD`, `FORGE_TITLE`, `FORGE_DRAFT=1` | Last `http://` or `https://` URL is recorded (new or existing PR for that head) |
| `state` | Empty | `FORGE_URL`, `FORGE_PR_NUMBER` (plus `FORGE_HEAD`, `FORGE_BASE`, `FORGE_HEAD_COMMIT` on inspect/close) | Last line starts with `open`, `draft`, `ready`, `merged`, or `closed` |
| `close` | Empty | `FORGE_URL`, `FORGE_PR_NUMBER`, `FORGE_HEAD`, `FORGE_BASE`, `FORGE_HEAD_COMMIT` | Exit 0 (confirmed via `state` if configured) |

Failures classify as **temporary** (network errors, HTTP 429, 500, 502, 503, 504), **lasting** (other nonzero exits or timeouts), or **broken contract** (exit 0 without a valid URL or state). Failed calls never auto-retry and leave the Smith working instead of blocking.

## Setup preflight

When an agent proposes a new or changed command profile via `bb tavern setup propose`:
1. Supply a single absolute executable path without arguments for each command; paths inside known environments, registered checkouts, or thread storage (including symlinks resolving there) are rejected.
2. On **Apply**, Tavern runs `<script> --help` (with empty `FORGE_*` values) before saving anything. Implement `--help` as a read-only exit 0 in your `open`, `state`, and `close` scripts—never treat empty variables as an instruction to open or close a PR.

## Recorded ownership and Keeper actions

Each project head branch keeps one PR record (`draft`, `ready`, `merged`, `closed`) storing its quest, URL, forge, head, base, owner, commits, and verification commit.

- **Releasing a Smith** transfers open PR ownership to its Keeper without closing the PR (undoing release does not transfer it back).
- **Keeper PR actions:** On verified quest PRs, the Keeper can mark ready, request reviewers, reply, or close (Undo returns ready to draft on GitHub). Tavern verifies the current head matches the Warden's verdict or a proven clean rebase before marking ready.
- **Closing a quest:** The Conclude and Close early cards list open PRs so you can keep them with the Keeper (default), take ownership, or close them through the recorded forge.
