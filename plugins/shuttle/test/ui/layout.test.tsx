import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { Label } from "../../src/contract";
import { formatRoute } from "../../src/ui/route";
import { app, callsTo, handlers, mount, pr, setViewport, unmountAll, type Handlers } from "./helpers";

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

const first = pr({ labels: [{ name: "bug", color: "d73a4a" }] });
const second = pr({ repo: "Shopify/spy-v2", number: 88, title: "Add per-route sampling to the tracer", author: "mia-r" });
const selected = (key: string) => formatRoute({ view: "section", section: "requested", key });

async function page(subPath: string, rpc: Partial<Handlers> = {}) {
  const loaded = await app();
  const panel = loaded.navPanels[0]!;
  const slot = mount<PluginNavPanelProps>(panel.component, { subPath }, handlers({
    list: () => ({ prs: [first, second] }),
    detail: ({ key }) => ({ pr: [first, second].find((item) => item.key === key)!, events: [], body: "" }),
    ...rpc,
  }));
  /** What bb's router does after a navigation: the same page, with the new subPath. */
  const route = (next: string) => slot.lifecycle.rerender(<panel.component subPath={next} />);
  return { slot, route };
}

const lastNavigation = (slot: Awaited<ReturnType<typeof page>>["slot"]) => slot.inspection.navigateCalls.at(-1);

describe("on a phone", () => {
  it("lists the sections as chips and rows that open the PR", async () => {
    setViewport(390);
    const { slot } = await page("requested");
    await slot.findByText(second.title);
    const chips = slot.getByRole("navigation", { name: "Sections" });
    expect(within(chips).getByRole("button", { name: /Requested of me/u }).getAttribute("aria-current")).toBe("page");
    expect(within(chips).getByRole("button", { name: /In flight/u }).textContent).toContain("3");
    const row = slot.container.querySelector<HTMLElement>(`[data-pr="${first.key}"]`)!;
    expect(row.querySelector("[data-icon='ChevronRight']")).not.toBeNull();
    expect(row.querySelector("[data-label='bug']")).not.toBeNull();
    expect(within(row).queryByRole("button", { name: /Open on/u })).toBeNull();
    fireEvent.click(within(row).getByRole("button"));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: selected(first.key) } });
  });

  it("shows only the PR view, with back, watch and more at the top and its actions at the bottom", async () => {
    setViewport(390);
    const { slot } = await page(selected(second.key));
    const view = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-phone-pr]") ?? Promise.reject(new Error("no PR view")));
    await waitFor(() => expect(view.querySelector(`[data-detail="${second.key}"]`)).not.toBeNull());
    expect(slot.container.querySelector("ul[aria-label='Pull requests']")).toBeNull();
    expect(slot.queryByRole("navigation", { name: "Sections" })).toBeNull();
    expect(within(view).getByRole("button", { name: "Back to Requested of me" })).toBeTruthy();
    expect(within(view).getByRole("button", { name: "Watch" })).toBeTruthy();
    expect(within(view).getByRole("button", { name: "More actions" })).toBeTruthy();
    expect(within(view).getByRole("button", { name: "Review" })).toBeTruthy();
    expect(within(view).queryByRole("button", { name: "Close details" })).toBeNull();
    expect(within(view).queryByRole("button", { name: /Open on GitHub/u })).toBeNull();
    fireEvent.click(within(view).getByRole("button", { name: "Open" }));
    expect(lastNavigation(slot)).toEqual({ method: "openUrl", url: second.url });
  });

  it("opens the presets and the More menu as bottom sheets", async () => {
    setViewport(390);
    const { slot } = await page(selected(second.key), { review: () => ({ threadId: "thr_review" }) });
    const review = await slot.findByRole("button", { name: "Review" });
    fireEvent.click(review);
    const sheet = await screen.findByRole("dialog", { name: "Start a review" });
    expect(within(sheet).getByRole("button", { name: "Done" })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("menuitem", { name: /Quick skim/u }));
    await waitFor(() => expect(callsTo(slot, "review")).toEqual([{ key: second.key, presetId: "quick" }]));
    expect(screen.queryByRole("dialog", { name: "Start a review" })).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: "More actions" }));
    const more = await screen.findByRole("dialog", { name: "More" });
    expect(within(more).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open on GitHub", "Copy link", "Link to a thread"]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "More" })).toBeNull();
  });

  it("goes back in history to the list it came from", async () => {
    setViewport(390);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const { slot, route } = await page("requested");
    fireEvent.click(within((await waitFor(() => slot.container.querySelector<HTMLElement>(`[data-pr="${first.key}"]`) ?? Promise.reject(new Error("no row"))))).getByRole("button"));
    route(selected(first.key));
    fireEvent.click(await slot.findByRole("button", { name: "Back to Requested of me" }));
    expect(back).toHaveBeenCalledTimes(1);
    expect(slot.inspection.navigateCalls).toHaveLength(1);
  });
});

