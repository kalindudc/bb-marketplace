import { describe, expect, it, vi } from "vitest";
import {
  COOKIE_NAME,
  MAX_DEVICES,
  PAIRING_TTL_MS,
  createPairingDesk,
  deviceCookie,
  deviceNameFromUserAgent,
  formatCode,
  loadDeviceStore,
  normalizeCode,
  readCookie,
  withoutCookie,
  type KvLike,
} from "../src/devices";

function fakeKv(initial?: unknown): KvLike & { values: Map<string, unknown>; writes: number } {
  const values = new Map<string, unknown>(initial === undefined ? [] : [["devices", initial]]);
  const kv = {
    values,
    writes: 0,
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      kv.writes += 1;
      values.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
  return kv;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("pairing desk", () => {
  it("makes eight-character codes from the unambiguous alphabet", () => {
    const desk = createPairingDesk();
    for (let i = 0; i < 50; i += 1) expect(desk.start().code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
  });

  it("accepts the code once, in any spacing or case", () => {
    const desk = createPairingDesk();
    const { code } = desk.start();
    const typed = `${code.slice(0, 4).toLowerCase()} ${code.slice(4)}`;
    expect(desk.redeem(typed)).toBe("ok");
    expect(desk.redeem(code)).toBe("invalid");
    expect(desk.current()).toBeNull();
  });

  it("expires the code after five minutes", () => {
    let now = 1_000;
    const desk = createPairingDesk(() => now);
    const { code, expiresAt } = desk.start();
    expect(expiresAt).toBe(1_000 + PAIRING_TTL_MS);
    now = expiresAt + 1;
    expect(desk.current()).toBeNull();
    expect(desk.redeem(code)).toBe("invalid");
  });

  it("uses the code up after five wrong tries", () => {
    const desk = createPairingDesk();
    const { code } = desk.start();
    const wrong = code.startsWith("0") ? "11111111" : "00000000";
    for (let i = 0; i < 5; i += 1) expect(desk.redeem(wrong)).toBe("invalid");
    expect(desk.redeem(code)).toBe("invalid");
  });

  it("replaces the pending code when a new one starts, and cancels it", () => {
    const desk = createPairingDesk();
    const first = desk.start();
    const second = desk.start();
    if (first.code !== second.code) expect(desk.redeem(first.code)).toBe("invalid");
    expect(desk.current()?.code).toBe(second.code);
    desk.cancel();
    expect(desk.current()).toBeNull();
  });
});

describe("codes", () => {
  it("normalizes look-alike characters and formats with a dash", () => {
    expect(normalizeCode(" abcd-efgh ")).toBe("ABCDEFGH");
    expect(normalizeCode("o1il")).toBe("0111");
    expect(formatCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });
});

describe("device store", () => {
  it("adds a device whose cookie authenticates, and refuses a wrong token or id", async () => {
    const kv = fakeKv();
    const store = await loadDeviceStore(kv, { now: () => 5 });
    const { device, cookieValue } = await store.add("  iPhone  ");
    expect(device).toEqual({ id: expect.any(String), name: "iPhone", createdAt: 5, lastSeenAt: 5, enabled: true });
    expect(device).not.toHaveProperty("tokenHash");
    expect(store.authenticate(cookieValue)?.id).toBe(device.id);
    expect(store.authenticate(`${device.id}.wrong`)).toBeNull();
    expect(store.authenticate(`other.${cookieValue.split(".")[1]}`)).toBeNull();
    expect(store.authenticate(undefined)).toBeNull();
    expect(store.authenticate("no-dot")).toBeNull();
  });

  it("stores only a hash of the token and keeps devices across a reload", async () => {
    const kv = fakeKv();
    const store = await loadDeviceStore(kv);
    const { cookieValue } = await store.add("Mac");
    const token = cookieValue.split(".")[1] ?? "";
    expect(JSON.stringify(kv.values.get("devices"))).not.toContain(token);
    const reloaded = await loadDeviceStore(kv);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.authenticate(cookieValue)?.name).toBe("Mac");
  });

  it("revokes a device", async () => {
    const kv = fakeKv();
    const store = await loadDeviceStore(kv);
    const { device, cookieValue } = await store.add("Mac");
    expect(await store.revoke(device.id)).toBe(true);
    expect(await store.revoke(device.id)).toBe(false);
    expect(store.authenticate(cookieValue)).toBeNull();
    expect((await loadDeviceStore(kv)).list()).toEqual([]);
  });

  it("turns a device off and on again, keeping it paired across a reload", async () => {
    const kv = fakeKv();
    const store = await loadDeviceStore(kv);
    const { device, cookieValue } = await store.add("Mac");
    expect(await store.setEnabled(device.id, false)).toBe(true);
    expect(store.authenticate(cookieValue)).toMatchObject({ id: device.id, enabled: false });
    const reloaded = await loadDeviceStore(kv);
    expect(reloaded.list()).toEqual([{ ...device, enabled: false }]);
    expect(await reloaded.setEnabled(device.id, true)).toBe(true);
    expect(reloaded.authenticate(cookieValue)?.enabled).toBe(true);
    expect(await reloaded.setEnabled("missing", false)).toBe(false);
  });

  it("reads devices saved before devices could be turned off as on", async () => {
    const stored = { version: 1, devices: [{ id: "a", name: "Mac", tokenHash: "0".repeat(64), createdAt: 1, lastSeenAt: 2 }] };
    const store = await loadDeviceStore(fakeKv(stored));
    expect(store.list()).toEqual([{ id: "a", name: "Mac", createdAt: 1, lastSeenAt: 2, enabled: true }]);
  });

  it("starts with no devices and reports an error when the stored value is corrupt", async () => {
    const onError = vi.fn();
    const store = await loadDeviceStore(fakeKv({ version: 1, devices: [{ id: 1 }] }), { onError });
    expect(store.list()).toEqual([]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("refuses a device past the limit", async () => {
    const store = await loadDeviceStore(fakeKv());
    for (let i = 0; i < MAX_DEVICES; i += 1) await store.add(`Device ${i}`);
    await expect(store.add("one more")).rejects.toThrow("Revoke a device before pairing another; LAN Connect keeps at most 50.");
  });

  it("writes lastSeenAt at most once a minute", async () => {
    let now = 0;
    const kv = fakeKv();
    const store = await loadDeviceStore(kv, { now: () => now });
    const { device } = await store.add("Mac");
    const writes = kv.writes;
    now = 30_000;
    store.touch(device.id);
    await flush();
    expect(kv.writes).toBe(writes);
    now = 60_000;
    store.touch(device.id);
    await flush();
    expect(kv.writes).toBe(writes + 1);
    expect(store.list()[0]?.lastSeenAt).toBe(60_000);
  });
});

describe("cookies", () => {
  it("reads and strips one cookie", () => {
    const header = `a=1; ${COOKIE_NAME}=id.token; b=2`;
    expect(readCookie(header, COOKIE_NAME)).toBe("id.token");
    expect(readCookie("a=1", COOKIE_NAME)).toBeUndefined();
    expect(withoutCookie(header, COOKIE_NAME)).toBe("a=1; b=2");
    expect(withoutCookie(`${COOKIE_NAME}=x`, COOKIE_NAME)).toBeUndefined();
    expect(withoutCookie(undefined, COOKIE_NAME)).toBeUndefined();
  });

  it("marks the cookie Secure only under HTTPS", () => {
    expect(deviceCookie("v", false)).toBe(`${COOKIE_NAME}=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000`);
    expect(deviceCookie("v", true)).toBe(`${COOKIE_NAME}=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000; Secure`);
  });

  it("names a device from its user agent", () => {
    expect(deviceNameFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iPhone");
    expect(deviceNameFromUserAgent("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)")).toBe("iPad");
    expect(deviceNameFromUserAgent("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe("Android");
    expect(deviceNameFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("Mac");
    expect(deviceNameFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows");
    expect(deviceNameFromUserAgent("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Linux");
    expect(deviceNameFromUserAgent(undefined)).toBe("Device");
  });
});
