// @vitest-environment node
import { runtimeFixture } from "./member-fixture";
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
    projects: { get: async ({ projectId }: { projectId: string }) => ({ id: projectId, sources: [], gitRemoteUrl: "https://example.invalid/team/repo.git" }) },
    environments: { list: async () => [], listProviders: async () => [worktreeProvider({ id: "vendor-checkout", displayName: "Vendor checkout", availability: null,
      inputs: { type: "object", properties: { base: { type: "string" }, branch: { type: "string" } }, required: ["base", "branch"] }, acceptsEmptyInputs: false })] },
    hosts: { list: async () => [], get: async ({ hostId }: { hostId: string }) => ({ id: hostId, name: "Home" }),
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
  const classes = registry.classes.map(role => role.id === "keeper" ? { ...role, hireable: true, environment: "worktree" as const, model: "anthropic/claude-sonnet-5-5" } : role);
  vi.spyOn(f.runtime, "prepareRegistry").mockResolvedValue({ ...registry, classes });
  const quest = await seedQuest(f.k, "lead", "Hire a lead", "LEAD");
  f.k.plan("lead", { ...planInput(quest.id), waypoints: [{ ...planInput(quest.id).waypoints[0]!, owner: "keeper" }], party: [{ classId: "keeper", characterId: null, model: null, purpose: "Lead", waypointIds: ["w1"], leadEnvelope: { members: 2, rangers: 1, depth: 1 } }] });
  f.k.answerAsk(f.k.asks("lead").find(ask => ask.state === "open" && ask.kind === "greenlight")!.id, "approve", null, "page", "user");
  return { ...f, leadHire: { ...hire, classId: "keeper", errand: false, boardQuestId: quest.id, waypointId: "w1" } };
}

async function blocked(promise: Promise<unknown>) {
  try { await promise; throw new Error("Expected a visible placement blocker"); }
  catch (error) { expect(error).toBeInstanceOf(PlacementHireBlocked); return error as PlacementHireBlocked; }
}

it("chooses distinct names when two placed hires revalidate the same Keeper's checkout together", async () => {
  const f = fixture();
  f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, match: { ...rule.match, keeperPathGlobs: ["/source"] } }] } }, why: "Match the Keeper's checkout" });
  const characterId = f.runtime.snapshot().classes.find(c => c.id === "ranger")!.characters[0]!;
  const name = f.runtime.snapshot().characters.find(c => c.id === characterId)!.name;
  let ready!: () => void;
  const both = new Promise<void>(resolve => { ready = resolve; });
  let reads = 0;
  vi.mocked(f.services.sources.revalidate).mockImplementation(async () => {
    if (++reads === 2) ready();
    if (reads <= 2) await both;
  });
  const input = { ...hire, characterId };
  const members = await Promise.all([f.runtime.hire("lead", "project", input), f.runtime.hire("lead", "project", input)]);
  expect(members.map(m => m.displayName).sort()).toEqual([name, `${name} II`]);
});

