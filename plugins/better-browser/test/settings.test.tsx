import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Status } from "../src/rpc";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const status = (overrides: Partial<Status> = {}): Status => ({
  supported: true, browser: { id: "chrome", name: "Google Chrome", syncable: true }, profile: "Default", syncing: false,
  lastSync: null, error: null, ...overrides,
});

async function section(next = status()) {
  const app = await loadPluginApp(() => import("../app"));
  const browsers = vi.fn(() => ({
    supported: true, defaultBrowserId: "chrome", chosen: { browser: "", profile: "" },
    browsers: [{ id: "chrome", name: "Google Chrome", engine: "chromium", installed: true, syncable: true, profiles: [{ directory: "Default", name: "Personal" }], lastUsedProfile: "Default" }],
  }));
  const slot = renderSlot(app.settingsSections[0]!, {}, {
    pluginId: "better-browser", rpc: { status: () => next, browsers, sync: () => next },
  });
  await waitFor(() => expect(within(slot.container).getByRole("button", { name: "Sync now" })).toBeTruthy());
  return { slot, view: within(slot.container), browsers, registration: app.settingsSections[0]! };
}

describe("connection settings section", () => {
  it("shows status without a second browser or profile editor", async () => {
    const { slot, view, browsers, registration } = await section();
    try {
      expect(registration.title).toBe("Connection");
      expect(view.queryAllByRole("radio")).toHaveLength(0);
      expect(view.queryAllByRole("combobox")).toHaveLength(0);
      expect(view.getByText(/Google Chrome/)).toBeTruthy();
      expect(view.getByText(/Default/)).toBeTruthy();
      expect(browsers).not.toHaveBeenCalled();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("keeps manual sync available in one compact control", async () => {
    const { slot, view } = await section();
    try {
      expect(view.getAllByRole("button")).toHaveLength(1);
      fireEvent.click(view.getByRole("button", { name: "Sync now" }));
      await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "sync", input: { mode: "full", reason: "manual" } }));
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("does not offer an unsupported Safari session sync", async () => {
    const { slot, view } = await section(status({ browser: { id: "safari", name: "Safari", syncable: false } }));
    try {
      expect((view.getByRole("button", { name: "Sync now" }) as HTMLButtonElement).disabled).toBe(true);
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("keeps access details collapsed and points profile errors to the main settings", async () => {
    const { slot, view } = await section(status({ error: { code: "noProfile", message: "Profile not found", at: Date.now() } }));
    try {
      expect(view.getByText(/profile override above/i)).toBeTruthy();
      const details = slot.container.querySelector("details");
      expect(details).not.toBeNull();
      expect(details!.open).toBe(false);
    } finally {
      slot.lifecycle.unmount();
    }
  });
});
