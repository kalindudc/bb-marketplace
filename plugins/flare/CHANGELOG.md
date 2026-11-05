# Changelog

Notable changes to Flare, newest first. Releases are tagged `flare/vX.Y.Z` in this repository.

## 0.1.0 (2026-11-05)

The first release: agents send up a flare mid-turn and keep working.

### Added

- A `flare` agent tool that sends a finding, progress, a decision, a blocker or a summary while the agent works. It writes one row and returns at once, so the turn never waits on it; a missing title, an unknown kind or a database error comes back as a note to send it again later, never as a failed call.
- A banner above the thread's message box with the newest flare of the current turn, how long ago it arrived and how many more there are. Its title opens the detail, and it can be dismissed until the next flare.
- A Flares tab in the thread's side panel that lists every flare by the turn it arrived in, with the message that started each turn and whether it finished or failed, and copies them as Markdown.
- A thread's banner and tab include the flares of the threads it started, each linked to its child thread.
- Push notifications for blockers and urgent flares through bb's push notifications plugin, never for a thread muted there, and optionally a notification with the last flare when a turn fails.
- A child thread's blockers reach its parent's agent as a note while the parent's turn is running; a note never starts a turn.
- An optional reminder for a turn that has gone quiet for a set number of minutes, at most three per turn.
- `flare_list` for agents, the `bb flare send` and `bb flare list` commands, and the palette command Flare: show this thread's flares.
