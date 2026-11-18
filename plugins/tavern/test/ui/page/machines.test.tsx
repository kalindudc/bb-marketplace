import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcContract } from "../../../src/shared/contract";
import { settingsContract, settingsViewSchema, type SettingsView } from "../../../src/shared/settings";
import type { PlacementSettings } from "../../../src/shared/placement-settings";
import { registry } from "../../../src/ui/page/fixtures";
import { settingsView } from "../../../src/ui/page/fixtures-insights";
import { machineProblems, machineVolumes, machinesCatalog, machinesRoom, previewFixture } from "../fixtures/machines";
import { machinesContract } from "../../../src/ui/page/machines-contract";
import * as MM from "../../../src/ui/page/machines-model";
import { validatePlacementInputs } from "../../../src/server/placement/inputs";
import { registerPageSurfaces } from "../../../src/ui/page/register";

// The page ships behind PLACEMENT_RPC_LIVE until the server serves its two reads; these tests run it as if they were live, except where they say not.
const live = vi.hoisted(() => ({ value: true }));
vi.mock("../../../src/ui/page/machines-contract", async (original) => {
  const mod = await original<typeof import("../../../src/ui/page/machines-contract")>();
  return { ...mod, get PLACEMENT_RPC_LIVE() { return live.value; } };
});

const contract = { ...rpcContract, ...settingsContract, ...machinesContract };
type Handlers = PluginRpcTestHandlers<typeof contract>;
const names = MM.makeNames(machinesCatalog, machinesCatalog.environments, registry.classes, machinesRoom);
const NOW = 1794660736997 + 3_600_000;
const hhmm = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

function viewWith(machines: PlacementSettings, revision = 12, history: SettingsView["history"] = []): SettingsView {
  return settingsViewSchema.parse({ ...structuredClone(settingsView), revision, effective: { ...structuredClone(settingsView.effective), machines }, placementPolicy: { state: "valid", revision, settings: machines }, history });
}
const slots: RenderedSlot[] = [];
afterEach(() => { for (const s of slots.splice(0)) s.lifecycle.unmount(); live.value = true; });
beforeEach(() => window.localStorage.clear());
async function page(subPath: string, rpc: Partial<Handlers> = {}, machines: PlacementSettings = machineVolumes.many) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  let current = viewWith(machines);
  const base: Partial<Handlers> = {
    room: () => structuredClone(machinesRoom), registry: () => structuredClone(registry), settings: () => current,
    placementCatalog: () => structuredClone(machinesCatalog),
    placementPreview: (input) => previewFixture(current.effective.machines, input),
    settingsUpdate: (input) => { const m = { ...current.effective.machines, ...input.patch.machines } as PlacementSettings; current = viewWith(m, current.revision + 1, [{ id: `d${current.revision + 1}`, at: NOW, by: "user", reason: input.why, evidence: null, questId: null, threadId: null, changes: [], undoable: true, undoneAt: null }]); return { code: "ok" as const, revision: current.revision, problems: [], settings: current, decisionId: `d${current.revision}` }; },
  };
  const slot = renderSlot(plugin.navPanels[0]!, { subPath }, { pluginId: "tavern", experimental_rpcContract: contract, rpc: { ...base, ...rpc } as Handlers });
  slots.push(slot);
  await slot.findByRole("heading", { name: /Where work runs/ });
  await waitFor(() => expect(slot.container.querySelector(".mx-rules, .mx-empty, .mx-block")).toBeTruthy());
  return slot;
}
const ruleRow = (slot: RenderedSlot, n: number) => slot.container.querySelector(`[data-rule="${n - 1}"]`) as HTMLElement;

