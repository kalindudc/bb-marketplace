import http from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import {
  COOKIE_NAME,
  deviceCookie,
  deviceNameFromUserAgent,
  readCookie,
  withoutCookie,
  type DeviceStore,
  type PairingDesk,
  type PublicDevice,
} from "./devices";
import { isAllowedHost, isLanAddress } from "./net";
import { PAIR_PAGE_HEADERS, pairPage } from "./pair-page";

export const PAIR_PATH = "/__bb-lan/pair";
const PLUGIN_PREFIX = "/__bb-lan/";
const MAX_FORM_BYTES = 4096;
const WRONG_CODE = "That code is wrong or has expired. Make a new one with `bb lan pair` or in Settings → LAN Connect.";

const DROPPED_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-connection", "te", "trailer", "upgrade", "forwarded", "x-real-ip", "x-bb-plugin-caller",
]);

export interface LanServerOptions {
  upstream(): string;
  allowedNames(): ReadonlySet<string>;
  devices: DeviceStore;
  pairing: PairingDesk;
  tls: { cert: Buffer; key: Buffer } | null;
  isAllowedClient?: (address: string | undefined) => boolean;
  onPaired(): void;
  log: { warn(message: string): void };
}

export interface LanServer {
  listen(port: number): Promise<void>;
  close(): Promise<void>;
  dropDevice(deviceId: string): void;
  readonly port: number;
}

type Gate =
  | { kind: "refuse"; status: number; message: string }
  | { kind: "plugin"; path: string }
  | { kind: "unpaired" }
  | { kind: "forward"; device: PublicDevice };

export function headersForUpstream(
  headers: http.IncomingHttpHeaders,
  args: { publicOrigin: string; upstream: URL; upgrade: boolean },
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (value === undefined || DROPPED_HEADERS.has(key) || key.startsWith("x-forwarded-") || key.startsWith("x-bb-gate-")) continue;
    if (key === "cookie") {
      const rest = withoutCookie(Array.isArray(value) ? value.join("; ") : value, COOKIE_NAME);
      if (rest !== undefined) out.cookie = rest;
    } else if (key === "origin") {
      // bb checks Origin against its own address, as bb connect's tunnel arranges; a foreign origin passes through and is refused.
      const origin = Array.isArray(value) ? value.join(", ") : value;
      out.origin = origin.toLowerCase() === args.publicOrigin.toLowerCase() ? args.upstream.origin : origin;
    } else {
      out[key] = value;
    }
  }
  out.host = args.upstream.host;
  if (args.upgrade) {
    out.connection = "Upgrade";
    out.upgrade = headers.upgrade ?? "websocket";
  }
  return out;
}

// The path bb itself will route: its adapter resolves dot segments with `new URL` and Hono then decodes `%` escapes.
export function routedPath(url: string | undefined): string | null {
  if (url === undefined || !url.startsWith("/")) return null;
  try {
    return decodeURI(new URL(`http://lan${url}`).pathname);
  } catch {
    return null;
  }
}

// Forwarded requests reach bb from 127.0.0.1, which would unlock bb's loopback-only /internal routes.
const isInternal = (path: string) => /^\/internal(?:\/|$)/.test(path.toLowerCase().replace(/\/{2,}/g, "/"));

// A Lax cookie still rides on cross-site top-level GETs, and bb checks Origin only when one is sent.
function isCrossSiteUse(req: http.IncomingMessage, path: string): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site === undefined || site === "same-origin" || site === "none") return false;
  const loadsAppShell =
    (req.method === "GET" || req.method === "HEAD") &&
    req.headers["sec-fetch-mode"] === "navigate" &&
    req.headers["sec-fetch-dest"] === "document" &&
    !/^\/(?:api|ws)(?:\/|$)/.test(path);
  return !loadsAppShell;
}

