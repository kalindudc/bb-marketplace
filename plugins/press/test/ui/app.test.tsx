// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import app from "../../app";
import { PressPanel } from "../../src/ui/panel";

describe("Press app registrations", () => {
  it("registers the Press tab once and no settings section", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const loaded = await loadPluginApp(app);
    // The legacy threadPanelAction slot collects the same tab id, so registering both threw and logged (F36).
    expect(loaded.tabs).toEqual([expect.objectContaining({
      id: "press", title: "Press", icon: "press/press", context: { kind: "thread" }, availability: "action", layout: "flush", component: PressPanel,
    })]);
    expect(error).not.toHaveBeenCalled();
    // bb draws the declarative settings form itself; a read-only copy repeated it (F42).
    expect(loaded.settingsSections).toEqual([]);
    error.mockRestore();
  });

  it("keeps the chat line, the /compact banner, the context surfaces and the footer anchor", async () => {
    const loaded = await loadPluginApp(app);
    expect(loaded.messageMetadata.map((entry) => [entry.id, entry.placement])).toEqual([["boundary", "above"]]);
    expect(loaded.composerCustomizations).toEqual([expect.objectContaining({ id: "manual-compact", scopes: ["thread"] })]);
    expect(loaded.threadContextSegments.map((entry) => entry.id)).toEqual(["press"]);
    expect(loaded.threadContextCardRows.map((entry) => entry.id)).toEqual(["press"]);
    expect(loaded.threadHeaderActions.map((entry) => entry.id)).toEqual(["press-chip"]);
  });
});
