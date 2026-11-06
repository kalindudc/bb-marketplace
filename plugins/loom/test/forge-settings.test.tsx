// @vitest-environment jsdom
// Loom's Forges and Import and export settings sections: each profile with its version and users, a Test that shows what
// the read commands read, a form that saves a profile, and an import that previews before it applies.
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSettingsSectionProps } from "@get-bb/plugin-sdk/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rpcContract, type ForgeProfileView } from "../src/contract";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const unexpected = (): never => {
  throw new Error("unexpected rpc call");
};
const handlers = (over: Partial<Handlers>): Handlers => ({ ...(Object.fromEntries(Object.keys(rpcContract).map((method) => [method, unexpected])) as unknown as Handlers), ...over });

const VIEW: ForgeProfileView = {
  profile: { id: "forge", name: "Forge", kind: "command", open: "forge pr create", state: "forge pr state", feedback: "forge pr feedback", bots: ["svc-*"] },
  hash: "0123456789ab",
  updatedAt: Date.UTC(2026, 10, 6),
  usedBy: [{ slug: "csv", name: "CSV export", state: "running", inForce: true }],
  deletable: false,
};

const slots: Array<ReturnType<typeof renderSlot>> = [];
afterEach(() => {
  for (const slot of slots.splice(0)) slot.lifecycle.unmount();
  cleanup();
});

async function section(id: string, rpc: Partial<Handlers>) {
  const app = await loadPluginApp(() => import("../app"));
  const registration = app.settingsSections.find((item) => item.id === id)!;
  const slot = renderSlot<PluginSettingsSectionProps, typeof rpcContract>(registration, {}, { pluginId: "loom", rpc: handlers(rpc) });
  slots.push(slot);
  return slot;
}

describe("Loom's settings sections", () => {
  it("registers Forges, then Import and export", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.settingsSections.map((item) => [item.id, item.title])).toEqual([
      ["forges", "Forges"],
      ["forge-import-export", "Import and export"],
    ]);
  });

  it("shows each profile with its version and users, and tests it against a pull request with its read commands only", async () => {
    const test = vi.fn((input: { id?: string; url: string }) => ({ test: {} as never, text: `Tested the forge profile ${input.id} against ${input.url}.\nState OPEN`, passed: true }));
    const slot = await section("forges", { forgeProfiles: () => [VIEW], testForgeProfile: test });
    const card = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-forge-profile='forge']") ?? Promise.reject(new Error("no card")));
    expect(card.textContent).toContain("Version 0123456789ab");
    expect(card.textContent).toContain("Used by csv.");
    expect(card.textContent).toContain("counts svc-* as bots");
    fireEvent.change(within(card).getByRole("textbox", { name: "Pull request to test Forge against" }), { target: { value: "https://forge.example.com/acme/shop/pull/7" } });
    fireEvent.click(within(card).getByRole("button", { name: "Test" }));
    await waitFor(() => expect(card.querySelector("[data-forge-test-result='passed']")?.textContent).toContain("State OPEN"));
    expect(test.mock.calls[0]![0]).toEqual({ id: "forge", url: "https://forge.example.com/acme/shop/pull/7" });
    expect(within(card).queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("offers Delete only for a profile no stored spec names, and says why it keeps one that only history names", async () => {
    const slot = await section("forges", { forgeProfiles: () => [{ ...VIEW, usedBy: [], deletable: false }, { ...VIEW, profile: { ...VIEW.profile, id: "spare", name: "Spare" }, usedBy: [], deletable: true }] });
    const kept = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-forge-profile='forge']") ?? Promise.reject(new Error("no card")));
    expect(kept.textContent).toContain("Older or archived specs name it, so Loom keeps it.");
    expect(within(kept).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(slot.container.querySelector<HTMLElement>("[data-forge-profile='spare']")!).getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("saves a new profile from the form, leaving empty fields out", async () => {
    const save = vi.fn((_input: unknown) => [] as ForgeProfileView[]);
    const slot = await section("forges", { forgeProfiles: () => [], saveForgeProfile: save });
    fireEvent.click(await slot.findByRole("button", { name: "Add a forge profile" }));
    const form = slot.container.querySelector<HTMLElement>("[data-forge-form]")!;
    fireEvent.change(within(form).getByRole("textbox", { name: "Profile name" }), { target: { value: "Forge" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Profile id" }), { target: { value: "forge" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "open command" }), { target: { value: "forge pr create" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "state command" }), { target: { value: "forge pr state" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Bot authors" }), { target: { value: "svc-*, *@robots.example.com" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0]).toEqual({ profile: { id: "forge", name: "Forge", kind: "command", open: "forge pr create", state: "forge pr state", bots: ["svc-*", "*@robots.example.com"] }, original: null, confirm: true });
  });

  it("previews an import before it applies it", async () => {
    const importer = vi.fn((input: { apply: boolean }) => ({ changes: input.apply ? [] : ["adds forge profile lab"] }));
    const slot = await section("forge-import-export", { exportForgeProfiles: () => ({ toml: "" }), importForgeProfiles: importer });
    fireEvent.change(await slot.findByRole("textbox", { name: "TOML to import" }), { target: { value: '[[forge]]\nid = "lab"' } });
    fireEvent.click(slot.getByRole("button", { name: "Preview changes" }));
    await waitFor(() => expect(slot.container.querySelector("[data-forge-import-preview]")?.textContent).toContain("adds forge profile lab"));
    fireEvent.click(slot.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(importer).toHaveBeenCalledTimes(2));
    expect(importer.mock.calls.map(([input]) => input.apply)).toEqual([false, true]);
  });
});
