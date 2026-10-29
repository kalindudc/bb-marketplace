// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import betterBrowser from "../server";

describe("settings form", () => {
  it("puts behavior first and optional overrides last without changing defaults", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "better-browser" });
    betterBrowser(bb);
    try {
      const fields = harness.inspection.registrations.settingsDescriptors;
      expect(Object.keys(fields)).toEqual(["sync", "signIn", "modifierClick", "browser", "profile", "signInPages"]);
      expect(fields.browser).toMatchObject({ type: "string", default: "", label: "Browser override (optional)" });
      expect(fields.profile.label).toBe("Profile override (optional)");
      expect(fields.signInPages.label).toBe("Additional sign-in sites (optional)");
      expect(Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.default]))).toEqual({
        browser: "", profile: "", sync: true, signIn: "automatic", signInPages: "", modifierClick: true,
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
