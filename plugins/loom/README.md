# Loom

A bb plugin that runs a software project with agents. You describe a goal on the
Loom page, or give it to any thread. A planner agent turns it into a validated spec: the tickets with acceptance
criteria, the checks that must pass, the review policy and the merge strategy.
You approve the spec and start the project. Worker agents then take the tickets
one by one, each in its own git worktree. Separate reviewer agents approve their
work or ask for changes, and approved work merges into an integration branch or
opens as pull requests. The plugin, not an agent, owns every state change;
agents get narrow tools for their role.

## How a project runs

1. Plan: press New project on the Loom page and describe the goal, or ask any thread to plan it; every thread has the `loom-plan` skill. The planner asks a round of questions and calls `loom_propose` with a TOML spec. The plugin validates it and saves a draft.
2. Approve: the human reads the spec and approves it. The tickets appear on the board.
3. Start: the human starts the project. The plugin picks ready tickets (dependencies done, no scope overlap with work in flight) and starts a worker thread for each.
4. Work: a worker calls `loom_note` as it goes, then `loom_submit`, or `loom_block` when it needs help.
5. Check: the plugin commits the worktree and runs the ticket's and the project's check commands. A failure goes back to the worker.
6. Review: reviewer threads read the diff and call `loom_approve` or `loom_request_changes`. Requested changes go back to the worker as numbered findings.
7. Merge: the plugin merges exactly the commit that was reviewed, one ticket at a time, into the integration branch and runs the `after_merge` checks on the result. On the pull request strategy it opens one pull request per ticket and follows it.
8. Land: on the integration strategy the human runs `bb loom land` to push the branch and open one pull request upstream, or `bb loom land --direct` to merge the remote's base branch in when it moved, run the `after_merge` checks on the result, and push straight to the base branch.

A ticket that gets stuck is blocked. The planner hears about blocked tickets in a
triage round and answers with its board tools (`loom_board`, `loom_ticket`,
`loom_post`, `loom_requeue`, `loom_edit_ticket`, `loom_add_tickets` and
`loom_cancel_ticket`), or the human answers on the ticket. The human's reply on a
blocked ticket goes to the planner at once, as a message that names the ticket,
so the planner can answer with the same board tools.

When bb refuses to start a worker or a reviewer with a client error (an HTTP 4xx
status other than 408, 409 and 429), the ticket blocks at once with bb's message
as the reason, because the same request would fail again. Network errors, server
errors and those three statuses are retried up to `budget.max_attempts` times.
Approving a pending spec version, on the page or with `bb loom approve`, queues
again every blocked ticket whose worker never started, resets its failure counts
and tells the planner which tickets it requeued. A ticket blocked because bb
refused its reviewer goes back to review instead, in a new review round for the
same commit: its work already passed the checks, so no worker starts again.

Each `provider` in `[agents.worker]` and `[agents.reviewer]` must be a bb
provider id, such as `claude-code`, `codex` or `pi`. Loom checks them against
the providers bb has when the spec is proposed and refuses an unknown one,
naming the ids bb has. When bb's list cannot be read, the spec is accepted
unchecked.

`skills/loom/references/spec.md` lists every key of the spec with its default.

## Commands

```sh
bb loom list                                 # every project with its state and ticket count
bb loom show <slug>                          # state, goal, merge setup, spec versions, ticket counts, next step
bb loom spec <slug> [--version N]            # the spec as TOML
bb loom tickets <slug> [--state s,s]         # the board
bb loom ticket CSV-1                         # a ticket and its reply thread
bb loom metrics <slug> [--days N] [--json]   # flow and agent metrics, one line each; --days sets the window (default 14)
bb loom feed <slug> [--after <id>] [--json]  # the newest events as sentences
bb loom approve <slug> [--version N]         # approve a draft (creates the tickets) or a pending version
bb loom start <slug>                         # workers start by themselves
bb loom pause <slug> [--now]                 # --now also stops the worker threads
bb loom resume <slug>
bb loom post CSV-1 "text" --reply-to <id>    # your reply; a worker that holds the ticket gets it, or the planner when it is blocked
bb loom block CSV-1 "reason"
bb loom requeue CSV-1 --note "answer"        # a blocked ticket back to the queue
bb loom cancel CSV-1 "reason"
bb loom land <slug> [--title t] [--ready]    # integration strategy: push the branch, open one pull request
bb loom land <slug> --direct                 # integration strategy: merge in the remote's base, check, push to it, no pull request
bb loom archive <slug>
```

