// @vitest-environment node
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { configOf, createController, type LanConfig } from "../src/controller";
import { createPairingDesk, loadDeviceStore, type KvLike } from "../src/devices";
import type { LanServer, LanServerOptions } from "../src/proxy";

const store = new AsyncLocalStorage<string>();

interface StubServer extends LanServer {
  options: LanServerOptions;
  createdIn: string | undefined;
  listenedOn: number | null;
  closed: boolean;
  dropped: Array<{ id: string; store: string | undefined }>;
}

function memoryKv(): KvLike {
  const values = new Map<string, unknown>();
  return { get: async <T>(key: string) => values.get(key) as T | undefined, set: async (key, value) => void values.set(key, value) };
}

const config = (overrides: Partial<LanConfig> = {}): LanConfig => ({
  lanAccess: false,
  port: 38890,
  hostnames: [],
  tlsCertPath: "",
  tlsKeyPath: "",
  ...overrides,
});

let runs: Array<{ abort: AbortController; done: Promise<void> }> = [];

afterEach(async () => {
  for (const run of runs) run.abort.abort();
  await Promise.all(runs.map((run) => run.done));
  runs = [];
});

async function setup(options: { listenError?: NodeJS.ErrnoException; readFile?: (path: string) => Buffer } = {}) {
  const servers: StubServer[] = [];
  const devices = await loadDeviceStore(memoryKv());
  let publishes = 0;
  const controller = createController({
    devices,
    pairing: createPairingDesk(),
    upstream: () => "http://127.0.0.1:38886",
    publish: () => {
      publishes += 1;
    },
    log: { warn: () => {} },
    bonjourName: () => "mac.local",
    addresses: () => ["192.168.10.21"],
    readFile: options.readFile ?? (() => Buffer.from("pem")),
    createServer: (serverOptions) => {
      const server: StubServer = {
        options: serverOptions,
        createdIn: store.getStore(),
        listenedOn: null,
        closed: false,
        dropped: [],
        get port() {
          return server.listenedOn ?? 0;
        },
        async listen(port) {
          if (options.listenError !== undefined) throw options.listenError;
          server.listenedOn = port;
        },
        async close() {
          server.closed = true;
        },
        dropDevice(id) {
          server.dropped.push({ id, store: store.getStore() });
        },
      };
      servers.push(server);
      return server;
    },
  });
  const start = (initial: LanConfig) => {
    const abort = new AbortController();
    const done = store.run("svc", () => controller.run(initial, abort.signal));
    runs.push({ abort, done });
    return { abort, done };
  };
  return { controller, servers, devices, start, publishes: () => publishes };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("configOf", () => {
  it("parses hostnames and trims TLS paths", () => {
    expect(configOf({ lanAccess: true, port: 80, hostnames: "BB.home.arpa, lab.lan", tlsCertPath: " /c ", tlsKeyPath: "" })).toEqual({
      lanAccess: true, port: 80, hostnames: ["bb.home.arpa", "lab.lan"], tlsCertPath: "/c", tlsKeyPath: "",
    });
  });
});

describe("controller", () => {
  it("stays off by default and records config before the loop runs", async () => {
    const { controller, servers } = await setup();
    await controller.apply(config({ lanAccess: true }));
    expect(servers).toEqual([]);
    expect(controller.status()).toMatchObject({ enabled: true, listening: false, urls: [] });
  });

  it("creates the listener inside the service context even when apply comes from outside it", async () => {
    const { controller, servers, start } = await setup();
    start(config());
    await settle();
    expect(servers).toEqual([]);
    await store.exit(() => controller.apply(config({ lanAccess: true, hostnames: ["bb.home.arpa"] })));
    expect(servers).toHaveLength(1);
    expect(servers[0]?.createdIn).toBe("svc");
    expect(servers[0]?.listenedOn).toBe(38890);
    expect(controller.status()).toMatchObject({ enabled: true, listening: true, scheme: "http", port: 38890, error: null });
    expect(controller.status().urls).toEqual(["http://bb.home.arpa:38890", "http://192.168.10.21:38890", "http://mac.local:38890"]);
    expect([...(servers[0]?.options.allowedNames() ?? [])]).toEqual(["localhost", "mac.local", "bb.home.arpa"]);
  });

  it("restarts for a port change but not for a hostname change", async () => {
    const { controller, servers, start } = await setup();
    start(config({ lanAccess: true }));
    await settle();
    await controller.apply(config({ lanAccess: true, hostnames: ["lab.lan"] }));
    expect(servers).toHaveLength(1);
    await controller.apply(config({ lanAccess: true, port: 38891 }));
    expect(servers).toHaveLength(2);
    expect(servers[0]?.closed).toBe(true);
    expect(servers[1]?.listenedOn).toBe(38891);
  });

  it("turns off and closes the port when aborted", async () => {
    const { controller, servers, start } = await setup();
    const run = start(config({ lanAccess: true }));
    await settle();
    await controller.apply(config({ lanAccess: false }));
    expect(servers[0]?.closed).toBe(true);
    expect(controller.status().listening).toBe(false);
    await controller.apply(config({ lanAccess: true }));
    run.abort.abort();
    await run.done;
    expect(servers[1]?.closed).toBe(true);
    await controller.apply(config({ lanAccess: true, port: 1 }));
    expect(servers).toHaveLength(2);
  });

  it("reports a port in use and retries on the next apply", async () => {
    const { controller, servers, start } = await setup({ listenError: Object.assign(new Error("in use"), { code: "EADDRINUSE" }) });
    start(config({ lanAccess: true }));
    await settle();
    expect(controller.status().error).toBe("Port 38890 is already in use. Choose another port in Settings → LAN Connect.");
    await controller.apply(config({ lanAccess: true }));
    expect(servers).toHaveLength(2);
  });

  it("refuses one TLS path, bb's own port and unreadable files", async () => {
    const { controller, start } = await setup({
      readFile: (path) => {
        throw Object.assign(new Error("missing"), { code: "ENOENT", path });
      },
    });
    start(config({ lanAccess: true, tlsCertPath: "/cert.pem" }));
    await settle();
    expect(controller.status().error).toBe("Set both the TLS certificate and key files, or neither.");
    await controller.apply(config({ lanAccess: true, port: 38886 }));
    expect(controller.status().error).toBe("Port 38886 is bb's own port. Choose another one.");
    await controller.apply(config({ lanAccess: true, tlsCertPath: "/cert.pem", tlsKeyPath: "/key.pem" }));
    expect(controller.status().error).toBe("Cannot read /cert.pem: ENOENT.");
  });

  it("serves https when both TLS files are readable", async () => {
    const { controller, servers, start } = await setup();
    start(config({ lanAccess: true, tlsCertPath: "/cert.pem", tlsKeyPath: "/key.pem" }));
    await settle();
    expect(servers[0]?.options.tls).toEqual({ cert: Buffer.from("pem"), key: Buffer.from("pem") });
    expect(controller.status().scheme).toBe("https");
    expect(controller.status().urls[0]).toBe("https://192.168.10.21:38890");
  });

  it("pairs only while listening, with a link and an SVG QR code", async () => {
    const { controller, start } = await setup();
    await expect(controller.pair()).rejects.toThrow("Turn on LAN access first: bb lan on");
    start(config({ lanAccess: true }));
    await settle();
    const view = await controller.pair();
    expect(view.url).toBe(`http://192.168.10.21:38890/__bb-lan/pair?code=${view.code}`);
    expect(view.qrSvg.startsWith("<svg")).toBe(true);
    expect(controller.status().pairing?.code).toBe(view.code);
  });

  it("drops a revoked device's connections inside the service context", async () => {
    const { controller, servers, devices, start } = await setup();
    start(config({ lanAccess: true }));
    await settle();
    const { device } = await devices.add("Phone");
    expect(await store.exit(() => controller.revoke(device.id))).toBe(true);
    expect(servers[0]?.dropped).toEqual([{ id: device.id, store: "svc" }]);
    expect(controller.status().devices).toEqual([]);
    expect(await controller.revoke(device.id)).toBe(false);
  });
});
