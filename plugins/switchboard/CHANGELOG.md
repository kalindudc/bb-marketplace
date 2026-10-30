# Changelog

Notable changes to Switchboard, newest first. Releases are tagged `switchboard/vX.Y.Z` in this repository.

## 0.3.9 (2026-10-28)

### Changed

- Switchboard takes its corner radii, fonts, surface shadows and destructive foreground colour from the active bb theme, including portalled info cards and drag previews. Saved section colours are unchanged.
- Pull request numbers in rows and the pull request line in the info card are now read from the GitHub PR Status plugin by thread environment. When that plugin is absent, disabled or cannot answer, Switchboard leaves the pull request out instead of waiting on it.

### Compatibility

- Requires bb Plugin SDK 0.6.79 or newer, up from 0.6.49.

## 0.3.8 (2026-10-20)

### Fixed

- Tree lines end at a parent's last child. When a parent with children was not the last thread in its section, the line under its last child ran on past it into the next, unrelated thread; each row now draws only its own column, so a last child closes with an elbow and the section's tree stops there.

## 0.3.7 (2026-10-19)

### Changed

- Drag auto-scroll keeps going while the pointer rests near the sidebar's edge, speeds up the closer it gets at any refresh rate, and updates the drop target as rows pass under the pointer.

### Fixed

- The running spinner turns smoothly on the compositor instead of jittering. A 92 ms main-thread timer used to turn it in 30 degree jumps, which land unevenly on a 60 Hz screen and stall while bb streams a thread; it is now a CSS animation of one turn a second in 30 even steps, and only spinners on screen animate.
- Every spinner shares one phase, including one whose animation restarts when React moves its row, and each iteration lasts 1000 turns so its iteration events do not wake bb's main thread. Reduced motion keeps the glyph still.
- The drop flash fades an overlay's opacity on the compositor instead of repainting the row's background each frame, and reduced motion turns it off.
- In headless Chrome with 5 to 7 running spinners, idle renderer CPU fell from 4.1% to 2.4% of a core and main-thread busy time from 2.1% to 0.4%; while a thread streamed, renderer CPU was 22.0% against 23.7% and main-thread busy time 13.3% against 15.4%.

## 0.3.6 (2026-10-19)

### Fixed

- A drag starts after 5 pixels of movement in any direction. Before, a first move that was more sideways than down cancelled the drag until release, so a slightly diagonal grab did nothing and letting go opened the thread.
- A drag no longer swallows your next click. Only the click fired by the drag's own release is ignored; before, a release over another row left the guard set, so the next click on a thread did nothing.
- A drag cancelled with Escape waits for the pointer release, so letting go over a row does not open it.
- The drag preview is placed at the cursor before its first paint instead of at the top of the list, and the list shows a grabbing cursor while dragging.
- Auto-scroll moves only the sidebar, because drags cross the main pane on their way to a split. Moving off the sidebar still hands over to bb's drag-to-split.

## 0.3.5 (2026-10-18)

### Fixed

- The running spinner no longer keeps bb's compositor busy. It was an SVG image mask with a SMIL rotation that repainted on every frame, about 170 to 290 paints a second, and held the desktop compositor near 100% of a core; one shared timer now turns every running spinner in 12 steps a turn, and will-change keeps each step off the paint path.
- In headless Chrome against the bb web UI with a scripted streaming agent, idle renderer CPU fell from 7.7% to 2.7% of a core and GPU from 6.5% to 2.0%, and streaming style time stayed within run-to-run noise of 0.3.4. Reduced motion keeps the glyph still.

## 0.3.4 (2026-10-18)

### Added

- New section opens an empty name field where the section will go and creates nothing until you press Enter. It is also in View options and, as New section below, in each section menu.
- Rename uses the same field, which selects the old name, reports a taken name or a failed save inline, and lets you retry.

### Fixed

- Escape in the new-section field leaves no placeholder section behind.

## 0.3.3 (2026-10-18)

### Fixed

- The info card closes when the pointer leaves the row before the card has rendered. The tooltip beneath it ignores a close that matches the last open state it rendered, so a quick pass over a row could leave the card on screen.

## 0.3.2 (2026-10-18)

### Changed

- Snooze and Pin moved from row buttons into the thread menu, opened with the ⋯ button or a right-click. The row keeps only Archive, and Snooze is labelled with its wake time, for example Snooze until 09:00.
- Rows in status lanes now get the ⋯ thread menu too, and the leading status glyph is centred in its column.

## 0.3.1 (2026-10-18)

### Changed

- Section, View options and selection-bar menu items now show a pointer cursor and highlight under the pointer or keyboard focus, and an open submenu keeps its parent item highlighted. Disabled items such as Mark all read and Archive stale threads… are greyed out with a not-allowed cursor, and colour swatches take a pointer too.

