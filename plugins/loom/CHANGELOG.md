# Changelog

Notable changes to Loom, newest first. Releases are tagged `loom/vX.Y.Z` in this repository; releases before this file existed are described in their commit messages.

## 0.21.0 (2026-10-26)

### Added

- While the Loom page is open, bb's sidebar lists Loom instead of your threads: Home with how many things need you, the planning conversations (marked while the planner asks you something), every project with its count of what needs you, the open project's tickets that are moving or stuck with blocked ones first, done and archived projects folded away, How Loom works and New project.
- bb's title bar names the page, such as `Loom / CSV export › CSV-3` or `Loom / Planning › Search revamp`, with the project linking back to it, and the window title follows. Loom's own breadcrumb row under the title bar is gone.
- A Loom worker, reviewer or planner thread's Info tab has a Loom row: its ticket, project or planning conversation, the state and the thread's role, with a link to the page. Unlike the header chip, it shows on phones too.
- Project controls and ticket actions say in bb's toast what they did, such as "Project started", "Approved v2" or "CSV-2 requeued". The toasts stay in bb's notification center. A change Loom refuses shows in bb's own error toast with Loom's reason, as every failed change in bb does; a reply, a message to the planner, spec comments and New project also keep their errors beside the text you wrote.

### Changed

- On the Insights tab, the "half" and "most" labels under "How long does a ticket take?" no longer overlap when the two times are close.
- The badge on Loom's rail icon is bb's own. It is amber, red while a ticket is blocked, and its label is in the icon's tooltip. It updates as soon as something changes, instead of every 15 seconds, and reads "waiting on you" from bb's live thread state, so the server no longer asks bb about each Loom thread.
- The page reads through bb's query cache. Each view refreshes when a change to its project lands, as before, and also catches up by itself after bb reconnects, which it did not do before. A view seen before reopens at once. A page you cannot see stops reading. A read that drops on the network is tried again. After a change, the page reads its project again instead of showing what the change returned.
- A refusal, such as an unknown project or a control that does not fit the project's state, reaches the page as a refusal with its message. bb no longer records it as a plugin error.
- Every git and `gh` process Loom starts waits for a turn in bb's VCS scheduler, which caps how many run at once on the machine: at most two `gh` and a few git processes for Loom's background work, with the Changes tab's reads first. Check commands and forge shell commands do not wait.
- bb sends a quick local git read (`worktreeState`, `diff`, `changedFiles`, `filePatch` and `remotes`) to the machine again when its answer is lost. Fetches, writes and pull request reads are never sent twice, so a slow GitHub read still gets its full 150 seconds.

### Removed

- The `GET /badge` route and the script that drew the rail count into bb's DOM. Nothing else read them.
- The `loom:changed` realtime message. The page now refreshes through bb's query tags `project:<slug>` and `loom`.

### Compatibility

- Loom now needs bb 0.47 and plugin SDK 0.6.79.

## 0.20.2 (2026-10-26)

### Fixed

- A network or name lookup failure no longer pauses a project. When Loom's read of an open pull request cannot reach the forge, because the host's name did not resolve, no connection opened, or gh says it could not connect, Loom reads no pull request on that host, in any project, for 5 minutes, then 10, 20 and 30 while the failures go on. One failed call counts once, however many pull requests it asked for, so a machine whose resolver keeps losing names costs one failed read per wait instead of one per pull request. Loom never reads again to retry; it only waits longer between the reads it already makes. The first ticket whose read failed gets one post, the ticket page's next check time shows the wait, and the first read to that host that works clears it. The project pauses only after an hour of failed reads to the host with none working in between, with a reason that names the host, the error and how long it lasted.
- A command forge's `state` and `feedback` commands now get the same waits as `gh`. When one fails or times out, Loom reads its output by the rules it uses for gh's errors. A network failure waits as above, for the pull request URL's host only, so a Delta failure stops reads to delta.shopify.io while GitHub keeps being read. A server error or a timeout makes that pull request's next read wait 5, 10, 20, then 30 minutes, as a GitHub server error does, and a rate limit stops reads to the host for 15 minutes or more. A command that fails for any other reason, such as a missing login or a pull request the forge cannot find, still pauses the project, and so does one that succeeds but prints no state or no feedback object, since that is a bug in the command. The posts and pause reasons name the forge's host instead of GitHub.

