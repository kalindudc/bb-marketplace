Run a software project with agents: a planner turns a goal into a validated spec and a ticket board, workers build the tickets in their own git worktrees, separate reviewers approve or ask for changes, and approved work merges into an integration branch or opens as one-commit pull requests the worker writes and Loom follows through CI. You watch and steer it from a full-screen page in bb's left navigation, or from `bb loom`.

## What you get

- A planner skill (`loom-plan`): any thread can propose a project as a TOML spec with tickets, acceptance criteria, checks, a review policy and a merge strategy. A separate agent checks it against your request and for work it does not need before you approve it.
- Start a project from the page: New project opens bb's own new-thread composer, and the planner's questions, its draft and the Approve and Start buttons stay on the page.
- Review a spec without reading TOML: a dashboard with the tickets in dependency waves, shared files, the checks and the limits. Press "+ note" on any part to send the planner your notes in one message, and compare its versions.
- Workers that start by themselves: one thread per ready ticket, in its own worktree, only when its dependencies are done and its files do not overlap work in flight. The plugin, not the agent, commits, runs your check commands, and decides whether the work passed.
- Reviewers on their own model: each ticket is read by fresh reviewer threads that approve or send findings back to the worker. A ticket merges only after the review you asked for and the `after_merge` checks on the merged result.
- Projects across repos: list bb projects as `[[repo]]` tables, and each ticket runs in one, with that repo's checks and integration branch. The planner offers to clone a missing checkout, and landing opens a pull request per repo.
- A Loom page: a home table that puts what needs you in each project's row, a health strip per project, a board with a row per stage, an Agents tab with every thread, a live feed, and flow and agent metrics over 7, 14 or 30 days.
- A Changes tab to see what lands before you land: the integration branch against the base, each merge, the commit in review and a working ticket's live worktree. A finished project still shows what it merged.
- A timeline on every project: rewind the page to any moment, or play it back.
- Controls with a second click: a next-step bar says what happens next and carries the one button you need now; start, pause, resume, land and archive a project; requeue, block or cancel a ticket; reply to a worker. Each is logged as your action.
- Header chips on Loom's threads and planning conversations that open them on the page.
- The planner's Ask User Question questions appear above its chat, where you answer them, and the Loom icon in the navigation rail counts what needs you.
- A ticket page with its stage, a summary, and each attempt as a card with its checks, reviews and merge.
- `bb loom metrics`, `feed` and `report` print the numbers, the events and a finished project's record. A done hook in Loom's settings sends that record, or an agent's summary of it, to a command you choose.

## How it works

Every change appends an event, in the same transaction, to a log that refuses edits, so the metrics computed from it are exact. Agents get narrow tools for their role and never merge or push. On the integration strategy the branch stays local until you run `bb loom land`: one pull request upstream, or with `--direct` a push to the base branch. A blocked ticket reaches the planner in a triage round, and so does your reply on it.

## Requirements

- `git` on the machine that has the project's checkouts.
- `gh`, signed in, for GitHub pull requests; elsewhere, the CLI `[merge.forge]` runs.
- Provider usage: every worker, reviewer and planner is an ordinary bb thread, so your providers' limits apply to them. Set a token budget or a deadline in the spec to have the plugin pause the project for you.
