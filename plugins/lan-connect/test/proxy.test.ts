// @vitest-environment node
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COOKIE_NAME, createPairingDesk, loadDeviceStore, type DeviceStore, type KvLike, type PairingDesk } from "../src/devices";
import { createLanServer, routedPath, type LanServer } from "../src/proxy";

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
}

function memoryKv(): KvLike {
  const values = new Map<string, unknown>();
  return { get: async <T>(key: string) => values.get(key) as T | undefined, set: async (key, value) => void values.set(key, value) };
}

let upstream: http.Server;
let seen: Seen[];
let devices: DeviceStore;
let pairing: PairingDesk;
let lan: LanServer;
let allowClient: boolean;
let paired: number;
let host: string;
let upstreamSockets: Socket[];

beforeEach(async () => {
  seen = [];
  upstreamSockets = [];
  allowClient = true;
  paired = 0;
  upstream = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "upstream=1" }).end('{"ok":true}');
  });
  upstream.on("upgrade", (req, socket: Socket) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    upstreamSockets.push(socket);
    socket.on("error", () => {});
    socket.on("end", () => socket.end());
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (data) => socket.write(data));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  devices = await loadDeviceStore(memoryKv());
  pairing = createPairingDesk();
  lan = createLanServer({
    upstream: () => `http://127.0.0.1:${upstreamPort}`,
    allowedNames: () => new Set(["bb.test"]),
    devices,
    pairing,
    tls: null,
    isAllowedClient: () => allowClient,
    onPaired: () => {
      paired += 1;
    },
    log: { warn: () => {} },
  });
  await lan.listen(0);
  host = `bb.test:${lan.port}`;
});

afterEach(async () => {
  await lan.close();
  for (const socket of upstreamSockets) socket.destroy();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  upstream.closeAllConnections();
});

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: lan.port, path, method: options.method ?? "GET", headers: { host, ...options.headers }, agent: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

type UpgradeResult = { kind: "upgrade"; socket: Socket } | { kind: "response"; status: number };

function upgrade(headers: Record<string, string> = {}): Promise<UpgradeResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: lan.port,
      path: "/ws",
      agent: false,
      headers: { host, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers },
    });
    req.on("upgrade", (_res, socket: Socket) => resolve({ kind: "upgrade", socket }));
    req.on("response", (res) => {
      res.resume();
      resolve({ kind: "response", status: res.statusCode ?? 0 });
    });
    req.on("error", reject);
    req.end();
  });
}

const cookieFor = async () => `${COOKIE_NAME}=${(await devices.add("Test")).cookieValue}`;

describe("routedPath", () => {
  it("resolves dot segments and decodes escapes like bb, and refuses other forms", () => {
    expect(routedPath("/a/../internal/x")).toBe("/internal/x");
    expect(routedPath("/%69nternal/x")).toBe("/internal/x");
    expect(routedPath("/%E0%A4%A")).toBeNull();
    expect(routedPath("http://evil/x")).toBeNull();
    expect(routedPath("*")).toBeNull();
  });
});

