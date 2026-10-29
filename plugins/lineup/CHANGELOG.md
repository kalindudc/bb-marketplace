# Changelog

Notable changes to Lineup, newest first. Releases are tagged `lineup/vX.Y.Z` in this repository.

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
