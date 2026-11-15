// @vitest-environment node
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { discoverPlacementCatalog } from "../../src/server/placement/catalog";
import { worktreeProvider } from "./environment-fixture";
import { createFakePluginHost } from "./host";

type MachineProvider = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["experimental_listProviders"]>>[number];
type Host = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["list"]>>[number];

function fixture() {
  const environment = worktreeProvider({ id: "vendor-workspace", pluginId: "vendor-plugin", availability: null });
  const composition = worktreeProvider({
    id: "vendor-composition", environmentProviderId: "vendor-workspace", machineProviderId: "vendor-machine",
    machineProviderPluginId: "vendor-machine-plugin", machineInputs: { type: "array", items: { type: "string" } },
    machineAcceptsEmptyInputs: false, availability: { status: "setup-required", message: "Configure the vendor account" },
  });
  const machine: MachineProvider = {
    id: "vendor-machine", displayName: "Vendor machine", description: "An advertised machine", icon: "box", logoUrl: null,
    pluginId: "vendor-machine-plugin", inputs: { type: "array", items: { type: "string" } }, acceptsEmptyInputs: false,
    supportsSuspend: true,
  };
  const host: Host = {
    id: "destination", name: "Destination", status: "disconnected", type: "ephemeral", machineProviderId: machine.id,
    maxPermissionMode: "full", createdAt: 1, updatedAt: 1, lastSeenAt: null, lastRejectedProtocolVersion: null,
    lifecycle: { phase: "suspended", message: null, pendingLog: "", suspendedAt: 1, teardown: null },
  };
  const listProviders = vi.fn(async (args: { projectId?: string; hostId?: string }) =>
    args.hostId === undefined ? [environment, composition] : [environment]);
  const listMachines = vi.fn(async () => [machine]);
  const listHosts = vi.fn(async () => [host]);
  const f = createFakePluginHost({ pluginId: "tavern", sdk: {
    environments: { listProviders }, hosts: { experimental_listProviders: listMachines, list: listHosts },
  } });
  return { ...f, environment, composition, machine, host, listProviders, listMachines, listHosts };
}

describe("read-only placement catalog discovery", () => {
  it("reads host-specific workspaces and unscoped compositions separately with generic provider ids", async () => {
    const f = fixture();
    const result = await discoverPlacementCatalog(f.bb, { projectId: "project", hostId: "destination" });
    expect(result).toEqual({
      projectId: "project", hostId: "destination", hostEnvironments: [f.environment],
      compositions: [f.composition], machines: [f.machine], hosts: [f.host],
    });
    expect(f.listProviders.mock.calls.map(([args]) => args)).toEqual([
      { projectId: "project", hostId: "destination" }, { projectId: "project" },
    ]);
    expect(f.listHosts).toHaveBeenCalledWith({ includeCreating: true });
    expect(f.listMachines).toHaveBeenCalledWith({});
  });

  it("retains setup-required, unknown availability, suspended hosts and separate machine schemas", async () => {
    const f = fixture();
    const result = await discoverPlacementCatalog(f.bb, { projectId: "project", hostId: "destination" });
    expect(result.hostEnvironments[0].availability).toBeNull();
    expect(result.compositions[0]).toMatchObject({
      id: "vendor-composition", environmentProviderId: "vendor-workspace", machineProviderId: "vendor-machine",
      availability: { status: "setup-required", message: "Configure the vendor account" },
      machineInputs: f.machine.inputs,
    });
    expect(result.hosts[0]).toMatchObject({ status: "disconnected", lifecycle: { phase: "suspended" } });
    expect(result.machines[0].inputs).toEqual({ type: "array", items: { type: "string" } });
  });

  it("uses only four read operations, with no machine, environment, thread or plugin mutations", async () => {
    const f = fixture();
    await discoverPlacementCatalog(f.bb, { projectId: "project", hostId: "destination" });
    expect(f.listProviders).toHaveBeenCalledTimes(2);
    expect(f.listMachines).toHaveBeenCalledOnce();
    expect(f.listHosts).toHaveBeenCalledOnce();
  });

  it("does not turn a failed catalog into an empty catalog or silently use another host", async () => {
    const f = fixture();
    f.listProviders.mockRejectedValueOnce(new Error("Host destination is unavailable"));
    await expect(discoverPlacementCatalog(f.bb, { projectId: "project", hostId: "destination" }))
      .rejects.toThrow("Host destination is unavailable");
    expect(f.listProviders).toHaveBeenCalledTimes(2);
  });

  it("passes cancellation to every read and refuses a pre-cancelled discovery", async () => {
    const f = fixture(), controller = new AbortController();
    await discoverPlacementCatalog(f.bb, { projectId: "project", hostId: "destination", signal: controller.signal });
    expect(f.listProviders).toHaveBeenCalledWith({ projectId: "project", hostId: "destination", signal: controller.signal });
    expect(f.listProviders).toHaveBeenCalledWith({ projectId: "project", signal: controller.signal });
    expect(f.listMachines).toHaveBeenCalledWith({ signal: controller.signal });
    expect(f.listHosts).toHaveBeenCalledWith({ includeCreating: true, signal: controller.signal });
    controller.abort(new Error("Preview cancelled"));
    await expect(discoverPlacementCatalog(f.bb, { projectId: "project", hostId: "destination", signal: controller.signal }))
      .rejects.toThrow("Preview cancelled");
    expect(f.listMachines).toHaveBeenCalledOnce();
  });

  it("does not publish a stale result if cancellation arrived while the SDK ignored its signal", async () => {
    const f = fixture(), controller = new AbortController();
    f.listMachines.mockImplementationOnce(async () => { controller.abort(new Error("Superseded preview")); return [f.machine]; });
    await expect(discoverPlacementCatalog(f.bb, { projectId: "project", hostId: "destination", signal: controller.signal }))
      .rejects.toThrow("Superseded preview");
  });
});
