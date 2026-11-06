# Changelog

Notable changes to Loom, newest first. Releases are tagged `loom/vX.Y.Z` in this repository; releases before this file existed are described in their commit messages.

## Unreleased

### Added

- A `loom-pr-description` skill ships with Loom, and every worker and reviewer gets it. It says how to write a pull request's title and description for a human reviewer who has never seen Loom: a Summary with Why and What, Review guidance, Changed files, Technical details and Notes for reviewers, readable in under five minutes. Other changes are named by their pull request link and title, never by a ticket key or ref; Loom's vocabulary (planner, worker, round, brief, triage, "the ticket", "the human", acceptance criterion numbers) and the agent's sandbox stay out, and testing says what ran and what CI covers. Loom adds its own merge and deploy section, so the worker writes none.
- `[[ticket]] keep_draft = true` keeps that ticket's pull request a draft until the human releases it, with Release draft on the ticket page, its board card or the Planner page, or `bb loom release <slug> --ticket <KEY>`, which marks it ready for review. The board card, the ticket page and the Merge order tab show it as "Held as a draft: you release it", and its merge waits. The planner's new `loom_release_draft` only asks the human to release one. Its pull request opens as a draft even with `merge.draft = false`. `loom_edit_ticket` can set `keep_draft` at any time, but clear it only before the pull request exists; after that only the human's release, or a spec version they approve, lets it go.
- A command forge's new `ready` command marks a draft pull request ready for review (`LOOM_URL`, `LOOM_PR_NUMBER`); `gh` does it with `gh pr ready`.

### Changed

