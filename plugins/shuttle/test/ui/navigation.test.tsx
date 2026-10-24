import { formatRoute } from "../../src/ui/route";
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract, type Overview } from "../../src/contract";
import { app, callsTo, handlers, mount, overview, unmountAll } from "./helpers";

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

  it("counts the PRs that need you, as a warning", async () => {
    const slot = await badge({ needs: 3 });
    await waitFor(() => expect(JSON.parse(slot.container.textContent!)).toEqual({ count: 3, tone: "warning", label: "3 PRs need you" }));
    slot.lifecycle.unmount();
  });

  it("shows nothing when nothing needs you", async () => {
    const slot = await badge({ needs: 0 });
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

  it("names the section, the selected PR and a looked-up PR", async () => {
    expect(await title("")).toEqual({ title: "Needs you" });
    expect(await title("activity")).toEqual({ title: "Activity" });
    expect(await title(formatRoute({ view: "section", section: "team", key: "github:Shopify/spy-v2#88" }))).toEqual({
      breadcrumbs: [{ label: "My teams", to: "/plugins/shuttle/shuttle/team" }, { label: "Shopify/spy-v2#88" }],
    });
    expect(await title(formatRoute({ view: "section", section: "needs", key: "delta:shop/world#2" }))).toEqual({
      breadcrumbs: [{ label: "Needs you", to: "/plugins/shuttle/shuttle" }, { label: "shop/world#2" }],
    });
    expect(await title(formatRoute({ view: "pr", key: "delta:shop/world#2261179" }))).toEqual({ breadcrumbs: [{ label: "Look up" }, { label: "shop/world#2261179" }] });
  });
});

describe("the sidebar", () => {
  it("lists the sections with their counts, marks the current one and goes to another", async () => {
    const registration = await panel();
    const slot = mount<PluginNavPanelProps>(registration.experimental_sidebar!, { subPath: "team" }, handlers());
    await waitFor(() => expect(callsTo(slot, "overview")).toHaveLength(1));
    const current = await slot.findByRole("button", { name: /My teams/u });
    expect(current.getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(slot.getByRole("button", { name: /Needs you/u }).querySelector("[data-count]")!.textContent).toBe("1"));
    expect(slot.getByRole("button", { name: /In flight/u }).textContent).toContain("3");
    fireEvent.click(slot.getByRole("button", { name: /Activity/u }));
    fireEvent.click(slot.getByRole("button", { name: /Needs you/u }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "shuttle", options: { subPath: "activity" } },
      { method: "toPluginPanel", path: "shuttle", options: { subPath: "" } },
    ]);
  });
});
