// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, mountPluginContentScripts, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { STYLE_ATTRIBUTE } from "../src/appearance";

const GRUVE_THEME = ':root, .light { --canvas: #f4f1e8; --gruve-prompt: "❯"; }';

function page(themeCss = GRUVE_THEME): void {
  document.head.replaceChildren();
  document.body.replaceChildren();
  document.documentElement.className = "light";
  const theme = document.createElement("style");
  theme.id = "bb-app-theme";
  theme.textContent = themeCss;
  document.head.append(theme);
}

const injected = () => document.querySelector<HTMLStyleElement>(`style[${STYLE_ATTRIBUTE}]`);

const settings = (values: Record<string, string | number | boolean>) =>
  vi.fn(async () => ({ ok: true as const, schema: {}, values }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe("plugin app", () => {
  it("registers the content script that applies the settings and the section that previews them", async () => {
    const app = await loadPluginApp(() => import("../app"));

    expect(app.contentScripts.map((script) => script.id)).toEqual(["appearance"]);
    expect(app.settingsSections.map((section) => section.id)).toEqual(["appearance"]);
  });

  it("applies saved settings and previews them", async () => {
    page();
    const app = await loadPluginApp(() => import("../app"));
    const getSettings = settings({ accent: "purple", interfaceFont: "plex", fontSize: 18 });
    const slot = renderSlot(app.settingsSections[0]!, {}, { pluginId: "gruve", sdk: { plugins: { getSettings } } });

    await vi.waitFor(() => expect(injected()).not.toBeNull());
    expect(injected()!.textContent).toContain("--primary: #8f3f71;");
    expect(injected()!.textContent).toContain("font-size: 18px;");
    expect(slot.getByText("The quick brown fox jumps over the lazy dog.")).toBeTruthy();
    expect(slot.getByText("Accent")).toBeTruthy();
    expect(slot.queryByText(/Pick Gruve under Appearance/u)).toBeNull();
  });

  it("re-reads the settings when the server reports a change", async () => {
    page();
    const app = await loadPluginApp(() => import("../app"));
    const getSettings = settings({ accent: "purple" });
    const slot = renderSlot(app.settingsSections[0]!, {}, { pluginId: "gruve", sdk: { plugins: { getSettings } } });
    await vi.waitFor(() => expect(injected()?.textContent).toContain("--primary: #8f3f71;"));

    getSettings.mockResolvedValueOnce({ ok: true, schema: {}, values: { accent: "red" } });
    await slot.behavior.emitRealtime("appearance", {});
    await vi.waitFor(() => expect(injected()?.textContent).toContain("--primary: #9d0006;"));
  });

  it("says where to turn the theme on when another theme is in use", async () => {
    page(":root { --canvas: #ffffff; }");
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.settingsSections[0]!, {}, { pluginId: "gruve", sdk: { plugins: { getSettings: settings({}) } } });

    expect(slot.getByText(/Pick Gruve under Appearance/u)).toBeTruthy();
    await vi.waitFor(() => expect(injected()).toBeNull());
  });

  it("keeps the theme working when the settings cannot be read", async () => {
    page();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = await loadPluginApp(() => import("../app"));
    const getSettings = vi.fn(async () => {
      throw new Error("offline");
    });
    const slot = renderSlot(app.settingsSections[0]!, {}, { pluginId: "gruve", sdk: { plugins: { getSettings } } });

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(injected()).toBeNull();
    expect(slot.getByText("The quick brown fox jumps over the lazy dog.")).toBeTruthy();
  });

  // The content script repaints on every head change, including the settings
  // page's own write; that must not put the older values back.
  it("keeps a change made on the settings page when the content script repaints", async () => {
    page();
    const app = await loadPluginApp(() => import("../app"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, schema: {}, values: { accent: "green" } }), { status: 200 })),
    );
    const scripts = await mountPluginContentScripts(app, { pluginId: "gruve" });
    await vi.waitFor(() => expect(injected()?.textContent).toContain("--primary: #67620a;"));

    const getSettings = settings({ accent: "red" });
    const slot = renderSlot(app.settingsSections[0]!, {}, { pluginId: "gruve", sdk: { plugins: { getSettings } } });
    await vi.waitFor(() => expect(injected()?.textContent).toContain("--primary: #9d0006;"));
    expect(slot.getByText("Accent")).toBeTruthy();

    document.getElementById("bb-app-theme")!.textContent = `${GRUVE_THEME} `;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(injected()!.textContent).toContain("--primary: #9d0006;");

    await scripts.lifecycle.dispose();
  });
});
