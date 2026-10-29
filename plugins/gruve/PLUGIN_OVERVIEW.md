A gruvbox theme for bb, tuned for long coding sessions: sharp corners, flat surfaces and a monospace UI, so bb reads like a terminal.

## What you get

- Dark mode is gruvbox soft: a `#32302f` canvas and a `#2b2928` sidebar, one step lighter than stock gruvbox, with gruvbox yellow as the accent.
- Light mode keeps gruvbox's ink and accents but trades the yellow `#fbf1c7` background for a neutral paper `#f4f1e8`. Accents use gruvbox's darker faded shades so links and status text stay readable.
- 0px corners everywhere bb uses its radius scale, and no drop shadows. Avatars, spinners, status dots and pills stay round.
- JetBrains Mono for the whole interface, code and the integrated terminal. It falls back to your system monospace font when JetBrains Mono is not installed.
- A composer styled as a terminal prompt: a `❯` before your first line, a yellow caret, an accent border while it has focus, and an outlined send button.
- Gruvbox syntax colours in diffs and file previews: gruvbox dark soft and gruvbox light hard.
- A gruvbox terminal palette for each mode.
- Six settings under **Settings → Installed plugins → Gruve**: accent colour (seven gruvbox accents, each with a shade for both modes), interface font, code and terminal font, text size from 12 to 20px, corners (square, 3px or 6px) and the composer's prompt glyph. Every default is what the theme ships with, so the CSS stays exactly as written until you change something, and a save applies straight away in the window you made it.

Every text colour clears 4.5:1 contrast on the canvas, cards, menus, sidebar and hovered rows in both modes, and so does every terminal colour except black. A test keeps it that way, including every accent the settings offer.

## Turn it on

Pick **Gruve** under **Settings → Appearance**, or run:

```sh
bb theme set plugin:gruve:gruve
```

Light or dark is still bb's own per-client setting.

## Limits

- It sets bb's theme tokens and styles bb's own composer, nothing else. Plugins that draw their own UI, such as a custom sidebar, keep their own corner radii and pick up the colours through bb's variables. If you choose another composer under Settings → Appearance → Composer, Gruve leaves it alone.
- The settings only apply while Gruve is the active theme: pick another theme and its own colours come back with nothing left behind.
- The composer styling relies on bb's `data-promptbox` markup, so a bb release that changes it can drop the prompt glyph until Gruve is updated. The colours are unaffected.
- The integrated terminal paints on the sidebar colour, so it is paper in light mode rather than dark.
