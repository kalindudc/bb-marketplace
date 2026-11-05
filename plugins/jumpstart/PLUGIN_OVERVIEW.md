Resume the threads a network blip stopped, in one click, instead of opening each one and typing "continue".

## What you get

- A **Resume failed threads** button in the sidebar footer. It opens a list of every thread that stopped on an error, newest first, with the error that stopped it and how long ago.
- Threads that stopped on a network error start ticked: a dropped connection, a timeout, or a provider that was unavailable or overloaded. Threads that stopped for another reason, such as a model that does not exist, start unticked, and so do threads that already have a message waiting. Tick or untick any row, or use **All** and **None**.
- **Resume** retries the failed turn on every ticked thread, the same way bb's own retry does: a turn the agent had started continues with "Please continue.", and a turn it never received is sent again, with the thread's model and reasoning level.
- When the error says the agent's process died or stopped answering, Jumpstart stops the thread first, so bb starts a fresh agent on the same conversation. Without that, the retry would fail at once with "No active Pi session".
- Each row then shows what happened: resuming, queued behind something such as a machine that is offline, or why it could not resume. Threads that resume leave the list.
- The command palette command **Jumpstart: resume failed threads** opens the same list.
- `bb jumpstart list` and `bb jumpstart kick --network` do the same from a terminal, and agents learn them from the plugin's skill.

## Limits

- Jumpstart never retries on its own: you press the button. bb's Provider retry plugin already retries some Codex and Claude Code failures by itself.
- Whether an error counts as a network error comes from the provider's own error category when it reports one (Codex and Claude Code do), and otherwise from the error text bb logged (pi reports only text). An error Jumpstart does not recognise starts unticked; tick it to resume it anyway.
- Only threads in bb's failed state are listed. Archived threads and hidden worker threads are left out.
- Needs bb 0.48.1 or later.
