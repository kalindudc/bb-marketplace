import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const COOKIE_NAME = "bb_lan_device";
export const PAIRING_TTL_MS = 300_000;
export const PAIRING_ATTEMPTS = 5;
export const MAX_DEVICES = 50;

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;
const TOUCH_INTERVAL_MS = 60_000;
const COOKIE_MAX_AGE_SECONDS = 34_560_000;
const KV_KEY = "devices";

const deviceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  tokenHash: z.string().length(64),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  enabled: z.boolean().default(true),
});
const storedSchema = z.object({ version: z.literal(1), devices: z.array(deviceSchema) });

export type Device = z.infer<typeof deviceSchema>;
export type PublicDevice = Omit<Device, "tokenHash">;

export interface KvLike {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export interface DeviceStore {
  list(): PublicDevice[];
  add(name: string): Promise<{ device: PublicDevice; cookieValue: string }>;
  authenticate(cookieValue: string | undefined): PublicDevice | null;
  touch(id: string): void;
  setEnabled(id: string, enabled: boolean): Promise<boolean>;
  revoke(id: string): Promise<boolean>;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const publicOf = ({ tokenHash: _, ...device }: Device): PublicDevice => ({ ...device });

export async function loadDeviceStore(
  kv: KvLike,
  options: { now?: () => number; onError?: (message: string) => void } = {},
): Promise<DeviceStore> {
  const now = options.now ?? Date.now;
  const onError = options.onError ?? (() => {});
  let devices: Device[] = [];
  const stored = await kv.get<unknown>(KV_KEY);
  if (stored !== undefined) {
    const parsed = storedSchema.safeParse(stored);
    // A corrupt list locks every device out rather than letting an unknown one in.
    if (parsed.success) devices = parsed.data.devices;
    else onError(`LAN Connect could not read its paired devices, so none are paired: ${parsed.error.message}`);
  }

  let writing: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    const snapshot = { version: 1, devices: devices.map((device) => ({ ...device })) };
    writing = writing
      .then(() => kv.set(KV_KEY, snapshot))
      .catch((error: unknown) => onError(`LAN Connect could not save its paired devices: ${String(error)}`));
    return writing;
  };

  return {
    list: () => devices.map(publicOf),
    async add(name) {
      if (devices.length >= MAX_DEVICES) throw new Error("Revoke a device before pairing another; LAN Connect keeps at most 50.");
      const token = randomBytes(32).toString("base64url");
      const at = now();
      const device: Device = { id: randomUUID(), name: name.trim().slice(0, 64) || "Device", tokenHash: hashToken(token), createdAt: at, lastSeenAt: at, enabled: true };
      devices = [...devices, device];
      await persist();
      return { device: publicOf(device), cookieValue: `${device.id}.${token}` };
    },
    authenticate(cookieValue) {
      if (cookieValue === undefined) return null;
      const dot = cookieValue.indexOf(".");
      if (dot <= 0) return null;
      const id = cookieValue.slice(0, dot);
      const device = devices.find((entry) => entry.id === id);
      if (device === undefined) return null;
      const given = Buffer.from(hashToken(cookieValue.slice(dot + 1)));
      const expected = Buffer.from(device.tokenHash);
      return given.length === expected.length && timingSafeEqual(given, expected) ? publicOf(device) : null;
    },
    touch(id) {
      const device = devices.find((entry) => entry.id === id);
      const at = now();
      if (device === undefined || at - device.lastSeenAt < TOUCH_INTERVAL_MS) return;
      device.lastSeenAt = at;
      void persist();
    },
    async setEnabled(id, enabled) {
      const device = devices.find((entry) => entry.id === id);
      if (device === undefined) return false;
      if (device.enabled !== enabled) {
        device.enabled = enabled;
        await persist();
      }
      return true;
    },
    async revoke(id) {
      const remaining = devices.filter((entry) => entry.id !== id);
      if (remaining.length === devices.length) return false;
      devices = remaining;
      await persist();
      return true;
    },
  };
}

export interface Pairing {
  code: string;
  expiresAt: number;
}

export interface PairingDesk {
  start(): Pairing;
  current(): Pairing | null;
  redeem(input: string): "ok" | "invalid";
  cancel(): void;
}

export function createPairingDesk(now: () => number = Date.now): PairingDesk {
  let pending: (Pairing & { failures: number }) | null = null;
  const live = () => {
    if (pending !== null && (pending.expiresAt <= now() || pending.failures >= PAIRING_ATTEMPTS)) pending = null;
    return pending;
  };
  return {
    start() {
      let code = "";
      for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      pending = { code, expiresAt: now() + PAIRING_TTL_MS, failures: 0 };
      return { code, expiresAt: pending.expiresAt };
    },
    current() {
      const current = live();
      return current === null ? null : { code: current.code, expiresAt: current.expiresAt };
    },
    redeem(input) {
      const current = live();
      if (current === null) return "invalid";
      const given = Buffer.from(normalizeCode(input));
      const expected = Buffer.from(current.code);
      if (given.length === expected.length && timingSafeEqual(given, expected)) {
        pending = null;
        return "ok";
      }
      current.failures += 1;
      return "invalid";
    },
    cancel() {
      pending = null;
    },
  };
}

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

export function withoutCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  const kept = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.split("=", 1)[0] !== name);
  return kept.length > 0 ? kept.join("; ") : undefined;
}

export function deviceCookie(value: string, secure: boolean): string {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

export function deviceNameFromUserAgent(userAgent: string | undefined): string {
  if (userAgent === undefined) return "Device";
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent)) return "iPad";
  if (/Android/.test(userAgent)) return "Android";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "Mac";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/Linux/.test(userAgent)) return "Linux";
  return "Device";
}
