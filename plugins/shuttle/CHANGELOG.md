# Changelog

Notable changes to Shuttle, newest first. Releases are tagged `shuttle/vX.Y.Z` in this repository.

## 0.5.0 (2026-10-30)

### Added

- An Inbox you can triage. Each PR is one row under what to do with it: Needs you, Ready to merge, AI reviews to post, Updated since your review and New review requests, each heading with its count and folding its section. A row starts with the author's avatar, or a plain PR mark on your own PR, then the repo, the number and the title, and its second line says only what the heading does not: failing checks, who asked for changes, no agent, who approved, how many findings, mentions and the size.
  - Search by title, repo, author or number, and group by what to do, by repository or not at all, sorted by priority, newest or oldest activity, or smallest first. Shuttle remembers the choice on this device.
  - A dot and a bold title mark a PR that changed since you last opened it, on any device. Opening it clears the dot, and Mark all as seen in the header's ⋯ menu clears them all.
  - Pointing at a row, or moving to it with J and K, shows its next step, Snooze, Dismiss and ⋯. The row's ⋯ menu snoozes or dismisses that PR, or keeps PRs like it out.
- Snooze, dismiss and rules. Snooze until later today, tomorrow, next week or until it changes; anything new still brings a PR back sooner. Dismiss keeps a PR out of the Inbox for good, even when it changes, and it stays in My PRs or Reviews. A rule keeps out every PR by an author, every PR from a repo, or mentions in a repo when you are not asked to review, and the row's menu says how many PRs in the Inbox each would take out. Snoozes, dismissals and rules have Undo, in their toast or with U.
  - The Snoozed tab says when each PR comes back and has Wake now. The Dismissed tab marks a PR that changed since you dismissed it with New activity, and the tab gets a dot; Restore brings one back. Your rules are listed there with what each keeps out, and Remove.
  - The PR view's ⋯ menu adds Dismiss from the Inbox and Restore to the Inbox.
- Several PRs at once, and the keyboard. Tick rows, Shift-click a range or press X, then snooze or dismiss them together. The keys are J, K, Enter, X, E, S, U, / and Escape, listed under the header's ⋯ menu. On a phone, swipe a row left to dismiss it or right to snooze it.
- Tooltips on the buttons. The Inbox's buttons, and the next-step buttons in the PR view, say what they do, with their key when they have one.
- A PR view that reads in the order you ask. The header says what the PR is: its title and state, who wants to merge how many commits from which branch, its labels and the boards it is on. One status card says where it stands: the next step with its buttons, then a row each for your review, reviews, checks, whether it can merge, the agent and, on someone else's PR, its size. Each row says what it waits on and opens the tab with the rest. The card replaces the strip, the next-step banner, the agent card and the your-review card.
- Tabs for the details. Each PR keeps the tab you left it on.
  - Overview: the description, the people and where each review stands (on which commit, and whether that commit is older than the head), the PR's facts and its linked threads. You request, withdraw and re-request reviewers here and edit labels from the header, instead of in a folded Details section.
  - Your review: the AI review draft to post, on someone else's PR.
  - Conversation: open review threads first, each with the lines of code it is on, its replies, what the agent did with it, and Reply, Resolve and Send to the agent. Reviews, comments and resolved threads follow in a timeline, newest first, with a button to flip the order that this device remembers. Bot comments fold and can be hidden, and what arrived since your last visit on this device is marked New.
  - Checks: every check on the head, on every PR, failing first, with whether it is required, how long it took, its log and, on your PR, whether it went to the agent.
  - Changes: the last 100 commits and the first 100 files with their line counts and open threads, and a link to the full diff. File contents are never read, so a PR with thousands of files costs no more than one with a hundred.
  - History: what happened to the PR, newest first by day, from the server and from Shuttle and its agents, with a filter by where it happened.
