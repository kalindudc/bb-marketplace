# Changelog

Notable changes to Flare, newest first. Releases are tagged `flare/vX.Y.Z` in this repository.

## 0.3.1 (2026-11-09)

Agents keep sending flares once a thread's turns get shorter, and flares stay drawn.

### Changed

- The tool's instructions and the skill tie a flare to moments in the agent's own work: finishing a step of its plan or a phase such as research, a build or a deploy, confirming something, making a decision the user might redirect, or hitting a blocker. When many tool calls have passed since the last flare, they ask the agent to check whether one of those moments went by. They also say a turn of a few tool calls needs no flare, because its reply is the update. The triggers name no other plugin's tools. Across Nov 5 and 6, 3% of top-level turns under 2 minutes sent a flare, against 27 to 57% of longer ones, and one 18-minute research turn finished two plan steps without sending any.
- For a quick status, the title is the whole flare. Anything more still opens with a sentence and draws its evidence. The instructions now add "A body that is all prose is right only when there is nothing to see", and they tell the agent to draw what it already has. After 0.3.0, title-only flares stopped, and the share of turns of 5 minutes or more with a flare fell from 38% to 17%; the work changed shape too, so that drop has more than one cause.
- The drawing guidance from 0.3.0 stays as it was. The instructions, the body description and the skill name genui's `ui` views and inline-vis pages as rendering plugins Flare draws when they are installed, beside Markdown tables, mermaid and images, which need no plugin. With that guidance, 82 of 87 flares drew a block, a table or an image, against 16 of 164 before it, and walls of text fell from 45 to 3. Tests keep the plugin names, the Markdown fallback and the all-prose rule in the text.
- The quiet-turn reminder says a title alone is enough.

## 0.3.0 (2026-11-06)

Agents draw what they found in a flare instead of describing it.

### Added

- When a body over 200 characters has no block, table or image but holds 6 or more numbers, 3 or more list items or a thread-storage file, "Flare sent" comes back with a hint naming the views that fit. It comes once a turn, or once an hour outside a turn, and never for a blocker.
- The help for `bb flare send --body` and the skill show how to send a body with fenced blocks: write it to a file and pass `--body "$(cat body.md)"`.

### Changed

- The tool's body description, its instructions and the skill ask for one or two sentences and then the evidence as a block. They map key numbers to a Metric row, comparisons to a Table, flows to a mermaid diagram, PRs to Status or Steps, saved files to a view that loads them and screenshots to a Gallery, and they give one example. On November 5, none of the 42 flares sent during real work drew anything, even after the Flares tab could.
- The instructions say that a rule keeping blocks to the message that ends a turn, such as genui's, does not cover a flare's body. The old description, "a few lines at most", is gone.

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