describe("target model failures", () => {
  it.each(["running", "stop-error", "archive-error"])("keeps a visible release hold after a %s first-turn model failure and retries", async fault => {
    const f = fixture();
    f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, classModels: { ranger: { model: "anthropic/claude-sonnet-5-5" } } }] } }, why: "Set target model" });
    const member = await f.runtime.hire("lead", "project", hire);
    let stopped = false, archived = false;
    vi.spyOn(f.bb.sdk.threads, "get").mockImplementation(async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "project", status: stopped ? "error" : "active", archivedAt: archived ? 1 : null }));
    const stop = f.bb.sdk.threads.stop = vi.fn(async () => { if (fault === "stop-error") throw new Error("Stop failed"); if (fault === "archive-error") stopped = true; return {} as never; });
    const archive = vi.spyOn(f.bb.sdk.threads, "archive").mockImplementation(async () => { if (fault === "archive-error") throw new Error("Archive failed"); archived = true; return {} as never; });
    await expect(f.runtime.failed(member.threadId, "Failed to resolve Pi model anthropic/claude-sonnet-5-5", "first")).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalled();
    expect(f.k.store.all("placementModelFailures")).toHaveLength(1);
    const record = f.services.store.byMember(member.threadId)!;
    expect(record.blocked).toMatchObject({ stage: "release", retryable: true });
    expect(runtimeFixture(f.k.store, member.threadId).releasePending).toBeTruthy();
    stopped = true;
    stop.mockResolvedValue({} as never);
    archive.mockImplementation(async () => { archived = true; return {} as never; });
    await f.services.controller.retry(record.id, record.generation);
    expect(f.services.store.byMember(member.threadId)?.phase).toBe("released");
    expect(runtimeFixture(f.k.store, member.threadId).released).toBeTruthy();
  });
  it("does not settle the first turn from an idle event before its failed turn event", async () => {
    const f = fixture();
    f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, classModels: { ranger: { model: "anthropic/claude-sonnet-5-5" } } }] } }, why: "Set target model" });
    const member = await f.runtime.hire("lead", "project", hire);
    vi.spyOn(f.runtime, "release").mockResolvedValue(true);
    f.runtime.memberEnded(makeThreadResponse({ id: member.threadId, status: "idle" }));
    await f.runtime.failed(member.threadId, "Failed to resolve Pi model anthropic/claude-sonnet-5-5", "first");
    expect(f.k.store.all("placementModelFailures")).toHaveLength(1);
  });
  it("records a first-turn resolution failure, releases, and refuses the next hire before reservation", async () => {
    const f = fixture();
    f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, classModels: { ranger: { model: "anthropic/claude-sonnet-5-5" } } }] } }, why: "Set target model" });
    const member = await f.runtime.hire("lead", "project", hire);
    const model = "anthropic/claude-sonnet-5-5";
    const release = vi.spyOn(f.runtime, "release").mockResolvedValue(true);
    vi.spyOn(f.bb.sdk.threads, "archive").mockResolvedValue({} as never);
    await f.runtime.failed(member.threadId, `Failed to resolve Pi model ${model}`, "request-1");
    expect(release).toHaveBeenCalledWith("lead", member.threadId, expect.stringContaining("can't run"), { kind: "host-failure", id: "request-1", evidence: { modelFailureId: expect.any(String) } });
    const reserve = vi.spyOn(f.services.controller, "reserve");
    await expect(f.runtime.hire("lead", "project", hire)).rejects.toThrow(/can't run.*set this rule's model for ranger/);
    expect(reserve).not.toHaveBeenCalled();
    expect(f.k.store.all("placementModelFailures")).toHaveLength(1);
    const record = f.k.store.all("placementModelFailures")[0];
    f.runtime.clearPlacementModelFailure(record.id);
    expect(f.k.store.all("placementModelFailures")).toEqual([]);
  });
  it.each(["unrouted", "held", "Stop all"] as const)("retains first-turn model cleanup with %s", async gate => {
    const f = fixture(), q = await seedQuest(f.k, "lead", "Model test", "Model test");
    f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, classModels: { ranger: { model: "anthropic/claude-sonnet-5-5" } } }] } }, why: "Set target model" });
    const member = await f.runtime.hire("lead", "project", { ...hire, errand: false, boardQuestId: q.id });
    const held = vi.spyOn(f.k, "quest");
    if (gate === "unrouted") {
      f.k.endTurn("lead");
      f.k.receiveUser("lead", "An unrouted message");
      expect(() => f.k.guard("lead", q.id)).toThrow(/unrouted/);
    }
    if (gate === "Stop all") f.k.store.put("stopAll", "tavern", { state: "stopped", since: f.time(), by: { kind: "user" }, receipt: null });
    const readQuest = held.getMockImplementation()!;
    if (gate === "held") held.mockImplementation(id => ({ ...readQuest.call(f.k, id), phase: "held" }));
    let archived = false;
    vi.spyOn(f.bb.sdk.threads, "get").mockImplementation(async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "project", status: "error", archivedAt: archived ? 1 : null }));
    const archive = vi.spyOn(f.bb.sdk.threads, "archive").mockImplementation(async () => { archived = true; return {} as never; });
    f.bb.sdk.threads.stop = vi.fn().mockResolvedValue({} as never);
    await f.runtime.failed(member.threadId, "Failed to resolve Pi model anthropic/claude-sonnet-5-5", "failure-receipt");
    if (gate === "unrouted") expect(f.k.member(member.threadId)?.engagement).toBe("released");
    else {
      expect(f.k.member(member.threadId)?.engagement).toBe("releasing");
      expect(runtimeFixture(f.k.store, member.threadId).memberEngagement?.operation?.receipt.id).toBe("failure-receipt");
      expect(archive).not.toHaveBeenCalled();
      if (gate === "Stop all") f.k.store.remove("stopAll", "tavern");
      held.mockRestore();
      expect(await f.runtime.retryModelFailureRelease(member.threadId)).toBe(true);
    }
    expect(f.services.store.byMember(member.threadId)?.phase).toBe("released");
  });

  it("uses the first turn's actual failure text and completes normal release without preservation", async () => {
    const f = fixture();
    f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, classModels: { ranger: { model: "anthropic/claude-sonnet-5-5" } } }] } }, why: "Set target model" });
    const member = await f.runtime.hire("lead", "project", hire);
    let archived = false;
    vi.spyOn(f.bb.sdk.threads, "get").mockImplementation(async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "project", status: "error", archivedAt: archived ? 1 : null }));
    vi.spyOn(f.bb.sdk.threads, "archive").mockImplementation(async () => { archived = true; return {} as never; });
    f.bb.sdk.threads.stop = vi.fn().mockResolvedValue({} as never);
    vi.spyOn(f.bb.sdk.threads.events, "list").mockResolvedValue([{ type: "turn/completed", data: { status: "failed", error: { message: "Failed to resolve Pi model anthropic/claude-sonnet-5-5" } } }] as never);
    const capture = vi.spyOn(f.services.capture, "initial").mockClear();
    await f.runtime.failed(member.threadId, "Provider turn failed", "first");
    expect(f.services.store.byMember(member.threadId)).toMatchObject({ phase: "released", preservation: { source: "not-needed" } });
    expect(runtimeFixture(f.k.store, member.threadId).released).toBeTruthy();
    expect(capture).not.toHaveBeenCalled();
  });
  it("does not treat a later model error as a first-turn failure", async () => {
    const f = fixture(), member = await f.runtime.hire("lead", "project", hire);
    vi.spyOn(f.bb.sdk.threads.events, "list").mockResolvedValue([{ type: "turn/completed", data: { status: "completed" } }] as never);
    await f.runtime.failed(member.threadId, "Failed to resolve Pi model anthropic/test", "later");
    expect(f.k.store.all("placementModelFailures")).toEqual([]);
  });
  it("does not record ordinary failures or failures after the first turn", async () => {
    const f = fixture(), member = await f.runtime.hire("lead", "project", hire);
    await f.runtime.failed(member.threadId, "Network timed out", "one");
    await f.runtime.failed(member.threadId, "Failed to resolve Pi model anthropic/test", "two");
    expect(f.k.store.all("placementModelFailures")).toEqual([]);
  });
});

