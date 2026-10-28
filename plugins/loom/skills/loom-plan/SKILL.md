---
name: loom-plan
description: "Turn a goal into a Loom project: a validated spec with tickets, acceptance criteria, check commands, a review policy and a merge plan, proposed with loom_propose. Use when the user wants agents to build something as a project, says \"loom\", \"start a project\" or \"plan tickets\"."
---

# Plan a Loom project

You turn the user's loose goal into a Loom project spec (TOML). Loom's plugin runs the project afterwards: it hands tickets to worker agents, sends finished work to separate reviewers and merges approved work. You do not run any of that and you do not decide when a ticket is done. Your job ends when `loom_propose` accepts the spec and the human knows the next commands.

Read the spec reference first: the `loom` skill's `references/spec.md` lists every table and key, its default and an example spec.

## When the Loom page started this thread

The human can start a project from New project on the Loom page. Then this thread's first message is their goal, followed by a note that starts with `[loom]`. The note may already settle the merge plan, name the reviewer model they want, or list the repos they picked in the composer's repo picker. Skip the interview questions it answers, and ask the rest as usual. Picked repos are a starting point, not a limit: step 2 still applies to them, and you may add other repos the work changes. When you hand over, say that they can read, approve and start the draft on the Loom page. Once you propose, this conversation is the project's Planner tab there.

## 1. Interview (one short round)

Ask only what you cannot find in the repository:

- Outcome: what should exist when the project is done, and how the human will tell.
- Non-goals: what is explicitly out of scope.
- Repos: which repositories the work spans. Most projects change one repository, this thread's own. When the work also changes other repositories, step 2 finds them.
- Base branch: where work starts (default `main`), and whether a repo uses another base.
- Merge plan: an integration branch that collects all approved tickets (`strategy = "integration"`), or one pull request per ticket (`strategy = "pr"`). On `"pr"`, dependent tickets start on their dependencies' open pull requests and stack on them in the same repo; ask only if the human wants each to wait for the merge instead (`merge.stack = false`). Where step 3 finds that Loom cannot add its own integration worktree, the choices are one pull request per ticket, or a `[merge.worktree]` command or plugin.
- Check commands: the commands that must pass on every submitted ticket, per repo when the repos use different toolchains. On `"pr"`, put only cheap checks that run on the machine each thread runs on in `checks` and `verify` (lint, format, type checks, a fast unit suite), and leave the tests that are expensive or cannot run there (ones that need containers or services, long suites) to the pull request's CI, which Loom relies on by default. Ask only if the human wants Loom to ignore a repo's CI (`ci = false` in `[checks]` or on the `[[repo]]`); then its checks are the whole bar and must cover every test the tickets need.
- Fresh pull requests, on `"pr"`: whether a repo's CI fails a pull request whose branch is far behind its base, or busy repos make pull requests go stale while they wait for review. Then set `merge.refresh_behind`, or `refresh_behind` on that `[[repo]]`, to a number of commits behind the base, below the limit that CI enforces; Loom then merges the base into an open pull request that falls that far behind, or that conflicts with its base, and pushes it with no new review. Leave it unset when the human prefers to bring branches up to date themselves.
- Models: ask for a reviewer model that differs from the worker's, so the reviewer does not share the worker's blind spots. `provider` in `[agents.worker]` and `[agents.reviewer]` is a bb provider id, such as `claude-code`, `codex` or `pi`, not a model name such as `claude`; `loom_propose` refuses a provider bb does not have and lists the ids it has.
- Protected paths: files no ticket may change, such as lockfiles, CI config or generated code.
- Deploy order, on `"pr"` when the work changes a running system: how each repo's merged changes reach traffic and whether merging deploys them, what must be live before what, any prerequisite no ticket delivers (a metric reaching zero, another team's service existing), freeze windows, and how to tell each change is live. Step 5 turns the answers into `[rollout]`.

Anything the human cannot answer yet goes in `project.open_questions`; Loom refuses a spec while that list is not empty, so settle every question before you propose.

## 2. Find the repos and their checkouts

Skip this step when the work stays in this thread's own repository: leave `[[repo]]` out of the spec, and every ticket runs there.

For work across repositories, each repository is a bb project, listed in its own `[[repo]]` table with its bb project id as `project`. The loom skill's `references/spec.md` has every `[[repo]]` key and an example spec with two repos.

