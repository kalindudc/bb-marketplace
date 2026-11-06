# Changelog

Notable changes to Flare, newest first. Releases are tagged `flare/vX.Y.Z` in this repository.

## 0.2.1 (2026-11-05)

Fixes from the code review of the Shopify marketplace listing.

### Fixed

- Deleting a child thread now also rebuilds the companion of any thread above it that drew the child's flares, so the parent's rendered Flares tab no longer shows flares that are gone.
- When a thread has no companion yet and the Flares tab falls back to cards, the child threads' toggle filters the list again; before, child flares stayed in the list and in Copy all while the toggle was off.
- The plugin's runtime dependencies, `zod` and `@radix-ui/react-slot`, are pinned to exact versions, as the SDK already was, so an install from the marketplace gets the versions Flare was tested with.

## 0.2.0 (2026-11-05)

Flares render the way bb renders a reply, with no plugin code in Flare.

### Added

- The Flares tab shows each flare as bb shows a reply, so any block an installed plugin draws, such as a genui view, an inline-vis page or a mermaid diagram, appears there. Flare keeps a hidden companion thread for each thread with flares, on Flare's own renderer, a provider that runs no model: each flare comes back word for word as an assistant message, at no cost in tokens or money. The companion reuses the thread's environment, tells nobody when its turns end, is muted in push notifications when that plugin is on, is archived with its thread and is deleted with it.
- A new companion replays the thread's newest 100 flares in order, so flares sent before it, or while the tab showed cards, are drawn too. Older ones, and any not drawn yet, show as cards above the rendered flares.
- Thread-storage files a flare names, as `$BB_THREAD_STORAGE/<path>` or by absolute path, are copied into a folder for that flare in the companion, so views that load them still find them.
- In the rendered view, a divider over each flare shows its kind, the time it arrived, how long ago and the child thread it came from, and each turn opens with the same header the cards use.
- Rendered and Cards buttons in the tab switch views, and the Flares tab shows setting picks the default; Plain cards starts no companion.

### Changed

- Both views of the Flares tab read oldest to newest and open on the newest flare, and its toolbar keeps the same controls in the same places in either view.
- The banner, push notifications, the note a parent agent gets and `flare_list` show the prose of a body and name each block instead of its source. The parent agent's note is cut at 4,000 characters, which saves its tokens.
- A flare's body can be 60,000 characters, up from 4,000, so a page or a view fits.
- The tool's instructions say the body is read like a reply, even where another instruction keeps tool input plain text.

### Fixed

- A thread muted in push notifications, or muted above, is read from the plugin's own levels, so its flares no longer push.

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
