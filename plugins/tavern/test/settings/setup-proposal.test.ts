// @vitest-environment node
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import tavern from "../../server";
import { KeeperStore } from "../../src/server/keeper/store";
import { SettingsStore } from "../../src/server/settings/store";
import { Keeper } from "../../src/server/keeper/service";
import { fakePort } from "../server/support";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanups.splice(0)) await dispose(); });

const forge = `[[machines.forges]]
id = "drafts"
name = "Draft pull requests"
kind = "command"
open = "/opt/bin/open-draft"
`;
const cap = "[keepers]\nparty_max = 6\n";
const rule = `[[machines.rules]]
id = "dedicated"
label = "Dedicated"
enabled = true
match = {}
target = { kind = "provider", environment_provider_id = "isolated", workspace = "dedicated-machine", machine = { type = "new", machine_provider_id = "new-host" } }
consent = { guard_install = true, remote_detection_only = true, linux_uncontained_checks = true }
class_models = { smith = { provider = "engine", model = "next" } }
`;
const model = `[classes.smith]
provider = "engine"
model = "next"`;

async function fixture({ missing = false, failed = false, modelOffered = true, ruleOffered = true } = {}) {
  const probe = vi.fn(async (_input: unknown) => failed ? [{ key: "machines.forges.0.open", status: "fail", message: "Probe failed with exit code 7." }] : []);
  const inspect = vi.fn(async (_input: unknown) => missing ? [{ key: "machines.forges.0.open", status: "fail", message: "Script does not exist." }] : [{ key: "machines.forges.0.open", status: "pass", message: "Executable file outside agent workspaces.", resolvedPath: "/opt/bin/real-open-draft" as string | undefined }]);
  const models = vi.fn(async () => ({ modelLoadError: null, models: modelOffered ? [{ model: "next", id: "engine/next", isDefault: true, supportedReasoningEfforts: [] }] : [] }));
  const { bb, harness } = createFakePluginHost({ pluginId: "tavern", experimental_declaredIconNames: ["tavern"], experimental_hostEntry: true, sdk: {
    projects: { list: async () => [{ sources: [{ hostId: "home", path: "/registered-checkout" }] }] },
    system: { config: async () => ({ primaryHostId: "home" }) },
    threads: { get: async () => ({ environmentId: "active-environment" }), storageLocation: async () => ({ hostId: "home", storageRootPath: "/storage/agent" }) },
    hosts: { get: async () => ({ threadStorageRootPath: "/storage", id: "home" }), experimental_listProviders: async () => [{ id: "new-host" }] },
    environments: { get: async () => ({ id: "active-environment", hostId: "existing-host" }), list: async () => [{ path: "/shared-checkout", isWorktree: false }], listProviders: async () => ruleOffered ? [{ id: "isolated", machineProviderId: "new-host", availability: { status: "available" } }] : [] },
    providers: { list: async () => [{ id: "engine", available: true }], models },
  }, experimental_callHostRpc: async ({ method, input }) => {
    if (method === "setupForgeInspect") return inspect(input);
    if (method === "setupForgeProbe") return probe(input);
    throw new Error("Unexpected native call: " + method);
  } });
  cleanups.push(() => harness.lifecycle.dispose());
  await tavern(bb);
  const run = (args: string[], threadId = "agent") => harness.behavior.runCli(["setup", ...args], { threadId });
  const propose = async (toml: string, reasons: Record<string, string>) => {
    const result = await run(["propose", "--toml", toml, "--reasons", JSON.stringify(reasons)]);
    expect(result.exitCode, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  const rpc = harness.behavior.callRpc;
  const read = () => rpc("settings", null);
  const events = () => new KeeperStore(bb.storage.database()).events().filter(e => e.type === "authority.acted" && (e.data as { act?: string }).act?.startsWith("setup"));
  return { run, propose, rpc, read, inspect, probe, models, events, db: bb.storage.database() };
}

it("proposes without a settings grant, does not probe before Apply, and applies a preset as one patch and one user receipt", async () => {
  const f = await fixture();
  await f.rpc("settingsUpdate", { revision: 0, why: "Outside the preset", patch: { tavern: { agentsMayChangeSettings: false }, journal: { journalReminders: false }, classes: { smith: { provider: "engine" } } } });
  const before = await f.read();
  const p = await f.propose(forge + cap + "\n[classes.smith]\nmodel = \"next\"\n", { "machines.forges": "Open drafts from the source host.", "keepers.partyMax": "Leave room for a second checker.", "classes.smith.model": "Use the model you picked." });
  expect(p.directive).toBe(`::tavern-setup{id="${p.id}"}`);
  expect(p).toMatchObject({ revision: 1, state: "pending", changes: expect.arrayContaining([{ key: "keepers.partyMax", from: 5, to: 6, kind: "set", reason: "Leave room for a second checker." }]), preflight: [{ key: "machines.forges.0.open", status: "pass" }, { key: "classes.smith.model", status: "pass" }] });
  expect(await f.read()).toEqual(before);
  expect(f.inspect).toHaveBeenCalledTimes(1);
  expect(f.probe).not.toHaveBeenCalled();
  expect(await f.rpc("setupProposal", { id: p.id })).toMatchObject({ state: "pending", id: p.id });
  expect(await f.rpc("setupPending", null)).toMatchObject([{ state: "pending", id: p.id }]);
  expect(await f.rpc("setupApply", { id: p.id })).toMatchObject({ state: "applied", decisionId: expect.any(String) });
  expect(f.inspect).toHaveBeenCalledTimes(2);
  expect(f.inspect).toHaveBeenLastCalledWith(expect.objectContaining({ blockedRoots: expect.arrayContaining(["/registered-checkout", "/shared-checkout"]), git: "full",
    forges: [{ index: 0, profile: expect.objectContaining({ open: "/opt/bin/real-open-draft" }) }] }));
  expect(f.probe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ git: "full" }));
  expect(await f.read()).toMatchObject({ revision: 2, effective: { journal: { journalReminders: false }, tavern: { agentsMayChangeSettings: false }, machines: { forges: [{ id: "drafts", open: "/opt/bin/real-open-draft" }] }, keepers: { partyMax: 6 }, classes: { smith: { model: "next", provider: "engine" } } } });
  expect(f.events()).toMatchObject([{ actor: { kind: "user" }, data: { act: "setupApply", surface: "client (unattested)", references: { id: p.id } } }]);
  expect(await f.rpc("setupPending", null)).toEqual([]);
});