- A full page, and a menu for the rest. Expand a PR from beside a list to open it on a page of its own, with the people, facts and threads in a column beside the tabs on a wide window. A PR's link and a look-up open there too, and collapsing puts it back beside its list. Draft, close, reopen, copying, tracking, snoozing, linking a thread and starting an AI review are in the ⋯ menu.
- Link a thread for what it is for. Linking a thread to your own PR offers Agent, with Fix it or Just tell it, or Reference only; Review is gone there, since it never sent the thread any feedback. If the PR already has an agent, the dialog says which thread the new one takes over from. On someone else's PR the choices are Review or Reference only, each with a line on what it does, and a thread the dialog starts can be its agent or run an AI review.
- Boards from the PR. The header lists the PR's boards. Its picker puts the PR on more boards, takes it off one, or starts a new board with it.
- Cards on git links in threads. A link in a thread message to a PR or one of its pages, a comment or review on it, a commit, a check or workflow run, or an issue gets an icon for what it names, coloured by its PR's or issue's state, and a dotted underline. A short rest on the link, keyboard focus or a tap on a phone opens a card with what Shuttle knows about it; from the keyboard, Down moves into the card and Escape comes back. Open in Shuttle opens the PR on the tab the link is about. Cards never write. A PR Shuttle has not seen is never fetched on a hover; the card offers to look it up instead. An issue card shows its state, labels, assignees, comments and the PRs that close it, read from GitHub, since Shuttle keeps no copy of issues; an issue link whose number is a PR's shows the PR. Issues, and commits or checks Shuttle cannot place, are read at most once a minute. Links that git-cards already decorates are left to it.
- Shuttle follows your bb theme. Everything takes bb's theme tokens, so a theme such as Gruve no longer turns Shuttle yellow. Buttons, hover and selection look like bb's own. A PR's state is a neutral chip coloured only on its icon, with merged in the theme's merged colour instead of its accent colour. Labels are neutral chips with a dot in their colour, avatars use the theme's terminal palette, branch names look like bb's inline code and diffs use the theme's diff colours. Text stays inside its box in monospace themes.
- Boards on a phone. Board cards fit the screen in one column. A board has a way back to Boards, keeps Add PRs (or Restore board) on screen and moves its other actions into a sheet. Its counts sit in two columns, its filters share one row, and the selection's actions stay at the top while the list scrolls. On a phone, lists leave out the selection hint until something is selected.

### Changed

- The Inbox leaves other areas their jobs. Its count stays in Shuttle's sidebar, the agents summary is in My PRs, and one line links to Insights › Automation log instead of listing what automation did.
- Details are read only when you open a PR. The PR view gets its checks, commits, files, timeline, merge state and each thread's code in the same read as its conversation, kept for 30 seconds. Syncs and agent watching read no more than before.
- For command servers. `activity` gets `SHUTTLE_DETAIL=1` when a PR view opens and may print the same details (see `servers.md`). Every command gets `SHUTTLE_SCRIPTS`, the folder of adapter scripts in the installed Shuttle, so a server that runs a script from there follows each upgrade. When a command server sends no commits or files, the Changes tab says how to add them. The reference Delta adapter sends every detail, and reads a PR with up to 100 files in one compare, without patch text.

### Fixed

- A PR snoozed until it changes, or with Not now, no longer looks unsnoozed: it shows as snoozed, and its ⋯ menu offers Bring back to the Inbox instead of Snooze again.

### Compatibility

- One migration: `prs.dismissed_at` becomes `snoozed_at`, and `inbox_dismissed_at`, `seen_at` and an `inbox_rules` table are added. Existing PRs count as seen, so nothing turns new on upgrade. Shuttle 0.4.4 cannot read the database afterwards, so going back to it needs a copy of the database from before the upgrade.

## 0.4.4 (2026-10-29)

### Fixed

- Hold the PR's scroll position while its content settles. Live verification of 0.4.3 found that late rendering could shift the restored position after it was first reached. PR panes now keep restoring for about five seconds with browser scroll anchoring disabled during that window. Scrolling, touching, clicking or typing takes over immediately; ordinary list restoration is unchanged.