### Changed

- A connection that timed out ("connection timed out" or "i/o timeout") now counts as a network failure, which waits for the whole host, instead of a server error, which waited for each pull request on its own.

## 0.20.1 (2026-10-26)

### Fixed

- A version that waits for your approval now shows its summary where you approve it. The About strip shows the summary it writes, or the one it changes to, with Review vN, instead of saying the spec has no summary; the home list shows it too. On the Spec tab, the Goal card labels the summary, marks one the version adds as new and shows a rewritten one as a word diff, as it does the goal. The Planner tab's card for the version quotes its summary when the version writes or changes it, and always for a draft.

## 0.20.0 (2026-10-26)

### Added

- A Merge order tab on pull request projects: the order to merge the pull requests in, step by step, with each one's checks, draft flag, review decision, what still holds it, what it waits on and what it unblocks. By repo lays them out by repo and step, with a line for each stack and wait. Its badge counts the pull requests with nothing before them, or turns red for one that merged into another ticket's branch. It warns about a stacked pull request the forge shows approved while its parent is still open, since merging it would put it into the parent's branch instead of the base.
- Every spec needs `project.summary`, one or two sentences on what the project changes and why, and may list `project.done_when`. An About strip under the project's header shows them with the issues and pull requests the goal links to, Full goal and the planner's thread, and the home list shows each summary under the project's name. The spec reviewer checks that the summary says what the project is for.
- A command forge's `feedback` JSON may give `draft`, `review` and `base`. Loom keeps them as it does GitHub's, for the Merge order tab and the wrong-branch check.
- A ticket takes `merge_after`, the refs of the tickets whose pull requests merge before its own (`loom_add_tickets` and `loom_edit_ticket` take keys too), without holding its start or stacking it. The pull request's description names them, and a patch of `merge_after` alone changes a ticket whose pull request is open.

### Changed

- A pull request that merged into a branch other than its repo's base, such as a stacked one merged into its parent's branch, blocks its ticket with the branch's name, and the ticket whose branch it is, instead of counting the work as done. This holds for a merge Loom finds when it polls and for one it finds before it pushes a fix round.
- Loom reads the open pull requests of each GitHub repository in one GraphQL call per 10 pull requests, instead of one call each, and keeps each one's draft flag, review decision and base branch.

### Fixed

- A pull request read through a forge's `feedback` command no longer stops after 30 seconds and pauses the project. It gets the 150 seconds the `state` command and other network calls already had, over the command's own 2-minute limit; a slow Delta read paused a project this way.

### Compatibility

- A spec stored before `project.summary` existed still loads, runs and revises: the project page shows its goal's first paragraph in the summary's place, and only its next proposed revision must add a summary. Its hash is unchanged.
## 0.19.1 (2026-10-26)

### Fixed

- One GitHub server error no longer pauses a project. When GitHub answers Loom's read of an open pull request with HTTP 500, 502, 503 or 504, times out or drops the connection, Loom waits longer before that pull request's next read (5, 10, 20, then 30 minutes) instead of pausing. The ticket gets one post when the failures start, the ticket page's next check time shows the wait, and the first read that works clears it. The project pauses only after an hour of failed reads, with a reason that names the pull request, the error and how long it lasted.
- A GitHub rate limit no longer pauses a project either. Loom stops reading pull requests on that GitHub host, in every project, for 15 minutes, doubling to an hour while the limits go on, and longer when GitHub names a later time. The ticket whose read was limited gets one post per backoff. Any other failed read, such as a missing `gh` login or a pull request GitHub cannot find, still pauses the project as before.

### Changed

