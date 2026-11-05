Let an agent tell you what it found while it is still working, instead of only in the message that ends its turn.

## What you get

- Agents get a `flare` tool. They send a flare when they confirm something, make a decision you might redirect, hit a blocker or finish a phase of a long task. The tool's instructions tell them when, so asking "send a flare when you find the cause" in a prompt is enough.
- A flare is fire and forget. The tool writes one row and returns at once with "Flare sent. Keep working"; nothing replies, and the agent's turn never waits on it. When a flare cannot be sent, the agent gets a short note to send it again later, never an error.
- The newest flare of the current turn shows in a banner above the message box: its kind, its title, how long ago, and how many more arrived. Click the title for the detail, open the Flares tab, or dismiss it until the next flare.
- The **Flares** tab in the thread's side panel lists every flare, grouped by the turn it arrived in, with the message that started each turn and whether the turn finished or failed. Bodies render as Markdown, and **Copy all** copies the lot as Markdown.
- A thread's banner and tab also show the flares of every thread it started, such as minions and delegates, each with a link to its child thread.
- Blockers, and flares the agent marks urgent, send a push notification through bb's push notifications plugin. A thread you muted there is never notified.
- When a child thread sends a blocker, its parent's agent also gets it as a note while the parent's turn is running, so an orchestrator can change course. Flare never starts a turn to deliver it.
- When a turn fails, its row in the Flares tab says so, with the error, so the last flare tells you where the agent got to.
- `bb flare send` and `bb flare list` do the same from a terminal, for scripts and for agents without the tool. `flare_list` lets an agent read its own flares back, for example after its context was compacted.
- The palette command **Flare: show this thread's flares** opens the tab.

## Settings

- **Push notifications**: blockers and urgent flares (the default), every flare, or none.
- **Notify with the last flare when a turn fails**: off by default.
- **Tell the parent agent**: blockers and urgent flares (the default), every flare, or none. The parent's banner and tab show every child flare either way.
- **Remind a quiet agent after (minutes)**: off (0) by default. When a turn runs this long without a flare, Flare adds a short reminder to it, at most three per turn, and only to a turn that is already running. **Remind child threads too** extends this to minions and delegates.
- **Keep flares for (days)**: 30 by default.

## Limits

- An agent sees the tool from its next session. A thread that was already running when you installed Flare gets it once its agent restarts.
- The timeline row for each call reads "Sent a flare"; expand it to see the flare itself. The banner and the tab are where flares are meant to be read.
- Flares, turns and dismissals stay in the plugin's own database on your bb server. No account or external service is needed; push notifications need bb's push notifications plugin.
- Needs bb 0.48.1 or later.
