import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { Label, PrView } from "../../src/contract";
import { formatRoute } from "../../src/ui/route";
import { app, CAN_ALL, callsTo, find, handlers, lastNavigation, mine, mount, next, overview, page, pr, setViewport, unmountAll, type Handlers } from "./helpers";

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

const first = mine({
  labels: [{ name: "bug", color: "d73a4a" }], can: CAN_ALL,
  next: next({ kind: "ready_to_merge", tone: "ok", label: "Ready to merge", why: "Approved, and all checks pass.", inbox: true, primary: { id: "merge", label: "Merge…" } }),
});
const second = pr({
  repo: "Shopify/spy-v2", number: 88, title: "Add per-route sampling to the tracer", author: "mia-r", can: CAN_ALL,
  next: next({ kind: "new_request", tone: "info", label: "New review request", inbox: true, primary: { id: "review", label: "Start AI review" } }),
});
const selected = (key: string) => formatRoute({ view: "mine", key });
const reviewSelected = (key: string) => formatRoute({ view: "reviews", source: "all", key });

function layoutPage(subPath: string, rpc: Partial<Handlers> = {}) {
  return page(subPath, {
    list: ({ area }) => ({ prs: area === "mine" ? [first] : area === "reviews" ? [second] : [] }),
    detail: ({ key }) => ({ pr: [first, second].find((item) => item.key === key)!, events: [], body: "", draft: null }),
    ...rpc,
  });
}

describe("on a phone", () => {
  it("switches areas from a tab bar with the Inbox's count, and rows open the PR", async () => {
    setViewport(390);
    const { slot } = await layoutPage("mine", { overview: () => overview({ counts: { inbox: 7, mine: 1, done: 0, reviews: 1 } }) });
    const row = await find(slot.container, `[data-pr="${first.key}"]`);
    const tabs = slot.getByRole("navigation", { name: "Areas" });
    expect(within(tabs).getAllByRole("button").map((button) => button.textContent)).toEqual(["Inbox7", "My PRs", "Reviews", "Insights"]);
    expect(within(tabs).getByRole("button", { name: /My PRs/u }).getAttribute("aria-current")).toBe("page");
    expect(row.querySelector("[data-icon='ChevronRight']")).not.toBeNull();
    expect(row.querySelector("[data-label='bug']")).not.toBeNull();
    expect(within(row).queryByRole("button", { name: "Merge…" })).toBeNull();
    fireEvent.click(row);
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: selected(first.key) } });
    fireEvent.click(within(tabs).getByRole("button", { name: /Reviews/u }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "reviews" } });
  });

  it("shows only the PR, with back, Track and Open at the top and its next step and Comment at the bottom", async () => {
    setViewport(390);
    const { slot } = await layoutPage(reviewSelected(second.key));
    const view = await find(slot.container, "[data-phone-pr]");
    await find(view, `[data-detail="${second.key}"]`);
    expect(slot.queryByRole("navigation", { name: "Areas" })).toBeNull();
    expect(within(view).getByRole("button", { name: "Back to Reviews" })).toBeTruthy();
    expect(within(view).getByRole("button", { name: "Track" })).toBeTruthy();
    expect(within(view).queryByRole("button", { name: "Close details" })).toBeNull();
    expect(view.querySelector("[data-composer]")).toBeNull();
    const step = view.querySelector<HTMLElement>("[data-phone-actions] [data-next='review']")!;
    expect(step.textContent).toBe("Start AI review");
    fireEvent.click(within(view).getByRole("button", { name: "Open on GitHub" }));
    expect(lastNavigation(slot)).toEqual({ method: "openUrl", url: second.url });
  });

  it("opens dialogs and the composer as bottom sheets", async () => {
    setViewport(390);
    const { slot } = await layoutPage(reviewSelected(second.key), { review: () => ({ threadId: "thr_review", revived: false }), comment: () => ({ pr: second }) });
    const view = await find(slot.container, "[data-phone-pr]");
    await find(view, `[data-detail="${second.key}"]`);
    fireEvent.click(view.querySelector<HTMLElement>("[data-phone-actions] [data-next='review']")!);
    const sheet = await screen.findByRole("dialog", { name: "Start an AI review of spy-v2#88" });
    expect(slot.container.contains(sheet)).toBe(false);
    expect(sheet.closest("[data-bb-plugin='shuttle'][data-bb-plugin-root]")).not.toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(callsTo(slot, "review")).toEqual([{ key: second.key, presetId: "standard" }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(within(view.querySelector<HTMLElement>("[data-phone-actions]")!).getByRole("button", { name: "Comment" }));
    const composer = await screen.findByRole("dialog", { name: "Comment on spy-v2#88" });
    fireEvent.change(within(composer).getByRole("textbox"), { target: { value: "Nice." } });
    fireEvent.click(within(composer).getAllByRole("button", { name: "Comment" }).at(-1)!);
    await waitFor(() => expect(callsTo(slot, "comment")).toEqual([{ key: second.key, body: "Nice." }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("names the bottom bar's composer button by what it can do", async () => {
    setViewport(390);
    const reviewOnly = { ...second, can: { ...second.can, comment: false, review: true } };
    const { slot } = await layoutPage(reviewSelected(second.key), { detail: () => ({ pr: reviewOnly, events: [], body: "", draft: null }) });
    const view = await find(slot.container, "[data-phone-pr]");
    await find(view, `[data-detail="${second.key}"]`);
    const bar = view.querySelector<HTMLElement>("[data-phone-actions]")!;
    expect(within(bar).queryByRole("button", { name: "Comment" })).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "Review" }));
    expect(await screen.findByRole("dialog", { name: "Review spy-v2#88" })).toBeTruthy();
  });

  it("goes back in history to the list it came from", async () => {
    setViewport(390);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const { slot, route } = await layoutPage("mine");
    fireEvent.click(await find(slot.container, `[data-pr="${first.key}"]`));
    route(selected(first.key));
    fireEvent.click(await slot.findByRole("button", { name: "Back to My PRs" }));
    expect(back).toHaveBeenCalledTimes(1);
    expect(slot.inspection.navigateCalls).toHaveLength(1);
  });
});

describe("history", () => {
  it("pushes when a PR opens from the list, replaces when another is picked, and goes back when it closes", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const both = [first, { ...second, mine: true, key: second.key }] as PrView[];
    const { slot, route } = await layoutPage("mine", { list: () => ({ prs: both }) });
    fireEvent.click(await find(slot.container, `[data-pr="${first.key}"]`));
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
    const { slot } = await layoutPage(selected(first.key));
    fireEvent.click(await slot.findByRole("button", { name: "Close details" }));
    expect(back).not.toHaveBeenCalled();
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "mine", replace: true } });
  });
});

