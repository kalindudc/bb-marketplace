import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { PrView } from "../../src/contract";
import { applyChange, type Change } from "../../src/ui/edit";
import { formatRoute } from "../../src/ui/route";
import { app, callsTo, handlers, mount, pr, setViewport, unmountAll, type Handlers } from "./helpers";

/** Opens the PR view's Details, where the Manage card lives. */
async function details(root: HTMLElement) {
  const section = await waitFor(() => within(root).getByRole("region", { name: "Details" }));
  const toggle = within(section).getByRole("button", { name: /Details/u });
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
  return section;
}

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toasts) }));

afterEach(() => {
  unmountAll();
  toasts.error.mockReset();
  toasts.success.mockReset();
});

const ALL_ACTIONS: PrView["actions"] = ["ready", "draft", "close", "reopen", "labels", "reviewers"];
const mine = (overrides: Partial<PrView> = {}) => pr({
  mine: true, author: "kalindudc", reasons: [], actions: ALL_ACTIONS, requestedAt: null,
  labels: [{ name: "bug", color: "d73a4a" }],
  reviewers: [
    { login: "alice-w", team: false, state: "changes" },
    { login: "bchen", team: false, state: "requested" },
    { login: "Shopify/edge-infrastructure", team: true, state: "requested" },
  ],
  ...overrides,
});

/** A server that applies each change, so confirmed reads agree with what the page predicted. */
async function open(start: PrView, rpc: Partial<Handlers> = {}) {
  let current = start;
  const loaded = await app();
  const slot = mount<PluginNavPanelProps>(loaded.navPanels[0]!.component, { subPath: formatRoute({ view: "mine", key: start.key }) }, handlers({
    list: ({ area }) => ({ prs: area === "mine" ? [current] : [] }),
    detail: () => ({ pr: current, events: [], body: "", draft: null }),
    editPr: ({ change }) => {
      current = applyChange(current, change as Change, new Map());
      return { pr: current };
    },
    editOptions: () => ({
      labels: [
        { name: "bug", color: "d73a4a", description: "Something isn't working" },
        { name: "cache", color: "1d76db", description: "Caching layers" },
      ],
      people: ["kalindudc", "alice-w", "bchen", "dana-k"],
      teams: ["Shopify/edge-infrastructure", "Shopify/cdn"],
    }),
    ...rpc,
  }));
  await details(slot.container);
  const card = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-manage]") ?? Promise.reject(new Error("no manage card")));
  return { slot, card };
}
const edits = (slot: Awaited<ReturnType<typeof open>>["slot"]) => callsTo(slot, "editPr").map((input) => (input as { change: Change }).change);
const row = (card: HTMLElement, name: string) => card.querySelector<HTMLElement>(`[data-manage-row="${name}"]`)!;
const openMenu = (button: HTMLElement) => fireEvent.keyDown(button, { key: "Enter" });

