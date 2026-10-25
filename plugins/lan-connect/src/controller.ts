import { readFileSync } from "node:fs";
import QRCode from "qrcode";
import type { DeviceStore, PairingDesk, PublicDevice } from "./devices";
import { bonjourName as defaultBonjourName, lanUrls, parseHostnames } from "./net";
import { PAIR_PATH, createLanServer, type LanServer, type LanServerOptions } from "./proxy";

export interface LanConfig {
  lanAccess: boolean;
  port: number;
  hostnames: string[];
  tlsCertPath: string;
  tlsKeyPath: string;
}

export interface PairingView {
  code: string;
  expiresAt: number;
  url: string;
  qrSvg: string;
}

export interface LanStatus {
  enabled: boolean;
  listening: boolean;
  scheme: "http" | "https";
  port: number;
  urls: string[];
  error: string | null;
  devices: PublicDevice[];
  pairing: PairingView | null;
}

export interface Controller {
  run(config: LanConfig, signal: AbortSignal): Promise<void>;
  apply(config: LanConfig): Promise<void>;
  status(): LanStatus;
  pair(): Promise<PairingView>;
  setDeviceEnabled(deviceId: string, enabled: boolean): Promise<boolean>;
  revoke(deviceId: string): Promise<boolean>;
}

export const DEFAULT_PORT = 38890;

export function configOf(values: { lanAccess: boolean; port: number; hostnames: string; tlsCertPath: string; tlsKeyPath: string }): LanConfig {
  return {
    lanAccess: values.lanAccess,
    port: values.port,
    hostnames: parseHostnames(values.hostnames),
    tlsCertPath: values.tlsCertPath.trim(),
    tlsKeyPath: values.tlsKeyPath.trim(),
  };
}

const listenerKey = (config: LanConfig) => JSON.stringify([config.lanAccess, config.port, config.tlsCertPath, config.tlsKeyPath]);

function listenError(error: unknown, port: number): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") return `Port ${port} is already in use. Choose another port in Settings → LAN Connect.`;
  if (code === "EACCES") return `This computer does not let bb use port ${port}. Choose a port above 1023.`;
  return `LAN Connect could not listen on port ${port}: ${error instanceof Error ? error.message : String(error)}`;
}