## 0.4.3 (2026-10-29)

### Added

- Keep your place when a PR view is recreated. Each PR restores its scroll position in the desktop panel, narrow overlay, phone layout, standalone view and thread tab. Expanded descriptions and Details, open reply boxes, unfinished comments and replies, and edits to an AI review draft stay in the current browser tab's session. Live syncing stays on; ordinary background refreshes still update the existing view in place.

### Changed

- Keep drafts separate and clear text after sending. Working state belongs to its PR, replies belong to their conversation item, and AI-review edits belong to their draft ID. A new AI review starts cleanly. Sending a comment or reply, or cancelling a reply, clears that text; failed sends keep it. Restored replies do not steal focus, and confirmation to post a stale review is never remembered.

## 0.4.2 (2026-10-29)

### Added

- Add context when starting an AI review. The preset dialog now has an optional Note for the reviewer field for both first reviews and re-reviews. Add context or areas to focus on without opening the custom-review dialog. Notes apply only to that run, and blank notes are omitted.

### Changed

- Keep your note when changing review options. Opening Change for this run… preserves the note and lets you edit it before starting. Both dialogs limit notes to the existing 4,000-character maximum.

## 0.4.1 (2026-10-29)

### Added

- Sort and group board PRs. Each board has Sort by and Group by menus. Keep the saved order or sort by update time, creation time, merge or close time, repository, or size. Group by status, repository, server, or author, with sorting inside each group. Repositories and author accounts on different servers stay separate.
- Remember each board's view. Fold individual groups or collapse and expand them all. Shuttle keeps sorting, grouping, and group folds separately for each board on this device, independently of the Activity log. These controls also work on archived boards and never change saved membership.

## 0.4.0 (2026-10-28)

### Added

- Saved PR boards. Keep an explicit set of PRs for a release, project, or handoff, across repositories and servers. Create an empty board, save a selection from My PRs, Reviews or Search, or add PRs by searching Shuttle or pasting links and keys. A PR can belong to several boards. Its status stays live, and merged or closed PRs stay in the set until removed.
- Curate without changing ownership. Rename, describe or duplicate a board, filter its PRs, remove selected members with confirmation and Undo, and open their ordinary detail panels. Membership badges show exactly which boards contain a PR. Board operations never assign an agent, change review tracking or alter feedback delivery.
- Archive and restore. Archive hides a board from active navigation without losing its saved PRs. Archived boards stay read-only until explicitly restored. Boards follows the other navigation areas: its submenu appears only while Boards is open.
- A compact activity log. Each board shows timestamped log lines for membership and metadata changes. Fold Activity to hide the log; Shuttle remembers the fold separately for each board on this device. Filters have more space above the PR list.
- Threads and the CLI can manage boards. The six new `shuttle_board*` tools and `bb shuttle board list|show|create|update|add|remove` share the same validation, archive guards and atomic membership operations. Adding the same PR again is safe. Board PRs stay fresh during sync and while their board is open.

## 0.3.8 (2026-10-26)

### Added

- A thread's Shuttle tab shows a PR in full. View PR on a card, or a click on its title, opens the PR inside the tab with everything its view on the Shuttle page has: where it stands, the next step and its buttons, the agent or your review, the description, the conversation with Reply, Resolve and the composer, checks, labels and reviewers, and its threads. Merge, Start AI review, Link a thread and the other dialogs open from there too, so you no longer leave the thread to act on its PR. Pull requests goes back to the list, and the tab reopens on the PR you left it on, for each thread. A PR clicked in the thread's Info tab or in the Pull requests segment above the composer opens the tab on that PR.

### Fixed

- Link a thread lists all your threads. bb's thread list included archived threads unless asked not to, sorted by project before date, so the 200 threads Shuttle read were mostly archived ones and the dialog showed only a few live threads. Shuttle now asks for unarchived threads only, and reads every page of them. Link a thread and the agent picker list your 200 most recently active threads, and their search looks through all of them. Auto agent's search for the thread on a PR's branch had the same gap and now sees every live thread, and the title refresh reads linked threads by id.

