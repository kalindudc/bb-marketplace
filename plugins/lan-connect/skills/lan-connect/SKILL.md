---
name: lan-connect
description: Check or manage LAN Connect, which serves this bb to paired devices on the local network. `bb lan status` shows whether LAN access is on and its URLs; `bb lan on` and `bb lan off` open and close the port; `bb lan pair` prints a one-time pairing link, code and QR code; `bb lan devices` lists paired devices; `bb lan disable <id>` and `bb lan enable <id>` turn one device's access off and on without unpairing it; `bb lan revoke <id>` removes one. Use only when the user asks about opening bb from another device on their network.
---

# LAN Connect

LAN Connect opens a port (38890 by default) on this computer's local network and forwards it to bb. A device must pair once before it can use bb; after that it has full access to bb, including terminals and files.

## Commands

    bb lan status          # on or off, listening scheme and port, the URLs to open, and how many devices are paired
    bb lan on              # turn LAN access on; fails with lan_not_listening and the reason if the port cannot open
    bb lan off             # turn LAN access off and close every connection
    bb lan pair            # a pairing link, an eight-character code and a terminal QR code; works once, for 5 minutes
    bb lan devices         # one line per paired device: id, name, on or off, pairing date, last use
    bb lan disable <id>    # turn LAN access off for one device and close its live connection; it stays paired
    bb lan enable <id>     # turn LAN access back on for a device that was turned off
    bb lan revoke <id>     # remove a device and close its live connection

Every command accepts `--json`. Failures carry a code: `lan_off` (run `bb lan on` first), `lan_not_listening` (the message says why, such as a port in use), or `device_not_found`.

## Rules for agents

- Never turn LAN access on, pair a device, turn a device on or off, or revoke one unless the user asks. A paired device can run commands on this computer.
- When the user wants to block a device for a while, use `bb lan disable`, not `revoke`: a turned-off device keeps its pairing and sees a "LAN access is off" page until `bb lan enable` turns it back on.
- When the user asks for a pairing code, run `bb lan pair` and give them the link and code. Codes expire after five minutes; make a new one if the user is too late.
- Settings live under Settings → Installed plugins → LAN Connect, or `bb plugin config lan-connect set <key> <value>`: `lanAccess`, `port`, `hostnames` (extra names such as `bb.home.arpa`, comma-separated), `tlsCertPath` and `tlsKeyPath` (both set to serve HTTPS).
- LAN Connect does not work with the native bb mobile app, which pairs only through getbb.app. Point phones at the URL in their browser.
