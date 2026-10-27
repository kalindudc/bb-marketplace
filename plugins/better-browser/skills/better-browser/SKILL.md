---
name: better-browser
description: Check or drive the Better Browser plugin, which keeps bb's Browser signed in with the user's real browser. `bb better-browser status` shows the browser and profile bb follows and the last session sync; `bb better-browser browsers` lists the browsers and profiles on the machine running the bb app; `bb better-browser sync` copies sessions into bb's Browser now; `bb better-browser open <url>` opens a link in the user's real browser. Use when a bb Browser page is signed out, stuck on a sign-in page, or the user asks about syncing cookies from Chrome, Arc, Brave, Edge, Vivaldi, Firefox or another browser.
---

# Better Browser

Better Browser copies cookies from the browser profile the user picked into bb's Browser while that browser stays open, hands sign-in pages to the real browser (where passkeys and Okta Verify work), and makes Cmd+click (Ctrl+click off macOS) open links in the real browser.

## Commands

    bb better-browser status [--json]          # browser, profile, last sync, last problem
    bb better-browser browsers [--json]        # installed browsers, their profiles, the default browser
    bb better-browser sync [--full] [--thread <id>] [--json]
    bb better-browser open <url>               # http or https only

- `sync` writes only the cookies that changed in the real browser since the last sync. `--full` also writes every cookie bb lacks or holds with another value; use it when a bb Browser page is signed out although the real browser is signed in.
- A sync borrows a hidden tab in a thread's Browser for a moment. Inside a thread it uses that thread; elsewhere pass `--thread`, or it uses the thread whose Browser tab reported in last. With neither, it fails with `noBrowserTab`.
- `sync` exits 1 when the sync failed. The problem codes are `keychainPending` (a Keychain prompt is waiting for the user), `keychainDenied` (the user refused it; run `sync` again and ask them to choose Always Allow), `keychainMissing`, `noProfile`, `notInstalled`, `unsupportedBrowser` (Safari only opens links), `unsupportedPlatform` (sync is macOS only), `noDesktop` (the bb desktop app is not open), `noBrowserTab`, `readFailed` and `writeFailed`.

## Settings

Change them on the plugin's page in Settings or with `bb plugin config better-browser set <key> <value>`:

- `browser`: a browser id from `bb better-browser browsers` (`chrome`, `arc`, `brave`, `edge`, …); empty follows the system default browser.
- `profile`: a profile directory such as `Default` or `Profile 1`; empty uses the profile the browser used last.
- `sync`: `true` or `false`.
- `signIn`: `automatic` (hand sign-in pages to the real browser), `ask` (show a button), or `off`.
- `signInPages`: extra sign-in pages, one per line: `*.example.com`, `login.example.com` or `example.com/login`.
- `modifierClick`: `true` or `false` for Cmd+click opening links in the real browser.

## Rules

- Never print cookie values. The plugin does not expose them, and nothing here needs them.
- Do not run `sync` in a loop to wait for a sign-in: the real browser writes cookies about every 30 seconds and the plugin syncs on its own when it does.
