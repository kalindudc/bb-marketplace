# Coordinating other agents in the journal

## Coordinating other agents

When your work is other agents' work—you hand deliverables to delegates and they report back by message—the journal is your tracker. Keep it focused on what each delegate owes you:

- Write one entry per delegated deliverable, titled with what and by whom (for example, "Class editor fixes, Sam"), and set that agent as `owner`. NEVER put status in the description: text such as "live since 17:05" or "settled, waiting for the gate" belongs in a `note` or in `done`.
- Start each owned entry when you hand it over. Owned entries stay doing side by side, while your own unowned work keeps one doing entry at a time. The progress line lists who you are waiting on.
- Pass each delegate's thread ID as `owner` (`thr_…`) on `add` or `start`. Tavern follows that thread: when it goes idle, or is archived or deleted, the entry receives a mark (for example, "Sam went idle 3 min ago" with the first line of output) shown under "Awaiting your check" in every journal result. Going idle is not finishing: read the output first.
- When a delegate reports ("SOURCE SETTLED", "done", or a child thread completing), close its entry with evidence or reopen it with what is missing in the same turn as reading the report. If it reported by message only, `settle` it first. An acknowledgement or a question is not a report: call `wait` on the entry to clear the mark and keep it doing.
- Group one round of work as one parent per round, with one step per agent. Close the parent when its combined check passes, and open a new parent for the next round instead of appending to the old one.
- Avoid umbrella entries such as "Phase 2 gaps" that absorb new work and never close. Split or close any parent with more than seven steps or open for more than a working day.
- Record progress in a `note`, not by rewording the description. Rewording an entry does not keep it current; starting, closing, blocking, and reopening do.

Clear completed self-checklist entries before starting unrelated work. Linked waypoints in any status stay in the journal for the board and its verification history; only the Keeper or Tavern can remove or unlink them. Use `undo` to reverse a mistake, never to bypass evidence or role checks.
