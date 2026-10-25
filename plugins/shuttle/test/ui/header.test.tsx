import { formatRoute } from "../../src/ui/route";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { createElement } from "react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { app, callsTo, handlers, mount, pr, unmountAll, type Handlers } from "./helpers";

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toasts) }));

afterEach(() => {
  unmountAll();
  toasts.error.mockReset();
});

async function header(rpc: Partial<Handlers> = {}, subPath = "") {
  const loaded = await app();
  const panel = loaded.navPanels[0]!;
  expect(panel).toMatchObject({ id: "shuttle", title: "Shuttle", icon: "shuttle/shuttle", path: "shuttle" });
  const slot = mount<PluginNavPanelProps>(panel.headerContent!, { subPath }, handlers(rpc));
  return Object.assign(slot, { route: (next: string) => slot.lifecycle.rerender(createElement(panel.headerContent!, { subPath: next })) });
}

const field = (slot: Awaited<ReturnType<typeof header>>) => slot.getByRole("textbox", { name: "Search pull requests" }) as HTMLInputElement;
const toSearch = (query: string, replace = false) => ({ method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "search", query, key: null }), ...(replace ? { replace: true } : {}) } });

describe("Shuttle page header", () => {
  it("offers to search PRs or look one up by its link", async () => {
    const slot = await header();
    expect(field(slot).getAttribute("placeholder")).toBe("Search PRs, or paste a link to look one up");
  });

  it("searches as you type, pushing the Search page once and refining it in place", async () => {
    const slot = await header();
    fireEvent.change(field(slot), { target: { value: "edge" } });
    await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([toSearch("edge")]));
    slot.route(formatRoute({ view: "search", query: "edge", key: null }));
    // The route it made itself leaves the typing alone.
    expect(field(slot).value).toBe("edge");
    fireEvent.change(field(slot), { target: { value: "edge retries" } });
    await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([toSearch("edge"), toSearch("edge retries", true)]));
    expect(callsTo(slot, "lookup")).toEqual([]);
  });

  it("searches at once on Enter, and Escape clears the words", async () => {
    const slot = await header({}, formatRoute({ view: "search", query: "old", key: null }));
    expect(field(slot).value).toBe("old");
    fireEvent.change(field(slot), { target: { value: "router" } });
    fireEvent.keyDown(field(slot), { key: "Enter" });
    expect(slot.inspection.navigateCalls).toEqual([toSearch("router", true)]);
    fireEvent.keyDown(field(slot), { key: "Escape" });
    expect(field(slot).value).toBe("");
    await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([toSearch("router", true), toSearch("", true)]));
  });

  it("follows the page: another area clears it, a search link fills it", async () => {
    const slot = await header({}, formatRoute({ view: "search", query: "edge cache", key: null }));
    expect(field(slot).value).toBe("edge cache");
    slot.route("mine");
    expect(field(slot).value).toBe("");
    slot.route(formatRoute({ view: "search", query: "nginx", key: null }));
    expect(field(slot).value).toBe("nginx");
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("does not search a pasted link: Enter looks it up", async () => {
    const slot = await header({ lookup: () => ({ pr: pr() }) });
    fireEvent.change(field(slot), { target: { value: "https://github.com/get-bb/bb/pull/4411" } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(slot.inspection.navigateCalls).toEqual([]);
    fireEvent.keyDown(field(slot), { key: "Enter" });
    await waitFor(() => expect(callsTo(slot, "lookup")).toEqual([{ query: "https://github.com/get-bb/bb/pull/4411" }]));
  });

  it("looks up a pasted key and selects that PR on the page", async () => {
    const found = pr({ server: "delta", repo: "shop/world", number: 2261179 });
    const slot = await header({ lookup: () => ({ pr: found }) });
    const input = field(slot);
    fireEvent.change(input, { target: { value: "delta:shop/world#2261179" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "pr", key: found.key }) } },
    ]));
    expect(callsTo(slot, "lookup")).toEqual([{ query: "delta:shop/world#2261179" }]);
  });

  it("shows the server's message when no server's link pattern matches", async () => {
    const slot = await header({ lookup: () => { throw new Error("no server's link pattern matches that"); } });
    const input = field(slot);
    fireEvent.change(input, { target: { value: "https://example.com/nope" } });
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