Every command takes `--json`. Each project gets a sidebar section named
`Loom · <name> (<slug>)`; the planner, workers and reviewers move into it.

## Agent tools

| Role | Tools |
|---|---|
| Any other thread | `loom_propose` |
| Planner | `loom_propose`, `loom_board`, `loom_ticket`, `loom_post`, `loom_requeue`, `loom_edit_ticket`, `loom_add_tickets`, `loom_cancel_ticket` |
| Worker | `loom_note`, `loom_submit`, `loom_block` |
| Reviewer | `loom_note`, `loom_approve`, `loom_request_changes` |

## The page

Loom adds a full-screen page to bb's left navigation. A first visit, before any
project or planning conversation exists, shows a guide: the five steps from plan to land, who does what, and
a ticket's life. "How Loom works" opens the same guide at any time.

New project shows bb's own new-thread composer, with its project, worktree,
branch, model and permission pickers; the permission picker starts on full. You
can also settle the merge plan and name a reviewer model up front. Submitting
starts an ordinary bb thread as the planner, with the `loom-plan` skill, and
opens the conversation on the page: the planner's chat beside a card for the
draft. When the planner proposes, the card fills in with the tickets, checks and
reviewer, and the next-step bar above the planner's chat offers Approve and then
Start. Conversations that have not proposed yet are listed on the home page
until their thread is archived. "Don't work in a project" is refused, because
Loom needs a git checkout. The composer starts on the project of the last
planning conversation you started from it.

Once the planner proposes, the conversation also shows the spec dashboard under
the chat and the draft card, with the warnings and the raw spec, the same one as
the project's Spec tab below. Every proposal before
approval is kept as its own version, and older drafts read as superseded. Press
"+ note" on any part of the spec to leave a note for the planner. Notes stay in
your browser until you send them, and the planner gets them in one message that
names each part, such as `ticket[csv-export].acceptance[1]`. A sent note then
shows whether the planner's next version changed that part.

The home page opens with five tiles across every project that is not archived:
projects running, agents working against the worker and reviewer slots of the
running and paused projects (a paused project's workers and reviewers finish
their turn), tickets done in the last 7 days, how many things need you, and
the sampled tokens. Under them, "Needs you" lists each blocked ticket, draft to
approve, pending spec version, finished integration project to land, and project
that Loom paused by itself (a budget or a deadline), newest first, each with a
button that opens its ticket or project. The project table shows each project's
state, strategy, ticket counts and the reason the plugin paused it, with a
progress bar, its workers and reviewers at work (not the planner, which stays on
call for triage rounds), a 14-day throughput sparkline, its tokens against the
spec's budget and the time of its last event. A search box above the table
filters it by name, key or slug as you type, and "Hide done and archived" leaves
finished projects out; the page remembers that switch.

A project with an approved spec shows a health strip above its tabs: progress,
pace over the last 14 days and the days left at that pace, the token budget and
the deadline (each only when the spec sets it), and worker and reviewer capacity
with the ready tickets that wait for a slot. Every project shows a next-step bar
under its header: the stages from Plan to Land with the current one marked, one
sentence on what happens next, and one button such as "Approve v1 · create 7
tickets" or "Start project · 2 workers". The bar turns yellow when tickets are
blocked or Loom paused the project, and names the reason and what Loom is doing
about it. When every ticket of an integration project is done or cancelled, the
bar offers Land, as does the next step in `bb loom show`. The header's "Land to
<base>" button, beside Land, lands with `--direct` instead. Open a project for
these views:

