# Changelog

Notable changes to Loom, newest first. Releases are tagged `loom/vX.Y.Z` in this repository; releases before this file existed are described in their commit messages.

## Unreleased

### Added

- The worker writes its pull request. On the pull request strategy, once the reviewers approve a ticket, Loom asks its worker for the pull request with the new `loom_pr` tool: its title, its description and the commit message, written the way the worker's own instructions and skills say. Loom opens the pull request with them. A worker that ends its turn twice without `loom_pr`, or takes more than 30 minutes, gets Loom's template instead; `merge.describe = "loom"` always uses the template.
- One commit per pull request. Loom pushes the reviewed work as a single commit with the worker's message, on the point where the ticket's branch left its base, instead of every submit and WIP commit. `merge.squash = false` pushes the branch as it is. Loom's commits follow the user's git config, so they are signed when `commit.gpgsign` is set.
- Loom follows the pull requests it opens. Every 5 minutes it reads the checks on the pull request's head, its reviews, its unresolved review threads and its comments, through `gh` or the new `feedback` command of a `kind = "command"` forge. Failed checks, reviews that request changes or comment with text, unresolved threads, and top-level comments from people go back to the ticket's worker as a fix round, each item once. Bots' top-level comments and anything from the pull request's author (the account a worker's replies come from) do not count. Failed checks wait until nothing else runs, or 30 minutes after the push.
- Fix rounds. A fix round takes the ticket from `pr_open` back to `working` (or to the queue when its worker is gone). The worker may answer review comments with the forge's CLI, but never pushes, merges, closes, approves or edits the pull request. Its fix passes the checks and a Loom review again, with the feedback in the reviewer's brief, and Loom pushes it as one more commit after checking that the pull request is still open. A fix round that changes nothing goes straight back to `pr_open`. A pull request that merged during the round completes the ticket, and a branch with commits Loom did not push goes back to the worker to merge them. After `merge.max_fix_rounds` rounds (5 by default; 0 follows only merged and closed) the ticket blocks and the pull request stays open.
- A human reply on a ticket whose pull request is open starts a fix round with that reply, while the project runs. A requeue of a ticket whose pull request stays open is a fix round on that pull request too.
- Only the rounds the pull request's own feedback starts count toward `merge.max_fix_rounds`; the human's replies and requeues do not, and a requeue starts the count again.
- The ticket page shows the pull request stage: the tracker's Pull request stage, a summary while the worker writes the pull request and while Loom follows it, facts for its number, the commits Loom pushed, its checks and the fix rounds used, a card with the worker's title, description and commit message, a card per fix round with the feedback it sent and what Loom did not count, a PR stage on each attempt, and a reply hint that says a reply starts a fix round.

### Changed

- The Board tab stacks a row per stage down the page instead of nine lanes side by side, so it no longer scrolls sideways. Blocked tickets come first under Needs you; In progress holds Working, Checking, Review and Shipping (approved, merging and open pull requests, each card with its state); Up next holds Ready and Waiting; and Done and Cancelled fold to one line each under Finished. A bar on top counts the tickets done, shipping, in progress, up next and blocked.
- A pull request closed without merging resets the ticket's pull request, so a requeue opens a new one with one commit.
- The push-only forge completes a ticket when the remote's base branch contains the commit Loom pushed.
- Pull requests opened before this version keep their branch: a fix round pushes one more commit to them.

## 0.12.0 (2026-10-23)

### Added

- A spec review before you approve a draft. When the planner saves a draft with `loom_propose`, Loom starts a separate reviewer agent on the spec's reviewer model. The reviewer reads the planning conversation, the spec and the code, and checks that the spec builds what you asked for and no more: no ticket the goal does not need, no speculative configuration or abstraction, nothing that rebuilds what the repository already has, and nothing missing. It approves with `loom_spec_approve`, or sends numbered findings to the planner with `loom_spec_request_changes`; the planner revises, and a fresh reviewer checks the new version.
- After three review rounds with findings, Loom stops reviewing the draft, and the planner hands it over with the findings it left open.
- `bb loom approve <slug> --skip-review` approves a draft whose spec review has not passed. The feed records the override.
- Loom works with versioning servers other than GitHub. It still opens pull requests with `gh` by default, and it knows no other server by name: each repository's server is set in the spec.
  - `[merge.forge]` sets how pull requests open. `kind = "command"` takes an `open` command and a `state` command for that server's own CLI, plus optional `after_open` commands, such as one that starts CI. `kind = "none"` only pushes the branch; the ticket is done when the remote's base branch contains its commit. That check misses squash and rebase merges, which have to be closed by hand.
  - `[environment]` starts the threads Loom runs in a repository (workers, reviewers, the spec reviewer and the summary agent) in any bb environment provider, such as one a plugin adds, with inputs in which Loom fills `{branch}` and `{base}` for each thread.
  - `[merge.worktree]` prepares the integration worktree with a shell command, or with a plugin's CLI command (`plugin = "<id>"`), for repositories whose git refuses worktrees outside their own location.
  - A `[[repo]]` table can set its own `forge`, `environment` and `worktree`.
- The `loom_discover` agent tool reports, for each repository, its git remotes, whether `gh` can open pull requests where it pushes, the environment providers bb offers for it on this machine, and whether Loom can add its own integration worktree. Each choice comes back as found or ask.
- The planner skill has a new step that calls `loom_discover` and asks the human every open question in one round.

### Changed

- `bb loom approve` and the Loom page refuse a draft whose spec review is still running, has open findings or did not finish. The next-step bar says what the review is doing, and the home page's Needs you list shows the draft once the review passes or stops.
- The `loom-plan` skill tells the planner to build only what the goal needs and to hand a draft over only after its spec review passes.
- Every human-only `bb loom` command refuses a spec reviewer thread, as it already refuses Loom's other agents.
- `loom_propose` refuses a spec that leaves one of the choices `loom_discover` reports unmade. It refuses a remote the repository does not have, a `gh` forge where `gh` is not signed in, no environment while a plugin offers one, inputs that do not match the provider's schema, and the integration strategy where git refuses Loom's own worktree. Each error names the key to set.
- After approval, a repository's forge kind, and whether it has a `worktree`, can no longer change.
- Specs without the new keys parse, hash and run exactly as before.
- Runs list the pull-request step as "open the pull request" instead of "gh pr create".