describe("repo picks", () => {
  it.each([{ provider: "vendor-checkout", machine: { provider: "vendor-compute", inputs: { size: 64 } } }, { ruleId: "shop", inputs: { base: "invented" } }])("rejects untrusted placement inputs without borrowing consent", async placement => {
    const f = fixture(), spawn = vi.spyOn(f.bb.sdk.threads, "spawn");
    await expect(f.runtime.hire("lead", "project", { ...hire, placement: placement as never })).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each([{ projectIds: ["other"] }, { projectIds: ["project"], classes: ["warden"] }, { repoRemotes: ["github.com/other/repo"] }, { keeperPathGlobs: ["/not/the/repo/**"] }, { questIds: ["other-quest"] }])("refuses a rule outside the repo or class choices", async match => {
    const f = fixture(), spawn = vi.spyOn(f.bb.sdk.threads, "spawn");
    f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, match }] } }, why: "Scoped rule" });
    const choices = await f.runtime.placementChoices("lead", "project", "ranger");
    expect(choices).not.toContain('placement={"ruleId":"shop"}');
    await expect(f.runtime.hire("lead", "project", { ...hire, placement: { ruleId: "shop" } })).rejects.toThrow(/not offered/);
    expect(spawn).not.toHaveBeenCalled();
  });
  it("offers a quest-scoped rule only with that quest's matching facts", async () => {
    const f = fixture(), quest = await seedQuest(f.k, "lead", "Scoped discovery", "SCOPED");
    f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, match: { projectIds: ["project"], classes: ["ranger"], questIds: [quest.id] } }] } }, why: "Quest rule" });
    expect(await f.runtime.placementChoices("lead", "project", "ranger")).not.toContain('placement={"ruleId":"shop"}');
    expect(await f.runtime.placementChoices("lead", "project", "ranger", quest.id)).toContain('placement={"ruleId":"shop"}');
  });
  it("does not keep consent on an earlier pick after its rule is turned off", async () => {
    const f = fixture();
    await f.runtime.hire("lead", "project", hire);
    f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, enabled: false }] } }, why: "Revoke" });
    expect(f.k.store.all("placementPicks")[0]).toMatchObject({ ruleId: "shop" });
    expect(f.k.store.all("placementPicks")[0]).not.toHaveProperty("target");
    expect(await f.runtime.placementChoices("lead", "project", "ranger")).toContain('Earlier picks for this remote: rule shop (not currently offered)');
    await expect(f.runtime.hire("lead", "project", { ...hire, placement: { ruleId: "shop" } })).rejects.toThrow(/not offered/);
  });
  it("lists choices when another repo has no rule or pick", async () => {
    const f = fixture();
    vi.spyOn(f.bb.sdk.projects, "get").mockResolvedValue({ id: "other", sources: [{ projectId: "other", hostId: "host", path: "/other", isDefault: true }], gitRemoteUrl: "https://example.invalid/other.git" } as never);
    vi.spyOn(f.bb.sdk.environments, "list").mockResolvedValue([{ id: "other-env", projectId: "other", hostId: "host", path: "/other", environmentProviderId: "project-checkout", status: "ready", hostLifecycle: "active", lifecycle: { phase: "active" } }] as never);
    await expect(f.runtime.hire("lead", "project", { ...hire, repo: "other" })).rejects.toThrow(/needs a rule or the Keeper's placement pick.*\nRepo other/s);
  });
  it("defaults the repo and names it on the first line", async () => {
    const f = fixture();
    const member = await f.runtime.hire("lead", "project", hire);
    expect(member.repo).toBe("project");
    expect(member.placementSummary).toMatch(/^Repo project; rule Shop members \(shop\);/);
  });
  it("lets a working member pick a rule", async () => {
    const f = fixture();
    const member = await f.runtime.hire("lead", "project", { ...hire, placement: { ruleId: "shop" } });
    expect(member.placementSummary).toContain("Keeper's pick: rule shop");
  });
  it("lets the Keeper explicitly stay in its own repo without taking a machine rule", async () => {
    const f = fixture();
    const member = await f.runtime.hire("lead", "project", { ...hire, placement: { kind: "current" } });
    expect(member.placement).toBeNull();
    expect(member.placementSummary).toContain("Keeper's pick: where the Keeper runs");
    expect(await f.runtime.placementChoices("lead", "project", "ranger")).toContain('placement={"kind":"current"}');
  });
  it("matches an old saved rule against the member repo and spawns there", async () => {
    const f = fixture(), spawn = vi.spyOn(f.bb.sdk.threads, "spawn");
    f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, match: { projectIds: ["other"] } }] } }, why: "Repo rule" });
    const source = await f.services.sources.inspect("lead", "project");
    vi.spyOn(f.bb.sdk.projects, "get").mockResolvedValue({ id: "other", sources: [{ projectId: "other", hostId: "host", path: "/other", isDefault: true }], gitRemoteUrl: "https://example.invalid/other.git" } as never);
    vi.spyOn(f.services.sources, "inspect").mockResolvedValue({ ...source, projectId: "other", endpoint: { hostId: "host", environmentId: "other-env", root: "/other" } } as KnownSource);
    vi.spyOn(f.bb.sdk.environments, "list").mockResolvedValue([{ id: "other-env", projectId: "other", hostId: "host", path: "/other", environmentProviderId: "project-checkout", status: "ready", hostLifecycle: "active", lifecycle: { phase: "active" } }] as never);
    vi.spyOn(f.services.capture, "initial").mockImplementation(async () => f.services.store.saveSnapshot(sourceSnapshot({ projectId: "other", keeperThreadId: "lead", sourceThreadId: "lead", source: { hostId: "host", environmentId: "other-env", root: "/other" }, home: { hostId: "host", environmentId: "other-env", root: "/other" } })));
    const member = await f.runtime.hire("lead", "project", { ...hire, repo: "other" });
    expect(member.repo).toBe("other");
    expect(spawn.mock.calls[0][0]).toMatchObject({ projectId: "other", environment: { inputs: { base: sourceSnapshot().base } } });
    const placed = f.services.store.byMember(member.threadId)!;
    expect(f.services.store.snapshot(placed.sourceSnapshotId!)).toMatchObject({ projectId: "other", source: { root: "/other" }, home: { root: "/other" } });
    expect(f.services.sources.inspect).toHaveBeenCalledWith("lead", "other");
    expect(f.services.capture.initial).toHaveBeenCalledWith(expect.objectContaining({ projectId: "other" }), undefined, { pushedBaseOnly: true });
  });
  it("refuses a repo without a laptop checkout", async () => {
    const f = fixture(), spawn = vi.spyOn(f.bb.sdk.threads, "spawn");
    await expect(f.runtime.hire("lead", "project", { ...hire, repo: "other" })).rejects.toThrow(/no checkout on this host/);
    expect(spawn).not.toHaveBeenCalled();
  });
  it("lists the matching rule and earlier picks for the same remote", async () => {
    const f = fixture();
    await f.runtime.hire("lead", "project", hire);
    const text = await f.runtime.placementChoices("lead", "project", "ranger");
    expect(text).toContain("Recommendation: rule Shop members (shop)");
    expect(text).toContain("Earlier picks");
    expect(text).toContain("vendor-checkout");
  });
});