describe("in a narrow window", () => {
  it("puts the areas in chips under the header", async () => {
    setViewport(1000);
    const { slot } = await layoutPage("mine");
    const chips = await waitFor(() => slot.getByRole("navigation", { name: "Areas" }));
    await waitFor(() => expect(within(chips).getAllByRole("button").map((button) => button.textContent)).toEqual(["Inbox2", "My PRs3", "Reviews12", "Insights"]));
    fireEvent.click(within(chips).getByRole("button", { name: /Insights/u }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "insights" } });
  });

  it("slides the PR over the list, and Escape closes it without reaching bb", async () => {
    setViewport(1000);
    const { slot } = await layoutPage(selected(first.key));
    const overlay = await find(slot.container, "[data-overlay]");
    await find(overlay, `[data-detail="${first.key}"]`);
    expect(slot.container.querySelector(`[data-pr="${first.key}"]`)).not.toBeNull();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "mine", replace: true } });
  });

  it("closes the panel when the scrim is clicked", async () => {
    setViewport(1000);
    const { slot } = await layoutPage(selected(first.key));
    fireEvent.click(await find(slot.container, "[data-scrim]"));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "mine", replace: true } });
  });

  it("leaves Escape to an open dialog", async () => {
    setViewport(1000);
    const { slot } = await layoutPage(selected(first.key));
    const overlay = await find(slot.container, "[data-overlay]");
    fireEvent.click(await within(overlay).findByRole("button", { name: "Link a thread" }));
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
    const { slot } = await layoutPage("mine", { list: () => ({ prs: [{ ...first, labels }] }) });
    const row = await find(slot.container, `[data-pr="${first.key}"]`);
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
  it("shows only search and Sync, and opens the field from the search icon", async () => {
    setViewport(390);
    const loaded = await app();
    const slot = mount<PluginNavPanelProps>(loaded.navPanels[0]!.headerContent!, { subPath: "" }, handlers({ lookup: () => ({ pr: second }) }));
    expect(slot.queryByRole("textbox")).toBeNull();
    expect(slot.queryByRole("link", { name: "Shuttle settings" })).toBeNull();
    expect(slot.getByRole("button", { name: "Sync" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Search PRs" }));
    const input = slot.getByRole("textbox", { name: "Search pull requests" });
    fireEvent.change(input, { target: { value: second.key } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "pr", key: second.key }) } }]));
  });

  it("keeps the search field open on the Search page, and its X goes back to the Inbox", async () => {
    setViewport(390);
    const loaded = await app();
    const slot = mount<PluginNavPanelProps>(loaded.navPanels[0]!.headerContent!, { subPath: formatRoute({ view: "search", query: "edge", key: null }) }, handlers());
    expect((slot.getByRole("textbox", { name: "Search pull requests" }) as HTMLInputElement).value).toBe("edge");
    fireEvent.click(slot.getByRole("button", { name: "Close search" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "shuttle", options: { subPath: "" } }]);
  });
});
