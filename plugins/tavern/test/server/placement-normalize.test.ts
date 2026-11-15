// @vitest-environment node
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeProviderPlacement } from "../../src/server/placement/normalize";
import type { PlacementRule } from "../../src/shared/placement-settings";
import { worktreeProvider } from "./environment-fixture";

type Project = Awaited<ReturnType<BbPluginApi["sdk"]["projects"]["get"]>>;
type Machine = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["experimental_listProviders"]>>[number];
const consent = { guardInstall: true, remoteDetectionOnly: true, linuxUncontainedChecks: true };
const live = new Set<ReturnType<typeof createFakePluginHost>>();
afterEach(async () => { for (const f of live) await f.harness.lifecycle.dispose(); live.clear(); });

function rule(target: Partial<Extract<PlacementRule["target"], { kind: "provider" }>> = {}): PlacementRule {
  return { id: "separate", label: "Separate checkout", enabled: true, match: {}, consent: { ...consent }, target: {
    kind: "provider", environmentProviderId: "vendor-workspace", machine: { type: "new", machineProviderId: "vendor-compute" },
    workspace: "dedicated-machine", ...target,
  } };
}
function fixture() {
  const environment = worktreeProvider({ id: "vendor-workspace", availability: null, machineAvailability: {} });
  const machine: Machine = { id: "vendor-compute", displayName: "Compute", description: "Dedicated compute", icon: "Server", logoUrl: null,
    pluginId: "vendor", acceptsEmptyInputs: true, inputs: null, supportsSuspend: false };
  const project: Project = { id: "project", name: "Project", kind: "standard", gitRemoteUrl: "https://example.com/team/repo.git",
    createdAt: 1, updatedAt: 1, sources: [{ id: "source", projectId: "project", hostId: "keeper-host", path: "/repo",
      type: "local_path", isDefault: true, createdAt: 1, updatedAt: 1 }] };
  const host = makeHostResponse({ id: "keeper-host", status: "connected", maxPermissionMode: "full" });
  const providers = [environment];
  const listProviders = vi.fn(async (_args: unknown) => providers);
  const getProject = vi.fn(async () => project);
  const getHost = vi.fn(async () => ({ ...host, connectMachineId: null, threadStorageRootPath: null }));
  const machines = vi.fn(async () => [machine]);
  const f = createFakePluginHost({ pluginId: "tavern", sdk: {
    environments: { listProviders }, projects: { get: getProject }, hosts: { get: getHost, experimental_listProviders: machines },
  } });
  live.add(f);
  const args = (selected = rule(), signal?: AbortSignal) => ({ rule: selected, projectId: "project", keeperHostId: "keeper-host",
    serverHostId: "server-host", substitutions: { "keeper.branch": "feature/source", "source.commit": "a".repeat(40),
      "member.branch": "tavern/member-1", "quest.id": "quest-1" }, ...(signal ? { signal } : {}) });
  return { ...f, environment, machine, project, host, providers, listProviders, getProject, getHost, machines, args };
}

