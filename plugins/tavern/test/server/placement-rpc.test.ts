// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { worktreeProvider } from "./environment-fixture";
import { registerRpc } from "../../src/server/rpc";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights";
import { placementRuleSchema } from "../../src/shared/placement-settings";
import { PlacementStore } from "../../src/server/placement/store";
import { placementHandlers } from "../../src/server/placement/rpc";
import { placementRecord } from "./placement-fixture";
import { placementWarningSchema, type PlacementPreviewInput } from "../../src/shared/placement-rpc";
import type { KnownSource } from "../../src/server/placement/source-discovery";

const project = { id: "project", name: "Project", kind: "standard", gitRemoteUrl: "https://secret@example.com/org/repo.git?token=secret", sources: [
  { id: "source", projectId: "project", hostId: "host", path: "/project", isDefault: true, type: "local_path", createdAt: 1, updatedAt: 1 },
], createdAt: 1, updatedAt: 1 };
const current = placementRuleSchema.parse({ id: "current", label: "Stay here", enabled: true, match: {}, target: { kind: "current" } });
const providerRule = placementRuleSchema.parse({ ...current, id: "provider", target: {
  kind: "provider", environmentProviderId: "vendor", machine: { type: "keeper" }, workspace: "linked-worktree",
} });
const input: PlacementPreviewInput = { projectId: "project", keeperThreadId: "lead", keeperPath: null, classId: "ranger", questId: null };
function fixture() {
  const environment = worktreeProvider({ id: "vendor", displayName: "Vendor workspace", description: "Provider description", inputs: { type: "object", properties: { zone: { type: "string" } } } });
  const f = setup({
    projects: { list: async () => [project], get: async () => project },
    environments: { listProviders: async () => [environment] },
    hosts: { list: async () => [{ id: "host", name: "Main", status: "connected" }], experimental_listProviders: async () => [] },
  });
  const settings = new SettingsStore(f.k.store.db, f.time);
  f.runtime.enableSettings(settings, new InsightsReader(f.k.store.db, settings, f.time));
  registerRpc(f.bb, f.runtime);
  const rules = (values: typeof current[]) => settings.update({ revision: settings.snapshot().revision, patch: { machines: { rules: values } }, why: "Preview configuration" });
  return { ...f, settings, environment, rules, preview: (patch: Partial<typeof input> = {}) => f.harness.invokeRpc("placementPreview", { ...input, ...patch }) };
}
function expectNoAllocation(f: ReturnType<typeof fixture>) {
  for (const method of ["threads.spawn", "hosts.create", "environments.create", "environments.remove"]) expect(f.harness.inspection.sdk.callsTo(method)).toEqual([]);
  for (const table of ["tavern_placements", "tavern_source_snapshots"]) expect(f.k.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  expect(f.k.store.all("hires")).toEqual([]);
  expect(f.k.store.all("asks")).toEqual([]);
}

describe("placement reads through the registered RPC contract", () => {
  it("publishes generic provider names, descriptions, schemas, hosts and project identities without allocating", async () => {
    const f = fixture();
    const result = await f.harness.invokeRpc("placementCatalog", {});
    expect(result).toMatchObject({ hostId: "host", environments: [{ id: "vendor", displayName: "Vendor workspace", description: "Provider description", inputs: f.environment.inputs }],
      hosts: [{ id: "host", name: "Main", connected: true }], projects: [{ id: "project", name: "Project", remotes: ["example.com/org/repo"], path: "/project" }] });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(f.harness.inspection.sdk.callsTo("environments.listProviders").map(call => call.args[0])).toEqual([
      { projectId: "project", hostId: "host", signal: expect.any(AbortSignal) }, { projectId: "project", signal: expect.any(AbortSignal) },
    ]);
    expectNoAllocation(f);
  });

  it("returns compatibility for no rules without constructing host inspection", async () => {
    const f = fixture(), source = vi.spyOn(f.runtime, "placementSources");
    expect(await f.preview()).toMatchObject({ revision: 0, steps: [], warnings: [], warningDetails: [], verdict: { state: "compatibility" } });
    expect(source).not.toHaveBeenCalled();
    expectNoAllocation(f);
  });

  it("explains disabled, missed, winning and unreached rules with the live match evidence", async () => {
    const f = fixture();
    f.rules([{ ...current, id: "off", enabled: false }, { ...current, id: "smiths", match: { classes: ["smith"] } }, current, { ...providerRule, id: "later" }]);
    expect(await f.preview()).toMatchObject({ steps: [
      { ruleId: "off", outcome: "off" }, { ruleId: "smiths", outcome: "miss", miss: { field: "classes", value: "ranger", pattern: "smith" } },
      { ruleId: "current", outcome: "matched" }, { ruleId: "later", outcome: "unreached" },
    ], verdict: { state: "matched", ruleId: "current", blocked: null, slot: null, slotsInUse: null, slotCap: null, partyCeiling: 5, remote: null } });
    expectNoAllocation(f);
  });

  it("shows provider slot usage and the real setup blocker, never a successful fallback", async () => {
    const f = fixture();
    f.rules([providerRule, current]);
    new PlacementStore(f.k.store.db).reserve(placementRecord({ keeperThreadId: "lead", questId: null }), { maxMakers: 2, maxCheckers: 2 });
    const result = await f.preview();
    expect(result).toMatchObject({ verdict: { state: "matched", ruleId: "provider", slot: "maker", slotsInUse: 1, slotCap: 2,
      blocked: { code: "placement-setup-incomplete", message: expect.stringMatching(/not ready.*provider/) } } });
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(f.k.store.db.prepare("SELECT count(*) AS n FROM tavern_placements").get()).toEqual({ n: 1 });
    expect(f.settings.snapshot().revision).toBe(1);
  });

  it("reports the checker slot separately", async () => {
    const f = fixture(); f.rules([providerRule]);
    expect(await f.preview({ classId: "warden" })).toMatchObject({ verdict: { slot: "checker", slotsInUse: 0, slotCap: 2 } });
    expectNoAllocation(f);
  });

  it("allows a project without a Keeper and labels its SDK metadata as hypothetical", async () => {
    const f = fixture(); f.rules([{ ...current, match: { projectIds: ["project"], keeperPathGlobs: ["/project"] } }]);
    expect(await f.preview({ keeperThreadId: null })).toMatchObject({ facts: { keeperPath: "/project", keeperEnvironmentProvider: null },
      verdict: { state: "matched", ruleId: "current", remote: null }, warnings: expect.arrayContaining([expect.stringMatching(/hypothetical/i)]),
      warningDetails: [{ code: "no-keeper", text: expect.stringMatching(/hypothetical/i) }] });
    expectNoAllocation(f);
  });

  it("treats a typed path as what-if data without inspecting, binding or persisting that path", async () => {
    const f = fixture(), source = vi.spyOn(f.runtime, "placementSources");
    f.rules([{ ...current, match: { keeperPathGlobs: ["/what-if/**"] } }]);
    expect(await f.preview({ keeperPath: "/what-if/tree" })).toMatchObject({ facts: { keeperPath: "/what-if/tree" }, verdict: { state: "matched", ruleId: "current" } });
    expect(source).not.toHaveBeenCalled();
    expect(f.k.store.db.prepare("SELECT count(*) AS n FROM tavern_placement_discoveries").get()).toEqual({ n: 0 });
    expectNoAllocation(f);
  });

  it("uses actual host facts while keeping a typed path out of the inspection request", async () => {
    const f = fixture();
    f.rules([{ ...current, match: { keeperPathGlobs: ["~/what-if/**"], repoRemotes: ["example.com/org/repo"] } }]);
    const source: KnownSource = {
      state: "known", keeperThreadId: "lead", projectId: "project", authorityId: "discovery", generation: 1, endpointId: "source",
      endpoint: { hostId: "guest", environmentId: "env", root: "/guest/actual" }, environmentProviderId: "vendor",
      inspection: { platform: "linux", home: "/guest", tmp: ["/guest/tmp"], piAgentDir: null, root: "/guest/actual", branch: "main",
        head: "a".repeat(40), tree: "b".repeat(40), objectFormat: "sha1", linkedWorktree: true,
        features: { porcelain: true, exportChanges: true, objectImport: true }, repoRemotes: ["git@example.com:org/repo.git"] },
    };
    const inspect = vi.fn(async () => source);
    vi.spyOn(f.runtime, "placementSources").mockReturnValue({ inspect } as never);
    expect(await f.preview({ keeperPath: "/guest/what-if/tree" })).toMatchObject({ facts: { keeperPath: "/guest/what-if/tree", repoRemotes: ["example.com/org/repo"], keeperEnvironmentProvider: "vendor" },
      verdict: { state: "matched", ruleId: "current", matchEvidence: expect.arrayContaining([{ field: "repoRemotes", value: "example.com/org/repo", pattern: "example.com/org/repo" }]) } });
    expect(inspect).toHaveBeenCalledWith("lead", "project", expect.any(AbortSignal));
    expect(source.endpoint.root).toBe("/guest/actual");
    expectNoAllocation(f);
  });

  it("keeps an unavailable source unknown rather than inventing local or empty facts", async () => {
    const f = fixture();
    f.rules([{ ...current, match: { repoRemotes: ["example.com/org/repo"] } }]);
    vi.spyOn(f.runtime, "placementSources").mockReturnValue({ inspect: async () => ({ state: "unavailable", code: "source-unavailable", message: "Guest is disconnected" }) } as never);
    expect(await f.preview()).toMatchObject({ facts: { repoRemotes: null, keeperPath: null }, verdict: { state: "compatibility" },
      warnings: expect.arrayContaining(["Guest is disconnected"]), warningDetails: [{ code: "source-unreadable", text: "Guest is disconnected" }] });
    expectNoAllocation(f);
  });

  it.each(["Environment unavailable", "Without a Keeper, project metadata and the optional path are hypothetical, not admission proof."])("codes identity failures by origin, preserving the detail: %s", async text => {
    const f = fixture(); f.rules([{ ...current, match: { keeperEnvironmentProviders: ["vendor"] } }]);
    f.bb.sdk.threads.get = async () => { throw new Error(text); };
    expect(await f.preview()).toMatchObject({ warnings: [text], warningDetails: [{ code: "identity-unreadable", text }] });
    expectNoAllocation(f);
  });

  it("declares all stable warning codes and rejects unknown categories", () => {
    for (const code of ["no-keeper", "provider-unverified", "source-unreadable", "identity-unreadable", "discovery-failed"]) {
      expect(placementWarningSchema.parse({ code, text: "Detail" })).toEqual({ code, text: "Detail" });
    }
    expect(placementWarningSchema.safeParse({ code: "guessed-from-text", text: "Detail" }).success).toBe(false);
  });

  it("blocks present-invalid policy and still returns the exact revision and problems", async () => {
    const f = fixture();
    f.k.store.db.prepare("UPDATE tavern_settings SET data=json_set(data,'$.user.machines',json(?)) WHERE id=1").run(JSON.stringify({ rules: "broken" }));
    expect(await f.preview()).toMatchObject({ verdict: { state: "blocked", code: "invalid-machine-policy", problems: expect.arrayContaining([expect.objectContaining({ path: expect.any(String) })]) } });
    expectNoAllocation(f);
  });

  it("rejects caller-supplied authority fields before the handler", async () => {
    const f = fixture();
    await expect(f.harness.invokeRpc("placementPreview", { ...input, sourceEndpoint: { root: "/forged" } })).rejects.toThrow();
    expectNoAllocation(f);
  });

  it("uses an unscoped catalog with no projects, never an invented project id", async () => {
    const f = fixture();
    f.bb.sdk.projects.list = async () => [];
    expect(await f.harness.invokeRpc("placementCatalog", {})).toMatchObject({ projects: [], environments: [{ id: "vendor" }] });
    expect(f.harness.inspection.sdk.callsTo("environments.listProviders").map(call => call.args[0])).toEqual([{ signal: expect.any(AbortSignal) }]);
    expectNoAllocation(f);
  });

  it("does not guess a primary host", async () => {
    const f = fixture();
    f.bb.sdk.system.config = async () => ({ primaryHostId: null }) as never;
    await expect(f.harness.invokeRpc("placementCatalog", {})).rejects.toThrow(/no primary host/i);
    expect(f.harness.inspection.sdk.callsTo("environments.listProviders")).toEqual([]);
    expectNoAllocation(f);
  });

  it("cancels a catalog even when an SDK read ignores cancellation", async () => {
    const f = fixture(), controller = new AbortController();
    f.bb.sdk.projects.list = async () => { controller.abort(new Error("Superseded preview")); return []; };
    const handlers = placementHandlers(f.runtime);
    await expect(Reflect.apply(handlers.placementCatalog, null, [{}, { experimental_caller: { kind: "client" }, experimental_signal: controller.signal }])).rejects.toThrow("Superseded preview");
    expect(f.harness.inspection.sdk.callsTo("environments.listProviders")).toEqual([]);
    expectNoAllocation(f);
  });

  it("refuses a preview whose machine policy changed during metadata loading", async () => {
    const f = fixture(); f.rules([current]);
    f.bb.sdk.projects.get = async () => { f.rules([providerRule]); return project as never; };
    await expect(f.preview({ keeperThreadId: null })).rejects.toThrow(/settings changed.*retry/i);
    expectNoAllocation(f);
  });

  it("does not convert failed catalog discovery into an empty catalog", async () => {
    const f = fixture();
    f.bb.sdk.hosts.list = async () => { throw new Error("Host catalog unavailable"); };
    await expect(f.harness.invokeRpc("placementCatalog", {})).rejects.toThrow("Host catalog unavailable");
    expectNoAllocation(f);
  });
});
