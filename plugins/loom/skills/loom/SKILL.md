---
name: loom
description: "Check or manage Loom, which runs a software project with agents. `bb loom list`, `show`, `spec`, `tickets`, `ticket`, `metrics` and `feed` read a project, its spec, its ticket board, its flow metrics and its events; `post`, `block`, `requeue`, `cancel`, `approve`, `start`, `pause`, `resume`, `archive` and `land` are the human's controls. Also the guide for a Loom worker (loom_note, loom_submit, loom_block), for a Loom reviewer (loom_approve, loom_request_changes) and for a planner answering a triage round (loom_board, loom_ticket, loom_post, loom_requeue, loom_edit_ticket, loom_add_tickets, loom_cancel_ticket). Use when the user asks about a Loom project, its tickets, its reviews, its metrics, the Loom page, how its work merges or how to land it, or when you are a Loom agent."
---

# Loom

Loom runs a software project with agents. A planner agent turns a goal into a spec: the goal, the tickets with acceptance criteria, the checks that must pass, the review policy and the merge strategy. The human approves the spec and starts the project. The plugin, not an agent, owns every state change: agents get narrow tools for their role, and only plugin code moves a ticket, runs checks, merges, or decides that work is done.

Once a project runs, the plugin starts worker agents by itself, one per ready ticket, each in its own git worktree. Work that passes the plugin's checks is reviewed by separate reviewer agents, reworked until they approve, and then merged: into an integration branch, or as one pull request per ticket. For the integration strategy the human lands the branch upstream with one command.

## Commands

    bb loom list                                  # projects with state and ticket count
    bb loom show <slug>                           # state, goal, merge setup, spec versions, ticket counts, next step
    bb loom spec <slug> [--version N]             # the spec as TOML (approved version, or the draft)
    bb loom tickets <slug> [--state s,s]          # the board: key, state, priority, title, dependencies
    bb loom ticket <KEY>                          # a ticket and its reply thread, indented by reply depth
    bb loom metrics <slug> [--days N]             # flow and agent metrics, one line each, with units; --days sets the window (default 14)
    bb loom feed <slug> [--after <id>]            # the newest events as sentences, oldest first
    bb loom report <slug> [--send]                # the project's record as Markdown; --send runs the done hook again (human only)
    bb loom post <KEY> <text> [--reply-to <id>]   # the human's reply on a ticket; a worker that holds it gets it as a message, or the planner when it is blocked (human only)
    bb loom block <KEY> <reason>                  # block a ticket; its worker is stopped (human only)
    bb loom requeue <KEY> [--note <text>]         # send a blocked ticket back to the queue (human only)
    bb loom cancel <KEY> <reason>                 # cancel a ticket; its worker is stopped (human only)
    bb loom approve <slug> [--version N]          # approve a draft and create its tickets, or apply a pending version (human only)
    bb loom start <slug>                          # ready to running; creates the integration branch (human only)
    bb loom pause <slug> [--now]                  # running to paused; --now also stops every worker thread (human only)
    bb loom resume <slug>                         # paused to running; stopped workers get a continue message (human only)
    bb loom archive <slug>                        # stop the workers, cancel open tickets, remove the sidebar section (human only)
    bb loom land <slug> [--title t] [--ready]     # push the integration branch and open one pull request to the base branch (human only)
    bb loom land <slug> --direct                  # merge in the remote's base branch, run after_merge, push to the base branch with no pull request (human only)

