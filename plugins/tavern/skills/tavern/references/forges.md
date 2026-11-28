# Forges and draft pull requests

Use this reference when opening or recording draft pull requests as a Smith or configuring custom forge profiles under `machines.forges`.

## Smith `tavern_draft_pr` workflow

- **From-home placement:** Commit your work and call `tavern_draft_pr` with `title`, `body`, and optional `base`. Tavern carries only the committed tree home without stopping your turn, builds a single commit on top of the source base preserving the commit message and author, verifies the tree, pushes to your assigned branch (plain on the first push, `--force-with-lease=refs/heads/<member-branch>:<last-pushed-sha>` on updates, never to the base or default branch), and opens or reuses a draft pull request. It never marks ready or merges. Read the result for excluded uncommitted files and the pushed commit.
- **Member-machine or unplaced Smith:** Open a draft pull request with your own tools as scope allows, then call `tavern_draft_pr` with `url`, `title`, optional `base`, and optional `forge` (`gh` or an enabled profile ID; omit to record unknown). This records the pull request without pushing. Reuse the same pull request for the same head branch.
- **Ownership on release:** Releasing a Smith hands open pull request ownership to its Keeper without closing the pull request; undoing release does not transfer it back.

Keepers use [`tavern_pull_request`](../../tavern-keeper/references/asks-and-merges.md#merge-approvals) with the recorded ID for readiness or reviewer requests on the quest’s own pull request, after the Warden checks the current head or a clean rebase. This does not authorize merging.

## Forge profiles and authority

Forge profiles live under `machines.forges` (`id`, `name`, `enabled`, `kind`: `github` or `command`). The user configures profiles in Settings under Where work runs or by applying a reviewed setup proposal. Tavern-managed threads MUST NOT change forge profiles directly, and `bb tavern settings set`, TOML imports, and backup restores leave existing profiles unchanged.

## Custom command profile contract

Commands run on the source host via `/bin/sh -c` in the source checkout with the bb host process environment (not a login shell), `GIT_OPTIONAL_LOCKS=0`, `GH_PROMPT_DISABLED=1`, and a 120-second timeout. Use single absolute executable paths without arguments stored outside agent checkouts and thread storage.

| Operation | Stdin | Environment variables (also mirrored with `LOOM_` prefix) | Expected stdout |
| --- | --- | --- | --- |
| `open` | Pull request description (`body`) | `FORGE_REMOTE`, `FORGE_BASE`, `FORGE_HEAD`, `FORGE_TITLE`, `FORGE_DRAFT=1` | Last `http://` or `https://` URL is recorded (new or existing pull request for that head). |
| `state` | Empty | `FORGE_URL`, `FORGE_PR_NUMBER` (plus `FORGE_HEAD`, `FORGE_BASE`, `FORGE_HEAD_COMMIT` on inspect and close) | Last line starts with `open`, `draft`, `ready`, `merged`, or `closed`. |
| `close` | Empty | `FORGE_URL`, `FORGE_PR_NUMBER`, `FORGE_HEAD`, `FORGE_BASE`, `FORGE_HEAD_COMMIT` | Exit 0 (confirmed via `state` when configured). |

Failures classify as temporary (network errors or HTTP 429, 500, 502, 503, 504), lasting (other nonzero exits or timeouts), or broken contract (exit 0 without a valid URL or state). Failed calls never auto-retry and leave the Smith working.

## Setup preflight (`--help`)

When the user applies a setup proposal adding or changing a `command` profile, Tavern runs `<script> --help` with empty `FORGE_*` variables before saving. Implement `--help` as a read-only exit 0 in `open`, `state`, and `close`, and never treat empty environment variables as an instruction to open or close a pull request.
