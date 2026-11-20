// @vitest-environment node
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import tavern from "../../server";
import { agentProgram } from "../../src/scope/legacy";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose();
});

const source = { id: "source", hostId: "home", path: "/repo", projectId: "repo", isDefault: true, type: "local_path" as const, createdAt: 1, updatedAt: 1 };
const project = { id: "repo", name: "Repo", kind: "standard" as const, gitRemoteUrl: "https://user:secret@code.example/team/repo.git", sources: [source], createdAt: 1, updatedAt: 1 };

async function fixture() {
  const { bb, harness } = createFakePluginHost({ pluginId: "tavern", experimental_declaredIconNames: ["tavern"], sdk: {
    projects: { list: async () => [project] },
    system: { config: async () => ({ primaryHostId: "home" }) },
    environments: {
      list: async () => [{ hostId: "home", projectId: "repo", path: "/repo", defaultBranch: "trunk" }],
      listProviders: async () => [{ id: "checkout", displayName: "Checkout", inputs: null, machineProviderId: null, availability: { status: "available" } }, { id: "composition", displayName: "Composition", machineProviderId: "machine" }],
    },
    hosts: { experimental_listProviders: async () => [{ id: "machine", displayName: "Machine" }] },
    providers: {
      list: async () => [{ id: "engine", displayName: "Engine", available: true }, { id: "offline", displayName: "Offline", available: false }, { id: "broken", displayName: "Broken", available: true }],
      models: async args => {
        if (args?.providerId === "broken") throw new Error("Catalog unavailable");
        return { modelLoadError: null, models: [{ id: "full/model", model: "model", displayName: "Model", isDefault: true, supportedReasoningEfforts: [] }] };
      },
    },
  } });
  cleanups.push(() => harness.lifecycle.dispose());
  await tavern(bb);
  return { bb, harness };
}

it("discovers registered sources, redacted remotes, default branches, providers and model catalogs without writes", async () => {
  const { bb, harness } = await fixture();
  await harness.behavior.callRpc("settingsUpdate", { revision: 0, patch: { machines: {
    rules: [{ id: "local", label: "Local", enabled: true, match: {}, target: { kind: "current" } }],
  } }, why: "Fixture rule" });
  const before = await harness.behavior.callRpc("settings", null);
  const db = bb.storage.database();
  const writes = () => db.prepare("SELECT total_changes() AS count").get();
  const initialWrites = writes();
  const result = await harness.behavior.runCli(["setup", "discover"], { threadId: "agent", projectId: "repo" });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain("secret");
  expect(JSON.parse(result.stdout)).toMatchObject({
    revision: 1, hostId: "home", modelProjectId: "repo",
    projects: [{ id: "repo", name: "Repo", remotes: ["code.example/team/repo"], repos: [{ hostId: "home", path: "/repo", isDefault: true, defaultBranch: "trunk" }] }],
    environments: [{ id: "checkout" }, { id: "composition", machineProviderId: "machine" }],
    machines: [{ id: "machine" }],
    providers: [
      { id: "engine", available: true, models: [{ id: "full/model", model: "model", isDefault: true }], error: null },
      { id: "offline", available: false, models: [] },
      { id: "broken", available: true, models: [], error: "Catalog unavailable" },
    ],
    placement: { state: "valid", settings: { forges: [], rules: [{ id: "local" }] } },
  });
  expect(writes()).toEqual(initialWrites);
  expect(await harness.behavior.callRpc("settings", null)).toEqual(before);
  expect(harness.inspection.sdk.callsTo("providers.models").map(([args]) => args)).toMatchObject([
    { hostId: "home", projectId: "repo", providerId: "engine" },
    { hostId: "home", projectId: "repo", providerId: "broken" },
  ]);
});

it("keeps discovery open to a scoped member's shell", () => {
  expect(agentProgram(["bb", "tavern", "setup", "discover"])).toBe(true);
  expect(agentProgram(["bb", "tavern", "setup", "apply"])).toBe(false);
});