- Following a pull request through `gh` asks GitHub for less. The query no longer asks for the steps of every check run, which on a pull request with many checks (88 on one) took 6 to 11 seconds, long enough for GitHub to time out and answer 502. Loom now asks for steps only while a check has failed and others are still running, in a second small query for at most 20 running check runs, because it uses them only to tell how far a running check got. When that second query fails, Loom carries on without the steps. Loom still reads each pull request once per poll and never repeats a failed read within it.

## 0.19.0 (2026-10-25)

### Added

- On the pull request strategy, an idle worker whose ticket's pull request is open no longer holds its environment. Once it has nothing in flight and its worktree holds exactly the reviewed commit, Loom archives its thread and bb frees the environment; the worker stays the ticket's worker. A fix round, your reply on the ticket or a stacked catch-up unarchives the same thread and has bb restore its environment on the worker's branch, so the worker keeps its whole conversation; the fix round's message says that files git ignores must be set up again. When bb cannot restore it, a new worker takes over from the branch, and its brief names the earlier workers' threads. `merge.release_workers = false` keeps every worker until its pull request merges, as before, and a spec version approved later may change it either way.
- `[environment]` and a repo's `environment` take a `reviewer` table: another provider for reviewers, the spec reviewer and the summary agent, or a merge patch over the inputs for the same provider, so the threads that only read can use a lighter environment. In a provider's environment the reviewer brief says how to read any file at the ticket's commit with `git show`.
- A ticket takes `environment = { inputs = { … } }`, a merge patch over its repo's environment inputs for its workers and reviewers, so it can ask for only what it touches. `loom_add_tickets` and `loom_edit_ticket` take it too, and `loom_propose` checks each ticket's patched inputs against the provider's schema.
- The board card and the ticket page say when a ticket waits to start its worker or a reviewer again, why, and when Loom tries.
- On a multi-repo project, a reviewer's brief lists the other repos with their checkout paths, as a worker's brief does.

### Changed

- A failed start no longer burns attempts within seconds. When the environment provider's availability check answers `unavailable`, or bb marks the error retryable, Loom waits and tries again (after 1 minute, doubling to every 15 minutes) and counts no attempt; after an hour of it the ticket blocks, with a reason that names the provider's unavailability, so triage hears of it, and approving a pending version requeues it. Any other failed start, a provisioning failure included, waits the same way and counts against `budget.max_attempts` only from the fourth failure in a row. A start bb refuses with a client error still blocks at once, and one Loom could not build counts at once.
- A retried start keeps its attempt number, thread row and claim, so its retry asks the provider for the same `{branch}` and the ticket thread gets one post per reason instead of one per try.
- A reviewer that could not start waits and tries again too, and counts as one that ended without a verdict only from the fourth failure in a row. The spec reviewer waits the same way, is retried by the engine, and fails after the fourth; proposing again tries at once. The summary agent tries again for up to 30 minutes before the full record goes to the done hook.
- A failed start keeps the ticket's branch, unless bb could not find it and no pull request is open. A ticket whose pull request is open always keeps it, so a new worker no longer starts from the base without the pull request's work.
- The post for a provisioning failure gives the provider's own message instead of "Provisioning thread failed".

## 0.18.0 (2026-10-24)

### Added

- An Insights tab takes the place of the Feed and Metrics tabs. It leads with how the project went: a headline, a few plain sentences whose links show the problems or your own actions, and four figures (running time, how long a typical ticket takes, how many passed their first review, and tokens).
- Insights draws when the work happened: a bar per stretch of time for the tickets shipped, sent back and blocked, the tickets in flight behind them, your actions and milestones above, paused stretches hatched and quiet stretches folded. Hovering reads a bar; a click or a drag across bars, or the arrow keys and Enter, shows only that stretch, and Whole project, Latest run and Last 24 hours pick one too. Every part of the tab follows the stretch, apart from tokens.
- What happened tells the story by run and pause, newest or oldest first, with one entry per ticket in each that says what happened to it there, a bar of its time in each state and its steps one click away. Right now lists the blocked tickets, open pull requests and tickets a pause holds. Problems, You and Every event filter it, and a search box finds a ticket or a word. An action that wrote several events, such as a verdict and the move it caused, reads as one line. Unlike the Feed, it covers every event, not the newest 200.
- In numbers: how long a ticket takes, with a dot per ticket that finds its story; where its time goes, with one sentence on why; how often the first try is right; what it cost; when you stepped in; what went wrong; and the checks by command.
- On the pull request strategy, Insights times a ticket to its pull request opening and counts the time the pull request then waits on people separately. This is only how Insights measures; scheduling, stacking and merging are unchanged, and `bb loom metrics` still times tickets to done.
- An `insights` RPC returns the tab for a project, a window (`all`, `run`, `day` or a `from` and `to` time) and an optional rewound event.