## 0.3.7 (2026-10-26)

### Changed

- The open PR stands out. The PR open in the panel beside a list now has a tint and a ring in your theme's primary colour, on Inbox cards and on the rows of My PRs, Reviews and Search alike. Before, an Inbox card had only a faint outline, and a row the same grey as a hovered one. Hovering no longer changes the open PR's look, and screen readers hear the open Inbox card as the current one.

## 0.3.6 (2026-10-26)

### Added

- Insights › Sync shows why a server failed. Each server shows its syncs of the last three hours as marks. Under them are the last failed sync step by step (who you are, each list, the linked and tracked PRs), what the command printed, its exit code and the command itself. You can copy all of it. A server that has recovered keeps its last failed sync, folded, in the same detail. The week's failures follow, and each opens to its output. Sync now syncs that server alone.
- A banner when a server keeps failing. After two failed syncs in a row, every page says which step failed and why in plain words. It also says how old that server's PRs are, and when Shuttle tries again or what you need to do, such as `dt auth login`, with a button that copies it. A refused sign-in shows at once, since waiting will not fix it, and it is what the banner explains even when another step failed first. In the sidebar, a server that is failing, or that failed in the last hour, says why in one line and opens the Sync tab.
- Shuttle tries again, a little. A step that fails with a server error, a network error or a cut-short answer is tried once more after 3 seconds. A server gets at most two such retries a sync. A rate limit or a timeout, including a gateway timeout (HTTP 504), is never retried, so a slow server is not asked again for the same slow request. After two failed steps in a row, such as two server errors or timeouts, Shuttle leaves the rest of that server's steps for the next sync. A server that rate-limited Shuttle or is down is not asked about each watched PR in that sync either. GitHub searches, which already retry their own pages, are not retried again on top. After a server's first failed sync, Shuttle syncs that server once more a minute later, so the banner, or the end of the failure, does not wait a whole interval. It does not when any step of that sync was rate-limited.

### Changed

- One failed list is a warning, not a failed server. When some lists fail and the rest pass, the server is partly synced: its dot turns yellow, and only the PRs that the failed lists bring are marked "Data from 11:28". They used to be marked "May be out of date", and so were all of the server's other PRs. A linked or tracked PR is marked only when its own read failed. Auto reviews still start from the lists that passed, but not from a list that failed, since it may hold a request that was withdrawn.
- `bb shuttle status` shows the same reason: the step, the cause, the end of what the command printed, the last good sync, and what happens next. `bb shuttle sync` reports the servers that failed and takes `--server <id>`; asked for a server while another syncs, it waits and then syncs the one you asked for. The Automation log says which step failed and why.

### Fixed

- Delta syncs say why they failed. When Delta was briefly down, for example while its host restarted (HTTP 503), `delta.sh` piped the failed `dt` call into `jq`. `jq` printed nothing and exited 0, so Shuttle saw a command that worked and said only "whoami did not print JSON: no output". Now `delta.sh` fails with `dt`'s own error and exit code. When Delta refuses your sign-in, it adds "run `dt auth login`". Any command that exits 0 without its JSON now fails with what it printed on stderr.

## 0.3.5 (2026-10-26)

### Fixed

- GitHub syncs no longer fail on GitHub's time limit. GitHub ends a GraphQL request that takes more than 10 seconds, and a search page of 50 PRs with everything Shuttle reads took 7 to 11 seconds. A sync then failed with `gh: HTTP 502`, `HTTP 504` or `unexpected end of JSON input`, and GitHub's PRs showed the last good data. Shuttle now asks for 25 PRs a page, still up to 300 per list. A page that times out is tried twice more from where it stopped, asking for 12 PRs and then 6. The empty-body error that gh reports as `unexpected end of JSON input` counts as a timeout too.

## 0.3.4 (2026-10-25)