describe("rule-driven member hires", () => {
  it.each([false, true])("uses the rule model for a placed Smith (full override: %s)", async full => {
    const f = fixture(), registry = await f.runtime.prepareRegistry("project");
    vi.spyOn(f.runtime, "prepareRegistry").mockResolvedValue({ ...registry, classes: registry.classes.map(role => role.id === "smith" ? { ...role, provider: "pi", model: "anthropic/claude-sonnet-5-5", reasoning: "high" } : role) });
    const override = full ? { provider: "other", model: "openai/gpt-6.1-sol", reasoning: "low" } : { model: "openai/gpt-6.1-sol" };
    f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, classModels: { smith: override } }] } }, why: "Choose remote model" });
    const quest = await seedQuest(f.k, "lead", "Build with rule model", "MODEL");
    f.k.plan("lead", { ...planInput(quest.id), party: [{ classId: "smith", characterId: null, model: "slot/model", purpose: "Build", waypointIds: ["w1"] }] });
    f.k.answerAsk(f.k.asks("lead").find(ask => ask.state === "open" && ask.kind === "greenlight")!.id, "approve", null, "page", "user");
    const spawn = vi.spyOn(f.bb.sdk.threads, "spawn");
    const member = await f.runtime.hire("lead", "project", { ...hire, classId: "smith", errand: false, boardQuestId: quest.id, waypointId: "w1" });
    expect(spawn.mock.calls[0][0]).toMatchObject({ providerId: full ? "other" : "pi", model: override.model, reasoningLevel: full ? "low" : "high" });
    expect(f.k.store.runtime(member.threadId).classDefinition).toMatchObject({ provider: full ? "other" : "pi", model: override.model, reasoning: full ? "low" : "high" });
    expect(member.executionNotes).toContain("model slot/model -> openai/gpt-6.1-sol (rule shop)");
    expect(member.executionNotes.filter(note => note.startsWith("provider ") && note.endsWith("(rule shop)"))).toEqual(full ? ["provider pi -> other (rule shop)"] : []);
    expect(member.executionNotes.filter(note => note.startsWith("reasoning ") && note.endsWith("(rule shop)"))).toEqual(full ? ["reasoning high -> low (rule shop)"] : []);
    expect((await f.runtime.prepareRegistry("project")).classes.find(role => role.id === "smith")?.model).toBe("anthropic/claude-sonnet-5-5");
  });
  it.each(["unplaced", "current"])("does not use a rule override for a %s hire", async route => {
    const f = fixture();
    f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, ...(route === "current" ? { target: { kind: "current" as const } } : { match: { classes: ["smith"] } }), classModels: { ranger: { model: "missing/model" } } }] } }, why: "No machine override" });
    const spawn = vi.spyOn(f.bb.sdk.threads, "spawn");
    const member = await f.runtime.hire("lead", "project", hire);
    expect(member.placement).toBeNull();
    expect(spawn.mock.calls[0][0].model).not.toBe("missing/model");
    expect(member.executionNotes.some(note => note.includes("(rule shop)"))).toBe(false);
  });
  it("puts the rule-model clause on the hire result\u0027s first line", async () => {
    const f = fixture(), registry = await f.runtime.prepareRegistry("project");
    const from = registry.classes.find(role => role.id === "ranger")!.model ?? "provider default";
    f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, classModels: { ranger: { model: "openai/gpt-6.1-sol" } } }] } }, why: "Rule model" });
    registerTools(f.bb, f.runtime);
    const result = await f.harness.behavior.invokeAgentTool("tavern_hire", hire, { threadId: "lead" });
    expect(String(result).split("\n")[0]).toContain(`model ${from} -> openai/gpt-6.1-sol (rule shop)`);
  });
  it("puts provider and reasoning changes from inherited defaults on the hire result's first line", async () => {
    const f = fixture(), registry = await f.runtime.prepareRegistry("project");
    vi.spyOn(f.runtime, "prepareRegistry").mockResolvedValue({ ...registry, classes: registry.classes.map(role => role.id === "ranger" ? { ...role, provider: null, reasoning: null } : role) });
    f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, classModels: { ranger: { provider: "other", model: "openai/gpt-6.1-sol", reasoning: "low" } } }] } }, why: "Rule execution" });
    registerTools(f.bb, f.runtime);
    const result = await f.harness.behavior.invokeAgentTool("tavern_hire", hire, { threadId: "lead" });
    const line = String(result).split("\n")[0];
    expect(line).toContain("provider pi -> other (rule shop)");
    expect(line).toContain("reasoning provider default -> low (rule shop)");
  });
  it("refuses an unverified rule model without allocating or substituting", async () => {
    const f = fixture();
    f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, classModels: { ranger: { model: "missing/model" } } }] } }, why: "Unknown model" });
    await expect(f.runtime.hire("lead", "project", hire)).rejects.toThrow("Cannot hire ranger: rule shop model missing/model is not offered or could not be verified");
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(f.services.store.activePage(null, 100)).toEqual([]);
  });
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
    await expect(f.k.openQuest(member.threadId, "Placed lead", "Lead")).rejects.toThrow("Call tavern_ready");
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

  it("refuses a lead rule outside its project or classes", async () => {
    const f = await leadFixture();
    f.settings.update({ revision: 1, patch: { machines: { rules: [{ ...rule, match: { projectIds: ["other"], classes: ["smith"] } }] } }, why: "Other project" });
    await expect(f.runtime.hire("lead", "project", { ...f.leadHire, placementRuleId: "shop" })).rejects.toThrow(/not offered/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    f.settings.update({ revision: 2, patch: { machines: { rules: [{ ...rule, match: { projectIds: ["project"], classes: ["smith"] } }] } }, why: "This project" });
    await expect(f.runtime.hire("lead", "project", { ...f.leadHire, placementRuleId: "shop" })).rejects.toThrow(/not offered/);
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
    f.k.answerAsk(f.k.asks("lead").find(ask => ask.state === "open" && ask.kind === "greenlight")!.id, "approve", null, "page", "user");
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
    expect(result).toMatch(/^Repo project; lead default; where the Keeper runs\./);
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
