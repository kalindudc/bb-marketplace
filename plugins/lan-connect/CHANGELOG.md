# Changelog

Notable changes to LAN Connect, newest first. Releases are tagged `lan-connect/vX.Y.Z` in this repository.

## 0.2.0 (2026-10-24)

### Added

- Each paired device has its own on/off switch, so a machine's access can be paused without pairing it again. The settings section lists a Turn off button beside Revoke, and `bb lan disable <id>` and `bb lan enable <id>` do the same from the terminal. A device that is turned off keeps its pairing and sees a "LAN access is off" page until you turn it back on.
- A turned-off device never reaches bb. A browser navigation gets the 403 page, other requests a 403 with the code `lan_device_off`, and a WebSocket upgrade a 403. Turning a device off closes its open connections, including a WebSocket handshake still in flight.
- `bb lan devices` now prints on or off for each device, and `bb lan status` counts the ones turned off, as in "Paired devices: 3 (1 turned off)".

### Compatibility

- Devices stored by 0.1.x have no `enabled` flag and read as on, so upgrading does not lock anyone out.
- A turned-off device cannot pair itself again with a new code while its cookie is off; turn it back on first.

## 0.1.1 (2026-10-21)

### Fixed

- The LAN Connect skill now reaches agents. bb reads each entry in a manifest's `bb.skills` as a folder that holds skill folders, and the plugin listed its one skill's own folder (`./skills/lan-connect`), so bb found no skill in it; the manifest now lists `./skills`.

## 0.1.0 (2026-10-20)

### Added

- LAN Connect serves this bb to paired devices on your home network, in the device's browser, with no bb account, no getbb.app and nothing to install on the device. With LAN access on, bb answers on port 38890 at its LAN IP address, at the computer's `.local` name and at any names you add.
- A settings section, on the plugin's page and on bb's Mobile settings page, that shows the URLs bb can be opened at, pairs a device with a QR code, link and eight-character code, and lists paired devices with a Revoke button.
- `bb lan status`, `bb lan on`, `bb lan off`, `bb lan pair`, `bb lan devices` and `bb lan revoke <id>`, each accepting `--json`, so agents and scripts can do what the settings section does. Failures carry the codes `lan_off`, `lan_not_listening` and `device_not_found`.
- Settings for `port` (38890 by default), `hostnames` (extra names such as `bb.home.arpa`, comma-separated) and `tlsCertPath` with `tlsKeyPath`: with both files set, the port serves HTTPS and the device cookie is `Secure`. The `lanAccess` setting is the on/off switch, and `bb lan on` and `bb lan off` set it.
- A pairing code works once, expires after five minutes and is used up after five wrong tries. A paired device stays paired for 400 days, bb keeps at most 50 of them, and revoking one closes its open connection at once.
- A `lan-connect` skill that tells agents the commands, the settings, and that a paired device can run commands on this computer.

### Security

- Only clients with private-network addresses are answered; Tailscale addresses are refused.
- The Host header must be an IP literal, `localhost`, the `.local` name or one of your extra hostnames, which blocks DNS rebinding.
- Anything bb would route under `/internal` is refused with 404, because forwarded requests reach bb from 127.0.0.1 and would otherwise unlock bb's loopback-only routes.
- A request another site starts is refused with 403, except a plain link that opens the app. Devices that have not paired reach the pairing page, not bb.

### Compatibility

- Requires bb 0.46 or later and plugin SDK 0.6.49 or later, as the manifest's `engines` states.
- The native bb mobile app pairs only through getbb.app, so it cannot use LAN Connect; use the phone's browser.
