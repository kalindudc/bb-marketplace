# Changelog

Notable changes to Session Log, newest first. Releases are tagged `session-log/vX.Y.Z` in this repository.

## 0.4.0 (2026-10-21)

### Added

- Every search match is painted in amber, and the match you are on is orange, underlined, and framed on its row. Matches inside rendered Markdown messages are painted now; the previous version only highlighted plain text and titles.
- A counter beside the search box says which match you are on, such as "3 of 17", with previous and next arrows. Enter and Shift+Enter step from the box and keep focus there, and Down arrow moves into the log at the current match without clearing the search.

### Changed

- With a search active, `n` and `N` step through matches instead of agent replies; with an empty box they still step through replies.
- Stepping to a match scrolls it to the middle of the log and pauses follow. A match inside an expanded file diff is not painted, because bb's diff viewer draws it in its own shadow DOM, but stepping still lands on that row and frames it.

## 0.3.0 (2026-10-21)

### Added

- The log shows input bb gives the agent but keeps out of the chat: a plugin's steer such as cortex memory, the context a mention resolves to, an automatic retry, and a tool result delivered with its presentation suppressed. Each one sits where the agent received it, with a dashed rail and a label: "Hidden steer", "Hidden message", "Hidden retry", "Hidden tool result", or "Hidden context" for the hidden part of a message the chat shows.
- A Hidden filter chip and a `showHidden` setting, on by default, turn those rows off. If the thread's request events cannot be read, the rest of the log still loads and a notice says why.

## 0.2.1 (2026-10-20)

### Changed

- The thread header leaves out the Session Log button on a phone, where bb's compact header has no room for plugin buttons and a title could shrink to nothing. The right panel's tab list opens the log there instead.

## 0.2.0 (2026-10-19)

### Added

- Rows are tinted by type in the active bb theme's colors: agent replies, tool calls and subagents, commands, file changes and failures each get a faint background, a 2-pixel rail on the left edge and a colored icon. Thinking rows and incoming messages stay neutral, and a failed row takes the failure color whatever its kind.
- A "Tint rows by type" setting (`tintRows`), on by default, turns the backgrounds and rails on, and icons stay coloured either way.

## 0.1.1 (2026-10-17)

### Changed

- The README embeds two screenshots taken from an isolated demo bb: the log beside a thread, and the log maximized to the whole window.

## 0.1.0 (2026-10-17)

### Added

- A Session Log tab in a thread's side panel, opened with Mod+Shift+L or from a button in the thread header. It shows the whole session as one flat, live log read from bb's timeline: incoming messages, steers and child reports as labeled dividers, then agent replies, thinking, commands with output, exit codes and duration, tool calls, file diffs and subagent steps in timeline order.
- The log follows new output until you scroll up or move to an older row with the keyboard; "↓ Latest" or `G` resumes it. Replies stay visible in full, long output previews its first and last lines, and failed commands and tools open expanded.
- Filters for Messages, Thinking, Tools and Errors, and search across the whole session.
- Keyboard control: `j`/`k` move between rows, `Enter` or `o` expands the focused row, `x` toggles the expanded view, `n`/`N` step through replies, `e`/`E` through errors, `g`/`G` jump to the first and latest rows, and `/` focuses search. `c` copies the row and `s` shows the message in bb's chat.
- Settings under Settings → Plugins → Session Log, also set with `bb plugin config session-log set <key> <value>`, and changes reach open panels straight away: `outputHeadLines` and `outputTailLines` (4 each), `thinkingLines` (3), `expandFailures` (on), `showMessages`, `showThinking` and `showTools` (on) for the chips' starting state, and `timeFormat` (`24h` or `12h`).
- The panel reads bb's public timeline and keeps no copy of the thread; only the expanded-view choice is saved on this device.

### Compatibility

- Needs bb 0.46 or newer and plugin SDK 0.6.49 or newer.
