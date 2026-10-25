import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract, type Overview } from "../../src/contract";
import { formatRoute } from "../../src/ui/route";
import { app, callsTo, handlers, mount, overview, pr, server, unmountAll } from "./helpers";

afterEach(unmountAll);

async function panel() {
  const loaded = await app();
  return loaded.navPanels[0]!;
}

describe("the rail badge", () => {
  async function badge(counts: Partial<Overview["counts"]>) {
    const registration = await panel();
    const Probe = () => <output>{JSON.stringify(registration.experimental_useBadge!())}</output>;
    const slot = renderSlot({ component: Probe }, {}, {
      pluginId: "shuttle", experimental_rpcContract: rpcContract,
      rpc: handlers({ overview: () => overview({ counts: { ...overview().counts, ...counts } }) }),
    });
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    return slot;
  }

  it("counts the Inbox, as a warning", async () => {
    const slot = await badge({ inbox: 3 });
    await waitFor(() => expect(JSON.parse(slot.container.textContent!)).toEqual({ count: 3, tone: "warning", label: "3 PRs in your Inbox" }));
    slot.lifecycle.unmount();
  });

  it("shows nothing when the Inbox is empty", async () => {
    const slot = await badge({ inbox: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slot.container.textContent).toBe("null");
    slot.lifecycle.unmount();
  });
});

describe("the page title", () => {
  async function title(subPath: string) {
    const registration = await panel();
    const slot = renderSlot({ component: () => null, experimental_usePageTitle: registration.experimental_usePageTitle }, { subPath }, { pluginId: "shuttle" });
    const shown = slot.inspection.experimental_pageTitle;
    slot.lifecycle.unmount();
    return shown;
  }

  it("names the area and its part, the selected PR and a looked-up PR", async () => {
    expect(await title("")).toEqual({ title: "Inbox" });
    expect(await title(formatRoute({ view: "inbox", key: "delta:shop/world#2" }))).toEqual({
      breadcrumbs: [{ label: "Inbox", to: "/plugins/shuttle/shuttle/inbox" }, { label: "shop/world#2" }],
    });
    expect(await title("mine")).toEqual({ breadcrumbs: [{ label: "My PRs", to: "/plugins/shuttle/shuttle/mine" }, { label: "Open" }] });
    expect(await title("done")).toEqual({ breadcrumbs: [{ label: "My PRs", to: "/plugins/shuttle/shuttle/mine" }, { label: "Merged and closed" }] });
    expect(await title(formatRoute({ view: "reviews", source: "team", key: "github:Shopify/spy-v2#88" }))).toEqual({
      breadcrumbs: [
        { label: "Reviews", to: "/plugins/shuttle/shuttle/reviews" },
        { label: "My teams", to: "/plugins/shuttle/shuttle/reviews~team" },
        { label: "Shopify/spy-v2#88" },
      ],
    });
    expect(await title("insights/log")).toEqual({ breadcrumbs: [{ label: "Insights", to: "/plugins/shuttle/shuttle/insights" }, { label: "Automation log" }] });
    expect(await title("activity")).toEqual({ breadcrumbs: [{ label: "Insights", to: "/plugins/shuttle/shuttle/insights" }, { label: "Automation log" }] });
    expect(await title(formatRoute({ view: "pr", key: "delta:shop/world#2261179" }))).toEqual({ breadcrumbs: [{ label: "Look up" }, { label: "shop/world#2261179" }] });
    expect(await title("search")).toEqual({ title: "Search" });
    expect(await title(formatRoute({ view: "search", query: "edge cache", key: null }))).toEqual({ title: "Search: \u201cedge cache\u201d" });
    expect(await title(formatRoute({ view: "search", query: "edge", key: "delta:shop/world#2" }))).toEqual({
      breadcrumbs: [{ label: "Search: \u201cedge\u201d", to: "/plugins/shuttle/shuttle/search/edge" }, { label: "shop/world#2" }],
    });
  });
});

describe("the sidebar", () => {
  async function sidebar(subPath: string, rpc: Parameters<typeof handlers>[0] = {}) {
    const registration = await panel();
    return mount<PluginNavPanelProps>(registration.experimental_sidebar!, { subPath }, handlers(rpc));
  }

  it("lists the areas with their counts, the Inbox's hot, and goes to another", async () => {
    const slot = await sidebar("mine");
    await waitFor(() => expect(callsTo(slot, "overview")).toHaveLength(1));
    const nav = slot.getByRole("navigation", { name: "Shuttle areas" });
    await waitFor(() => expect(within(nav).getByRole("button", { name: /Inbox/u }).querySelector("[data-count]")!.textContent).toBe("2"));
    expect(within(nav).getByRole("button", { name: /Inbox/u }).querySelector("[data-count]")!.className).toContain("bg-warning");
    expect(within(nav).getByRole("button", { name: /^My PRs/u }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("button", { name: /^Open/u }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("button", { name: /Merged and closed/u }).textContent).toContain("1");
    expect(within(nav).queryByRole("button", { name: /Asked me/u })).toBeNull();
    fireEvent.click(within(nav).getByRole("button", { name: /Merged and closed/u }));
    fireEvent.click(within(nav).getByRole("button", { name: /Insights/u }));
    fireEvent.click(within(nav).getByRole("button", { name: /Inbox/u }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "shuttle", options: { subPath: "done" } },
      { method: "toPluginPanel", path: "shuttle", options: { subPath: "insights" } },
      { method: "toPluginPanel", path: "shuttle", options: { subPath: "inbox" } },
    ]);
  });

  it("shows Reviews' sources with their counts while Reviews is open", async () => {
    const slot = await sidebar("reviews~asked", {
      list: () => ({ prs: [pr(), pr({ number: 2, reasons: [{ reason: "team", teams: ["edge"] }], teams: ["edge"], tracked: true })] }),
    });
    const nav = slot.getByRole("navigation", { name: "Shuttle areas" });
    await waitFor(() => expect(within(nav).getByRole("button", { name: /Everything/u }).textContent).toBe("Everything2"));
    expect(within(nav).getByRole("button", { name: /Asked me/u }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("button", { name: /My teams/u }).textContent).toBe("My teams1");
    expect(within(nav).getByRole("button", { name: /Tracked/u }).textContent).toBe("Tracked1");
    fireEvent.click(within(nav).getByRole("button", { name: /Mentioned me/u }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "shuttle", options: { subPath: "reviews~mentioned" } }]);
  });

  it("ends with each server's health and sync time, and whether automations are paused", async () => {
    const slot = await sidebar("", {
      overview: () => overview({
        paused: true,
        servers: [server(), server({ id: "gitlab", name: "GitLab", ok: false, error: "glab: command not found" }), server({ id: "off", name: "Off", enabled: false })],
      }),
    });
    const footer = await waitFor(() => {
      const found = slot.container.querySelector<HTMLElement>("[data-sidebar-footer]");
      if (found === null || found.querySelectorAll("[data-server]").length === 0) throw new Error("no footer yet");
      return found;
    });
    expect([...footer.querySelectorAll("[data-server]")].map((node) => node.textContent)).toEqual(["GitHub · synced 1m ago", "GitLab · sync failed 1m ago"]);
    expect(footer.querySelector("[data-server='gitlab']")!.getAttribute("title")).toBe("glab: command not found");
    expect(footer.textContent).toContain("Automations paused");
    expect(within(footer).getByRole("link", { name: "resume" }).getAttribute("href")).toBe("/settings/plugins/shuttle");
  });
});