describe("Machine placement words", () => {
  it("uses the server's supported and unsupported verdicts in the preview fixture", async () => {
    const input = { projectId: "proj_3m7ijbk6gx", keeperThreadId: null, keeperPath: null, classId: "smith", questId: null };
    expect(await previewFixture(machineVolumes.one, input)).toMatchObject({ verdict: { state: "matched", ruleId: "shop-world-remote", blocked: null, remote: true, posture: "Detection only (remote)" } });
    const rule = machineVolumes.one.rules[0]!;
    if (rule.target.kind !== "provider") throw new Error("Expected a provider fixture.");
    const unsupported = { ...machineVolumes.one, rules: [{ ...rule, target: { ...rule.target, machine: { type: "keeper" as const }, workspace: "linked-worktree" as const } }] };
    expect(await previewFixture(unsupported, input)).toMatchObject({ verdict: { state: "matched", blocked: { code: "unsupported-target", message: "This rule's target isn't supported in this version." }, remote: null, posture: null } });
  });
  it("offers the pushed source base template and validates it as a provider input", () => {
    expect(MM.TEMPLATES).toContain("{source.base}");
    const provider = { id: "checkout", inputs: { type: "object", properties: { base: { type: "string" } }, required: ["base"] }, acceptsEmptyInputs: false };
    expect(validatePlacementInputs(provider, { base: "{source.base}" }, { "source.base": "a".repeat(40) })).toMatchObject({ state: "valid", inputs: { base: "a".repeat(40) } });
  });
  it("says what each rule catches and where it sends members, by name", () => {
    const [local, shop, trees, wardens, , devbox, all] = machineVolumes.many.rules;
    expect(MM.catches(names, shop!)).toEqual([{ field: "repoRemotes", word: "Repository", values: ["delta.shopify.io/shop/world"] }]);
    expect(MM.catches(names, trees!).map((p) => p.values.join())).toEqual(["~/world/trees/*/src", "Smith (builder)"]);
    expect(MM.catches(names, wardens!)[0]!.values).toEqual(["bb-marketplace"]);
    expect(MM.catches(names, all!)).toEqual([]);
    expect(MM.sendsTo(names, local!.target).place).toBe("Where it runs today");
    expect(MM.sendsTo(names, shop!.target)).toMatchObject({ place: "Aquifer World checkout on a new Aquifer World sandbox", detail: "one machine per member · cores 4, memoryGb 8", remote: true, unavailable: null });
    expect(MM.sendsTo(names, devbox!.target).unavailable).toBe("devbox-checkout");
    const noCatalog = MM.makeNames(null, [], registry.classes, machinesRoom);
    expect(MM.sendsTo(noCatalog, devbox!.target).unavailable).toBeNull();
  });

  it("tells two quests with one name apart by Keeper, and by start time only when the Keepers share a name", () => {
    const labels = MM.questLabels(machinesRoom, NOW);
    expect(labels.get("quest_08eee999")).toBe(`Uppercase durations · Wren, started ${hhmm(1794656692754)}`);
    expect(labels.get("quest_04663432")).toBe(`Uppercase durations · Wren, started ${hhmm(1794656425490)}`);
    expect(labels.get("quest_9e7f9c0f")).toBe("formatDuration");
  });

  it("finds rules an earlier enabled rule always catches first", () => {
    const rules = machineVolumes.many.rules;
    expect(MM.shadowedBy(rules, 7)).toBe(6);
    expect(MM.shadowedBy(rules, 2)).toBeNull();
    const narrow = { ...rules[3]!, id: "x", match: { projectIds: ["proj_7przffsyfd"], classes: ["warden"] } };
    expect(MM.shadowedBy([rules[3]!, narrow], 1)).toBe(0);
    expect(MM.shadowedBy([{ ...rules[6]!, enabled: false }, narrow], 1)).toBeNull();
  });

  it("places every server problem on its rule and field, and keeps unknown keys", () => {
    const placed = MM.placeProblems([...machineProblems, { key: "machines.rules", message: "At most 50." }]);
    expect(placed.map((p) => [p.rule, MM.problemField(p.field)])).toEqual([[1, "Checkout input fromLaptopBranch"], [2, "Workspace"], [3, "Machine input cores"], [4, "Consent"], [5, "Machine inputs"], [6, "Rule ID"], [null, "Makers per Keeper"], [null, "Rules"]]);
    expect(MM.problemField("match.classes")).toBe("Class");
    expect(MM.editorKey("id")).toBe("label");
  });

  it("reads provider inputs from their schema and never sends an empty value", () => {
    const aquifer = MM.fieldsOf(machinesCatalog.machines.find((m) => m.id === "aquifer")!.inputs);
    expect(aquifer.optional).toBe(true);
    expect(aquifer.fields.find((f) => f.key === "cores")).toMatchObject({ kind: "integer", min: 1, max: 20 });
    expect(aquifer.fields.find((f) => f.key === "world.zones")).toMatchObject({ kind: "strings", maxItems: 32 });
    expect(MM.fieldsOf(machinesCatalog.environments.find((e) => e.id === "world-tree")!.inputs).json).toBe(true);
    expect(MM.writeInput({ cores: 4 }, "cores", "")).toBeUndefined();
    expect(MM.writeInput(undefined, "world.zones", ["areas/infra"])).toEqual({ world: { zones: ["areas/infra"] } });
  });

  it("copies a rule with a new id, off and without its consent", () => {
    const rules = MM.copyRule(machineVolumes.many.rules, 1);
    expect(rules[2]).toMatchObject({ id: "shop-world-remote-copy", enabled: false, consent: MM.NO_CONSENT, label: "Shop/world on an Aquifer machine (copy)" });
    expect(MM.ruleId("Shop/world on an Aquifer machine", ["shop-world-on-an-aquifer-machine"])).toBe("shop-world-on-an-aquifer-machine-2");
    expect(MM.moveRule(rules, 0, -1)).toBeNull();
  });

  it("starts the preview on the most recently active live Keeper, then the last hire here, then the first project", () => {
    expect(MM.defaultHire(machinesRoom, null, machinesCatalog)).toEqual({ mode: "keeper", keeperThreadId: "thr_t3zru37rah", questId: null, classId: "smith" });
    const remembered: MM.Hire = { mode: "project", projectId: "proj_3m7ijbk6gx", keeperPath: "", classId: "warden" };
    expect(MM.defaultHire({ ...machinesRoom, keepers: [] }, remembered, machinesCatalog)).toEqual(remembered);
    expect(MM.defaultHire({ ...machinesRoom, keepers: [] }, null, machinesCatalog)).toMatchObject({ mode: "project", projectId: "proj_v75cbnswyk" });
  });
});

