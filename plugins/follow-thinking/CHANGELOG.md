# Changelog

Notable changes to Follow Thinking, newest first. Releases are tagged `follow-thinking/vX.Y.Z` in this repository.

## 0.2.0 (2026-10-20)

### Added

- Follow thinking is in every thread's actions menu, under the settings group, showing On or Off beside the brain icon. Choosing it flips the plugin and says "Follow thinking is on" or "Follow thinking is off" in a toast, as the palette command does.

### Changed

- On a phone, the thread header no longer draws the brain button. bb's thread header has no overflow for plugin buttons, so with several plugins installed the title shrank to nothing, plugin icons covered the thread actions button and the panel toggle was pushed off screen. The actions menu, which a phone opens as a drawer, carries the toggle instead.
- The README and the plugin overview list the actions-menu item beside the header button and the palette command, and say that a phone leaves the button out.

## 0.1.0 (2026-10-16)

### Added

- The live Thinking… row at the bottom of a running thread opens by itself and stays scrolled to its newest line while the text streams.
- Finished Thought rows open when they appear, including the ones inside an activity group, which open when you open the group.
- Scrolling up inside a thinking block to read earlier text stops the block following, and scrolling back to the bottom starts it again. It follows the way bb's own sticky scrollers do: it stays at the bottom unless you scrolled or dragged within the last 350 ms.
- A block you collapse stays collapsed. The plugin remembers your choice for that timeline row by its row id, so the block does not reopen when the row remounts as the timeline windows rows in and out.
- A brain button in the thread header turns the plugin on or off.
- The command palette command `Follow Thinking: Toggle auto-expand and auto-scroll of thinking` does the same, and says in a toast whether it is now on or off.
- Turning the plugin off collapses the blocks it opened and leaves the ones you opened yourself.
- The on or off choice is kept in bb's local storage for each device, is shared by every bb window on that device, and starts on.

### Compatibility

- Needs bb 0.46 or later and plugin SDK 0.6.49 or later.
- bb has no plugin API for timeline rows, so the plugin recognises a thinking row by the markup bb 0.46.1 draws: the row's toggle button, the brain icon, the text that starts with Thinking, and the thinking text box. A bb release that changes that markup leaves the plugin doing nothing until it is updated; the timeline itself keeps working.