it("reports missing paths before Apply without probing, and writes nothing if a probe fails", async () => {
  const reason = { "machines.forges": "Open drafts." };
  const missing = await fixture({ missing: true });
  const p = await missing.propose(forge, reason);
  expect(p.preflight).toMatchObject([{ status: "fail", message: "Script does not exist." }]);
  const b = await missing.read();
  expect(await missing.rpc("setupApply", { id: p.id })).toMatchObject({ state: "pending", preflight: [{ status: "fail" }] });
  expect(missing.probe).not.toHaveBeenCalled();
  expect(await missing.read()).toEqual(b);

  const failed = await fixture({ failed: true });
  const q = await failed.propose(forge + cap, { ...reason, "keepers.partyMax": "Raise the ceiling." });
  const before = await failed.read();
  expect(failed.probe).not.toHaveBeenCalled();
  expect(await failed.rpc("setupApply", { id: q.id })).toMatchObject({ state: "pending", preflight: [{ status: "fail", message: "Probe failed with exit code 7." }] });
  expect(await failed.read()).toEqual(before);
  expect(failed.events()).toEqual([]);
  expect(await failed.rpc("setupProposal", { id: q.id })).toMatchObject({ preflight: [{ status: "fail" }] });
});

it("refuses agent Apply and Dismiss, has no CLI Apply, and never probes a conflict on a named key", async () => {
  const f = await fixture();
  const p = await f.propose(forge, { "machines.forges": "Open drafts." });
  for (const method of ["setupApply", "setupDismiss"]) {
    await expect(f.rpc(method, { id: p.id }, { experimental_caller: { kind: "plugin", pluginId: "tavern" } })).rejects.toMatchObject({ code: "forbidden" });
    await expect(f.rpc(method, { id: p.id }, { experimental_caller: { kind: "client", threadId: "agent" } } as never)).rejects.toMatchObject({ code: "forbidden" });
  }
  expect((await f.run(["apply", p.id], "member")).stderr).toMatch(/unknown command/i);
  await f.rpc("settingsUpdate", { revision: 0, patch: { machines: { forges: [{ id: "other", kind: "github", name: "Other" }] } }, why: "Change a named array" });
  const changedAt = new SettingsStore(f.db).snapshot().history[0]!.at;
  for (const method of ["setupApply", "setupProposal"]) {
    expect(await f.rpc(method, { id: p.id })).toMatchObject({ state: "stale", conflicts: [{ key: "machines.forges", at: changedAt }] });
  }
  expect(f.probe).not.toHaveBeenCalled();
  expect(await f.rpc("setupDismiss", { id: p.id })).toMatchObject({ state: "dismissed" });
  expect(await f.rpc("setupPending", null)).toEqual([]);
  expect(f.events()).toMatchObject([{ data: { act: "setupDismiss" } }]);
});

