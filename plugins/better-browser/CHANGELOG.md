# Changelog

Notable changes to Better Browser, newest first. Releases are tagged `better-browser/vX.Y.Z` in this repository.

## 0.2.6 (2026-10-29)

### Fixed

- Any failed sync now forgets the cached bb window, not just a failed tab lease. After bb restarts or its browser window reconnects, the plugin used to keep retrying the old generation and reported "Desktop browser instance is unavailable or generation is stale" until it was reloaded; it now rediscovers the window on the next sync.

## 0.2.5 (2026-10-29)

### Security

- Cmd/Ctrl-click now opens the real browser only for a real user gesture. A page that dispatched its own click with the modifier set could previously open an arbitrary http(s) URL in the browser where you are signed in.
- The automatic sign-in handoff opens the sign-in page the tab is showing, not an address the page had planted before redirecting there. After sign-in the bb tab still reloads to the application on its own.

### Fixed

- A read that could not decrypt every cookie no longer removes the ones it could not see, and no longer forgets their remembered hashes, so a temporary keyring failure cannot sign you out or strand a stale session in bb.
- A failed cookie write keeps the change pending for the next sync instead of dropping it, and a stale bb window is rediscovered rather than reused.
- A Browser tab that goes away stops counting as focused at once, so background syncs cannot lease a tab you are not looking at.
- Choosing a browser that is not installed is reported, naming it, instead of quietly syncing the system default instead.
- Firefox and Zen links open in the synced profile, including a profile moved to an absolute path, without forcing a second instance against a profile that is already open.
- Firefox cookie expiry is read correctly whether the profile stores seconds or milliseconds.
- The Linux key probe samples only ciphertexts a key can open, so unsupported portal-encrypted rows no longer make readable cookies look undecryptable.
- The cookie watch follows a changed last-used profile instead of keeping the previous profile's database watched.

## 0.2.4 (2026-10-29)

### Fixed

- The plugin no longer opens a Browser tab of its own, ever. With no Browser tab in the side panel it used to open a hidden tab for the write and close it again, which made the panel flash while you worked in other tabs. It now waits: with no Browser tab open there is nothing to sync into, and the first sync happens when you open one and it has focus.

## 0.2.3 (2026-10-29)

### Fixed

- Periodic cookie syncs no longer make the side panel flicker, reset its other tabs, or switch away from them. Each sync used to open a new Browser tab: bb rebuilds the side panel's tab list when a native tab appears or disappears, remounting every panel tab, and it brings the new tab forward. Background syncs now run only while the Browser tab itself has focus, and they write through that tab instead of opening one. A hidden tab is opened only when no Browser tab is open at all, and it closes again immediately. When you return to the Browser, a pending change syncs at once.

## 0.2.2 (2026-10-29)

### Fixed

- Restored a Browser dropdown with named browser choices and an explicit System default option, instead of requiring a browser ID in a blank text field. The dropdown is the only browser-selection control.
- Existing blank default-browser selections keep following the system default, and explicit browser/profile selections are preserved. The existing choose RPC still accepts an empty browser value for compatibility.

## 0.2.1 (2026-10-29)

### Fixed

- Sign-in handoffs no longer restart when the temporary cookie-sync tab unmounts the Browser toolbar. Progress is kept per owning thread and tab, so an Okta verification page opens the real browser instead of repeatedly refreshing.
- Briefly hidden forms and loading documents no longer reset the handoff. A completed sign-in still finishes without opening an unnecessary browser tab.
- The original application URL survives toolbar remounts, so sign-in can return to the page that started it.
- A handoff stuck waiting to start its sync now times out and offers a retry instead of remaining on “Checking…” indefinitely.
- Sync now is disabled for browsers whose sessions cannot be synced, such as Safari.

### Changed

- Settings have one configuration form instead of a second browser/profile picker. Behavior controls appear first, followed by optional browser, profile and sign-in-site overrides. Existing keys, defaults and saved values are unchanged.
- The Connection section shows the resolved browser/profile, recent sync status and actionable errors. Session-access help is collapsed, and opening settings no longer makes a separate browser-discovery request.
