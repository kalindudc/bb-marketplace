// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import betterBrowser from "../server";
import { BROWSERS } from "../src/browsers";
import { DISTRIBUTION_DEFAULTS } from "../src/distribution";
import { readSettings } from "../src/ui/common";

function setup(settings: Record<string, string | boolean> = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "better-browser",
    settings,
    sdk: {
      hosts: { list: async () => [makeHostResponse({ id: "host_1", status: "connected" })] },
      experimental_desktopBrowsers: { listInstances: async () => ({ instances: [{ hostId: "host_1", instanceId: "instance_1", generation: "generation_1", label: "BB" }] }) },
    },
    experimental_callHostRpc: async ({ method }) => {
      if (method !== "browsers") throw new Error(`Unexpected host call: ${method}`);
      return {
        supported: true,
        defaultBrowserId: "chrome",
        browsers: [
          { id: "chrome", name: "Google Chrome", engine: "chromium", installed: true, syncable: true, profiles: [{ directory: "Default", name: "Personal" }], lastUsedProfile: "Default" },
          { id: "arc", name: "Arc", engine: "chromium", installed: true, syncable: true, profiles: [{ directory: "Profile 1", name: "Work" }], lastUsedProfile: "Profile 1" },
        ],
      };
    },
  });
  betterBrowser(bb);
  return harness;
}

describe("settings form", () => {
  it("offers named browser choices without a raw browser text field", async () => {
    const harness = setup();
    try {
      const fields = harness.inspection.registrations.settingsDescriptors;
      expect(Object.keys(fields)).toEqual(["browser", "sync", "signIn", "modifierClick", "profile", "signInPages", "gatewayPages"]);
      expect(fields.browser).toMatchObject({
        type: "select", default: "system", label: "Browser",
        options: ["system", ...BROWSERS.map((browser) => browser.id)],
        experimental_optionLabels: { system: "System default", chrome: "Google Chrome", arc: "Arc" },
      });
      expect(fields.profile.label).toBe("Profile override (optional)");
      expect(Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.default]))).toEqual({
        browser: "system", profile: "", sync: true, signIn: "automatic", signInPages: "", gatewayPages: DISTRIBUTION_DEFAULTS.gatewayPages, modifierClick: true,
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it.each(["", "system", "chrome", "arc"])("preserves browser choice %j and its profile", async (browser) => {
    const harness = setup({ browser, profile: "Profile 1" });
    try {
      const result = await harness.behavior.callRpc("browsers", null);
      expect(result).toMatchObject({ chosen: { browser: browser === "" || browser === "system" ? "" : browser, profile: "Profile 1" } });
      expect(await harness.behavior.callRpc("status", null)).toMatchObject({ browser: { id: browser === "arc" ? "arc" : "chrome" }, profile: "Profile 1" });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("changes the active browser through the dropdown setting and can return to system default", async () => {
    const harness = setup();
    try {
      await harness.behavior.setSettings({ browser: "arc" });
      expect(await harness.behavior.callRpc("status", null)).toMatchObject({ browser: { id: "arc" } });
      await harness.behavior.setSettings({ browser: "system" });
      expect(await harness.behavior.callRpc("status", null)).toMatchObject({ browser: { id: "chrome" } });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("accepts access gateway patterns and refuses lines that are not a host", async () => {
    const harness = setup();
    try {
      await harness.behavior.setSettings({ gatewayPages: "gateway.example.com/auth\n# a comment\n*.iap.example.test" });
      await expect(harness.behavior.setSettings({ gatewayPages: "not a host!" })).rejects.toThrow();
      // A marketplace's own default has to pass the same check, or the setting could never be saved unchanged.
      await harness.behavior.setSettings({ gatewayPages: DISTRIBUTION_DEFAULTS.gatewayPages });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("falls back to the distribution's gateway pages while the app has no setting values", () => {
    expect(readSettings(undefined).gatewayPages).toBe(DISTRIBUTION_DEFAULTS.gatewayPages);
    expect(readSettings({ gatewayPages: "gateway.example.com/auth" }).gatewayPages).toBe("gateway.example.com/auth");
  });

  it("rejects unknown browser IDs instead of treating them as commands", async () => {
    const harness = setup();
    try {
      await expect(harness.behavior.setSettings({ browser: "not-a-browser" })).rejects.toThrow();
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("keeps the existing choose RPC's empty browser value working", async () => {
    const harness = setup({ browser: "arc" });
    try {
      expect(await harness.behavior.callRpc("choose", { browserId: "", profile: "" })).toMatchObject({ browser: { id: "chrome" } });
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
