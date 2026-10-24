# Changelog

Notable changes to Loom, newest first. Releases are tagged `loom/vX.Y.Z` in this repository; releases before this file existed are described in their commit messages.

## 0.16.0 (2026-10-23)

### Added

- A `commentSignature` setting, "Posted by Loom" by default. On the pull request strategy a worker posts from your account, so it now ends every comment and reply it posts on a pull request with this line. It takes Markdown, such as `<sub>Posted by Loom</sub>` for small text on GitHub, and an empty value turns it off. The fix-round message carries it, and so does the brief of a worker that resumes on an open pull request.

### Fixed

- The Spec tab's How it runs cards no longer overflow beside the review panel. The cards are laid out by the width of their own column instead of the whole page, use three columns only from 64rem, stack each label above its value when a card is narrow, and fill the gap a wide card leaves. A model name breaks after its slash instead of inside a word, and the slot squares wrap.
- The Planner tab's strip counts the questions the planner waits on, so one round of four questions reads "Waiting on you · 4 questions" instead of "1 question".

### Changed

- The README is reorganized and shorter: install and quick start first, the page by tab with screenshots, and one section for pull requests.

## 0.15.0 (2026-10-23)

### Added

- Stacked pull requests, on by default on the pull request strategy. A ticket starts once each ticket it depends on is done or has an open pull request with a commit Loom pushed, instead of waiting for it to merge. `merge.stack = false` in the spec turns this off.
- In the same repo, a ticket stacks on its dependency: its worktree starts from the dependency's pull request commit through the branch `loom/<slug>/<key>-stack`, its scope check, reviewers' diff and Changes tab count only its own changes, and its pull request opens on the dependency's branch with a line saying to merge that one first. Its scope may overlap the tickets it builds on.
- When a dependency's pull request gets a new commit, or merges, Loom brings each ticket stacked on it up to date: it merges the new commit, or the remote base branch, in that ticket's worker worktree, runs the ticket's checks and pushes, with no new review. After a merge it moves the pull request to the base branch with `gh pr edit --base`. A conflict or a failing check goes back to the worker with the branch to merge. An open pull request moves from `pr_open` to `merging` while it catches up.
- A ticket with two or more open dependencies in its repo starts on a merge of their commits, and its pull request waits after review until all but one have merged. Loom then merges the base branch into the one still open, so the new pull request does not show merged work as its own, and opens the ticket's pull request on it. Dependencies whose commits conflict with each other hold the start, with a post on the ticket.
- A dependency in another repo: its dependents start on its open pull request, the brief says how to read its files from that repo's checkout, each new commit on it is posted on the dependent ticket and sent to its worker while it works, and the dependent's pull request names it.
- The worker brief has a Dependencies section with each dependency's state, pull request and commit, and a stacked ticket's reviewer is told that the dependencies' changes in its worktree are not the ticket's.
- The board shows what a ticket is stacked on, and why an approved ticket's pull request waits.
- A `checksSettleMinutes` setting (30 by default): how long Loom waits for a pull request's pending checks after a push before it sends the failed ones to the worker.
- Host calls `stackBase`, which builds the commit a stacked ticket starts from or merges in with `git merge-tree`, and `prRetarget`. New ticket columns `stack_json` and `pr_base`.

## 0.14.0 (2026-10-23)

### Added

- The Spec tab is a new spec page in three sections, read in order: How it runs (the settings as cards), Tickets (a list by wave beside the picked ticket, a Map of the waves, and Files) and Goal & guardrails (the goal, non-goals, rubric, open questions and the raw TOML).
- A version that has one before it opens on only what changed: settings, tickets and parts that did not change are hidden or faded, a changed value says what it was, added items are outlined, removed ones struck through, a rewritten brief or goal shows word by word, and a removed ticket shows what it had. "The entire spec" and "View the entire spec" show everything. A pending version compares with the version in force, and "compared with" picks any older version.
- "What changed" lists every change by section, says which ones answer the comments you sent, and jumps to each one. A change you jumped to counts as seen, j and k step through the changes, and each section can be marked reviewed; all of it is kept in your browser.
- Comment on any part of the spec by clicking it. A choice, a number or a switch can also take a suggested value, which reaches the planner as TOML on a line of its own, and quick picks such as "Split it in two" or "Not testable" start the text. Comments collect in a numbered review panel with a note on the whole spec, a preview and one Send, and the panel offers Approve when there is nothing to send and the next-step bar does not carry it.
- `specVersion` returns the version it compares with, and takes a `base` version to compare with instead.
- The Planner tab is a page about the planner's work, with its chat one click away under Conversation. A strip says whether the planner is working and on what, waits on you or is idle, and before approval where planning stands. Needs you holds its questions, the steps it asked for and a version ready for you. What happened tells its work as steps in chapters, one per draft version and one for the running project, with filters and newest or oldest first. A side column has a box to message the planner, your answers, the spec versions and facts about it.
- The planner's Ask User Question rounds show one question at a time, with "Use the recommended answers for the rest" and a review before Send.
- `loom_ask_human`: the planner records what the human has to do, such as approve v4 and then requeue two tickets. The Planner tab lists the steps under Needs you with a button for each, checks a step off when the human takes it, and counts the steps left on its tab; Set aside hides them. The Planner tab also shows "?" while the planner waits on a question.
- Loom's spec review also checks a version the planner proposes after approval, as a change to the version in force, and approving it waits for the review the way a draft's approval does (`--skip-review` overrides it).
- The Spec page keeps a version's spec review after approval, pins each finding on its part as R1, R2… with Go to it, and marks the changes in "What changed" that answer an earlier version's findings.
- Loom keeps the planner's last words of each turn and the human's messages from the page, and records each triage round as a `triage.sent` event, for the Planner page. New RPC methods: `plannerView`, `messagePlanner` and `dismissAsk`; `specVersion` lists the spec reviews, and the project view counts the open asks.

### Changed

- A note to the planner may have no text when it suggests a value.
- A planning conversation that proposed opens as its project's Planner tab. The spec dashboard under the planner's chat is gone; the Spec tab reviews every version.

## 0.13.1 (2026-10-23)

### Fixed

- The ticket page's side column (acceptance criteria, files in scope, verify command and agents) no longer scrolls on its own, in either direction. It scrolls with the page and stays pinned beside the activity only while all of it fits in the window. Long words in the criteria wrap, and backticked text shows as code.

### Changed

- The ticket page is wider: up to 90rem instead of 72rem, with a side column of 20rem, or 24rem on a wide page, instead of 300px.
- Hide details folds the side column away so the activity takes the full width, and Show details brings it back. The page remembers the choice for every ticket.

## 0.13.0 (2026-10-23)

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
