// @vitest-environment node
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import lanConnect from "../server";

let upstream: http.Server;
let upstreamUrl: string;

beforeEach(async () => {
  upstream = http.createServer((_req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("bb"));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterEach(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "::", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...headers }, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function postForm(port: number, path: string, form: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", agent: false, headers: { host: `127.0.0.1:${port}`, "content-type": "application/x-www-form-urlencoded" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const errorCode = (stdout: string) => (JSON.parse(stdout) as { error: { code: string } }).error.code;

describe("LAN Connect plugin", () => {
  it("serves only after LAN access is turned on, pairs a device, revokes it and closes on stop", async () => {
    const port = await freePort();
    const { bb, harness } = createFakePluginHost({ pluginId: "lan-connect", loopbackBaseUrl: upstreamUrl, settings: { port } });
    await lanConnect(bb);
    const service = harness.behavior.runService("lan");

    await expect(get(port, "/")).rejects.toThrow();
    const off = await harness.behavior.runCli(["pair", "--json"]);
    expect(off.exitCode).toBe(1);
    expect(errorCode(off.stdout)).toBe("lan_off");

    const on = await harness.behavior.runCli(["on"]);
    expect(on.exitCode).toBe(0);
    expect(on.stdout).toContain(`:${port}`);
    const status = JSON.parse((await harness.behavior.runCli(["status", "--json"])).stdout) as { listening: boolean; urls: string[] };
    expect(status.listening).toBe(true);
    expect(status.urls.every((url) => url.endsWith(`:${port}`))).toBe(true);
    expect((await get(port, "/", { accept: "text/html" })).status).toBe(302);

    const pairing = (await harness.behavior.callRpc("pair", null)) as { code: string; url: string; qrSvg: string };
    expect(pairing.url).toContain(`/__bb-lan/pair?code=${pairing.code}`);
    const paired = await postForm(port, "/__bb-lan/pair", { code: pairing.code, name: "Phone" });
    expect(paired.status).toBe(303);
    const cookie = (paired.headers["set-cookie"]?.[0] ?? "").split(";", 1)[0] ?? "";
    expect(await get(port, "/api/v1/projects", { cookie })).toMatchObject({ status: 200, body: "bb" });

    const listed = JSON.parse((await harness.behavior.runCli(["devices", "--json"])).stdout) as Array<{ id: string; name: string }>;
    expect(listed.map((device) => device.name)).toEqual(["Phone"]);
    const revoked = await harness.behavior.runCli(["revoke", listed[0]?.id ?? ""]);
    expect(revoked).toMatchObject({ exitCode: 0, stdout: "Revoked Phone.\n" });
    expect((await get(port, "/api/v1/projects", { cookie })).status).toBe(401);
    const unknown = await harness.behavior.runCli(["revoke", "missing", "--json"]);
    expect(errorCode(unknown.stdout)).toBe("device_not_found");

    const stopped = await harness.behavior.runCli(["off"]);
    expect(stopped.stdout).toContain("LAN access is off");
    await expect(get(port, "/")).rejects.toThrow();
    await harness.behavior.runCli(["on"]);
    expect((await get(port, "/", { accept: "text/html" })).status).toBe(302);

    service.controller.abort();
    await service.done;
    await expect(get(port, "/")).rejects.toThrow();
  });

  it("validates the hostnames and port settings", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lan-connect", loopbackBaseUrl: upstreamUrl });
    await lanConnect(bb);
    await expect(harness.behavior.setSettings({ hostnames: "bb.home.arpa, bad_name!" })).rejects.toThrow();
    await expect(harness.behavior.setSettings({ port: 70000 })).rejects.toThrow();
    await harness.behavior.setSettings({ hostnames: "bb.home.arpa, lab.lan" });
  });

  it("reports a port that is already in use", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "::", resolve));
    const { port } = blocker.address() as AddressInfo;
    try {
      const { bb, harness } = createFakePluginHost({ pluginId: "lan-connect", loopbackBaseUrl: upstreamUrl, settings: { port, lanAccess: true } });
      await lanConnect(bb);
      const service = harness.behavior.runService("lan");
      const on = await harness.behavior.runCli(["on", "--json"]);
      expect(on.exitCode).toBe(1);
      expect(errorCode(on.stdout)).toBe("lan_not_listening");
      expect(on.stderr).toContain(`Port ${port} is already in use.`);
      service.controller.abort();
      await service.done;
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
