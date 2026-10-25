import { PluginCliError, cliCommand, defineCli, type PluginCliRegistration } from "@get-bb/plugin-sdk";
import type { Controller, LanStatus } from "./controller";
import { formatCode } from "./devices";

const json = { type: "boolean", description: "Print machine-readable JSON." } as const;
const toJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const date = (at: number) => new Date(at).toLocaleString();

export function formatStatus(status: LanStatus): string {
  if (!status.enabled) return "LAN access is off. Turn it on with `bb lan on`.\n";
  if (!status.listening) return `LAN access is on, but LAN Connect is not listening: ${status.error ?? "starting"}\n`;
  const off = status.devices.filter((device) => !device.enabled).length;
  const lines = [
    `LAN access is on: listening for ${status.scheme.toUpperCase()} on port ${status.port}.`,
    "Open bb on a device on this network at:",
    ...status.urls.map((url) => `  ${url}`),
    `Paired devices: ${status.devices.length}${off > 0 ? ` (${off} turned off)` : ""}. Pair one with \`bb lan pair\`.`,
  ];
  if (status.scheme === "http") lines.push("Traffic is unencrypted HTTP; set the TLS certificate and key files to serve HTTPS.");
  return `${lines.join("\n")}\n`;
}

function notListening(status: LanStatus): PluginCliError {
  return new PluginCliError(status.error ?? "LAN Connect is not listening.", {
    code: "lan_not_listening",
    hint: "Fix the setting in Settings → LAN Connect or with `bb plugin config lan-connect set <key> <value>`.",
  });
}

function deviceNotFound(id: string): PluginCliError {
  return new PluginCliError(`No paired device has the id ${id}.`, { code: "device_not_found", hint: "Run `bb lan devices` to list device ids." });
}

export function createCli(deps: {
  controller: Controller;
  setEnabled(enabled: boolean): Promise<LanStatus>;
  qrText(url: string): Promise<string>;
}): PluginCliRegistration {
  const { controller } = deps;
  const deviceToggle = (enabled: boolean) =>
    cliCommand({
      summary: enabled
        ? "Turn LAN access back on for a paired device"
        : "Turn LAN access off for a paired device and close its open connection; it stays paired",
      positionals: [{ name: "device", description: "Device id from `bb lan devices`.", required: true }],
      options: { json },
      async run({ options, positionals }) {
        const device = controller.status().devices.find((entry) => entry.id === positionals.device);
        if (device === undefined || !(await controller.setDeviceEnabled(device.id, enabled))) throw deviceNotFound(positionals.device);
        if (options.json) return { exitCode: 0, stdout: toJson({ updated: true, device: { ...device, enabled } }) };
        const stdout = enabled
          ? `Turned LAN access on for ${device.name}.\n`
          : `Turned LAN access off for ${device.name}. It stays paired; turn it back on with \`bb lan enable ${device.id}\`.\n`;
        return { exitCode: 0, stdout };
      },
    });
  const toggle = (enabled: boolean) =>
    cliCommand({
      summary: enabled ? "Turn LAN access on and print the URLs" : "Turn LAN access off and close the port",
      options: { json },
      async run({ options }) {
        const status = await deps.setEnabled(enabled);
        if (enabled && !status.listening) throw notListening(status);
        return { exitCode: 0, stdout: options.json ? toJson(status) : formatStatus(status) };
      },
    });

  return defineCli({
    name: "lan",
    summary: "Open this bb to paired devices on the local network (LAN Connect)",
    commands: {
      status: cliCommand({
        summary: "Show whether LAN access is on, its URLs and how many devices are paired",
        options: { json },
        run({ options }) {
          const status = controller.status();
          return { exitCode: 0, stdout: options.json ? toJson(status) : formatStatus(status) };
        },
      }),
      on: toggle(true),
      off: toggle(false),
      pair: cliCommand({
        summary: "Make a one-time pairing code, link and QR code for a new device (expires in 5 minutes)",
        options: { json },
        async run({ options }) {
          const status = controller.status();
          if (!status.enabled) throw new PluginCliError("LAN access is off.", { code: "lan_off", hint: "Run `bb lan on` first." });
          if (!status.listening) throw notListening(status);
          const pairing = await controller.pair();
          if (options.json) return { exitCode: 0, stdout: toJson({ code: pairing.code, expiresAt: pairing.expiresAt, url: pairing.url }) };
          const stdout = [
            `Open this link on the device: ${pairing.url}`,
            `Or open ${status.urls[0] ?? ""}/__bb-lan/pair and enter the code ${formatCode(pairing.code)}.`,
            `The code works once and expires in 5 minutes (at ${new Date(pairing.expiresAt).toLocaleTimeString()}).`,
            "",
            await deps.qrText(pairing.url),
          ].join("\n");
          return { exitCode: 0, stdout };
        },
      }),
      devices: cliCommand({
        summary: "List paired devices with their ids, whether LAN access is on for them, pairing date and last use",
        options: { json },
        run({ options }) {
          const { devices } = controller.status();
          if (options.json) return { exitCode: 0, stdout: toJson(devices) };
          if (devices.length === 0) return { exitCode: 0, stdout: "No devices are paired. Pair one with `bb lan pair`.\n" };
          const rows = devices.map(
            (device) => `${device.id}  ${device.name}  ${device.enabled ? "on" : "off"}  paired ${date(device.createdAt)}  last seen ${date(device.lastSeenAt)}`,
          );
          return { exitCode: 0, stdout: `${rows.join("\n")}\n` };
        },
      }),
      enable: deviceToggle(true),
      disable: deviceToggle(false),
      revoke: cliCommand({
        summary: "Revoke a paired device and close its open connection",
        positionals: [{ name: "device", description: "Device id from `bb lan devices`.", required: true }],
        options: { json },
        async run({ options, positionals }) {
          const device = controller.status().devices.find((entry) => entry.id === positionals.device);
          if (device === undefined || !(await controller.revoke(device.id))) throw deviceNotFound(positionals.device);
          return { exitCode: 0, stdout: options.json ? toJson({ removed: true, device }) : `Revoked ${device.name}.\n` };
        },
      }),
    },
  });
}
