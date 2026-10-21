Run a software project with agents: a planner turns a goal into a validated spec and a ticket board, workers build the tickets in their own git worktrees, separate reviewers approve or ask for changes, and approved work merges into an integration branch or opens as pull requests. You watch and steer it from a full-screen page in bb's left navigation, or from `bb loom`.

## What you get

- A planner skill (`loom-plan`): any thread can propose a project as a TOML spec with tickets, acceptance criteria, checks, a review policy and a merge strategy. The plugin validates it with numbered errors you can act on, and you approve it before anything runs.
- Start a project from the page: New project opens bb's own new-thread composer, and the planner's questions, its draft and the Approve and Start buttons stay on the page. A first visit shows a short guide to how Loom works.
- Workers that start by themselves: one thread per ready ticket, in its own worktree, only when its dependencies are done and its files do not overlap work in flight. The plugin, not the agent, commits, runs your check commands, and decides whether the work passed.
- Reviewers on their own model: each ticket is read by fresh reviewer threads that approve or send findings back to the worker. A ticket merges only after the review you asked for and the `after_merge` checks on the merged result.
- A Loom page: a home overview with tiles and a "Needs you" list across every project, a health strip per project (progress, pace, budget, deadline and capacity), a board with a lane per ticket state, an Agents tab with every thread and how it ended, ticket threads with replies in the Usenet style, a live feed, the spec with its pending version, and flow and agent metrics over 7, 14 or 30 days: work in progress, throughput, cycle time, time in state and flow efficiency, first-pass approval, review findings, checks by command, reliability, tokens and a cumulative flow chart.
- Controls with a second click: start, pause, resume, land and archive a project; requeue, block or cancel a ticket; reply to a worker, which it reads as a message. Each is logged as your action.
- A header chip such as `CSV-3 · review` on worker, reviewer and planner threads that opens the ticket on the page.
- `bb loom metrics <slug>` and `bb loom feed <slug>` print the same numbers and events, and `--json` is there for scripts and agents.

## How it works

Every change to a project or ticket goes through one store method that appends an event in the same transaction, and the event table refuses edits. The metrics are computed from that log, so they are exact and can be recomputed. Agents get narrow tools for their role and never merge or push. On the integration strategy the branch stays local until you run `bb loom land`, which opens one pull request upstream. A blocked ticket reaches the planner in a triage round, or you answer it on the page.

## Requirements

- `git` on the machine that has the project's checkout.
- `gh`, signed in, for the pull request strategy and for `bb loom land`, and a GitHub remote.
- Provider usage: every worker, reviewer and planner is an ordinary bb thread, so your providers' usage and limits apply to all of them. Set a token budget or a deadline in the spec to have the plugin pause the project for you.
