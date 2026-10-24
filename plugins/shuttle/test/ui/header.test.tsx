import { formatRoute } from "../../src/ui/route";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { app, callsTo, handlers, mount, pr, unmountAll, type Handlers } from "./helpers";

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toasts) }));

afterEach(() => {
  unmountAll();
  toasts.error.mockReset();
});

async function header(rpc: Partial<Handlers> = {}) {
  const loaded = await app();
  const panel = loaded.navPanels[0]!;
  expect(panel).toMatchObject({ id: "shuttle", title: "Shuttle", icon: "shuttle/shuttle", path: "shuttle" });
  return mount<PluginNavPanelProps>(panel.headerContent!, { subPath: "" }, handlers(rpc));
}

describe("Shuttle page header", () => {
  it("asks for a link to look up or track any PR", async () => {
    const slot = await header();
    expect(slot.getByRole("textbox", { name: "Look up a pull request" }).getAttribute("placeholder")).toBe("Look up or track any PR: paste a link");
  });

  it("looks up a pasted link and selects that PR on the page", async () => {
    const found = pr({ server: "delta", repo: "shop/world", number: 2261179 });
    const slot = await header({ lookup: () => ({ pr: found }) });
    const input = slot.getByRole("textbox", { name: "Look up a pull request" });
    fireEvent.change(input, { target: { value: "delta:shop/world#2261179" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "pr", key: found.key }) } },
    ]));
    expect(callsTo(slot, "lookup")).toEqual([{ query: "delta:shop/world#2261179" }]);
  });

  it("shows the server's message when nothing matches the look-up", async () => {
    const slot = await header({ lookup: () => { throw new Error("no server's link pattern matches that"); } });
    const input = slot.getByRole("textbox", { name: "Look up a pull request" });
    fireEvent.change(input, { target: { value: "nonsense" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("no server's link pattern matches that"));
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("syncs, and links to Shuttle's settings page", async () => {
    const slot = await header();
    fireEvent.click(slot.getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(callsTo(slot, "sync")).toEqual([{}]));
    expect(slot.getByRole("link", { name: "Shuttle settings" }).getAttribute("href")).toBe("/settings/plugins/shuttle");
  });
});
