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
src/watch.ts           watched PRs: new activity, batches, messages to owner threads
src/reviews.ts         review and owner threads from presets
src/shuttle.ts         the operations the RPC handlers, tools and CLI share
src/ui/                React components
```

## Develop

```sh
npm install && npm test && npm run typecheck && bb plugin build
```