### Added

- Sort My PRs, or keep the groups. My PRs has a Grouped and List switch and a Sort by menu: Recently updated, Newest first, Oldest first, Repository and Largest first. List shows every open PR in one list, each row with a pill for the group it would be in; Grouped keeps the sections and sorts the rows inside each. Merged and closed sorts too, by when each merged by default. A row shows the time its list is sorted by, such as "opened 3d ago".
- Fold sections. Click a section's title in My PRs, Reviews or the Inbox's Handled for you to fold it to its title and count, and again to open it. Collapse all and Expand all do every section on the page.
- Shuttle remembers where you left it. Opening Shuttle from the rail goes back to the list and the PR you last had open, and each list scrolls back to where you left it, including when a PR opens beside the list. Your folds, the My PRs layout and sort, and the Reviews filters (team, Hide bots, Hide quiet) are kept on this device and follow other bb windows. The Inbox now has its own path, `inbox`, so picking it is remembered too.

### Changed

- The PR's description is in its view. It shows above the conversation instead of inside the folded Details, and a long one is still cut until you ask for the rest.
- A wider PR panel on desktop. The panel beside the list is 640px wide, up from 540px, and may take up to 55% of the page; the panel that slides over the list in a narrow window is up to 640px too.

## 0.3.3 (2026-10-25)

### Fixed

- You can post a review on someone else's draft PR. Shuttle offered Post review, Approve and Request changes only on PRs marked ready for review. A review draft on a draft PR then said the server had no `review` command and pointed to Settings › Servers, even on GitHub, where the command is built in. Merging still waits until a PR is ready for review.

## 0.3.2 (2026-10-24)

### Added

- Review threads are archived when their review is done. Shuttle archives a review thread it started once you post or discard its draft, review the PR yourself, or the PR merges or closes. bb archives the thread's child threads with it, such as a reviewer's critics. A thread that is still working or waiting on you is archived once it stops. Shuttle never archives a thread you picked yourself or made the PR's agent, and leaves alone a thread you brought back from the archive until its next review. Undo after a discard brings the thread back. A setting, Archive finished review threads, turns this off.

### Changed

- The next review of a PR brings its review thread back instead of starting another one, so it already knows the PR. bb brings back only the thread, not its child threads, and builds its workspace again if it was removed. The run gets the preset's model and thinking level. A new thread starts instead when the old one is gone, runs on another agent than the preset, or refuses the message, and the Automation log says why. Change for this run… defaults to that thread and still offers a new one, and `bb shuttle review` takes `--new-thread`.

## 0.3.1 (2026-10-24)

### Added

- Search. The header's field searches the PRs Shuttle already has as you type: words in the title, repository, number, author, branches, server or labels, every word matching; `#2213` is a PR number. Results open on a Search page, your open PRs first, then other people's, then merged and closed ones, each opening beside the list. A pasted link or key is still looked up on its server when you press Enter. `bb shuttle search <words…>` does the same from the command line.

### Fixed

- Snooze works on every Inbox card. Feedback nobody is on and an agent waiting on you ignored it, so a snoozed card came straight back.
- A draft on a server with no `review` command now says so and links to Settings › Servers, instead of saying the server can't post reviews. Servers set up before 0.3, such as Delta through delta.sh, need `comment`, `review`, `reply` and `resolve` added to post from Shuttle.

## 0.3.0 (2026-10-24)

A redesign around what you do with pull requests, rather than where they come from.

### Added