it("stores the proposer's class and timestamp without applying a member's proposal", async () => {
  const f = await fixture();
  new Keeper(new KeeperStore(f.db), fakePort()).bind("agent", "smith", null, "project", undefined, "setup-proposal-fixture");
  const p = await f.propose(cap, { "keepers.partyMax": "Leave room for another checker." });
  expect(p).toMatchObject({ threadId: "agent", classId: "smith", proposedAt: expect.any(Number), state: "pending" });
  expect(await f.read()).toMatchObject({ revision: 0 });
});

it("rebases a named patch after unrelated tuning and preserves that tuning", async () => {
  const f = await fixture(), store = new SettingsStore(f.db);
  store.update({ revision: 0, patch: { tuning: { mode: "apply" } }, why: "Enable tuning" });
  const p = await f.propose(cap, { "keepers.partyMax": "Raise the ceiling." });
  store.applyTuned({ tickSeconds: 95 }, "Measured", { section: "ticks", chart: "pacing" });
  expect(await f.rpc("setupProposal", { id: p.id })).toMatchObject({ state: "pending" });
  expect(await f.rpc("setupApply", { id: p.id })).toMatchObject({ state: "applied" });
  expect(store.read()).toMatchObject({ keepers: { partyMax: 6 }, knobs: { tickSeconds: 95 } });
});

it("applies knob and motion changes through Settings update semantics", async () => {
  const f = await fixture(), store = new SettingsStore(f.db);
  store.update({ revision: 0, patch: { tuning: { mode: "apply" } }, pins: { staleMinutes: 25 }, why: "Enable tuning and pin quiet time" });
  store.applyTuned({ tickSeconds: 95 }, "Measured", { section: "ticks", chart: "pacing" });
  const p = await f.propose("[knobs]\ntick_seconds = 75\nstale_minutes = 26\n[tavern]\nambient_motion = \"off\"\n", {
    "knobs.tickSeconds": "Set a fixed interval.", "knobs.staleMinutes": "Update the pin.", "tavern.ambientMotion": "Stop movement.",
  });
  expect(await f.rpc("setupApply", { id: p.id })).toMatchObject({ state: "applied" });
  expect(store.snapshot()).toMatchObject({ effective: { knobs: { tickSeconds: 75, staleMinutes: 26 }, tavern: { ambientMotion: "off", hearthFlicker: false } }, pinned: { staleMinutes: 26 }, tuned: {} });
  expect(store.snapshot().tuned).not.toHaveProperty("tickSeconds");
});

it("does not report writing the current default as a change", async () => {
  const f = await fixture();
  const p = await f.propose(cap + "[tavern]\npaused = false\n", { "keepers.partyMax": "Raise the ceiling." });
  expect(p.changes.map((line: {key:string}) => line.key)).toEqual(["keepers.partyMax"]);
  await f.rpc("setupApply", { id: p.id });
  expect(await f.read()).toMatchObject({ user: { keepers: { partyMax: 6 } } });
  expect(await f.read()).not.toHaveProperty("user.tavern.paused");
});

