# Loom spec reference

A Loom spec is one TOML document. `loom_propose` parses it with a strict schema: an unknown key is an error, and every error names its TOML path and the fix. Tickets are numbered from 0 in the order of the `[[ticket]]` tables, so `ticket[2]` is the third one.

Workers, the plugin's checks, reviewers, merging, budgets and triage all use these settings.

A spec without `[[repo]]` tables is a single-repo project: every ticket runs in the repository of the bb project the planner thread belongs to. A spec with `[[repo]]` tables spans those repositories, and every ticket names the one it changes (see [[repo]] and the second example below).

## Tables and keys

### [project]

| Key | Type | Default | Rule |
|---|---|---|---|
| `slug` | string | required | `^[a-z][a-z0-9-]{1,39}$`; names the project and its sidebar section |
| `name` | string | required | 1 to 80 characters |
| `key` | string | required | `^[A-Z][A-Z0-9]{1,7}$`; the ticket key prefix (`CSV` gives `CSV-1`); unique across all projects, archived ones included |
| `goal` | string | required | 20 to 4000 characters |
| `summary` | string | required in every proposal | 20 to 300 characters; one or two plain sentences that say what the project changes and why, for the project page's About strip and Loom's home list. A spec stored before summaries existed still loads, and shows its goal's first paragraph instead, but its next revision must add one |
| `done_when` | string array | none | at most 20, each up to 300 characters; what must be true for the project to be done, one line each, shown under the summary |
| `non_goals` | string array | `[]` | at most 50, each up to 500 characters |
| `base` | string | `"main"` | the branch work starts from; a plain git name; the default `base` of every `[[repo]]` |
| `open_questions` | string array | `[]` | must be empty |

### [merge]

