# Changelog

Notable changes to Lineup, newest first. Releases are tagged `lineup/vX.Y.Z` in this repository.

## 0.1.1 (2026-10-29)

### Fixed

- Pins, reorders and tab changes made close together, in one window or several, all keep their change. Each write now names one change (pin, unpin or move one model, or set the last tab), the server applies writes one at a time to the latest stored state, and each window sends its writes in order. Before, two overlapping saves could each rewrite the whole state, so the later one dropped a pin or brought back the previous tab.
- A window shows a change made in another window even when it arrives while this window's own pin or move is on its way. That window reads the state again once its writes finish, and a change announced during an older read is read again instead of reusing that read. Before, the window could keep its own older state until the next change or a reload.
- Recent leaves out a thread whose model cannot be read, such as a thread deleted during the scan, and still lists every other recent model. Before, one such thread failed the whole list, which showed as empty with an error toast. The thread is tried again on the next scan.
- Recent reads bb's thread list in pages of 500 instead of in one request. bb's list is not ordered by activity, so Recent still reads every thread's summary to find the newest ones, but a default page size can no longer cut the list short and hide recent models. Models are still read for at most the 400 most recently active threads.
- The settings page starts its model picker on the first provider that offers a model, counting models bb lists only once selected, and skips providers that are signed out or fail to answer. When none offers a model it says so. Before, it tried only the first provider and could show "Loading models…" for good.

## 0.1.0 (2026-10-29)

### Added

- **Recent** and **Lineup** tabs at the start of bb's model menu, before its provider tabs. When only one provider is enabled and bb draws no tab row, Lineup adds one with an **All models** tab for bb's own list.
- **Recent** lists the models your threads ran on most recently, newest first, with how long ago each was used. It reads them from thread history, so it is full from the first day. **Models in Recent** in the plugin's settings sets how many it shows (25 by default, up to 100).
- **Lineup** lists models you pin. Hover a row in any of the menu's lists, including bb's own provider lists, and click its pin to add the model or take it out; pinning never changes the selected model.
- Picking a row in Recent or Lineup switches the composer's model through bb's own selection path, and the menu stays open so the reasoning level can be changed too.
- Typing in the search box filters Recent or Lineup and lists matching models from every provider underneath.
- **Tab** and **Shift+Tab** in the search box move between Recent, Lineup and bb's list; the arrow keys, Home, End and Enter drive Lineup's lists as they drive bb's.
- The menu reopens on the tab used last, and on bb's own list until another is chosen. The lineup and the last tab are saved on the bb server, so every window shares them.
- **Settings → Plugins → Lineup** reorders the lineup, removes models from it and adds any model with bb's provider and model picker.
- Works in the New thread composer and in thread composers. If bb's menu is not drawn as Lineup expects, Lineup leaves it unchanged, and it removes everything it added when the menu closes.
