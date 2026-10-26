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
- Check commands: the commands that must pass on every submitted ticket (tests, type checks, lint), per repo when the repos use different toolchains.
- Models: ask for a reviewer model that differs from the worker's, so the reviewer does not share the worker's blind spots. `provider` in `[agents.worker]` and `[agents.reviewer]` is a bb provider id, such as `claude-code`, `codex` or `pi`, not a model name such as `claude`; `loom_propose` refuses a provider bb does not have and lists the ids it has.
- Protected paths: files no ticket may change, such as lockfiles, CI config or generated code.

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

Call `loom_discover` once you know the repos: with no arguments for this thread's own repository, or with the bb project ids of every `[[repo]]`, in their order. For each repo it reports its git remotes, whether `gh` can open pull requests there, the environment providers bb offers for it on this machine, and whether Loom can add its own integration worktree. Every line ends in found or ask.

- Settle every ask item before you propose. Look for the answer yourself first: in the goal, the repository's docs, the skills loaded in this thread and, for an environment provider, its description, its inputs schema and its plugin's skill (`bb skill list`). Ask the human only for what is still missing.
- Ask everything that is left in ONE round with your question tool, giving each question the options discovery found. The Loom page shows the questions next to the draft.
- A remote: when there is no `origin`, set `merge.remote`, or `remote` on the `[[repo]]`, to the remote its pull requests go through.
- A forge: when `gh` cannot open pull requests on the push URL's host, set `[merge.forge]`, or `forge` on the `[[repo]]`: `kind = "command"` with an `open` and a `state` command for that server's own CLI, and a `feedback` command when that CLI can list a pull request's checks and review comments, so Loom can send them back to the worker as fix rounds; or `kind = "none"` to only push branches. The loom skill's `references/spec.md` gives the commands' variables and the output Loom reads.
- An environment provider: when a plugin offers one, ask whether Loom's threads (workers, reviewers and the spec reviewer) run there. Set `[environment]`, or `environment` on the `[[repo]]`, to its `provider` id and `inputs` written to its schema, with `{branch}` and `{base}` where each thread's branch and starting point go. To keep plain git worktrees, set `provider = "git-worktree"`. When its environments are large or limited, give reviewers less with `reviewer = { inputs = { … } }` (a merge patch over `inputs`; reviewers only read, and Loom runs the checks in the worker's worktree), and give each ticket only what it touches with its own `environment = { inputs = { … } }`.
- The integration worktree: on `strategy = "integration"`, when git refused Loom's own worktree, offer `strategy = "pr"`, or set `[merge.worktree]` to a command that prepares a checkout and prints its path last, or to a plugin's CLI command with `plugin = "<id>"` (`bb plugin run <id> --help` lists its commands).
- Anything the human cannot answer yet goes in `project.open_questions`. `loom_propose` refuses a spec that leaves any of these unsettled, and its numbered errors name the key to set.

## 4. Read the code and run the checks once

Read the parts of each repository the goal touches. Run each check command once and note whether it passes on the base branch. A check that already fails will fail every ticket; tell the human before you propose.

When the repos use different toolchains, give each `[[repo]]` its own `checks` (and `after_merge` on the integration strategy), which replace the top-level ones for that repo's tickets. Run each repo's checks once, in that repo's checkout, and note whether they pass on its base branch.

## 5. Write the tickets

- Build only what the goal needs: the fewest tickets that deliver it, no configuration, flags, layers or future-proofing it does not use, and reuse what the repository already has. Loom's spec reviewer checks exactly this.
- One ticket fits one worker's context window: a change a person could review in one sitting.
- Acceptance criteria are testable statements, preferably in EARS form: "WHEN <event> THE SYSTEM SHALL <response>". Every ticket needs at least one.
- Scope lists the exact files or directories the ticket may change, as globs. A ticket outside its scope is flagged.
- Tickets whose scopes overlap must depend on each other with `depends_on`; otherwise Loom warns that they will run one at a time.
- On the pull request strategy a dependent ticket usually starts before its dependency merges: its brief lists each dependency's open pull request and commit, and in the same repo its worktree starts on that commit. So say in its body which of the dependency's files or names it builds on, not that the dependency "is merged". Do not plan two independent tickets in one repo that a third depends on unless you must: its pull request can open only once one of them has merged.
- `verify` lists commands that check this ticket alone. A ticket with no `verify` needs commands in `[checks]`, or in its repo's `checks`.
- Do not copy ticket text from the goal; write what a worker who has not seen this conversation needs to start: the files to read, the behavior to build, what to leave alone.
- Never write `[NEEDS CLARIFICATION]` markers. Ask the human instead.

On a project with `[[repo]]` tables:

- One ticket changes one repo, and every ticket sets `repo` to one of the `[[repo]]` names. A worker has a checkout of its ticket's repo only; it can read the other repos but not change them.
- Split cross-repo work into one ticket per repo, linked with `depends_on`: for example the API ticket first, then the web ticket that `depends_on` it. On the integration strategy a ticket starts only when the tickets it depends on are done; on the pull request strategy it starts once their pull requests are open, and reads their work from the other repo's checkout at the commit its brief names.
- Scopes, `verify` commands and protected paths are relative to the ticket's repo. Write `src/**`, not the repo's checkout path. Scopes in different repos never overlap.
- In the body of a dependent ticket, say which files of the other repo to read, such as an API schema. Its brief gives the other repos' checkout paths; on the integration strategy it can read their merged work from the integration branch, and on the pull request strategy from the commit of their open pull request.

## 6. Propose

Call `loom_propose` with the whole spec. Fix every numbered error it returns and call it again; a refused spec creates nothing. Calling it again from this thread with the same slug revises the draft. Read any warnings and fix the ones that matter.

Then wait for the spec review. For each draft version Loom starts a separate reviewer agent that reads this conversation, the spec and the code, and checks that the spec builds what the human asked for, and no more. End your turn after `loom_propose`; the verdict arrives in this thread as a message that starts with "[loom] Spec review".

- A passed review says so: hand over (step 6).
- Findings arrive as a numbered list, each with the spec path it is about. Revise the spec for each finding and call `loom_propose` again; a fresh reviewer checks the new version. If a finding is wrong, leave that part as it is and say why in your reply: the next reviewer reads this conversation.
- After three rounds with findings, Loom stops reviewing. Revise for the findings you agree with, propose once more, then hand over and name the findings you left open and why.
- A review that did not finish (the reviewer stopped, or bb could not start it) restarts when you call `loom_propose` again with the same spec.
- A revision for the human's notes is reviewed again before you hand it back.

The human can review the draft on the Loom page and send you notes. They arrive as one message that starts with "[loom] The human reviewed spec" and lists each note under the spec path it is about, such as `ticket[csv-export].acceptance[1]`: tickets by ref, list items counted from 0. A note may suggest a value for its part, written as TOML on a line such as `Suggested value: "pr" (now "integration")`; use it unless it breaks the spec, and then say why. Revise the spec for each note, or answer it in your reply, then call `loom_propose` again with the whole spec.

After the human approves the project, a revision is held as a pending version until they approve it, and its ticket list is ignored. Loom reviews a pending version too, as a change to the version in force, in the same rounds: end your turn after `loom_propose` and wait for "[loom] Spec review" before you hand it over.

## When the human has to act

Whenever the human has to do something, such as approve a pending version and then requeue the tickets it unblocks, call `loom_ask_human` with the steps in order, as well as saying them in your reply. The Loom page shows them under Needs you on the Planner tab, with a button for each: `approve` with the version, `requeue` or `reply` with the ticket key, `start`, `resume`, `land`, or `other` for anything the page cannot do. Each call replaces your earlier asks, and a step is checked off when the human does it. Call it with no steps once nothing is needed.

## 7. Hand over

Hand over only after Loom's spec review passed, or after Loom said it stopped reviewing; then also name the findings you left open. The human cannot approve a draft or a pending version whose review is still running or has findings unless they skip it with `bb loom approve <slug> --skip-review`.

Tell the human, in plain words, what you proposed and the next steps. On a project with `[[repo]]` tables, name the repos; landing opens one pull request in each repo with merged work, and `bb loom land <slug> --repo <name>` lands one. On the Loom page the next-step bar carries Approve and then Start; in a terminal the commands are:

- `bb loom spec <slug>` to read the spec.
- `bb loom approve <slug>` to approve it and create the tickets.
- `bb loom start <slug>` to start the project.

## Rules

- NEVER approve, start, pause, resume or archive a project, and never post on a ticket as the human. Those commands refuse Loom threads, and they are the human's decisions.
- NEVER propose a project for another thread's slug. This thread plans one project.
- The plugin owns every state change. You can propose a spec; you cannot move a ticket.