### Changed

- The Timeline is redesigned to be calmer and easier to read. It sits in a dashed frame under the health strip, which turns orange while the page is rewound. Collapsed, it is one row: a Play button, a strip of how much happened when on a labelled time axis, with red dots where tickets blocked or were sent back and rings for your own actions, and whether the page is live. Hovering shows what happened at a moment before anything rewinds, and the time after the playhead fades while rewound.
- The Timeline steps through moments instead of raw events: each one changes the board, the header or the health strip, events less than 2 seconds apart read as one, and each has the sentence `bb loom feed` writes for it, with your own actions written as "You ran …". Posts and edits are no longer steps.
- Open, the Timeline has one row per ticket instead of packed rows, on the same time axis as the strip: its time in each state, where it was sent back, a check when it was done, its state at the playhead, and how long it took; a ticket's name opens it. Agents shows each ticket's sessions on its row, and Only trouble is a switch. Esc returns to now and Home goes to the first moment.
- Quiet stretches fold to a dotted gap instead of a band marked "≈", and the axis labels the time work resumed after a fold of an hour or more.

### Removed

- The Feed and Metrics tabs, with the Metrics tab's cumulative flow chart and its 7, 14 or 30 day window, and the `feed` and `metrics` RPCs that only they read. `bb loom feed` and `bb loom metrics` (with `--days`) are unchanged.
- The Timeline's stacked chart of ticket states, its zoom choice (whole project, 2 hours or 30 minutes), its First event and Now buttons, and its diamond markers. The `timeline` RPC no longer returns `flow` or `marks`; it returns `moments`, `state` and `ticketCount`, and each ticket bar carries `sentBack` and `final`.

## 0.17.0 (2026-10-24)

### Added

- On the pull request strategy, once Loom pushes a fix round, it asks the people whose reviews and review threads the fix answered to review the pull request again, as GitHub's Re-request review button does. It asks only people, not bots, and not those who only left a top-level comment; a round of failed checks alone, or the human's reply on the ticket, asks no one. A post on the ticket names who was asked, and anyone Loom could not ask with GitHub's reason; the fix stays pushed either way. This goes through `gh` only, with a new host operation that calls GitHub's request reviewers endpoint once for each person.

## 0.16.1 (2026-10-23)

### Changed

- On the pull request strategy, failed checks no longer wait for every pending check. A check still queued 5 minutes after Loom first saw it, or after the push, stops holding them back, so the worker starts on them sooner. A running check holds them only while it is at least 75% along, by the forge's own progress, its time so far against the median of its last 5 passed runs on the same forge repository, or its GitHub Actions job's finished steps; one running for more than twice its usual time stops holding. A check Loom cannot measure, and every commit status, holds until `checksSettleMinutes` after the push, as before.
- The fix round's message and its post on the ticket list the pending checks Loom did not wait for, and why.

### Added

- Settings `checksQueuedMinutes` (5 by default; 0 waits for queued checks) and `checksNearDonePercent` (75 by default; 0 waits for every running check), and the spec keys `merge.checks_queued_minutes` and `merge.checks_near_done_percent`, which override them for one project. The Spec tab shows the spec keys when they are set.
- A command forge's `feedback` output may give each check `started`, `started_at`, `completed_at` and `progress`. Through `gh`, Loom reads each check run's status, start and end times and job steps.
- A `check_durations` table that keeps how long each passed check took, by forge repository, the newest 20 runs of each check.

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
