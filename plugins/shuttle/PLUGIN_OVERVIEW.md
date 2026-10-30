See what each PR is waiting on and act without leaving bb. GitHub works out of the box; Delta, GitLab and other servers use command adapters.

## Five areas

- **Inbox:** the decisions waiting on you. Each PR says why it is here, what happens next and which action clears it. Snooze hides it until tomorrow or new activity.
- **My PRs:** your open PRs grouped by their next step or shown in a sortable list, followed by merged and closed PRs. Checks, reviews and agents stay beside each PR.
- **Reviews:** requests from people and teams, mentions and tracked PRs, grouped by where your review stands. Filter by team or hide bots and quiet PRs.
- **Boards:** saved PR sets for a release, project or handoff, across repositories and servers.
- **Insights:** review and merge times, feedback handled by agents, AI review results and the automation log. Sync shows each server's recent runs and explains failed steps.

## Saved PR boards

Create a board or save selected PRs from a list. Add members by searching Shuttle or pasting links and keys, filter the set, duplicate it, or remove members with confirmation and Undo. A PR can belong to several boards. Status stays live; merged and closed PRs remain until removed.

Archive a board without losing its PRs, then restore it before editing membership. Boards uses the same navigation as the other areas. Its compact timestamped activity log folds to its heading, with a remembered choice for each board on this device. Board membership never assigns agents or changes review tracking or feedback delivery.

## Work with agents

A PR's agent thread gets new reviews, comments and failed checks. Choose Fix it, Just tell it or Off. Auto agent, off by default, can find the thread on your PR's branch. Threads report which feedback they fixed, replied to or declined.

Start reviews from presets for the skill, model and workspace, or enable auto review. Reviewers hand back a draft; choose its findings and verdict before posting. Finished review threads are archived and brought back for the next review.

## Act on PRs

Each PR's view says what it is, where it stands and what happens next in one card, then shows the rest in tabs: an overview, your review, the conversation with open threads first, every check, a summary of its commits and files, and its history. Open it as a full page, or put it on boards from there.

Git links in thread messages show what they point at on hover: a PR's state and next step, a comment with its code, a commit, or a check's result. Open the PR in Shuttle on the right tab from there. Shuttle draws with your bb theme's own colours.

Merge, comment, reply, resolve threads, request reviewers, manage labels and post reviews as yourself. A thread's Shuttle tab shows its PRs in full. Search cached PRs or paste a link to look one up. Layouts adapt to phones and narrow windows, and lists remember their scroll, sort, filters and folded sections.

## Setup and tools

GitHub uses your authenticated `gh` CLI. Configure other servers with commands that print JSON; a working Delta adapter is included. Settings cover servers, presets, automations, agents and TOML import/export.

Agents use `shuttle_link`, `shuttle_prs`, `shuttle_review_draft` and `shuttle_feedback_done` for PR work, and the six `shuttle_board*` tools for saved sets. `bb shuttle` offers the same operations from the command line.