- Loom marks every pull request that its ticket does not hold ready for review. With `merge.draft = true`, the default, a pull request opened as a draft used to stay one until an `after_open` command or a person marked it ready, so one opened before such a command existed never got reviewers and could never merge. Now Loom marks it ready once per pull request, once it targets its repo's base: right after it opens when the forge has no `after_open` commands, else at the first read after those commands ended that still finds a draft, so they keep working and never race with it; Loom records when they start and end, and counts a run a restart cut short as over once its commands' time is up. The opening, a read and a release claim the pull request before they call the forge, and check again that it is the same pull request and still not held, right before the call and when its answer comes, so they never mark one ready twice, mark one the human held meanwhile, or clear the hold of a pull request that replaced it. It posts when it does, then asks for reviewers as before, and never makes a pull request a draft again. A draft it is about to mark ready shows as "being marked ready", never as ready to merge.
- In manual merge mode, Confirm merge shows only once the pull request is ready to merge: every other hold cleared on the commit Loom pushed (Loom's Ready to merge verdict with its approval, checks and order, freeze windows, `require_live`, attempts left and a passed final review). Until then the ticket and its card say the one thing it waits for, with no button, and Loom refuses a confirmation, which used to be allowed early. A planner's merge request can still be recorded early, and shows as waiting until the pull request is ready.
- Commit subjects Loom writes name no ticket key. Its fallback commits take the ticket's title, a fix round's is "Address review feedback", unfinished work is `WIP: <title>`, and its merges read as git's do: `Merge origin/main into <branch>`, `Merge <dependency's branch> into <branch>`, and for an integration merge `Merge <ticket branch> into <integration branch>` with the title in the body. "(Loom)" and "Loom: … for KEY" are gone. Nothing parsed a key out of a subject, so no trailer is needed.
- The integration strategy's landing pull request lists the merged changes by title, with their pull request link when they have one, under a Summary with the goal, and drops "Opened by Loom (project …)"; the project's slug stays in a hidden comment.
- Workers are told to read the skill first and follow it wherever Loom asks for a pull request's text: the brief's proposal through `loom_submit`, the `loom_pr` request, and a fix round's rules. Reviewers judge the text by it, and request changes when it names a ticket key or ref, uses Loom's vocabulary or says how the change was produced, explains the sandbox, or writes its own deploy section.
- Loom's own section of a description, between `<!-- loom:begin -->` and `<!-- loom:end -->`, is written for the reviewer. Under a "Merge and deploy order" heading it lists the pull requests this one builds on or merges after, what must be in production first and whether it is deployed, each by pull request link and title or "pull request not open yet", and how the change deploys, releases, verifies and rolls back, from the ticket's rollout. It names no ticket key, stage or Loom, drops "Loom moves…", "Loom tracks…", "advice" and "Opened by Loom for …", and keeps the ticket's key only in a hidden `<!-- loom:ticket KEY -->` comment, which nothing parses. With nothing to say, the block is that comment alone.
- Loom's template, used with `merge.describe = "loom"` or when a worker does not hand in its text, follows the skill's shape: the ticket's title with no key in front, and a Summary from the ticket's goal and what it must do, without the review count and summaries.
- Open pull requests get the new section. Loom edits only with the title the read just gave, so a read without a title leaves the section for a later read and never puts back a title a person changed. When the block on a pull request is not the one Loom would write now, as after this update, or when a pull request it builds on opens or merges, Loom rewrites it at its next read, touching only the text between its markers and saying so on the ticket. It does so once per block it would write, so a forge that reformats the text never makes Loom edit on every read, and at most 5 times in 10 minutes across every project; the rest follow at later reads. A description without exactly one pair of markers, a forge that cannot edit, or a description the block would make too long is left alone without a word.

### Fixed

- A forge's "update branch" on a pull request whose worker runs on a machine of its own no longer leaves the worker's worktree full of conflict markers. Loom merged the branch's new commits against its own last push, so the base branch's changes looked like the tip's and conflicted, and carried the result into the worker's worktree, which a checkout whose git is served from elsewhere could not take: thousands of modified files, which Loom then refused as work it had not seen, round after round. Now Loom proves when a tip is exactly its last push with the base branch merged in: the approved work does not contain that push (a squash Loom built), it builds on the base the tip took, and merging that base into the push on the project's machine gives the tip's tree. Then the tip adds nothing the work lacks, and Loom records the merge with the work's own tree (`git merge -s ours`). Anything else, such as a person's commit on top of the update, is merged from the commit Loom accounts for: its last push, or the newest foreign tip the work already took, so a later tip that reverts an earlier one's change keeps the revert. A clean merge for such a worker is pushed from the project's machine without touching its worktree, when it leaves the tree as it is or the pull request's CI checks it; when it changed the tree, `loom_resume` puts it in the worktree before the worker's next submit, and the fix round says so. Only a conflict still goes to the worker, and on a repo that does not rely on CI a clean merge that changes the tree is still checked in the worker's worktree.
- A carry into a worker's worktree never takes a worker's work. A carry that fails part-way used to put the worktree back, which could reset a worker's staged version of a file, delete a file the worker edited, or follow a directory the worker had replaced with a symlink. Now a carry that fails, or refuses, leaves the worktree, its files and its index as they are, resetting, cleaning and restoring nothing, removes only its own temporary files, and names each path it wrote or deleted with what that path holds now; the ticket goes back to the worker or waits, as before. A carry starts only on a clean worktree whose HEAD Loom expects, and only when no ignored or untracked file sits where it, or its reset to the base, will write; otherwise it names those files. A path is the carry's only while its content and git mode (the executable bit and the file type) are what the carry left there, reached with no symlink on the way, and the carry stops at any other. Each file goes in whole, by a rename from a private directory outside the worktree on the worktree's filesystem; where there is none, as on a machine whose checkout is a filesystem of its own, it is written in place, checked right before the write, opened without following a symlink, and never through a symlinked parent. The carry commits with `git add` and `git commit` only, since a machine's emulated git may serve no index or object plumbing, and only while the worker's index still matches HEAD, so a worker's staged versions are never touched. It journals the commit first, so a restart recognizes it by its parent and tree, the first of a stacked carry's two commits too, and the next carry takes over the files of one that failed or was cut short when every change in the worktree is its own. A commit whose tree is not the one Loom sent, as when the worker staged a file while it was made, is never the carry's: the next carry refuses it, names it and touches nothing. Loom carries into a worker's worktree on its own, as for a merge of the worker's branch, only while the worker's thread is not running a turn, and holds its own messages to that worker until the carry is over. A turn the human starts on that worker in the moment a file goes in is the same race any editor has, and no check stops it.

### Compatibility

- A migration adds `keep_draft` to tickets. Every ticket whose pull request is open and was a draft at Loom's last read gets `keep_draft = 1`, so a draft that exists before this change stays a draft until the human releases it; every other ticket gets 0. Old blocks keep their markers, so Loom replaces them.
- Loom marks a draft ready only while its project runs: a paused project still reads its pull requests, but changes none. After the update, open drafts are held by the migration, and a pull request that opens later is marked ready unless its ticket sets `keep_draft`; set it with `loom_edit_ticket` or a spec version, for example while the project is paused, on the tickets whose pull requests must open as drafts and stay so.
- `keep_draft` and `ready` have no default in the spec, so a spec without them hashes as before.

## 0.34.2 (2026-11-06)

### Fixed

- Bringing a worker's commit home from another machine no longer reads the project's whole tree. On a very large monorepo, Loom read the entire base into a temporary index, which took minutes under load and made submits fail with "git read-tree took too long" at the same moment for several tickets. Loom now reads and writes only the directories on the way to the changed files, builds the same tree, and still refuses the commit unless its tree matches the worker's. `git_index_timeout_seconds` keeps covering these steps.
- Heavy git work on one checkout runs one call at a time. Bringing a commit home, building a stacked base and merging into a pull request's branch no longer overlap on the same checkout, which kept a loaded machine busy and made each of them slower. A call that has waited so long that its own steps no longer fit in its deadline does not start; it fails as a temporary error that Loom waits out and runs again, instead of being cut off halfway.
- A git command that runs out of time, or is cancelled, now ends the whole process group it started, including children that ignore a polite stop. Before, only git itself was stopped, and the processes git had started, such as a connectivity check, kept running and loading the machine.
- Every `git fetch` Loom runs turns off packfile URIs and bundle URIs. A repository that sets `fetch.uriprotocols`, as World does, could make a plain fetch download hundreds of prebuilt packs; Loom now fetches only the commits it names.
- Retries wait longer after each failure instead of repeating every 15 seconds. A submit whose steps on the project's machine timed out or got no answer runs again only after 15 seconds, then 30, 60 and 120, then every 5 minutes, and the reply to the worker's resubmit says when. Bringing the work of a stopped worker home waits the same way, and the ten-minute limit still ends the thread on time. A new success starts the schedule over.
- A message to a worker that bb does not take is retried on that schedule, and logged once per new error rather than every 15 seconds. When the worker's thread was archived or deleted, or its machine was removed, Loom stops sending and blocks the ticket at once, even while bb still reports the thread active, with the reason "its worker can no longer be reached", without trying to bring the work home from a machine that is gone. The message it could not send is kept on the ticket's feed, and requeuing the ticket starts a new worker that reads it, so the ticket no longer holds a worker slot or sits in working. Before, one removed sandbox produced the same "Host not found" warning every 15 seconds for as long as the ticket waited.

### Compatibility

- No migration, and no spec change. The retry schedules are kept in memory, so a restart tries once at its first tick.
- `git read-tree`, `update-index` and `write-tree` are no longer run on the project's checkout; the commit Loom brings home is the same one as before, with the same tree, author, date and message.
- Not changed: the timeline RPC, how often Loom polls whether a commit has landed, and merge-tree itself apart from the one-at-a-time queue.

## 0.34.1 (2026-11-06)

### Added

- `auto_merge.mode` says who decides each merge on a repo whose forge sets `auto_merge`. `"manual"`, the default, makes Loom wait for the human: once a pull request is ready (and its final review, if any, has passed), Loom posts once that it waits, and asks the forge to merge only after the human confirms the merge of the exact commit it pushed. The human confirms with Confirm merge on the ticket page or the ticket's board card, or with `bb loom auto-merge <slug> confirm --ticket <KEY> --pr <URL> --sha <SHA>`; without them, the command prints the pull request and commit it would confirm and confirms nothing. Every confirmation names the pull request and commit the human saw, and Loom refuses one that no longer matches, so a stale or replayed confirmation never authorizes a newer head, and each push needs its own confirmation. Only the human's confirmation counts. The planner's new `loom_confirm_merge` tool asks the human to confirm a commit: the request shows on the Planner page, the ticket and its card with the same Confirm button, and merges nothing by itself. A confirmation may come before the pull request is ready. Like every human control in Loom, this relies on agents not impersonating the human: a call through `bb plugin rpc`, or the CLI run with the bb thread identity stripped, looks like the human's, and closing that needs bb to report where each call came from. `"auto"` merges once the pull request is ready, as auto-merge did before.

### Fixed

- A merge that needs the worker's worktree no longer pauses the project and stalls the merge queue when the worker's thread is still active but bb shows no worktree for it, as when its sandbox expired. Bringing a branch up to date with what it is stacked on or its base, finishing such a merge, and merging commits someone else pushed to the pull request's branch all used to stop with "has no worktree … Resume once bb shows the worktree again", which paused the project and left the ticket in merging, where every other approved ticket waited behind it; resuming could not help once the environment was gone for good. Now the ticket leaves merging, back to approved or to its open pull request, with a post saying why, and the queue moves on. The worker comes back the way a released one does: bb restores its environment when it can, and the queue then takes the ticket again; when bb cannot, a new worker takes the ticket from its branch.
- Submits no longer fail on a large monorepo because Loom's own git steps on the project's checkout run out of time. To bring home a commit from a worker on another machine, Loom reads the base into a temporary index, updates it, writes its tree and commits it; on a loaded machine, reading a monorepo's whole index took 41.5 seconds, past the 30 seconds every quick git call gets, so every submit failed with "The checks could not run: git read-tree took too long. Submit again." and workers blocked their tickets after three tries. These index and tree steps, and merge-tree when Loom merges into a pull request's branch or builds a stacked base, now share a separate limit per call: 5 minutes by default, set with the new `git_index_timeout_seconds` (30 to 900) on `[merge]` or a `[[repo]]`, next to `git_network_timeout_seconds`. Quick git calls keep their 30 seconds, and every step stays bounded. When a submit still runs out of that time, the post and the worker's message name the setting to raise and say the failure counts against nothing, so the worker submits the same work again instead of blocking; as before, it counts no check failure and no attempt. A merge that runs out of it is waited out like any temporary failure, and its wait names the setting too.
- A Loom update no longer pauses every running project. bb retires the old host plugin generation in the middle of a call, and the answers it gives then, "host plugin loom generation … is retired", "host plugin loom startup timed out" and "host plugin transport is unavailable", were read as lasting errors, so a pull request read that got one paused the project ("Reading the pull request of LANE-21 stopped: host plugin loom generation … is retired"), and a restack sent its ticket back to the worker. They are now waited out like a network blip, together with the answers Loom already waited out (the host plugin worker exiting, "Host is not connected" and "Host is suspended"): the read runs again after 5, 10, 20 and 30 minutes, and the project pauses only if the reads keep failing for an hour.

### Compatibility

- No migration. A ticket can now move from merging back to approved.
- `auto_merge.mode` defaults to `"manual"`, so a running project whose spec sets `auto_merge` stops merging by itself after the update: each ready pull request waits for a confirmation. Add `mode = "auto"` to its `auto_merge` to keep merging without one. The key has no default in the spec, so a spec without it hashes as before.
- `git_index_timeout_seconds` is optional and has no default in the spec, so a spec without it hashes as before. A version that changes only it skips the spec review, like `git_network_timeout_seconds`. Host calls with index steps get that time on top of their old limit (`mergeOnto` 330 seconds instead of 150, `importCommit` and `stackBase` 570 instead of 270 by default), capped under bb's 30-minute host call limit.

## 0.34.0 (2026-11-05)

### Added

- Each step of the planner's ask has Mark done, which records an `askStepDone` human action for that step, so an `other` step, or a step the human will not take, no longer holds the badge until the whole ask is set aside.
- `loom_ask_human` takes a `live` step with a ticket key or milestone ref. Loom checks it off once that target has a live mark, by the human, a merge, a verify or a check, and the step has a Mark live button.
- Acknowledge on the Merge order and Rollout badges, which Loom cannot see the human resolve: it records an `ackBadge` human action with the items counted then, and the badge stays hidden until a new item appears.

### Changed

- A project tab with a badge now opens with a notice that says what the badge counts, lists each item with a link (a ticket, a pull request, a step of the planner's ask or the planner's thread), and says what clears it. Before, the label was only in the tab's tooltip, so the badge was a number without an explanation.
- The Merge order tab no longer counts the pull requests with nothing before them. They wait on their own reviews and checks, which the tab shows, not on the human, so the badge never cleared until they merged. It still counts, in red, pull requests that merged into another ticket's branch.
- The Rollout tab counts only its warning-tone warnings. Info-tone ones, such as a milestone that does not hold yet or a freeze window a few days away, still show on the tab without a badge.
- The Planner tab's "?" says that the planner's thread waits for an answer in its chat and links to it. When bb's wait is on something the Planner page cannot show, such as a tool approval from the planner's provider, Needs you now says so and opens the thread, where it used to say that nothing needed you.

### Compatibility

- No migration: both acknowledgements are `human.action` events, which the feed and Insights describe. An acknowledgement does not count as a human intervention in the metrics.
- Asks recorded before this release read as before. New RPC methods `askStepDone` and `ackBadge`; the project view's `openAsks` count is replaced by `askSteps`, the open steps, and gains `badgeAcks`.

## 0.33.1 (2026-11-05)

### Fixed

- The Spec tab shows a setting turned on with an empty table, such as `auto_merge.final_review = {}`, as a change. The spec diff walked only into a table's keys, so a table added or removed with none was no change at all: a version that only turned the final review on showed nothing under "Only what changed" and "What changed", and was sent to the spec reviewer instead of being skipped as operational. "What changed" now reads such a table as "on, with its defaults".

## 0.33.0 (2026-11-05)

### Added

- A final review before Loom merges: `auto_merge.final_review = {}`, or with `provider`, `model`, `reasoning` and `timeout_minutes`, runs one short agent turn right before Loom asks to merge, once every other hold has cleared, on the exact commit it would merge. Loom merges only once it passes for that commit, and a new push needs a new one. It is scoped to the delta: the patches of the pull request's own files that changed since Loom's reviewers approved the ticket (a base merge's conflict resolution, someone else's commits), the pull request's title and description now, people's comments and reviews since the approval, and the acceptance criteria; with no code change it checks the text only. It runs in an empty scratch directory on the project's machine, with no worktree, environment or machine of its own; it never runs in the repo's checkout (should bb refuse the scratch directory, the merge holds). Against accidents, Loom takes a cheap fingerprint of the repo's checkout (HEAD, branch, the index checksum, `git status` and each listed path's lstat, at most 300 paths and 5 seconds) before it and, once the reviewer has really stopped, again before it counts a pass, holding the merge on any change or a fingerprint it cannot take, and never resetting the checkout. A reviewer's thread is stopped and its scratch directory removed once its run is over, a pass included; a run is closed only after the removal is confirmed, and orphaned directories are swept. Own files are those the pull request changed at the approval or changes now, so a conflict resolution that drops an approved change is shown; files only the base brought are counted only when Loom established it. The brief is bounded (12 patches, 40,000 characters, exact counts of what it left out), and a pass of an incomplete brief waits for `bb loom auto-merge <slug> accept --ticket <KEY>`. Runs are kept up apart from whether a merge may start: a deadline recorded with each run (a later verdict is refused), a new push, a pause, an `off`, a block, a cancel or lost readiness ends the run and archives its thread. It runs at `agents.reviewer`'s model and `"low"` reasoning within 10 minutes unless the spec says otherwise. Its one tool, `loom_final_review`, passes or fails with a reason and whether the worker can fix it: a fixable failure is a fix round, counted like other feedback, and any other blocks the ticket. A run that does not start, times out or ends without a verdict never merges; Loom tries again 5 and 10 minutes later and holds after 3, until `bb loom auto-merge <slug> retry --ticket <KEY>`. The ticket's posts, the feed, the Merge order tab ("Waiting for final review", "Final review failed: …") and `bb loom metrics` (`finalReviews`) show it.

### Compatibility

- No migration: each run, verdict and end is a ticket event keyed by the commit (`ticket.final_review_started`, `_bound`, `_verdict`, `_ended`, `_nudged`, `_acted`, `_closed`, `_held`, `_reset`, `_verified`, `_accepted`), recorded before the thread is spawned, so a restart neither runs a second review nor merges without one.
- A spec without `final_review` parses and hashes as before.
- New host calls `checkoutPrint` and `finalScratch`.

## 0.32.0 (2026-11-04)

### Added

- Loom can merge a ticket's pull request itself once it is ready, on a repo whose forge opts in with `auto_merge`. `method` says how the repo merges: with gh, `squash`, `merge` or `rebase` (`gh pr merge --match-head-commit <pushed sha>`), `queue` (`gh pr merge --auto`, for a merge queue) or `comment` (a comment such as `/merge` for a merge bot); with a command forge, `command` runs its new `merge` command, which gets `LOOM_URL`, `LOOM_PR_NUMBER`, `LOOM_HEAD`, `LOOM_BASE`, `LOOM_SHA` and `LOOM_ATTEMPT`, and exits 0 when the server took it, 3 when it turned it away in a way the worker can fix and 4 when it refused. Loom asks only while the Merge order tab's verdict is Ready to merge (not a draft, approved on the forge, or with `approval = "loom"` only not asked to change, its checks less `ignore_checks` passed, no conflict, nothing it waits on open, a stacked pull request moved to its base), the project runs, no `[[rollout.window]]` is on and, with `require_live`, what its rollout requires is live. Each attempt is recorded on the ticket before the forge is called, so a comment or a command is never sent twice, and later reads settle it: merged completes the ticket, a rejection (GitHub's merge queue removing it for failed checks or a conflict, or a new comment matching `rejected`) becomes a fix round with the forge's words, and a refusal, or a rejection on the last of `max_attempts` (3), blocks the ticket with the reason. Before, Loom never merged: every ready pull request waited for a person, and a failure at merge time, such as a merge service's conflict, reached no worker.
- A merge comment or command is never sent twice for one attempt: an outcome Loom cannot know (a timeout, a temporary-looking error, a lost answer) keeps the attempt open until a read settles it or `retry`, so `max_attempts` bounds what is sent. Loom judges the ticket again, and records the attempt, right before it calls the forge, so a pause, an `off`, a block or a new push while it looks up the checkout stops the merge. A merge-queue removal settles only an attempt it is newer than, and never while the pull request is queued; a rejecting comment must be new by its stable id and made after the attempt, so an edited old comment does not count (the `feedback` command's items may give `stable_id` and `created_at`; gh gives both). An attempt from before a requeue or `on` is judged against the fresh budget. A merge or `request_reviews` command stopped by a signal after it started counts as an unknown outcome, like a timeout. An attempt a restart left with no recorded answer gets one post with the `retry` instruction, and an answer that comes back after its attempt was cleared or replaced is posted and acts on nothing.
- `bb loom auto-merge <slug> off|on|retry [--ticket <KEY>]`: the human stops or resumes Loom's merging for a project or one ticket, and `retry` clears an attempt in flight whose outcome Loom cannot see.
- Reviewer rules per forge: `reviewers = [{ team = "acme/platform", count = 2 }]`, or `users` with an optional `count`, makes Loom ask a stable random sample of people to review each pull request it opens, once, as soon as it is not a draft. The pick is seeded by the pull request's URL, never takes its author or a bot, and counts people already asked or reviewing. gh lists the team with `gh api` and asks as Loom's re-requests do; a command forge gets `request_reviews` (the logins comma-separated in `LOOM_REVIEWERS`) and `team_members` (`LOOM_TEAM`, one login per line). Who was asked, and why, is posted on the ticket, naming anyone the forge refused. Loom waits for a read that says the pull request is not a draft (a command forge needs a `feedback` command printing `draft`), never counts the author's own review, allows at most 20 people per pull request, and records each request before sending it: a `request_reviews` run that timed out or lost its answer is not repeated, and a definite failure is tried at most three times. Before, Loom only asked people who had already reviewed to review again, and only through gh.
- `loom_discover` says whether each repo's forge merges by itself, and the Spec tab draws `auto_merge`, `reviewers` and the new commands with the forge.

### Compatibility

- No migration: attempts, outcomes and the human's switches are ticket and project events (`ticket.merge_attempt`, `ticket.merge_outcome`, `ticket.merge_held`, `ticket.auto_merge`, `project.auto_merge`, `ticket.merge_answered`, `ticket.reviewers_asking`, `ticket.reviewers_failed`, `ticket.reviewers_requested`), which the feed describes.
- A spec without the new keys parses and hashes as before: none has a default. They are operational settings, so a version that only adds them skips the spec review, and the human still approves it.
- New host calls `prMerge`, `prReviewState` and `teamMembers`; `prRequestReview` takes an optional command forge and logins with `@`, and answers `unknown` for a command that timed out; feedback items may carry `stableId` and `createdAt`, and gh reads each comment's creation time; `prBatch` reads merge queue state only when a repo merges through the queue, so other reads are unchanged.

## 0.31.1 (2026-11-04)

### Added

- The planner's `loom_post` on a ticket whose pull request is open starts a fix round, as a human reply does, and the worker's message says the planner asked. The planner had no way to ask an open pull request's worker for a change such as merging the base branch in: its comments on the pull request come from the author's account, which Loom ignores as the worker's own, and `bb loom post` is the human's.

### Compatibility

- No migration.

## 0.31.0 (2026-10-29)

### Added

- Hooks in the spec. A `[[hook]]` table names a project event in `on` (`spec.approved`, `project.started`, `ticket.started`, `pr.opened`, `ticket.blocked`, `ticket.done` or `project.done`) and says what happens then: `tell` is an instruction Loom sends the planner thread, with what happened, once the planner is idle, and `run` is a shell command Loom runs on the project's machine with `LOOM_*` variables for the event. With `to = "worker"` on `ticket.started`, the instruction goes into every worker's brief instead. Before, an instruction such as "add every pull request to a Shuttle board" lived only in the planning conversation, and nothing reminded anyone of it once the project ran. Every hook is optional; the planner writes the ones the human asks for. Loom delivers each hook once per event, from the project's event log and with the spec version in force when the event happened, and only delivers it: it checks nothing a hook asks for, moves no ticket and holds nothing back. A command that fails, or that a restart interrupted, never runs again, and a project's next command waits until an interrupted one can no longer be running; a send to the planner that bb refuses is tried again on the next pass, three sends in all. The feed and the Insights tab record `hook.told`, `hook.ran` and `hook.failed`, and the Spec tab draws the hooks as a card that What changed and comments reach.
- A Planner instructions setting (`plannerInstructions`): standing instructions for every planner, up to 4,000 characters. Loom adds them, for the planner only, after the goal of a project started from the Loom page; `loom_discover` prints them first, so a planner started from any thread sees them; and the spec reviewer reads them, with a rubric line that asks for a hook or ticket for each instruction that applies and flags a hook nobody asked for. The loom-plan skill says how to turn them into hooks.

### Compatibility

- One migration: a `hook_firings` table, and `projects.hook_event_id`, the newest event whose hooks Loom queued. Every existing project starts after its newest event, so a hook that a later version adds never fires for an old event.
- A ticket's move to `pr_open` when Loom opens its pull request now records `opened: true` in its event, which `pr.opened` reads; a move back after a fix round or a catch-up does not.
- A spec without `[[hook]]` tables parses and hashes as before. Changing a hook keeps the spec review, since hooks are what the human asked for.

## 0.30.3 (2026-10-28)

### Fixed

- Work brought home from another machine is measured from the base its worker had, not from the checkout's remote-tracking base branch. When the forge refuses the checkout's fetch of the base branch, for being too far behind, that ref stays hours old while each worker starts from a fresh one, and measuring from it counted every base commit in between as the ticket's. A reviewer's `loom_checkout` then carried thousands of files, ran past the 5-minute limit of its call and failed with "fetch failed" again and again; the reviewers' diff showed other people's changes; and the pull request's commit would have been built on the old base. The carry, the reviewers' diff and the pull request's commit now start from the parent of a head that came home, one commit on its worker's base. A stacked ticket, and a merge Loom made of commits someone else pushed, are measured as before.

### Compatibility

- No migration. `refTip` takes an optional `parents` and then returns the commit's parents.

## 0.30.2 (2026-10-28)

### Fixed

- Moving a pull request to the branch it now builds on no longer pauses the project when GitHub has already moved it. GitHub moves a pull request in one of its stacks itself when the one below merges, and refuses any base edit on it, even one to the base it already has: "Cannot change the base branch because the pull request is part of a stack". Loom now reads the pull request's base first and edits it only when the base differs. If the base cannot be read, Loom still edits, and a failed edit stops as before.

### Compatibility

- No migration.

## 0.30.1 (2026-10-28)

### Fixed

- A git server that refuses a fetch for now and asks to be tried again no longer pauses the project. A forge's upload-pack answered "native upload-pack memory budget exhausted by fetches far behind; retry with backoff" while Loom read a pull request's branch before a push, and Loom paused. Git's and forge commands' failures that say retry with backoff, retry later or shortly, try again later, temporarily unavailable, budget or resources exhausted, a busy server or an overloaded one now wait and run again, as a server error does, and pause only after an hour.
- Reading a pull request's branch fetches the base branch before the branch. After someone merged many base commits into the pull request, as a forge's "update branch" does, fetching its tip first from a checkout whose base is old brought every one of those commits, which is the fetch far behind the forge refused. With the base fetched first, the tip brings only the pull request's own commits.

### Compatibility

- No migration.

## 0.30.0 (2026-10-28)

### Changed

- The Rollout tab reads as a plan instead of a wall of text. Before, it was one sentence for the next step, a banner per warning, and a block of four to six lines of prose per step, with the same deploy text on every step of a repo, full command paths, two status chips per step to read together, steps sorted by ticket key and the milestones at the bottom. Now it shows, top to bottom:
  - Do next: the next safe step as a checklist (review and checks from the Merge order data, merge, deploy, verify), and what its going live opens, such as the stage soaking for a day and the steps that can go after it. When nothing can go, it says what to wait for.
  - Hold off: each step a warning names, once, with its reasons as a short list, such as "Don't merge OTLP-10 yet" because a milestone does not hold, the stage before is not all live and a freeze starts in 12 days.
  - Calendar: the freeze windows on a dated strip with today marked, and the earliest each stage could be done if every step went live as soon as it could.
  - Deploy order: a column per stage with a progress bar, in deploy order with "then" lines, and one status per step (Live with the soak time left, Merge now, Merge, then deploy, Ready after the stage before, Waiting, Don't merge yet, Don't deploy yet and others). ⚡ marks a step whose merge deploys it, and milestones sit in the stage that needs them. A step opens in place to its needs, deploy, release, verify result with Copy and its output, rollback, what it unblocks, and Mark live.
  - Hovering a step highlights what it needs and what waits on it, with a line from each. Highlight on hover turns that off, Show every link draws every line, and both are remembered on the device.
  - How each repo deploys, once per repo.
- On a phone the cards and the stages stack, the Do next buttons share the card's width, and nothing scrolls sideways at 390 px. A touch never leaves a step highlighted, and the hover switch is hidden on touch screens; keyboard focus highlights like hovering. Each step's button reads its whole tile to a screen reader, and Copy falls back to selecting the text where the page has no clipboard, as over plain HTTP.

### Compatibility

- No migration. The page's Rollout tab also reads the Merge order view the project page already loads. `bb loom rollout` prints the same sentences as before.

## 0.29.4 (2026-10-28)

### Fixed

- Loom can carry work onto a machine whose git serves the repository from elsewhere, with `.git` a file and no git directory behind it, such as an emulated git. 0.29.0 kept a carry's restart mark where `git rev-parse --git-path loom-carry` points, and on such a machine that is `.git/loom-carry` inside a file, so every carry there failed with `ENOTDIR`, `loom_resume` included. The mark now goes to the machine's temporary directory, keyed by the worktree, whenever the git directory is not a directory, so a carry that was cut short still starts again there.

### Compatibility

- No migration.

## 0.29.3 (2026-10-28)

### Changed

- A version whose spec review was skipped names how many operational settings changed and which ones ("6 operational settings: the forge on 4 repos and web's refresh_behind"), with the full list behind a disclosure, in the next-step bar and on the Planner tab.

### Fixed

- Every Loom view fits a phone. On a page narrower than about 36rem:
  - The project tabs scroll sideways in their own row, which stays at the top. Before, eight tabs made the whole project page scroll sideways.
  - The health strip and the Timeline fold to one row each, and one click opens the full view and folds it back. The About strip keeps its summary's first lines, so the first screen reaches the tabs.
  - The next-step bar's button goes under its text, and a Planner tab step's buttons go under its text instead of squeezing it to one letter per line.
  - Home shows each project as a card, and the Agents tab stacks the ended threads' rows.
  - bb's title bar names a ticket's project by its key.
  - Long names, paths and links wrap instead of running off the screen: Insights, What changed, the Planner story, the home cards and New project's choices.
- The Spec tab draws every setting the spec can hold, so a version can be reviewed on the page, not only as paths in What changed:
  - the forge's commands (`open`, `state`, `feedback`, `edit`, `reply`, `retarget`, `after_open`, `after_push`) folded to their first line, and `ignore_checks`;
  - `stack`, `release_workers`, `refresh_behind`, `git_network_timeout_seconds` and `checks.ci`;
  - each environment's inputs, machine and reviewer table;
  - each repo's forge, environment, CI, deploy, freshness, git time limit and worktree, behind a disclosure that opens by itself when something in it changed;
  - a Deploy order card for `[rollout]` (deploy, stages, milestones and windows);
  - each ticket's rollout and environment inputs.
  Every value can be commented on, every What changed row jumps to it, and a removed setting is drawn struck through with the value Loom now uses in its place. A test walks the spec schema, so a key added later fails it until the page draws it.

### Compatibility

- No migration. The page's `NextStep` view gains an optional `paths`.

## 0.29.2 (2026-10-27)

### Fixed

- A ticket whose stored conflict-marker paths came from Loom before 0.29.0 can submit again. 0.29.0 made new paths relative to the repository's top level, but a ticket in a checkout that is a subdirectory of its repository kept its old paths, relative to that subdirectory, such as `../../../clients/web/a.ts`, and every submit failed with "must be a path inside the repository". The submit now resolves such a path from the checkout's place in the repository, stores it again, and drops one that points outside the repository.

### Compatibility

- No migration. The host entry gains `repoPrefix`.

## 0.29.1 (2026-10-27)

### Fixed

- Every Loom agent has its tools again. 0.29.0 made the loom skill's description 1,083 characters, over the 1,024 bb registers, so bb dropped the skill, `bb.agents.configure` then failed on the unknown skill id, and no planner, worker or reviewer thread got a Loom tool. `bb plugin list` showed `agent configure failed: configure() selected unknown skill id "loom"`. The description is shorter now, and a test keeps each skill's name and description within what bb registers.

### Compatibility

- No migration.

## 0.29.0 (2026-10-27)

Two pull request projects needed the human too often: 69 ticket blocks, 17 automatic pauses and 21 resumes in three days. Most came from four gaps: a merge path that paused on failures worth waiting out, a worker that could not change its pull request's text, bases that went stale, and nowhere to keep deploy order. This release closes all four.

### Added

- Deploy order, advice for the human. Loom never holds, delays or reorders a start, a review, a merge or a push for it.
  - The spec takes `[rollout]`: a project-wide `deploy = { on_merge?, how? }`, ordered `[[rollout.stage]]` tables with a `goal` and optional `soak`, `[[rollout.milestone]]` tables for a prerequisite no ticket delivers (with an optional `check` command), and `[[rollout.window]]` tables for freezes. A repo's `deploy` overrides the project's, and each ticket takes `rollout = { stage, requires_live, release, dark, how, verify, rollback }`. All optional and pull request strategy only; a spec without it parses and hashes as before. `loom_propose` refuses an unknown stage or ref, a cycle through `depends_on`, `merge_after` and `requires_live`, and a ticket requiring one in a later stage.
  - A ticket's rollout runs from merged to live and soaked, apart from its ticket state; in a repo that deploys on merge it is live once its pull request merges. A merged ticket's `verify` and a milestone's `check` run on the project's machine every 15 minutes with a 2-minute timeout until they exit 0, one run per target at a time, across a plugin reload too, and a run keeps no result once the project is archived or its command changed. A failed run never pauses the project, and Loom follows a done project's rollout until archived.
  - `bb loom live <slug> <KEY|milestone> [--note] [--undo]` and Mark live on the page record it by hand (human only).
  - A Rollout tab beside Merge order shows the next safe step in one sentence, warnings (a prerequisite not live, a stage that has not soaked, a deploy-on-merge pull request near or inside a freeze window, a milestone that does not hold), one section per stage, the milestones and the windows. Its badge counts warnings. `bb loom rollout <slug> [--json]` prints the same.
  - A pull request Loom opens for a ticket with a rollout, or in a project with stages, gets a `## Rollout` section: its stage, what must be live first with links, how it deploys, its release, whether it is dark, verify and rollback. Loom rewrites the section when a prerequisite goes live. Loom's own sections sit between `<!-- loom:begin -->` and `<!-- loom:end -->`, and nothing outside them is changed.
  - The worker and reviewer briefs say Loom tracks the rollout order, so reviewers stop asking for a draft until something deploys and never request changes for rollout order. The loom-plan skill and the spec reference explain the three orders (work, merge, deploy) with a worked example, and the spec reviewer checks rollout on tickets that change a running system.
- Pull request text that reviewers judge and Loom can change.
  - `loom_submit({ summary, pr? })`: the worker proposes the pull request's title and description, and reviewers judge them with the work. On first approval `loom_pr` needs only the commit message. In a fix round `loom_pr` also takes `title` and `body`, and a fix that changes only the text goes through review; Loom then sets the text without pushing.
  - Loom sets the text with `gh pr edit`, or a command forge's new `edit` command, on the project's machine, so a worker on a machine of its own needs no forge access. A forge without one gets the text posted on the ticket. A description over the forge's limit is never cut short: the edit is skipped and said on the ticket.
- `loom_pr_reply({ item, text, resolve? })`: a worker in a fix round answers a review thread or comment by its feedback key, and resolves a thread, through gh or a command forge's new `reply` command. Replies carry the comment signature, at most 30 per round, and are never read back as feedback.
- Forge setting `ignore_checks`, globs (`*` and `?`) of check names Loom drops, such as an advisory bot status no fix can clear.
- `merge.refresh_behind` and a repo's `refresh_behind`: opt-in, counted in commits. Loom counts the base commits each open pull request lacks, fetching the base at most every 30 minutes per repo and only while it has open pull requests. When one lacks that many, or the forge says it conflicts, Loom merges the base into it on the checkout, runs its checks in the worker's worktree and pushes with no new review, also when the merge leaves its files as they were, so the pushed branch has the base; a conflict goes back to the worker. What is still due goes by the pushed commit. Never a rebase or a force-push. Refreshes run after approved tickets and restacks.
- `mergeable`, from gh and a command forge's `feedback`. The Merge order tab shows "conflicts with main" and "N commits behind main", and a conflicting pull request is never "ready".
- Review again as is: `bb loom requeue <KEY> --review`, `loom_requeue({ key, note, review: true })` and a button on a blocked ticket. It starts no worker. The ticket goes back on its open pull request when its branch has nothing the pull request lacks, or back to review for the commit whose checks passed last, with fresh counters; approved text that was never applied is applied, and unreviewed text goes to review. Its thread stays the released worker, so a later fix round, requested changes or catch-up brings it back.
- `bb loom forge check <slug> <KEY or url> [--repo <name>] [--version N] [--json]`: runs the repo's own forge read on the project's machine, as a poll would, and prints what Loom reads (state, draft, review, base, mergeable, checks with what `ignore_checks` drops, items, and Loom's section in the description), or why the read failed and each field the host contract refused. Planners may run it, also against a pending version's forge, and it changes nothing.
- The spec reviewer traces each `done_when` item to tickets, and flags acceptance criteria that writing down why the goal cannot be met would satisfy.

### Changed

- One error policy for every merge step. A failure worth waiting out (a host call that got no answer or whose host worker exited, a server error, a rate limit, a timeout or a network failure) keeps the ticket in merging and runs the merge again after 1, 2, 5 and 10 minutes, then every 15, with one post per streak; the project pauses only after an hour of them. The board card, the ticket page and the next-step bar say when it tries again. Pull request reads and the review's diff read wait a host call with no answer out the same way. A missing login, a checkout or a forge command that prints the wrong thing still pauses.
- Any merge Loom puts in a worker's worktree (a restack, a refresh, commits someone else pushed) is built on the checkout with `git merge-tree` and saved before its checks run, so a merge that runs again finishes it instead of merging from an older head: nothing is pushed, or counted as pushed, before its checks pass, and nobody's commits are lost.
- A version that changes only operational settings against the previous one skips the spec review: forge, environments, `agents`, `budget`, `merge` keys other than `strategy`, `branch` and `remote`, a repo's `refresh_behind` and `git_network_timeout_seconds`, `checks.timeout_minutes` and `ci`. The human still approves it, with no `--skip-review`, and the feed, the Spec tab and the next-step bar say why. A draft skips only when the draft before it passed or skipped its review.
- An automatic pause sends the planner a triage round only for the budget or the deadline, which a new version can change.
- A stacked pull request the forge closed when its parent merged and its branch went away no longer blocks: Loom opens a new one on its new base, with the title and description the reviewers approved last, field by field before the template, and its own sections as they are now. Sync and the board say a new pull request is coming.
- A ticket sent back to review keeps its worker thread, after a spec approval too, so it can still catch up and take requested changes.
- The human can block or cancel a ticket whose merge waits, or that a pause left in merging; on the integration strategy Loom first takes an unchecked merge back out of the integration branch.
- A git fetch, `ls-remote` or push that runs out of its `git_network_timeout_seconds` is waited out like any temporary failure. The new `behindBase` and `remoteBranch` host calls get twice that timeout plus 30 seconds; `mergeOnto`, `prRequestReview`, `prEdit`, `prReply` and gh's `prRetarget` get the 150-second host deadline, a command forge's `retarget` keeps 0.28.0's 5 minutes with a host deadline 30 seconds longer, and `merge-tree` runs for up to 2 minutes.
- `after_push`, from 0.28.0, runs at most once per push, also when a merge runs again: Loom records each run before the commands start, and a move to another base gets its own record, so a retry repeats neither. A push and a move in one step run the commands once, after the move, on the new base; a push whose move fails, waits or pauses runs them at once on the base the pull request still has, so no push loses its run; a later successful move gets its own. It also runs after a refresh's push.
- `retarget`, from 0.28.0, follows the error policy: a failure that looks temporary is waited out with the merge, and any other failure asks the human to move the pull request without pausing. Loom runs it through the host entry's `prRetarget`, so its output is read as the other forge commands' is. Only a move that succeeds changes the base Loom keeps; after a failure, or a post asking the human to move it, the next push tries again.
- Review requests after a fix, and `after_open` and `after_push` commands, are never run again after a failure; it is posted once and the merge completes.
- `bb loom feed <slug> --after <id>` pages forward, 200 events at a time.

### Fixed

- A reviewer's verdict on a ticket submitted before Loom kept its tree is checked by tree, not by commit id, so a commit carried to a reviewer's machine is recognised.
- Conflict paths, carried files and conflict markers in a checkout that is a subdirectory of its repository are relative to the repository's top level, so a worker can submit.
- A worktree with an unfinished merge, even one with nothing left to resolve, goes back to its worker untouched instead of pausing the project, being reset or released.
- A push that fails after Loom brought a pull request's branch up to date is made on the next run, a carry to a thread's machine that was cut short starts again, and a failed fetch while carrying is waited out.
- An approved pull request text waiting to be tried again after a temporary edit failure no longer overwrites a newer proposal: the proposal is judged against the waiting text, and once approved it replaces that edit, or drops it when it keeps the description.

### Compatibility

- Migrations add the ticket columns `merge_wait_json`, `merge_step_json`, `rollout_json`, `pr_proposal_json` and `pr_applied_json`, the table `rollout_marks`, and rebuild `spec_reviews` with a `skipped` state and a `skip_json` column, keeping every row.
- The host entry gains `behindBase`, `remoteBranch`, `prEdit` and `prReply`; reads return `title`, `body` and `mergeable`; network ops return `transient`; and `prRetarget` takes an optional `forge` for a command forge's `retarget`. Older hosts' answers still parse.
- `ticket.after_push` and `project.after_push` events record the base and whether the run was for a push, a move or both.
- `ignore_checks` takes globs, not regular expressions. Pull requests opened before 0.29.0 have no Loom markers, so their Rollout section is not refreshed, and Loom says so once.
- The page's RPC gains `markLive` and the `review` ticket action; `ProjectView` gains `rollout`, and a ticket's detail `reviewAgain` and `mergeWait`.

## 0.28.0 (2026-10-27)

### Added

- `after_push` on `[merge.forge]`, or a `[[repo]]`'s `forge`: up to 5 shell commands Loom runs after each push to an open pull request, and after it moves one to another base. A push here is a fix round, a catch-up with a dependency or the base branch, someone else's commits merged in, or a land's push. Before, only `after_open` ran, once, so a forge whose CI does not start by itself on a draft, such as Delta, had no CI on Loom's later pushes until someone started it.
  - The commands get `LOOM_URL`, `LOOM_PR_NUMBER`, `LOOM_HEAD`, `LOOM_SHA` (the commit the pull request now has) and `LOOM_BASE`, the branch it builds on now: its dependency's branch while it is stacked, the base branch once Loom moved it there. So `[ "$LOOM_BASE" != main ] || dt pr ready "$LOOM_PR_NUMBER"` marks a stacked pull request ready once its dependency merged.
  - A failure is posted on the ticket and blocks nothing, as `after_open`'s does. `kind = "none"` refuses it.
- `retarget` on a command forge: a shell command that moves an open pull request to another base, with `LOOM_URL`, `LOOM_PR_NUMBER` and `LOOM_BASE`. Loom runs it when a stacked pull request's dependency merges, as it runs `gh pr edit --base` on GitHub. Before, a command forge's ticket posted that the human must change the base by hand; that still happens without the command, or when it fails, and a failure does not pause the project. Only `kind = "command"` accepts it.
- The spec reference's World example sets `retarget = 'dt pr edit …'` and an `after_push` that starts CI and marks a pull request ready once it builds on main.

### Changed

- `after_open`'s `LOOM_BASE` is now the branch the pull request opened on. For a stacked pull request that is its dependency's branch; before, it was always the repo's base branch.

### Compatibility

- No migration. A spec without the new keys runs as before.

## 0.27.0 (2026-10-27)

### Added

- `git_network_timeout_seconds`, on a `[[repo]]` or on `[merge]` for every repo, sets how long each git fetch, `ls-remote` or push Loom runs in that repo may take: 30 to 600 seconds, 120 when unset, as before. 0.26.1 fixed a project on World that paused every time it brought a stacked pull request up to date, by giving the fetch 150 seconds; this lets a spec raise the limit again, with a revision, if a fetch grows slower than that.
  - It covers fetching the base branch to restack or to start a stacked ticket, reading and fetching a pull request's branch to build its commit or to merge someone else's commits, pushing, the fetches that bring a machine's work home and carry it to a worker's machine, the push-only forge's check that a commit landed, and the direct land.
  - Each of these host calls gets twice the timeout plus 30 seconds, because some run two git network steps in a row (`ls-remote` then a fetch). With the default that is 270 seconds instead of 150.
  - A version approved after the project started applies from Loom's next pass.
  - `gh`, the forge's commands and the first checkout of an integration worktree keep their 2-minute limits.
- The spec reference has a new section, Slow repositories, and its World example sets `git_network_timeout_seconds = 300`. The planner skill tells the planner to set it on a repo whose base branch takes more than about a minute to fetch.

### Compatibility

- No migration. A spec without the key hashes and runs as before, and the host calls carry the new `networkTimeoutMs` input only when the spec sets it.

## 0.26.1 (2026-10-27)

### Fixed

- Bringing a stacked pull request up to date with the base branch no longer pauses the project on a large repository. The host call that builds the stacked commit fetches the base branch first, but it had the 30-second deadline of a local git call. Fetching main of the World monorepo takes 50 to 80 seconds, so once a lower pull request merged, every attempt to restack the one above it ran out of time and paused the project with "host plugin call … exceeded its deadline". Resuming paused it again.
  - `stackBase`, `fetchTip` and `prCommit` now get the 150-second network deadline, like the other host calls that fetch, run `ls-remote` or push. `stackBase` and `fetchTip` fetch the base branch, and `prCommit` runs `ls-remote` and may fetch the pull request's branch.

### Compatibility

- No migration.

## 0.26.0 (2026-10-27)

### Added

- Sync pull requests, in a pull request project's header while one is open, reads every open pull request now instead of at its next check. Sync now on a ticket reads that one, and `bb loom sync <slug> [--ticket <KEY>]` does the same from the command line. Before, a pull request that merged or got a review waited for Loom's next check, which is every 5 minutes and up to 30 minutes after failed reads, and the only way to hurry it was to message the planner.
  - The read happens in the engine's next pass as an ordinary check, so a merge completes the ticket, a close blocks it and new feedback starts a fix round, exactly as the regular check would. A pull request Loom is reading at that moment is not read again; the sync waits for that read's answer.
  - It goes past a ticket's wait after server errors or timeouts, and past a host's wait after network failures, because the human may have just fixed what failed. A read that fails again continues the same streak, so the project still pauses after an hour of failures. It does not go past a rate limit, and says how long the limit lasts instead.
  - It waits up to 30 seconds for the reads, then says in a toast what each one found: merged, blocked, a fix round, still open, a failed read with its error and when Loom reads it again, or still being read. A read that failed, waits or still runs makes the toast a warning. The page updates when a slow read finishes.
  - A sync changes nothing the human decides, so its buttons need one click and it writes no `human.action` event; the command still refuses Loom's own agent threads with `loom_human_only`.

### Compatibility

- No migration. The page's RPC gains `syncPullRequests`, which takes `confirm: true` and refuses other plugins as every change does.

## 0.25.0 (2026-10-27)

### Fixed

- Commits someone else pushed to a ticket's pull request branch, such as a reviewer's own fix or a forge's "update branch", no longer stall a worker on a machine of its own. Before, Loom told the worker to fetch the branch and merge it. An Aquifer World sandbox can fetch and keep merges of main only, so it could not. On any other machine the merge was lost when the work came home, because Loom rebuilds that work on the checkout as one commit; the push then found the branch diverged again and sent the worker back, with no limit.
- Loom now merges those commits itself, on the project's checkout, using the commit it last pushed there as the merge base. git's own merge base, from before the ticket's work, would make an edit of a line the ticket wrote conflict.
  - At the start of a fix round, for a ticket whose work came home from another machine, Loom fetches the branch onto `refs/loom/<slug>/<key>/tip` and merges it into the head. It then carries the result into a live worker's worktree as linear commits, or leaves it on the home branch for the next worker's `loom_resume`. The fix round's message says the merge is done, and the next push builds on that tip. A worker on the project's machine is still told to merge the commits itself, which works there.
  - Commits that arrive while the worker fixes are merged before the push, for every worker, as a restack is: Loom puts the result in the worker's worktree, runs the ticket's checks there and pushes with no new review. On another machine a conflict arrives with conflict markers, which a submit may not keep. On the project's machine a conflict goes back to the worker to merge the fetched tip, and a worktree with other work is left alone. A push that finds the branch moved again merges up to three times, then sends the fix back.
- When the pushed commits merged a newer base branch in, the worker's changes are still measured as its own. The carry starts the machine's worktree on that newer base and fetches the base branch there when it lacks it. A stacked ticket first merges the base branch into the commit it is stacked on.

### Compatibility

- No migration. A ticket's `pushed_sha` is now the pull request branch's tip that Loom accounts for, which can be a commit someone else pushed once Loom has merged it. The host entry gains `fetchTip` and `pointRefs`, `mergeOnto` takes an optional `base`, and `carryStart` fetches the remote's base branch when that branch lacks the base. A ticket post's `outcome` may be `tip_merged`. Merging needs git 2.40 or newer on the project's machine, for `git merge-tree --merge-base`.

## 0.24.0 (2026-10-27)

### Added

- Stacked pull requests with threads on new machines. `merge.stack` now works with `environment.machine`; `loom_propose` refuses only the integration strategy there. Loom makes every stack merge on the project's checkout and puts only linear commits on a machine, which may keep no merge commit. A stacked ticket's first worker carries in the commit it is stacked on with `loom_resume`, as one commit on the fresh base. Its scope is measured from that commit's tree, and its work comes home rebuilt on the commit it is stacked on, so the reviewers' diff and its pull request, opened on the dependency's branch, are its own.
- When a dependency's pull request changes or merges, Loom merges the dependent's head with the new commit on the checkout with `git merge-tree` (the new host call `mergeOnto`). It carries the result into the worker's worktree on its machine, replacing the reviewed work there, runs the checks there and pushes with no new review; after a merge it also moves the pull request to the base branch. A conflict is carried in with conflict markers, and a submit that still has them fails a "conflict check", so a commit with markers is never brought home as a submit or pushed. A worktree with other work than the reviewed tree is left alone and the ticket goes back to its worker.
- A worker on a new machine is not released while its ticket has a dependency in its repo that has not merged, since its machine cannot come back and those merges run in its worktree.
- `ci`, in `[checks]` for the project and on each `[[repo]]`: whether Loom relies on the pull request's CI for every test the plugin's checks do not run. Unset is `true` on the pull request strategy; the key is refused on the integration strategy.
  - `ci = true`: the plugin's checks are the cheap ones that run where each thread runs. The worker brief says every other test runs in the pull request's CI, not to block, fail or loop on a test the environment cannot run, and to name the tests it did not run in `loom_submit`. The reviewer brief says not to request changes only because a test was not run there. A fix round for a failed CI check says CI may run tests the worker cannot. Pending and failing CI shows on a ticket's board card and on the next-step bar, as well as on the Merge order tab.
  - `ci = false`: Loom ignores the repo's CI. Its plugin checks are the whole bar, the briefs say so, and a failed CI check starts no fix round; reviews, review threads, comments and your replies still do.
  - `loom_propose` refuses a repo that relies on CI through a forge that reports no checks (`kind = "command"` without `feedback`, or `kind = "none"`), naming both fixes: add a `feedback` command, or set `ci = false` for it.
- The spec reference's World example follows a Delta pull request's CI with a `feedback` command over `dt pr view` and `dt pr checks`, checked against a live pull request.

### Changed

- A spec version that adds or removes `machine` on a running project moves only new threads, and each ticket in flight has a defined behaviour (a table in the spec reference). Loom now decides about a thread that already runs by its environment's machine, not by the spec: a machine move's idle is still not counted after the spec moves workers off machines; `loom_resume` stays offered while it is pending; a reviewer on the project's machine starts from the home branch only when the head came home, else from the worker's branch; and a released worker's post says where the next worker takes over from by the same fact.
- On another machine, the worktree checks of a stacked ticket (after the checks, a reviewer's verdict, a release) measure from the fresh base, since the commit it is stacked on exists only on the checkout.
- `loom_checkout` carries a stacked ticket's reviewed work as two commits, the commit it is stacked on and then the ticket's own, so a reviewer on a machine reads its changes with `git diff HEAD~1`.

### Compatibility

- A spec without `ci` relies on CI. Compared with 0.23.0, a gh or `feedback` forge sends failed CI checks back as before, now with guidance in the briefs. A stored spec whose forge reports no checks keeps running as `ci = false`, but a revision of it is refused until it sets `ci = false` or adds a `feedback` command.
- No migration. `stack_json` may hold `markers`. The host entry gains `mergeOnto` and `conflictMarkers`; `importCommit` takes `parent`, `worktreeState` takes `baseTree` and reports `onBase`, `carryStart` takes `replaces`, and `stackBase` reports the tree it built. Projects without `machine` run as before, apart from a reviewer's start reading the reviewed ref.

## 0.23.0 (2026-10-27)

### Added

- Threads on new machines. `machine = { provider, inputs }` in an `[environment]`, or in its `reviewer` table, starts each worker and reviewer on a new machine of its own from any bb machine provider, including an environment that makes the machine itself. `loom_propose` checks the machine provider and its inputs against bb, and refuses an environment that makes its own machine unless the spec names that machine provider. Reviewers follow the workers unless the `reviewer` table names another provider. Such a repo needs `merge.strategy = "pr"` with `merge.stack = false`.
- Loom carries commits between the project's checkout and those machines itself, through its host entry, checked by tree. A submit that passes is rebuilt on the checkout as one commit with the worker's tree, author and message, on `loom/<slug>/<key>-home`, with `refs/loom/<slug>/<key>/reviewed` keeping the reviewed one; it is the ticket's head for review, the pull request and the Changes tab. Only the tree the checks passed comes home: a commit made after the checks is refused, counting no failure. A file over 100 MiB is refused before anything is copied.
- A work-in-progress save is carried back when the worker's thread ends. While that fails, Loom keeps the stopped thread, and so its machine, for up to 10 minutes, then ends it and says on the ticket that the work did not come home. A worker that ends before `loom_resume` commits on its machine but brings nothing home, so the next worker resumes the same work.
- `loom_resume`, for a worker on a new machine: a worker that comes back starts at the fresh base and carries in the work on the home branch; `loom_submit` waits for it. A `machine` change between attempts keeps the work: a worker on a new machine after one on the project's machine resumes from that worker's branch, and a worker on the project's machine starts from the home branch, or from the last worker's branch once that builds on it. A released worker on a new machine cannot come back, and its post says the new worker takes over from the work Loom brought home.
- `loom_resume` and `loom_checkout` refuse a worktree with uncommitted changes, or with commits that are not on the base, instead of dropping them, and say to stash them. A worktree that has the tree already is left as it is, and a carry that fails part-way puts the worktree back at the base. Files committed with `git add -f` over a `.gitignore` carry too.
- `loom_discover` lists the environments that start each thread on a new machine, and the environments earlier approved projects chose for a repository with the same git remote. The loom-plan skill proposes one on every project and confirms it with the human.

### Changed

- Every reviewer calls `loom_checkout` first instead of running `git checkout --detach`: it checks the reviewed commit out on the project's machine, or carries its tree to a reviewer on a machine of its own. The verdict tools refuse until the worktree has the reviewed tree.
- Loom compares trees instead of commit ids for the worktree check after the checks, an unchanged fix round, a reviewer's verdict and a worker's release.
- A machine provider that cannot start a machine now (bb's `machine_provider_rejected`) is a wait, as an unavailable environment provider is, and an idle caused by bb moving a thread's machine (`machine_maintenance`) counts toward neither a nudge nor ending the thread.

### Compatibility

- A migration adds `tickets.head_tree`, `threads.resume_json` and `threads.maintenance_seq`. Projects without `machine` run as before, apart from reviewers calling `loom_checkout`.

## 0.22.0 (2026-10-26)

### Changed

- Only threads at work count against `max_workers` and `max_reviewers`. A worker or reviewer waiting for the human's answer to a question holds no slot, so other work runs in its place; Loom asks bb which threads wait only while every slot is held and work waits for one.
- A worker's ticket timeout starts when its work gets a slot, not while it waits for one, and the Agents tab shows no countdown meanwhile.
- A reply you post on a ticket whose work waits for a slot, and a cross-repo dependency's new commit, reach the worker together with that work instead of starting a turn on their own. The resume message skips such a worker: its work is its next turn.
- A review's requested changes and a merge that did not land are kept until bb takes them and sent again after a failed send or a restart, as a fix round's message already was.
- The health strip counts the workers that hold a slot, and the tickets waiting to go back to their workers. The next-step bar names the tickets that wait for a slot instead of counting them as workers at work.

### Fixed

- `agents.max_workers` holds when work goes back to workers. A pull request's fix round, a review's requested changes and a merge that did not land used to message the worker at once, so when several open pull requests got reviews or failed checks together, all of their workers started together: in one project with `max_workers = 2`, ten tickets went back to their workers within seven minutes. Each now moves its ticket to working and waits for a free worker slot, with a post on the ticket and "Waits for a free worker slot" on its card. A released worker is brought back only once it has a slot. Waiting work takes free slots before any new ticket starts, priority 0 first, then the work that has waited longest.
- A worker writing its pull request holds a worker slot, and Loom asks for it only when a slot is free.

### Compatibility

- The ticket column `pr_deliver_json` is renamed `handback_json`; a fix round's message stored before the upgrade is sent as before. Loom 0.21 does not know the new name, so going back to it needs the database from before the upgrade.

## 0.21.2 (2026-10-26)

### Changed

- The Loom page remembers where you left it, on this device. Coming back from a thread or another page through the Loom icon in the rail reopens the page you were on, a ticket, a project or a planning conversation, instead of home; each project opens on the tab you left it on instead of the Board; each view scrolls back to where you were; and the sidebar keeps its Done and archived group open or folded. Home has its own address, `/plugins/loom/loom/_home`: the sidebar's Home opens it, and the page replaces the rail's bare `/plugins/loom/loom` with the place it reopens, home included, so Back walks back through the pages instead of bouncing forward. Clicking the sidebar item for the page already shown adds no history entry. A rewound Timeline moment is not kept: the page reopens at now.

## 0.21.1 (2026-10-26)

### Fixed

- 0.21.0 could not be installed or updated from git: bb installs a git plugin's `dependencies` only, and the host entry now runs git and `gh` through the SDK's VCS scheduler, which the host bundle carries itself. `@get-bb/plugin-sdk` is now a dependency, pinned at 0.6.75, the newest version some package proxies serve. Loom needs plugin SDK 0.6.75 or later in bb, and bb 0.47.

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

### Changed

- A connection that timed out ("connection timed out" or "i/o timeout") now counts as a network failure, which waits for the whole host, instead of a server error, which waited for each pull request on its own.

### Fixed

- A network or name lookup failure no longer pauses a project. When Loom's read of an open pull request cannot reach the forge, because the host's name did not resolve, no connection opened, or gh says it could not connect, Loom reads no pull request on that host, in any project, for 5 minutes, then 10, 20 and 30 while the failures go on. One failed call counts once, however many pull requests it asked for, so a machine whose resolver keeps losing names costs one failed read per wait instead of one per pull request. Loom never reads again to retry; it only waits longer between the reads it already makes. The first ticket whose read failed gets one post, the ticket page's next check time shows the wait, and the first read to that host that works clears it. The project pauses only after an hour of failed reads to the host with none working in between, with a reason that names the host, the error and how long it lasted.
- A command forge's `state` and `feedback` commands now get the same waits as `gh`. When one fails or times out, Loom reads its output by the rules it uses for gh's errors. A network failure waits as above, for the pull request URL's host only, so a Delta failure stops reads to delta.shopify.io while GitHub keeps being read. A server error or a timeout makes that pull request's next read wait 5, 10, 20, then 30 minutes, as a GitHub server error does, and a rate limit stops reads to the host for 15 minutes or more. A command that fails for any other reason, such as a missing login or a pull request the forge cannot find, still pauses the project, and so does one that succeeds but prints no state or no feedback object, since that is a bug in the command. The posts and pause reasons name the forge's host instead of GitHub.

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

### Changed

- Following a pull request through `gh` asks GitHub for less. The query no longer asks for the steps of every check run, which on a pull request with many checks (88 on one) took 6 to 11 seconds, long enough for GitHub to time out and answer 502. Loom now asks for steps only while a check has failed and others are still running, in a second small query for at most 20 running check runs, because it uses them only to tell how far a running check got. When that second query fails, Loom carries on without the steps. Loom still reads each pull request once per poll and never repeats a failed read within it.

### Fixed

- One GitHub server error no longer pauses a project. When GitHub answers Loom's read of an open pull request with HTTP 500, 502, 503 or 504, times out or drops the connection, Loom waits longer before that pull request's next read (5, 10, 20, then 30 minutes) instead of pausing. The ticket gets one post when the failures start, the ticket page's next check time shows the wait, and the first read that works clears it. The project pauses only after an hour of failed reads, with a reason that names the pull request, the error and how long it lasted.
- A GitHub rate limit no longer pauses a project either. Loom stops reading pull requests on that GitHub host, in every project, for 15 minutes, doubling to an hour while the limits go on, and longer when GitHub names a later time. The ticket whose read was limited gets one post per backoff. Any other failed read, such as a missing `gh` login or a pull request GitHub cannot find, still pauses the project as before.

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

### Added

- Settings `checksQueuedMinutes` (5 by default; 0 waits for queued checks) and `checksNearDonePercent` (75 by default; 0 waits for every running check), and the spec keys `merge.checks_queued_minutes` and `merge.checks_near_done_percent`, which override them for one project. The Spec tab shows the spec keys when they are set.
- A command forge's `feedback` output may give each check `started`, `started_at`, `completed_at` and `progress`. Through `gh`, Loom reads each check run's status, start and end times and job steps.
- A `check_durations` table that keeps how long each passed check took, by forge repository, the newest 20 runs of each check.

### Changed

- On the pull request strategy, failed checks no longer wait for every pending check. A check still queued 5 minutes after Loom first saw it, or after the push, stops holding them back, so the worker starts on them sooner. A running check holds them only while it is at least 75% along, by the forge's own progress, its time so far against the median of its last 5 passed runs on the same forge repository, or its GitHub Actions job's finished steps; one running for more than twice its usual time stops holding. A check Loom cannot measure, and every commit status, holds until `checksSettleMinutes` after the push, as before.
- The fix round's message and its post on the ticket list the pending checks Loom did not wait for, and why.

## 0.16.0 (2026-10-23)

### Added

- A `commentSignature` setting, "Posted by Loom" by default. On the pull request strategy a worker posts from your account, so it now ends every comment and reply it posts on a pull request with this line. It takes Markdown, such as `<sub>Posted by Loom</sub>` for small text on GitHub, and an empty value turns it off. The fix-round message carries it, and so does the brief of a worker that resumes on an open pull request.

### Changed

- The README is reorganized and shorter: install and quick start first, the page by tab with screenshots, and one section for pull requests.

### Fixed

- The Spec tab's How it runs cards no longer overflow beside the review panel. The cards are laid out by the width of their own column instead of the whole page, use three columns only from 64rem, stack each label above its value when a card is narrow, and fill the gap a wide card leaves. A model name breaks after its slash instead of inside a word, and the slot squares wrap.
- The Planner tab's strip counts the questions the planner waits on, so one round of four questions reads "Waiting on you · 4 questions" instead of "1 question".

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

### Changed

- The ticket page is wider: up to 90rem instead of 72rem, with a side column of 20rem, or 24rem on a wide page, instead of 300px.
- Hide details folds the side column away so the activity takes the full width, and Show details brings it back. The page remembers the choice for every ticket.

### Fixed

- The ticket page's side column (acceptance criteria, files in scope, verify command and agents) no longer scrolls on its own, in either direction. It scrolls with the page and stays pinned beside the activity only while all of it fits in the window. Long words in the criteria wrap, and backticked text shows as code.

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
