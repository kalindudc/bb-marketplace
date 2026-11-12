# Gruve

A coding theme for bb with gruvbox and House style palettes: sharp corners, flat surfaces and a configurable monospace UI.

| Mode | Canvas | Sidebar | Ink | Accent |
|---|---|---|---|---|
| Dark (gruvbox soft) | `#32302f` | `#2b2928` | `#ebdbb2` | `#fabd2f` |
| Light (dimmed paper) | `#e7e3d8` | `#ded9cc` | `#282828` | `#704700` |

Light mode keeps gruvbox's ink and accents on a dimmed neutral paper instead of gruvbox's bright yellow `#fbf1c7`, so large surfaces don't glare. Accents use deeper shades of gruvbox's faded colours so they clear 4.5:1 as text on the paper and on chips.

## Install and turn it on

```sh
bb marketplace add git:github.com/kalindudc/bb-marketplace@main
bb plugin install gruve@kalindudc
bb theme set plugin:gruve:gruve
```

Or pick **Gruve** under **Settings → Appearance**. Light or dark stays bb's per-client setting.

## What it changes

- Colours: the anchors (`--canvas`, `--ink`), the surfaces, borders, text tiers, status colours and the 16 ANSI terminal colours for each mode. With square corners and no shadows, dark mode separates layers with gruvbox's own steps: cards on bg1 (`#3c3836`), outlines and seams on bg2 (`#504945`). Light mode's default Soft paper does the same on dimmed paper: cards a step lighter but off white (`#edeae1`), borders at about 2:1 (`#a49b82`), input outlines at 3:1 and a darker selected row in the sidebar.
- Shape: `--radius` is `0px`, and bb's few fixed-radius utilities (`rounded`, `rounded-xl` and the `rounded-[Npx]` ones) are squared. `rounded-full` stays round, so avatars, spinners, dots and pills keep their shape.
- Elevation: every `--shadow-*` token is a zero, transparent shadow. Tailwind joins shadows into one `box-shadow` list, so `none` would void the whole declaration.
- Type: `--font-sans`, `--font-mono` and `--font-terminal` use JetBrains Mono (the Nerd Font build first), then your system monospace font.
- Lists: bb leaves room for a proportional `1. ` before a numbered item, which a monospace number overflows, so messages clipped it. Gruve indents bb's numbered lists by the number's width in characters plus two, for the full stop and the space, in messages and in plugin overviews alike. Messages set that indent inline, so the rule needs `!important`.
- Code: diffs and file previews use the gruvbox dark soft and gruvbox light hard syntax themes, declared as `codeTheme` in `package.json`.
- Composer: bb's bundled composer reads as a terminal prompt, with a `❯` before the first line, a `--primary` caret, an accent border and left rail while it has focus, and an outlined send button. When sending has options, bb joins the send button and its chevron in one group filled with ink; Gruve outlines that group in the accent too, so it never shows as a dark block in light mode or a light one in dark mode.

The theme sets bb's tokens and styles bb's own composer and numbered lists, nothing else. Plugins with their own UI, such as [Switchboard](../switchboard), are not restyled: they keep their own radii and read the colours through bb's variables.

The composer rules hook bb's `data-promptbox` attributes and are scoped to `[data-bb-plugin="bb--composer"]`, the bundled composer's plugin root. A replacement composer chosen under Settings → Appearance → Composer is left alone, and a test fails if a composer rule loses that scope. A bb release that renames those attributes would drop the prompt styling, not the colours.

The integrated terminal paints on `--sidebar`, so it is paper in light mode. The light ANSI palette uses gruvbox's faded colours, darkened where needed; every colour except black clears 4.5:1 on the terminal and on command output in both modes.

## Settings

**Settings → Installed plugins → Gruve** has seven settings. Every default is what the theme ships with, so a fresh install writes no extra CSS at all.