## 0.3.0 (2026-10-18)

### Added

- Default project in a section's menu, and in the Threads menu, picks the project that the section's + button and New thread here compose in. Automatic, the default, keeps the usual choice: the project you have open, otherwise the project of the section's newest thread.
- The + hint names the choice, for example "New Shop thread in Checkout".

### Changed

- Deleting a section clears its default project, and a default whose project no longer exists falls back to Automatic.

### Compatibility

- No migration. The stored layout gains an optional sectionProjects record, and a layout saved by an earlier version reads as having no defaults.

## 0.2.1 (2026-10-17)

### Changed

- Switchboard has its own single-colour icon, used by the sidebar, the marketplace entry and the plugin manifest.
- The README embeds screenshots of sections, an info card and status lanes, and the marketplace description and tags were rewritten for the sidebar thread list.

## 0.2.0 (2026-10-17)

### Added

- Hover a thread row, or tab to it, to open a read-only info card with the thread's state, project and section, model, context use, branch, git changes and pull request. The Briefing layout adds the first prompt and the latest reply, and a waiting thread shows what it is asking for.
- The Thread info card setting (`infoCard`) picks At a glance (`glance`, the default), Briefing (`briefing`), Full details (`full`) or Off (`off`).
- Sidebar data paints at once; fetched fields are prefetched on hover, cached briefly and show placeholders until loaded.
- Cards never open on touch screens, in compact windows or during a drag.

## 0.1.1 (2026-10-17)

### Fixed

- The thread menu stays anchored to its row. A row hid its ⋯ button whenever it was not hovered or focused, and because bb's thread menu is portalled, takes focus and positions itself against that button, moving the pointer onto the menu collapsed the button to zero and sent the menu to the window's top-left corner. An open menu now keeps the trigger, the quick actions and the row highlight in place.

## 0.1.0 (2026-10-17)

### Added

- Switchboard, a sidebar thread list for supervising many parallel agent threads. Choose Switchboard under Settings → Appearance → Sidebar in each bb client; the plugin is listed in a new Sidebar category in the marketplace.
- Threads appear as Pinned, then your bb sections, then Threads for unfiled roots, each section marked with a rail, tinted header or swatch by the `sectionColour` setting. Children stay under their parent even in another project or section, and a collapsed parent shows its most urgent hidden descendant.
- Five row states (Failed, Needs you, Running, Finished unread and Idle), with counts on collapsed groups, a filter box over title, project, section and branch, and clickable status chips. `/` focuses the filter and Escape clears its query and chips.
- A status-lanes view lists every awake thread once under Failed, Needs you, Running, Unread or Idle, sorted by recent attention. Empty lanes are hidden, lanes collapse, and lanes have no drag or multi-selection.
- Drag a thread above, below or into another thread, or onto a section header. `Alt+↑/↓` reorders among siblings, `Alt+→` nests under the previous sibling and `Alt+←` moves it out. Alt-click and Shift-click select families, and the selection bar moves, archives or snoozes them. Moves and archives offer Undo.
- Each section and Threads sorts its roots By hand, Recent activity or Status. Reorder drops and `Alt+↑/↓` are refused at a sorted root, while nesting and dropping onto its header still work, and a Sort glyph marks a sorted header.
- Idle unpinned threads fade after `staleDays` (3 by default, 0 turns fading off) unless a descendant failed, needs you or is running. Archive stale threads… in a section menu confirms the stale-root and child counts, archives only that section's stale families and offers Undo.
- A quiet root can be snoozed until `snoozeHour` tomorrow (09:00 local by default) from its Clock action or the selection bar. It leaves sections and lanes and returns through the Snoozed shelf, which shows wake times and a Wake button; new attention or a failed, waiting or running family member wakes it early.
- The Archive button beside the view switch shows an Archived shelf, most recently archived first, that follows the filter box and loads older threads with Show more. Each archived row offers Unarchive.
- Settings for `view`, `density` (`compact`, `default` for comfortable, `two-line`), `sectionColour`, `statusChips`, `needsYouShelf`, `showArchived`, `treeGuides`, `showBranch`, `showPullRequests`, `showAge`, `staleDays` and `snoozeHour`, changed in bb's plugin settings or with `bb plugin config switchboard set`.
- Palette commands to focus the thread filter (`Mod+Alt+F`), go to the next thread that needs you (`Mod+Alt+J`), switch between sections and status lanes, and open New section.
- Hints on the chips, the view switch, View options and a section's buttons. bb keeps parents, sections, pins and archives; Switchboard stores collapse state, manual order, section colours, sort modes and snoozes in its plugin store and publishes settings changes to every window.
