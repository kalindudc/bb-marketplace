// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { makeThreadResponse } from "./host";
import { setup } from "./runtime-fixture";
import { planInput } from "./support";
import { worktreeProvider } from "./environment-fixture";
async function smith(environmentProviderId: string | null, branchName: string | null = "feature/current") {
  const f = setup();
  const environment = { id: "env", hostId: "host", isGitRepo: true, environmentProviderId, branchName };
  const providers = [worktreeProvider()];
  Object.assign(f.bb.sdk, { environments: {
    get: async () => environment,
    listProviders: async () => providers,
  } });
  f.bb.sdk.threads.get = async ({ threadId }) => makeThreadResponse({ id: threadId, environmentId: "env" });
  const q = await seedQuest(f.k,"lead", "Build", "Build");
  f.k.plan("lead", {
    ...planInput(q.id),
    party: [{ classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] }],
  });
  f.k.answerAsk(f.k.asks("lead").find(ask => ask.kind === "greenlight")!.id, "approve", null, "page", "user");
  const hire = () => f.runtime.hire("lead", "project", {
    classId: "smith", boardQuestId: q.id, waypointId: "w1", title: "Build",
    brief: { outcome: "Build", mode: "make-it-work", outOfScope: "Deploy", doneWhen: "Tests pass", context: [], questions: [], timeboxMinutes: null },
  });
  return { ...f, environment, providers, hire };
}

describe("Smith managed environments through the strict SDK host", () => {
  it.each([null, "git-worktree", "project-checkout"])("creates an isolated provider worktree for %s instead of reusing the checkout", async provider => {
    const f = await smith(provider);
    await f.hire();
    expect(f.harness.inspection.sdk.callsTo("environments.listProviders").map(call => call.args[0])).toEqual([{ projectId: "project", hostId: "host" }]);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")[0]?.args[0]).toMatchObject({
      environment: {
        type: "provider", environmentProviderId: "git-worktree",
        machine: { type: "existing", hostId: "host" },
        inputs: { branch: { kind: "named", name: "feature/current" } },
      },
    });
  });
  it("lets the provider choose the default branch if the current checkout branch is absent", async () => {
    const f = await smith("project-checkout", null);
    await f.hire();
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")[0]?.args[0]).toMatchObject({
      environment: { type: "provider", inputs: { branch: { kind: "default" } } },
    });
  });
  it("refuses an unknown provider before spawning and returns its staffing reservation", async () => {
    const f = await smith("unknown-provider");
    await expect(f.hire()).rejects.toThrow(/Smith.*unknown-provider.*not supported/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(f.k.store.all("hires")).toEqual([]);
    f.environment.environmentProviderId = "project-checkout";
    await expect(f.hire()).resolves.toMatchObject({ classId: "smith" });
  });
  it("refuses a non-Git checkout before spawning", async () => {
    const f = await smith("project-checkout");
    f.environment.isGitRepo = false;
    await expect(f.hire()).rejects.toThrow(/Smith.*Git checkout/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("refuses an unprovisioned parent instead of using a shared project default", async () => {
    const f = await smith("project-checkout");
    f.bb.sdk.threads.get = async ({ threadId }) => makeThreadResponse({ id: threadId });
    await expect(f.hire()).rejects.toThrow(/Smith.*ready.*Git checkout/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("refuses if the official worktree provider is absent", async () => {
    const f = await smith("project-checkout");
    f.providers.length = 0;
    await expect(f.hire()).rejects.toThrow(/Smith.*git-worktree.*not available/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it.each(["global", "machine"])("refuses %s worktree unavailability before spawning", async level => {
    const f = await smith("project-checkout");
    const blocked = { status: "unavailable" as const, message: "Worktree setup blocked" };
    if (level === "global") f.providers[0]!.availability = blocked;
    else f.providers[0]!.machineAvailability.host = blocked;
    await expect(f.hire()).rejects.toThrow(/Smith.*Worktree setup blocked/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("fails clearly without spawning if provider eligibility cannot be checked", async () => {
    const f = await smith("project-checkout");
    f.bb.sdk.environments.listProviders = vi.fn(async () => { throw new Error("Provider lookup offline"); });
    await expect(f.hire()).rejects.toThrow(/Smith.*Provider lookup offline/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("keeps a Ranger on an unknown parent provider without asking it to make a worktree", async () => {
    const f = await smith("unknown-provider");
    await f.runtime.hire("lead", "project", {
      classId: "ranger", errand: true, title: "Scout",
      brief: { outcome: "Scout", mode: "make-it-work", outOfScope: "Deliverable", doneWhen: "Report", context: [], questions: ["What exists?"], timeboxMinutes: 5 },
    });
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")[0]?.args[0]).toMatchObject({ environment: { type: "reuse", environmentId: "env" } });
    expect(f.harness.inspection.sdk.callsTo("environments.listProviders")).toEqual([]);
  });
});
