# Flare

A bb plugin that lets an agent tell you what it found while it is still
working. The agent sends up a flare, keeps going, and you see it at once
above the message box, instead of waiting for the message that ends its turn.

- The `flare` agent tool sends a finding, progress, a decision, a blocker or
  a summary. It writes one row and returns; the turn never waits on it.
- A banner above the thread's message box shows the newest flare of the
  current turn, with how many more arrived. Click it for the detail.
- The **Flares** tab lists every flare by turn, including the flares of
  threads this one started, and copies them as Markdown.
- Blockers push a notification. A child's blocker also reaches its parent's
  agent while the parent is working.
- An optional reminder nudges a turn that has been quiet for too long.
- `bb flare send` and `bb flare list` do the same from a terminal;
  `skills/flare` teaches agents the commands.

## Install

```sh
bb marketplace add git:github.com/kalindudc/bb-marketplace@main
bb plugin install flare@kalindudc
```

## How it works

| Part | How |
| --- | --- |
| Fire and forget | `flare`'s `execute` is synchronous. It normalizes the input (`src/normalize.ts`), writes one row to the plugin's SQLite database and returns. Its parameters are a raw JSON schema, which bb does not validate, so a stringified boolean or a number for a title reaches the normalizer instead of failing the call. A missing title, an unknown kind or an over-long body come back as a note in the result; a database error comes back as "send it again later". Everything else runs after the result is sent, from `setImmediate` (`FlareService.fanOut`). |
| Turns | `thread.active`, `thread.idle` and `thread.failed` open and close a run per thread (`runs` table), and the newest `client/turn/requested` event labels it. The `turns` background service matches open runs to `bb.sdk.threads.listRunning()` at start, so a reload does not leave a run open. |
| Banner and tab | The `banner` and `feed` RPC reads are tagged `flare:thread:<id>`. A flare, a turn change or a dismissal invalidates the tag, so every open client refreshes without polling. The banner is a bare composer banner (`app.composer.customize`); the tab is an action tab (`experimental_tab`). |
| Child threads | After a flare, `experimental_listAncestors` finds the threads above it and records them in `audience`, so a parent reads its children's flares with one query. |
| Push | `notifications.send` on the push notifications plugin, after checking `threadNotifications.list` for a muted thread. Past 20 flares in one turn, flares are still kept but stop notifying. |
| Notes to an agent | A child's blocker and the quiet-turn reminder are agent-only `threads.send` steers, sent only when the thread is active and not waiting on the user. A steer that finds no running turn, for example after it waited in the queue behind a question, would start one, so a `message.dispatch` hook refuses a turn start made only of Flare's notes, judging a queued group row by row. A note queued behind the user's own message rides along with the turn that message starts, and a person's message is never refused. |
| Restarts | Thread events that arrive while `reconcile` reads the running threads win over what it read, so a turn that starts or stops during a reload keeps its run. |

## Develop

```sh
cd plugins/flare
npm install && npm test && npm run typecheck && bb plugin build
bb plugin install "path:$PWD" --yes   # then `bb plugin reload flare` after each build
```