describe("Where work runs page", () => {
  it("lists the rules in order with what they catch, where they send, and their flags", async () => {
    const slot = await page("machines");
    expect(within(ruleRow(slot, 2)).getByText("delta.shopify.io/shop/world")).toBeTruthy();
    expect(within(ruleRow(slot, 2)).getByText("Detection only (remote)")).toBeTruthy();
    expect(within(ruleRow(slot, 5)).getByText("Needs your consent to turn on")).toBeTruthy();
    expect(within(ruleRow(slot, 6)).getByText(/devbox-checkout isn't installed in this bb/)).toBeTruthy();
    expect(within(ruleRow(slot, 8)).getByText(/Never reached/)).toBeTruthy();
    expect(within(ruleRow(slot, 1)).getByText(/^Uppercase durations · Wren, started /)).toBeTruthy();
  });

  it("shows every server problem at its rule, and a summary that lists them", async () => {
    const slot = await page("machines", { settingsUpdate: () => ({ code: "invalid" as const, revision: 12, problems: machineProblems, settings: null }) });
    fireEvent.click(within(ruleRow(slot, 2)).getByRole("switch", { name: "Rule 2 on" }));
    await slot.findByText(/Tavern didn't save/);
    for (const p of machineProblems) {
      const n = p.key.match(/rules\.(\d+)/)?.[1];
      const host = n ? ruleRow(slot, Number(n) + 1) : slot.container.querySelector(".mx-caps") as HTMLElement;
      expect(within(host).getByText((_, el) => el?.getAttribute("data-problem") === p.key)).toBeTruthy();
    }
  });

  it("opens consent instead of saving when an unconsented rule is turned on, and saves all three with it on when accepted", async () => {
    const settingsUpdate = vi.fn((input: Parameters<Handlers["settingsUpdate"]>[0]) => ({ code: "ok" as const, revision: 13, problems: [], settings: viewWith(input.patch.machines as PlacementSettings, 13) }));
    const slot = await page("machines", { settingsUpdate });
    fireEvent.click(within(ruleRow(slot, 5)).getByRole("switch", { name: "Rule 5 on" }));
    const panel = await slot.findByRole("group", { name: "Allow rule 5 to place members on new machines" });
    expect(settingsUpdate).not.toHaveBeenCalled();
    expect([...panel.querySelectorAll(".tag")].map((t) => t.textContent)).toEqual([MM.POSTURE.remote, MM.POSTURE.linuxPi, MM.POSTURE.linuxNoPi]);
    expect(panel.querySelector("input[type=checkbox]")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Accept for rule 5" }));
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledTimes(1));
    const rules = settingsUpdate.mock.calls[0]![0].patch.machines!.rules!;
    expect(rules).toHaveLength(8);
    expect(rules[4]).toMatchObject({ id: "infra-smiths-big", enabled: true, consent: MM.FULL_CONSENT });
    expect(settingsUpdate.mock.calls[0]![0].patch.machines).not.toHaveProperty("maxMakers");
  });

  it("copies a rule off and without consent", async () => {
    const settingsUpdate = vi.fn((input: Parameters<Handlers["settingsUpdate"]>[0]) => ({ code: "ok" as const, revision: 13, problems: [], settings: viewWith(input.patch.machines as PlacementSettings, 13) }));
    const slot = await page("machines", { settingsUpdate });
    fireEvent.click(within(ruleRow(slot, 2)).getByRole("button", { name: "Copy rule 2" }));
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalled());
    expect(settingsUpdate.mock.calls[0]![0].patch.machines!.rules![2]).toMatchObject({ id: "shop-world-remote-copy", enabled: false, consent: MM.NO_CONSENT });
  });

  it("moves a rule by keyboard, keeps focus on it and says where it went", async () => {
    const settingsUpdate = vi.fn((input: Parameters<Handlers["settingsUpdate"]>[0]) => ({ code: "ok" as const, revision: 13, problems: [], settings: viewWith(input.patch.machines as PlacementSettings, 13) }));
    const slot = await page("machines", { settingsUpdate });
    fireEvent.click(slot.getByRole("button", { name: "Move rule 3 down" }));
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalled());
    expect(settingsUpdate.mock.calls[0]![0].patch.machines!.rules!.map((r) => r.id).slice(2, 4)).toEqual(["bb-marketplace-wardens", "world-trees-smiths"]);
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Move rule 4 down"));
    expect(slot.getByText("Rule moved to position 4 of 8. Saved.")).toBeTruthy();
  });

  it("deletes a rule with an Undo that restores it through settingsUndo", async () => {
    const settingsUndo = vi.fn(() => ({ code: "ok" as const, revision: 14, problems: [], settings: viewWith(machineVolumes.many, 14) }));
    const slot = await page("machines", { settingsUndo });
    fireEvent.click(within(ruleRow(slot, 2)).getByRole("button", { name: "Delete rule 2" }));
    await slot.findByText("Rule 2 deleted. Saved.");
    fireEvent.click(slot.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(settingsUndo).toHaveBeenCalledWith(expect.objectContaining({ id: "d13", revision: 13 })));
  });

  it("answers the preview on load for the most recently active Keeper, and for a project with no Keeper", async () => {
    const placementPreview = vi.fn((input: Parameters<Handlers["placementPreview"]>[0]) => previewFixture(machineVolumes.many, input));
    const slot = await page("machines", { placementPreview });
    await waitFor(() => expect(placementPreview).toHaveBeenCalledWith({ projectId: null, keeperThreadId: "thr_t3zru37rah", keeperPath: null, classId: "smith", questId: null }));
    fireEvent.click(slot.getByRole("button", { name: "A project" }));
    fireEvent.change(slot.getByLabelText("Project"), { target: { value: "proj_3m7ijbk6gx" } });
    const verdict = await slot.findByText(/Runs on a new Aquifer World sandbox/);
    expect(verdict.closest("[data-verdict]")!.textContent).toMatch(/Because repository is delta\.shopify\.io\/shop\/world/);
    expect(within(ruleRow(slot, 2)).getByText("catches it")).toBeTruthy();
    expect(within(ruleRow(slot, 1)).getByText("no quest yet")).toBeTruthy();
  });

  it("shows a supported machine rule's destination, posture and slot from the preview", async () => {
    const slot = await page("machines");
    fireEvent.click(slot.getByRole("button", { name: "A project" }));
    fireEvent.change(slot.getByLabelText("Project"), { target: { value: "proj_3m7ijbk6gx" } });
    const verdict = (await slot.findByText(/Runs on a new Aquifer World sandbox/)).closest("[data-verdict]") as HTMLElement;
    expect(verdict.dataset.verdict).toBe("caught");
    expect(within(verdict).getByText("Detection only (remote)")).toBeTruthy();
    expect(within(verdict).getByRole("button", { name: /Rule 2 · Shop\/world on an Aquifer machine/ })).toBeTruthy();
    expect(verdict.textContent).toContain("Preview only: nothing is created.");
    expect(verdict.textContent).toContain("Takes a maker slot: 0 of 4 in use. Party ceiling 5.");
    expect(verdict.textContent).not.toMatch(/Blocked|waits with a blocker|When it runs/);
    expect(within(ruleRow(slot, 2)).getByText("catches it")).toBeTruthy();
  });

  it("shows the server's unsupported-target refusal on the verdict and matched rule", async () => {
    const rule = machineVolumes.many.rules[1]!;
    if (rule.target.kind !== "provider") throw new Error("Expected a provider fixture.");
    const unsupported = { ...machineVolumes.many, rules: [{ ...rule, match: {}, target: { ...rule.target, machine: { type: "keeper" as const }, workspace: "linked-worktree" as const } }] };
    const slot = await page("machines", {}, unsupported);
    const message = await slot.findByText("This rule's target isn't supported in this version.");
    expect(message.closest('[data-verdict="blocked"]')).not.toBeNull();
    expect(within(ruleRow(slot, 1)).getByText("catches it, blocked")).toBeTruthy();
    expect(slot.queryByText(/Today it waits.*can't run work yet/)).toBeNull();
  });

  it("keeps a rule that sends work where it runs today unchanged", async () => {
    const stay = { ...machineVolumes.many.rules[0]!, id: "all-stay", label: "Everything stays", match: {} };
    const slot = await page("machines", {}, { ...machineVolumes.many, rules: [stay, ...machineVolumes.many.rules.slice(1)] });
    const verdict = (await slot.findByText("Runs where it runs today.")).closest("[data-verdict]") as HTMLElement;
    expect(verdict.textContent).not.toMatch(/Would run|waits with a blocker|depends on the Keeper/);
  });

  it("says where a hire no rule catches runs today in plain words, never the server's posture sentence", async () => {
    // Live on b2080590: the server's compatibility posture and its no-Keeper warning were printed raw, and "'s machine" followed a thread title.
    const warning = "Without a Keeper, project metadata and the optional path are hypothetical, not admission proof.";
    const compat = async (input: Parameters<Handlers["placementPreview"]>[0]) => {
      const { warningDetails: _details, ...preview } = await previewFixture(machineVolumes.empty, input);
      return { ...preview, warnings: [warning] };
    };
    const slot = await page("machines", { placementPreview: compat }, machineVolumes.empty);
    const verdict = (await slot.findByText("No rule catches it.")).closest("[data-verdict]") as HTMLElement;
    expect(verdict.textContent).toContain("Runs where it runs today: on Wren's machine (Find plugins missing from README table).");
    expect(verdict.textContent).toContain("The guard this hire gets today still applies. No machine slot is taken.");
    expect(verdict.textContent).toContain("There's no Keeper behind this hire yet, so its project and path are assumed: a real hire can still land differently.");
    expect(verdict.textContent).not.toMatch(/execution posture|applies as it does now|admission proof|table's machine/);
  });

  it("words each coded preview warning, keeping the server's text as detail only where it says something new", async () => {
    const coded = async (input: Parameters<Handlers["placementPreview"]>[0]) => ({ ...await previewFixture(machineVolumes.empty, input),
      warnings: ["Without a Keeper, project metadata and the optional path are hypothetical, not admission proof.", "ENOENT: /work/vault"],
      warningDetails: [{ code: "no-keeper" as const, text: "Without a Keeper, project metadata and the optional path are hypothetical, not admission proof." }, { code: "source-unreadable" as const, text: "ENOENT: /work/vault" }] });
    const slot = await page("machines", { placementPreview: coded }, machineVolumes.empty);
    const verdict = (await slot.findByText("No rule catches it.")).closest("[data-verdict]") as HTMLElement;
    expect(verdict.textContent).toContain("There's no Keeper behind this hire yet, so its project and path are assumed: a real hire can still land differently.");
    expect(verdict.textContent).toContain("Tavern couldn't read this Keeper's checkout, so a rule that matches its path, home or remote may not catch it. ENOENT: /work/vault");
    expect(verdict.textContent).not.toContain("admission proof");
  });

  it("keeps the period with the settings link under the caps, so it never wraps alone", async () => {
    const slot = await page("machines", {}, machineVolumes.empty);
    const link = await slot.findByRole("link", { name: "Keepers and decisions" });
    expect(link.parentElement!.className).toBe("mx-nowrap");
    expect(link.parentElement!.textContent).toBe("Keepers and decisions.");
  });

  it("names the Keeper alone when no other Keeper shares its name", async () => {
    const one = { ...structuredClone(machinesRoom), keepers: [structuredClone(machinesRoom.keepers[0]!), structuredClone(machinesRoom.keepers[3]!)] };
    const slot = await page("machines", { room: () => one }, machineVolumes.empty);
    const verdict = (await slot.findByText("No rule catches it.")).closest("[data-verdict]") as HTMLElement;
    expect(verdict.textContent).toContain("on Wren's machine.");
    expect(verdict.textContent).toContain("The guard this hire gets today still applies.");
  });

  it("shows the server's preview warnings with the verdict", async () => {
    const warning = "No Keeper works in this project yet, so the Keeper's path and environment are unknown.";
    const slot = await page("machines", { placementPreview: async (input) => {
      const { warningDetails: _details, ...preview } = await previewFixture(machineVolumes.many, input);
      return { ...preview, warnings: [warning] };
    } });
    const verdict = (await slot.findByText(warning)).closest("[data-verdict]");
    expect(verdict).toBeTruthy();
  });

  it("previews a hire caught by a rule with a missing provider as blocked, never as the laptop", async () => {
    const slot = await page("machines");
    fireEvent.click(slot.getByRole("button", { name: "A project" }));
    fireEvent.change(slot.getByLabelText("Project"), { target: { value: "proj_mddz3fcct5" } });
    fireEvent.click(slot.getByRole("button", { name: /^Ranger/ }));
    const verdict = (await slot.findByText("Blocked.")).closest("[data-verdict]")!;
    expect(verdict.textContent).toMatch(/devbox-checkout is not installed/);
    expect(verdict.classList.contains("blocked")).toBe(true);
    expect(verdict.classList.contains("waits")).toBe(false);
    expect(verdict.textContent).not.toMatch(/laptop|MacBook/i);
  });

  it("opens at a rule from a blocked hire and focuses it", async () => {
    const slot = await page("machines/devbox-rangers");
    await waitFor(() => expect(document.activeElement).toBe(ruleRow(slot, 6)));
    expect(slot.getByText(/Opened from a placement rule/)).toBeTruthy();
  });

  it("blocks every hire while the stored rules can't be read, and repairs with a full replacement", async () => {
    const settingsUpdate = vi.fn(() => ({ code: "ok" as const, revision: 13, problems: [], settings: viewWith(machineVolumes.empty, 13) }));
    const slot = await page("machines", { settings: () => settingsViewSchema.parse({ ...viewWith(machineVolumes.empty), placementPolicy: { state: "invalid", revision: 12, problems: [{ path: "machines.rules.2.target", message: "Invalid input" }] } }), settingsUpdate });
    expect(await slot.findByText(/Placement is blocked/)).toBeTruthy();
    expect((await slot.findByText(/Every hire waits until the saved rules can be read again/)).closest("[data-verdict]")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Start from no rules" }));
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledWith(expect.objectContaining({ patch: { machines: { rules: [] } } })));
  });

  it("sends only the cap that changed", async () => {
    const settingsUpdate = vi.fn((input: Parameters<Handlers["settingsUpdate"]>[0]) => ({ code: "ok" as const, revision: 13, problems: [], settings: viewWith({ ...machineVolumes.many, ...input.patch.machines } as PlacementSettings, 13) }));
    const slot = await page("machines", { settingsUpdate });
    const field = slot.getByLabelText("Makers per Keeper");
    fireEvent.change(field, { target: { value: "6" } });
    fireEvent.blur(field);
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledWith(expect.objectContaining({ patch: { machines: { maxMakers: 6 } } })));
  });

  it("says when settings changed somewhere else", async () => {
    const slot = await page("machines", { settingsUpdate: () => ({ code: "stale" as const, revision: 13, problems: [], settings: null }) });
    fireEvent.click(within(ruleRow(slot, 2)).getByRole("switch", { name: "Rule 2 on" }));
    expect(await slot.findByText(/Settings changed somewhere else, so nothing was saved/)).toBeTruthy();
  });

  it("adds a rule through the editor, last, with an id from its name", async () => {
    const settingsUpdate = vi.fn((input: Parameters<Handlers["settingsUpdate"]>[0]) => ({ code: "ok" as const, revision: 13, problems: [], settings: viewWith(input.patch.machines as PlacementSettings, 13) }));
    const slot = await page("machines", { settingsUpdate }, machineVolumes.one);
    fireEvent.click(slot.getByRole("button", { name: "Add a rule" }));
    const form = await slot.findByRole("form", { name: "New rule 2" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Keep cortex local" } });
    fireEvent.click(within(form).getByRole("button", { name: "Another machine" }));
    fireEvent.change(within(form).getByRole("combobox", { name: "Machine and checkout" }), { target: { value: "custom" } });
    const machine = within(form).getByRole<HTMLSelectElement>("combobox", { name: "Machine" });
    fireEvent.change(machine, { target: { value: "project-checkout" } });
    expect(machine.disabled).toBe(false);
    expect(settingsUpdate).not.toHaveBeenCalled();
    fireEvent.click(within(form).getByRole("button", { name: "Where it runs today" }));
    fireEvent.click(within(form).getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalled());
    expect(settingsUpdate.mock.calls[0]![0].patch.machines!.rules![1]).toMatchObject({ id: "keep-cortex-local", label: "Keep cortex local", match: {}, target: { kind: "current" } });
  });

  it("keeps an open rule form, its draft and the field being edited when the page remounts or the editor changes column", async () => {
    const slot = await page("machines", {}, machineVolumes.one);
    fireEvent.click(slot.getByRole("button", { name: "Add a rule" }));
    const name = within(await slot.findByRole("form", { name: "New rule 2" })).getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Keep cortex local" } });
    name.focus(); name.setSelectionRange(4, 4); fireEvent.select(name);
    // bb remounts the page when its layout switches to the phone: the form must come back as it was.
    slot.lifecycle.unmount(); slots.splice(slots.indexOf(slot), 1);
    const again = await page("machines", {}, machineVolumes.one);
    const back = within(await again.findByRole("form", { name: "New rule 2" })).getByLabelText("Name") as HTMLInputElement;
    expect(back.value).toBe("Keep cortex local");
    expect(document.activeElement).toBe(back);
    expect([back.selectionStart, back.selectionEnd]).toEqual([4, 4]);
    // And again, the way back from the phone: the caret is still where the person left it.
    again.lifecycle.unmount(); slots.splice(slots.indexOf(again), 1);
    const twice = await page("machines", {}, machineVolumes.one);
    const name2 = within(await twice.findByRole("form", { name: "New rule 2" })).getByLabelText("Name") as HTMLInputElement;
    expect([document.activeElement === name2, name2.selectionStart, name2.selectionEnd]).toEqual([true, 4, 4]);
    slots.splice(slots.indexOf(twice), 1); twice.lifecycle.unmount();
    const thrice = await page("machines", {}, machineVolumes.one);
    fireEvent.click(within(await thrice.findByRole("form", { name: "New rule 2" })).getByRole("button", { name: "Cancel" }));
    thrice.lifecycle.unmount(); slots.splice(slots.indexOf(thrice), 1);
    const closed = await page("machines", {}, machineVolumes.one);
    expect(closed.queryByRole("form", { name: "New rule 2" })).toBeNull();
  });

  it("keeps an untouched open form too, and forgets a rule's draft when the rule is deleted, so Undo never reopens it", async () => {
    const slot = await page("machines", {}, machineVolumes.many);
    fireEvent.click(within(ruleRow(slot, 2)).getByRole("button", { name: "Edit rule 2" }));
    await slot.findByRole("form", { name: "Edit rule 2" });
    slot.lifecycle.unmount(); slots.splice(slots.indexOf(slot), 1);
    const again = await page("machines", {}, machineVolumes.many);
    await again.findByRole("form", { name: "Edit rule 2" });
    fireEvent.click(within(ruleRow(again, 2)).getByRole("button", { name: "Delete rule 2" }));
    await again.findByText("Rule 2 deleted. Saved.");
    await waitFor(() => expect(again.queryByRole("form", { name: /rule 2/i })).toBeNull());
    again.lifecycle.unmount(); slots.splice(slots.indexOf(again), 1);
    const later = await page("machines", {}, machineVolumes.many);
    expect(later.queryByRole("form")).toBeNull();
  });

  it("drops a kept draft when the saved rule changed meanwhile, so saving never reverts the newer change", async () => {
    const slot = await page("machines", {}, machineVolumes.many);
    fireEvent.click(within(ruleRow(slot, 2)).getByRole("button", { name: "Edit rule 2" }));
    fireEvent.change(within(await slot.findByRole("form", { name: "Edit rule 2" })).getByLabelText("Name"), { target: { value: "My old draft" } });
    slot.lifecycle.unmount(); slots.splice(slots.indexOf(slot), 1);
    // Saved from another device while the draft waited.
    const newer = structuredClone(machineVolumes.many);
    newer.rules[1] = { ...newer.rules[1]!, label: "Renamed elsewhere" };
    const again = await page("machines", { settings: () => viewWith(newer, 20) }, newer);
    const form = await again.findByRole("form", { name: "Edit rule 2" });
    expect((within(form).getByLabelText("Name") as HTMLInputElement).value).toBe("Renamed elsewhere");
    expect(within(form).getByRole("status").textContent).toMatch(/This rule changed since you started editing/);
  });

  it("keeps a failed save's draft without calling it changed elsewhere when the editor moves to the other column", async () => {
    const observers = new Set<() => void>();
    let gridWidth = 700;
    const savedRO = globalThis.ResizeObserver, savedRect = Element.prototype.getBoundingClientRect;
    globalThis.ResizeObserver = class { constructor(private cb: () => void) {} observe() { observers.add(this.cb); } unobserve() {} disconnect() { observers.delete(this.cb); } } as unknown as typeof ResizeObserver;
    Element.prototype.getBoundingClientRect = function (this: Element) { return { width: this.classList.contains("mx-grid") ? gridWidth : 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect; };
    try {
      const slot = await page("machines", { settingsUpdate: () => ({ code: "invalid" as const, revision: 12, problems: machineProblems, settings: null }) }, machineVolumes.many);
      act(() => { for (const cb of [...observers]) cb(); });
      fireEvent.click(within(ruleRow(slot, 2)).getByRole("button", { name: "Edit rule 2" }));
      const form = await slot.findByRole("form", { name: "Edit rule 2" });
      fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Not saved yet" } });
      fireEvent.click(within(form).getByRole("button", { name: "Save rule" }));
      await slot.findByText(/Tavern didn't save/);
      gridWidth = 1200; act(() => { for (const cb of [...observers]) cb(); });
      const moved = await slot.findByRole("form", { name: "Edit rule 2" });
      await waitFor(() => expect(moved.closest(".mx-side")).not.toBeNull());
      expect((within(moved).getByLabelText("Name") as HTMLInputElement).value).toBe("Not saved yet");
      expect(within(moved).queryByText(/This rule changed since you started editing/)).toBeNull();
    } finally { globalThis.ResizeObserver = savedRO; Element.prototype.getBoundingClientRect = savedRect; }
  });

  it("keys raw rules without ids by their place in repair mode, so Edit opens the rule asked for and keeps it", async () => {
    const raw = JSON.stringify({ rules: [{ label: "First raw", enabled: true, match: {}, target: { kind: "current" } }, { label: "Second raw", enabled: true, match: { classes: ["smith"] }, target: { kind: "current" } }] });
    const settings = () => settingsViewSchema.parse({ ...viewWith(machineVolumes.empty), placementPolicy: { state: "invalid", revision: 12, problems: [{ path: "machines.rules.1.id", message: "Required" }] }, placementRawJson: raw });
    const slot = await page("machines", { settings }, machineVolumes.empty);
    fireEvent.click(within(ruleRow(slot, 2)).getByRole("button", { name: "Edit rule 2" }));
    const form = await slot.findByRole("form", { name: "Edit rule 2" });
    expect((within(form).getByLabelText("Name") as HTMLInputElement).value).toBe("Second raw");
    slot.lifecycle.unmount(); slots.splice(slots.indexOf(slot), 1);
    const again = await page("machines", { settings }, machineVolumes.empty);
    expect((within(await again.findByRole("form", { name: "Edit rule 2" })).getByLabelText("Name") as HTMLInputElement).value).toBe("Second raw");
  });

  it("does not show the retired machine-rules preview banner", async () => {
    const slot = await page("machines");
    expect(slot.queryByRole("status", { name: "Preview" })).toBeNull();
    expect(slot.queryByText(/work can't run on other machines yet/)).toBeNull();
  });

  it("is on: in the sidebar, the phone page picker and settings", async () => {
    const actual = await vi.importActual<typeof import("../../../src/ui/page/machines-contract")>("../../../src/ui/page/machines-contract");
    expect(actual.PLACEMENT_RPC_LIVE).toBe(true);
    const slot = await page("machines");
    const picker = slot.getByRole("combobox", { name: "Tavern page" }) as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toContain("machines");
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    expect(plugin.settingsSections.some((s) => s.id === "machines")).toBe(true);
    const side = renderSlot({ component: plugin.navPanels[0]!.experimental_sidebar! }, { subPath: "machines" }, { pluginId: "tavern", experimental_rpcContract: contract, rpc: { room: () => machinesRoom, registry: () => registry } as Partial<Handlers> as Handlers });
    slots.push(side);
    const link = await within(side.container).findByRole("button", { name: /Where work runs/ });
    expect(link.getAttribute("aria-current")).toBe("page");
  });

  it("says the preview isn't available yet and stays out of the sidebar until the server serves it", async () => {
    live.value = false;
    const slot = await page("machines");
    expect(await slot.findByText(/Not available yet/)).toBeTruthy();
    expect(slot.container.querySelector("[data-verdict]")).toBeNull();
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const side = renderSlot({ component: plugin.navPanels[0]!.experimental_sidebar! }, { subPath: "room" }, { pluginId: "tavern", experimental_rpcContract: contract, rpc: { room: () => machinesRoom, registry: () => registry } as Partial<Handlers> as Handlers });
    slots.push(side);
    await within(side.container).findByText("Common room");
    expect(within(side.container).queryByText("Where work runs")).toBeNull();
  });
});

describe("Where work runs in settings", () => {
  it("summarises the rules and links to the page", async () => {
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const section = plugin.settingsSections.find((s) => s.id === "machines");
    expect(section).toBeTruthy();
    const slot = renderSlot(section!, {}, { pluginId: "tavern", experimental_rpcContract: contract, rpc: { settings: () => viewWith(machineVolumes.many), placementCatalog: () => machinesCatalog } as Partial<Handlers> as Handlers });
    slots.push(slot);
    expect(await slot.findByText("8 rules, 7 on. 2 need you. 4 makers and 2 checkers per Keeper.")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: /Open Where work runs/ }));
    await act(async () => {});
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", options: { subPath: "machines" } });
  });
});
