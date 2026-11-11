Run a software project with agents. A planner writes the spec, workers build tickets in git worktrees, reviewers approve or request changes, and approved work merges into an integration branch or opens as pull requests. You follow and steer it from the Loom page in bb's left navigation, or with `bb loom`.

## What you get

- Planning from any thread with the `loom-plan` skill, or from New project on the Loom page. The planner asks its questions (Ask User Question rounds, one at a time on its page) and proposes a spec: tickets with acceptance criteria, check commands, a review policy and a merge plan.
- Phases for big goals: one at a time, each approved at a gate beside the last one's record.
- A spec review before you see it: a separate agent checks the spec against your request and for work the goal does not need.
- Spec review without reading TOML: how it runs, the tickets by wave and the goal, opening on what changed since the last version. Comment on any part or suggest a value ("+ note" on files), and the planner gets every comment in one message.
- Workers that start by themselves, one per ready ticket in its own worktree, once its dependencies are done and its files clear the work in flight. Loom, not the agent, commits, runs your checks and decides whether the work passed.
- Reviewers on their own model that approve or send numbered findings back. A ticket merges only after the review you asked for and the `after_merge` checks on the merged result.
- Two ways to ship: an integration branch you read on the Changes tab and land as one pull request, or straight onto the base with `--direct`; or one pull request per ticket that the worker writes and Loom follows through CI and review. A dependent ticket stacks on its dependency's open pull request instead of waiting for the merge.
- Hooks: when a pull request opens or a ticket blocks, Loom tells the planner what to do, or runs a command, as your Planner instructions ask.
- Deploy order as advice: Ship's Do next, the Rollout tab and each pull request show the next safe step and what must be live first.
- Projects across repos: `[[repo]]` tables, each with its own checks and integration branch; a ticket runs in one.
- A Loom page: a Home that lists what needs you oldest first, a project line with the one button you need now, a phase rail, five views, a Work list by whose move it is with a dependency map, a ticket pane with every attempt, check and review, an Insights tab per project and one for all.
- A timeline on every project: rewind the page to any moment or play it back.
- Blocked tickets go to the planner in a triage round, and your reply on one reaches it at once. The Loom icon in the navigation rail counts what needs you, and the Loom page swaps bb's sidebar for its projects and what needs you.
- `bb loom metrics`, `feed` and `report` print the numbers, the events and a finished project's record. A done hook sends that record, or an agent's summary of it, to a command you choose.

## How it works

Every change appends an event, in the same transaction, to a log that refuses edits, so metrics from it are exact. Agents get narrow tools for their role and never merge or push. On the integration strategy the branch stays local until you land it; on the pull request strategy Loom pushes the reviewed work, never with force, and you merge. A worker's pull request comments come from your account, so each ends with a signature line, "Posted by Loom" unless you change it in Loom's settings. A risky button asks "Yes, …?" in place, with no timer; the rest take one click. Each is logged as your action.

## Requirements

- `git` on the machine that has the project's checkouts.
- `gh`, signed in, for GitHub pull requests; for another server, the commands you set in the spec's `[merge.forge]`.
- Provider usage: every planner, worker and reviewer is an ordinary bb thread, so your providers' limits apply. A token budget or a deadline in the spec has Loom pause the project for you.
