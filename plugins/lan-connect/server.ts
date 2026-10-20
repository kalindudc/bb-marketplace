import type { BbPluginApi } from "@get-bb/plugin-sdk";
import QRCode from "qrcode";
import { z } from "zod";
import { createCli } from "./src/cli";
import { STATUS_CHANNEL, rpcContract } from "./src/contract";
import { DEFAULT_PORT, configOf, createController } from "./src/controller";
import { createPairingDesk, loadDeviceStore } from "./src/devices";
import { HOSTNAME_PATTERN, parseHostnames } from "./src/net";

export default async function lanConnect(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    lanAccess: {
      type: "boolean",
      label: "LAN access",
      description: "Serve bb to paired devices on this computer's local network. Paired devices get full access to bb.",
      default: false,
    },
    port: {
      type: "number",
      label: "Port",
      description: "The port devices connect to. macOS lets bb use port 80, which gives URLs without a port; Linux needs a port above 1023.",
      default: DEFAULT_PORT,
      experimental_schema: z.number().int().min(1).max(65535),
    },
    hostnames: {
      type: "string",
      label: "Extra hostnames",
      description: "Other names that point at this computer, separated by commas, such as bb.home.arpa from your router's DNS. The .local name and IP addresses always work.",
      default: "",
      experimental_schema: z
        .string()
        .max(512, "Keep the list under 512 characters.")
        .refine((value) => parseHostnames(value).every((name) => HOSTNAME_PATTERN.test(name)), "Each entry must be a host name such as bb.home.arpa."),
    },
    tlsCertPath: {
      type: "string",
      label: "TLS certificate file",
      description: "Absolute path to a PEM certificate (for example from mkcert). With a key file too, the port serves HTTPS.",
      default: "",
    },
    tlsKeyPath: {
      type: "string",
      label: "TLS key file",
      description: "Absolute path to the PEM private key for the certificate.",
      default: "",
    },
  });

  const devices = await loadDeviceStore(bb.storage.kv, { onError: (message) => bb.log.error(message) });
  const controller = createController({
    devices,
    pairing: createPairingDesk(),
    upstream: () => bb.server.loopbackBaseUrl,
    publish: () => bb.realtime.publish(STATUS_CHANNEL, null),
    log: bb.log,
  });

  settings.onChange((next) => {
    void controller.apply(configOf(next));
  });

  const setEnabled = async (enabled: boolean) => {
    await settings.experimental_set({ lanAccess: enabled });
    await controller.apply(configOf(await settings.get()));
    return controller.status();
  };

  // The listener lives in this service's run loop, where bb contains its uncaught errors.
  bb.background.service("lan", {
    async start(signal) {
      await controller.run(configOf(await settings.get()), signal);
    },
  });

  bb.rpc.register(rpcContract, {
    status: () => controller.status(),
    setEnabled: ({ enabled }) => setEnabled(enabled),
    pair: () => controller.pair(),
    revoke: async ({ deviceId }) => ({ removed: await controller.revoke(deviceId) }),
  });

  bb.cli.register(createCli({ controller, setEnabled, qrText: (url) => QRCode.toString(url, { type: "utf8" }) }));
}
