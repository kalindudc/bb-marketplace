// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { STYLE_ATTRIBUTE } from "../src/appearance";
import { mountGruveAppearance } from "../src/mount";

const GRUVE_THEME = ':root, .light { --canvas: #f4f1e8; --gruve-prompt: "❯"; }';
const OTHER_THEME = ":root, .light { --canvas: #ffffff; }";

function page(themeCss = GRUVE_THEME): Document {
  document.head.replaceChildren();
  document.body.replaceChildren();
  const theme = document.createElement("style");
  theme.id = "bb-app-theme";
  theme.textContent = themeCss;
  document.head.append(theme);
  return document;
}

const answers = (values: Record<string, unknown>) =>
  vi.fn(async () => new Response(JSON.stringify({ ok: true, schema: {}, values }), { status: 200 }));

const injected = () => document.querySelector<HTMLStyleElement>(`style[${STYLE_ATTRIBUTE}]`);

function mount(fetchImpl: typeof fetch): () => void {
  const controller = new AbortController();
  return mountGruveAppearance({ document, pluginId: "gruve", signal: controller.signal, fetch: fetchImpl });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe("mountGruveAppearance", () => {
  it("applies the stored settings straight after the theme's sheet", async () => {
    page();
    const fetchImpl = answers({ fontSize: 18, accent: "purple", prompt: "dollar" });
    const dispose = mount(fetchImpl);
    await vi.waitFor(() => expect(injected()).not.toBeNull());

    const style = injected()!;
    expect(style.textContent).toContain("font-size: 18px;");
    expect(style.textContent).toContain("--gruve-prompt: \"$\";");
    expect(style.previousElementSibling?.id).toBe("bb-app-theme");
    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/plugins/gruve/settings", expect.objectContaining({ credentials: "same-origin" }));

    dispose();
    expect(injected()).toBeNull();
  });

  it("leaves the window alone while another theme is in use", async () => {
    page(OTHER_THEME);
    const fetchImpl = answers({ fontSize: 18 });
    const dispose = mount(fetchImpl);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());

    expect(injected()).toBeNull();
    dispose();
  });

  it("takes the settings out when the theme changes away, and back when it returns", async () => {
    page();
    const dispose = mount(answers({ accent: "red" }));
    await vi.waitFor(() => expect(injected()).not.toBeNull());

    const theme = document.getElementById("bb-app-theme")!;
    theme.textContent = OTHER_THEME;
    await vi.waitFor(() => expect(injected()).toBeNull());

    theme.textContent = GRUVE_THEME;
    await vi.waitFor(() => expect(injected())?.not.toBeNull());

    dispose();
  });

  it("keeps the theme as it is when the settings cannot be read", async () => {
    page();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("no", { status: 500 }));
    const dispose = mount(fetchImpl);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());

    expect(injected()).toBeNull();
    expect(warn).toHaveBeenCalled();
    dispose();
  });

  it("re-reads the settings when the window regains focus", async () => {
    page();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, schema: {}, values: { fontSize: 18 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, schema: {}, values: { fontSize: 20 } }), { status: 200 }));
    const dispose = mount(fetchImpl);
    await vi.waitFor(() => expect(injected()?.textContent).toContain("font-size: 18px;"));

    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(injected()?.textContent).toContain("font-size: 20px;"));

    dispose();
  });

  it("stops reading once disposed", async () => {
    page();
    const fetchImpl = answers({ fontSize: 18 });
    const dispose = mount(fetchImpl);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    dispose();
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(injected()).toBeNull();
  });
});
