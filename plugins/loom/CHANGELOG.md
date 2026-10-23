# Changelog

Notable changes to Loom, newest first. Releases are tagged `loom/vX.Y.Z` in this repository; releases before this file existed are described in their commit messages.

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
