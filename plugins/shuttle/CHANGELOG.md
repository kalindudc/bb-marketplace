# Changelog

## 0.3.0

A redesign around what you do with pull requests, rather than where they come from.

- **Four areas replace seven sections.** Inbox, My PRs, Reviews and Insights. Old links to a section open the area that holds it now.
- **Inbox replaces Needs you.** One rule on the server decides each PR's next step, and the Inbox card, the row and the PR view all use its words. A card says why it is there and when it leaves, and has one main button. New review requests that ask for you by name or mention you come to the Inbox for their first three days; a setting turns this off, and another sets the days. Snooze replaces Dismiss: until 9:00 tomorrow, or until the PR changes.
- **Agents replace watching.** A PR has one agent thread, which gets its new reviews, comments and failed checks: Fix it, Just tell it or Off. The owner link, the watch switch and the watch mode were three controls that could disagree. A new agent gets the feedback already on the PR at once. Agents report what they did with each item through the new `shuttle_feedback_done` tool, and each forwarded item carries a `[ref …]` for it.
- **Auto agent**, off by default: the bb thread that opened one of your PRs becomes its agent, found by the thread id in the branch name or by the branch it works on, and only in the project whose remote is exactly the PR's repository. Off, Shuttle only suggests that thread.
- **Track replaces Watching** for other people's PRs. Existing watches on other people's PRs become tracked PRs, and a PR linked to several owner threads keeps the most recent one as its agent.
- **Reviews** is one list grouped by where your review stands, with source chips (Asked me, My teams, Mentioned, Tracked). Teams are merged across servers, and bots and PRs quiet for 30 days are hidden by default. A new `reviewed` list keeps PRs you reviewed. A bot authors setting adds to the accounts a server marks as bots.
- **Act from Shuttle.** Merge your PRs (squash, merge or rebase, only at the head you saw, or with auto-merge), comment, reply in review threads, resolve them, approve or request changes. Review threads hand their findings back with the new `shuttle_review_draft` tool; you tick, edit and post them as one review with inline comments. Findings GitHub can't place on a line go into the review's body.
- **Insights:** merges, time to merge, the wait for a first review, your review response, where your PRs spend their time, what agents did with feedback, requests per week, AI findings kept, and ideas with the button that acts on them. Shuttle starts keeping some of these numbers with this release, and says so.
- GitHub lists carry creation and merge times, check counts, your own latest review, auto-merge, bot authors and when you were asked. Command servers can send the same, and get optional `reviewed`, `merge`, `merge_options`, `comment`, `review`, `reply` and `resolve` commands; see `references/servers.md`.
- `bb shuttle list` takes `--area inbox|mine|done|reviews`; new `bb shuttle agent` and `bb shuttle track` commands.
- Pages use the whole width beside bb's sidebar. Inbox cards and Insights panels go into two or three columns when there is room, and back to one when a PR is open beside them. A click anywhere on a card or row opens its PR; its own buttons only do what they say. Snooze sits in each card's top row.
- Safety for the new writes: merges and reviews stay on the head you saw; before a draft is posted Shuttle reads the PR's head from its server, and a draft whose review read an older head says so, can't approve, and posts only once you confirm; a newer review's draft is never replaced by an older thread's. A server that answers for another PR is refused, and keys with characters a repository can't have are refused.
- The Delta adapter works on each PR's own repository instead of always shop/world, posts every review with its commit, and sends failed checks to agents.
- Reloading or updating Shuttle during a sync no longer leaves it stuck with "service sync did not stop", starts no more auto reviews once stopped, and a sync cut short no longer marks its server as failing.
- Server links go into review prompts only as plain URLs, like titles and authors as one line. Reviewers GitHub or Delta reports as bots are kept apart from people in Insights, and a request withdrawn and asked again counts twice, each in its own week.

## 0.2.1

- Menus and sheets drawn over the page now get all of Shuttle's styles. bb applies a plugin's CSS only inside the plugin's own part of the page, and these were drawn outside it, so they kept only the classes bb's own stylesheet also has. In the reviewer picker, for example, the avatars were squashed and the group headings were too large. A test now fails if a menu or sheet is drawn without Shuttle's styles.