describe("history", () => {
  it("pushes when a PR opens from the list, replaces when another is picked, and goes back when it closes", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const { slot, route } = await page("requested");
    await slot.findByText(second.title);
    fireEvent.click(slot.container.querySelector<HTMLElement>(`[data-pr="${first.key}"]`)!);
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: selected(first.key) } });
    route(selected(first.key));
    fireEvent.click(slot.container.querySelector<HTMLElement>(`[data-pr="${second.key}"]`)!);
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: selected(second.key), replace: true } });
    route(selected(second.key));
    fireEvent.click(await slot.findByRole("button", { name: "Close details" }));
    expect(back).toHaveBeenCalledTimes(1);
    expect(slot.inspection.navigateCalls).toHaveLength(2);
  });

  it("replaces the entry with the list when a PR opened by a link closes, since nothing was pushed", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const { slot } = await page(selected(second.key));
    fireEvent.click(await slot.findByRole("button", { name: "Close details" }));
    expect(back).not.toHaveBeenCalled();
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "requested", replace: true } });
  });
});

describe("in a narrow window", () => {
  it("slides the PR over the list, and Escape closes it without reaching bb", async () => {
    setViewport(1000);
    const { slot } = await page(selected(second.key));
    const overlay = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-overlay]") ?? Promise.reject(new Error("no overlay")));
    await waitFor(() => expect(overlay.querySelector(`[data-detail="${second.key}"]`)).not.toBeNull());
    expect(slot.container.querySelector(`ul[aria-label='Pull requests'] [data-pr="${second.key}"]`)).not.toBeNull();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "requested", replace: true } });
  });

  it("closes the panel when the scrim is clicked", async () => {
    setViewport(1000);
    const { slot } = await page(selected(second.key));
    fireEvent.click(await waitFor(() => slot.container.querySelector<HTMLElement>("[data-scrim]") ?? Promise.reject(new Error("no scrim"))));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "requested", replace: true } });
  });

  it("leaves Escape to an open dialog", async () => {
    setViewport(1000);
    const { slot } = await page(selected(second.key), { threads: () => ({ threads: [] }) });
    const overlay = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-overlay]") ?? Promise.reject(new Error("no overlay")));
    fireEvent.click((await within(overlay).findAllByRole("button", { name: "Link a thread" }))[0]!);
    await slot.findByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(slot.inspection.navigateCalls).toEqual([]);
  });
});

describe("list rows", () => {
  it("show at most three labels, each shortened with its full name as a title, then how many more", async () => {
    const labels: Label[] = [
      { name: "ZoneID: W-5df49c", color: null },
      { name: "//areas/infra/routing/nginx-routing-modules", color: "0e8a16" },
      { name: "edge", color: "1d76db" },
      { name: "tophatted", color: null },
      { name: "do-not-merge", color: "b60205" },
    ];
    const { slot } = await page("requested", { list: () => ({ prs: [pr({ labels })] }) });
    const row = await waitFor(() => slot.container.querySelector<HTMLElement>(`[data-pr="${first.key}"]`) ?? Promise.reject(new Error("no row")));
    const chips = [...row.querySelectorAll<HTMLElement>("[data-label]")];
    expect(chips.map((chip) => chip.getAttribute("data-label"))).toEqual(labels.slice(0, 3).map((label) => label.name));
    expect(chips[1]!.textContent).toBe("//areas/infra/routing/n…");
    expect(chips[1]!.getAttribute("title")).toBe("//areas/infra/routing/nginx-routing-modules");
    expect(chips[0]!.getAttribute("title")).toBeNull();
    const more = within(row).getByText("+2");
    expect(more.closest("[title]")!.getAttribute("title")).toBe("tophatted\ndo-not-merge");
  });
});

describe("the header on a phone", () => {
  it("shows only look-up and Sync, and opens the field from the search icon", async () => {
    setViewport(390);
    const loaded = await app();
    const slot = mount<PluginNavPanelProps>(loaded.navPanels[0]!.headerContent!, { subPath: "" }, handlers({ lookup: () => ({ pr: second }) }));
    expect(slot.queryByRole("textbox")).toBeNull();
    expect(slot.queryByRole("link", { name: "Shuttle settings" })).toBeNull();
    expect(slot.getByRole("button", { name: "Sync" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Look up a PR" }));
    const input = slot.getByRole("textbox", { name: "Look up a pull request" });
    fireEvent.change(input, { target: { value: "spy-v2#88" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "pr", key: second.key }) } }]));
  });
});
