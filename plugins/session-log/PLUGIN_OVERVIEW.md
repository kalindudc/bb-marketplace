See everything an agent did in a thread without opening nested chat rows.

## What you get

- One flat side-panel log in bb's timeline order: your messages and steers, child reports, agent replies, thinking, commands, tool calls, file diffs and subagent steps.
- What bb gives the agent but keeps out of the chat, marked Hidden where the agent received it: a plugin's steer, the context a mention resolves to, an automatic retry or a suppressed tool result.
- Rows tinted by type in your bb theme's colors, so replies, tool calls, commands, file changes and failures stand apart.
- Timestamps, status, exit codes and duration beside each step. Replies appear in full, long output previews its first and last lines, failed commands and tools open by default, and `x` expands every row.
- Filters for Messages, Thinking, Tools, Hidden and Errors, plus whole-session search. The log follows new output, including outputs that open up as they finish, until you scroll up or move to an older row; “↓ Latest” or `G` takes you back.
- Keyboard navigation (`j/k`, `n/N` for replies, `e/E` for errors), copy (`c`), a message link back to chat (`s`), and Mod+Shift+L to open the tab. The thread header has an open button too, except on phones, where the right panel's tab list opens the log. bb's Maximize pane button gives the log the whole window.
- Settings for preview sizes, whether failures open by themselves, which rows show when the log opens (hidden messages included), a 12- or 24-hour clock, and whether rows are tinted by type. Changes reach open panels straight away.

## How it works

The plugin loads bb's public timeline API, including nested rows, when you open the tab. It applies live deltas afterward, with at most two refresh requests a second. Because the timeline leaves hidden input out, it also reads the thread's request events and places each hidden message by its sequence number. It does not change bb's chat markup or store thread data; only the expanded-view choice is saved on this device. If you also want bb's chat itself to stop folding finished turns, use `bb settings completed-turns <provider> flat`.

## Limits

bb truncates output above 32,000 characters and the log keeps its truncation note. Search finds text inside Markdown messages but does not highlight it there. The whole session is fetched on opening, including large threads.
