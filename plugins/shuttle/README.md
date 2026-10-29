# Shuttle

Every pull request that needs you, from any server, in one place. See
[PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md) for what it does, and
[skills/shuttle/references/servers.md](skills/shuttle/references/servers.md) for the command
adapter contract and a working Delta adapter.

## PR view state

Shuttle restores each PR's scroll position and expanded Description and Details when its view
is recreated, in the page and the thread tab. Unfinished comments and replies, open reply boxes,
and edits to an AI review draft stay in this browser tab's session. Sending a comment or reply
clears its text. A new AI review draft starts with its own findings and summary.

## AI reviews

Choose **Start AI review** or **Re-review with AI**, pick a preset, and optionally add a
**Note for the reviewer** with context or areas to focus on. The note applies only to that
review and stays with you if you open **Change for this run…** for more options.

## Boards

Save a specific set of PRs as a board, across repositories and servers. Create an empty board,
save a selection from a PR list, or add PR links to an existing board. PR status stays live;
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
src/next.ts            the next-step rule every PR's Inbox card, row and banner show
src/views.ts           PR rows as the UI sees them, and which area each belongs in
src/agents.ts          a PR's agent thread, its mode, and auto agent
src/watch.ts           new activity on PRs with an agent: batches, messages, item refs
src/drafts.ts          AI review drafts and posting reviews
src/conversation.ts    a PR's conversation, comments, replies, resolving and merging
src/insights.ts        the numbers and ideas on the Insights page
src/reviews.ts         review and agent threads from presets
src/shuttle.ts         the operations the RPC handlers, tools and CLI share
src/ui/                React components; prefs.ts is what the page remembers on this device (localStorage)
```

## Develop

```sh
npm install && npm test && npm run typecheck && bb plugin build
```
