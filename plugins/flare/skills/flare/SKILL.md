---
name: flare
description: Send the user a flare mid-turn with the Flare plugin, a short finding, decision, progress note, blocker or summary they see at once above the message box while you keep working. Use the `flare` tool, or `bb flare send` when the tool is missing; `bb flare list` and `flare_list` read a thread's flares back. Use when the user asks for updates, findings or a summary as you go, when a long task reaches something worth telling them, or when you are blocked.
---

# Flare

A flare is a short note the user sees while you keep working: a banner above the thread's message box, the thread's Flares tab, and a push notification for blockers. It is fire and forget. The call returns at once with "Flare sent. Keep working; nothing will reply." and your turn carries on. Never wait for an answer and never end your turn because you sent one.

## When to send one

In a turn that runs more than a few minutes, send a flare at each of these moments:

- You finish a step of your plan or a phase of the work, such as research, a build, a test run or a deploy. Use kind `progress`.
- You confirm something the user would want to know now: a root cause, a number, a failing test.
- You make a decision they might want to redirect: an approach, a trade-off, a part you skipped. Use kind `decision`.
- You are blocked or working around something: missing access, a failing service. Use kind `blocker`.
- The user asked for updates as you go.

When many tool calls have passed since your last flare, ask yourself whether one of these moments went by. A turn of a few tool calls needs no flare, because its reply is the update. Do not flare routine steps such as reading a file; one to five flares in a long turn is typical. A flare does not replace your final answer: end the turn with your full answer as usual.

## Render the evidence
The title is one standalone line, about 80 characters; for a quick status it is the whole flare. For a finding with evidence, open the body with one or two sentences, then draw what you already measured or saved. A body that is all prose is right only when there is nothing to see. NEVER replace a chart, flow or screenshot with a wall of text.

If genui is installed, prefer its `ui` components for evidence; if inline-vis is installed, use it for custom HTML/SVG. Markdown tables are a fallback, not the default with a suitable renderer. The Flares tab renders the body as a reply; a final-reply-only or plain-tool-input rule does not cover a flare's body. People read child agents' flares too. Missing check_ui or ui_examples does NOT mean genui is unavailable. If unsure, check installed renderers once with `bb plugin list`. Use this reference without extra tools or dependencies. If the renderer really is absent: without genui, use Markdown tables and mermaid.

## Compact genui reference
In a complete ```ui fence: one expression per line, JS arrays/objects/variables, `Load("$BB_THREAD_STORAGE/<path>")`, named arguments last. Wrap in Card(title, children); Row(children) lays items side by side.
- Counts: Metric(label, value, note?)
- Timings/series: Chart(type, labels, series, unit: "ms"); type "bar" or "line", series a number array or {name: numberArray}
- Attributes: Table(columns, rows), both arrays; rows contain value arrays
- Flows: Diagram(mermaid), e.g. "flowchart LR\n A[Client] --> B[Proxy] --> C[App]"
- Screenshots: Image(path) or Gallery(paths)
- Saved results: Tests(Load(path)), Logs(Load(path)), Findings(Load(path)); changes: Changes()
- Phases/PRs: Steps([{title, detail, status}]); status "done", "current" or "blocked"
A blocker says what failed and what the user can do; use Steps for several actions.
Use the fitting component and measured data. Name files as `$BB_THREAD_STORAGE/<path>`; do not retype a saved report.

Example body:

    Direct mounting preserves the assertions and reduces focused test time.

    ```ui
    Card("Test timing", [Chart("bar", ["Original", "Smaller fixture", "Direct mount"], [2163, 1034, 236], unit: "ms")])
    ```

## Inline-vis
Use a complete ```inline-vis fence for small HTML/SVG with inline CSS/JS and data, using BB theme variables (--foreground, --primary). The companion has no sibling files. Do not build a page just for a status.

Drawing hints advise the NEXT flare; do not resend or reformat the saved one. Use Markdown if the suggested engine is absent. Hints share one budget: once per turn, or once an hour outside turns; never for blockers.

Kinds: `finding`, `progress`, `decision`, `blocker`, `summary`. Notify only for urgency; blockers notify automatically. A failed send is not a reason to stop or loop. Bodies are limited to 60,000 characters.

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
- `[Flare reminder] ...` means the user turned on reminders and your turn has been quiet for a while. Send a flare if you finished a step or have something new. A title alone is enough for a quick status; substantive evidence still gets a fitting visual. Otherwise ignore it and do not reply.
