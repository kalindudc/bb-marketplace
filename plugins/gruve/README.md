# Gruve

A gruvbox theme for bb, tuned for coding: sharp corners, flat surfaces and a monospace UI.

| Mode | Canvas | Sidebar | Ink | Accent |
|---|---|---|---|---|
| Dark (gruvbox soft) | `#32302f` | `#2b2928` | `#ebdbb2` | `#fabd2f` |
| Light (paper) | `#f4f1e8` | `#ebe7db` | `#3c3836` | `#7d520b` |

Light mode keeps gruvbox's ink and accents on a neutral paper base instead of gruvbox's yellow `#fbf1c7`. Accents use the darker faded shades so they clear 4.5:1 as text.

## Install and turn it on

```sh
bb marketplace add git:github.com/kalindudc/bb-marketplace@main
bb plugin install gruve@kalindudc
bb theme set plugin:gruve:gruve
```

Or pick **Gruve** under **Settings → Appearance**. Light or dark stays bb's per-client setting.

## What it changes

- Colours: the anchors (`--canvas`, `--ink`), the surfaces, borders, text tiers, status colours and the 16 ANSI terminal colours for each mode. With square corners and no shadows, dark mode separates layers with gruvbox's own steps: cards on bg1 (`#3c3836`), outlines and seams on bg2 (`#504945`).
- Shape: `--radius` is `0px`, and bb's few fixed-radius utilities (`rounded`, `rounded-xl` and the `rounded-[Npx]` ones) are squared. `rounded-full` stays round, so avatars, spinners, dots and pills keep their shape.- Elevation: every `--shadow-*` token is a zero, transparent shadow. Tailwind joins shadows into one `box-shadow` list, so `none` would void the whole declaration.
- Type: `--font-sans`, `--font-mono` and `--font-terminal` use JetBrains Mono (the Nerd Font build first), then your system monospace font.
- Code: diffs and file previews use the gruvbox dark soft and gruvbox light hard syntax themes, declared as `codeTheme` in `package.json`.
- Composer: bb's bundled composer reads as a terminal prompt, with a `❯` before the first line, a `--primary` caret, an accent border and left rail while it has focus, and an outlined send button.

The theme sets bb's tokens and styles bb's own composer, nothing else. Plugins with their own UI, such as [Switchboard](../switchboard), are not restyled: they keep their own radii and read the colours through bb's variables.

The composer rules hook bb's `data-promptbox` attributes and are scoped to `[data-bb-plugin="bb--composer"]`, the bundled composer's plugin root. A replacement composer chosen under Settings → Appearance → Composer is left alone, and a test fails if a composer rule loses that scope. A bb release that renames those attributes would drop the prompt styling, not the colours.

The integrated terminal paints on `--sidebar`, so it is paper in light mode. The light ANSI palette uses gruvbox's faded colours, darkened where needed; every colour except black clears 4.5:1 on the terminal and on command output in both modes.

## Settings

**Settings → Installed plugins → Gruve** has six settings. Every default is what the theme ships with, so a fresh install writes no extra CSS at all.

| Setting | Values | Changes |
|---|---|---|
| Accent colour | Yellow (default), Orange, Red, Green, Aqua, Blue, Purple | `--primary` and `--primary-foreground`: links, the composer prompt and caret, focused controls |
| Interface font | JetBrains Mono (default), IBM Plex Mono, Fira Code, Source Code Pro, Cascadia Code, System monospace, System sans | `--font-sans`, so the app, its menus and your messages |
| Code and terminal font | The same families, minus the proportional one | `--font-mono` and `--font-terminal`: code blocks, diffs, file previews, the integrated terminal |
| Text size (px) | 12 to 20, default 16 | The root font size; bb is laid out in rem, so the whole interface scales |
| Corners | Square (default), Soft 3px, Rounded 6px | `--gruve-corner`, which every radius in the theme derives from |
| Composer prompt | `❯` (default), `›`, `$`, `λ`, None | `--gruve-prompt`; None also gives the composer its left inset back |

Each accent has a light and a dark shade, so the choice stays readable in both modes; a test checks every accent against every surface. The settings are stored by bb and shared by every window. A change applies as you save it, and switching away from Gruve removes its additions without a reload.

The appearance runs in a content script (`app.tsx`), not in the theme sheet, because a theme CSS file is static. It adds one `<style>` next to bb's own theme sheet and keeps it last, removes it when another theme is active, and follows the theme changing live. The settings form saves through bb's declarative settings, so the options are plain descriptors in `src/settings.ts`.

The section under the settings form previews the choices and is also how a save reaches the window it was saved in: a content script cannot subscribe to bb's realtime channels, so the section listens for the change and re-applies it. Refocusing a window re-reads the stored settings, which covers changes made elsewhere.

## Develop

```sh
cd plugins/gruve
npm install
npm test            # contrast floors for every text tier and every accent, both modes
npm run typecheck
bb plugin build
```

`test/appearance.test.ts` covers how settings become CSS, `test/theme.test.ts` the contrast floors and the tokens the settings rewrite, and `test/mount.test.ts` with `test/app.test.tsx` the content script and the settings page (both jsdom).

To try a working copy, install the folder and reload after each change:

```sh
bb plugin install "path:$PWD" --yes
bb theme set plugin:gruve:gruve
bb plugin reload gruve
```

Edits to `themes/gruve.css` need a reload; edits to the settings code need `bb plugin build` first, because bb loads the built bundle.

Theme Preview (a built-in bb panel) shows every resolved token with its contrast ratio and repaints as you edit.

## Release

After merging to an up-to-date `main`, tag the version and push the tag:

```sh
git tag gruve/v0.2.0 && git push origin gruve/v0.2.0
```

## Credits

Colours come from [gruvbox](https://github.com/morhetz/gruvbox) by Pavel Pertsev (MIT). The paper light base and darkened accents are this theme's own. Not affiliated with the gruvbox project.