it("does not preflight a class whose named fields are unchanged", async () => {
  const f = await fixture({ modelOffered: false });
  await f.rpc("settingsUpdate", { revision: 0, patch: { classes: { smith: { provider: "engine", model: "next" } } }, why: "Keep the current override" });
  const p = await f.propose(cap + model, { "keepers.partyMax": "Raise the ceiling." });
  expect(p.preflight).toEqual([]);
  expect(f.models).not.toHaveBeenCalled();
  expect(await f.rpc("setupApply", { id: p.id })).toMatchObject({ state: "applied" });
});

it("rechecks file paths on Apply and never probes when the path changed", async () => {
  const f = await fixture();
  const p = await f.propose(forge, { "machines.forges": "Open drafts." });
  expect(p.changes[0].to[0].open).toBe("/opt/bin/real-open-draft");
  f.inspect.mockResolvedValueOnce([{ key: "machines.forges.0.open", status: "fail", message: "Script does not exist." }]);
  expect(await f.rpc("setupApply", { id: p.id })).toMatchObject({ state: "pending", preflight: [{ status: "fail" }] });
  expect(f.inspect).toHaveBeenCalledTimes(2);
  expect(f.probe).not.toHaveBeenCalled();
  expect(await f.read()).toMatchObject({ revision: 0 });
});

it("shows models on new machines as unchecked, but blocks missing primary-host models or missing rule providers", async () => {
  const f = await fixture({ modelOffered: false });
  const reasons = { "machines.rules": "Use a separate machine." };
  const p = await f.propose(rule, reasons);
  expect(p.preflight).toMatchObject([{ key: "machines.rules.0.target", status: "pass" }, { key: "machines.rules.0.classModels.smith", status: "unchecked", message: expect.stringContaining("No machine exists") }]);
  expect(f.models).not.toHaveBeenCalled();
  expect(await f.rpc("setupApply", { id: p.id })).toMatchObject({ state: "applied" });
  const q = await f.propose(model, { "classes.smith.provider": "Use this engine.", "classes.smith.model": "Use this model." });
  expect(q.preflight).toMatchObject([{ key: "classes.smith.model", status: "fail" }]);
  expect(f.models).toHaveBeenCalledWith(expect.objectContaining({ hostId: "home", providerId: "engine" }));
  expect(await f.rpc("setupApply", { id: q.id })).toMatchObject({ state: "pending" });
  const g = await fixture({ ruleOffered: false });
  const r = await g.propose(rule, reasons);
  expect(r.preflight).toMatchObject([{ key: "machines.rules.0.target", status: "fail" }, { status: "unchecked" }]);
});

it("uses the existing environment for a rule inheriting the source environment", async () => {
  const f = await fixture();
  const current = `[[machines.rules]]
id = "existing"
label = "Existing environment"
enabled = true
match = {}
target = { kind = "current" }
class_models = { smith = { provider = "engine", model = "next" } }`;
  const p = await f.propose(current, { "machines.rules": "Keep work on the current environment." });
  expect(f.models).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ environmentId: "active-environment", providerId: "engine" }));
  expect(p.preflight).toMatchObject([{ key: "machines.rules.0.classModels.smith", status: "pass" }]);
});

it("rolls back settings and the proposal transition when the user-act receipt cannot be written", async () => {
  const f = await fixture();
  const p = await f.propose(cap, { "keepers.partyMax": "Co-locate small review parties." });
  f.db.exec(`CREATE TRIGGER fail_setup_receipt BEFORE INSERT ON tavern_events
    WHEN NEW.type = 'authority.acted' BEGIN SELECT RAISE(ABORT, 'test receipt failure'); END;`);
  const before = await f.read();
  expect(await f.rpc("setupApply", { id: p.id })).toMatchObject({ state: "pending", preflight: [{ status: "fail", message: "test receipt failure" }] });
  expect(await f.read()).toEqual(before);
  expect(await f.rpc("setupProposal", { id: p.id })).toMatchObject({ state: "pending", decisionId: null });
  expect(f.events()).toEqual([]);
});

it("requires one single-line reason for every changed key before storing a proposal", async () => {
  const f = await fixture();
  const result = await f.run(["propose", "--toml", cap, "--reasons", JSON.stringify({ "unrelated.key": "Wrong key." })]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("keepers.partyMax");
  expect(await f.rpc("setupPending", null)).toEqual([]);
});