| Setting | Values | Changes |
|---|---|---|
| Accent colour | Yellow (default), Orange, Red, Green, Aqua, Blue, Purple | `--primary` and `--primary-foreground`: links, the composer prompt and caret, focused controls |
| Mode | Classic, Crisp, Soft (default), Dim, House style | The whole palette of both light and dark mode: how much light the surfaces give off, how bright the text is and how firmly lines are drawn. bb's own light or dark setting still picks between the two |
| Interface font | JetBrains Mono (default), IBM Plex Mono, Fira Code, Source Code Pro, Cascadia Code, System monospace, System sans | `--font-sans`, so the app, its menus and your messages |
| Code and terminal font | The same families, minus the proportional one | `--font-mono` and `--font-terminal`: code blocks, diffs, file previews, the integrated terminal |
| Text size (px) | 12 to 20, default 16 | The root font size; bb is laid out in rem, so the whole interface scales |
| Corners | Square (default), Soft 3px, Rounded 6px | `--gruve-corner`, which every radius in the theme derives from |
| Composer prompt | `❯` (default), `›`, `$`, `λ`, None | `--gruve-prompt`; None also gives the composer its left inset back |

Each mode has its own light and dark shade of every accent, so the choice stays readable everywhere; a test checks every accent against every surface of every mode, light and dark. The settings are stored by bb and shared by every window. A change applies as you save it, and switching away from Gruve removes its additions without a reload.

The modes, each with a light and a dark version:

| Mode | Light page and cards | Light borders, body text | Dark page and cards | Dark borders, body text |
|---|---|---|---|---|
| Classic: the colours of Gruve 0.2.0 | `#f4f1e8`, `#faf8f1` | 1.42:1, 10.3:1 | `#32302f`, `#3c3836` | 1.72:1, 9.6:1 |
| Crisp: the most contrast, with the brightest text | `#f4f1e8`, `#fffdf8` | 2.30:1, 13.1:1 | `#282828`, `#32302f` | 2.26:1, 13.0:1 |
| Soft: dimmed paper and gruvbox soft dark (default) | `#e7e3d8`, `#edeae1` | 2.16:1, 11.5:1 | `#32302f`, `#3c3836` | 1.72:1, 9.6:1 |
| Dim: the least light, for a dark room | `#ddd9ce`, `#e3e0d8` | 2.19:1, 10.5:1 | `#1d2021`, `#282828` | 1.71:1, 9.6:1 |

Dark Crisp sits on gruvbox's medium background with its brightest text, `#fbf1c7`. Dark Dim sits on gruvbox's hard background with the dimmer `#d5c4a1` text and gruvbox's normal accents in place of the bright ones, so it gives off the least light at the same contrast as Soft. Classic's dark version is Soft's, since Gruve 0.2.0 shipped today's dark mode.

House style uses the house palette's warm paper (`#f6f3ec`) and charcoal (`#24221f`), with its own card, rule, ink and muted accent colours. Warnings and attention use orange, success uses aqua, errors use red, and merged PRs use purple. Terminal colours use the same house accents, including orange instead of ANSI yellow. Yellow in the accent setting becomes house Blue; the other accent choices use their house equivalents. Font, size, corner and prompt settings stay independent. Syntax highlighting still uses the gruvbox themes declared in the manifest.

The exact house palette keeps its softer borders and one secondary ink colour rather than Gruve's three secondary text tiers. On BB's 15% status washes over a dark card, red has 3.84:1 contrast, purple 4.25:1 and orange 4.47:1: these badge pairs do not meet the 4.5:1 AA threshold for small text. Tests record those limits rather than changing the house colours or claiming full AA compliance. The house tokens are copied into `src/house-tokens.json`, so local and Git installs need no external skill files.

Soft is the theme sheet itself; the other modes live in `src/palettes.ts` and replace every surface, line, text, status and terminal colour in both schemes, with accent shades of their own. Light colours go in a `:root:not(.dark), .light` block and dark ones in `.dark`, so neither reaches the other scheme. A test fails if Soft in `src/palettes.ts` drifts from the theme sheet, or if a palette misses one of its colours.

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
bb plugin config gruve set mode house
bb plugin dev
```

Edits to `themes/gruve.css` need a reload; edits to the settings code need `bb plugin build` first, because bb loads the built bundle.

Theme Preview (a built-in bb panel) shows every resolved token with its contrast ratio and repaints as you edit.

## Release

After merging to an up-to-date `main`, tag the version and push the tag:

```sh
git tag gruve/v0.4.0 && git push origin gruve/v0.4.0
```

## Credits

Colours come from [gruvbox](https://github.com/morhetz/gruvbox) by Pavel Pertsev (MIT). The paper light base and darkened accents are this theme's own. Not affiliated with the gruvbox project.