describe("private provider placement normalization", () => {
  it("constructs an explicit SDK new-machine selection without allocation or destination-ready claims", async () => {
    const f = fixture();
    const result = await normalizeProviderPlacement(f.bb, f.args());
    expect(result).toEqual({ ruleId: "separate", compositionId: null, hostId: null, remote: true,
      ownsNewMachine: true, workspaceKind: "dedicated-machine", destinationValidationRequired: true,
      environment: { type: "provider", environmentProviderId: "vendor-workspace", inputs: null,
        machine: { type: "new", machineProviderId: "vendor-compute", inputs: null } },
      warnings: [expect.stringContaining("not established")],
    });
    expect(f.listProviders).toHaveBeenCalledWith({ projectId: "project" });
    expect(f.harness.inspection.sdk.calls.map(call => call.path)).not.toEqual(expect.arrayContaining([
      "threads.spawn", "threads.send", "hosts.experimental_create", "hosts.experimental_resume", "hosts.delete",
    ]));
  });

  it("unpacks a composition only by its advertised concrete ids and validates separate schemas", async () => {
    const f = fixture();
    f.machine.inputs = { type: "object", properties: { MemoryGb: { type: "integer" } }, required: ["MemoryGb"], additionalProperties: false };
    f.machine.acceptsEmptyInputs = false;
    f.environment.inputs = { type: "object", properties: { FromBranch: { type: "string" }, Branch: { type: "string" } }, required: ["Branch"] };
    f.providers.push(worktreeProvider({ ...f.environment, id: "bundle-with-unrelated-name", machineProviderId: f.machine.id,
      environmentProviderId: f.environment.id, machineInputs: f.machine.inputs, machineAcceptsEmptyInputs: false }));
    const selected = rule({ environmentProviderId: "bundle-with-unrelated-name", inputs: { FromBranch: "{keeper.branch}", Branch: "{member.branch}" },
      machine: { type: "new", machineProviderId: f.machine.id, inputs: { MemoryGb: 8 } } });
    const result = await normalizeProviderPlacement(f.bb, f.args(selected));
    expect(result).toMatchObject({ compositionId: "bundle-with-unrelated-name", environment: {
      environmentProviderId: f.environment.id, inputs: { FromBranch: "feature/source", Branch: "tavern/member-1" },
      machine: { type: "new", machineProviderId: f.machine.id, inputs: { MemoryGb: 8 } },
    } });
    expect(selected.target).toMatchObject({ inputs: { FromBranch: "{keeper.branch}", Branch: "{member.branch}" } });
  });

  it.each(["keeper", "existing", "project-checkout"] as const)("resolves %s to the actual explicit host", async type => {
    const f = fixture();
    f.environment.availability = { status: "available" };
    f.environment.machineAvailability = { "keeper-host": { status: "available" } };
    const machine = type === "existing" ? { type, hostId: "keeper-host" } as const : { type };
    const result = await normalizeProviderPlacement(f.bb, f.args(rule({ machine, workspace: "linked-worktree" })));
    expect(result).toMatchObject({ hostId: "keeper-host", remote: true, ownsNewMachine: false,
      destinationValidationRequired: true, environment: { machine: { type: "existing", hostId: "keeper-host" } } });
    expect(f.listProviders).toHaveBeenCalledWith({ projectId: "project", hostId: "keeper-host" });
    expect(f.getHost).toHaveBeenCalledWith({ hostId: "keeper-host" });
  });

  it("compares remote posture with the server host, not the Keeper host", async () => {
    const f = fixture();
    f.host.id = "server-host";
    f.project.sources[0]!.hostId = "server-host";
    f.environment.availability = { status: "available" };
    const selected = rule({ machine: { type: "existing", hostId: "server-host" }, workspace: "linked-worktree" });
    selected.consent = { guardInstall: false, remoteDetectionOnly: false, linuxUncontainedChecks: false };
    expect(await normalizeProviderPlacement(f.bb, f.args(selected))).toMatchObject({ remote: false, hostId: "server-host" });
  });

  it.each(Object.keys(consent) as Array<keyof typeof consent>)("requires once-per-rule %s consent without asking", async key => {
    const f = fixture(), selected = rule(); selected.consent[key] = false;
    await expect(normalizeProviderPlacement(f.bb, f.args(selected))).rejects.toMatchObject({
      code: "needs-rule-consent", ruleId: selected.id,
    });
    expect(f.harness.inspection.sdk.calls).toHaveLength(0);
  });

  it("also checks consent after resolving an existing remote target", async () => {
    const f = fixture(), selected = rule({ machine: { type: "keeper" }, workspace: "linked-worktree" });
    selected.consent.guardInstall = false;
    await expect(normalizeProviderPlacement(f.bb, f.args(selected))).rejects.toMatchObject({ code: "needs-rule-consent" });
  });

  it.each(["setup-required", "unavailable"] as const)("preserves a %s provider message as a visible rule blocker", async status => {
    const f = fixture(); f.environment.availability = { status, message: "Vendor quota needs attention" };
    await expect(normalizeProviderPlacement(f.bb, f.args())).rejects.toMatchObject({
      ruleId: "separate", code: `provider-${status}`, message: expect.stringContaining("Vendor quota needs attention"),
    });
  });

  it("does not substitute a provider when the configured one disappeared", async () => {
    const f = fixture(); f.environment.id = "other-provider";
    await expect(normalizeProviderPlacement(f.bb, f.args())).rejects.toMatchObject({ code: "environment-provider-missing" });
  });

  it("blocks an absent machine provider even when a composition names it", async () => {
    const f = fixture(); f.machines.mockResolvedValue([]);
    await expect(normalizeProviderPlacement(f.bb, f.args())).rejects.toMatchObject({ code: "machine-provider-missing" });
  });

  it.each(["machine", "concrete", "nested", "existing"])("refuses inconsistent composition metadata: %s", async kind => {
    const f = fixture();
    const composed = worktreeProvider({ id: "composition", machineProviderId: f.machine.id, environmentProviderId: f.environment.id });
    f.providers.push(composed);
    let selected = rule({ environmentProviderId: composed.id });
    if (kind === "machine") composed.machineProviderId = "different-compute";
    if (kind === "concrete") delete composed.environmentProviderId;
    if (kind === "nested") f.environment.machineProviderId = "nested-compute";
    if (kind === "existing") selected = rule({ environmentProviderId: composed.id, machine: { type: "keeper" }, workspace: "linked-worktree" });
    await expect(normalizeProviderPlacement(f.bb, f.args(selected))).rejects.toMatchObject({ code: "composition-invalid" });
  });

  it("validates both the composition's and concrete provider's advertised schemas", async () => {
    const f = fixture(); f.environment.inputs = { type: "string", pattern: "^concrete$" };
    f.providers.push(worktreeProvider({ ...f.environment, id: "composition", machineProviderId: f.machine.id,
      environmentProviderId: f.environment.id, inputs: { type: "string" } }));
    await expect(normalizeProviderPlacement(f.bb, f.args(rule({ environmentProviderId: "composition", inputs: "wrong" }))))
      .rejects.toMatchObject({ code: "provider-inputs-invalid" });
  });

  it("validates composition machine inputs as well as the machine provider's schema", async () => {
    const f = fixture(); f.machine.inputs = { type: "integer" }; f.machine.acceptsEmptyInputs = false;
    f.providers.push(worktreeProvider({ ...f.environment, id: "composition", machineProviderId: f.machine.id,
      environmentProviderId: f.environment.id, machineInputs: { type: "integer", minimum: 4 }, machineAcceptsEmptyInputs: false }));
    await expect(normalizeProviderPlacement(f.bb, f.args(rule({ environmentProviderId: "composition",
      machine: { type: "new", machineProviderId: f.machine.id, inputs: 2 } }))))
      .rejects.toMatchObject({ code: "provider-inputs-invalid" });
  });

  it.each(["invalid", "unsupported", "missing-value"])("never calls %s input validation passed", async kind => {
    const f = fixture(); f.environment.inputs = kind === "unsupported" ? { type: "string", vendorConstraint: true } : { type: "integer" };
    const selected = rule({ inputs: kind === "missing-value" ? "{keeper.branch}" : "x" });
    const args = f.args(selected);
    if (kind === "missing-value") args.substitutions["keeper.branch"] = "";
    await expect(normalizeProviderPlacement(f.bb, args)).rejects.toMatchObject({
      code: kind === "unsupported" ? "provider-schema-unsupported" : "provider-inputs-invalid",
    });
  });

  it("fills all four substitutions in values without changing provider-owned keys or executing shell text", async () => {
    const f = fixture(); f.environment.inputs = { type: "object" }; f.machine.inputs = { type: "string" };
    const result = await normalizeProviderPlacement(f.bb, f.args(rule({ inputs: {
      "{member.branch}": ["{keeper.branch}", "{source.commit}", "{member.branch}", "{quest.id}", "$HOME; $(id)"],
    }, machine: { type: "new", machineProviderId: f.machine.id, inputs: "for-{quest.id}" } })));
    expect(result.environment.inputs).toEqual({ "{member.branch}": ["feature/source", "a".repeat(40), "tavern/member-1", "quest-1", "$HOME; $(id)"] });
    expect(result.environment.machine).toMatchObject({ inputs: "for-quest-1" });
  });

  it("refuses ambiguous project-checkout sources instead of choosing the laptop", async () => {
    const f = fixture(); f.project.sources.push({ ...f.project.sources[0]!, id: "second", hostId: "elsewhere" });
    await expect(normalizeProviderPlacement(f.bb, f.args(rule({ machine: { type: "project-checkout" }, workspace: "linked-worktree" }))))
      .rejects.toMatchObject({ code: "project-source-ambiguous" });
  });

  it("refuses absent project-checkout sources and mismatched project identity", async () => {
    const f = fixture(); f.project.sources = [];
    await expect(normalizeProviderPlacement(f.bb, f.args(rule({ machine: { type: "project-checkout" }, workspace: "linked-worktree" }))))
      .rejects.toMatchObject({ code: "project-source-missing" });
    f.project.id = "different-project";
    await expect(normalizeProviderPlacement(f.bb, f.args())).rejects.toMatchObject({ code: "project-changed" });
  });

  it.each(["creating", "suspended", "resuming", "destroyed", "removing", "suspending"] as const)("does not call %s host ready or resume it implicitly", async phase => {
    const f = fixture(); f.host.lifecycle.phase = phase;
    await expect(normalizeProviderPlacement(f.bb, f.args(rule({ machine: { type: "keeper" }, workspace: "linked-worktree" }))))
      .rejects.toMatchObject({ code: `host-${phase}`, message: expect.stringContaining(phase) });
  });

  it.each(["disconnected", "wrong-identity", "permission"])("refuses unusable existing hosts: %s", async kind => {
    const f = fixture();
    if (kind === "disconnected") f.host.status = "disconnected";
    if (kind === "wrong-identity") f.host.id = "wrong-host";
    if (kind === "permission") f.host.maxPermissionMode = "accept-edits";
    await expect(normalizeProviderPlacement(f.bb, f.args(rule({ machine: { type: "keeper" }, workspace: "linked-worktree" }))))
      .rejects.toMatchObject({ code: kind === "permission" ? "host-permission-ceiling" : kind === "disconnected" ? "host-disconnected" : "host-changed" });
  });

  it("honors actual-host unavailability over generic availability", async () => {
    const f = fixture(); f.environment.availability = { status: "available" };
    f.environment.machineAvailability = { "keeper-host": { status: "unavailable", message: "No checkout pool on destination" } };
    await expect(normalizeProviderPlacement(f.bb, f.args(rule({ machine: { type: "keeper" }, workspace: "linked-worktree" }))))
      .rejects.toThrow("No checkout pool on destination");
  });

  it("never promotes unknown actual-host availability to ready", async () => {
    const f = fixture();
    await expect(normalizeProviderPlacement(f.bb, f.args(rule({ machine: { type: "keeper" }, workspace: "linked-worktree" }))))
      .rejects.toMatchObject({ code: "provider-availability-unknown" });
  });

  it("refuses duplicate catalog identities rather than taking the first one", async () => {
    const f = fixture(); f.providers.push({ ...f.environment });
    await expect(normalizeProviderPlacement(f.bb, f.args())).rejects.toMatchObject({ code: "provider-catalog-ambiguous" });
  });

  it("requires reachable project source metadata for a fresh machine without inventing a checkout", async () => {
    const f = fixture(); f.project.gitRemoteUrl = null;
    await expect(normalizeProviderPlacement(f.bb, f.args())).rejects.toMatchObject({ code: "project-remote-required" });
  });

  it("requires a project source on the selected existing host when the provider needs one", async () => {
    const f = fixture(); f.project.sources = [];
    await expect(normalizeProviderPlacement(f.bb, f.args(rule({ machine: { type: "keeper" }, workspace: "linked-worktree" }))))
      .rejects.toMatchObject({ code: "project-checkout-required" });
  });

  it("does not require a remote for providers that advertise no checkout or remote requirement", async () => {
    const f = fixture(); f.project.gitRemoteUrl = null; f.project.sources = [];
    f.environment.requires = { gitCheckout: false, projectCheckout: false, gitRemote: false, projectless: true };
    expect(await normalizeProviderPlacement(f.bb, f.args())).toMatchObject({ ownsNewMachine: true });
  });

  it("treats explicit null host availability as unknown even when generic availability is available", async () => {
    const f = fixture(); f.environment.availability = { status: "available" };
    f.environment.machineAvailability = { "keeper-host": null };
    await expect(normalizeProviderPlacement(f.bb, f.args(rule({ machine: { type: "keeper" }, workspace: "linked-worktree" }))))
      .rejects.toMatchObject({ code: "provider-availability-unknown" });
  });

  it("forbids dedicated mode on an existing machine independently of settings parsing", async () => {
    const f = fixture();
    await expect(normalizeProviderPlacement(f.bb, f.args(rule({ machine: { type: "keeper" } }))))
      .rejects.toMatchObject({ code: "dedicated-machine-required" });
  });

  it("never normalizes a disabled or current rule into provider execution", async () => {
    const f = fixture(), selected = rule(); selected.enabled = false;
    await expect(normalizeProviderPlacement(f.bb, f.args(selected))).rejects.toMatchObject({ code: "rule-disabled" });
    selected.enabled = true; selected.target = { kind: "current" };
    await expect(normalizeProviderPlacement(f.bb, f.args(selected))).rejects.toMatchObject({ code: "provider-target-required" });
  });

  it("carries cancellation to SDK reads and fences late results from an SDK that ignores its signal", async () => {
    const f = fixture(), controller = new AbortController();
    f.listProviders.mockImplementationOnce(async () => { controller.abort(new Error("Superseded hire")); return f.providers; });
    await expect(normalizeProviderPlacement(f.bb, f.args(rule(), controller.signal))).rejects.toThrow("Superseded hire");
    expect(f.listProviders).toHaveBeenCalledWith({ projectId: "project", signal: controller.signal });
    await expect(normalizeProviderPlacement(f.bb, f.args(rule(), controller.signal))).rejects.toThrow("Superseded hire");
    expect(f.listProviders).toHaveBeenCalledOnce();
  });
});
