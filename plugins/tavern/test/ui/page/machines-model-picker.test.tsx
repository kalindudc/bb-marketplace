import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, expect, it, vi } from "vitest";
import { settingsContract, settingsViewSchema } from "../../../src/shared/settings";
import { rpcContract } from "../../../src/shared/contract";
import { settingsView } from "../../../src/ui/page/fixtures-insights";
import { registry } from "../../../src/ui/page/fixtures";
import { machinesCatalog, machinesRoom } from "../fixtures/machines";
import { machinesContract } from "../../../src/ui/page/machines-contract";
import { registerPageSurfaces } from "../../../src/ui/page/register";
const picker = vi.hoisted(() => ({ callbacks: new Set<unknown>() }));
vi.mock("@get-bb/plugin-sdk/app", async original => ({
  ...await original<typeof import("@get-bb/plugin-sdk/app")>(),
  experimental_ProviderModelPicker: function Picker({ value, onChange }: any) {
    const [open, setOpen] = useState(false);
    picker.callbacks.add(onChange);
    return <div data-testid="model-picker"><button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>Pick</button><output>{value.model}</output>
      {open && createPortal(<div role="dialog"><button type="button" onClick={() => onChange({ providerId: "pi", model: "new-model", reasoningLevel: "high" })}>Choose model</button><button type="button" onClick={() => onChange({ providerId: "pi", model: "new-model", reasoningLevel: "" })}>Choose without reasoning</button><button type="button" onClick={() => setOpen(false)}>Close picker</button></div>, document.body)}</div>;
  },
}));
let slot: RenderedSlot;
afterEach(() => { slot?.lifecycle.unmount(); picker.callbacks.clear(); window.localStorage.clear(); });
it.each(["high", ""])("stages model picks with reasoning %j, saves only once with Save rule, and leaves other rows enabled", async reasoning => {
  const rule = { id: "models", label: "Models", enabled: true, match: { classes: ["smith", "ranger"] }, target: { kind: "current" } };
  const view = settingsViewSchema.parse({ ...structuredClone(settingsView), effective: { ...structuredClone(settingsView.effective), machines: { rules: [rule] } }, placementPolicy: { state: "valid", revision: 1, settings: { rules: [rule] } } });
  const update = vi.fn(async () => ({ code: "ok" as const, revision: 2, problems: [], settings: view }));
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  slot = renderSlot(plugin.navPanels[0]!, { subPath: "machines" }, { pluginId: "tavern", experimental_rpcContract: { ...rpcContract, ...settingsContract, ...machinesContract }, rpc: { room: () => machinesRoom, registry: () => registry, settings: () => view, settingsUpdate: update, placementCatalog: () => machinesCatalog }, providers: { status: "ready", providers: [{ id: "pi", displayName: "Pi", available: true }] as never } });
  fireEvent.click(await slot.findByRole("button", { name: "Edit rule 1" }));
  const models = await slot.findByRole("group", { name: "Models on these machines" });
  fireEvent.click(within(models).getByRole("button", { name: "Choose model for Smith" }));
  const row = slot.getByTestId("model-picker");
  fireEvent.click(within(row).getByRole("button", { name: "Pick" }));
  fireEvent.click(within(document.body).getByRole("button", { name: reasoning ? "Choose model" : "Choose without reasoning" }));
  expect(row.textContent).toContain("new-model");
  fireEvent.click(within(document.body).getByRole("button", { name: "Close picker" }));
  expect(update).not.toHaveBeenCalled();
  expect(picker.callbacks.size).toBe(1);
  expect(within(models).getByRole<HTMLButtonElement>("button", { name: "Choose model for Ranger" }).disabled).toBe(false);
  expect(within(models).queryByRole("button", { name: "Choose model for Warden" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Save rule" }));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ patch: { machines: { rules: [expect.objectContaining({ classModels: { smith: { provider: "pi", model: "new-model", ...(reasoning ? { reasoning } : {}) } } })] } } }));
});