Every command accepts `--json`. Failures carry a code: `loom_not_found`, `loom_invalid_state` (the message names the current state), `loom_invalid_spec`, `loom_invalid_input`, `loom_no_checkout` (the bb project has no checkout on the project's machine), `loom_unavailable` (git or gh is missing or failed on the project's machine; the message is the host's) and `loom_human_only`.

## Project states

- `draft`: proposed, not approved. The planner can revise it; each revision is a new version, older drafts read as superseded, and approving takes the newest.
- `ready`: approved; its tickets exist. A revision now waits as a pending version until the human approves it.
- `running`, `paused`: started, and paused again. Moves: ready to running (start), running to paused (pause), paused to running (resume). Starting or resuming makes the project's sidebar section again if it was deleted, and moves the planner thread back into it. Pausing stops new work; workers already running keep going unless the human used `--now`. A check result that finishes while the project is paused is kept on the ticket, and a failed one reaches the worker when the project resumes. The plugin also pauses a running project when its token budget is used up or its deadline has passed, and says why in `bb loom show`.
- `done`: every ticket is done or cancelled. On the pull request strategy the plugin moves the project to done by itself; on the integration strategy `bb loom land` does. The plugin then deletes the project's sidebar section, and its threads go back to the ungrouped list.
- `archived`: reachable from any state; archiving stops the workers, cancels open tickets and removes the sidebar section.

## Ticket states

`queued`, `working`, `checking`, `review`, `approved`, `merging`, `pr_open`, `done`, `blocked`, `cancelled`.

- `queued`: waiting for a worker. A ticket is ready when every ticket it depends on is done and its scope does not overlap the scope of any ticket in working, checking, review, approved, merging or pr_open. At most `agents.max_workers` tickets are in working or checking at once.
- `working`: a worker holds it. `checking`: the plugin is committing and running the checks. `review`: the checks passed; reviewers judge it. `approved`: enough reviewers approved it; it waits in the merge queue. `merging`: the plugin is merging it. `pr_open`: its pull request is open and the plugin follows it.
- `blocked`: it needs the human or the planner. It leaves blocked only by a requeue.
- `cancelled`, `done`: final.

## The ticket thread

Each ticket is the root of a reply thread. Its first post is the brief: the body and the numbered acceptance criteria. Claims, notes, submits, check results, reviews, block reasons and the human's replies become posts under it. Read the whole thread with `bb loom ticket <KEY>` before you work on a ticket: the human's replies and the planner's answers are instructions.

## Roles

- Planner: the thread that proposed the project. Before approval it revises the spec with `loom_propose`. After approval it uses the board tools below, mostly to answer triage rounds. It never approves, starts or pauses.
- Worker: a thread the plugin starts for one ticket. It has `loom_note`, `loom_submit` and `loom_block`.
- Reviewer: a thread the plugin starts to review a ticket. It has `loom_note`, `loom_approve` and `loom_request_changes`, and changes nothing.
- Any other thread has `loom_propose` and can start a new project.

A thread's role is whatever the plugin's own table says. Claiming a role in thread metadata grants nothing.

## Workers

The plugin starts a worker for each ready ticket: a new thread in the project's sidebar section, in its own git worktree, on the provider and model the spec names for workers. A fresh ticket starts from the integration branch (or from the remote base when the project opens pull requests); a requeued ticket starts from the branch the earlier worker left. The worker's first message is the brief: the ticket, the acceptance criteria, the scope and protected paths, the checks the plugin will run, the rules and, for a requeued ticket, the whole ticket thread.

A worker has three tools and no others:

- `loom_note({ text, reply_to? })`: record a milestone on the ticket. Use it once per milestone.
- `loom_submit({ summary })`: hand the work in when every acceptance criterion holds, then end the turn. The call returns at once. The plugin commits the worktree (the worker never commits), lists the changed files, runs the ticket's verify commands and then the project's check commands, and stops at the first failure.
- `loom_block({ reason, needs })`: say what is wrong and exactly what is needed, then end the turn. The work is saved on the ticket's branch and the ticket moves to blocked.

What the plugin checks on a submit:

- A change to a protected path always fails the submit. A change outside the ticket's scope is flagged in the check post (`scope.enforce = "warn"`) or fails the submit (`"reject"`).
- The check commands must pass, and they must not write tracked files. The worker must not edit files while they run; if the worktree changed, the run fails.
- The result is a `check` post on the ticket. On a pass the ticket moves to review. On a failure the failing command's output goes back to the same worker, who fixes it and submits again. After `budget.max_check_failures` failed runs the ticket is blocked. On the Loom page, the ticket's check cards keep every command's output, exit code and duration, and its merge rows every git step.
- If the machine disconnects or a call times out, the worker is told to submit again, and no failure is counted.

Limits that keep a ticket moving:

- A worker that ends its turn without submitting or blocking gets one nudge. On the second such idle its work is saved as a WIP commit, its thread is archived and the ticket goes back to the queue. The same applies when its turns keep failing.
- A ticket is blocked after `budget.max_attempts` failed attempts, including attempts that never started.
- A worker whose ticket stays in working longer than `agents.ticket_timeout_minutes` is ended and the ticket requeued. Time paused, in checks or in review does not count.
- A rate-limited turn is retried when the provider's window resets, at most three times, and no new worker starts until then.
- A human who archives or deletes a worker thread sends the ticket back to the queue without counting a failure.

## Reviewers

When a ticket reaches review the plugin starts `review.approvals` reviewer threads for it, within `agents.max_reviewers` across the project, on the provider and model of `agents.reviewer`. Use a different model than the workers: a model rates its own output higher than another's. Each reviewer gets its own worktree. The brief holds the ticket and its numbered acceptance criteria, the rubric, the scope report and check results, the diff, the findings of earlier rounds and the rules.

A reviewer has three tools and no others:

- `loom_note({ text, reply_to? })`: record what it checked.
- `loom_approve({ summary })`: every acceptance criterion holds and no blocking finding remains.
- `loom_request_changes({ summary, findings })`: send the ticket back. `findings` has 1 to 20 entries. Each is `{ severity, title, detail, file?, line? }`, where `severity` is `blocking` or `should-fix`, `title` is one line, and `detail` says what is wrong and how to fix it. Give a file and a line whenever you can.

Rules for a reviewer:

- Read and run anything, change nothing, commit nothing. Never push or merge.
- First step: `git checkout --detach <head_sha>`, the commit named in the brief. The worker can move its branch, and the verdict tools refuse ("Check out <head_sha> first, then review again.") until the worktree is on that commit.
- Judge each acceptance criterion. Approve only when every one holds and no blocking finding remains.
- Give exactly one verdict per round, then end the turn. A reviewer that ends its turn without a verdict gets one nudge and is then replaced.

The plugin counts a verdict only from the reviewer thread it started for that ticket and round, so a worker can never approve its own work. One `changes_requested` verdict decides the round: the other reviewers of the round are stopped, the findings reach the same worker as a message and as a `review` post, and the ticket goes through checks and review again. Requested changes also count toward `review.max_rounds`; when they reach it the ticket blocks and the planner or the human decides. When `review.approvals` reviewers approved, the ticket is approved and waits in the merge queue.

## Merging

Approved tickets enter a merge queue, one ticket at a time per project. The plugin merges exactly the commit that passed the checks and was reviewed, never the branch tip.

- `merge.strategy = "integration"`: the plugin merges the commit into the integration branch (`merge.branch`, `loom/<slug>` by default) in a worktree it owns, with a merge commit, then runs `checks.after_merge` on the merged result. The branch only moves forward when the combined code passes. A conflict, a failed after_merge check, or an after_merge check that commits or edits a tracked file leaves the branch where it was, and the ticket goes back to its worker: a conflict names the files and tells the worker to merge the integration branch into its own branch, resolve them, run the checks and call `loom_submit`; a failed check sends the output, and so does a check that changed the branch. Either way the ticket goes through checks and review again. No new worker starts while a merge is running, so none branches from a merge that has not passed.
- `merge.strategy = "pr"`: the plugin pushes the commit to the ticket's branch and opens one pull request with `gh`, a draft unless `merge.draft = false`, with the ticket's title, body, acceptance criteria and review summary. It follows the pull request every few minutes: merged completes the ticket, closed without merging blocks it.

Under both strategies a ticket that depends on another starts only after it is done. If git, gh or the remote is missing, or the integration branch is checked out in another worktree, the plugin pauses the project and says why in `bb loom show`; fix it and `bb loom resume`. A merge left half done resumes without a second merge commit or a second pull request.

## Landing

`bb loom land <slug>` is the human's step on the integration strategy. It pushes the integration branch and opens one pull request to the base branch, with the project's goal and the merged tickets in its description (a draft unless `--ready`, titled with `--title` or the project name). Running it again pushes the new commits to the same pull request. It refuses while a ticket is merging or when no ticket is done yet. When every ticket is done or cancelled the project is done. `bb loom land <slug> --direct` lands with no pull request instead: it waits while a worker's worktree is still being created, fetches the base branch from the merge remote into Loom's own worktree, merges it into the integration branch when it moved (refusing on a conflict, with the files), runs the `after_merge` checks on the result (refusing and resetting the branch when one fails, with its output), and pushes to the base branch without force. No new worker starts while it runs, and block and cancel wait for it. `--title` and `--ready` do not go with `--direct`. On the page, "Land to <base>" beside Land does the same. The plugin pushes to the base branch only when the human lands with `--direct`, and nothing is pushed on the integration strategy until the human lands. Agents never push, merge or land: tell the human to run `bb loom land`. When a project finishes, Loom sends its record, or an agent's summary of it, to the done hook the human set in Loom's settings; agents never run `bb loom report --send`.

## Blocked tickets

A ticket blocks when its worker calls `loom_block`, when it fails `max_attempts` or `max_check_failures` times (checks run after a merge count too), when reviewers asked for changes in `review.max_rounds` rounds, when its reviewers ended without a verdict, when its pull request was closed without merging, or when the human runs `bb loom block`. When bb refuses to start its worker or a reviewer with a client error (an HTTP 4xx status other than 408, 409 and 429), it blocks at once, with "bb refused to start a worker:" or "bb refused to start a reviewer:" and bb's message as the reason. It gets back into the queue in one of two ways:

- The human answers on the ticket (`bb loom post <KEY> <text>`) and runs `bb loom requeue <KEY> [--note <text>]`. A reply on a blocked ticket also goes to the planner at once, as a message that starts with "[loom] The human replied on <KEY>, which is blocked", with the reply as its detail; the planner reads the ticket with `loom_ticket` and answers with its board tools.
- The planner answers in a triage round (below) with `loom_post`, `loom_edit_ticket`, `loom_add_tickets` or `loom_cancel_ticket`, and requeues with `loom_requeue`.

A requeued ticket starts a fresh worker on the same branch, and the brief carries the whole thread, so it continues where the last worker stopped. Requeueing resets the failure counters and gives the ticket `review.max_rounds` fresh review rounds.

When the human approves a pending spec version, the plugin itself requeues every blocked ticket whose worker never started (bb refused it, or it failed to start `max_attempts` times). A ticket blocked because bb refused its reviewer goes back to review instead, in a new review round for the same commit, because its work already passed the checks. The plugin then sends the planner a message that names the version, the tickets it requeued or sent back to review, and the tickets still blocked. Requeue the ones still blocked with `loom_requeue` only when the new version fixes what blocked them.

Each `provider` in `[agents.worker]` and `[agents.reviewer]` must be a bb provider id, such as `claude-code`, `codex` or `pi`, not a model name such as `claude`. `loom_propose` checks them against the providers bb has and refuses an unknown one with the ids bb has; when bb's list cannot be read, the spec is accepted unchecked.

## Triage rounds

When a ticket blocks, the plugin sends the planner thread one batched message, but only when the planner is idle and no earlier round is still open. It names the board counts and, for each blocked ticket, its key, title, reason, what the worker needed, the attempt counts and the last three posts. A round also goes out when the plugin paused the project (budget or deadline).

The planner answers only through its tools; the human reads the board, not the planner's chat:

- `loom_board({ state? })`: the board, one line per ticket.
- `loom_ticket({ key })`: one ticket with its whole thread.
- `loom_post({ key, text, reply_to? })`: answer on a ticket.
- `loom_requeue({ key, note })`: send a blocked ticket back to the queue after answering.
- `loom_edit_ticket({ key, patch })`: change a queued or blocked ticket (title, body, acceptance, verify, scope, depends_on, priority; only the fields in the patch change).
- `loom_add_tickets({ tickets })`: add tickets, for example to split a blocked one or add a dependency. depends_on may name refs in the batch or tickets already on the board.
- `loom_cancel_ticket({ key, reason })`: cancel a ticket; a live worker is stopped.

The planner never starts, pauses or approves a project, and never edits the spec after approval except by proposing a new version for the human to approve.

## The Loom page

The human starts, watches and steers projects from the Loom entry in bb's left navigation. A first visit shows a guide to how Loom works, which "How Loom works" opens again at any time. New project shows bb's own new-thread composer; its submit starts a planner thread with the `loom-plan` skill, and the page then shows that planner's chat beside a card for the draft, under a next-step bar that offers Approve and then Start, and the spec dashboard under them once it proposes. Conversations that have not proposed a spec yet are listed on the home page until their thread is archived. The home page shows tiles across every project and one table of every project and planning conversation. Its "Needs you" column has a button for each thing that needs the human in that project (a blocked ticket, a draft to review, a pending spec version, a finished integration project to land, a project Loom paused by itself), and rows that need the human come first with a coloured edge; the table also shows each project's state, progress, live agents, throughput, tokens and the reason the plugin paused it. A search box filters it by name, key, slug or title, and done and archived projects that need nothing fold into a remembered "Finished" group. A project with an approved spec shows a health strip (progress, pace, token budget, deadline and capacity) above its tabs, and every project shows a next-step bar under its header: the stages from Plan to Land, one sentence on what happens next and one button, yellow when tickets are blocked or Loom paused the project. The Board tab counts the blocked tickets, the Spec tab carries a badge while a draft or a pending version waits for the human, and the Changes tab counts the files of a project ready to land that the human has not marked viewed. The tabs are a Board (a lane per ticket state, with each card's age, attempt, review round and thread link, and what a waiting ticket waits on; before approval, the draft's tickets as dashed cards), Agents (every thread with its ticket, model, running time, timeout, tokens and how it ended), a Feed of events, Metrics with a 7, 14 or 30 day window, the Spec as a dashboard (its versions, with older drafts superseded, and what each version changed; a Tickets tab with the dependency waves from top to bottom, where selecting a ticket lights up what it waits for and what it unblocks; a Files tab that lists the Shared files first, with whether their tickets run in order or one at a time, then every path by folder and the protected paths; a wide card for the selected ticket with its brief and its facts; and "+ note" on every ticket card and every part, which sends the human's notes to the planner in one message), a Planner tab with the planner's chat, and a Changes tab (the integration branch against the remote's base branch, which is what Land pushes; what each merge added; the commit in review; and a working ticket's live worktree, each file opening in bb's diff viewer with a Viewed mark; on the pull request strategy each ticket against the base; a done or archived project shows what it merged from the merge commits Loom recorded, and work whose commits are gone is left out). Under the health strip, a Timeline section rewinds the whole page, and any ticket opened from it, to a past moment or plays the project back, with every control hidden or disabled until Back to now. A ticket shows a header with its state, a one-line summary, a stage tracker and fact chips (a blocked ticket adds its reason, a link to the blocking post, an answer box and Requeue, and Block and Cancel sit in the ⋯ menu); an Activity stream of attempt cards, newest first with an Oldest first switch, where checks, reviews with their findings and notes, and merges are cards and replies sit under their post; a Brief tab with the brief as Markdown; and a side column, a Details tab when narrow, with the criteria, files in scope, verify command and every worker and reviewer thread. Every button that changes something asks twice: the first click turns it into "Click again to …" for five seconds, beside Cancel. Archive sits in the ⋯ menu. The page updates by itself within about a second of an event.

A Loom worker, reviewer or planner thread shows a header chip such as `CSV-3 · review` that opens its ticket on the page, and a planning conversation that has not proposed yet shows a "Planning" chip that opens it there. A question the planner asks with Ask User Question appears above its chat on the page, where the human can answer it. The Loom icon in bb's navigation rail counts what needs the human: the "Needs you" items and Loom threads waiting on a question or an approval. Point the human to the page when they ask where to look. Each button runs the same engine method as the matching command and is logged as the human's action, so it is the same as the command.

NEVER call Loom's RPC (`bb plugin rpc loom ...` or any call to its `control`, `reply`, `ticketAction` or `startPlanning` methods). bb cannot tell the page from an agent, so these calls change state exactly as the human's buttons do. Tell the human which command or button to use instead.

## Metrics

`bb loom metrics <slug>` prints the project's numbers, and `--json` prints them for you to read. They come from the plugin's append-only event log, so they are exact except for tokens. `--days N` (1 to 90) sets the window for throughput and cumulative flow; the other numbers cover the whole project.

- Flow: work in progress (tickets in working, checking, review, approved, merging or pr_open), throughput (tickets done per UTC day over 14 days), cycle time (first move to working until done; p50 and p85), lead time (creation until done) and work item age (time in flight, oldest first).
- Agents: first-pass approval (of tickets with a verdict, the share approved with no changes requested in the first verdict round), review rounds per done ticket, how many check posts failed, how many times a ticket blocked, and human interventions (commands the human ran, apart from `start` and the approval of a draft).
- Tokens are sampled about once a minute per live thread and once when it ends, so a thread's last minute can be missing. Report them as approximate. Some providers report no token usage at all: `tokens.unreported` counts those threads, and their tokens are missing from the totals.
- Cumulative flow is the count of tickets in each state at the end of each of 14 days; a ticket counts as queued from its creation. Active time is how long the project ran, without paused spans; `windowActiveMs` is the part of it inside the window, and the health strip's pace is the tickets done in the window over that time.
- Where the time goes: `timeInState` sums, over done tickets, the time spent in each state from creation until done, and `flowEfficiency` is the share of it spent working. `checksByCommand` lists each check command's runs, failures and p50 duration ("scope check" and "worktree check" are the plugin's own refusals), and `scopeFlags` counts check posts with files outside the scope or on protected paths.
- Review and cost: `findings` counts review findings by severity over the reviews with a verdict, with the rounds and the rounds that requested changes. `tokensByTicket` is the 5 tickets that used the most sampled tokens. `reliability` counts failed worker attempts, rate-limit retries, worker timeouts and merges sent back to work.

Use the numbers to say where work piles up: a growing queue means too few ready tickets or workers, a growing review lane or a large share of time in review means reviewers are the limit, and a low first-pass approval, many blocking findings or one check command that fails often mean the briefs or acceptance criteria need work.

## Rules for agents

- NEVER run `post`, `block`, `requeue`, `cancel`, `approve`, `start`, `pause`, `resume`, `archive` or `land` from a Loom planner, worker or reviewer thread. They are refused with `loom_human_only`. When the human needs to act, say which command.
- A worker works only in its worktree, never pushes or merges, never edits a protected path, and never runs `bb loom` commands other than the read commands. A reviewer changes nothing and commits nothing.
- Read commands (`list`, `show`, `spec`, `tickets`, `ticket`, `metrics`, `feed`, and `report` without `--send`) are fine for everyone.
- Do not edit the plugin's database or work around a refusal. If a state looks wrong, tell the human.
- The spec format, defaults and the list of errors and warnings are in `references/spec.md`.
