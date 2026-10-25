import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const STATUS_CHANNEL = "lan-connect:status";

export const deviceSchema = z
  .object({ id: z.string(), name: z.string(), createdAt: z.number(), lastSeenAt: z.number(), enabled: z.boolean() })
  .strict();
export const devicesSchema = z.array(deviceSchema);
export const pairingSchema = z.object({ code: z.string(), expiresAt: z.number(), url: z.string(), qrSvg: z.string() }).strict();
export const statusSchema = z
  .object({
    enabled: z.boolean(),
    listening: z.boolean(),
    scheme: z.enum(["http", "https"]),
    port: z.number().int(),
    urls: z.array(z.string()),
    error: z.string().nullable(),
    devices: devicesSchema,
    pairing: pairingSchema.nullable(),
  })
  .strict();

export type LanStatusDto = z.infer<typeof statusSchema>;
export type PairingDto = z.infer<typeof pairingSchema>;
export type DeviceDto = z.infer<typeof deviceSchema>;

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: statusSchema },
  setEnabled: { input: z.object({ enabled: z.boolean() }).strict(), output: statusSchema },
  pair: { input: z.null(), output: pairingSchema },
  setDeviceEnabled: {
    input: z.object({ deviceId: z.string().min(1), enabled: z.boolean() }).strict(),
    output: z.object({ updated: z.boolean() }).strict(),
  },
  revoke: { input: z.object({ deviceId: z.string().min(1) }).strict(), output: z.object({ removed: z.boolean() }).strict() },
});
