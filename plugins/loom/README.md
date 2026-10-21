# Loom

A bb plugin that runs a software project with agents. You give a thread a goal. A
planner agent turns it into a validated spec: the tickets with acceptance
criteria, the checks that must pass, the review policy and the merge strategy.
You approve the spec and start the project. Worker agents then take the tickets
one by one, each in its own git worktree. Separate reviewer agents approve their
work or ask for changes, and approved work merges into an integration branch or
opens as pull requests. The plugin, not an agent, owns every state change;
agents get narrow tools for their role.

## How a project runs

1. Plan: a thread with the `loom-plan` skill calls `loom_propose` with a TOML spec. The plugin validates it and saves a draft.
2. Approve: the human reads the spec and approves it. The tickets appear on the board.
3. Start: the human starts the project. The plugin picks ready tickets (dependencies done, no scope overlap with work in flight) and starts a worker thread for each.
4. Work: a worker calls `loom_note` as it goes, then `loom_submit`, or `loom_block` when it needs help.
5. Check: the plugin commits the worktree and runs the ticket's and the project's check commands. A failure goes back to the worker.
6. Review: reviewer threads read the diff and call `loom_approve` or `loom_request_changes`. Requested changes go back to the worker as numbered findings.
7. Merge: the plugin merges exactly the commit that was reviewed, one ticket at a time, into the integration branch and runs the `after_merge` checks on the result. On the pull request strategy it opens one pull request per ticket and follows it.
8. Land: on the integration strategy the human runs `bb loom land` to push the branch and open one pull request upstream.

A ticket that gets stuck is blocked. The planner hears about blocked tickets in a
triage round and answers with its board tools (`loom_board`, `loom_ticket`,
`loom_post`, `loom_requeue`, `loom_edit_ticket`, `loom_add_tickets` and
`loom_cancel_ticket`), or the human answers on the ticket.

`skills/loom/references/spec.md` lists every key of the spec with its default.

## Commands

```sh
bb loom list                                 # every project with its state and ticket count
bb loom show <slug>                          # state, goal, merge setup, spec versions, ticket counts, next step
bb loom spec <slug> [--version N]            # the spec as TOML
bb loom tickets <slug> [--state s,s]         # the board
bb loom ticket CSV-1                         # a ticket and its reply thread
bb loom metrics <slug> [--json]              # flow and agent metrics, one line each
bb loom feed <slug> [--after <id>] [--json]  # the newest events as sentences
bb loom approve <slug> [--version N]         # approve a draft (creates the tickets) or a pending version
bb loom start <slug>                         # workers start by themselves
bb loom pause <slug> [--now]                 # --now also stops the worker threads
bb loom resume <slug>
bb loom post CSV-1 "text" --reply-to <id>    # your reply; a worker that holds the ticket gets it
bb loom block CSV-1 "reason"
bb loom requeue CSV-1 --note "answer"        # a blocked ticket back to the queue
bb loom cancel CSV-1 "reason"
bb loom land <slug> [--title t] [--ready]    # integration strategy: push the branch, open one pull request
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

Loom adds a full-screen page to bb's left navigation. It lists every project with
its state, strategy, ticket counts and the reason the plugin paused it. Open a
project for five views:

- Board: one lane per ticket state, with each card's age in its state, its attempt and review round, and a link to the thread working on it. Queued tickets are split into Ready and Waiting, and a waiting ticket names what it waits on.
- Ticket: the reply thread, indented by reply depth, with a Reply box on every post and Requeue, Block and Cancel buttons.
- Feed: the project's events, newest first.
- Metrics: the numbers below, with charts.
- Spec: the approved spec, any pending version and an Approve button.

Start, Pause, Resume, Land, Archive and the other buttons ask twice: the first
click changes the label to "Confirm ..." for five seconds. Each button calls the
same engine method as the matching command, and each is logged as a
`human.action` event. The page updates within about a second of an event, without
a reload. Addresses work after a reload: `/plugins/loom/loom/<slug>` opens a
project and `/plugins/loom/loom/<slug>/<KEY>` a ticket. A worker, reviewer or
planner thread shows a small header chip such as `CSV-3 · review` that opens
its ticket.

## Metrics

All of them are computed from the append-only event log and the plugin's tables,
so they can be recomputed at any time. `bb loom metrics <slug>` prints them and
`--json` prints the same numbers for scripts and agents.

| Metric | What it is |
|---|---|
| work in progress | Tickets in working, checking, review, approved, merging or pr_open. |
| throughput | Tickets that reached done, per UTC day, for the last 14 days. |
| cycle time | From a ticket's first move to working until done; p50 and p85. |
| lead time | From the ticket's creation until done; p50 and p85. |
| work item age | For each ticket in flight, the time since its first move to working. |
| first-pass approval | Of the tickets that have a verdict, the share approved (or merged) with no changes requested in their first verdict round. |
| review rounds | Mean number of review rounds of done tickets. |
| check failures | `check` posts, and how many of them failed. |
| blocks | Times a ticket moved to blocked. |
| human interventions | Commands the human ran, apart from `start` and the approval of a draft. |
| tokens (sampled) | Tokens used by the project's threads in total, by role and per done ticket. They are sampled, not exact: the plugin reads each live thread about once a minute and once when it ends it. |
| cumulative flow | Tickets in each state at the end of each of 14 days. A ticket counts as queued from its creation. |
| active time | Time the project ran, without the paused spans. |

## Safety

- Only plugin code moves a ticket, runs checks, merges or decides that work is done. A thread's role comes from the plugin's own table, never from thread metadata.
- Agents never merge or push. On the integration strategy nothing is pushed until the human runs `bb loom land`.
- The human's controls (`approve`, `start`, `pause`, `resume`, `archive`, `post`, `block`, `requeue`, `cancel`, `land`) refuse Loom's own planner, worker and reviewer threads with the code `loom_human_only`.
- The page's RPC changes state only when the call carries `confirm: true`, and it refuses calls from other plugins. bb cannot tell the page from an agent running `bb plugin rpc`, so the skill tells agents never to call Loom's RPC.

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
  event (`Store.changed`), at most once every 300 ms per project.
- `app.tsx` and `src/ui/` are the page. The app imports only types from
  `src/contract.ts`, so zod stays out of its bundle, and its charts are small SVG
  components.

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
