# Lineup

A bb plugin that adds **Recent** and **Lineup** tabs to bb's own model menu,
so you pick a model from a short list instead of scrolling every provider's
catalog.

- **Recent** lists the models your threads ran on most recently, newest
  first. The count is the **Models in Recent** setting (default 25, up to
  100).
- **Lineup** lists models you pin. Hover any row in the menu, including bb's
  own rows, and click its pin.
- Picking a row switches the composer's model as bb's list does. Typing
  filters the tab and also lists matches from every provider.
- Tab and Shift+Tab in the search box move between Recent, Lineup and bb's
  list. The menu reopens on the last tab used, and on bb's list until you
  choose another.
- Settings → Plugins → Lineup reorders the lineup and adds models with bb's
  picker.

## Install

```sh
bb marketplace add git:github.com/kalindudc/bb-marketplace@main
bb plugin install lineup@kalindudc
```

## How it works

bb has no plugin API for its model menu, so the frontend adds to the menu bb
0.47.1 draws, through the public SDK wherever one exists:

| Part                         | How                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------ |
| Knowing which composer opened the menu | An action in each composer (`app.composer.customize`) that renders a hidden span; it watches that composer's model button (`aria-label^="Provider, model and reasoning"`) and finds the menu through its `aria-controls` |
| Tabs, list and pins          | React portals into containers added to bb's menu: the tabs at the start of bb's provider tab row (or a row of Lineup's own when bb draws none), the list after bb's `[role=listbox][aria-label=Models]`, a pin slot before each row's check mark |
| Showing a tab                | `data-lineup-view` on the menu; `app.css` hides bb's list and mutes its tab underline while Recent or Lineup is open |
| Picking a model              | `useComposer().setSelection({ providerId, model })`, the same path bb's pickers take |
| Keys                         | A window capture listener for keys typed in the menu's search box: Tab cycles the three lists; arrows and Enter drive Lineup's list |
| Recent models                | `server.ts` reads the thread list in pages of 500 (bb's list is not ordered by activity, so the newest threads can be anywhere in it), then reads the last model of the 400 most recently active threads with `bb.sdk.threads.defaultExecutionOptions`, caching by thread and `updatedAt` (`src/recent.ts`); a thread whose model cannot be read is skipped and tried again next time |
| Model names                  | `bb.sdk.providers.list` and `providers.models`; names drop the provider's brand prefix, as bb's rows do |
| Lineup and last tab          | One `bb.storage.kv` value. Each write is one change (`pin`, `move` or `setLastView`); the server applies them one at a time to the latest state, each window sends its own in order, and every write publishes `state-changed` so other windows read the state again (a window with a write on its way reads again once it finishes) |

`src/picker.ts` holds every selector. When the search box or the model list
is missing, Lineup leaves the menu alone; when the menu closes it removes
everything it added. `test/fake-picker.ts` reproduces bb's markup for the
tests, so update it with the selectors when bb's menu changes.

Tab never clicks one of bb's provider tabs, because in bb that also switches
the composer's provider.

## Develop

```sh
npm install
npm test           # vitest + jsdom
npm run typecheck
bb plugin build
```

To run a working copy, remove the marketplace install first (this deletes the
plugin's saved lineup and settings), then install the directory:

```sh
bb plugin remove lineup
bb plugin install "path:$PWD" --yes
bb plugin reload lineup        # after each build
```