- Auto agent, off by default: the bb thread that opened one of your PRs becomes its agent, found by the thread id in the branch name or by the branch it works on, and only in the project whose remote is exactly the PR's repository. Off, Shuttle only suggests that thread.
- Act from Shuttle. Merge your PRs (squash, merge or rebase, only at the head you saw, or with auto-merge), comment, reply in review threads, resolve them, approve or request changes. Review threads hand their findings back with the new `shuttle_review_draft` tool; you tick, edit and post them as one review with inline comments. Findings GitHub can't place on a line go into the review's body.
- Insights: merges, time to merge, the wait for a first review, your review response, where your PRs spend their time, what agents did with feedback, requests per week, AI findings kept, and ideas with the button that acts on them. Shuttle starts keeping some of these numbers with this release, and says so.
- GitHub lists carry creation and merge times, check counts, your own latest review, auto-merge, bot authors and when you were asked. Command servers can send the same, and get optional `reviewed`, `merge`, `merge_options`, `comment`, `review`, `reply` and `resolve` commands; see `references/servers.md`.
- `bb shuttle list` takes `--area inbox|mine|done|reviews`; new `bb shuttle agent` and `bb shuttle track` commands.

### Changed

- Four areas replace seven sections. Inbox, My PRs, Reviews and Insights. Old links to a section open the area that holds it now.
- Inbox replaces Needs you. One rule on the server decides each PR's next step, and the Inbox card, the row and the PR view all use its words. A card says why it is there and when it leaves, and has one main button. New review requests that ask for you by name or mention you come to the Inbox for their first three days; a setting turns this off, and another sets the days. Snooze replaces Dismiss: until 9:00 tomorrow, or until the PR changes.
- Agents replace watching. A PR has one agent thread, which gets its new reviews, comments and failed checks: Fix it, Just tell it or Off. The owner link, the watch switch and the watch mode were three controls that could disagree. A new agent gets the feedback already on the PR at once. Agents report what they did with each item through the new `shuttle_feedback_done` tool, and each forwarded item carries a `[ref …]` for it.
- Track replaces Watching for other people's PRs. Existing watches on other people's PRs become tracked PRs, and a PR linked to several owner threads keeps the most recent one as its agent.
- Reviews is one list grouped by where your review stands, with source chips (Asked me, My teams, Mentioned, Tracked). Teams are merged across servers, and bots and PRs quiet for 30 days are hidden by default. A new `reviewed` list keeps PRs you reviewed. A bot authors setting adds to the accounts a server marks as bots.
- Pages use the whole width beside bb's sidebar. Inbox cards and Insights panels go into two or three columns when there is room, and back to one when a PR is open beside them. A click anywhere on a card or row opens its PR; its own buttons only do what they say. Snooze sits in each card's top row.

### Fixed

- The Delta adapter works on each PR's own repository instead of always shop/world, posts every review with its commit, and sends failed checks to agents.
- Reloading or updating Shuttle during a sync no longer leaves it stuck with "service sync did not stop", starts no more auto reviews once stopped, and a sync cut short no longer marks its server as failing.
- Server links go into review prompts only as plain URLs, like titles and authors as one line. Reviewers GitHub or Delta reports as bots are kept apart from people in Insights, and a request withdrawn and asked again counts twice, each in its own week.

### Security

- Safety for the new writes: merges and reviews stay on the head you saw; before a draft is posted Shuttle reads the PR's head from its server, and a draft whose review read an older head says so, can't approve, and posts only once you confirm; a newer review's draft is never replaced by an older thread's. A server that answers for another PR is refused, and keys with characters a repository can't have are refused.

## 0.2.1 (2026-10-23)

### Fixed

- Menus and sheets drawn over the page now get all of Shuttle's styles. bb applies a plugin's CSS only inside the plugin's own part of the page, and these were drawn outside it, so they kept only the classes bb's own stylesheet also has. In the reviewer picker, for example, the avatars were squashed and the group headings were too large. A test now fails if a menu or sheet is drawn without Shuttle's styles.

## 0.2.0 (2026-10-23)

### Added

