# Follow Thinking

A bb plugin that opens thinking blocks in the thread timeline automatically
and keeps live thinking scrolled to its newest line while it streams.

- The live "Thinking…" row and finished "Thought" rows open as they appear.
  Thought rows inside a collapsed activity group open when you open the group.
- Live thinking follows its newest line. Scrolling up inside the block stops
  following; scrolling back to the bottom resumes it.
- A block you collapse stays collapsed.
- Turn it on or off with the brain button in the thread header or the palette
  command "Follow Thinking: Toggle auto-expand and auto-scroll of thinking".
  Turning it off collapses the blocks the plugin opened. The choice is stored
  in the app's local storage, per device, and defaults to on.

## Install

```sh
bb marketplace add git:github.com/kalindudc/bb-marketplace@main
bb plugin install follow-thinking@kalindudc
```

## How it works

`app.tsx` registers a content script, the header button and the palette
command. The content script (`src/follow-thinking.ts`) watches the page for
timeline rows. bb has no plugin API for timeline rows, so it relies on the
markup bb 0.46.1 renders:

| What                    | Selector or signal                                              |
| ----------------------- | --------------------------------------------------------------- |
| Row toggle button       | `.group\/timeline-row > button[aria-expanded]`                  |
| Finished thought row    | the button contains `[data-icon="AiBrain01"]`                   |
| Live indicator          | no `[data-icon]` in the button and its text starts with "Thinking" |
| Thinking text box       | `.max-h-80.overflow-auto.whitespace-pre-wrap`                   |
| Stable row identity     | the closest `[data-timeline-row-id]`                            |

It opens a block by clicking its toggle button, so bb's own expansion state
stays in charge, and it follows text the way bb's sticky scrollers do: stay
at the bottom unless the person scrolled away within the last 350 ms or is
dragging. If a bb release changes this markup, nothing matches and the
plugin does nothing; update the selectors and the fixture in
`test/fake-timeline.ts` together.

## Develop

```sh
npm install
npm test           # vitest + jsdom
npm run typecheck
bb plugin build
```

To run a working copy, remove the marketplace install first (this deletes
the plugin's bb settings; it has none), then install the directory:

```sh
bb plugin remove follow-thinking
bb plugin install "path:$PWD" --yes
bb plugin reload follow-thinking   # after each `bb plugin build`
```

## Release

Bump `version` in `package.json`, merge to `main`, then tag from an
up-to-date `main`:

```sh
git tag follow-thinking/v0.1.1 && git push origin follow-thinking/v0.1.1
```
