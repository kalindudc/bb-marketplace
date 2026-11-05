# Jumpstart

A bb plugin that resumes the threads a network blip stopped, from one button,
instead of opening each failed thread and typing "continue".

- **Resume failed threads** in the sidebar footer opens a list of every
  failed thread that is not archived or hidden, newest failure first, with
  the error that stopped it and how long ago. The palette command
  **Jumpstart: resume failed threads** opens the same list.
- Threads that stopped on a dropped connection, a timeout or an unavailable
  or overloaded provider start ticked. Other failures, and threads that
  already have a message waiting, start unticked. Tick any row, or use
  **All** and **None**.
- **Resume** retries the failed turn on every ticked thread, and each row
  then says whether it is resuming, queued and why, or could not resume.
- `bb jumpstart list` and `bb jumpstart kick <ids> | --network | --all` do
  the same from a terminal; `skills/jumpstart` teaches agents the commands.

## Install

```sh
bb marketplace add git:github.com/kalindudc/bb-marketplace@main
bb plugin install jumpstart@kalindudc
```

## How it works

| Part | How |
| --- | --- |
| Which threads failed | The panel reads bb's live thread list (`experimental_useSidebarThreads`) and keeps threads whose status is `error`, leaving out archived and hidden ones, so it updates as threads fail and resume without polling. The CLI pages `bb.sdk.threads.list({ archived: false })` the same way. |
| Why each one failed | The `failures` RPC, a keyed read, takes the thread's newest `provider/error` or `system/error` event since its last turn request (`bb.sdk.threads.events.list`), skipping attempts the provider marked `willRetry`. A `thread.failed` event marks that thread's row stale, so a thread that fails again shows its new error. |
| Network or not | `src/failure.ts`. The provider's own `errorInfo.category` decides when it reports one (Codex and Claude Code do); pi reports only text, so the text decides for it: connection errors, timeouts, `ECONNRESET`-style codes, "did not answer … in time", "not connected", 5xx and overloaded. |
| Resuming | The `kick` RPC calls `bb.sdk.threads.retry({ threadId })` for each ticked thread, four at a time. Core continues a turn the agent accepted with an agent-only "Please continue." and sends one it never accepted again, with the failed turn's model, reasoning level and permission mode. |
| A dead or hung agent | When the error says the agent exited, did not answer in time or has no session, `kick` calls `bb.sdk.threads.stop` first. Without it, core's retry reports the turn as sent and the turn fails at once with "No active Pi session"; after the stop, bb starts a fresh agent that picks the conversation up. |

## Limits

- Jumpstart never retries by itself. bb's bundled Provider retry plugin
  already schedules retries for Codex and Claude Code failures that carry a
  structured error category; pi failures carry only text, which it skips.
- A retry of a failure that was not about the network, such as a model that
  does not exist, usually fails again; those start unticked for that reason.
- `--network` and `--all` skip threads that already have a message or
  retry waiting to run; name such a thread to retry it anyway.

## Develop

```sh
cd plugins/jumpstart
npm install && npm test && npm run typecheck && bb plugin build
bb plugin install "path:$PWD" --yes   # then `bb plugin reload jumpstart` after each build
```
