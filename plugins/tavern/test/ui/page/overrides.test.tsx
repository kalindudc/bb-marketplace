import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { rpcContract } from "../../../src/shared/contract";
import { registry, room } from "../../../src/ui/page/fixtures";
import { registerPageSurfaces } from "../../../src/ui/page/register";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
const wren = registry.characters.find(c => c.id === "wren")!;
const row = { kind: "character" as const, id: "wren", name: "Wren", projectId: null, projectName: null,
  format: "patch" as const, fields: ["avatar"], canReset: true, path: "/example/characters/wren.md" };
const preview = { code: "ok" as const, name: "Wren", revision: "checked", path: row.path, fields: ["avatar"], fallback: "shipped" as const, widening: false, shadowed: false };
async function page(subPath: string, rpc: Partial<Handlers> = {}) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot(plugin.navPanels[0]!, { subPath }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: {
    registry: () => registry, room: () => room, ...rpc,
  } as Handlers });
  slots.push(slot); return slot;
}

it("lists readable overrides by scope, reports unreadable projects, and confirms a single row reset", async () => {
  const resetOverride = vi.fn(() => ({ code: "ok" as const }));
  const slot = await page("classes/overrides", {
    registryOverrides: () => ({ rows: [row, { ...row, id: "smith", name: "Mason", kind: "class", projectId: "archive", projectName: "Windmill Archive", fields: ["description"] }], problems: ["Remote Workshop: no server-local checkout."] }),
    previewOverrideReset: () => preview, resetOverride,
  });
  await slot.findByRole("heading", { name: "Every project" });
  slot.getByRole("heading", { name: /Windmill Archive/ });
  slot.getByText(/Remote Workshop/);
  fireEvent.click(slot.getByRole("button", { name: /Reset Wren/ }));
  const dialog = await slot.findByRole("dialog", { name: /Reset Wren/ });
  expect(dialog.textContent).toMatch(/Every project.*Tavern.*default.*Avatar.*Running turns/s);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(resetOverride).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: /Reset Wren/ }));
  fireEvent.click(within(await slot.findByRole("dialog", { name: /Reset Wren/ })).getByRole("button", { name: "Reset to default" }));
  await slot.findByText(/Wren’s override reset/);
  expect(resetOverride).toHaveBeenCalledWith({ kind: "character", id: "wren", target: "global", projectId: null, revision: "checked" });
});

it("shows no overrides, and a character sheet keeps its comparison after a stale field reset", async () => {
  const empty = await page("classes/overrides", { registryOverrides: () => ({ rows: [], problems: [] }) });
  await empty.findByRole("heading", { name: "No overrides" });
  const resetOverride = vi.fn(() => ({ code: "stale" as const }));
  const sheet = await page("character/wren", {
    registryDefinition: () => ({ name: "Wren", projectName: null, canViewProject: false, definition: wren, revision: "opened", format: "patch", hasDefault: true, canReset: true, path: row.path, fallback: "shipped", shadowed: false, fields: [{ field: "avatar", shipped: null, current: "7gqda", saved: true }], problem: null }),
    previewOverrideReset: () => preview, resetOverride,
  });
  fireEvent.click(await sheet.findByRole("button", { name: /Reset Avatar/ }));
  fireEvent.click(within(await sheet.findByRole("dialog", { name: /Reset Wren’s avatar/ })).getByRole("button", { name: "Reset to default" }));
  await sheet.findByText(/Nothing was reset/);
  expect(sheet.getByRole("table").textContent).toContain("7gqda");
  expect(resetOverride).toHaveBeenCalledWith(expect.objectContaining({ field: "avatar", revision: "checked" }));
});
