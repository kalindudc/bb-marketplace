Use this bb from your phone, tablet or another laptop on the same home network, in the device's browser. No bb account, no getbb.app and nothing to install on the device.

## What you get

- A "LAN access" switch. When it is on, bb answers on port 38890 on your local network, at its LAN IP address (such as `http://192.168.1.20:38890`), at any name you add yourself, and at the computer's Bonjour name (such as `http://macbook-pro.local:38890`).
- A settings section, on the plugin's page and on bb's Mobile settings page, that shows the URLs, pairs new devices with a QR code and lists paired devices with buttons to turn each one off and on, or revoke it.
- `bb lan status`, `on`, `off`, `pair`, `devices`, `enable`, `disable` and `revoke` in the terminal, so agents and scripts can do the same.
- The full bb app on the device: threads stream live, and terminals work.

## Pairing

Press "Pair a device" or run `bb lan pair`. You get a QR code, a link and an eight-character code. The link uses your first extra hostname, or the LAN IP address when you have none, because many phones cannot resolve `.local` names. Scan the code or open the link on the device and press "Pair this device". The code works once and expires after five minutes. The device then stays paired for 400 days, or until you revoke it.

To block a device for a while, turn it off in the device list or with `bb lan disable <id>`. It keeps its pairing and sees a "LAN access is off" page until you turn it back on, so you can switch a machine's access on and off without pairing it again. Turning a device off or revoking it closes its open connection at once. A device pairs once for each name it uses, so use one name per device.

## Names you can use

- The LAN IP addresses, listed in the status. Give the computer a fixed address in your router (a DHCP reservation): a device pairs per address, so a new address means pairing again.
- The computer's `.local` name, which Macs and most Linux machines announce on the network by themselves. Macs and iPhones resolve it; many Android phones and some Wi-Fi networks do not.
- Your own name, such as `bb.home.arpa`: add a DNS record for it in your router or Pi-hole that points at this computer, then add it under "Extra hostnames".
- On macOS you can set the port to 80 to drop the port from the URL.

## Security

- Only devices with private-network addresses are answered, and only for the names above. Tailscale addresses are refused.
- Devices that have not paired never reach bb. They see the pairing page.
- A paired device can do everything you can do in bb, including running commands in terminals. Pair only your own devices, and revoke one you lose.
- Requests that another website starts in a paired browser are refused, except plain links that open the app.
- Without HTTPS, traffic and the device cookie travel unencrypted, and browsers block voice input and clipboard access. To serve HTTPS, make a certificate (for example with mkcert, and install its root certificate on each device) and set the certificate and key file settings.

## Not included

- The native bb mobile app pairs only through getbb.app, so it cannot use LAN Connect. Use the phone's browser.
- Sharing agents' dev-server ports, and publishing extra `.local` names.