- Shuttle works on a phone. Opening a PR shows it on its own screen, with a bar to go back and a bar at the bottom for Review, Link and Open; Back and the swipe return to the list. The list shows the sections as chips, and the review presets, labels and reviewers open as sheets from the bottom.
- A "Manage your PR" card on your own PRs: mark a draft ready for review or turn it back into a draft, close or reopen it, add and remove labels, and request or withdraw reviewers or ask someone to review again. Each change goes to the server at once and offers Undo for a few seconds; a change the server refuses is put back, with its reason.
- PRs show their labels, and the PR panel lists requested reviewers and everyone's latest review. Other people's PRs show them read-only.
- GitHub uses `gh pr ready`, `gh pr close`, `gh pr reopen` and the REST API for labels and reviewers. Command servers get optional `ready`, `draft`, `close`, `reopen`, `edit_labels`, `edit_reviewers` and `edit_options` commands; the Delta adapter has all but `draft` and `edit_options`, since Delta can't go back to draft.

### Changed

- In windows narrower than 1280px, the PR panel slides over the list instead of appearing below it. Escape, ×, or a click outside closes it.
- While a PR is on screen, Shuttle reads it from its server every minute, so new reviewers and labels appear.

## 0.1.4 (2026-10-23)

### Added

- A server can say how reviews get their own checkout of its PRs, for repositories that refuse bb's git worktree (World only allows worktrees under `~/world/trees`): a bb environment provider such as World tree, with inputs, or a command that prints a checkout's path, such as one around `dev tree add`. Inputs and the command take the PR's number, repo, branches and head; in a command they are shell-quoted. Set it under Review workspace when editing a server.

### Fixed

- Editing a server in Settings no longer drops its read command.

## 0.1.3 (2026-10-23)

### Added

- The PR drawer is wider (up to 640px, at most 45% of the page) and shows the PR's description, rendered as Markdown; a long one is folded until you open it. Lists carry no description, so Shuttle reads it from the server the first time you open a PR. Command servers can send it as `body` from `view`; the Delta adapter does.

### Fixed

- The Review button's preset menu renders above the page, in bb's shared dropdown, instead of being clipped by the PR drawer it sits in.
- Starting a review with the worktree workspace no longer fails with "hostId is required": Shuttle creates the worktree on the machine that has the project's default checkout, or bb's primary machine.

## 0.1.2 (2026-10-23)

### Fixed

- Installs from the marketplace. Git installs leave dev dependencies out, and the UI imported `defineRpcContract` from the SDK's root entry, which only a dev dependency provides; the UI now uses its own copy of that identity function.

## 0.1.1 (2026-10-23)

### Fixed

- Adds an `.npmrc` so `npm install` in the plugin uses the public npm registry, which has the plugin SDK Shuttle pins. This did not fix the marketplace install; 0.1.2 does.

## 0.1.0 (2026-10-23)

The first release: every pull request that needs you, from any server, in one place.

### Added

- Servers: GitHub is built in, through `gh`. Any other server is a command server: a link pattern and one shell command per operation, each printing JSON. A working Delta adapter, with team requests, ships in `skills/shuttle/references/delta.sh`. A list a server cuts short never drops PRs it did not reach.
- Lists: Needs you, Requested of me, My teams, Mentioned and Watching, plus your PRs in flight and done. Look up any PR by pasting its link.
- Threads: link a PR to any thread, or start a new one for it. A thread can own several PRs, and a PR can have several threads. The thread's Info tab and the line above its composer list every PR it owns, and its Shuttle tab offers to link the PR on the thread's branch.
- Reviews: start one from a preset (skill, agent, model, thinking level, workspace and prompt), or change one run. Auto review starts a review thread when you are requested by name, with a daily limit and a repository filter; requests already waiting at the first sync never start one. Review threads can go to a sidebar section of your choice.
- Watched PRs: new reviews, review comments and failed checks go to every owner thread, batched into one message per thread, with server text kept in data blocks. Each owner gets each item once, and a failed send is retried for that owner only.
- Settings: on Shuttle's page in bb's Settings: sync interval, the Done window, the project and section for review threads, servers with a Test button, review presets, automations, and import or export as TOML.
- Agents and the CLI: the `shuttle_link`, `shuttle_unlink` and `shuttle_prs` tools, and `bb shuttle`.
