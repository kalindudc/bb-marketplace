# Changelog

Notable changes to Gruve, newest first. Releases are tagged `gruve/vX.Y.Z` in this repository.

## 0.1.0 (2026-10-28)

### Added

- The Gruve theme: gruvbox soft dark (`#32302f`) and a neutral paper light (`#f4f1e8`) instead of gruvbox's yellow `#fbf1c7`, with 0px corners, no drop shadows and a JetBrains Mono interface, code font and terminal font.
- Dark mode layers one gruvbox step apart, so cards, buttons, chips and dividers stand off the page without shadows: cards on bg1 (`#3c3836`), seams and outlines on bg2 (`#504945`), and a slightly stronger hover. Lines stay under 2.2:1 against the canvas so they don't read as hard rules.
- bb's composer styled as a terminal prompt: a `❯` before the first line, an accent caret, an accent border and left rail while it has focus, and an outlined send button. It applies only to bb's bundled composer.
- Gruvbox syntax colours for diffs and file previews (gruvbox dark soft and gruvbox light hard), and a gruvbox ANSI palette for each mode.
- Tests that every text colour clears 4.5:1 on the canvas, cards, menus, sidebar and hovered rows, that status badges clear 4.5:1 on their own wash, and that every ANSI colour but black clears 4.5:1 on the terminal, all in both modes. Further tests keep dark mode's layers apart and its lines soft, and keep the composer rules scoped to bb's composer.
