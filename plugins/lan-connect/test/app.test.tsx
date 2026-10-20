import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { LanStatusDto, rpcContract } from "../src/contract";

afterEach(() => {
  document.body.replaceChildren();
});

const pairing = { code: "ABCDEFGH", expiresAt: Date.now() + 300_000, url: "http://192.168.10.21:38890/__bb-lan/pair?code=ABCDEFGH", qrSvg: "<svg></svg>" };
const device = { id: "dev-1", name: "iPhone", createdAt: 1_700_000_000_000, lastSeenAt: 1_700_000_100_000 };
const listening: LanStatusDto = {
  enabled: true,
  listening: true,
  scheme: "http",
  port: 38890,
  urls: ["http://192.168.10.21:38890", "http://mac.local:38890"],
  error: null,
  devices: [device],
  pairing: null,
};

async function render(handlers: Partial<{ [M in keyof typeof rpcContract]: (input: never) => unknown }>) {
  const app = await loadPluginApp(() => import("../app"));
  const registration = app.settingsSections[0];
  if (registration === undefined) throw new Error("no settings section");
  return renderSlot<object, typeof rpcContract>(registration, {}, { pluginId: "lan-connect", rpc: handlers as never });
}

describe("plugin app", () => {
  it("registers the section on the plugin page and on Mobile settings", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.settingsSections.map(({ id, experimental_page }) => ({ id, experimental_page }))).toEqual([
      { id: "lan-connect", experimental_page: undefined },
      { id: "lan-connect-mobile", experimental_page: "mobile" },
    ]);
  });

  it("shows the URLs and paired devices", async () => {
    const slot = await render({ status: () => listening });
    expect(await screen.findByText("Listening for HTTP on port 38890.")).toBeTruthy();
    expect(within(slot.container).getByRole("link", { name: "http://192.168.10.21:38890" })).toBeTruthy();
    expect(within(slot.container).getByText("iPhone")).toBeTruthy();
    expect(within(slot.container).getByText(/unencrypted HTTP/)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("pairs a device and shows the code, link and QR code", async () => {
    let current: LanStatusDto = listening;
    const slot = await render({
      status: () => current,
      pair: () => {
        current = { ...listening, pairing };
        return pairing;
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Pair a device" }));
    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
    const qr = within(slot.container).getByRole("img", { name: "Pairing QR code" });
    expect(qr.getAttribute("src")).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent("<svg></svg>")}`);
    expect(within(slot.container).getByRole("link", { name: pairing.url })).toBeTruthy();
    expect(slot.inspection.rpcCalls.map((call) => call.method)).toContain("pair");
    slot.lifecycle.unmount();
  });

  it("revokes a device by id", async () => {
    let current: LanStatusDto = listening;
    const slot = await render({
      status: () => current,
      revoke: () => {
        current = { ...listening, devices: [] };
        return { removed: true };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Revoke iPhone" }));
    expect(await screen.findByText("No devices are paired.")).toBeTruthy();
    expect(slot.inspection.rpcCalls.find((call) => call.method === "revoke")?.input).toEqual({ deviceId: "dev-1" });
    slot.lifecycle.unmount();
  });

  it("turns LAN access on and refetches when the server signals a change", async () => {
    let current: LanStatusDto = { ...listening, enabled: false, listening: false, urls: [], devices: [] };
    const slot = await render({
      status: () => current,
      setEnabled: () => current,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Turn on LAN access" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "setEnabled")?.input).toEqual({ enabled: true }));
    current = listening;
    await slot.behavior.emitRealtime("lan-connect:status", null);
    expect(await screen.findByText("Listening for HTTP on port 38890.")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("shows a failed call's message", async () => {
    const slot = await render({
      status: () => listening,
      pair: () => {
        throw new Error("Port 38890 is already in use.");
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Pair a device" }));
    expect(await screen.findByText("Port 38890 is already in use.")).toBeTruthy();
    slot.lifecycle.unmount();
  });
});
