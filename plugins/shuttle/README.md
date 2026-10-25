# Shuttle

Every pull request that needs you, from any server, in one place. See
[PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md) for what it does, and
[skills/shuttle/references/servers.md](skills/shuttle/references/servers.md) for the command
adapter contract and a working Delta adapter.

## Layout

```
server.ts              wiring: database, settings, RPC, tools, CLI, events, the sync service
app.tsx                the Shuttle page, thread panel tab, header chip and settings sections
src/config.ts          servers, presets and automations (stored in the plugin database)
src/adapters/          the built-in GitHub adapter (gh) and the command adapter
src/sync.ts            one server sync and the auto reviews it calls for
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
