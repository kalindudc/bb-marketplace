# Shuttle

Every pull request that needs you, from any server, in one place. See
[PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md) for what it does, and
[skills/shuttle/references/servers.md](skills/shuttle/references/servers.md) for the command
adapter contract.

## Inbox

The Inbox lists what waits on you, one row per PR under what to do with it: Needs you, Ready to
merge, AI reviews to post, Updated since your review and New review requests. A row's second line
says only what its heading, avatar and time do not. Search, group by what to do or by repository,
and sort; the choice is kept on this device. Pointing at a row, or moving to it with J and K,
shows its next step, Snooze, Dismiss and ⋯; each says what it does, and its key, in a tooltip. A
row's ⋯ menu holds Snooze and Dismiss too (the only menu on a phone, besides swiping), then its rules.

- **Reviewing** lists your reviews on their way to their servers, then the PRs an AI review is
  running on, which are out of the Inbox until it finishes or stops: the preset, when it started,
  whether its thread waits on your answer or is idle, and a button to its thread. The Inbox's foot
  says how many of each there are, and how many merges are on their way.
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
  to post, on someone else's PR, with the review's notes for you, which are never posted), Conversation (open threads first with the code they are on, then
  every review and comment, newest first with a button to flip the order), Checks (every check,
  failing first), Changes (commits and each file's path and line counts, never the diff itself)
  and History (what happened on the server and in Shuttle). Tabs that do not fit the width go
  under More, which shows a dot when one of them has failing or running checks or open threads;
  the tab you are on always stays in view.

Beside a list, drag the view's left edge to make it wider or narrower, or focus the edge and use
the arrow keys; a double-click puts back the default width. Shuttle remembers the width on this
device, for the panel beside the list and the one that slides over it in a narrower window. The
view's expand button opens it as a full page, which puts people and facts in a column of their own
on a wide window; a PR's own link opens there too. The ⋯ menu holds copying,
tracking, snoozing, dismissing from the Inbox, linking a thread, starting an AI review and your
PR's draft, close and reopen.

Posting a review, from an AI draft, the composer or Approve…, never makes you wait on the server.
Shuttle checks it at once, queues it and posts it in the background, one review at a time on each
server and in the order you posted them, checking the PR's head again just before it posts. Your
review shows it queued, with Cancel until it starts, then posting, and a toast says when it is on the
server. A review the server refuses comes back to the Inbox under Needs you with the server's
reason: try it again, change its draft and post that, or dismiss it. A review Shuttle was posting
when it stopped fails the same way instead of posting twice, so check the PR before you try again.

Merging one of your PRs, or turning on its auto-merge, works the same way. The Merge dialog closes
at once, and Shuttle merges in the background, one PR at a time on each server and in the order you
chose them. My PRs lists them under Merging, and the PR's card has Cancel until the merge starts.
Just before it merges, Shuttle reads the PR from its server and merges only while it is open and
still at the head you saw. It decides what happened from the PR it reads back afterwards, so a PR a
repository's own merge queue took stays open, under Merging: as In the merge queue when the server
says so, or as Sent to merge for up to a day while it is still at that head, instead of merged or
ready to merge. Every 30 seconds, even while a sync runs, Shuttle reads your PRs with a merge
pending, so a merge that lands, there or anywhere else, shows within a minute or so. A PR that has
waited on auto-merge or a merge queue for more than an hour is read every five minutes instead. A merge that
does not go through comes back to the Inbox under Needs you with the server's reason. Try again runs
the same merge, or, when someone pushed since, Merge… lets you look at the new commits first.

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

A review runs until its thread hands back a draft with `shuttle_review_draft`, or says it is over
with `shuttle_review_done`. The end of a turn does not end it, so a review that waits on critics or
other child threads stays under Reviewing. A review with nothing happening for 2 hours, in its
thread or the threads under it, counts as gone quiet and comes to the Inbox. Shuttle asks bb first, so
a thread at work, or one waiting on your answer, keeps its review running. A review whose thread
failed or went quiet runs again when the thread gets back to work.

### Auto post (shadow mode)

Auto post decides, for each AI review draft in a repository you opt in, whether Shuttle could post it
for you. For now it only runs in shadow mode: it records the decision on the draft and never posts.
Turn it on per repository in **Settings › Automations › Auto post**. It is off everywhere by default.

A finding would post only when it clears every check:

- **Safety:** no @mentions, bot commands, HTML comments, invisible characters, links outside the PR's
  server, or anything that looks like a secret.
- **Accuracy:** a majority of the review's critics kept it (at least two), every excerpt the reviewer
  quoted (at least 12 characters) is in the code at the head the review read, within three lines of
  the lines it cites, and the verifier scores it as holding.
- **Quality:** at least the minimum severity (medium by default, so nits never post), on a line, and
  scored by the verifier as worth posting.
- **Alignment:** outside the repository's held paths. The repository's guidelines go to the verifier.

A draft as a whole is held when the PR has new commits since the review, is a draft, was written by
a bot, is larger than the line limit or of unknown size, changes a held path, has a summary that fails
the safety check, or when the reviewer rated it high risk or raised a concern about the PR as a whole. Comment reviews only: approvals and requests for changes are
held for now.

The verifier is a fast model that runs as a command with no tools, so it judges only what Shuttle
gives it: the finding, the lines the reviewer quoted, the file's diff and the code around the line.
It never sees the PR's description. The default runs Kimi K3 at low thinking through `pi -p`, from the
temp directory with tools, skills and context files off; extensions still load, since some provide the
model's credentials, so add `--no-extensions -e <that extension>` to leave the rest out. Any command
that reads the prompt on stdin and prints `{"holds", "worth_posting", "reason"}` works. Only findings
that pass every other check, in a draft nothing else holds, go to it, and no more than could post.

The draft's Your review tab shows what auto post would do, with a chip on each finding whose tooltip
lists every check and the verifier's scores. **Check again** runs the checks once more, and so does
`bb shuttle gate <pr>`. Posting a draft records which findings you kept, edited or dropped, and a
discard records whether you discarded it or a newer review replaced it. **Insights › Auto post**
compares the two per repository: precision, its 95% lower bound against your target, how many more
agreeing findings would prove the target, what auto post held that you posted, why drafts were held,
how the verifier scored each finding, and the latest decisions.

## Agents

A PR's agent is the thread linked to it as owner. Shuttle reads the PR's activity on every sync, three
PRs at a time, which also tells it when the PR merged or closed (an answer older than what Shuttle
has never changes that), and,
after the batch window, sends the thread what is new: reviews, review comments, conversation
comments and, if you choose, failed checks on the head. Resolved threads and your own reviews and
replies are left out, and so are bots while **Ignore bots** is on, except the logins and globs under
**Except these bots**, which starts empty: add the bots whose comments are about the PR's own change,
such as an AI reviewer or a code scanner. A bot is what the server marks as one; GitHub's logins match
with or without `[bot]`.
Each watch remembers which bots it heard from, so a bot added later, or every bot when Ignore bots is
turned off, starts from what it says next instead of sending what it said while it was ignored.

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

## Syncing

Servers sync at the same time, and each one at most once at a time. **Sync now** on one server
starts that server's sync at once, or joins it when one is already running, rather than waiting for
the other servers. The steps after the servers, such as thread titles and sending agents what is
new, run once the servers are done and never hold up the next sync of a server.

Shuttle's loop runs every 30 seconds and never waits for a sync. It starts a full sync when one is
due and none is running, rechecks a server whose sync failed, and on every tick reads the PRs with a
merge pending (the fast lane), ends reviews that went quiet and sends agents what is new. The fast
lane reads each server on its own and leaves alone a server that is syncing. After a rate limit, a
refused sign-in, or a failure that says the server is down, in a sync or in the fast lane, Shuttle
asks that server nothing more until its next sync.

On each server Shuttle reads your open PRs first and shows them as soon as they land. It then reads
the other lists two at a time, and each list shows as soon as it lands. Merged and closed PRs are
read since the last read that came in full, less five minutes, with the whole Done window read
about once an hour and at the next sync after the Done setting changes, so a sync does not read two
weeks of closed PRs every time. Linked and tracked PRs that no list brought are read three at a time,
at most 30 a sync, and so are open PRs of yours that neither your open nor your closed PRs brought.

## Layout

```
server.ts              wiring: database, settings, RPC, tools, CLI, events, the sync service
app.tsx                the Shuttle page, thread panel tab, header chip and settings sections
src/config.ts          servers, presets and automations (stored in the plugin database)
src/boards.ts          saved PR sets, board activity, archive guards and membership operations
src/adapters/          the built-in GitHub adapter (gh) and the command adapter
src/sync.ts            one server sync, list by list with bounded retries, and the auto reviews it calls for
src/failures.ts        why a sync step failed, in plain words, for the UI, the CLI and the Automation log
src/next.ts            the next-step rule every PR's Inbox row, list row and banner show, and Inbox rules
src/inbox.ts           the Inbox's read, snoozes, dismissals, seen marks and rules
src/views.ts           PR rows as the UI sees them, and which area each belongs in
src/agents.ts          a PR's agent thread, its mode, and auto agent
src/watch.ts           new activity on PRs with an agent: batches, messages, item refs
src/drafts.ts          AI review drafts and posting reviews
src/posts.ts           the review queue: checks, cancel, try again, and posts a stopped Shuttle left half done
src/merges.ts          the merge queue for your own PRs, the same way
src/fast-lane.ts       each tick, reads the state of your PRs with a merge pending
src/review-runs.ts     when a review run ends: a draft, the thread saying so, a failure, or hours of quiet
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
