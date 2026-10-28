import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Changelog, PendingUpdate } from "../src/contract";
import { renderInstalledPage } from "./dom";

const update = (id: string, name: string, extra: Partial<PendingUpdate> = {}): PendingUpdate => ({
  id,
  name,
  icon: "Puzzle",
  imageUrl: null,
  installed: { version: `${id}-old`, label: "0.1.0" },
  candidate: { version: `${id}-new`, label: "0.2.0" },
  lastFailure: null,
  job: null,
  ...extra,
});

const CHANGELOG: Changelog = {
  toVersion: "0.2.0",
  notes: [{ version: "0.2.0", title: "0.2.0 (2026-10-28)", body: "- Trusted file directories." }],
  commits: [],
  moreCommits: 0,
  commitsCapped: false,
  compareUrl: "https://github.com/o/r/compare/a...b",
  unavailable: null,
};

beforeEach(() => {
  window.history.replaceState(null, "", "/plugins?view=installed");
});

afterEach(() => {
  document.body.replaceChildren();
});

async function mountOverlay(updates: PendingUpdate[]) {
  const app = await loadPluginApp(() => import("../app"));
  renderInstalledPage();
  const calls: Array<{ method: string; input: unknown }> = [];
  const slot = renderSlot(
    app.appOverlays[0]!,
    {},
    {
      pluginId: "plugin-updates",
      rpc: {
        list: () => {
          calls.push({ method: "list", input: null });
          return { updates };
        },
        changelog: (input: unknown) => {
          calls.push({ method: "changelog", input });
          return CHANGELOG;
        },
        update: (input: unknown) => {
          calls.push({ method: "update", input });
          return { started: (input as { ids: string[] }).ids, failed: [] };
        },
      },
    },
  );
  const group = await screen.findByRole("region", { name: "Plugin updates" });
  return { slot, calls, group };
}

describe("plugin app", () => {
  it("registers one app overlay and nothing else", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.appOverlays.map((overlay) => overlay.id)).toEqual(["installed-updates"]);
    expect(app.navPanels).toHaveLength(0);
    expect(app.contentScripts).toHaveLength(0);
  });

  it("groups the waiting updates above the Installed page's cards", async () => {
    const { group, slot } = await mountOverlay([update("burn", "Burn"), update("genui", "Generative UI")]);
    expect(within(group).getByText("2 plugins have updates")).toBeTruthy();
    expect(within(group).getByText("Generative UI")).toBeTruthy();
    expect(within(group).getAllByText("0.1.0 → 0.2.0")).toHaveLength(2);
    const host = group.closest("[data-plugin-updates-group]")!;
    expect(host.nextElementSibling?.querySelector('[data-testid="plugin-row-genui"]')).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("updates one plugin from its row", async () => {
    const { group, calls, slot } = await mountOverlay([update("burn", "Burn"), update("genui", "Generative UI")]);
    fireEvent.click(within(group).getByRole("button", { name: "Update Generative UI to 0.2.0" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "update")).toEqual([{ method: "update", input: { ids: ["genui"] } }]));
    slot.lifecycle.unmount();
  });

  it("asks once before updating every plugin", async () => {
    const { group, calls, slot } = await mountOverlay([update("burn", "Burn"), update("genui", "Generative UI")]);
    fireEvent.click(within(group).getByRole("button", { name: "Update all" }));
    expect(within(group).getByText("Update 2 plugins?")).toBeTruthy();
    expect(calls.some((call) => call.method === "update")).toBe(false);
    fireEvent.click(within(group).getByRole("button", { name: "Update all" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "update")).toEqual([{ method: "update", input: { ids: ["burn", "genui"] } }]));
    slot.lifecycle.unmount();
  });

  it("leaves running updates out of Update all and shows their progress", async () => {
    const { group, slot } = await mountOverlay([
      update("burn", "Burn", { job: { state: "running", detail: "Activating" } }),
      update("genui", "Generative UI"),
    ]);
    expect(within(group).getByRole("status").textContent).toContain("Activating");
    expect(within(group).queryByRole("button", { name: "Update all" })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("offers a retry with the reason after a failed update", async () => {
    const { group, slot } = await mountOverlay([update("genui", "Generative UI", { job: { state: "failed", detail: "build failed" } })]);
    expect(within(group).getByText("build failed")).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Retry updating Generative UI to 0.2.0" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("reads the changelog only when asked, and shows its entries", async () => {
    const { group, calls, slot } = await mountOverlay([update("genui", "Generative UI")]);
    expect(calls.some((call) => call.method === "changelog")).toBe(false);
    fireEvent.click(within(group).getByRole("button", { name: /What’s new/u }));
    expect(await within(group).findByText("0.2.0 (2026-10-28)")).toBeTruthy();
    expect(calls.filter((call) => call.method === "changelog")).toEqual([{ method: "changelog", input: { id: "genui" } }]);
    expect(within(group).getByRole("link", { name: /View on GitHub/u }).getAttribute("href")).toBe(CHANGELOG.compareUrl);
    slot.lifecycle.unmount();
  });

  it("draws nothing when no plugin has an update", async () => {
    const app = await loadPluginApp(() => import("../app"));
    renderInstalledPage();
    const slot = renderSlot(app.appOverlays[0]!, {}, { pluginId: "plugin-updates", rpc: { list: () => ({ updates: [] }) } });
    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
    expect(screen.queryByRole("region", { name: "Plugin updates" })).toBeNull();
    slot.lifecycle.unmount();
  });
});
