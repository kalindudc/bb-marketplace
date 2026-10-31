Make bb's Browser follow the browser you already use, so you stop re-importing cookies and closing your browser every time a session expires.

## What you get

- **Sessions that keep up.** Pick a browser and profile once. Whenever that browser saves its cookies, the ones that changed are copied into bb's Browser while the browser stays open. Signing in or out in your browser carries over to bb within about 30 seconds, which is how often Chromium browsers write cookies to disk.
- **Sign-in finishes in your real browser.** When a bb Browser tab stops on an Okta, Microsoft, Google, Auth0, OneLogin, Duo, Ping or GitHub sign-in form, the plugin first copies your browser's current session and reloads the tab; that is enough when your browser is already signed in. If the form is still there, the page opens in your browser, where passkeys, Touch ID, security keys and Okta Verify work. bb reloads the tab once the new session arrives. Add your own sign-in pages in the settings, or switch the handoff to a button or off.
- **Access gateways too.** Some gateways in front of internal apps check the browser itself and turn bb's Browser away without a sign-in form. List their pages in the settings: bb then copies your browser's session for the app and retries it, and if the gateway still says no, a Continue button opens the app in your browser and brings the bb tab back once you are in.
- **Cmd+click opens links in your browser.** Cmd+click on macOS (Ctrl+click elsewhere) opens a link in the browser you picked, in the same profile, instead of a new bb tab.
- **A sync button.** Beside the address bar, a button syncs sessions now, with the last sync or any problem in its tooltip.
- **`bb better-browser`** prints the status, lists browsers and profiles, syncs, and opens a link, for you or an agent.

## Browsers

Sessions sync from Google Chrome, Chromium, Arc, Dia, Brave, Microsoft Edge, Vivaldi, Opera, Helium, Firefox and Zen on macOS, and from Google Chrome, Chromium, Brave, Microsoft Edge, Vivaldi, Opera, Firefox and Zen on Linux. Safari can open links, but its sessions do not sync yet.

## How it works

The plugin runs on the computer with the bb app. It reads a private copy of the profile's cookie database, so the browser can stay open, and decrypts Chromium cookies with the browser's "Safe Storage" key. On macOS the first sync shows a Keychain prompt; choose Always Allow. On Linux the secret comes from the Secret Service or KWallet, falling back to the basic password store, and cookies that none of those can decrypt are reported as unreadable. It writes cookies into bb's Browser through the Browser tab you already have open, leasing it for a moment. Background syncs wait while you are working in another panel tab such as a terminal or a diff, and catch up when you return to the Browser: opening a tab of its own would make bb rebuild the side panel and interrupt that work.

Only cookies that changed in your browser since the last sync are written. A cookie a site changed inside bb is never overwritten with an older copy, and a cookie your browser dropped is removed from bb only while bb still holds the copy the plugin wrote. Cookie values never leave your computer; the plugin stores only hashes of what it synced.

## Limits

- bb's Browser is still bb's own engine, so a page that needs a passkey or Okta Verify cannot use them inside bb; the handoff sends that step to your browser instead.
- Partitioned (CHIPS) cookies and cookies a browser binds to the device are not copied, like bb's own import.
- Session sync needs the bb desktop app, and a sync runs only while a bb Browser tab is open.
