Run a software project with agents: a planner turns a goal into a validated spec and a ticket board, workers build the tickets in their own git worktrees, separate reviewers approve or ask for changes, and approved work merges into an integration branch or opens as pull requests. You watch and steer it from a full-screen page in bb's left navigation, or from `bb loom`.

## What you get

- A planner skill (`loom-plan`): any thread can propose a project as a TOML spec with tickets, acceptance criteria, checks, a review policy and a merge strategy. The plugin validates it with numbered errors you can act on, and you approve it before anything runs.
- Start a project from the page: New project opens bb's own new-thread composer, and the planner's questions, its draft and the Approve and Start buttons stay on the page. A first visit shows a short guide.
- Review a spec without reading TOML: a dashboard with the tickets in dependency waves, shared files, the checks and the limits. Press "+ note" on any part to send the planner your notes in one message, and compare its versions with what each one changed.
- Workers that start by themselves: one thread per ready ticket, in its own worktree, only when its dependencies are done and its files do not overlap work in flight. The plugin, not the agent, commits, runs your check commands, and decides whether the work passed.
- Reviewers on their own model: each ticket is read by fresh reviewer threads that approve or send findings back to the worker. A ticket merges only after the review you asked for and the `after_merge` checks on the merged result.
- A Loom page: a home overview with tiles and a "Needs you" list across every project, a health strip per project with its pace, budget and deadline, a board with a lane per ticket state, an Agents tab with every thread and how it ended, ticket reply threads, a live feed, and flow and agent metrics over 7, 14 or 30 days, from throughput, cycle time and flow efficiency to review findings, checks by command, tokens and a cumulative flow chart.
- Controls with a second click: a next-step bar on every project says what happens next and carries the one button you need now; start, pause, resume, land and archive a project; requeue, block or cancel a ticket; reply to a worker. Each is logged as your action. Approving the planner's fixed spec requeues the tickets whose worker or reviewer bb could not start.
- A header chip such as `CSV-3 · review` on worker, reviewer and planner threads that opens the ticket on the page, and a Planning chip on a planning conversation that opens it there.
- Questions the planner asks with Ask User Question appear above its chat on the page, where you answer them, and the Loom icon in the navigation rail counts what needs you.
- A timeline on every ticket: each check command with its output, each git step of the merge, each verdict, and every thread, ended ones included.
- `bb loom metrics` and `bb loom feed` print the same numbers and events, with `--json` for scripts and agents.

## How it works

Every change to a project or ticket goes through one store method that appends an event in the same transaction, and the event table refuses edits. The metrics are computed from that log, so they are exact and can be recomputed. Agents get narrow tools for their role and never merge or push. On the integration strategy the branch stays local until you run `bb loom land`: one pull request upstream, or with `--direct` a push to the base branch. A blocked ticket reaches the planner in a triage round, and so does your reply on it.

## Requirements

- `git` on the machine that has the project's checkout.
- `gh`, signed in, for the pull request strategy and for `bb loom land`, and a GitHub remote.
- Provider usage: every worker, reviewer and planner is an ordinary bb thread, so your providers' usage and limits apply to all of them. Set a token budget or a deadline in the spec to have the plugin pause the project for you.
