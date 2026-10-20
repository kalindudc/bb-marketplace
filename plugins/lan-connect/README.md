# LAN Connect

A bb plugin that serves this bb to paired devices on the local network, so a
phone or laptop can use it in a browser without bb connect or a bb account.
See [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md) for what users get.

## How it works

bb's server listens only on 127.0.0.1. When "LAN access" is on, the plugin
opens its own port inside bb's server process and forwards each request to
`bb.server.loopbackBaseUrl`, the same way bb connect's tunnel does.

- The listener is created, restarted and closed only inside the run loop of
  the `lan` background service (`src/controller.ts`). bb contains an uncaught
  error only inside a service's async context; anywhere else it exits the whole
  server. The CLI, RPC and settings changes therefore only record the wanted
  configuration and wake the loop.
- Every request and WebSocket upgrade passes the same checks, in this order
  (`src/proxy.ts`):
  1. The client has a private-network address (Tailscale is excluded), else 403.
  2. The Host is an IP literal, `localhost`, the Bonjour name or an extra
     hostname, else 421. This blocks DNS rebinding.
  3. `/__bb-lan/*` is the plugin's own pairing page.
  4. Anything bb would route under `/internal` is refused with 404, after
     resolving `..` and decoding `%` escapes the way bb does.
  5. A request that another site starts (`Sec-Fetch-Site` of `cross-site` or
     `same-site`) is refused with 403, except a document navigation outside
     `/api` and `/ws`.
  6. The device cookie is valid, else a redirect to the pairing page or 401.
- Forwarded requests get bb's loopback `Host`, and an `Origin` equal to the
  LAN origin is rewritten to bb's origin, so bb's own host and origin checks
  pass. Any other `Origin` passes through and bb refuses it. The plugin
  removes its own cookie and the `x-forwarded-*`, `x-bb-gate-*`,
  `x-bb-plugin-caller` and hop-by-hop headers.
- Why `/internal` is blocked: forwarded requests reach bb from 127.0.0.1,
  which unlocks bb's loopback-only routes, such as machine enrollment. bb's
  web app never calls them.
- URLs are listed as extra hostnames, then LAN IPv4 addresses, then the
  `.local` name, and the pairing link and QR code use the first one. Many
  Android phones and some Wi-Fi networks cannot resolve `.local` names, so
  without an extra hostname the link uses an IP address.
- Pairing codes are eight characters, live in memory only, work once, expire
  after five minutes and are used up after five wrong tries. Paired devices
  are stored in the plugin's kv as a SHA-256 hash of their token
  (`src/devices.ts`).

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `lanAccess` | `false` | Open the port. `bb lan on` and `off` set it. |
| `port` | `38890` | Port to listen on. macOS allows 80; Linux needs 1024 or more. |
| `hostnames` | `""` | Extra names, comma-separated, such as `bb.home.arpa`. |
| `tlsCertPath`, `tlsKeyPath` | `""` | PEM files; with both set, the port serves HTTPS and the cookie is `Secure`. |

## HTTPS with mkcert

```sh
mkcert -install
mkcert bb.home.arpa "$(scutil --get LocalHostName | tr A-Z a-z).local" 192.168.1.20
bb plugin config lan-connect set tlsCertPath "$PWD/bb.home.arpa+2.pem"
bb plugin config lan-connect set tlsKeyPath "$PWD/bb.home.arpa+2-key.pem"
```

Install mkcert's root certificate (`mkcert -CAROOT`) on each device, or the
browser will warn.

## A name in your router

Add a DNS record in your router, Pi-hole or other local DNS server that points
a name such as `bb.home.arpa` (`home.arpa` is reserved for home networks by
RFC 8375) at this computer's LAN IP, then add the name under "Extra
hostnames". Give the computer a fixed IP address in the router so the record
stays right.

## Develop

```sh
npm install --registry https://registry.npmjs.org
npm test && npm run typecheck && npm run build
bb plugin install ./plugins/lan-connect   # from the repository root, for a live check
```

Tests that open sockets run in Node (`// @vitest-environment node`) against a
real fake upstream on a random port.
