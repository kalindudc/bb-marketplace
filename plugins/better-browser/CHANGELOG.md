# Changelog

Notable changes to Better Browser, newest first. Releases are tagged `better-browser/vX.Y.Z` in this repository.

## 0.3.0 (2026-10-30)

### Added

- Access gateways. Some identity-aware proxies in front of internal apps check the browser or device itself, such as its version, whether it is managed or a device certificate, and turn bb's Browser away with a page that has no sign-in form, so the handoff never started. List those pages in the new `gatewayPages` setting. When a tab stops on one, the plugin copies your browser's cookies for the app the gateway returns to (named in its `rd`, `redirect_url`, `return_to`, `returnTo` or `return_url` parameter) and retries the app. If the gateway still turns bb away, a Continue button opens the app in your browser, and the bb tab returns to it once the new session arrives. The tab also follows when your browser signs in to the app some other way, and a gateway page that names no app to return to is left alone.

### Fixed

- During an access gateway's handoff, bb's cookies for the app now match your browser's exactly: a cookie bb holds there that your browser does not, such as a pending request id left by bb's own failed attempt, is removed. Without this, some gateways ignored the session copied from your browser and sent the tab back to the gateway.

### Security

- An access gateway's handoff opens your browser only after you press Continue, and only for the app the button named, even if the tab moves to another gateway before it opens, because the app's address comes from the page in the tab. It opens the app itself, not the gateway URL, because a gateway URL can carry bb's pending request, and letting another browser complete that request is what gateways treat as a stolen sign-in.

## 0.2.6 (2026-10-29)

### Fixed

- Any failed sync now forgets the cached bb window, not just a failed tab lease. After bb restarts or its browser window reconnects, the plugin used to keep retrying the old generation and reported "Desktop browser instance is unavailable or generation is stale" until it was reloaded; it now rediscovers the window on the next sync.

## 0.2.5 (2026-10-29)

### Fixed

- A read that could not decrypt every cookie no longer removes the ones it could not see, and no longer forgets their remembered hashes, so a temporary keyring failure cannot sign you out or strand a stale session in bb.
- A failed cookie write keeps the change pending for the next sync instead of dropping it, and a stale bb window is rediscovered rather than reused.
- A Browser tab that goes away stops counting as focused at once, so background syncs cannot lease a tab you are not looking at.
- Choosing a browser that is not installed is reported, naming it, instead of quietly syncing the system default instead.
- Firefox and Zen links open in the synced profile, including a profile moved to an absolute path, without forcing a second instance against a profile that is already open.
- Firefox cookie expiry is read correctly whether the profile stores seconds or milliseconds.
- The Linux key probe samples only ciphertexts a key can open, so unsupported portal-encrypted rows no longer make readable cookies look undecryptable.
- The cookie watch follows a changed last-used profile instead of keeping the previous profile's database watched.

### Security

- Cmd/Ctrl-click now opens the real browser only for a real user gesture. A page that dispatched its own click with the modifier set could previously open an arbitrary http(s) URL in the browser where you are signed in.
- The automatic sign-in handoff opens the sign-in page the tab is showing, not an address the page had planted before redirecting there. After sign-in the bb tab still reloads to the application on its own.

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

### Changed

- Settings have one configuration form instead of a second browser/profile picker. Behavior controls appear first, followed by optional browser, profile and sign-in-site overrides. Existing keys, defaults and saved values are unchanged.
- The Connection section shows the resolved browser/profile, recent sync status and actionable errors. Session-access help is collapsed, and opening settings no longer makes a separate browser-discovery request.

### Fixed

- Sign-in handoffs no longer restart when the temporary cookie-sync tab unmounts the Browser toolbar. Progress is kept per owning thread and tab, so an Okta verification page opens the real browser instead of repeatedly refreshing.
- Briefly hidden forms and loading documents no longer reset the handoff. A completed sign-in still finishes without opening an unnecessary browser tab.
- The original application URL survives toolbar remounts, so sign-in can return to the page that started it.
- A handoff stuck waiting to start its sync now times out and offers a retry instead of remaining on “Checking…” indefinitely.
- Sync now is disabled for browsers whose sessions cannot be synced, such as Safari.

## 0.2.0 (2026-10-28)

### Added

- Session sync on Linux. Each browser carries its Linux data directory, PATH binary and `.desktop` id, and the default browser comes from `xdg-settings`.
- Links open through the browser binary found on PATH with `--profile-directory`, falling back to `xdg-open`.

### Changed

- Chromium cookie keys are derived the Linux way, with PBKDF2 and one round, and every candidate key source is proved against real ciphertext before it is used: `secret-tool` under both `chrome_libsecret_os_crypt_password` schemas, `kwallet-query` in the `<Product> Keys` folder, then the basic store's `peanuts`. A wrong source never silently reads garbage.

### Compatibility

- Arc, Dia and Helium stay macOS-only, as do portal-encrypted (v12) cookies.

## 0.1.0 (2026-10-27)

### Added

- Live sessions from the browser you already use. Pick a browser and profile (Chrome, Chromium, Arc, Dia, Brave, Edge, Vivaldi, Opera, Helium, Firefox or Zen on macOS), or follow the system default, and the plugin watches that profile's cookie file and writes what changed into bb's Browser while the real browser stays open.
- Cookies are read from a private `VACUUM INTO` copy of the cookie database, and Chromium values are decrypted with the Keychain's "Safe Storage" key, so a session never needs a quit and a re-import.
- Only hashes of what was synced are kept, never values, so a cookie a site changed inside bb is never overwritten with an older copy.
- A sign-in handoff. A tab that stays on a visible sign-in form first gets the real browser's current session and a reload; if the form is still there the page opens in the real browser, and the bb tab reloads when the new session arrives. It can be automatic, a button, or off, and extra sign-in pages are a setting.
- Cmd+click (Ctrl+click off macOS) opens a link in the chosen browser and profile instead of a new bb tab.
- A sync button beside the address bar, a settings picker, and `bb better-browser status|browsers|sync|open`.