describe("gate", () => {
  it("refuses clients outside the local network", async () => {
    allowClient = false;
    expect((await send("/")).status).toBe(403);
  });

  it("refuses unknown host names", async () => {
    expect((await send("/", { headers: { host: `evil.example:${lan.port}` } })).status).toBe(421);
  });

  it("sends an unpaired browser to the pair page and refuses other unpaired requests", async () => {
    const page = await send("/threads/x", { headers: { accept: "text/html,*/*" } });
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe("/__bb-lan/pair");
    const api = await send("/api/v1/projects");
    expect(api.status).toBe(401);
    expect(JSON.parse(api.body).code).toBe("lan_unpaired");
    expect(seen).toEqual([]);
  });

  it.each(["/internal/x", "/a/../internal/x", "/a/%2e%2e/internal/x", "/%69nternal/x", "//internal/x", "/INTERNAL/x"])(
    "never forwards %s",
    async (path) => {
      const cookie = await cookieFor();
      expect((await send(path, { headers: { cookie } })).status).toBe(404);
      expect(seen).toEqual([]);
    },
  );

  it("answers 400 for a path that cannot be decoded", async () => {
    expect((await send("/%E0%A4%A", { headers: { cookie: await cookieFor() } })).status).toBe(400);
  });

  it("refuses a cross-site API request but forwards a cross-site document navigation", async () => {
    const cookie = await cookieFor();
    const api = await send("/api/v1/projects", { headers: { cookie, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
    expect(api.status).toBe(403);
    const fetchFromSite = await send("/", { headers: { cookie, "sec-fetch-site": "same-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } });
    expect(fetchFromSite.status).toBe(403);
    const navigation = await send("/threads/x", { headers: { cookie, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
    expect(navigation.status).toBe(200);
    const sameOrigin = await send("/api/v1/projects", { headers: { cookie, "sec-fetch-site": "same-origin" } });
    expect(sameOrigin.status).toBe(200);
  });
});

describe("pair page", () => {
  it("serves the form with strict headers and the code from the link", async () => {
    const page = await send("/__bb-lan/pair?code=ABCD-EFGH", { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" } });
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["referrer-policy"]).toBe("same-origin");
    expect(page.body).toContain('value="ABCD-EFGH"');
    expect(page.body).toContain('value="iPhone"');
  });

  it("escapes what it echoes", async () => {
    const page = await send(`/__bb-lan/pair?code=${encodeURIComponent('"><script>')}`);
    expect(page.body).not.toContain("<script>");
  });

  it("pairs with a good code and sets an HttpOnly cookie that then reaches bb", async () => {
    const { code } = pairing.start();
    const reply = await send("/__bb-lan/pair", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: `http://${host}` },
      body: new URLSearchParams({ code, name: "Phone" }).toString(),
    });
    expect(reply.status).toBe(303);
    expect(reply.headers.location).toBe("/");
    const setCookie = reply.headers["set-cookie"]?.[0] ?? "";
    expect(setCookie).toMatch(/^bb_lan_device=[^;]+; Path=\/; HttpOnly; SameSite=Lax/);
    expect(setCookie).not.toContain("Secure");
    expect(paired).toBe(1);
    expect(devices.list().map((device) => device.name)).toEqual(["Phone"]);
    const cookie = setCookie.split(";", 1)[0] ?? "";
    expect((await send("/api/v1/projects", { headers: { cookie } })).status).toBe(200);
  });

  it("refuses a wrong code and a POST from another site", async () => {
    const { code } = pairing.start();
    const wrong = await send("/__bb-lan/pair", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "code=00000000",
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toContain("That code is wrong or has expired.");
    const foreign = await send("/__bb-lan/pair", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://evil.example" },
      body: new URLSearchParams({ code }).toString(),
    });
    expect(foreign.status).toBe(403);
    const opaque = await send("/__bb-lan/pair", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "null" },
      body: new URLSearchParams({ code }).toString(),
    });
    expect(opaque.status).toBe(403);
    expect(pairing.current()?.code).toBe(code);
  });
});

describe("forwarding", () => {
  it("rewrites Host and a matching Origin, passes a foreign Origin, strips its cookie and spoofable headers", async () => {
    const cookie = await cookieFor();
    const reply = await send("/api/v1/projects?x=1", {
      headers: {
        cookie: `theme=dark; ${cookie}`,
        origin: `http://${host}`,
        "x-forwarded-host": "spoof",
        "x-bb-gate-auth": "machine",
        "x-bb-plugin-caller": "spoof",
      },
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('{"ok":true}');
    expect(reply.headers["set-cookie"]).toEqual(["upstream=1"]);
    const [request] = seen;
    expect(request?.url).toBe("/api/v1/projects?x=1");
    expect(request?.headers.host).toBe(`127.0.0.1:${(upstream.address() as AddressInfo).port}`);
    expect(request?.headers.origin).toBe(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
    expect(request?.headers.cookie).toBe("theme=dark");
    expect(request?.headers["x-forwarded-host"]).toBeUndefined();
    expect(request?.headers["x-bb-gate-auth"]).toBeUndefined();
    expect(request?.headers["x-bb-plugin-caller"]).toBeUndefined();

    await send("/api/v1/projects", { headers: { cookie, origin: "http://evil.example" } });
    expect(seen[1]?.headers.origin).toBe("http://evil.example");
    expect(seen[1]?.headers.cookie).toBeUndefined();
  });

  it("forwards request bodies", async () => {
    const cookie = await cookieFor();
    let received = "";
    upstream.removeAllListeners("request");
    upstream.on("request", (req, res) => {
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (received += chunk));
      req.on("end", () => res.writeHead(201).end());
    });
    const reply = await send("/api/v1/threads", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: '{"a":1}' });
    expect(reply.status).toBe(201);
    expect(received).toBe('{"a":1}');
  });
});

describe("upgrades", () => {
  it("upgrades a paired device and relays bytes both ways", async () => {
    const result = await upgrade({ cookie: await cookieFor(), origin: `http://${host}` });
    expect(result.kind).toBe("upgrade");
    if (result.kind !== "upgrade") return;
    const echoed = new Promise<string>((resolve) => result.socket.once("data", (data: Buffer) => resolve(data.toString())));
    result.socket.write("ping");
    expect(await echoed).toBe("ping");
    expect(seen[0]?.headers.upgrade).toBe("websocket");
    expect(seen[0]?.headers.origin).toMatch(/^http:\/\/127\.0\.0\.1:/);
    result.socket.destroy();
  });

  it("refuses an unpaired upgrade", async () => {
    expect(await upgrade()).toEqual({ kind: "response", status: 401 });
    expect(seen).toEqual([]);
  });

  it("closes a device's live connection when it is dropped", async () => {
    const { device, cookieValue } = await devices.add("Phone");
    const result = await upgrade({ cookie: `${COOKIE_NAME}=${cookieValue}` });
    if (result.kind !== "upgrade") throw new Error("expected an upgrade");
    const closed = new Promise<void>((resolve) => result.socket.once("close", () => resolve()));
    result.socket.on("error", () => {});
    lan.dropDevice(device.id);
    await closed;
  });
});

describe("close", () => {
  it("stops accepting connections", async () => {
    await lan.close();
    await expect(send("/")).rejects.toThrow();
  });
});
