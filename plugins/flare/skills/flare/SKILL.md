---
name: flare
description: Send the user a flare mid-turn with the Flare plugin, a short finding, decision, progress note, blocker or summary they see at once above the message box while you keep working. Use the `flare` tool, or `bb flare send` when the tool is missing; `bb flare list` and `flare_list` read a thread's flares back. Use when the user asks for updates, findings or a summary as you go, when a long task reaches something worth telling them, or when you are blocked.
---

# Flare

A flare is a short note the user sees while you keep working: a banner above the thread's message box, the thread's Flares tab, and a push notification for blockers. It is fire and forget. The call returns at once with "Flare sent. Keep working; nothing will reply." and your turn carries on. Never wait for an answer and never end your turn because you sent one.

## When to send one

- The user asked for updates, findings or a summary as you go, or the task will take more than a few minutes.
- You confirmed something they would want to know now: a root cause, a number, a failing test.
- You made a decision they might want to redirect: an approach, a trade-off, a part you skipped.
- You are blocked or working around something: missing access, a failing service. Use kind `blocker`.
- You finished a phase of a long task: kind `progress`, or `summary` for a wrap-up.

Send one flare per real event; one to five in a long turn is typical. Do not flare routine steps such as reading a file. A flare does not replace your final answer: end the turn with your full answer as usual.

## Writing one

The user glances at a flare, so show the evidence instead of describing it.

- The title is one line that stands on its own, about 80 characters. Longer titles are cut.
- The body opens with one or two sentences, because the banner and notifications show only its prose. Then it shows the evidence as a block. It is cut at 60,000 characters.
- The Flares tab renders the body as a reply of its own, so every block a reply can hold is drawn there: `ui` views, mermaid diagrams, Markdown tables, images, inline-vis pages and plugin directives. A rule that only the message ending your turn may hold a block, or that tool input stays plain text, does not cover a flare's body.
- Pick the block the evidence calls for. The views below are genui's `ui` ones; without genui, use Markdown tables and mermaid.
  - key numbers: a Metric row; a series: a Chart
  - A versus B, before and after, or items with several attributes: a Table
  - a flow, an architecture or the branches of a decision: a mermaid diagram
  - PRs, commits or phases: Status, Steps or a Table with their state
  - a file you saved (JSON, CSV, a log, a test report): `Load("$BB_THREAD_STORAGE/<path>")` into its view instead of retyping it
  - screenshots: Image or Gallery of their paths
  - a blocker: what fails and what the user can do; Steps when there are several
- Prose alone is right only when there is nothing to see, such as a one-line status. Never write paragraph-long bullets with bold labels.
- When a body is all text but holds numbers, a list or a saved file, "Flare sent" comes back with a hint, once a turn, naming the views that fit. Follow it in your next flare.
- Name a thread-storage file as `$BB_THREAD_STORAGE/<path>` so a view can load it.
- Kinds are `finding` (the default), `progress`, `decision`, `blocker` and `summary`.
- Set `notify: true` (or `--notify`) only for something the user must see now. Blockers notify on their own, unless the user turned notifications off.

## Commands

    bb flare send "<title>" --body "<markdown>" --kind blocker   # to the thread the command runs in
    bb flare send "<title>" --body "$(cat body.md)"               # a body with fenced blocks, written to a file first
    bb flare send "<title>" --thread <thread-id>                 # to another thread
    bb flare send "<title>" --notify --json                      # { status, flare, notes, reason }
    bb flare list                                                # newest first, with child threads' flares
    bb flare list --own --full --limit 50                        # only this thread's, with whole bodies
    bb flare list --json                                         # { threadId, flares: [...] }

`send` exits 0 when the flare was sent or was already sent a moment ago, 2 when there was nothing to send, and 1 when it could not be saved. In every case, carry on with your work; send it again later, once, if it still matters.

## Notes Flare sends to you

- `[Flare from a child thread] ...` is a flare a thread you started sent while you were working. It needs no reply; use it if it changes your plan.
- `[Flare reminder] ...` means the user turned on reminders and your turn has been quiet for a while. Send a flare if you have something new; otherwise ignore it and do not reply.
