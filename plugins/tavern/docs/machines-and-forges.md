# Machines and forges

Use **Settings** under **Where work runs** to place newly hired party members onto dedicated machines through bb's providers and to open draft pull requests from your home machine without putting forge credentials on remote hosts. See [How Tavern works](design.md) for the architecture and term definitions.

Tavern has no machine provider of its own and uses whichever environment and machine providers bb exposes on your host.

## Machine placement rules

Enabled rules under `machines.rules` match in order against project IDs, repository remotes, Keeper path globs, Keeper environment providers, class IDs, and quest IDs.

- **Who moves:** Matching rules place newly hired Rangers, Smiths, Wardens, and Wanderers. Keepers stay where started unless a rule includes `keeper` or names no classes; child Keeper leads stay with their hiring Keeper unless it selects a matching enabled rule.
- **Supported target:** Only rules requesting a new machine with a dedicated checkout execute today. Other target shapes save, preview, and block hires with a reason.
- **Slot ceilings:** `machines.max_makers` and `machines.max_checkers` (default 2 each per Keeper) cap active remote machines. Waiting for a slot is a visible hold; Tavern never falls back to your local machine silently.
- **Cross-repo hires:** Hires into another registered project start from its pushed default-branch tip without local uncommitted changes. Wardens default to their maker's repository.
- **Guard posture:** Placed members run as **Detection only (remote)**. Scope updates show **Scope update pending** until the machine acknowledges them.

## Per-class model overrides

Each rule can override provider, model, and reasoning per class under **Models on these machines** (staged until **Save rule**; pick **Use the class's model** to clear an override). Tavern checks effective models before hiring and records first-turn model-resolution failures for that machine, environment, and provider so later hires refuse before allocating a machine until you clear the record on the rule card. Temporary provider overloads are not recorded, and Tavern never substitutes a fallback model silently.

## How source code travels

Tavern moves source code using porcelain Git on member machines and verified object assembly at home without touching your local working tree, index, `HEAD`, refs, branches, or stash.

1. **Hire capture (home to member):** For the Keeper's repo, Tavern captures the pushed base, unpushed commits, and changed tracked or untracked files via a temporary index, then carries that snapshot and scope into the member on startup.
2. **Submission capture (Smith to Warden):** Tavern waits for a placed Smith's turn to go idle without interrupting it, brings its committed and uncommitted work home under a private ref, and carries that exact tree into the Warden's separate machine. Verdicts count only while the Warden checkout is clean on that tree and the submission has not changed.
3. **Preservation before release:** Before releasing, closing, stopping, or archiving a placed member, Tavern saves its checkout state and declared file evidence home, then archives the thread so bb removes the machine. Failed saves keep the machine alive with **Retry**; machines that vanished outside Tavern record work as **not saved**.

Verified home imports are pinned under `refs/tavern/snapshots/<64-char-owner-hash>` (inspect with `git for-each-ref --format="%(refname) %(objectname)" refs/tavern/snapshots/`). Portable backups exclude private placement tables and host-local refs.

## Forge profiles and draft pull requests from home

Configure forge profiles in **Settings** under **Where work runs** (or by applying a reviewed setup proposal) so placed Smiths open draft pull requests from home without remote credentials:

| Kind | Commands | Supported actions |
| --- | --- | --- |
| `github` | Built-in `gh` CLI | Open draft, inspect state, mark ready, return to draft, request reviewers, comment, reply to review comments, resolve or reopen review threads, and close. |
| `command` | Custom `open` (required), optional `state` and `close` | Open draft, inspect state when `state` is set, and close when `close` is set. |

`bb tavern settings set` refuses forge edits, and imports and backup restores preserve existing profiles. Custom commands must be absolute executable paths outside agent checkouts and thread storage, and support read-only `--help` tested on **Apply**. For the script wire contract, see [`skills/tavern/references/forges.md`](../skills/tavern/references/forges.md).

For from-home placement, Tavern carries a Smith's committed tree home (reporting excluded uncommitted files), builds one commit preserving message and author, pushes to the Smith's assigned branch (never the base or default branch, using `--force-with-lease` on updates), and opens or reuses a draft pull request. Member-machine Smiths open drafts with their own tools and record the URL. For GitHub, Tavern checks that it is an open draft on the Smith’s assigned branch at its pushed head.

Releasing a Smith transfers open pull request ownership to its Keeper without closing it. The Keeper can manage the quest's own pull request without asking you about each edit, reviewer request, reply or resolution. `tavern_pull_request` takes the recorded pull request ID and checks that a reply or resolution belongs to it. Readiness and reviewer requests go through this tool, which checks the Warden's verdict against the head or a clean rebase. Unverified records and custom or enterprise forge URLs keep their previous shell permissions. The merge guard is unchanged. Closing a quest lets you keep (default), take over, or close each open pull request.
