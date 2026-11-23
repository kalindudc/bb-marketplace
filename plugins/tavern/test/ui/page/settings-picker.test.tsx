import { renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, expect, it, vi } from "vitest";
import { settingsContract } from "../../../src/shared/settings";
import { rpcContract } from "../../../src/shared/contract";
import { settingsView } from "../../../src/ui/page/fixtures-insights";
import { registry } from "../../../src/ui/page/fixtures";
import { ClassesSection } from "../../../src/ui/page/settings";

const picker = vi.hoisted(() => ({ correct: () => {}, mounts: 0 }));
vi.mock("@get-bb/plugin-sdk/app", async importOriginal => ({
  ...await importOriginal<typeof import("@get-bb/plugin-sdk/app")>(),
  experimental_ProviderModelPicker: function Picker({ value, onChange, disabled }: any) {
    const [open, setOpen] = useState(false);
    const [identity] = useState(() => ++picker.mounts);
    const [selected, setSelected] = useState<typeof value | null>(null);
    const reported = useRef(false);
    useEffect(() => {
      if (selected && selected.model !== value.model && !reported.current) {
        reported.current = true;
        onChange(selected);
      }
    }, [selected, value, onChange]);
    picker.correct = () => onChange({ ...value, reasoningLevel: "medium" });
    return <div data-testid="picker" data-identity={identity}>
      <button disabled={disabled} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>Pick</button>
      {open && createPortal(<div role="dialog">
        <button onClick={() => { const next = { ...value, model: "new-model" }; setSelected(next); onChange(next); }}>Choose model</button>
        <button onClick={() => setOpen(false)}>Close picker</button>
      </div>, document.body)}
      <output>{value.model}</output>
    </div>;
  },
}));
const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
async function setup(update = vi.fn(async (_input: unknown) => ({ code: "ok", revision: 2, problems: [], settings: settingsView })), fromFile = false) {
  const view = structuredClone(settingsView);
  for (const c of registry.classes) view.effective.classes[c.id] = { provider: "codex", model: "old-model", reasoning: "high" };
  if (fromFile) view.effective.classes.keeper = {};
  const slot = renderSlot({ component: ClassesSection }, {}, {
    pluginId: "tavern", experimental_rpcContract: { ...rpcContract, ...settingsContract },
    rpc: { registry: () => registry, settings: () => view, settingsUpdate: update },
    providers: { status: "ready", providers: [{ id: "codex", displayName: "Codex", available: true }] as never },
  });
  slots.push(slot);
  await slot.findAllByTestId("picker");
  return { slot, update, view };
}
it("controls the draft immediately and saves once only after the menu closes", async () => {
  const { slot, update } = await setup();
  const row = slot.getAllByTestId("picker")[0]!;
  const identity = row.dataset.identity;
  fireEvent.click(within(row).getByRole("button", { name: "Pick" }));
  fireEvent.click(within(document.body).getByRole("button", { name: "Choose model" }));
  expect(row.textContent).toContain("new-model");
  expect(update).not.toHaveBeenCalled();
  fireEvent.click(within(document.body).getByRole("button", { name: "Close picker" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(row.dataset.identity).toBe(identity);
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ patch: { classes: { keeper: { provider: "codex", model: "new-model", reasoning: "high" } } } }));
});
it("keeps every picker mounted and enabled while one row saves", async () => {
  let finish!: (value: any) => void;
  const update = vi.fn((_input: unknown) => new Promise<any>(resolve => { finish = resolve; }));
  const { slot } = await setup(update);
  const rows = slot.getAllByTestId("picker");
  const identities = rows.map(row => row.dataset.identity);
  fireEvent.click(within(rows[0]!).getByRole("button", { name: "Pick" }));
  fireEvent.click(within(document.body).getByRole("button", { name: "Choose model" }));
  fireEvent.click(within(document.body).getByRole("button", { name: "Close picker" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(rows.map(row => within(row).getByRole<HTMLButtonElement>("button", { name: "Pick" }).disabled)).toEqual(rows.map(() => false));
  expect(slot.getAllByTestId("picker").map(row => row.dataset.identity)).toEqual(identities);
  expect(slot.getByText("Saving Keeper…")).toBeTruthy();
  await act(async () => finish({ code: "ok", revision: 2, problems: [], settings: settingsView }));
  await waitFor(() => expect(slot.queryByText("Saving Keeper…")).toBeNull());
});
it("does not save a later correction reported by the picker itself", async () => {
  const { slot, update } = await setup();
  const rows = slot.getAllByTestId("picker");
  const row = rows.at(-1)!;
  fireEvent.click(within(row).getByRole("button", { name: "Pick" }));
  fireEvent.click(within(document.body).getByRole("button", { name: "Choose model" }));
  fireEvent.click(within(document.body).getByRole("button", { name: "Close picker" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  await act(async () => picker.correct());
  expect(update).toHaveBeenCalledTimes(1);
});
it("keeps a first-choice picker mounted when the saved override arrives", async () => {
  const { slot, update, view } = await setup(undefined, true);
  update.mockImplementation(async () => {
    view.effective.classes.keeper = { provider: "codex", model: "new-model", reasoning: null };
    return { code: "ok", revision: 2, problems: [], settings: view };
  });
  fireEvent.click(slot.getByRole("button", { name: "Choose model and thinking for Keeper" }));
  const row = slot.getAllByTestId("picker")[0]!;
  const identity = row.dataset.identity;
  fireEvent.click(within(row).getByRole("button", { name: "Pick" }));
  fireEvent.click(within(document.body).getByRole("button", { name: "Choose model" }));
  fireEvent.click(within(document.body).getByRole("button", { name: "Close picker" }));
  expect(update).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Save model and thinking for Keeper" }));
  await slot.findByRole("button", { name: "Use the class file for Keeper" });
  expect(slot.getAllByTestId("picker")[0]!.dataset.identity).toBe(identity);
  expect(update).toHaveBeenCalledTimes(1);
});