export function createController(deps: {
  devices: DeviceStore;
  pairing: PairingDesk;
  upstream(): string;
  publish(): void;
  log: LanServerOptions["log"];
  readFile?: (path: string) => Buffer;
  createServer?: typeof createLanServer;
  bonjourName?: () => string;
  addresses?: () => string[];
}): Controller {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path));
  const createServer = deps.createServer ?? createLanServer;
  let bonjour: string | null = null;
  const bonjourName = () => (bonjour ??= (deps.bonjourName ?? defaultBonjourName)());

  let desired: LanConfig = { lanAccess: false, port: DEFAULT_PORT, hostnames: [], tlsCertPath: "", tlsKeyPath: "" };
  let server: LanServer | null = null;
  let scheme: "http" | "https" = "http";
  let appliedKey: string | null = null;
  let error: string | null = null;
  let pairingView: PairingView | null = null;

  // Every listener change runs in run()'s loop: bb contains uncaught errors only inside a service's async context.
  let running = false;
  let dirty = false;
  let wake: (() => void) | null = null;
  const waiters: Array<() => void> = [];
  const tasks: Array<() => void> = [];

  function schedule(task?: () => void): Promise<void> {
    if (!running) return Promise.resolve();
    if (task !== undefined) tasks.push(task);
    dirty = true;
    const done = new Promise<void>((resolve) => waiters.push(resolve));
    wake?.();
    return done;
  }

  async function closeServer() {
    const current = server;
    server = null;
    if (current !== null) await current.close();
  }

  async function reconcile() {
    const want = desired;
    const key = listenerKey(want);
    if (key === appliedKey && error === null) return;
    await closeServer();
    appliedKey = key;
    error = null;
    pairingView = null;
    deps.pairing.cancel();
    if (!want.lanAccess) return;

    const hasCert = want.tlsCertPath.length > 0;
    if (hasCert !== want.tlsKeyPath.length > 0) {
      error = "Set both the TLS certificate and key files, or neither.";
      return;
    }
    if (String(want.port) === new URL(deps.upstream()).port) {
      error = `Port ${want.port} is bb's own port. Choose another one.`;
      return;
    }
    let tls: { cert: Buffer; key: Buffer } | null = null;
    if (hasCert) {
      try {
        tls = { cert: readFile(want.tlsCertPath), key: readFile(want.tlsKeyPath) };
      } catch (readError) {
        const path = (readError as { path?: string }).path ?? want.tlsCertPath;
        error = `Cannot read ${path}: ${(readError as NodeJS.ErrnoException).code ?? String(readError)}.`;
        return;
      }
    }
    const next = createServer({
      upstream: deps.upstream,
      allowedNames: () => new Set(["localhost", bonjourName(), ...desired.hostnames]),
      devices: deps.devices,
      pairing: deps.pairing,
      tls,
      onPaired: () => {
        pairingView = null;
        deps.publish();
      },
      log: deps.log,
    });
    try {
      await next.listen(want.port);
      server = next;
      scheme = tls === null ? "http" : "https";
    } catch (listenFailure) {
      error = listenError(listenFailure, want.port);
      await next.close();
    }
  }

  function urls(): string[] {
    if (server === null) return [];
    return lanUrls({ scheme, port: server.port, hostnames: desired.hostnames, localName: bonjourName(), addresses: deps.addresses?.() });
  }

  return {
    async run(config, signal) {
      desired = config;
      running = true;
      const onAbort = () => wake?.();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        while (true) {
          dirty = false;
          const settled = waiters.splice(0);
          const queued = tasks.splice(0);
          await reconcile();
          for (const task of queued) task();
          deps.publish();
          for (const resolve of settled) resolve();
          if (signal.aborted) break;
          await new Promise<void>((resolve) => {
            if (dirty || signal.aborted) resolve();
            else wake = resolve;
          });
          wake = null;
        }
      } finally {
        running = false;
        signal.removeEventListener("abort", onAbort);
        await closeServer();
        appliedKey = null;
        pairingView = null;
        deps.publish();
        for (const resolve of waiters.splice(0)) resolve();
        tasks.length = 0;
      }
    },
    apply(config) {
      desired = config;
      return schedule();
    },
    status() {
      const pairing = pairingView !== null && deps.pairing.current()?.code === pairingView.code ? pairingView : null;
      return {
        enabled: desired.lanAccess,
        listening: server !== null,
        scheme,
        port: server?.port ?? desired.port,
        urls: urls(),
        error,
        devices: deps.devices.list(),
        pairing,
      };
    },
    async pair() {
      if (!desired.lanAccess) throw new Error("Turn on LAN access first: bb lan on");
      const first = urls()[0];
      if (server === null || first === undefined) throw new Error(error ?? "LAN Connect is not listening yet.");
      const { code, expiresAt } = deps.pairing.start();
      const url = `${first}${PAIR_PATH}?code=${code}`;
      pairingView = { code, expiresAt, url, qrSvg: await QRCode.toString(url, { type: "svg", margin: 1 }) };
      deps.publish();
      return pairingView;
    },
    async setDeviceEnabled(deviceId, enabled) {
      const found = await deps.devices.setEnabled(deviceId, enabled);
      if (!found) return false;
      if (!enabled) await schedule(() => server?.dropDevice(deviceId));
      deps.publish();
      return true;
    },
    async revoke(deviceId) {
      const removed = await deps.devices.revoke(deviceId);
      if (!removed) return false;
      await schedule(() => server?.dropDevice(deviceId));
      deps.publish();
      return true;
    },
  };
}
