# Changelog

Notable changes to Gruve, newest first. Releases are tagged `gruve/vX.Y.Z` in this repository.

## 0.2.0 (2026-10-29)

### Added

- Six settings under **Settings → Installed plugins → Gruve**, all of them with the theme's own values as defaults, so an install that changes nothing is styled exactly as before:
  - Accent colour: yellow (default), orange, red, green, aqua, blue or purple. Each has a light and a dark shade, and every shade keeps the 4.5:1 floors the theme already promises.
  - Interface font, and a separate code and terminal font: JetBrains Mono (default), IBM Plex Mono, Fira Code, Source Code Pro, Cascadia Code or the system monospace font, plus a proportional choice for the interface.
  - Text size from 12 to 20px, applied to the root font size; bb lays itself out in rem, so the whole interface scales.
  - Corners: square (default), 3px or 6px.
  - Composer prompt glyph: `❯` (default), `›`, `$`, `λ` or none, which also gives the composer its left inset back.
- A preview under the settings form that shows the chosen font, text size, prompt glyph and accent, and applies a save to the window it was made in without a reload.
- A mask-friendly icon. bb paints a plugin icon as a mask in the theme's colour, so the old full-bleed tile showed as a solid square; the mark is now a square terminal with a prompt and a cursor, and `icons/gruve-color.svg` is the same mark in gruvbox colours for the marketplace listing. A test fails if the mask icon paints a fill or pins a colour.

### Changed

- The corner radius and the composer prompt are now read from `--gruve-corner`, `--gruve-prompt` and `--gruve-prompt-indent` rather than being written into each rule, so the settings can rewrite them. The theme looks identical with the defaults.
- The plugin now ships a frontend bundle (`app.tsx`), so it needs `bbPluginSdk` 0.6.79 or newer.

## 0.1.0 (2026-10-28)

### Added

- The Gruve theme: gruvbox soft dark (`#32302f`) and a neutral paper light (`#f4f1e8`) instead of gruvbox's yellow `#fbf1c7`, with 0px corners, no drop shadows and a JetBrains Mono interface, code font and terminal font.
- Dark mode layers one gruvbox step apart, so cards, buttons, chips and dividers stand off the page without shadows: cards on bg1 (`#3c3836`), seams and outlines on bg2 (`#504945`), and a slightly stronger hover. Lines stay under 2.2:1 against the canvas so they don't read as hard rules.
- bb's composer styled as a terminal prompt: a `❯` before the first line, an accent caret, an accent border and left rail while it has focus, and an outlined send button. It applies only to bb's bundled composer.
- Gruvbox syntax colours for diffs and file previews (gruvbox dark soft and gruvbox light hard), and a gruvbox ANSI palette for each mode.
- Tests that every text colour clears 4.5:1 on the canvas, cards, menus, sidebar and hovered rows, that status badges clear 4.5:1 on their own wash, and that every ANSI colour but black clears 4.5:1 on the terminal, all in both modes. Further tests keep dark mode's layers apart and its lines soft, and keep the composer rules scoped to bb's composer.