- Find this machine with `bb status --json`: `thread.environment.hostId` is the machine this thread runs on, and the project's workers run there too. The commands below call it `<host>`.
- Find bb's projects with `bb project list --json`: each has an `id`, a `name`, a `gitRemoteUrl` and `sources`, one per checkout, each with the `hostId` of its machine and its `path`. A project has a checkout here when one of its sources has this machine's `hostId`.
- Find git repositories used recently on this machine with `bb project discover --machine <host> --json`: each has a `path`, an `originUrl` and a `projectId`, which is null for a repository that is not a bb project yet.
- List every repo the work changes, this thread's own project included when the work changes it. A repo the work only reads needs no table; name the files to read, with their path on this machine, in the ticket bodies.

Every repo needs a checkout on this machine; `loom_propose` refuses a repo without one and names the clone command. When a repo has none, offer the human the fix and run it only after they agree:

- A bb project with no checkout here: clone it with `bb project source add <id> --clone --machine <host>`.
- A repository that is not a bb project yet: when `bb project discover` found it on this machine, register that path with `bb project create --root <path> --machine <host>`; otherwise clone it first (`git clone <url> <path>`), then register it the same way. Use the new project's id as `project`.

## 3. Discover how each repo is reached

Call `loom_discover` once you know the repos: with no arguments for this thread's own repository, or with the bb project ids of every `[[repo]]`, in their order. For each repo it reports its git remotes, whether `gh` can open pull requests there, the environment providers bb offers for it on this machine, the environments that start each thread on a new machine of its own ("New machine per thread"), the environments earlier approved projects chose for a repository with the same remote ("Earlier picks"), and whether Loom can add its own integration worktree. Every line ends in found or ask.