function upgradeRefusal(status: number): string {
  return `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
}

function readForm(req: http.IncomingMessage): Promise<URLSearchParams | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FORM_BYTES) {
        resolve(null);
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", () => resolve(null));
  });
}

export function createLanServer(options: LanServerOptions): LanServer {
  const scheme = options.tls === null ? "http" : "https";
  const isAllowedClient = options.isAllowedClient ?? isLanAddress;
  const agent = new http.Agent({ keepAlive: true });
  const sockets = new Set<Socket>();
  const upgraded = new Map<string, Set<Socket>>();

  const server = options.tls === null ? http.createServer() : https.createServer({ cert: options.tls.cert, key: options.tls.key });
  server.on("error", (error) => options.log.warn(`LAN Connect listener error: ${error.message}`));
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });

  const publicOrigin = (req: http.IncomingMessage) => `${scheme}://${req.headers.host ?? ""}`;
  const pairedDevice = (req: http.IncomingMessage) => options.devices.authenticate(readCookie(req.headers.cookie, COOKIE_NAME));

  function gate(req: http.IncomingMessage): Gate {
    if (!isAllowedClient(req.socket.remoteAddress)) return { kind: "refuse", status: 403, message: "This device is not on the local network." };
    if (!isAllowedHost(req.headers.host, options.allowedNames())) {
      return { kind: "refuse", status: 421, message: "LAN Connect does not serve this host name. Add it under Extra hostnames." };
    }
    const path = routedPath(req.url);
    if (path === null) return { kind: "refuse", status: 400, message: "Bad request path." };
    if (path.startsWith(PLUGIN_PREFIX)) return { kind: "plugin", path };
    if (isInternal(path)) return { kind: "refuse", status: 404, message: "Not found." };
    if (isCrossSiteUse(req, path)) return { kind: "refuse", status: 403, message: "LAN Connect refuses requests that another site starts." };
    const device = pairedDevice(req);
    return device === null ? { kind: "unpaired" } : { kind: "forward", device };
  }

  function sendPage(res: http.ServerResponse, status: number, html: string, extra: Record<string, string> = {}) {
    res.writeHead(status, { ...PAIR_PAGE_HEADERS, ...extra });
    res.end(html);
  }

  async function handlePluginPage(req: http.IncomingMessage, res: http.ServerResponse, path: string) {
    if (path !== PAIR_PATH) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found.");
      return;
    }
    const userAgentName = deviceNameFromUserAgent(req.headers["user-agent"]);
    if (req.method === "GET" || req.method === "HEAD") {
      const code = new URL(`http://lan${req.url ?? "/"}`).searchParams.get("code") ?? "";
      sendPage(res, 200, pairPage({ code: code.slice(0, 16), name: userAgentName, error: null, paired: pairedDevice(req) !== null }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "GET, HEAD, POST", "content-type": "text/plain; charset=utf-8" }).end("Method not allowed.");
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin.toLowerCase() !== publicOrigin(req).toLowerCase()) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("Pair from this page, not another site.");
      return;
    }
    const contentType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    const form = contentType === "application/x-www-form-urlencoded" ? await readForm(req) : null;
    if (form === null) {
      sendPage(res, 400, pairPage({ code: "", name: userAgentName, error: WRONG_CODE, paired: false }));
      return;
    }
    const code = form.get("code") ?? "";
    const name = (form.get("name") ?? "").trim() || userAgentName;
    if (options.pairing.redeem(code) !== "ok") {
      sendPage(res, 400, pairPage({ code: "", name, error: WRONG_CODE, paired: false }));
      return;
    }
    try {
      const { cookieValue } = await options.devices.add(name);
      options.onPaired();
      res.writeHead(303, { location: "/", "set-cookie": deviceCookie(cookieValue, scheme === "https"), "cache-control": "no-store" }).end();
    } catch (error) {
      sendPage(res, 400, pairPage({ code: "", name, error: error instanceof Error ? error.message : String(error), paired: false }));
    }
  }

  function forward(req: http.IncomingMessage, res: http.ServerResponse) {
    const upstream = new URL(options.upstream());
    const upstreamReq = http.request(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: headersForUpstream(req.headers, { publicOrigin: publicOrigin(req), upstream, upgrade: false }),
        agent,
      },
      (upstreamRes) => {
        const headers = { ...upstreamRes.headers };
        delete headers.connection;
        delete headers["keep-alive"];
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, headers);
        upstreamRes.on("error", () => res.destroy());
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on("error", () => {
      if (res.headersSent) res.destroy();
      else res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end("LAN Connect cannot reach bb.");
    });
    res.on("close", () => {
      if (!res.writableFinished) upstreamReq.destroy();
    });
    req.on("error", () => upstreamReq.destroy());
    req.pipe(upstreamReq);
  }

  server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.on("error", () => res.destroy());
    const result = gate(req);
    switch (result.kind) {
      case "refuse":
        res.writeHead(result.status, { "content-type": "text/plain; charset=utf-8" }).end(result.message);
        return;
      case "plugin":
        handlePluginPage(req, res, result.path).catch((error: unknown) => {
          options.log.warn(`LAN Connect pair page failed: ${String(error)}`);
          if (!res.headersSent) res.writeHead(500).end();
          else res.destroy();
        });
        return;
      case "unpaired":
        if ((req.method === "GET" || req.method === "HEAD") && (req.headers.accept ?? "").includes("text/html")) {
          res.writeHead(302, { location: PAIR_PATH, "cache-control": "no-store" }).end();
        } else {
          res.writeHead(401, { "content-type": "application/json" }).end(
            JSON.stringify({ code: "lan_unpaired", message: `Pair this device first at ${PAIR_PATH}.` }),
          );
        }
        return;
      case "forward":
        options.devices.touch(result.device.id);
        forward(req, res);
    }
  });

  server.on("upgrade", (req: http.IncomingMessage, socket: Socket, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const result = gate(req);
    if (result.kind !== "forward") {
      const status = result.kind === "refuse" ? result.status : result.kind === "unpaired" ? 401 : 404;
      socket.end(upgradeRefusal(status), () => socket.destroy());
      return;
    }
    const deviceId = result.device.id;
    options.devices.touch(deviceId);
    const upstream = new URL(options.upstream());
    const upstreamReq = http.request({
      hostname: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: req.url,
      headers: headersForUpstream(req.headers, { publicOrigin: publicOrigin(req), upstream, upgrade: true }),
    });
    upstreamReq.on("upgrade", (upstreamRes, upstreamSocket: Socket, upstreamHead: Buffer) => {
      upstreamSocket.on("error", () => upstreamSocket.destroy());
      if (socket.destroyed) {
        upstreamSocket.destroy();
        return;
      }
      const lines = [`HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? "Switching Protocols"}`];
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) lines.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      const open = upgraded.get(deviceId) ?? new Set<Socket>();
      upgraded.set(deviceId, open.add(socket));
      socket.on("close", () => {
        open.delete(socket);
        upstreamSocket.destroy();
      });
      upstreamSocket.on("close", () => socket.destroy());
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    upstreamReq.on("response", (upstreamRes) => {
      upstreamRes.resume();
      socket.end(upgradeRefusal(upstreamRes.statusCode ?? 502), () => socket.destroy());
    });
    upstreamReq.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (!upstreamReq.writableFinished || upstreamReq.socket === null) upstreamReq.destroy();
    });
    upstreamReq.end();
  });

  return {
    get port() {
      const address = server.address();
      return address !== null && typeof address === "object" ? (address as AddressInfo).port : 0;
    },
    listen(port) {
      const attempt = (host: string) =>
        new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => {
            server.off("listening", onListening);
            reject(error);
          };
          const onListening = () => {
            server.off("error", onError);
            resolve();
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen({ port, host });
        });
      // "::" also accepts IPv4 on macOS and Linux; a host without IPv6 falls back to IPv4 only.
      return attempt("::").catch((error: NodeJS.ErrnoException) =>
        error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL" ? attempt("0.0.0.0") : Promise.reject(error),
      );
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
        for (const open of upgraded.values()) for (const socket of open) socket.destroy();
        upgraded.clear();
        agent.destroy();
      });
    },
    dropDevice(deviceId) {
      for (const socket of upgraded.get(deviceId) ?? []) socket.destroy();
      upgraded.delete(deviceId);
    },
  };
}
