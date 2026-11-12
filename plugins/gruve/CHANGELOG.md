# Changelog

Notable changes to Gruve, newest first. Releases are tagged `gruve/vX.Y.Z` in this repository.

## 0.4.2 (2026-11-12)

### Fixed

- House style’s heavier text weights now apply only in light mode. Dark mode returns to weight 400 for regular text and 500 for medium labels, and the settings previews show each scheme’s actual weight.

## 0.4.1 (2026-11-12)

### Changed

- Dimmed House style's light page and card surfaces to reduce glare, with slightly deeper light status text to preserve badge contrast. Dark canvas colours and link accents are unchanged.
- House style now uses weight 500 for regular text and 600 for medium-weight labels, native font smoothing, and sturdier strokes for built-in SVG icons, including older bb icons with fixed stroke widths.
- Thread hover follows the selected accent's house-palette tint in both schemes, with a deeper highlight in light mode. Sent-message bubbles use a softer accent tint and an accent-coloured border to separate them from the page.
- Panel borders and dividers are firmer in both schemes, and secondary ink is stronger in light mode.

## 0.4.0 (2026-11-12)

### Added

- House style mode with the house palette's warm paper and charcoal, muted accents, semantic status colours and matching terminal colours in both light and dark mode. Yellow maps to house Blue; other accent choices keep their house equivalents. Existing font, corner, size and prompt settings are unchanged.
- Tests for palette fidelity, settings persistence and live settings previews. Contrast tests record the exact palette's known limits on BB's dark status badge washes.

## 0.3.2 (2026-11-05)

### Fixed

- Numbered lists in messages lost the left part of their numbers, so `1.` read as `l.`. bb leaves room for a proportional `1. `, and in a monospace font the number, the full stop and the space are a character each, which is wider. Gruve now indents bb's numbered lists by the number's width in characters plus two, so the numbers line up with the text above them and wrapped lines still hang under the item. Plugin overviews get the same indent, with room for two digits once a list reaches ten items.

## 0.3.1 (2026-11-05)

### Fixed

- The **Light mode** setting added in 0.3.0 only changed light mode. It is now **Mode**, and every mode has a dark version as well as a light one; bb's own light or dark setting still picks between them.
  - Classic: the colours of Gruve 0.2.0 in both schemes.
  - Crisp, which replaces Bright: the most contrast. Light mode keeps the bright paper and draws borders at 2.3:1 and input outlines at 3.3:1; dark mode moves to gruvbox's medium `#282828` with its brightest text, `#fbf1c7`, and firmer lines.
  - Soft (default): unchanged in both schemes.
  - Dim: the least light. Light mode keeps the dimmest paper; dark mode moves to gruvbox's hard `#1d2021` with the dimmer `#d5c4a1` text and gruvbox's normal accents in place of the bright ones.
- A Light mode saved by 0.3.0 carries over, with Bright becoming Crisp.
- The settings page previews the light and dark versions of the chosen mode side by side.
- Tests run the contrast checks on every mode in both schemes, hold Crisp to firmer lines than Soft, and check that Dim gives off less light than Soft in dark mode.

## 0.3.0 (2026-11-05)

### Added

- A **Light mode** setting that picks how bright light mode is and how firmly it draws lines. Dark mode is not affected.
  - Classic: the bright paper and faint lines of Gruve 0.2.0.
  - Bright: the same bright paper with firm lines and near-black text.
  - Soft (default): a dimmed paper with firm lines, described below.
  - Dim: the dimmest paper, about 70% as bright as white.

  Each paper replaces every surface, line, text, status and terminal colour, and has its own shade of every accent, so text and accents clear 4.5:1 on all four. The settings page previews the chosen paper, even from dark mode. The palettes live in `src/palettes.ts`.

### Changed

- Light mode's default paper is dimmer, so large surfaces no longer glare. The paper went from `#f4f1e8` to `#e7e3d8`, cards and menus from near-white `#faf8f1` to `#edeae1`, and the sidebar from `#ebe7db` to `#ded9cc`. The brightest surface now reflects 82% as much light as white, down from 94%, and a test keeps the paper, cards, menus and sidebar under a luminance ceiling.
- The Soft paper has much more contrast, so outlines, chips and selected rows are easy to find:

  | | 0.2.0 | 0.3.0, Soft |
  |---|---|---|
  | Borders on the page | 1.42:1 | 2.16:1 |
  | Seams and dividers | 1.42:1 | 2.05:1 |
  | Form input outlines | 2.04:1 | 3.15:1 |
  | The sidebar's edge | 1.30:1 | 1.87:1 |
  | Selected or hovered sidebar row | 1.11:1 | 1.23:1 |
  | Chips and filled buttons on a card | 1.23:1 | 1.30:1 |
  | Body text (now gruvbox `#282828`) | 10.3:1 | 11.5:1 |
  | Muted, readback and subtle text | 6.8, 6.1 and 5.5:1 | 8.1, 7.1 and 6.3:1 |

  Hovered rows use 10% ink instead of bb's 5.9%.
- On the Soft paper, the light shades of the accents, status colours and terminal colours are a little deeper, so each still clears 4.5:1 on the dimmer paper and on chips: yellow is `#704700`, orange `#922d00`, green `#575200`, aqua `#265a3e`, blue `#005869` and purple `#813464`; red is unchanged. Dark mode is unchanged.
- Tests now run the contrast checks on all four papers, hold every paper but Classic to minimum contrasts for its lines, keep Soft and Dim under a brightness ceiling, and check that the send group is outlined rather than filled.

### Fixed

- The send button in bb 0.48's composer showed as a solid dark block in light mode, and a light one in dark mode. bb now puts the send button and its options chevron in one group filled with ink and forces the buttons inside it transparent, so Gruve outlines the group in the accent instead, with a thin seam before the chevron. Hovering fills it with the accent, and an empty composer shows it in the input outline colour.

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