- Settle every ask item before you propose. Look for the answer yourself first: in the goal, the repository's docs, the skills loaded in this thread and, for an environment provider, its description, its inputs schema and its plugin's skill (`bb skill list`). Ask the human only for what is still missing.
- Ask everything that is left in ONE round with your question tool, giving each question the options discovery found. The Loom page shows the questions next to the draft.
- A remote: when there is no `origin`, set `merge.remote`, or `remote` on the `[[repo]]`, to the remote its pull requests go through.
- A forge: when `gh` cannot open pull requests on the push URL's host, set `[merge.forge]`, or `forge` on the `[[repo]]`: `kind = "command"` with an `open` and a `state` command for that server's own CLI, and a `feedback` command when that CLI can list a pull request's checks and review comments, so Loom can send them back to the worker as fix rounds; or `kind = "none"` to only push branches. A repo that relies on CI needs a forge that reports checks, `gh` or a command forge with `feedback`: write one when the CLI can list checks (the command forge example in `references/spec.md` shows one for a CLI with GitHub's JSON), and otherwise set `ci = false` for that repo after telling the human, because `loom_propose` refuses the spec until one of them is there. The loom skill's `references/spec.md` gives the commands' variables and the output Loom reads. Add an `edit` command when the CLI can change a pull request's title and description, so Loom can apply the text reviewers approve in a fix round and refresh the Rollout section (the `feedback` command then prints `title` and `body` too), and a `reply` command when it can answer a review comment, so workers reply through Loom on every machine. `after_push` commands run after each push to an open pull request, for a server whose CI must be started by hand, and `ignore_checks` globs (`*` and `?`, everything else literal), such as `"Review Bot*"`, drop advisory statuses, such as a review bot's, that no fix can clear; both work on `gh` too. Once the project exists, `bb loom forge check <slug> <pull request URL> --version <N>` runs version N's forge read against a live pull request, as a poll would, and prints what Loom reads or why the read failed; run it after proposing a version that changes forge commands, and before you hand it over.
- An environment provider: when a plugin offers one, ask whether Loom's threads (workers, reviewers and the spec reviewer) run there. Set `[environment]`, or `environment` on the `[[repo]]`, to its `provider` id and `inputs` written to its schema, with `{branch}` and `{base}` where each thread's branch and starting point go. To keep plain git worktrees, set `provider = "git-worktree"`. When its environments are large or limited, give reviewers less with `reviewer = { inputs = { … } }` (a merge patch over `inputs`; reviewers only read, and Loom runs the checks in the worker's worktree), and give each ticket only what it touches with its own `environment = { inputs = { … } }`.
- A new machine per thread: when discovery lists "New machine per thread", propose one of those environments on every project, weighing the earlier picks for the same remote, and confirm it with the human in your question round; keep this machine only when they prefer it. Copy the line as discovery prints it, `provider = "<id>"` with `machine = { provider = "<id>", inputs = { … } }` written to the machine provider's schema, and use `merge.strategy = "pr"`, which Loom needs there; stacking works on new machines too, so keep `merge.stack` as the human chose it. A stacked dependent's worker keeps its machine while its dependency's pull request is open, so count those machines against the machine provider's room. Every worker then runs the checks on its own machine, so make sure each check command works on that machine, not only on this one. Reviewers follow the workers unless you give them a `reviewer` table with another provider.
- The integration worktree: on `strategy = "integration"`, when git refused Loom's own worktree, offer `strategy = "pr"`, or set `[merge.worktree]` to a command that prepares a checkout and prints its path last, or to a plugin's CLI command with `plugin = "<id>"` (`bb plugin run <id> --help` lists its commands).
- A large repository: when fetching its base branch takes more than about a minute, as on a large monorepo, set `git_network_timeout_seconds` on its `[[repo]]` (or on `[merge]` for a single-repo project) well above the time `time git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main` takes in its checkout; 300 leaves room for a fetch of 50 to 80 seconds. With Loom's default of 120 seconds per fetch, `ls-remote` or push, every try to bring a stacked pull request up to date runs out of time, and the project pauses after an hour of them. See Slow repositories in `references/spec.md`.
- Anything the human cannot answer yet goes in `project.open_questions`. `loom_propose` refuses a spec that leaves any of these unsettled, and its numbered errors name the key to set.

## 4. Read the code and run the checks once

Read the parts of each repository the goal touches. Run each check command once and note whether it passes on the base branch. A check that already fails will fail every ticket; tell the human before you propose. A test that cannot run on the threads' machine, or takes too long for every submit, belongs to the pull request's CI, not to `checks`.

When the repos use different toolchains, give each `[[repo]]` its own `checks` (and `after_merge` on the integration strategy), which replace the top-level ones for that repo's tickets. Run each repo's checks once, in that repo's checkout, and note whether they pass on its base branch.

## 5. Write the summary and the tickets

Every proposal needs `project.summary`: one or two plain sentences, 20 to 300 characters, that say what the project changes and why, for someone who has not read the goal. Loom shows it on the project page and in its home list, so a reader learns what the project is for without finding this thread. Write the outcome, not the task: "Page Edge Infrastructure and fail fast when a Cloudflare API token is rejected", not "Implement items 1 to 3 of the issue". When the goal says what done means, add `project.done_when`, one short line for each thing that must be true.

- Build only what the goal needs: the fewest tickets that deliver it, no configuration, flags, layers or future-proofing it does not use, and reuse what the repository already has. Loom's spec reviewer checks exactly this.
- Each `project.done_when` item must come true through some ticket's acceptance criteria; the spec reviewer traces each one and names any item no ticket delivers. Write criteria that only the change itself meets: a ticket that could pass by explaining in comments or docs why the goal cannot be met is a finding. When the work may turn out impossible, say so in the body and let the worker block, instead of accepting a write-up as done.
- One ticket fits one worker's context window: a change a person could review in one sitting.
- Acceptance criteria are testable statements, preferably in EARS form: "WHEN <event> THE SYSTEM SHALL <response>". Every ticket needs at least one.
- Scope lists the exact files or directories the ticket may change, as globs. A ticket outside its scope is flagged.
- Tickets whose scopes overlap must depend on each other with `depends_on`; otherwise Loom warns that they will run one at a time.
- On the pull request strategy a dependent ticket usually starts before its dependency merges: its brief lists each dependency's open pull request and commit, and in the same repo its worktree starts on that commit. So say in its body which of the dependency's files or names it builds on, not that the dependency "is merged". Do not plan two independent tickets in one repo that a third depends on unless you must: its pull request can open only once one of them has merged.
- On the pull request strategy, the human merges each pull request. When the rollout needs an order the code does not, such as the server deployed before the clients that call it, or staging before production, give the later ticket `merge_after` with the earlier refs instead of `depends_on`. It still starts at once, but the Merge order tab puts its pull request after theirs, and its description names them. Keep `depends_on` for work that builds on another ticket's code.
- On the pull request strategy, give every ticket that changes a running system (a service, infrastructure, or an interface other code calls) a `rollout`, and the project the `[rollout]` tables it needs. See "Deploy order" below.
- `verify` lists commands that check this ticket alone. A ticket with no `verify` needs commands in `[checks]`, or in its repo's `checks`.
- Do not copy ticket text from the goal; write what a worker who has not seen this conversation needs to start: the files to read, the behavior to build, what to leave alone.
- Never write `[NEEDS CLARIFICATION]` markers. Ask the human instead.

On a project with `[[repo]]` tables:

- One ticket changes one repo, and every ticket sets `repo` to one of the `[[repo]]` names. A worker has a checkout of its ticket's repo only; it can read the other repos but not change them.
- Split cross-repo work into one ticket per repo, linked with `depends_on`: for example the API ticket first, then the web ticket that `depends_on` it. On the integration strategy a ticket starts only when the tickets it depends on are done; on the pull request strategy it starts once their pull requests are open, and reads their work from the other repo's checkout at the commit its brief names.
- Scopes, `verify` commands and protected paths are relative to the ticket's repo. Write `src/**`, not the repo's checkout path. Scopes in different repos never overlap.
- In the body of a dependent ticket, say which files of the other repo to read, such as an API schema. Its brief gives the other repos' checkout paths; on the integration strategy it can read their merged work from the integration branch, and on the pull request strategy from the commit of their open pull request.

### Deploy order

Loom orders three things, and each answers its own question. `depends_on` orders the work: when a ticket can start. `merge_after` orders the merges, so git history is right. `rollout` orders the deploys: when a ticket's change may reach traffic, and what must be live first, not merely merged. A change can merge early and stay dark behind a gate, a repo can deploy on merge, one release can carry several merges, and some prerequisites are no ticket at all. Deploy order is advice for the human: Loom starts, reviews and opens every pull request whatever it says, and holds no merge for it. It tracks what is live, shows the order on the Rollout tab and writes a Rollout section into each pull request's description, which it refreshes when a prerequisite goes live, so do not ask workers or reviewers to write the deploy order into the description, or to keep a pull request a draft until something is live. Workers propose the rest of the description with `loom_submit` and the reviewers judge it with the code, so a rubric line about what a pull request's description must say (how to verify after deploy, how to roll back) is checked before the pull request opens.

- `[rollout].deploy` says how changes reach traffic, and a `[[repo]]` table's `deploy` overrides it: `on_merge = true` for a repo whose merge deploys, such as a Terraform actuator.
- `[[rollout.stage]]` tables, in order, each with a `goal` and an optional `soak`, such as expand, migrate and contract.
- `[[rollout.milestone]]` for a prerequisite no ticket delivers, with a `check` command when one can tell, and the `stage` it gates.
- `[[rollout.window]]` for each freeze.
- Each ticket's `rollout`: its `stage`, what it `requires_live`, its `release` when several deploy together, `dark = true` for a change that ships with its gate off, `how` when it deploys unlike its repo, a `verify` command that exits 0 once it is live, and its `rollback`.

Follow these principles, which the spec reviewer checks:

- Providers before consumers: the server, the proxy or the schema is live before anything calls it.
- Dark before exposed: ship the code with its gate off, and turn the gate on in a ticket of its own.
- Staging before production, canary before the fleet.
- Verify and soak between stages: give each step a `verify` where a command can tell, and a stage a `soak` where the change needs time in production.
- Removal last, behind a milestone: the ticket that removes an old path sits in the last stage, which a milestone such as "old traffic near zero" gates.
- Respect windows: no deploy-on-merge step should be due inside a freeze.

A worked example, as an excerpt: each ticket also needs its title, body, acceptance and scope, and the references/spec.md example is a whole spec.

```toml
[rollout]
deploy = { how = "The deploy pipeline ships main: canary, then production" }

[[rollout.stage]]
name = "expand"
goal = "The server accepts the new header in production"
soak = "1d"

[[rollout.stage]]
name = "migrate"
goal = "Every caller sends the new header"

[[rollout.stage]]
name = "contract"
goal = "The old header is gone"

[[rollout.milestone]]
ref = "old-header-zero"
title = "Requests with the old header are near zero"
check = "./scripts/old-header-rate.sh --below 0.1"
stage = "contract"

[[repo]]
name = "proxy"
project = "proj_proxy"
deploy = { on_merge = true, how = "The Terraform actuator applies on merge" }

[[ticket]]
ref = "server-header"
rollout = { stage = "expand", verify = "curl -fsS -H 'X-New: 1' https://api.example.com/health", rollback = "Revert; nothing calls it yet" }

[[ticket]]
ref = "proxy-header"
repo = "proxy"
rollout = { stage = "migrate", requires_live = ["server-header"], rollback = "Revert; the actuator applies the revert" }

[[ticket]]
ref = "drop-old-header"
rollout = { stage = "contract", rollback = "Revert the removal" }
```

After approval, change a ticket's rollout with `loom_edit_ticket` and a patch of `rollout` alone, which works on a ticket whose pull request is open and on a done one; add stages, milestones and windows in a new spec version. `bb loom rollout <slug>` prints the order as Loom sees it.

## 6. Propose

Call `loom_propose` with the whole spec. Fix every numbered error it returns and call it again; a refused spec creates nothing. Calling it again from this thread with the same slug revises the draft. Read any warnings and fix the ones that matter.

Then wait for the spec review. For each draft version Loom starts a separate reviewer agent that reads this conversation, the spec and the code, and checks that the spec builds what the human asked for, and no more. End your turn after `loom_propose`; the verdict arrives in this thread as a message that starts with "[loom] Spec review".

- A passed review says so: hand over (step 7).
- Findings arrive as a numbered list, each with the spec path it is about. Revise the spec for each finding and call `loom_propose` again; a fresh reviewer checks the new version. If a finding is wrong, leave that part as it is and say why in your reply: the next reviewer reads this conversation.
- After three rounds with findings, Loom stops reviewing. Revise for the findings you agree with, propose once more, then hand over and name the findings you left open and why.
- A review that did not finish (the reviewer stopped, or bb could not start it) restarts when you call `loom_propose` again with the same spec.
- A revision for the human's notes is reviewed again before you hand it back.
- A version that, against the one before it, changes only operational settings (the forge, environments, `agents`, `budget`, `[merge]` keys other than `strategy`, `branch` and `remote`, `checks.timeout_minutes` and `ci`) skips the review, when that earlier draft's own review passed or was skipped, or when it is a pending version compared with the version in force. The message starts with "[loom] Loom skipped the spec review" and names the paths: hand over as after a passed review.

The human can review the draft on the Loom page and send you notes. They arrive as one message that starts with "[loom] The human reviewed spec" and lists each note under the spec path it is about, such as `ticket[csv-export].acceptance[1]`: tickets by ref, list items counted from 0. A note may suggest a value for its part, written as TOML on a line such as `Suggested value: "pr" (now "integration")`; use it unless it breaks the spec, and then say why. Revise the spec for each note, or answer it in your reply, then call `loom_propose` again with the whole spec.

After the human approves the project, a revision is held as a pending version until they approve it, and its ticket list is ignored. A project approved before summaries were required has none, and its next revision must add `project.summary`: `loom_propose` refuses one without it. Later merge order changes go through `loom_edit_ticket` with a patch of `merge_after` alone, which works on a ticket whose pull request is already open. Loom reviews a pending version too, as a change to the version in force, in the same rounds: end your turn after `loom_propose` and wait for "[loom] Spec review" before you hand it over.

## When the human has to act

Whenever the human has to do something, such as approve a pending version and then requeue the tickets it unblocks, call `loom_ask_human` with the steps in order, as well as saying them in your reply. The Loom page shows them under Needs you on the Planner tab, with a button for each: `approve` with the version, `requeue` or `reply` with the ticket key, `start`, `resume`, `land`, or `other` for anything the page cannot do. Each call replaces your earlier asks, and a step is checked off when the human does it. Call it with no steps once nothing is needed.

## 7. Hand over

Hand over only after Loom's spec review passed or was skipped, or after Loom said it stopped reviewing; then also name the findings you left open. The human cannot approve a draft or a pending version whose review is still running or has findings unless they skip it with `bb loom approve <slug> --skip-review`.

Tell the human, in plain words, what you proposed and the next steps. On a project with `[[repo]]` tables, name the repos; landing opens one pull request in each repo with merged work, and `bb loom land <slug> --repo <name>` lands one. On the Loom page the next-step bar carries Approve and then Start; in a terminal the commands are:

- `bb loom spec <slug>` to read the spec.
- `bb loom approve <slug>` to approve it and create the tickets.
- `bb loom start <slug>` to start the project.

## Rules

- NEVER approve, start, pause, resume or archive a project, and never post on a ticket as the human. Those commands refuse Loom threads, and they are the human's decisions.
- NEVER propose a project for another thread's slug. This thread plans one project.
- The plugin owns every state change. You can propose a spec; you cannot move a ticket.