## 0.2.0

- Shuttle works on a phone. Opening a PR shows it on its own screen, with a bar to go back and a bar at the bottom for Review, Link and Open; Back and the swipe return to the list. The list shows the sections as chips, and the review presets, labels and reviewers open as sheets from the bottom.
- In windows narrower than 1280px, the PR panel slides over the list instead of appearing below it. Escape, ×, or a click outside closes it.
- A "Manage your PR" card on your own PRs: mark a draft ready for review or turn it back into a draft, close or reopen it, add and remove labels, and request or withdraw reviewers or ask someone to review again. Each change goes to the server at once and offers Undo for a few seconds; a change the server refuses is put back, with its reason.
- PRs show their labels, and the PR panel lists requested reviewers and everyone's latest review. Other people's PRs show them read-only.
- GitHub uses `gh pr ready`, `gh pr close`, `gh pr reopen` and the REST API for labels and reviewers. Command servers get optional `ready`, `draft`, `close`, `reopen`, `edit_labels`, `edit_reviewers` and `edit_options` commands; the Delta adapter has all but `draft` and `edit_options`, since Delta can't go back to draft.
- While a PR is on screen, Shuttle reads it from its server every minute, so new reviewers and labels appear.

## 0.1.4

- A server can say how reviews get their own checkout of its PRs, for repositories that refuse bb's git worktree (World only allows worktrees under `~/world/trees`): a bb environment provider such as World tree, with inputs, or a command that prints a checkout's path, such as one around `dev tree add`. Inputs and the command take the PR's number, repo, branches and head; in a command they are shell-quoted. Set it under Review workspace when editing a server.
- Editing a server in Settings no longer drops its read command.

## 0.1.3

- The Review button's preset menu renders above the page, in bb's shared dropdown, instead of being clipped by the PR drawer it sits in.
- Starting a review with the worktree workspace no longer fails with "hostId is required": Shuttle creates the worktree on the machine that has the project's default checkout, or bb's primary machine.
- The PR drawer is wider (up to 640px, at most 45% of the page) and shows the PR's description, rendered as Markdown; a long one is folded until you open it. Lists carry no description, so Shuttle reads it from the server the first time you open a PR. Command servers can send it as `body` from `view`; the Delta adapter does.

## 0.1.2

- Installs from the marketplace. Git installs leave dev dependencies out, and the UI imported `defineRpcContract` from the SDK's root entry, which only a dev dependency provides; the UI now uses its own copy of that identity function.

## 0.1.1

- Adds an `.npmrc` so `npm install` in the plugin uses the public npm registry, which has the plugin SDK Shuttle pins. This did not fix the marketplace install; 0.1.2 does.

## 0.1.0

The first release: every pull request that needs you, from any server, in one place.

- **Servers:** GitHub is built in, through `gh`. Any other server is a command server: a link pattern and one shell command per operation, each printing JSON. A working Delta adapter, with team requests, ships in `skills/shuttle/references/delta.sh`. A list a server cuts short never drops PRs it did not reach.
- **Lists:** Needs you, Requested of me, My teams, Mentioned and Watching, plus your PRs in flight and done. Look up any PR by pasting its link.
- **Threads:** link a PR to any thread, or start a new one for it. A thread can own several PRs, and a PR can have several threads. The thread's Info tab and the line above its composer list every PR it owns, and its Shuttle tab offers to link the PR on the thread's branch.
- **Reviews:** start one from a preset (skill, agent, model, thinking level, workspace and prompt), or change one run. Auto review starts a review thread when you are requested by name, with a daily limit and a repository filter; requests already waiting at the first sync never start one. Review threads can go to a sidebar section of your choice.
- **Watched PRs:** new reviews, review comments and failed checks go to every owner thread, batched into one message per thread, with server text kept in data blocks. Each owner gets each item once, and a failed send is retried for that owner only.
- **Settings:** on Shuttle's page in bb's Settings: sync interval, the Done window, the project and section for review threads, servers with a Test button, review presets, automations, and import or export as TOML.
- **Agents and the CLI:** the `shuttle_link`, `shuttle_unlink` and `shuttle_prs` tools, and `bb shuttle`.
