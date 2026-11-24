Let an agent tell you what it found while it is still working, instead of only in the message that ends its turn.

## What you get

- Agents get a `flare` tool. They send a flare when they confirm something, make a decision you might redirect, hit a blocker or finish a phase of a long task. The tool's instructions tell them when, and to draw the evidence as a table, chart or diagram instead of describing it, so asking "send a flare when you find the cause" in a prompt is enough.
- A flare is fire and forget. The tool writes one row and returns at once with "Flare sent. Keep working"; nothing replies, and the agent's turn never waits on it. When a flare cannot be sent, the agent gets a short note to send it again later, never an error.
- The newest flare of the current turn shows in a banner above the message box: its kind, title, age and how many more arrived. Click the title for the detail, open the Flares tab, or dismiss it until the next flare. In settings, **Show the newest flare as** can move it into the thread's context row instead, as a widget that counts the flares since you last looked.
- The **Flares** tab in the thread's side panel shows every flare the way bb shows a reply, so a chart, a page or a diagram any installed plugin draws appears there, with no setup. **Cards** switches to Flare's own list, grouped by turn, and **Copy all** copies the lot as Markdown.
- The widget and tab also show the flares of threads this one started, such as minions, each linked to its thread.
- Blockers, and flares the agent marks urgent, send a push notification through bb's push notifications plugin. A thread you muted there is never notified.
- When a child thread sends a blocker, its parent's agent also gets it as a note while the parent's turn is running, so an orchestrator can change course. Flare never starts a turn to deliver it.
- When a turn fails, the widget and the Flares tab say so, with the error.
- `bb flare send`, `bb flare list` and `flare_list` send and read flares from a terminal or an agent. The palette command **Flare: show this thread's flares** opens the tab.

## How rich flares work

bb draws plugin blocks only in assistant messages, so Flare keeps a hidden companion thread for each thread with flares, on Flare's own renderer: a provider that runs no model. Each flare comes back there word for word as an assistant message, and the Flares tab shows that thread. A companion costs no tokens or money, reuses its thread's environment, tells nobody when its turns end, and goes when its thread goes. Flare therefore appears in bb's provider list; it is not an agent.

## Settings

- **Push notifications**: blockers and urgent flares (the default), every flare, or none.
- **Notify with the last flare when a turn fails**: off by default.
- **Tell the parent agent**: blockers and urgent flares (the default), every flare, or none. The parent's widget and tab show every child flare either way.
- **Remind a quiet agent after (minutes)**: off (0) by default. A turn this quiet gets a short reminder, at most three per turn, and only while it runs. **Remind child threads too** extends this to minions and delegates.
- **Flares tab shows**: rendered like a reply (the default), or plain cards, which starts no companion.
- **Keep flares for (days)**: 30 by default.

## Limits

- An agent sees the tool from its next session. A thread that was already running when you installed Flare gets it once its agent restarts.
- The timeline row for each call reads "Sent a flare". The widget shows the prose of a body; its views are in the tab.
- A view that loads a file from thread storage finds it when the flare names it as `$BB_THREAD_STORAGE/<path>`; workspace files work as they do in a reply.
- Flares stay in the plugin's own database on your bb server; no account or external service is needed.
- Needs bb 0.48.1 or later.