- Board: one lane per ticket state, with each card's age in its state, its attempt and review round, and a link to the thread working on it. Queued tickets are split into Ready and Waiting, and a waiting ticket names what it waits on. Before approval, the draft's tickets show as dashed cards in Ready and Waiting, with the keys approval will give them.
- Agents: every planner, worker and reviewer thread. The workers and reviewers working now come first, with their ticket, configured model, running time, timeout, tokens and rate-limit retries, and a Thread button. The planner has its own section, on call for triage rounds, with its tokens and Thread button. Below them are the tokens by role, how threads ended (idle twice, gave a verdict, timed out and so on) and the ended threads. A thread whose provider reports no token usage shows "not reported", and the tokens by role say how many such threads there are.
- Ticket: a header with the state, a one-line summary, a stage tracker from Queued to Done, and chips for the attempts, review rounds, total time, dependencies, the branch (with a copy button) and the pull request. A blocked ticket shows its reason, a link to the post that blocked it, an answer box and Requeue; Block and Cancel ticket sit in the header's ⋯ menu, and each needs a reason. The Activity tab shows one card per worker attempt, newest first (Oldest first switches the order), the newest open and older ones folded to one line. Inside an attempt, posts are cards with their replies under them, each check lists its commands with their result, time and exit code and the failed command's output, each review shows its verdict, findings and the reviewer's notes, and each merge its git steps. The Brief tab shows the brief as Markdown. A side column, or a Details tab on a narrow page, lists the acceptance criteria, the files in scope, the verify command and every worker and reviewer thread with how it ended. The reply box says who gets your reply now.
- Feed: the project's events, newest first.
- Metrics: the numbers below, with charts, and a 7, 14 or 30 day window for throughput and cumulative flow.
- Spec: the spec as a dashboard, with a summary strip and four tabs. Tickets shows the dependency waves from top to bottom, each a wrapping grid of cards that say what they wait for; selecting a ticket lights up everything it waits for and everything it unblocks, says so in a sentence, and dims the rest until you click it again or press Show all. Files starts with Shared files, one row per path that two or more tickets may change, naming the tickets and whether they run in order or one at a time; then every path grouped by folder, with an "All files" or "Shared only" filter and the selected ticket's paths highlighted; then the protected paths. Checks & review and Project & limits show the rest of the spec. Under the tabs a wide card shows the selected ticket: its brief for the worker on the left, cut short with "Show the whole brief" when it is long, and its facts on the right (priority and wave, what it waits for and unblocks, the acceptance criteria, the paths it may change and its verify commands). The dashboard also has a version switcher that marks what each version changed, "Read the raw spec", "+ note" on every part with a tray beside the tabs that sends the notes to the planner, and Approve for a pending version.
- Planner: the planner thread's chat, embedded in the page, with its open questions above it.

Every button that changes something asks twice: the first click turns it amber
with "Click again to ..." and a bar that drains over five seconds, beside a
Cancel button. Archive sits in the ⋯ menu. Each button calls the
same engine method as the matching command, and each is logged as a
`human.action` event. The page updates within about a second of an event, without
a reload. Addresses work after a reload: `/plugins/loom/loom/<slug>` opens a
project, `/plugins/loom/loom/<slug>/<KEY>` a ticket and
`/plugins/loom/loom/_plan/<threadId>` a planning conversation. A worker, reviewer or
planner thread shows a small header chip such as `CSV-3 · review` that opens
its ticket; a planning conversation shows "Planning", which opens it on the page.
The chip is hidden on phone-sized screens. A question the planner asks with
Ask User Question appears above its chat on the page, where you can answer it.
The Loom icon in the left navigation rail counts what needs you: the "Needs you"
items and Loom threads waiting on a question or an approval.

## Metrics

All of them are computed from the append-only event log and the plugin's tables,
so they can be recomputed at any time. `bb loom metrics <slug>` prints them and
`--json` prints the same numbers for scripts and agents. `--days N` (1 to 90)
sets the window for throughput and cumulative flow; every other metric covers the
whole project.

| Metric | What it is |
|---|---|
| work in progress | Tickets in working, checking, review, approved, merging or pr_open. |
| throughput | Tickets that reached done, per UTC day, for the last 14 days (or `--days`). |
| cycle time | From a ticket's first move to working until done; p50 and p85. |
| lead time | From the ticket's creation until done; p50 and p85. |
| work item age | For each ticket in flight, the time since its first move to working. |
| first-pass approval | Of the tickets that have a verdict, the share approved (or merged) with no changes requested in their first verdict round. |
| review rounds | Mean number of review rounds of done tickets. |
| check failures | `check` posts, and how many of them failed. |
| blocks | Times a ticket moved to blocked. |
| human interventions | Commands the human ran, apart from `start` and the approval of a draft. |
| tokens (sampled) | Tokens used by the project's threads in total, by role and per done ticket. They are sampled, not exact: the plugin reads each live thread about once a minute and once when it ends it. Some providers report no token usage; the threads that ended, or have run for a minute, with no sample are counted as not reporting (`tokens.unreported` in `--json`). |
| cumulative flow | Tickets in each state at the end of each of 14 days (or `--days`). A ticket counts as queued from its creation. |
| active time | Time the project ran, without the paused spans. |
| time in state and flow efficiency | Over done tickets, the time spent in each state from creation (as queued) until done. Flow efficiency is the share of that time spent working. |
| checks by command | For each check command, its runs, failed runs (a non-zero exit or a timeout) and p50 duration. The plugin's own refusals count under "scope check" and "worktree check". |
| scope flags | Check posts that found files outside the ticket's scope, and check posts that found protected paths. |
| review findings | Over reviews with a verdict: the findings, how many are blocking and should-fix, the review rounds, and the rounds that requested changes. |
| tokens by ticket | The 5 tickets whose threads used the most sampled tokens. |
| reliability | Failed worker attempts, rate-limit retries, worker threads that timed out, and merges sent back to work (a merge conflict or a failed `after_merge` check). |

