# Shuttle

Every pull request that needs you, from any server, in one place. See
[PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md) for what it does, and
[skills/shuttle/references/servers.md](skills/shuttle/references/servers.md) for the command
adapter contract and a working Delta adapter.

## Inbox

The Inbox lists what waits on you, one row per PR under what to do with it: Needs you, Ready to
merge, AI reviews to post, Updated since your review and New review requests. A row's second line
says only what its heading, avatar and time do not. Search, group by what to do or by repository,
and sort; the choice is kept on this device. Pointing at a row, or moving to it with J and K,
shows its next step, Snooze, Dismiss and ⋯; each says what it does, and its key, in a tooltip. A
row's ⋯ menu holds Snooze and Dismiss too (the only menu on a phone, besides swiping), then its rules.

- **Snooze** hides a PR until later today, tomorrow, next week or until it changes; anything new
  brings it back sooner. The Snoozed tab lists them with when each comes back.
- **Dismiss** keeps a PR out of the Inbox for good, even when it changes. The Dismissed tab lists
  them, marks those with new activity and restores one.
- **Rules** from a row's ⋯ menu keep out every PR by an author, every PR from a repo, or mentions
  in a repo when you are not asked to review. They are per server and listed under Dismissed.
- **New since you opened it:** Shuttle stores when you last opened each PR, so the dot and bold
  title follow you across devices. Opening the PR clears them; Mark all as seen clears every one.

Several rows can be snoozed or dismissed at once. Snoozes, dismissals and rules have Undo, and a
phone swipes a row left to dismiss it or right to snooze it.

## PR view

A PR's view reads top to bottom the way a person asks about it:

- **What it is:** the title, its state, who wants to merge how many commits from which branch, its
  labels and the boards it is on.
- **Where it stands:** one card with the next step and its buttons, in the same words as the
  Inbox, then a row for each part: your review, reviews, checks, whether it can merge, the agent
  (which opens its controls in place) and, on someone else's PR, its size. A row opens the tab
  with the rest.
- **Tabs:** Overview (description, people, facts and linked threads), Your review (the AI draft
  to post, on someone else's PR), Conversation (open threads first with the code they are on, then
  every review and comment, newest first with a button to flip the order), Checks (every check,
  failing first), Changes (commits and each file's path and line counts, never the diff itself)
  and History (what happened on the server and in Shuttle).

Beside a list, the view's expand button opens it as a full page, which puts people and facts in a
column of their own on a wide window; a PR's own link opens there too. The ⋯ menu holds copying,
tracking, snoozing, dismissing from the Inbox, linking a thread, starting an AI review and your
PR's draft, close and reopen.

Shuttle restores each PR's tab, scroll position and folds when its view is recreated, in the page
and the thread tab. Unfinished comments and replies, open reply boxes, and edits to an AI review
draft stay in this browser tab's session. Sending a comment or reply clears its text. A new AI
review draft starts with its own findings and summary. What came since you last opened a PR on
this device is marked New.

## Link cards

Git links in thread messages that Shuttle can read get an icon for what they name, coloured by their PR's
or issue's state, and a card on hover, focus or a tap on a phone: a PR, one of its pages, a comment or review
on it, a commit, a check or workflow run, or an issue. The page script (`src/ui/links/dom.ts`) marks the links
and the app overlay (`src/ui/links/overlay.tsx`) draws the card from `linkCard`, which answers from Shuttle's
copy and the PR view's 30-second read; a PR it has not seen is never fetched on a hover. Shuttle keeps no copy
of issues, so an issue card reads it from the server, as a commit or check Shuttle cannot place does, at most
once a minute; only GitHub's adapter can read issues. An issue link whose number is a PR's shows the PR.
Nothing on a card writes.
On a focused link, Down moves into its card. The script finds messages by bb's timeline markers, which
are not a published contract.

## Theme

Shuttle draws only with bb's theme tokens (`--foreground`, `--surface-recessed`, `--state-hover`,
`--surface-selected`, `--pr-merged`, the diff and terminal colours) and bb's own button, chip and count
patterns, so it follows any theme. `--primary` is for links, focus and the selected row's edge, never a
fill. Buttons, icon buttons and fields come in one shared style per kind, size and state (`BUTTON_ON`,
`BUTTON_DANGER`, `ICON_GHOST_LARGE`, `FIELD_SMALL` and so on) in `src/ui/common.tsx`: Tailwind orders
utilities in its stylesheet, so a class added after a shared style never reliably overrides it.
`test/ui/class-overrides.test.ts` fails when a class string adds, after a shared style, a class that sets
what the style already sets, and when it adds classes through a variable it cannot read.

## AI reviews

Choose **Start AI review** or **Re-review with AI**, pick a preset, and optionally add a
**Note for the reviewer** with context or areas to focus on. The note applies only to that
review and stays with you if you open **Change for this run…** for more options.

## Boards

Save a specific set of PRs as a board, across repositories and servers. Create an empty board,
save a selection from a PR list, add PR links to an existing board, or tick boards in a PR's own
view to put it on them or take it off. PR status stays live;
merged and closed PRs stay in the saved set until removed. A PR can belong to multiple boards.

Use **Sort by** to keep the saved order or sort by update time, creation time, merge or close time,
repository, or size. Use **Group by** to split the list by status, repository, server, or author.
Sorting applies within each group. Fold individual groups or collapse and expand them all.
Shuttle remembers sorting, grouping, and folded sections separately for each board on this device;
these view choices do not change saved membership or anyone else's view.

Archive a board to hide it from active navigation without losing its PRs. Restore it before
changing membership. Boards uses the same sidebar navigation as the other areas: its board links
appear only while Boards is open. Board membership never assigns an agent or changes feedback
delivery. The board's compact, timestamped activity log can be folded to its heading; Shuttle
remembers that choice separately for each board on this device.

Threads can find, inspect, create, update, and curate boards with the `shuttle_board*` tools.
See the bundled [Shuttle skill](skills/shuttle/SKILL.md) for the inputs and CLI commands.

## Layout

```
server.ts              wiring: database, settings, RPC, tools, CLI, events, the sync service
app.tsx                the Shuttle page, thread panel tab, header chip and settings sections
src/config.ts          servers, presets and automations (stored in the plugin database)
src/boards.ts          saved PR sets, board activity, archive guards and membership operations
src/adapters/          the built-in GitHub adapter (gh) and the command adapter
src/sync.ts            one server sync, step by step with bounded retries, and the auto reviews it calls for
src/failures.ts        why a sync step failed, in plain words, for the UI, the CLI and the Automation log
src/next.ts            the next-step rule every PR's Inbox row, list row and banner show, and Inbox rules
src/inbox.ts           the Inbox's read, snoozes, dismissals, seen marks and rules
src/views.ts           PR rows as the UI sees them, and which area each belongs in
src/agents.ts          a PR's agent thread, its mode, and auto agent
src/watch.ts           new activity on PRs with an agent: batches, messages, item refs
src/drafts.ts          AI review drafts and posting reviews
src/conversation.ts    a PR's conversation and details, comments, replies, resolving and merging
src/insights.ts        the numbers and ideas on the Insights page
src/reviews.ts         review and agent threads from presets
src/shuttle.ts         the operations the RPC handlers, tools and CLI share
src/links.ts           which git thing a link names, shared by the server and the page script
src/link-cards.ts      the cards on git links in threads, read without writing
src/ui/                React components; prefs.ts is what the page remembers on this device (localStorage)
```

## Develop

```sh
npm install && npm test && npm run typecheck && bb plugin build
```