describe("the Manage your PR card", () => {
  it("shows only for PRs with actions; others get labels and reviewers to read", async () => {
    const theirs = pr({ labels: [{ name: "loom", color: null }], reviewers: [{ login: "kalindudc", team: false, state: "requested" }] });
    const loaded = await app();
    const slot = mount<PluginNavPanelProps>(loaded.navPanels[0]!.component, { subPath: formatRoute({ view: "reviews", source: "all", key: theirs.key }) },
      handlers({ list: () => ({ prs: [theirs] }), detail: () => ({ pr: theirs, events: [], body: "", draft: null }) }));
    await details(slot.container);
    await waitFor(() => expect(slot.container.querySelector("[data-readonly='labels']")).not.toBeNull());
    expect(slot.container.querySelector("[data-manage]")).toBeNull();
    expect(slot.container.querySelector("[data-readonly='labels'] [data-label='loom']")).not.toBeNull();
    expect(slot.container.querySelector("[data-readonly='reviewers']")!.textContent).toContain("Review requested");
    expect(slot.container.querySelector("[data-readonly='reviewers'] button")).toBeNull();

    const { card } = await open(mine());
    expect(card.textContent).toContain("Changes go straight to GitHub");
    expect(card.parentElement!.querySelector("[data-readonly]")).toBeNull();
  });

  it("marks a draft ready, converts an open PR to a draft, closes and reopens", async () => {
    const draft = await open(mine({ state: "draft" }));
    fireEvent.click(within(row(draft.card, "status")).getByRole("button", { name: "Ready for review" }));
    await waitFor(() => expect(edits(draft.slot)).toEqual([{ kind: "ready" }]));
    expect(within(row(draft.card, "status")).getByRole("button", { name: "Convert to draft" })).toBeTruthy();
    fireEvent.click(within(row(draft.card, "status")).getByRole("button", { name: "Convert to draft" }));
    fireEvent.click(within(row(draft.card, "status")).getByRole("button", { name: "Close PR" }));
    await waitFor(() => expect(edits(draft.slot)).toEqual([{ kind: "ready" }, { kind: "draft" }, { kind: "close" }]));
    fireEvent.click(await within(row(draft.card, "status")).findByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(edits(draft.slot)).toEqual([{ kind: "ready" }, { kind: "draft" }, { kind: "close" }, { kind: "reopen" }]));
    expect(toasts.success.mock.calls.map(([message]) => message)).toEqual([
      "get-bb/bb#4411 is ready for review", "get-bb/bb#4411 is a draft again", "Closed get-bb/bb#4411", "Reopened get-bb/bb#4411",
    ]);
  });

  it("disables what the server cannot do, saying so", async () => {
    const { card } = await open(mine({ serverName: "Delta", actions: ["ready", "close", "labels"] }));
    const draft = within(row(card, "status")).getByRole("button", { name: "Convert to draft" }) as HTMLButtonElement;
    expect(draft.disabled).toBe(true);
    expect(draft.title).toBe("Delta can't do this");
    expect(row(card, "status").textContent).toContain("Delta can't do this: convert to draft.");
    expect((within(row(card, "reviewers")).getByRole("button", { name: "Request reviewers" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(row(card, "reviewers")).queryByRole("button", { name: /Withdraw/u })).toBeNull();
  });

  it("shows no status buttons on a merged PR", async () => {
    const { card } = await open(mine({ state: "merged" }));
    expect(within(row(card, "status")).queryAllByRole("button")).toEqual([]);
    expect(row(card, "status").textContent).toContain("Merged");
  });

  it("adds a label from the picker and removes one with its ×, showing each at once", async () => {
    let release: () => void = () => {};
    const { slot, card } = await open(mine(), {
      editPr: ({ change }) => new Promise((resolve) => {
        release = () => resolve({ pr: applyChange(mine(), change as Change, new Map()) });
      }),
    });
    openMenu(within(row(card, "labels")).getByRole("button", { name: "Edit labels" }));
    const menu = await screen.findByRole("menu", { name: "Edit labels" });
    await within(menu).findByRole("menuitemcheckbox", { name: /cache/u });
    expect(within(menu).getByRole("menuitemcheckbox", { name: /bug/u }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: /cache/u }));
    await waitFor(() => expect(edits(slot)).toEqual([{ kind: "labels", add: ["cache"] }]));
    expect(row(card, "labels").querySelector("[data-label='cache']")).not.toBeNull();
    expect(within(menu).getByRole("menuitemcheckbox", { name: /cache/u }).getAttribute("aria-checked")).toBe("true");
    release();
    fireEvent.click(within(row(card, "labels")).getByRole("button", { name: "Remove label bug" }));
    await waitFor(() => expect(edits(slot)).toEqual([{ kind: "labels", add: ["cache"] }, { kind: "labels", remove: ["bug"] }]));
  });

  it("offers to add a label the filter does not match", async () => {
    const { slot, card } = await open(mine());
    openMenu(within(row(card, "labels")).getByRole("button", { name: "Edit labels" }));
    const menu = await screen.findByRole("menu", { name: "Edit labels" });
    await within(menu).findByRole("menuitemcheckbox", { name: /cache/u });
    fireEvent.change(within(menu).getByRole("textbox", { name: "Filter labels" }), { target: { value: "needs-tophat" } });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Add label “needs-tophat”" }));
    await waitFor(() => expect(edits(slot)).toEqual([{ kind: "labels", add: ["needs-tophat"] }]));
  });

  it("requests a reviewer, withdraws a request and asks again", async () => {
    const { slot, card } = await open(mine());
    openMenu(within(row(card, "reviewers")).getByRole("button", { name: "Request reviewers" }));
    const menu = await screen.findByRole("menu", { name: "Request reviewers" });
    await within(menu).findByRole("menuitemcheckbox", { name: /dana-k/u });
    expect(within(menu).queryByRole("menuitemcheckbox", { name: /kalindudc/u })).toBeNull();
    const alice = within(menu).getByRole("menuitemcheckbox", { name: /alice-w/u });
    expect(alice.getAttribute("aria-disabled")).toBe("true");
    expect(alice.textContent).toContain("Changes requested: use Ask again");
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: /dana-k/u }));
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: /Shopify\/cdn/u }));
    await waitFor(() => expect(edits(slot)).toEqual([
      { kind: "reviewers", add: [{ login: "dana-k", team: false }] },
      { kind: "reviewers", add: [{ login: "Shopify/cdn", team: true }] },
    ]));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    fireEvent.click(within(row(card, "reviewers")).getByRole("button", { name: "Withdraw the request to bchen" }));
    fireEvent.click(within(row(card, "reviewers")).getByRole("button", { name: "Ask alice-w to review again" }));
    await waitFor(() => expect(edits(slot).slice(2)).toEqual([
      { kind: "reviewers", remove: [{ login: "bchen", team: false }] },
      { kind: "reviewers", add: [{ login: "alice-w", team: false }] },
    ]));
    await waitFor(() => expect(row(card, "reviewers").querySelector("[data-reviewer='bchen']")).toBeNull());
    expect(row(card, "reviewers").querySelector("[data-reviewer='alice-w']")!.textContent).toContain("Review requested");
    const askAgain = toasts.success.mock.calls.find(([message]) => message === "Asked alice-w to review again")!;
    expect(askAgain[1]).toBeUndefined();
  });

  it("requests a typed team, without its @", async () => {
    const { slot, card } = await open(mine());
    openMenu(within(row(card, "reviewers")).getByRole("button", { name: "Request reviewers" }));
    const menu = await screen.findByRole("menu", { name: "Request reviewers" });
    await within(menu).findByRole("menuitemcheckbox", { name: /dana-k/u });
    fireEvent.change(within(menu).getByRole("textbox", { name: "Search people and teams" }), { target: { value: "@Shopify/routing" } });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Request team Shopify/routing" }));
    await waitFor(() => expect(edits(slot)).toEqual([{ kind: "reviewers", add: [{ login: "Shopify/routing", team: true }] }]));
  });

  it("undoes a change by sending its inverse", async () => {
    const { slot, card } = await open(mine({ state: "draft" }));
    fireEvent.click(within(row(card, "status")).getByRole("button", { name: "Ready for review" }));
    fireEvent.click(within(row(card, "labels")).getByRole("button", { name: "Remove label bug" }));
    fireEvent.click(within(row(card, "reviewers")).getByRole("button", { name: "Withdraw the request to bchen" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(3));
    for (const [, options] of toasts.success.mock.calls) {
      expect(options).toMatchObject({ duration: 5000, action: { label: "Undo" } });
      options.action.onClick();
    }
    await waitFor(() => expect(edits(slot).slice(3)).toEqual([
      { kind: "draft" },
      { kind: "labels", add: ["bug"], remove: [] },
      { kind: "reviewers", add: [{ login: "bchen", team: false }], remove: [] },
    ]));
    await waitFor(() => expect(row(card, "labels").querySelector("[data-label='bug']")).not.toBeNull());
  });

  it("offers no Undo when the server can't make the inverse change", async () => {
    const noDraft: PrView["actions"] = ["ready", "close", "labels", "reviewers"];
    const { slot, card } = await open(mine({ state: "draft", actions: noDraft }), {
      editPr: () => ({ pr: mine({ state: "open", actions: noDraft }) }),
    });
    fireEvent.click(within(row(card, "status")).getByRole("button", { name: "Ready for review" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(1));
    expect(edits(slot)).toEqual([{ kind: "ready" }]);
    expect(toasts.success.mock.calls[0]).toEqual(["get-bb/bb#4411 is ready for review"]);
  });

  it("puts a refused change back and shows the server's message", async () => {
    const { card } = await open(mine({ state: "draft" }), {
      editPr: () => { throw Object.assign(new Error("gh: GraphQL: Pull request is in clean status"), { code: "invalid" }); },
    });
    fireEvent.click(within(row(card, "status")).getByRole("button", { name: "Ready for review" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("gh: GraphQL: Pull request is in clean status"));
    expect(within(row(card, "status")).getByRole("button", { name: "Ready for review" })).toBeTruthy();
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("shows each change in the list as well as the PR view", async () => {
    let release: () => void = () => {};
    const { slot, card } = await open(mine(), {
      editPr: ({ change }) => new Promise((resolve) => {
        release = () => resolve({ pr: applyChange(mine(), change as Change, new Map()) });
      }),
    });
    fireEvent.click(within(row(card, "labels")).getByRole("button", { name: "Remove label bug" }));
    await waitFor(() => expect(edits(slot)).toHaveLength(1));
    const listRow = slot.container.querySelector<HTMLElement>(`li[data-pr="${mine().key}"]`)!;
    expect(listRow.querySelector("[data-label='bug']")).toBeNull();
    release();
  });

  // bb applies Shuttle's CSS only under [data-bb-plugin=shuttle]; a portal outside it loses classes such as size-[22px].
  it("portals its pickers inside Shuttle's CSS scope, as a menu and as a sheet", async () => {
    const desktop = await open(mine());
    openMenu(within(row(desktop.card, "reviewers")).getByRole("button", { name: "Request reviewers" }));
    const menu = await screen.findByRole("menu", { name: "Request reviewers" });
    expect(desktop.slot.container.contains(menu)).toBe(false);
    expect(menu.closest("[data-bb-plugin='shuttle'][data-bb-plugin-root]")).not.toBeNull();
    unmountAll();
    setViewport(390);
    const phone = await open(mine());
    fireEvent.click(within(row(phone.card, "reviewers")).getByRole("button", { name: "Request reviewers" }));
    const sheet = await screen.findByRole("dialog", { name: "Request reviewers" });
    expect(phone.slot.container.contains(sheet)).toBe(false);
    expect(sheet.closest("[data-bb-plugin='shuttle'][data-bb-plugin-root]")).not.toBeNull();
  });

  it("opens its pickers as bottom sheets on a phone", async () => {
    setViewport(390);
    const { slot, card } = await open(mine());
    fireEvent.click(within(row(card, "labels")).getByRole("button", { name: "Edit labels" }));
    const sheet = await screen.findByRole("dialog", { name: "Labels" });
    fireEvent.click(await within(sheet).findByRole("menuitemcheckbox", { name: /cache/u }));
    await waitFor(() => expect(edits(slot)).toEqual([{ kind: "labels", add: ["cache"] }]));
    expect(screen.getByRole("dialog", { name: "Labels" })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Labels" })).toBeNull();
  });
});