| Key | Type | Default | Rule |
|---|---|---|---|
| `strategy` | string | required | `"integration"` (approved work merges into one branch) or `"pr"` (one pull request per ticket) |
| `branch` | string | `loom/<slug>` | integration strategy only; a multi-repo project has an integration branch of this name in every repo |
| `remote` | string | `"origin"` | a plain remote name; the default `remote` of every `[[repo]]` |
| `draft` | boolean | `true` | whether pull requests open as drafts |
| `forge` | table | `{ kind = "gh" }` | where pull requests open; see [merge.forge] |
| `worktree` | table | none | integration strategy only; prepares the integration worktree; see [merge.worktree] |
| `describe` | string | `"worker"` | pr strategy only; who writes each pull request's title, description and commit message: `"worker"` (the ticket's worker, with `loom_pr`, after approval) or `"loom"` (Loom's template from the ticket) |
| `squash` | boolean | `true` | pr strategy only; push the reviewed work as one commit, and each fix round as one more, instead of the worker's branch as it is |
| `max_fix_rounds` | integer | `5` | pr strategy only; 0 to 20; fix rounds the pull request's checks and reviews may start before the ticket blocks, counted again from each requeue; the human's replies do not count; `0` follows only merged and closed |
| `stack` | boolean | `true` | pr strategy only; a ticket starts once its dependencies' pull requests are open, on top of them in its own repo, and its pull request opens on its one open dependency's branch; `false` waits for each dependency to merge |
| `release_workers` | boolean | `true` | pr strategy only; once a ticket's pull request is open and its worker is idle, Loom archives the worker's thread so bb frees its environment, and brings the same thread back with a new environment for a fix round or a catch-up; `false` keeps every worker and its environment until its pull request merges; a pending version may change it after approval. See [Releasing workers](#releasing-workers) |
| `checks_queued_minutes` | integer | Loom's `checksQueuedMinutes` setting (`5`) | pr strategy only; 0 to 1440; a pending check that is still queued this many minutes after Loom first saw it, or after the push, no longer holds back the failed ones; `0` waits for queued checks too |
| `checks_near_done_percent` | integer | Loom's `checksNearDonePercent` setting (`75`) | pr strategy only; 0 to 100; once a check has failed, a running check holds back the fix round only while it is at least this far along; a check Loom cannot measure, and every commit status, keeps holding it; `0` waits for every running check. See [When failed checks go to the worker](#when-failed-checks-go-to-the-worker) |
| `git_network_timeout_seconds` | integer | `120` | 30 to 600; how long each git fetch, `ls-remote` or push Loom runs in the repo may take, such as fetching the base branch to bring a stacked pull request up to date, building a pull request's commit, or pushing it; a host call that runs two of them in a row gets twice this plus 30 seconds; the default of every `[[repo]]`. Raise it for a large monorepo, where fetching main takes a minute or more; a version approved after the project started applies from Loom's next pass. See [Slow repositories](#slow-repositories) |

### [merge.forge]

The server that hosts pull requests. Leave it out for GitHub: Loom opens and follows pull requests with `gh`. `loom_propose` refuses a spec whose remote pushes to a host `gh` is not signed in to, until this table says how to reach that server.

| Key | Type | Default | Rule |
|---|---|---|---|
| `kind` | string | required | `"gh"`, `"command"` (the `open` and `state` commands below) or `"none"` (Loom only pushes the branch) |
| `open` | string | none | required with `kind = "command"`, refused otherwise; a shell command that opens a pull request for a branch that is already pushed |
| `state` | string | none | required with `kind = "command"`, refused otherwise; a shell command that prints the pull request's state |
| `feedback` | string | none | `kind = "command"` only; a shell command that prints the pull request's checks and review feedback, so Loom can start fix rounds; without it Loom follows only merged and closed, and a repo on this forge must set `ci = false` (see [Relying on CI](#relying-on-ci)) |
| `after_open` | string array | none | at most 5; shell commands run once after a pull request opens, such as one that starts CI; a failure is posted and blocks nothing; not allowed with `kind = "none"` |
| `retarget` | string | none | `kind = "command"` only; a shell command that moves an open pull request to another base branch, which Loom does when a stacked pull request's dependency merges; without it Loom asks you to move it by hand; a failure is posted, asks you to move it by hand and blocks nothing |
| `after_push` | string array | none | at most 5; shell commands run after each push Loom makes to an open pull request (a fix round, a catch-up with a dependency or the base branch, someone else's commits merged in, a land's push) and after Loom moves one to another base, such as one that starts CI again or marks the pull request ready once it builds on the base branch; a failure is posted and blocks nothing; not allowed with `kind = "none"` |

The commands run with `/bin/sh` in the repo's checkout, with a 2-minute limit (`after_open`, `after_push` and `retarget`: 5 minutes):

- `open` gets `LOOM_REMOTE`, `LOOM_BASE`, `LOOM_HEAD` (the pushed branch), `LOOM_TITLE` and `LOOM_DRAFT` (`1` or `0`), and reads the body on standard input. Loom takes the last `http(s)://` URL it prints as the pull request. When one is already open for the branch, it must print that one: a restart can run it again.
- `state` gets `LOOM_URL` and `LOOM_PR_NUMBER` (the last run of digits in the URL). The first word of its last non-empty line must be `open`, `merged` or `closed`, in any case. Merged completes the ticket; closed blocks it. It tells Loom nothing else, so on a forge with only `state` the Merge order tab cannot say whether a pull request is a draft or approved, and a merge into another branch completes the ticket.
- `after_open` gets `LOOM_URL`, `LOOM_PR_NUMBER`, `LOOM_HEAD` and `LOOM_BASE`.
- `retarget` gets `LOOM_URL`, `LOOM_PR_NUMBER` and `LOOM_BASE`, the branch to move the pull request to.
- `after_push` gets `LOOM_URL`, `LOOM_PR_NUMBER`, `LOOM_HEAD` (the pull request's branch), `LOOM_SHA` (the commit it now has) and `LOOM_BASE`, the branch it builds on now: its dependency's branch while it is stacked, the repo's base branch once that dependency merged and Loom moved it. So `[ "$LOOM_BASE" != main ] || dt pr ready "$LOOM_PR_NUMBER"` marks a stacked pull request ready once it builds on main; in `after_open` too, it marks one that opens on main ready right away, since `after_open`'s `LOOM_BASE` is also the branch the pull request opened on.
- `feedback` gets `LOOM_URL` and `LOOM_PR_NUMBER`, and prints one JSON object on its last non-empty line:

  ```json
  {"state": "open", "head": "<sha of the pull request's head>", "author": "<the pull request's author>",
   "checks": [{"id": "1", "name": "lint", "state": "failed", "url": "https://ci.example.com/1"},
              {"id": "2", "name": "test", "state": "pending", "started": true, "started_at": "2026-10-24T10:00:00Z", "progress": 60}],
   "items": [{"id": "r7", "kind": "review", "author": "alice", "bot": false, "body": "Rename it.", "state": "changes_requested", "url": null, "path": null, "line": null}]}
  ```

  `state` is `open`, `merged` or `closed`. A check's `state` is `pending`, `passed`, `failed` or `neutral`. An item's `kind` is `review`, `thread` (an unresolved review thread, with `path` and `line`, whose `author` is its latest comment's) or `comment`. A pending check may say whether it `started` (`false` while it waits in a queue) and how far it got as `progress`, 0 to 100; any check may give `started_at` and `completed_at` as ISO 8601 times, and the times of passed checks give Loom their usual durations. The object may also give the pull request's `draft` (`true` or `false`), its `review` decision (`approved`, `changes_requested` or `review_required`, in any case) and the `base` branch it targets; Loom shows the first two on the Merge order tab, and with `base` it blocks a ticket whose pull request merged into a branch other than the repo's base instead of completing it. `author`, `checks`, `items`, `bot`, `url`, `state`, `path`, `line`, `started`, `started_at`, `completed_at`, `progress`, `draft`, `review` and `base` may be left out, and a null `draft`, `review` or `base` means the forge cannot tell. An `id` must stay the same while the thing it names does not change, and change when it does (a check that runs again, an edited comment, a new reply in a thread): Loom sends each id to the worker once.

When `state` or `feedback` exits non-zero or runs out of time, Loom reads the end of its output as it reads gh's errors: a network failure, a server error or a rate limit is waited out instead of pausing the project, and anything else pauses it. A JSON line in that output counts only for its `message` and `errors` fields. So a command should exit non-zero when its CLI fails, for example with `set -eu` and without piping a failed call into another command, because one that exits 0 and prints the error instead of a state pauses the project.

With `kind = "none"`, Loom pushes the ticket's branch and says where; a person opens the pull request. The ticket is done when the remote's base branch contains the ticket's exact commit, so a squash or rebase merge is not seen: block or cancel that ticket by hand. On the integration strategy, `bb loom land` pushes the integration branch and opens nothing.

### When failed checks go to the worker

On the pull request strategy, a failed check waits for the pending checks that hold it back, and goes to the worker as a fix round once none does, or once Loom's `checksSettleMinutes` setting (30 minutes) has passed since the push, whichever comes first:

- A check still queued `checks_queued_minutes` after Loom first saw it stops holding. A check on Loom's first reading of its own push counts from the push.
- A running check holds only while it is at least `checks_near_done_percent` along. Loom reads how far it got from the forge's own `progress`, else from its time so far against the median of its last 5 passed runs on the same forge repository, else from a GitHub Actions job's finished steps. A check running for more than twice its usual time stops holding.
- A running check Loom cannot measure, and every commit status (it says only pending), holds until the settle time.

The fix round's message lists the pending checks Loom did not wait for, and why. They run again on the worker's fix commit; when the fix changes nothing, Loom follows their results on the same commit.

### [merge.worktree]

Integration strategy only. Loom normally adds its own git worktree of the integration branch in its data directory; some repositories refuse worktrees outside their own location. `loom_discover` says when, with git's message, and `loom_propose` then refuses the integration strategy until this table is set.

| Key | Type | Default | Rule |
|---|---|---|---|
| `command` | string | required | a shell command that prepares a checkout of the repository and prints its absolute path on its last line |
| `plugin` | string | none | a bb plugin id; Loom then runs `bb plugin run <plugin> <command>`; the plugin must be installed and turned on, and the command's first word must be one of its CLI commands |

The command runs in the repo's checkout before every merge and land, with a 10-minute limit, so it must be safe to run again. It gets `LOOM_PROJECT_SLUG`, `LOOM_BRANCH` (the integration branch) and `LOOM_BASE`. The path must be a checkout of the same repository; when it is on another branch and has no uncommitted changes, Loom switches it to the integration branch.

### [environment]

Where the threads Loom starts in the repository run: its workers and reviewers, the spec reviewer and the agent that summarizes a finished project. Leave it out for a git worktree per thread, which is what bb's `git-worktree` provider makes. `loom_propose` refuses a spec that leaves it out while a plugin offers an environment provider for the repository on this machine; `provider = "git-worktree"` keeps plain worktrees.

| Key | Type | Default | Rule |
|---|---|---|---|
| `provider` | string | required | the id of a bb environment provider that is available for the project on this machine (`bb environment providers --project <id> --machine <host> --json`) |
| `inputs` | table | none | the provider's inputs, checked against its inputs schema; a provider that needs inputs refuses a spec without them |
| `machine` | table | none | `{ provider = "<id>", inputs = { … } }`: start each thread on a new machine of its own from this bb machine provider (`bb machine providers --json`), with its inputs checked against its schema; required, with the composition's own machine provider, when `provider` is an environment that makes a new machine per thread. See [Threads on new machines](#threads-on-new-machines) |
| `reviewer` | table | none | where reviewers, the spec reviewer and the summary agent start instead: `provider` (another provider; its own `inputs` then, none by default) or `inputs` alone, a merge patch over `inputs` for the same provider; checked against the provider's schema like `inputs`. Reviewers follow the workers' `machine`, unless the table names another provider, which drops it; its own `machine` replaces it |

In any string of `inputs`, or of a `machine`'s `inputs`, Loom replaces `{branch}` with a new branch for that thread (`loom/<slug>/<key>-<attempt>` for a worker, `loom/<slug>/<key>-review-<round>-<n>` for a reviewer) and `{base}` with where the thread starts, the same base it would give a worktree. Any other `{name}` is an error.

A merge patch works as in RFC 7396: a table merges key by key, and any other value, an array included, replaces the value it patches. TOML has no null, so a patch in the spec sets keys but cannot remove one.

Reviewers judge the diff and the code around it at the ticket's commit; Loom runs the checks in the worker's worktree, never in a reviewer's. So a reviewer can use a lighter environment, such as fewer of a large repository's directories or no setup step. In a provider's environment, the reviewer brief says to read any file at the ticket's commit with `git show <commit>:<path>`, checked out or not, and the other repos of a multi-repo project stay at their checkouts on the machine.

A ticket can narrow its repo's environment with its own `environment.inputs` (see [[ticket]]), for example to ask for only the directories it changes. Its workers and its reviewers get it, applied after the `reviewer` patch, when they use the repo's provider; a reviewer in another provider does not.

#### When an environment provider has no room

Loom tells a thread that bb or the provider cannot start now from one that failed:

- When a provider's availability check answers `unavailable` for the machine, bb refuses the new thread with `environment_provider_rejected` and that status, and Loom waits and tries again without counting an attempt: after 1 minute, then twice as long each time, up to every 15 minutes. The same goes for any error bb marks `retryable`. The board says what the ticket waits for and when Loom tries again. A provider with a fixed amount of room can use this: answer `unavailable` while it has none. A ticket waits like this for at most an hour; then it blocks, with a reason that says the provider was unavailable and quotes its message, so triage hears of it. Its worker then counts as one that never started, so approving a pending spec version requeues it, and a ticket whose reviewer never started goes back to review.
- Any other failed start, a provisioning failure included (bb reports it as `thread_provisioning_failed`, with the provider's message as its detail), waits the same way. It counts against `budget.max_attempts` only once it has failed 4 times in a row, so a provider that runs out of room while provisioning does not block the ticket at once, and one that is broken still blocks it.
- A start bb refuses with another client error blocks the ticket at once, and a start that fails before Loom asks bb, such as a ticket whose repo the spec no longer lists, counts at once, as before.
- This holds for workers, for a released worker coming back (see [Releasing workers](#releasing-workers)), for reviewers (a reviewer that did not start is not one that ended without a verdict), for the spec reviewer (it fails after 4 failures in a row or an hour of an unavailable provider, the planner hears why, and proposing again tries at once) and for the summary agent (it tries again for up to 30 minutes, then the full record goes to the done hook).
- A worker that never started keeps its attempt number, its thread row and its claim on the ticket, so its retry asks for the same `{branch}`. A ticket resumed from a branch keeps that branch, unless bb could not find it and no pull request is open, and a ticket whose pull request is open always keeps it.

### Threads on new machines

With `machine`, every worker and reviewer of the repo starts on a new machine of its own, from any bb machine provider, instead of on the machine with the project's checkout. `loom_discover` lists the choices under "New machine per thread": the environments that make a new machine themselves (a composition, such as `provider = "example-world"`, `machine = { provider = "example-world" }`), and bb's `git-worktree` on each machine provider. It also lists the environments earlier approved projects chose for a repository with the same git remote. Loom knows no provider by name; it tells a thread on another machine by its environment's host.

- Only `merge.strategy = "pr"` works there, with `merge.stack` on or off: the integration branch is made on the project's machine, and Loom does not carry it to other machines. `loom_propose` refuses the integration strategy, naming the `machine` path. `merge.stack = false` makes each dependent wait for its dependencies to merge, as anywhere.
- The checks run on the worker's machine, as they do in any worktree, so they must work there.
- On a submit that passes, Loom carries the worker's commit back to the project's checkout itself, through its host entry: it reads the files the commit changed, rebuilds the same tree on the same base with a temporary index, refuses the result unless the tree matches, and commits it with the worker's author, date and message. That commit is the ticket's head: reviewers get its diff, and the pull request is built from it. It is on the branch `loom/<slug>/<key>-home`, which also gets each work-in-progress save, and `refs/loom/<slug>/<key>/reviewed` keeps the reviewed one. Only the tree the checks passed comes home: a commit the worker makes after the checks is refused, counting no failure, and the worker submits again. Files over 100 MiB cannot move between machines, and Loom refuses one before it copies anything.
- A worker whose work-in-progress save cannot be brought home when its thread ends keeps its stopped thread, and so its machine, while Loom tries again for up to 10 minutes. Then Loom ends it anyway, and says on the ticket that the work did not come home and why.
- Loom compares trees, not commit ids, wherever a commit crossed machines: the worktree check after the checks, an unchanged fix round, a reviewer's verdict and a worker's release. A machine that moves during the checks, and gives the same commit a new id, still passes.
- Commits someone else pushed to a ticket's pull request branch, such as a reviewer's fix or a forge's "update branch", are merged on the project's checkout by Loom itself, since a worker on a machine can neither fetch that branch nor keep a merge of it. The merge base is the commit Loom last pushed there: the ticket's head was rebuilt on the checkout and shares no history with the branch, so git's own merge base would conflict wherever someone edited a line the ticket wrote. At the start of a fix round Loom fetches the branch onto `refs/loom/<slug>/<key>/tip`, merges it into the head, carries the result into a live worker's worktree as linear commits, or leaves it on the home branch for the next worker's `loom_resume`, and then builds the next push on that tip. Commits that arrive during the fix are merged before the push: Loom carries the result in, runs the ticket's checks there and pushes with no new review, and a conflict arrives with conflict markers. When the branch merged a newer base branch in, the carry starts the worktree on that base and fetches the base branch there, so the worker's changes are measured from it; a stacked ticket first merges the base branch into the commit it is stacked on. A worker on the project's machine merges the fix round's commits itself, and before a push Loom merges later ones in its worktree, or sends a conflict back for it to merge `refs/loom/<slug>/<key>/tip`.
- A new machine is removed when its threads end, so it is never restored. A worker that comes back, after a block, a failed attempt or a release, starts at the fresh base on a new machine, and its first step is `loom_resume`, which carries in the work on the home branch. `loom_submit` is refused until it has. A worker that ends before it calls `loom_resume` commits its own changes on its machine, but Loom brings nothing home from it, so the next worker resumes the same work.
- `loom_resume` and `loom_checkout` refuse a worktree with uncommitted changes, or with commits that are not on the base, since putting the work in would drop them; stash them or move them to another branch, then call again. A worktree that has the tree already is left as it is, so calling again is harmless, and a carry that fails part-way puts the worktree back at the base.
- After a `machine` change in a pending version, the next worker, on either machine, continues from the ticket's newest work on the project's checkout: the last worker's branch when it builds on the home branch or there is no home branch, as after a worker on the project's machine, and the home branch otherwise. A branch that a provider copies to the checkout from another machine never counts.
- Every reviewer's first step is `loom_checkout`: on another machine it carries the reviewed tree there with ordinary worktree commands, and on the project's machine it checks the head out. The verdict tools are refused until the reviewer's worktree has that tree. A reviewer on the project's machine of a ticket whose head came home starts from the home branch.
- A machine provider that cannot start a machine now, because its pool is full or it is not set up, makes bb refuse with `machine_provider_rejected`; Loom waits as for an unavailable environment provider (see [When an environment provider has no room](#when-an-environment-provider-has-no-room)), posts bb's message on the ticket, and blocks after an hour.
- When bb moves a thread's machine and stops its turn, it records a `machine_maintenance` error; that idle counts toward neither a nudge nor ending the thread, and the next one does.

#### Stacked pull requests on new machines

Loom makes every stack merge on the project's checkout and puts only linear commits on a thread's machine, since a machine may keep no merge commit (World's sandboxes neither sync one to the laptop nor survive a move with one).

- A dependent starts once its dependency's pull request is open. The stack base, the commit it is stacked on, is built on the checkout as anywhere (one dependency's pull request commit, or a merge of several, on `loom/<slug>/<key>-stack`). The worker starts at the fresh base, and `loom_resume` puts the stack base in as one commit on it. On a machine, a stacked ticket's history is therefore the fresh base, one commit with the stack base's tree, and then its own work. `loom_resume` and `loom_checkout` carry earlier work, or the reviewed work, as one more commit on top.
- The scope check on the machine measures the worker's changes from the newest commit on its first-parent line whose tree is the stack base's, since the machine may give that commit a new id. A branch that no longer has it, after a rebase, a reset or a squash over it, is refused as a scope check, and the worker's brief says to keep it.
- Work brought home is rebuilt on the stack base itself, so the reviewers' diff, the pull request's commit and the Changes tab count only the ticket's own changes, and its pull request opens on its dependency's branch. A reviewer on another machine reads those changes with `git diff HEAD~1` after `loom_checkout`.
- When a dependency's pull request gets a new commit or merges, Loom merges the new stack base into the dependent's head on the checkout with `git merge-tree`, without a worktree. It carries the result into the worker's worktree as linear commits, replacing the reviewed work there, which the checkout keeps. It then runs the ticket's checks there, compared by tree, and pushes with no new review. After a merge it also moves the pull request to the base branch.
- A conflict is committed on the checkout as the tree with conflict markers and carried in the same way. The ticket goes back to the worker with the files to resolve, and `stack_json.markers` keeps them: a submit that still has a marker in one of them fails a "conflict check", so a commit with markers is never brought home as a submit or pushed. A check that fails on the carried result goes back to the worker too. A worktree that holds work other than the reviewed tree is left alone, and the ticket goes back to the worker with the reason.
- A worker on a machine is not released while its ticket has a dependency in its repo that has not merged: a released worker's machine is removed, and the merges that dependency causes run in its worktree. Once every dependency in its repo has merged and its branch has taken the base branch, it is released as usual. `merge.release_workers = false` keeps every worker, and its machine, until its pull request merges.

#### Moving a running project onto machines, or off them

Approving a pending version that adds or removes `machine` moves only the threads that start after it. A thread that runs stays where it is, and Loom decides about it by its environment's machine, not by the spec:

| Ticket state | Onto machines | Off machines |
| --- | --- | --- |
| working or checking | The live worker finishes on the project's machine, and nothing is carried. The next attempt starts on a new machine and resumes the last worker's branch with `loom_resume`. | The live worker keeps its machine. Its submits come home, `loom_resume` stays offered while it is pending, and a move of its machine is not counted. The next attempt starts on the project's machine from the home branch. |
| review | Live reviewers finish their round. New ones start on new machines and carry the head with `loom_checkout`. | Live reviewers finish. A new reviewer on the project's machine starts from the home branch when the head came home (its reviewed ref says so), else from the worker's branch. |
| approved | The pull request is built from the head on the checkout. A restack runs in the worker's own worktree. | The pull request is built from the commit that came home. A restack is merged on the checkout and carried to the worker's machine. |
| pr_open, live worker | Fix rounds go to it where it runs. | The same. |
| pr_open, released worker | bb restores its environment on the project's machine, where it ran. If it cannot, a new worker on a new machine resumes the last worker's branch. | Its machine was removed, so it cannot come back. A new worker on the project's machine starts from the home branch, and the post says so. |
| stacked children | A child whose worker runs on the project's machine restacks there. A queued child starts on a new machine on its stack base. | A child on a machine restacks through the checkout. Its next worker starts on the project's machine from the home branch, which builds on the stack base. |

### Releasing workers

On the pull request strategy a pull request can wait days for a person, and an idle worker would hold its environment all that time. With `merge.release_workers` (on by default), Loom archives the worker's thread once the ticket is in `pr_open`, the thread is idle with no question waiting, no fix round is on its way to it, its branch does not have to catch up, and its worktree holds exactly the reviewed commit with nothing uncommitted. bb then frees the environment after its provider's grace period. The worker stays the ticket's worker.

- When the pull request's feedback or your reply on the ticket starts a fix round, or the branch must take a dependency's new commits, Loom unarchives the same thread and asks bb to restore its environment on the worker's branch. Once it is ready, the worker gets the fix round with a note that files git ignores (installed dependencies, build output) are gone, and it keeps its whole conversation. A catch-up runs in the restored worktree with no message, and a check that fails there goes to the worker with the same note and counts no failure.
- A restore that fails waits and tries again, as a failed start does; after 4 failures in a row, or when bb cannot restore the environment (its provider has no restore, or the thread was deleted), a new worker takes the ticket from its branch. A worker on a new machine never comes back, since bb removes the machine; the new worker takes over from the work Loom brought home, with `loom_resume`. So a worker on a new machine is not released while its ticket has a dependency in its repo that has not merged, whose new commits must reach its worktree. A provider that stays unavailable for an hour blocks the ticket instead, and a requeue starts the new worker. Its brief names the earlier workers' threads, which it can read with `bb thread log <id> --all`.
- Fix-round counting, `merge.max_fix_rounds`, `merge.describe`, stacking, tokens and the page work as before.
- `merge.release_workers = false` keeps each worker and its worktree until its pull request merges, as Loom did before this setting; choose it when a worktree holds set-up state that takes long to build again and environments cost little.
- A spec version approved after the project started may turn it on or off; it applies from Loom's next pass. A worker released before it was turned off still comes back for its pull request's next fix round.

### Slow repositories

Loom runs git's network steps in a repo's checkout: it fetches the base branch before it brings a stacked pull request up to date, runs `ls-remote` and may fetch the branch when it builds a pull request's commit, and pushes. Each step may take `git_network_timeout_seconds` (120 by default), and the host call around it twice that plus 30 seconds. A step that runs longer is stopped and the project pauses with the git error, or with "host plugin call … exceeded its deadline", and resuming pauses it again while the fetch stays that slow.

- Time the fetch in the repo's checkout, for example `time git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main`, and set `git_network_timeout_seconds` comfortably above it on that `[[repo]]`, or on `[merge]` for a single-repo project. Fetching main of the World monorepo takes 50 to 80 seconds, so 300 leaves room.
- To change it on a running project, propose a revision with the new value; it applies once the version is approved. The project's pull requests, workers and tickets are unchanged.
- The setting covers git only. `gh`, the forge's commands and the first checkout of an integration worktree keep their own 2-minute limits.

### [checks]

| Key | Type | Default | Rule |
|---|---|---|---|
| `commands` | string array | `[]` | at most 10; run on every submitted ticket, except in a repo whose `[[repo]]` table sets its own `checks` |
| `after_merge` | string array | `[]` | at most 10; run on the merged integration branch, which they must leave as they found it (no new commit, no edited tracked file) or the merge is rolled back; not allowed with strategy `"pr"`; a repo that sets its own `after_merge` runs that instead |
| `timeout_minutes` | integer | `15` | 1 to 29 |
| `ci` | boolean | `true` | strategy `"pr"` only; `true` relies on the pull request's CI for every test the plugin's checks do not run, `false` ignores it and makes the plugin's checks the whole bar; a repo's own `ci` replaces it; see [Relying on CI](#relying-on-ci) |

### Relying on CI

On the pull request strategy, the plugin's checks (`commands`, a repo's `checks` and a ticket's `verify`) are the cheap ones that run where each worker runs, and the pull request's CI is the authority for every other test: one that needs a container runtime or a service the worker's machine does not have, or a suite too slow to run on every submit. `ci` says, per repo, whether Loom relies on it.

- `ci = true`, the default: Loom relies on the pull request's CI.
  - The worker brief says the plugin's checks are the cheap ones and every other test runs in the pull request's CI. It tells the worker to run what it can, not to block, fail or loop on a test its environment cannot run, and to name in its `loom_submit` summary the tests it did not run. The reviewer brief says not to request changes only because a test was not run where the reviewer is, and to request them when the work lacks a test the ticket needs.
  - Once the pull request is open, a failed CI check goes to the worker as a fix round, as described in [When failed checks go to the worker](#when-failed-checks-go-to-the-worker), with a note that CI may run tests the worker cannot run. The fix goes through the checks and a review before Loom pushes it, and a ticket stacked on this one takes the pushed fix through its restack.
  - A ticket's failing and pending CI checks show on its board card, on the next-step bar while the project runs, and on the Merge order tab.
  - It needs a forge that reports checks: `gh`, or `kind = "command"` with a `feedback` command. `loom_propose` refuses a repo on any other forge, naming both fixes: add a `feedback` command, or set `ci = false` for that repo. With `merge.max_fix_rounds = 0` Loom reads no feedback at all, so no failed check comes back either.
- `ci = false`: Loom ignores the repo's CI, and the plugin's checks are the whole bar; the briefs say so. A failed CI check starts no fix round, while the pull request's reviews, review threads and comments, and your replies on the ticket, still do. Loom still records the check counts it reads, so the Merge order tab shows them.

Compared with 0.23.0: Loom already sent failed CI checks back as fix rounds whenever the forge reported them, but no brief said so, so workers and reviewers took the plugin's checks as the whole bar and could stall on a test they could not run. `ci = true` keeps those fix rounds and adds the guidance and the board's CI counts; `ci = false` stops them. A spec approved before 0.24.0 keeps running as it is, and a repo whose forge reports no checks counts as `ci = false`; proposing a revision of it needs a `feedback` command or `ci = false`.

### [scope]

| Key | Type | Default | Rule |
|---|---|---|---|
| `protected` | string array | `[]` | globs no ticket may change; at most 100; in a multi-repo project they apply in every repo, relative to its root |
| `enforce` | string | `"warn"` | `"warn"` or `"reject"`: what happens to files a submit changes outside its ticket's scope |

### [agents]

| Key | Type | Default | Rule |
|---|---|---|---|
| `max_workers` | integer | `2` | 1 to 8; worker threads running at once, fix rounds and other work sent back to a worker included |
| `max_reviewers` | integer | `2` | 1 to 8; reviewer threads running at once |
| `ticket_timeout_minutes` | integer | `120` | 10 to 1440 |
| `triage` | boolean | `true` | |

`[agents.worker]` and `[agents.reviewer]` each take `provider`, `model` and `reasoning` (optional strings) and `permission_mode` (`"accept-edits"`, `"auto"` or `"full"`, default `"full"`). Some providers, such as pi, accept only `"full"`.

`provider` must be the id of a provider bb has, such as `claude-code`, `codex` or `pi`; a model or product name such as `claude` is not a provider id. Loom checks each provider against bb's list when the spec is proposed and refuses an unknown one with the ids bb has. When bb's list cannot be read, the spec is accepted unchecked.

### [review]

| Key | Type | Default | Rule |
|---|---|---|---|
| `approvals` | integer | `1` | 1 to 3 |
| `max_rounds` | integer | `3` | 1 to 10 |
| `rubric` | string array | `[]` | at most 20, each up to 500 characters |

### [budget]

| Key | Type | Default | Rule |
|---|---|---|---|
| `max_attempts` | integer | `3` | 1 to 10; failed worker attempts before a ticket blocks |
| `max_check_failures` | integer | `5` | 1 to 20; failed check runs on one ticket before it blocks |
| `max_tokens` | integer | none | positive; for the whole project |
| `deadline` | date | none | a real date such as `2026-12-31`, as a TOML date or a string |

### [[repo]]

Zero to 10 entries. Leave them out when the work stays in the planner thread's own repository. With one or more, the project spans exactly these repositories: list every repo the work changes, the planner thread's own project included when the work changes it too.

| Key | Type | Default | Rule |
|---|---|---|---|
| `name` | string | required | `^[a-z][a-z0-9-]{0,23}$`; unique among the `[[repo]]` tables; tickets name it in `repo` |
| `project` | string | required | the id of a standard bb project, such as `proj_abc123`, from `bb project list --json`; each bb project in one table only; it must have a checkout on the machine the planner runs on, where the workers run |
| `base` | string | `project.base` | the branch this repo's work starts from and lands on; a plain git name |
| `remote` | string | `merge.remote` | a plain remote name; where this repo's pull requests open and its land pushes |
| `checks` | string array | `checks.commands` | at most 10; replaces `checks.commands` for the tickets in this repo; an empty list runs no project checks there |
| `after_merge` | string array | `checks.after_merge` | at most 10; replaces `checks.after_merge` on this repo's integration branch; not allowed with strategy `"pr"` |
| `ci` | boolean | `checks.ci` | replaces `checks.ci` for the tickets in this repo; strategy `"pr"` only |
| `protected` | string array | `[]` | at most 100 globs, relative to this repo's root; added to `scope.protected` for the tickets in this repo |
| `forge` | table | `merge.forge` | like [merge.forge], for this repo's pull requests |
| `environment` | table | `environment` | like [environment], for the threads Loom starts in this repo |
| `worktree` | table | `merge.worktree` | like [merge.worktree], for this repo's integration worktree |
| `git_network_timeout_seconds` | integer | `merge.git_network_timeout_seconds` | 30 to 600; like `merge.git_network_timeout_seconds`, for this repo's git fetches, `ls-remote` and pushes |

Each repo gets its own integration branch (`merge.branch`, from the repo's `base`) and its own Loom worktree. Tickets in different repos never share a file, so their scopes never overlap.

### [[ticket]]

One to 200 entries.

| Key | Type | Default | Rule |
|---|---|---|---|
| `ref` | string | required | `^[a-z0-9][a-z0-9-]{0,39}$`; unique; other tickets name it in `depends_on` |
| `title` | string | required | 1 to 120 characters |
| `body` | string | required | 1 to 8000 characters; what a worker who has seen nothing else needs |
| `acceptance` | string array | required | 1 to 20 items; EARS form is recommended: "WHEN ... THE SYSTEM SHALL ..." |
| `verify` | string array | `[]` | at most 10 commands |
| `scope` | string array | required | 1 to 50 globs |
| `depends_on` | string array | `[]` | at most 20 refs; the ticket starts once these are done, or on the pr strategy with `merge.stack` once their pull requests are open |
| `merge_after` | string array | none | at most 20 refs, not the ticket's own; the tickets whose pull requests should merge before this one's, on top of its `depends_on`. It orders merges only: it never holds the ticket's start and never stacks its pull request. Use it for an order the rollout needs that the code does not, such as clients after the server they call is deployed. Loom shows it on the Merge order tab and names those pull requests in this one's description. With `depends_on` it must leave no cycle |
| `priority` | integer | `2` | 0 (highest) to 3 |
| `repo` | string | none | required when the spec has `[[repo]]` tables, and then one of their names; not allowed without them. The ticket changes only this repo: its `scope`, `verify` and protected paths are relative to the repo's root. `depends_on` may name a ticket in another repo. |
| `environment` | table | none | `{ inputs = { … } }`: a merge patch over its repo's environment `inputs` for this ticket's workers and reviewers (see [environment]); only where the repo has an environment provider; `loom_edit_ticket` changes it, and an empty `inputs` removes it |

Commands are up to 2000 characters each, globs up to 200, acceptance items up to 1000.

## Example: a two-ticket project

```toml
[project]
slug = "csv-export"
name = "CSV export"
key = "CSV"
goal = "Let admins export the orders table as a CSV file from the orders page, with the same columns as the screen."
summary = "Admins can download the orders table as a CSV file, so they stop copying it out of the screen by hand."
non_goals = ["Scheduled exports", "Other file formats"]
base = "main"

[merge]
strategy = "integration"

[checks]
commands = ["npm test", "npm run typecheck"]
timeout_minutes = 15

[scope]
protected = ["package-lock.json", ".github/**"]

[agents]
max_workers = 2

[agents.worker]
provider = "claude-code"
model = "sonnet"

[agents.reviewer]
provider = "codex"
model = "gpt"

[review]
approvals = 1
max_rounds = 3
rubric = ["Every acceptance criterion has a test", "No change outside the ticket's scope"]

[[ticket]]
ref = "row-mapper"
title = "Map an order to a CSV row"
body = "Add src/export/rows.ts with orderToRow(order), which returns the visible columns in screen order. Read src/orders/columns.ts for the column list. Do not touch the orders page."
acceptance = [
  "WHEN an order is mapped THE SYSTEM SHALL return one value per visible column, in screen order",
  "WHEN a value contains a comma or a quote THE SYSTEM SHALL quote and escape it",
]
verify = ["npx vitest run test/export/rows.test.ts"]
scope = ["src/export/rows.ts", "test/export/rows.test.ts"]
priority = 1

[[ticket]]
ref = "export-endpoint"
title = "Serve the export"
body = "Add GET /orders/export, which streams the CSV using orderToRow from src/export/rows.ts, and an Export button on the orders page."
acceptance = [
  "WHEN an admin opens /orders/export THE SYSTEM SHALL stream a CSV with a header row and one row per order",
  "WHEN there are no orders THE SYSTEM SHALL return only the header row",
]
scope = ["src/export/**", "src/orders/page.tsx"]
depends_on = ["row-mapper"]
```

## Example: a project across two repos

An API change in one repository and the page that uses it in another. Each repo has its own toolchain, so each sets its own checks, and the web ticket depends on the API ticket across the two repos.

```toml
[project]
slug = "order-notes"
name = "Order notes"
key = "NOTE"
goal = "Let staff add a note to an order through the orders API, and show the note on the order page of the web app."
summary = "Staff can note an order through the API and read the note on the order page."
non_goals = ["Editing notes from the web app", "Notes on other resources"]
base = "main"

[merge]
strategy = "integration"

[scope]
protected = [".github/**"]

[agents.worker]
provider = "claude-code"
model = "sonnet"

[agents.reviewer]
provider = "codex"
model = "gpt"

[[repo]]
name = "api"
project = "proj_api7k2m9q"
checks = ["go test ./...", "go vet ./..."]
protected = ["go.sum"]

[[repo]]
name = "web"
project = "proj_web4x8n2r"
base = "trunk"
checks = ["npm test", "npm run typecheck"]
after_merge = ["npm test"]
protected = ["package-lock.json"]

[[ticket]]
ref = "notes-api"
repo = "api"
title = "Store and serve order notes"
body = "Add a nullable note column to orders (a migration in db/migrations), accept note in PATCH /orders/{id} and return it from GET /orders/{id}. Update api/openapi.yaml to match. Read internal/orders/handler.go first."
acceptance = [
  "WHEN a client sends PATCH /orders/{id} with a note THE SYSTEM SHALL store it and return it from GET /orders/{id}",
  "WHEN an order has no note THE SYSTEM SHALL return note as null",
]
scope = ["internal/orders/**", "db/migrations/**", "api/openapi.yaml"]
priority = 1

[[ticket]]
ref = "notes-page"
repo = "web"
title = "Show the note on the order page"
body = "Read note from GET /orders/{id} (api/openapi.yaml in the api repo describes it; read it, do not edit it) and show it under the order summary in src/orders/OrderPage.tsx. Show nothing when note is null."
acceptance = [
  "WHEN an order has a note THE SYSTEM SHALL show it under the order summary",
  "WHEN an order's note is null THE SYSTEM SHALL show no note section",
]
scope = ["src/orders/**", "test/orders/**"]
depends_on = ["notes-api"]
```

- No ticket has `verify` and `[checks]` is empty, which is allowed because each ticket's repo sets `checks`. A ticket in `api` runs the Go commands and a ticket in `web` runs the npm commands.
- `bb loom start` creates `loom/order-notes` in both repos: from `main` in `api`, and from `trunk` in `web`.
- `notes-page` starts only after `notes-api` is done, that is merged into `loom/order-notes` in `api`. Its worker works in a checkout of `web`, and its brief gives the path of the `api` checkout to read, not to edit.
- A ticket's protected paths are `.github/**` and its own repo's list: `go.sum` in `api`, `package-lock.json` in `web`.
- `bb loom land order-notes` opens one pull request in each repo, `bb loom land order-notes --repo api` lands only `api`, and the project is done when every repo with merged work has landed.

## Example: servers other than GitHub

A project in a repository whose remote is not on GitHub, and whose workers need a plugin's environment. The values come from `loom_discover` and the human; Loom knows none of them.

```toml
[project]
slug = "order-tags"
name = "Order tags"
key = "TAG"
goal = "Let support staff tag an order with free-text labels and filter the order list by tag."
summary = "Support staff can tag orders and filter the order list by tag."

[merge]
strategy = "pr"
remote = "upstream"

[merge.forge]
kind = "command"
open = 'review-cli create --base "$LOOM_BASE" --head "$LOOM_HEAD" --title "$LOOM_TITLE" --body-file -'
state = 'review-cli status "$LOOM_PR_NUMBER"'
after_open = ['ci-cli run --pr "$LOOM_PR_NUMBER"']

# On merge.strategy = "integration", the same plugin could prepare the integration worktree:
# [merge.worktree]
# plugin = "example-trees"
# command = 'prepare "loom-$LOOM_PROJECT_SLUG" services/orders'

[environment]
provider = "example-trees"
inputs = { branch = "{branch}", base = "{base}", paths = ["services/orders", "services/billing"] }
# Reviewers read the diff; a lighter tree without the setup step is enough for them.
reviewer = { inputs = { setup = false } }

# review-cli cannot print checks, so Loom cannot rely on the pull request's CI: these checks are the whole bar.
[checks]
commands = ["make -C services/orders test"]
ci = false

[[ticket]]
ref = "tag-model"
title = "Store tags on orders"
body = "Add a tags column to orders in services/orders/db and expose it on the Order model."
acceptance = ["WHEN an order is saved with tags THE SYSTEM SHALL return the same tags when it is read back"]
scope = ["services/orders/db/**", "services/orders/model/**"]
# This ticket only needs the orders service in its tree.
environment = { inputs = { paths = ["services/orders"] } }
```

## Example: a World project on new machines

A project whose workers and reviewers each run on a new machine that a plugin's environment makes, opening and following its pull requests through a forge command. The provider ids and inputs come from `loom_discover` and the human; these are placeholders. The forge is Delta, through its `dt` CLI, whose JSON follows GitHub's REST API.

The zone's tests need a container runtime that the machines do not have, so the plugin's checks are only the static ones, and Loom relies on the pull request's CI (`ci` unset is `true`) for the rest. That needs the `feedback` command: it reads the pull request with `dt pr view`, and its check runs and commit statuses with `dt pr checks`, which exits 8 while checks are pending. The command turns them into the JSON object Loom reads, mapping each check run's `status` and `conclusion` to Loom's check states. It leaves out Delta's `reviews` check run, which is the approval gate rather than CI and would hold every failed check until the settle time. It reports no reviews or comments, so your replies on the ticket are what starts a fix round for a reviewer's request.

```toml
[project]
slug = "route-timeouts"
name = "Route timeouts"
key = "RTO"
goal = "Give every route of the routing controller a configurable upstream timeout, defaulting to the current value."
summary = "Each route of the routing controller gets a configurable upstream timeout."

[merge]
strategy = "pr"
# Fetching main of World takes about a minute; see Slow repositories.
git_network_timeout_seconds = 300

[merge.forge]
kind = "command"
open = 'dt pr create --remote "$LOOM_REMOTE" --base "$LOOM_BASE" --head "$LOOM_HEAD" --title "$LOOM_TITLE" --body "$(cat)"'
state = 'dt pr view "$LOOM_PR_NUMBER" --json | jq -r "if .merged == true then \"merged\" else .state end"'
retarget = 'dt pr edit "$LOOM_PR_NUMBER" --base "$LOOM_BASE"'
# Fresh CI after every push; a stacked pull request leaves draft once it builds on main.
after_push = ['devx ci run -b "$LOOM_HEAD" -n', '[ "$LOOM_BASE" != main ] || dt pr ready "$LOOM_PR_NUMBER"']
feedback = '''
set -eu
view=$(dt pr view "$LOOM_PR_NUMBER" --remote origin --json)
checks=$(dt pr checks "$LOOM_PR_NUMBER" --remote origin --json) || [ $? -eq 8 ]
jq -cn --argjson view "$view" --argjson checks "$checks" '{
  state: (if $view.merged then "merged" else $view.state end),
  head: $view.head.sha,
  author: $view.user.login,
  draft: $view.draft,
  base: $view.base.ref,
  review: ({"approved": "APPROVED", "changes_requested": "CHANGES_REQUESTED", "review_required": "REVIEW_REQUIRED"}[$view.merge_readiness.review_decision] // null),
  checks: ([$checks.check_runs[] | select(.name != "reviews") | {
    id: .id, name: .name, url: .html_url, started: (.status != "queued"), started_at: .started_at, completed_at: .completed_at,
    state: (if .status != "completed" then "pending"
      elif .conclusion == "success" then "passed"
      elif (.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "cancelled" or .conclusion == "action_required") then "failed"
      else "neutral" end)
  }] + [$checks.statuses.statuses[] | {
    id: ("status:" + .context), name: .context, url: .target_url,
    state: (if .state == "success" then "passed" elif .state == "pending" then "pending" else "failed" end)
  }])
}'
'''

[environment]
provider = "example-world"
machine = { provider = "example-world", inputs = { zones = ["areas/infra/routing/controller"] } }

# Cheap checks that run on the worker's machine; the zone's tests run in the pull request's CI.
[checks]
commands = ["git diff --check origin/main...HEAD"]

[[ticket]]
ref = "route-timeout"
title = "Configurable upstream timeout"
body = "Add an upstream_timeout setting to each route, read it where the controller builds the upstream, and keep today's value as the default."
acceptance = ["WHEN a route sets upstream_timeout THE SYSTEM SHALL use it for that route's upstream", "WHEN a route sets none THE SYSTEM SHALL keep today's timeout"]
scope = ["areas/infra/routing/controller/**"]
```

## Errors

A spec with any error is refused and nothing is saved. Errors are numbered, at most 20 shown.

- TOML that does not parse: one error with the line and column.
- A key the schema does not know, a missing required key, or a value outside its range.
- `depends_on` names a ref that is not a ticket.
- A dependency cycle; the error shows one cycle path.
- Two tickets with the same `ref`.
- `project.open_questions` is not empty.
- The text `[NEEDS CLARIFICATION` appears anywhere in the TOML, even in a comment or a string.
- A ticket scope glob equals, or sits under, a protected glob (the text before the first `*` is compared).
- A ticket has no `verify` command and `checks.commands` is empty.
- `checks.after_merge` is set with strategy `"pr"`.
- A forge with `kind = "command"` lacks `open` or `state`, a forge of another kind sets them or `feedback`, or `kind = "none"` sets `after_open`.
- `merge.describe`, `merge.squash`, `merge.max_fix_rounds`, `merge.stack`, `merge.release_workers`, `merge.checks_queued_minutes` or `merge.checks_near_done_percent` on the integration strategy.
- `merge.worktree` is set with strategy `"pr"`.
- An `environment` (top level or a repo's) or its `reviewer` sets `machine`, and the strategy is not `"pr"`.
- `checks.ci` or a repo's `ci` on the integration strategy.
- A repo that relies on the pull request's CI (strategy `"pr"` with `ci` unset or `true`) whose forge reports no checks: `kind = "command"` without `feedback`, or `kind = "none"`. Add a `feedback` command, or set `ci = false` for that repo.
- An `inputs` string, in `[environment]`, its `reviewer` table or a ticket's `environment`, holds a `{name}` other than `{branch}` or `{base}`.
- A ticket sets `environment` in a repo whose threads start in git worktrees, with no environment provider to patch.

Repos add these errors:

- Two `[[repo]]` tables with the same `name`, or with the same `project`: list each bb project in one table only.
- A ticket sets `repo`, but the spec has no `[[repo]]` table. Add the table, or remove `repo` from the ticket.
- The spec has `[[repo]]` tables and a ticket has no `repo`, or names a repo that is not one of them. The error lists the repo names.
- A ticket scope glob equals, or sits under, a `protected` glob of its repo.
- A ticket has no `verify` command and its repo's `checks` is an empty list, or its repo sets no `checks` and `checks.commands` is empty.
- A `[[repo]]` sets `after_merge` with strategy `"pr"`.

Loom also checks every `[[repo]]` against bb when the spec is proposed:

- `project` is not a bb project, or is bb's personal project, which has no git checkout. The error lists bb's standard projects with their ids.
- The bb project has no checkout on the machine the planner runs on, where the workers run. The error gives the command that clones it there, `bb project source add <id> --clone --machine <host>`; run it once the human agrees, then propose again.
- bb's projects could not be read, or bb did not say which machine the planner runs on. Unlike an unreadable provider list, this refuses the spec, because the project could not start without a checkout of every repo. Propose again in a moment.

Loom then checks how each repo is reached on the planner's machine (`loom_discover` reports the same facts):

- The repo has no git remote named `remote`. The error lists its remotes.
- The forge is `gh`, and `gh` is missing or not signed in to the push URL's host, or the push URL is not a repository URL.
- A plugin offers an environment provider for the repo, and the spec names no `environment`.
- The `environment` provider, or its `reviewer.provider`, is not offered or not available there, or its `inputs`, the reviewer's inputs or a ticket's patched inputs do not match its schema. The error quotes the provider's description and schema.
- A `machine.provider` is not a bb machine provider, or its `inputs` do not match its schema; or the environment makes a new machine per thread and `machine` is missing or names another machine provider than its own.
- On the integration strategy with no `worktree`, git refused Loom's own worktree. The error quotes git.
- `worktree.plugin` is not installed or is turned off, or `bb plugin run <plugin> <first word> --help` fails.

Refusals tied to existing projects come back the same way:

- `project.key` is used by another project, archived ones included.
- The slug already belongs to a project this thread does not plan, or this thread already plans a different slug.
- After approval, a revision that changes `project.key`, `merge.strategy` or `merge.branch`, a repo's forge `kind`, or whether it has a `worktree`.
- After approval, a revision that adds `[[repo]]` tables to a project approved without them, removes or renames an approved repo, or changes an approved repo's `project`, `base` or `remote`, including through the `project.base` or `merge.remote` it inherits. Its tickets, branches and worktrees already use them. A revision may add new `[[repo]]` tables; the planner adds their tickets with `loom_add_tickets`.
- bb already has a sidebar section named `Loom · <name> (<slug>)`.
- Workers and reviewers cannot propose projects.

## Warnings

Warnings are returned but do not block a proposal.

- The reviewer and the worker use the same provider and model (including both left unset), so review shares the worker's blind spots.
- Two tickets have overlapping scope and no dependency path between them, so they will run one at a time. Add `depends_on` or narrow the scope.
- After approval, a revision's ticket list is ignored: "Ticket changes after approval go through the planner's board tools."

## Revisions

- Before approval, proposing again from the planner thread with the same slug adds a new draft version; older drafts are kept as superseded, and approving takes the newest.
- After approval, a revision becomes a pending version; `bb loom approve <slug>` applies it. Tickets are not recreated.
- Proposing a spec identical to the latest one changes nothing and returns the existing version.
