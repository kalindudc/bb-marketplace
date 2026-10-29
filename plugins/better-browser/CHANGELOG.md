# Changelog

Notable changes to Better Browser, newest first. Releases are tagged `better-browser/vX.Y.Z` in this repository.

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
