# Better Browser

A bb plugin that makes bb's Browser follow the browser you already use:

- **Live sessions.** Cookies from the profile you pick are copied into bb's
  Browser whenever that browser saves them, while it stays open. No more
  importing cookies in Settings and quitting your browser each time a session
  expires.
- **Sign-in handoff.** When a bb Browser tab stops on an Okta, Microsoft,
  Google, Auth0, OneLogin, Duo, Ping or GitHub sign-in form, the plugin pulls
  your browser's current session and reloads the tab. If the form is still
  there, the page opens in your browser, where passkeys, Touch ID, security
  keys and Okta Verify work, and the bb tab reloads once the new session
  arrives.
- **Cmd+click** (Ctrl+click off macOS) opens a link in your browser, in the
  same profile, instead of a new bb tab.
- A sync button beside the address bar, with the last sync or any problem in
  its tooltip.

## Install

```sh
bb marketplace add git:github.com/kalindudc/bb-marketplace@main
bb plugin install better-browser@kalindudc
```

Then open the plugin's page in Settings and pick a browser and profile, or
leave it on your default browser. The first sync from a Chromium browser shows
a macOS Keychain prompt for "<Browser> Safe Storage"; choose **Always Allow**.
On Linux the "Safe Storage" secret is read from the Secret Service or KWallet
without a prompt; if neither answers, the basic password store is tried.

## Settings

| Key | Default | What it does |
| --- | --- | --- |
| `browser` | empty | Browser id (`chrome`, `arc`, `brave`, `edge`, `vivaldi`, `opera`, `chromium`, `dia`, `helium`, `firefox`, `zen`, `safari`). Empty follows the system default browser. |
| `profile` | empty | Profile directory, such as `Default` or `Profile 1`. Empty uses the profile the browser used last. |
| `sync` | `true` | Copy sessions into bb's Browser. |
| `signIn` | `automatic` | `automatic` hands sign-in pages to your browser, `ask` shows a button, `off` leaves them alone. |
| `signInPages` | empty | More sign-in pages, one per line: `*.example.com`, `login.example.com` or `example.com/login`. |
| `modifierClick` | `true` | Cmd+click (Ctrl+click) opens links in your browser. |

## CLI

```sh
bb better-browser status      # browser, profile, last sync, last problem
bb better-browser browsers    # browsers and profiles on the machine running the bb app
bb better-browser sync [--full] [--thread <id>]
bb better-browser open <url>
```

## How it works

bb's Browser is an Electron view, and a plugin cannot change its engine,
permissions or the links it is allowed to open. That is why passkeys (Electron
cannot reach macOS passkeys) and Okta FastPass (it needs custom links and
local-network access the view refuses) fail inside it. The plugin works around
that rather than replacing the view:

| Part | Where it runs | What it does |
| --- | --- | --- |
| `host.ts` | The host daemon on the machine with the bb app | Finds browsers and profiles, reads a private copy of a profile's cookie database (`VACUUM INTO`, or a file copy when the browser holds an exclusive lock), decrypts Chromium values with the "Safe Storage" key, watches the cookie file, writes cookies over CDP, and opens links with `open -b` or the browser binary. |
| `server.ts` and `src/engine.ts` | The bb server | Decides when to sync, finds the desktop app's Browser, creates a hidden `about:blank` tab, takes a short control lease on it, hands the CDP endpoint to the host, then releases and closes the tab. |
| `app.tsx` and `src/ui/` | The bb app | The Browser toolbar control: heartbeats, the Cmd+click handler it installs in each page's isolated world, the sign-in handoff, and the settings picker. |

A sync writes cookies with `Network.setCookies` on the leased tab; every bb
Browser tab shares one cookie store, so they all see them. The host remembers
a hash of each cookie it synced (never the value), so later syncs write only
what changed in the real browser and remove a cookie the real browser dropped
only while bb still holds the copy the plugin wrote.

The real browser writes cookies to disk about every 30 seconds, so a new
session reaches bb within roughly that time plus a 1.5 second debounce. Syncs
happen only while a bb Browser tab has reported in within 90 seconds; a change
made while no tab was open syncs when the next tab opens.

The Cmd+click handler is a capture-phase click listener in the page's
isolated world. Each toolbar refresh keeps it on for six seconds, so it
lapses on its own when the plugin is disabled or the tab is hidden.

## Limits

- Session sync works on macOS and Linux. Safari opens links but does not sync.
- On Linux, cookie values are decrypted with the browser's "Safe Storage"
  secret: from the Secret Service (`secret-tool`, both `chrome_libsecret_os_crypt_password_v1` and `v2` schemas),
  then KWallet (`kwallet-query`, the "<Product> Keys" folder), then the basic
  password store. Each candidate is proved against real ciphertext, so the
  wrong source never silently reads garbage; cookies it cannot decrypt are
  reported as unreadable. Portal-encrypted values (Chromium's `v12`, used
  inside Flatpak sandboxes) are not supported yet.
- On Linux a link opens in the browser binary the plugin finds on `PATH` with
  `--profile-directory`, falling back to `xdg-open` when no binary is found.
- Partitioned (CHIPS) cookies are skipped, as bb's own import skips them.
- Cookies a browser binds to the device cannot be copied by anything.
- The sign-in handoff waits for a visible sign-in form, so the Okta dashboard
  and other non-sign-in pages on those hosts are left alone.

## Develop

```sh
npm install && npm test && npm run typecheck && bb plugin build
bb plugin install "path:$PWD" --yes
bb plugin reload better-browser   # after each build
```