## Safety

- Only plugin code moves a ticket, runs checks, merges or decides that work is done. A thread's role comes from the plugin's own table, never from thread metadata.
- Agents never merge or push. On the integration strategy nothing is pushed until the human runs `bb loom land`, and only `bb loom land --direct` pushes to the base branch, never with force and only after the `after_merge` checks pass on what it pushes.
- Workers and reviewers run in bb's full permission mode unless the spec sets `permission_mode`, because some providers, such as pi, accept no other mode. An approved spec keeps the mode it was approved with.
- The human's controls (`approve`, `start`, `pause`, `resume`, `archive`, `post`, `block`, `requeue`, `cancel`, `land`) refuse Loom's own planner, worker and reviewer threads with the code `loom_human_only`.
- The page's RPC changes state, and starts a planner thread, only when the call carries `confirm: true`, and it refuses calls from other plugins. bb cannot tell the page from an agent running `bb plugin rpc`, so the skill tells agents never to call Loom's RPC.

## How it works

- `src/states.ts` holds the project and ticket state maps; every move goes
  through one store method that updates the row and appends an event in a
  single transaction (`src/db/store.ts`). The `events` table refuses UPDATE and
  DELETE with triggers (`src/db/schema.ts`).
- `src/spec.ts` parses the spec with `smol-toml`, checks it with strict zod
  schemas, then applies the cross-field rules.
- `src/projects.ts` is the service: proposals, approval, lifecycle, the board's
  posts and the role lookup.
- `src/tools.ts` registers the agent tools and picks tools per role;
  `src/cli.ts` is `bb loom`; `src/bb-port.ts` is the one adapter over `bb.sdk`,
  faked in tests.
- `src/scheduler.ts` is pure: which tickets are ready, how many slots are free.
  `src/workers.ts`, `src/checks.ts`, `src/triage.ts`, `src/review.ts` and
  `src/merge.ts` are the engine's parts, and `src/engine.ts` is the control loop
  that ticks every 15 seconds, reconciles after a restart and handles bb's
  thread events.
- `host.ts` and `src/host/ops.ts` run on the machine that owns the checkout:
  git through argv, `gh` for pull requests, and check commands in their own
  process group.
- `src/metrics.ts` and `src/feed-text.ts` are pure; `src/reports.ts` reads them
  for the CLI and the page. `src/rpc.ts` serves the page and publishes
  `loom:changed` after a project's events and after any change that writes no
  event (`Store.changed`), at most once every 300 ms per project. A change
  outside any project, such as a new planning conversation, publishes
  `{ slug: null }`.
- `app.tsx` and `src/ui/` are the page. The app imports only types from
  `src/contract.ts`, so zod stays out of its bundle, and its charts are small SVG
  components. It also imports `src/spec-paths.ts` and `src/prompts.ts`, which
  import only types, so the notes preview is the text the planner receives.
  `src/spec-view.ts` serves one spec version to the page, parsed and compared
  with the one before, and `src/activity.ts` groups a ticket's posts, runs and
  threads into worker attempts for the ticket page.

## Credit

The structure follows
[bb-autoresearch](https://github.com/pascal-de-ladurantaye/bb-autoresearch)
(MIT): role-scoped tools re-checked against the plugin's own table, an
append-only events table with triggers, strict zod specs with reworded errors,
and a `BbPort` adapter faked in tests. The claim, retry and reconcile ideas come
from OpenAI's Symphony `SPEC.md`.

## Develop

```sh
npm install --registry https://registry.npmjs.org
npm test
npm run typecheck
bb plugin build
bb plugin install ./plugins/loom   # from this repository's root, to try it
```

The registry flag matters on machines whose configured package proxy cannot
serve the `@get-bb/plugin-sdk` tarball.
