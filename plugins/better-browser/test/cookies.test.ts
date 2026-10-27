// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cookieKey, planSync, sourceChanged, toCdpParam, valueHash, type JarCookie, type SourceCookie, type SyncMemory } from "../src/cookies";

const NOW = 1_800_000_000;

function cookie(overrides: Partial<SourceCookie> = {}): SourceCookie {
  return { name: "sid", value: "one", host: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires: NOW + 3600, ...overrides };
}

function jar(...cookies: SourceCookie[]): JarCookie[] {
  return cookies.map((entry) => ({ name: entry.name, value: entry.value, domain: entry.host, path: entry.path }));
}

function memoryOf(...cookies: SourceCookie[]): SyncMemory {
  return planSync({ source: cookies, previous: null, jar: [], mode: "full", nowSeconds: NOW }).memory;
}

describe("planSync", () => {
  it("writes every live cookie bb lacks on the first sync of a profile", () => {
    const fresh = cookie();
    const expired = cookie({ name: "old", expires: NOW - 1 });
    const plan = planSync({ source: [fresh, expired], previous: null, jar: [], mode: "changes", nowSeconds: NOW });
    expect(plan.set).toEqual([fresh]);
    expect(plan.remove).toEqual([]);
    expect(Object.keys(plan.memory)).toEqual([cookieKey(fresh)]);
  });

  it("on a full sync, also writes an unchanged cookie bb lacks or holds with another value", () => {
    const held = cookie({ name: "held" });
    const lost = cookie({ name: "lost" });
    const stale = cookie({ name: "stale", value: "chrome" });
    const previous = memoryOf(held, lost, stale);
    const inBb = jar(held, { ...stale, value: "bb" });
    expect(planSync({ source: [held, lost, stale], previous, jar: inBb, mode: "full", nowSeconds: NOW }).set.map((entry) => entry.name)).toEqual(["lost", "stale"]);
    expect(planSync({ source: [held, lost, stale], previous, jar: inBb, mode: "changes", nowSeconds: NOW }).set).toEqual([]);
  });

  it("writes only what changed in the real browser since the last sync", () => {
    const unchanged = cookie({ name: "a" });
    const before = cookie({ name: "b", value: "old" });
    const after = cookie({ name: "b", value: "new" });
    const added = cookie({ name: "c" });
    const plan = planSync({ source: [unchanged, after, added], previous: memoryOf(unchanged, before), jar: jar(unchanged, before), mode: "changes", nowSeconds: NOW });
    expect(plan.set.map((entry) => entry.name)).toEqual(["b", "c"]);
  });

  it("never puts back a cookie that changed only inside bb", () => {
    const original = cookie({ value: "from-chrome" });
    const rotatedInBb = cookie({ value: "rotated-by-site" });
    const plan = planSync({ source: [original], previous: memoryOf(original), jar: jar(rotatedInBb), mode: "changes", nowSeconds: NOW });
    expect(plan.set).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("removes a cookie the real browser dropped while bb still holds the synced value", () => {
    const gone = cookie({ name: "session", host: "app.example.com" });
    const plan = planSync({ source: [], previous: memoryOf(gone), jar: jar(gone), mode: "changes", nowSeconds: NOW });
    expect(plan.remove).toEqual([{ name: "session", domain: "app.example.com", path: "/" }]);
  });

  it("keeps a dropped cookie when bb has its own newer value", () => {
    const gone = cookie();
    const plan = planSync({ source: [], previous: memoryOf(gone), jar: jar(cookie({ value: "bb-own" })), mode: "changes", nowSeconds: NOW });
    expect(plan.remove).toEqual([]);
  });

  it("treats a cookie that expired in the real browser as dropped", () => {
    const live = cookie();
    const plan = planSync({ source: [{ ...live, expires: NOW - 5 }], previous: memoryOf(live), jar: jar(live), mode: "changes", nowSeconds: NOW });
    expect(plan.remove).toHaveLength(1);
    expect(plan.memory).toEqual({});
  });

  it("ignores partitioned cookies in bb's jar", () => {
    const same = cookie();
    const partitioned: JarCookie = { ...jar(same)[0]!, partitionKey: { topLevelSite: "https://other.com", hasCrossSiteAncestor: true } };
    const plan = planSync({ source: [same], previous: null, jar: [partitioned], mode: "full", nowSeconds: NOW });
    expect(plan.set).toEqual([same]);
  });

  it("keeps hashes, not values, in its memory", () => {
    const secret = cookie({ value: "super-secret-token" });
    expect(JSON.stringify(memoryOf(secret))).not.toContain("super-secret-token");
    expect(memoryOf(secret)[cookieKey(secret)]?.v).toBe(valueHash("super-secret-token"));
  });
});

describe("sourceChanged", () => {
  it("is true with no memory, after a change and after a removal, and false otherwise", () => {
    const a = cookie({ name: "a" });
    const b = cookie({ name: "b" });
    expect(sourceChanged([a], null, NOW)).toBe(true);
    expect(sourceChanged([a, b], memoryOf(a, b), NOW)).toBe(false);
    expect(sourceChanged([a, { ...b, value: "two" }], memoryOf(a, b), NOW)).toBe(true);
    expect(sourceChanged([a], memoryOf(a, b), NOW)).toBe(true);
    expect(sourceChanged([a, { ...b, expires: NOW - 1 }], memoryOf(a), NOW)).toBe(false);
  });
});

describe("toCdpParam", () => {
  it("keeps a domain cookie's domain and gives a host-only cookie only a URL", () => {
    expect(toCdpParam(cookie())).toMatchObject({ domain: ".example.com", url: "https://example.com/" });
    const hostOnly = toCdpParam(cookie({ host: "app.example.com", path: "/api", secure: false, sameSite: undefined, expires: undefined }));
    expect(hostOnly).toEqual({ name: "sid", value: "one", url: "http://app.example.com/api", path: "/api", secure: false, httpOnly: true });
  });

  it("drops SameSite=None from an insecure cookie, which Chromium would refuse", () => {
    expect(toCdpParam(cookie({ secure: false, sameSite: "None" })).sameSite).toBeUndefined();
    expect(toCdpParam(cookie({ sameSite: "None" })).sameSite).toBe("None");
  });

  it("brackets an IPv6 host and keeps only a valid source port", () => {
    expect(toCdpParam(cookie({ host: "::1", sourcePort: 8443 })).url).toBe("https://[::1]/");
    expect(toCdpParam(cookie({ sourcePort: 8443 })).sourcePort).toBe(8443);
    expect(toCdpParam(cookie({ sourcePort: -1 })).sourcePort).toBeUndefined();
  });
});
