import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { interceptAppLinks } from "../src/app-links";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
const stop = vi.fn();
vi.mock("../src/app-links", async (original) => ({ ...(await original<typeof import("../src/app-links")>()), interceptAppLinks: vi.fn(() => stop) }));

type DesktopWindow = Window & { bbDesktop?: unknown };

afterEach(() => {
  delete (window as DesktopWindow).bbDesktop;
  vi.clearAllMocks();
});

async function overlay(settings: Record<string, boolean> = {}) {
  const app = await loadPluginApp(() => import("../app"));
  expect(app.appOverlays.map(({ id }) => id)).toEqual(["app-links"]);
  return renderSlot(app.appOverlays[0]!, {}, {
    pluginId: "better-browser",
    rpc: { openExternal: () => ({ ok: true, browser: "Google Chrome" }) },
    settings: { modifierClick: true, ...settings },
  });
}

describe("the app-wide Cmd+click overlay", () => {
  it("opens what the interceptor reports in the real browser, in the desktop app", async () => {
    (window as DesktopWindow).bbDesktop = {};
    const slot = await overlay();
    await waitFor(() => expect(interceptAppLinks).toHaveBeenCalledTimes(1));
    const [target, options] = vi.mocked(interceptAppLinks).mock.calls[0]!;
    expect(target).toBe(window);
    options.open("https://github.com/kalindudc/bb-marketplace");
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "openExternal", input: { url: "https://github.com/kalindudc/bb-marketplace" } }));
    slot.lifecycle.unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the setting is off", async () => {
    (window as DesktopWindow).bbDesktop = {};
    const slot = await overlay({ modifierClick: false });
    expect(interceptAppLinks).not.toHaveBeenCalled();
    slot.lifecycle.unmount();
  });

  it("does nothing outside the desktop app, where links would open on another computer", async () => {
    const slot = await overlay();
    expect(interceptAppLinks).not.toHaveBeenCalled();
    slot.lifecycle.unmount();
  });
});
