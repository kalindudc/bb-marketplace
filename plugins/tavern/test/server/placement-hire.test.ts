// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { setup } from "./runtime-fixture";
import { worktreeProvider } from "./environment-fixture";
import { placementRecord, sourceSnapshot } from "./placement-fixture";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights";
import { placementRuleSchema } from "../../src/shared/placement-settings";
import { PlacementController, PlacementHireBlocked } from "../../src/server/placement/controller";
import type { KnownSource } from "../../src/server/placement/source-discovery";
import { seedQuest, planInput } from "./support";
import { recoverHires } from "../../src/server/hires";
import { registerTools } from "../../src/server/tools";
import { dispatch049 } from "./dispatch-fixture";
import { inputText } from "../../src/server/dispatch";

const scopeRoots: string[] = [];
afterEach(() => { for (const root of scopeRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function enableScopes(f: ReturnType<typeof fixture>) {
  const root = mkdtempSync(join(tmpdir(), "placement-hire-scope-")); scopeRoots.push(root);
  f.runtime.enableScopes({ dataDir: root, installGuard: false, policyOptions: { home: root } });
}

const rule = placementRuleSchema.parse({
  id: "shop", label: "Shop members", enabled: true, match: { projectIds: ["project"] },
  target: { kind: "provider", environmentProviderId: "vendor-checkout", inputs: { base: "{source.base}", branch: "{member.branch}" },
    machine: { type: "new", machineProviderId: "vendor-compute", inputs: { size: 2 } }, workspace: "dedicated-machine" },
  consent: { guardInstall: true, remoteDetectionOnly: true, linuxUncontainedChecks: true },
});
const hire = { classId: "ranger", title: "Scout", errand: true,
  brief: { outcome: "Read", mode: "make-it-work" as const, outOfScope: "", doneWhen: "Read", context: [], questions: ["What exists?"], timeboxMinutes: 1 } };

function fixture() {
  const f = setup({
    projects: { get: async () => ({ id: "project", sources: [], gitRemoteUrl: "https://example.invalid/team/repo.git" }) },
    environments: { listProviders: async () => [worktreeProvider({ id: "vendor-checkout", displayName: "Vendor checkout", availability: null,
      inputs: { type: "object", properties: { base: { type: "string" }, branch: { type: "string" } }, required: ["base", "branch"] }, acceptsEmptyInputs: false })] },
    hosts: { get: async ({ hostId }: { hostId: string }) => ({ id: hostId, name: "Home" }),
      experimental_listProviders: async () => [{ id: "vendor-compute", displayName: "Vendor compute", inputs: { type: "object", properties: { size: { type: "number" } }, required: ["size"] }, acceptsEmptyInputs: false }] },
  });
  const hostEntry = createFakePluginHost({ pluginId: "tavern", experimental_hostEntry: true });
  Object.assign(f.bb, { hosts: hostEntry.bb.hosts });
  const settings = new SettingsStore(f.k.store.db, f.time);
  f.runtime.enableSettings(settings, new InsightsReader(f.k.store.db, settings, f.time));
  settings.update({ revision: 0, patch: { machines: { rules: [rule] } }, why: "Place helpers" });
  const services = f.runtime.placements();
  const source = { state: "known", keeperThreadId: "lead", projectId: "project", endpoint: { hostId: "host", environmentId: "env", root: "/source" },
    inspection: { branch: "feature", home: "/home", repoRemotes: [] } } as unknown as KnownSource;
  vi.spyOn(services.sources, "inspect").mockResolvedValue(source);
  vi.spyOn(services.sources, "revalidate").mockResolvedValue();
  vi.spyOn(services.capture, "initial").mockImplementation(async () => services.store.saveSnapshot(sourceSnapshot({ keeperThreadId: "lead", sourceThreadId: "lead", source: source.endpoint, home: source.endpoint })));
  return { ...f, settings, services };
}

async function leadFixture() {
  const f = fixture(), registry = await f.runtime.prepareRegistry("project");
  const classes = registry.classes.map(role => role.id === "keeper" ? { ...role, hireable: true, hires: [...role.hires, "keeper"], environment: "worktree" as const, model: "anthropic/claude-sonnet-5-5" } : role);
  vi.spyOn(f.runtime, "prepareRegistry").mockResolvedValue({ ...registry, classes });
  const quest = await seedQuest(f.k, "lead", "Hire a lead", "LEAD");
  f.k.plan("lead", { ...planInput(quest.id), party: [{ classId: "keeper", characterId: null, model: null, purpose: "Lead", waypointIds: [] }] });
  f.k.answerAsk(f.k.asks("lead").find(ask => ask.state === "open" && ask.kind === "greenlight")!.id, "approve", null, "page");
  return { ...f, leadHire: { ...hire, classId: "keeper", errand: false, boardQuestId: quest.id } };
}

async function blocked(promise: Promise<unknown>) {
  try { await promise; throw new Error("Expected a visible placement blocker"); }
  catch (error) { expect(error).toBeInstanceOf(PlacementHireBlocked); return error as PlacementHireBlocked; }
}

describe("rule-driven member hires", () => {
  it("spawns once with the exact SDK selection, binds the placement, and explains the source of admission", async () => {
    const f = fixture(), spawn = vi.spyOn(f.bb.sdk.threads, "spawn");
    const member = await f.runtime.hire("lead", "project", hire);
    expect(spawn).toHaveBeenCalledOnce();
    const call = spawn.mock.calls[0][0];
    expect(call.environment).toEqual({ type: "provider", environmentProviderId: "vendor-checkout", inputs: { base: "a".repeat(40), branch: expect.stringMatching(/^tavern\//) },
      machine: { type: "new", machineProviderId: "vendor-compute", inputs: { size: 2 } } });
    expect(call.input?.[0]).toMatchObject({ text: expect.stringContaining("Call tavern_ready {} before substantive work.") });
    expect(f.services.store.byMember(member.threadId)).toMatchObject({ memberThreadId: member.threadId, phase: "bootstrapping", posture: { aggregate: "remote-detection-only" } });
    expect(member.placement).toMatchObject({ phase: "bootstrapping", rule: { id: "shop", label: "Shop members" }, posture: { label: "Detection only (remote)" } });
    expect(member.placement?.where).toEqual({ kind: "pending", label: "Vendor checkout, starting" });
    expect(member.placementSummary).toMatch(/Shop members.*shop.*projectIds=project.*bootstrapping.*Detection only \(remote\)/);
    expect(member.placementSummary).toContain("Scope not yet delivered");
    expect(member.placementSummary).not.toContain("Scope update pending");
    expect(f.k.store.all("asks")).toEqual([]);
  });

  it("names uncommitted-source provenance using the observed home host label", async () => {
    const f = fixture(), source = { hostId: "host", environmentId: "env", root: "/source" };
    vi.mocked(f.services.capture.initial).mockImplementation(async () => f.services.store.saveSnapshot(sourceSnapshot({
      keeperThreadId: "lead", sourceThreadId: "lead", source, home: source,
      includesUncommitted: true, userHead: "a".repeat(40), uncommittedOrigin: source, modifiedPaths: 1, untrackedPaths: 2,
    })));
    const member = await f.runtime.hire("lead", "project", hire);
    expect(member.placementSummary).toContain("Includes uncommitted changes from /source on Home.");
    expect(member.placement?.source).toEqual({ includesUncommitted: true, from: "/source on Home" });
    f.services.controller.observeHost({ id: "worker", name: "Worker machine" });
    const record = f.services.store.byMember(member.threadId)!;
    const bound = f.services.store.update(record.id, 1, value => ({ ...value, hostId: "worker" }));
    expect(f.services.controller.view(bound).where).toEqual({ kind: "host", hostId: "worker", label: "Worker machine" });
  });

  it("counts blocked placements toward a maker cap and never spawns on a full cap", async () => {
    const f = fixture();
    f.settings.update({ revision: 1, patch: { machines: { maxMakers: 1 } }, why: "One at a time" });
    const prior = f.services.store.reserve(placementRecord({ keeperThreadId: "lead", questId: null }), { maxMakers: 1, maxCheckers: 2 });
    f.services.store.block(prior.id, 1, { stage: "provision", code: "offline", message: "Offline", retryable: true });
    const spawn = vi.spyOn(f.bb.sdk.threads, "spawn");
    expect((await blocked(f.runtime.hire("lead", "project", hire))).message).toContain("Waiting for a maker slot: 1 of 1 in use");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["existing", "linked-worktree"] as const)("blocks unsupported %s targets without allocating", async kind => {
    const f = fixture();
    f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, target: { ...rule.target, ...(kind === "existing" ? { machine: { type: "existing", hostId: "remote" }, workspace: "linked-worktree" } : { workspace: "linked-worktree" }) } }] } }, why: "Unsupported route" });
    expect((await blocked(f.runtime.hire("lead", "project", hire))).message).toContain("This rule's target isn't supported in this version.");
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it("blocks an unruled scoped remote helper but does not force a lead onto the matching rule", async () => {
    const f = fixture();
    enableScopes(f);
    f.settings.update({ revision: 1, patch: { machines: { rules: [] } }, why: "No remote rule" });
    vi.spyOn(f.bb.sdk.environments, "get").mockResolvedValue({ id: "env", hostId: "remote", environmentProviderId: "checkout", branchName: "main", isGitRepo: true } as never);
    expect((await blocked(f.runtime.hire("lead", "project", hire))).message).toBe("No machine rule places Ranger members for this project, and this Keeper runs on another machine. Add a rule in Settings, Where work runs.");
  });

  it("allows an open-preset helper to stay with a remote Keeper without cut-6 SDK reads", async () => {
    const f = fixture(); enableScopes(f);
    f.settings.update({ revision: 1, patch: { machines: { rules: [] } }, why: "No rule" });
    const environment = vi.spyOn(f.bb.sdk.environments, "get").mockResolvedValue({ id: "env", hostId: "remote", path: "/remote/repo", environmentProviderId: "checkout", isGitRepo: true } as never);
    expect((await f.runtime.hire("lead", "project", { ...hire, classId: "wanderer" })).placement).toBeNull();
    expect(environment).toHaveBeenCalledTimes(1);
  });

  it("keeps a lead in the remote Keeper environment even when a new-machine rule matches", async () => {
    const f = await leadFixture(), spawn = vi.spyOn(f.bb.sdk.threads, "spawn");
    vi.spyOn(f.bb.sdk.environments, "get").mockResolvedValue({ id: "env", hostId: "remote", environmentProviderId: "checkout", isGitRepo: true } as never);
    const member = await f.runtime.hire("lead", "project", f.leadHire);
    expect(spawn.mock.calls[0][0].environment).toEqual({ type: "reuse", environmentId: "env" });
    expect(member.placement).toBeNull();
    expect(f.services.store.counts("lead")).toEqual({ makers: 0, checkers: 0 });
  });

  it("places a lead only by its explicitly named enabled rule", async () => {
    const f = await leadFixture(), spawn = vi.spyOn(f.bb.sdk.threads, "spawn");
    const member = await f.runtime.hire("lead", "project", { ...f.leadHire, placementRuleId: "shop" });
    expect(spawn).toHaveBeenCalledOnce();
    expect(member.placement).toMatchObject({ rule: { id: "shop" }, phase: "bootstrapping" });
    expect(member.placementSummary).toContain("placementRuleId=shop");
    expect(f.services.store.byMember(member.threadId)?.matchEvidence).toEqual([
      { field: "projectIds", value: "project", pattern: "project" }, { field: "placementRuleId", value: "shop", pattern: "shop" },
    ]);
  });

  it.each(["missing", "disabled"])("refuses a lead rule id that is %s", async kind => {
    const f = await leadFixture();
    f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, enabled: false }] } }, why: "Disabled rule" });
    await expect(f.runtime.hire("lead", "project", { ...f.leadHire, placementRuleId: kind === "missing" ? "unknown" : "shop" })).rejects.toThrow(/placementRuleId.*enabled rule/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it("releases a definite spawn refusal and permits a new hire without reserving another held slot", async () => {
    const f = fixture(), spawn = vi.spyOn(f.bb.sdk.threads, "spawn").mockRejectedValue(Object.assign(new Error("HTTP 400: model unavailable"), { status: 400 }));
    expect((await blocked(f.runtime.hire("lead", "project", hire))).message).toBe("HTTP 400: model unavailable");
    expect(f.services.store.counts("lead")).toEqual({ makers: 0, checkers: 0 });
    expect(f.k.store.all("hires")).toEqual([]);
    expect(f.k.store.events("lead", 0, 100).some(event => event.type === "hire.waiting" && event.text.includes("HTTP 400: model unavailable"))).toBe(true);
    spawn.mockRestore();
    expect((await f.runtime.hire("lead", "project", hire)).placement?.phase).toBe("bootstrapping");
  });

  it("releases a never-attempted reservation after a known pre-spawn failure", async () => {
    const f = fixture();
    vi.spyOn(f.services.controller, "beginSpawn").mockImplementation(() => { throw new Error("Maker stopped before launch"); });
    expect((await blocked(f.runtime.hire("lead", "project", hire))).message).toBe("Maker stopped before launch");
    expect(f.services.store.counts("lead")).toEqual({ makers: 0, checkers: 0 });
    expect(f.k.store.all("hires")).toEqual([]);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it("retains a child arriving after cancellation as a preservation owner, without archiving it", async () => {
    const f = fixture();
    vi.spyOn(f.bb.sdk.threads, "spawn").mockImplementation(async args => {
      const record = f.services.store.byHireToken((args.pluginMetadata as { hireToken: string }).hireToken)!;
      f.services.store.cancel(record.id, record.generation);
      return makeThreadResponse({ id: "late-child", projectId: "project", parentThreadId: "lead" });
    });
    await expect(f.runtime.hire("lead", "project", hire)).rejects.toThrow();
    expect(f.services.store.byMember("late-child")).toMatchObject({ desiredState: "released", phase: "preserving",
      preservation: { source: "pending", liveOwnerThreadId: "late-child", stopConfirmed: false } });
    expect(f.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });

  it("keeps an unresolved placement intent out of legacy hire maintenance", async () => {
    const f = fixture();
    vi.spyOn(f.bb.sdk.threads, "spawn").mockRejectedValue(new Error("Allocation reply lost"));
    await blocked(f.runtime.hire("lead", "project", hire));
    const record = f.services.store.activePage(null, 100)[0];
    f.advance(120_000);
    await recoverHires(f.bb, f.k, "lead");
    expect(f.k.store.get("hires", record.hireToken)).not.toBeNull();
    expect(f.harness.inspection.sdk.callsTo("threads.list")).toEqual([]);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("does not reset saved provenance or confirmed stop on repeated cancelled-child reconciliation", async () => {
    const f = fixture(), member = await f.runtime.hire("lead", "project", hire), record = f.services.store.byMember(member.threadId)!;
    const cancelled = f.services.controller.cancelChild(record, member.threadId);
    const saved = f.services.store.update(cancelled.id, cancelled.generation, value => ({ ...value,
      preservation: { ...value.preservation, source: "saved", stopConfirmed: true },
    }), "released");
    expect(f.services.controller.cancelChild(saved, member.threadId).preservation).toEqual(saved.preservation);
  });

  it("routes a cancelled preservation retry to preservation rather than allocation or readiness", async () => {
    const f = fixture(), member = await f.runtime.hire("lead", "project", hire), record = f.services.store.byMember(member.threadId)!;
    const cancelled = f.services.store.cancel(record.id, record.generation);
    f.services.store.block(record.id, cancelled.generation, { stage: "preserve", code: "save-failed", message: "Save failed", retryable: true }, "released");
    const preserve = vi.spyOn(f.services.preserve, "beforeRelease").mockResolvedValue({ state: "waiting", message: "Wait for the maker to be idle" });
    await expect(f.services.controller.retry(record.id, cancelled.generation)).rejects.toThrow("Wait for the maker to be idle");
    expect(preserve).toHaveBeenCalledWith(member.threadId, "Retry preservation");
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
  });

  it("refuses a lead rule that names another project, but ignores only its classes", async () => {
    const f = await leadFixture();
    f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, match: { projectIds: ["other"], classes: ["smith"] } }] } }, why: "Other project" });
    await expect(f.runtime.hire("lead", "project", { ...f.leadHire, placementRuleId: "shop" })).rejects.toThrow(/does not match.*project/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    f.settings.update({ revision: 2, patch: { machines: { rules: [{ ...rule, match: { projectIds: ["project"], classes: ["smith"] } }] } }, why: "This project" });
    expect((await f.runtime.hire("lead", "project", { ...f.leadHire, placementRuleId: "shop" })).placement?.rule?.id).toBe("shop");
  });

  it("reconciles a late child arrival after an unknown spawn outcome without a user retry", async () => {
    const f = fixture();
    vi.spyOn(f.bb.sdk.threads, "spawn").mockRejectedValue(new Error("Allocation reply lost"));
    await blocked(f.runtime.hire("lead", "project", hire));
    const record = f.services.store.activePage(null, 100)[0];
    expect(f.services.controller.bindChild(record, "arrived")).toMatchObject({ memberThreadId: "arrived", phase: "bootstrapping", blocked: null });
    expect(f.k.store.get("hires", record.hireToken)?.memberThreadId).toBe("arrived");
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("keeps a child already bound by dispatch when the spawn reply is lost", async () => {
    const f = fixture(), member = await f.runtime.hire("lead", "project", hire), record = f.services.store.byMember(member.threadId)!;
    expect(f.services.controller.spawnFailed(record, new Error("Reply lost"))).toEqual(record);
    expect(f.services.store.byMember(member.threadId)).toEqual(record);
  });

  it("finishes the normal waypoint hire after dispatch binds the child and the spawn reply is lost", async () => {
    const f = fixture(), quest = await seedQuest(f.k, "lead", "Build after a lost reply", "LOST");
    f.k.plan("lead", { ...planInput(quest.id), party: [{ classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] }] });
    f.k.answerAsk(f.k.asks("lead").find(ask => ask.state === "open" && ask.kind === "greenlight")!.id, "approve", null, "page");
    const prepare = vi.spyOn(f.port, "prepare"), link = vi.spyOn(f.port, "linkWaypoint");
    const delivered = vi.spyOn(f.runtime, "spawnBriefDelivered");
    const spawn = vi.spyOn(f.bb.sdk.threads, "spawn").mockImplementation(async args => {
      const child = makeThreadResponse({ id: "dispatched-child", status: "pending", projectId: "project", parentThreadId: "lead", environmentId: null });
      const ctx = dispatch049({ threadId: child.id, status: "pending", pluginId: "tavern", submission: args.pluginSubmission });
      ctx.thread = child; ctx.input = { text: inputText(args.input!), blocks: args.input! };
      expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "proceed" });
      expect(f.services.store.byMember(child.id)?.phase).toBe("bootstrapping");
      delivered.mockClear();
      throw new Error("Connection lost after child dispatch");
    });
    const member = await f.runtime.hire("lead", "project", { ...hire, classId: "smith", errand: false, boardQuestId: quest.id, waypointId: "w1" });
    expect(member.threadId).toBe("dispatched-child");
    expect(spawn).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(member.threadId);
    expect(link).toHaveBeenCalledWith(member.threadId, { boardQuestId: quest.id, waypointId: "w1" }, "Build", member.threadId, { kind: "agent", threadId: "lead" });
    expect(f.k.store.events("lead", 0, 100).filter(event => event.type === "member.hired" && event.data.memberThreadId === member.threadId)).toHaveLength(1);
    expect(delivered).toHaveBeenCalledExactlyOnceWith(member.threadId);
    expect(f.k.store.runtime(member.threadId)).toMatchObject({ classDefinition: { id: "smith" }, executionNotes: member.executionNotes });
    expect(f.k.store.all("hires")).toEqual([]);
    expect(f.services.store.byMember(member.threadId)?.blocked).toBeNull();
  });

  it.each([
    { outcome: "unknown", message: "Allocation still reconciling", firstLine: /^Allocation still reconciling$/ },
    { outcome: "hold", message: "Hire outcome unknown; quoted provider label", firstLine: /^Not hired\./ },
  ] as const)("selects the $outcome hire reply from its outcome field, not the message", async ({ outcome, message, firstLine }) => {
    const f = fixture(); registerTools(f.bb, f.runtime);
    vi.spyOn(f.runtime, "hire").mockRejectedValue(new PlacementHireBlocked(message, null, outcome));
    const result = await f.harness.behavior.invokeAgentTool("tavern_hire", hire, { threadId: "lead" });
    expect(result).toMatch(firstLine);
  });

  it("shows an unknown-outcome hire hold and refuses a second errand allocation", async () => {
    const f = fixture(); registerTools(f.bb, f.runtime);
    vi.spyOn(f.bb.sdk.threads, "spawn").mockRejectedValue(new Error("Allocation reply lost"));
    const result = await f.harness.behavior.invokeAgentTool("tavern_hire", hire, { threadId: "lead" });
    expect(result).toMatch(/^Hire outcome unknown; placement .* keeps its slot and no second machine will be allocated\./);
    expect(result).toContain("Do not hire again; the user can press Retry on the placement.");
    const held = await blocked(f.runtime.hire("lead", "project", hire));
    expect(held.message).toContain("Hire outcome unknown");
    expect(held).toMatchObject({ outcome: "unknown" });
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("puts the placement summary first even when a lead stays with the Keeper", async () => {
    const f = await leadFixture(); registerTools(f.bb, f.runtime);
    const result = await f.harness.behavior.invokeAgentTool("tavern_hire", f.leadHire, { threadId: "lead" });
    expect(result).toMatch(/^Where the Keeper runs; lead default\./);
  });

  it("does not put match facts inside a rule label containing the setup delimiter", async () => {
    const f = fixture();
    f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, label: "Shop; setup members" }] } }, why: "Label" });
    expect((await f.runtime.hire("lead", "project", hire)).placementSummary).toContain('rule "Shop; setup members" (shop); matched projectIds=project; setup bootstrapping');
  });

  it("rebuilds provider and host display names in one status read batch after reload", async () => {
    const f = fixture(), member = await f.runtime.hire("lead", "project", hire), record = f.services.store.byMember(member.threadId)!;
    f.services.store.update(record.id, 1, value => ({ ...value, hostId: "worker" }));
    const providers = vi.spyOn(f.bb.sdk.environments, "listProviders"); providers.mockClear();
    const hosts = vi.fn(async () => [{ id: "worker", name: "Worker machine" }]);
    Object.assign(f.bb.sdk.hosts, { list: hosts });
    const reloaded = new PlacementController(f.runtime, f.services);
    const status = await reloaded.status("lead");
    expect(status.members[0].placement.where.label).toBe("Worker machine");
    expect(status.classes.find(row => row.classId === "smith")?.line).toContain("Vendor checkout");
    expect(providers).toHaveBeenCalledTimes(1); expect(hosts).toHaveBeenCalledTimes(1);
  });

  it("keeps raw display ids and logs once when the status name batch is unavailable", async () => {
    const f = fixture(), member = await f.runtime.hire("lead", "project", hire), record = f.services.store.byMember(member.threadId)!;
    f.services.store.update(record.id, 1, value => ({ ...value, hostId: "worker" }));
    vi.spyOn(f.bb.sdk.environments, "listProviders").mockRejectedValue(new Error("Providers offline"));
    Object.assign(f.bb.sdk.hosts, { list: vi.fn(async () => { throw new Error("Hosts offline"); }) });
    const warning = vi.spyOn(f.bb.log, "warn");
    const reloaded = new PlacementController(f.runtime, f.services);
    const status = await reloaded.status("lead");
    expect(status.members[0].placement.where.label).toBe("worker");
    expect(status.classes.find(row => row.classId === "smith")?.line).toContain("vendor-checkout");
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it("does not label a blocked placement without a host as starting", async () => {
    const f = fixture();
    vi.spyOn(f.bb.sdk.threads, "spawn").mockRejectedValue(new Error("Allocation reply lost"));
    await blocked(f.runtime.hire("lead", "project", hire));
    expect(f.services.controller.view(f.services.store.activePage(null, 100)[0]).where.label).not.toContain("starting");
  });

  it("retains an unknown spawn outcome and reconciles only the exact hire token without a second allocation", async () => {
    const f = fixture();
    vi.spyOn(f.bb.sdk.threads, "spawn").mockRejectedValue(new Error("Connection lost after allocation"));
    const result = await blocked(f.runtime.hire("lead", "project", hire));
    const record = f.services.store.activePage(null, 100)[0];
    expect(record.blocked).toMatchObject({ code: "spawn-outcome-unknown", message: "Connection lost after allocation" });
    expect(f.k.store.get("hires", record.hireToken)).not.toBeNull();
    Object.assign(f.bb.sdk.threads, { list: vi.fn(async ({ archived }: { archived: boolean }) => archived ? [] : [{ id: "late-member", createdAt: f.time() }]),
      getPluginMetadata: vi.fn(async () => ({ hireToken: record.hireToken })) });
    expect(await f.services.controller.retry(record.id, record.generation)).toMatchObject({ phase: "bootstrapping" });
    expect(f.services.store.byMember("late-member")).toMatchObject({ id: record.id });
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(result.message).toContain("Connection lost after allocation");
  });
});
