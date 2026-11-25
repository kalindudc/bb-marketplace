// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { resolveHireExecution } from "../../src/server/execution";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights";
import { registerRpc } from "../../src/server/rpc";
import { registerTools } from "../../src/server/tools";
import { createJournalStore } from "../../src/server/journal/store";
import type { Member } from "../../src/shared/schema";
import { setup } from "./runtime-fixture";
import { catalog, model } from "./provider-fixture";
import { makeThreadResponse } from "./host";
import { planInput, waypointEntry } from "./support";

const fallback = "same-family check (not independent)";
const anthropic = "anthropic/claude-sonnet-5-5";
const openai = "openai/gpt-6.1-sol";
const brief = { outcome: "Check the maker's evidence", mode: "make-it-work" as const, outOfScope: "Changes", doneWhen: "Verify or reject", context: [], questions: [], timeboxMinutes: null };
function execution(models = [model(anthropic), model(openai, ["high"], false)]) {
  const f = setup();
  const role = { ...f.runtime.snapshot().classes.find(role => role.id === "warden")!, model: models[0]!.model };
  f.bb.sdk.providers.models = async () => catalog(models);
  return { ...f, role, resolve: (providerId: string, makerModel: string | null) => resolveHireExecution(f.bb, role, {
    providerId: "pi", environmentId: null, projectId: "project", maker: { providerId, model: makerModel, environmentId: null },
  }) };
}

async function review(classId = "smith") {
  const f = setup();
  const q = await seedQuest(f.k,"lead", "Build", "Build");
  f.k.bind("maker", classId, classId === "ranger" ? "lark" : "bram", "project", {
    keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", errand: false, title: "Make", brief,
  });
  const entries = [waypointEntry("maker", q.id), waypointEntry("maker", q.id, "w1", "a2"), waypointEntry("maker", q.id, "w2", "b1")];
  const get = f.port.get;
  f.port.get = threadId => ({ ...get(threadId), entries: threadId === "maker" ? entries : [] });
  f.port.linkedEntries = id => id === q.id ? entries : [];
  const base = planInput(q.id);
  f.k.plan("lead", { ...base, waypoints: [{ ...base.waypoints[0]!, owner: "maker" }], party: [{ classId: "warden", characterId: null, model: null, purpose: "Check", waypointIds: ["w1"] }] });
  f.k.answerAsk(f.k.store.openAsks("lead").find(ask => ask.kind === "greenlight")!.id, "approve", null, "page", "user");
  f.bb.sdk.threads.get = async ({ threadId }) => makeThreadResponse({ id: threadId, providerId: threadId === "maker" ? "corp-router-anthropic" : "pi" });
  f.bb.sdk.threads.defaultExecutionOptions = async () => ({ model: anthropic, permissionMode: "full", reasoningLevel: "high", serviceTier: "standard", source: "client/turn/start" });
  const input = { classId: "warden", boardQuestId: q.id, waypointId: "w1", title: "Check", brief };
  return { ...f, q, entries, input };
}

describe("Warden model family evidence", () => {
  it.each([
    ["pi", "corp-router-anthropic/corp/dev"],
    ["corp-router-anthropic", "corp/dev"],
    ["pi", "router/google/scratch-gemini"],
    ["router-openai", "corp/dev"],
  ])("recognizes vendor tokens throughout provider %s and model %s", async (providerId, makerModel) => {
    const ownerIsAnthropic = `${providerId}/${makerModel}`.includes("anthropic");
    const f = execution([
      model(makerModel),
      model("custom/unknown-checker", ["high"], false),
      model(ownerIsAnthropic ? openai : anthropic, ["high"], false),
    ]);
    const result = await f.resolve(providerId, makerModel);
    expect(result).toMatchObject({ model: ownerIsAnthropic ? openai : anthropic, checkIndependence: "independent" });
  });

  it("never treats an opaque default candidate as independent from a known maker", async () => {
    const f = execution([model("custom/dev"), model(anthropic, ["high"], false), model(openai, ["high"], false)]);
    expect(await f.resolve("pi", anthropic)).toMatchObject({ model: openai, checkIndependence: "independent" });
  });

  it("uses routed-provider and display metadata for opaque model ids", async () => {
    const f = execution([
      { ...model("opaque/owner"), displayName: "Claude Sonnet", routeProviderId: "corp-router-anthropic" },
      { ...model("opaque/checker", ["high"], false), displayName: "GPT checker", routeProviderId: "corp-router-openai" },
    ]);
    expect(await f.resolve("pi", "opaque/owner")).toMatchObject({ model: "opaque/checker", checkIndependence: "independent" });
  });

  it.each(["opaque/maker", null])("fails closed on unknown maker family %s and labels its class-model fallback", async makerModel => {
    const f = execution();
    const result = await f.resolve("pi", makerModel);
    expect(result).toMatchObject({ model: anthropic, checkIndependence: "not-established" });
    expect(result.notes.join(" ")).toContain("check independence not established");
    expect(result.notes.join(" ")).not.toContain("Independent checker model");
  });

  it("refuses an unadvertised checker model before spawning, not after it fails", async () => {
    const f = setup();
    const role = { ...f.runtime.snapshot().classes.find(candidate => candidate.id === "warden")!, model: "anthropic/claude-opus-5-5" };
    f.bb.sdk.providers.models = async () => ({ ...catalog([model("openai/gpt-6.1-sol")]), selectedOnlyModels: [model("anthropic/claude-opus-5-5")] });
    await expect(resolveHireExecution(f.bb, role, {
      providerId: "pi", environmentId: null, projectId: "project",
      maker: { providerId: "pi", model: "openai/gpt-6.1-sol", environmentId: null },
    })).rejects.toThrow(/claude-opus-5-5.*classes[.]warden[.]model/);
  });

  it("keeps a configured different-family class model instead of substituting another", async () => {
    const f = execution([model(openai), model(anthropic, ["high"], false, "high")]);
    const result = await f.resolve("pi", anthropic);
    expect(result).toMatchObject({ model: openai, checkIndependence: "independent" });
    expect(result.notes.join(" ")).toContain("Kept the configured checker model");
    expect(result.notes.join(" ")).not.toContain("was replaced");
  });

  it("says so when a same-family class model is replaced to keep the check independent", async () => {
    const f = execution([model(anthropic), model(openai, ["high"], false)]);
    const result = await f.resolve("pi", anthropic);
    expect(result).toMatchObject({ model: openai, checkIndependence: "independent" });
    expect(result.notes.join(" ")).toContain("the configured class model " + anthropic + " was replaced");
    expect(result.notes.join(" ")).toContain("model " + anthropic + " -> " + openai);
  });

  it("never counts the maker's own model as a different family, whatever the catalog calls it", async () => {
    const f = setup();
    const role = { ...f.runtime.snapshot().classes.find(candidate => candidate.id === "warden")!, model: "corp/dev" };
    f.bb.sdk.providers.models = async ({ providerId }: { providerId: string }) => {
      if (providerId === "corp-router-anthropic") throw new Error("maker catalog unavailable");
      return catalog([
        { ...model("corp/dev", ["high"], false), displayName: "GPT checker" },
        { ...model("corp/third", ["high"], false), displayName: "Gemini helper" },
      ]);
    };
    const result = await resolveHireExecution(f.bb, role, {
      providerId: "pi", environmentId: null, projectId: "project",
      maker: { providerId: "corp-router-anthropic", model: "corp/dev", environmentId: null },
    });
    expect(result.model).not.toBe("corp/dev");
    expect(result).toMatchObject({ model: "corp/third", checkIndependence: "independent" });
    expect(result.notes.join(" ")).toContain("the configured class model corp/dev was replaced");
  });

  it("labels a fallback when only the maker family and opaque alternatives are available", async () => {
    const f = execution([model(anthropic), model("custom/dev", ["high"], false)]);
    const result = await f.resolve("pi", anthropic);
    expect(result).toMatchObject({ model: anthropic, checkIndependence: "same-family" });
    expect(result.notes.join(" ")).toContain(fallback);
  });
});

describe("Warden target briefing", () => {
  it("pins a Warden to a recorded Keeper subject and credits verification without crediting a maker", async () => {
    const f = setup();
    const q = await seedQuest(f.k, "lead", "Validate a release", "Validate");
    const base = planInput(q.id);
    const subject = "Validate the release branch";
    f.bb.sdk.threads.getPluginMetadata = async () => ({});
    const journal = createJournalStore(f.bb, f.k.store.db, {
      invalidate: () => {},
      roleOf: id => f.runtime.journalRole(id),
    });
    Object.assign(f.port, journal);
    const plan = await f.runtime.plan("lead", { ...base, reversible: false, waypoints: [{ ...base.waypoints[0]!, title: subject, owner: "lead", check: "warden" }], party: [{ classId: "warden", characterId: null, model: null, purpose: "Validate", waypointIds: ["w1"] }] });
    expect(plan.waypoints[0]?.owner).toBe("this-keeper");
    const entry = journal.linkedEntries(q.id)[0]!;
    expect(entry).toMatchObject({ threadId: "lead", owner: "lead", description: subject, link: { boardQuestId: q.id, waypointId: "w1" } });
    const input = { classId: "warden", boardQuestId: q.id, waypointId: "w1", title: "Check release", brief };
    await expect(f.runtime.hire("lead", "project", input)).rejects.toThrow(/greenlight/);
    f.k.answerAsk(f.k.store.openAsks("lead", q.id).find(ask => ask.kind === "greenlight")!.id, "approve", null, "page", "user");

    await expect(f.runtime.hire("lead", "project", input)).rejects.toThrow(/record.*subject/i);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    const record = await journal.runTool("lead", { action: "done", id: entry.id, evidence: [{ kind: "query", ref: "refs/heads/release", detail: "Release subject", exitCode: null }] });
    expect(record).toMatchObject({ isError: false });

    const member = await f.runtime.hire("lead", "project", input);
    expect(f.k.store.runtime(member.threadId).reviewTarget).toMatchObject({ makerThreadId: "lead", waypointId: "w1", entryIds: [entry.id] });
    expect(f.k.checkerWaypoints(member.threadId)).toEqual(["w1"]);
    const spawn = f.harness.inspection.sdk.callsTo("threads.spawn")[0]!.args[0] as { input: { text: string }[] };
    expect(spawn.input[0]!.text).toContain("subject recorded by the Keeper");

    const target = { threadId: "lead", id: entry.id };
    const evidence = [{ kind: "command" as const, ref: "git rev-parse refs/heads/release", detail: "Release ref resolves", exitCode: 0 }];
    expect(await journal.runTool("lead", { ...target, action: "verify", evidence })).toMatchObject({ isError: true });
    expect(await journal.runTool(member.threadId, { ...target, action: "done", evidence })).toMatchObject({ isError: true });
    expect(await journal.runTool(member.threadId, { ...target, action: "verify" })).toMatchObject({ isError: true });
    expect(await journal.runTool(member.threadId, { ...target, action: "verify", evidence })).toMatchObject({ isError: false });
    expect(f.k.summary(q.id).waypoints[0]).toMatchObject({ state: "verified", madeBy: [], checkedBy: [member.threadId] });
  });
  it.each(["smith", "ranger"])("compares the checked %s, not the Keeper, and includes the exact maker journal references", async classId => {
    const f = await review(classId);
    f.bb.sdk.threads.defaultExecutionOptions = vi.fn<typeof f.bb.sdk.threads.defaultExecutionOptions>(async ({ threadId }) => ({ model: threadId === "maker" ? anthropic : openai, permissionMode: "full", reasoningLevel: "high", serviceTier: "standard", source: "client/turn/start" }));
    const member = await f.runtime.hire("lead", "project", f.input);
    const spawn = f.harness.inspection.sdk.callsTo("threads.spawn")[0]!.args[0] as { model: string; input: { text: string }[] };
    expect(spawn.model).toBe(openai);
    expect(f.bb.sdk.threads.defaultExecutionOptions).toHaveBeenCalledWith({ threadId: "maker" });
    expect(member).toMatchObject({ checkIndependence: "independent" });
    const text = spawn.input[0]!.text;
    expect(text).toContain('"makerThreadId": "maker"');
    expect(text).toContain('"waypointId": "w1"');
    expect(text).toContain('"a1"');
    expect(text).toContain('"a2"');
    expect(text).not.toContain('"b1"');
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("checks another maker and its replacement from one approved slot, but refuses the Warden's own family", async () => {
    const f = setup();
    f.bb.sdk.threads.getPluginMetadata = async () => ({});
    const journal = createJournalStore(f.bb, f.k.store.db, {
      invalidate: () => {},
      roleOf: id => f.runtime.journalRole(id),
    });
    Object.assign(f.port, journal);
    const q = await seedQuest(f.k, "lead", "Build two parts", "Build");
    const bind = (id: string, waypointId: string, family: string) => {
      f.k.bind(id, "smith", "bram", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId, errand: false, title: "Build", brief });
      f.k.store.patch(id, { classExecutionChoice: { providerId: "pi", model: family, recordedAt: f.time(), reasoningLevel: null, modelSource: null, reasoningSource: null } });
    };
    bind("maker", "w1", anthropic);
    bind("other", "w2", openai);
    const base = planInput(q.id);
    const one = { ...base.waypoints[0]!, owner: "maker", check: "warden" as const };
    await f.runtime.plan("lead", { ...base, waypoints: [one, { ...one, id: "w2", owner: "other" }], party: [
      { classId: "warden", characterId: null, model: null, purpose: "Check both", waypointIds: ["w1", "w2"] },
    ] });
    f.k.answerAsk(f.k.store.openAsks("lead", q.id)[0]!.id, "approve", null, "page", "user");
    f.bb.sdk.threads.defaultExecutionOptions = async () => ({ model: anthropic, permissionMode: "full", reasoningLevel: "high", serviceTier: "standard", source: "client/turn/start" });
    const input = { classId: "warden", boardQuestId: q.id, waypointId: "w1", title: "Check", brief };
    f.bb.sdk.providers.models = async () => catalog([model(anthropic)]);
    await expect(f.runtime.hire("lead", "project", input)).rejects.toThrow(/same.family/i);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);

    f.bb.sdk.providers.models = async () => catalog([model(anthropic), model(openai, ["high"], false)]);
    const checker = await f.runtime.hire("lead", "project", input);
    expect(checker.checkIndependence).toBe("independent");
    const evidence = [{ kind: "command" as const, ref: "npm test", detail: "All tests pass", exitCode: 0 }];
    const verify = async (makerId: string) => {
      const entry = journal.get(makerId).entries[0]!;
      expect(await journal.runTool(makerId, { action: "done", id: entry.id, evidence })).toMatchObject({ isError: false });
      return journal.runTool(checker.threadId, { action: "verify", id: entry.id, threadId: makerId, evidence });
    };
    expect(await verify("maker")).toMatchObject({ isError: false });
    expect(await verify("other")).toMatchObject({ isError: true, text: expect.stringMatching(/independent|same.family/i) });
    f.bb.sdk.threads.stop = async () => ({ ok: true });
    expect(await f.runtime.release("lead", "other", "Replace the maker")).toBe(true);
    bind("replacement", "w2", anthropic);
    await journal.prepare("replacement");
    journal.linkWaypoint("replacement", { boardQuestId: q.id, waypointId: "w2" }, one.title, "replacement", { kind: "tavern" });
    expect(await verify("replacement")).toMatchObject({ isError: false });
    expect(f.k.quest(q.id).planVersion).toBe(1);
    expect(f.k.summary(q.id).waypoints.map(w => w.state)).toEqual(["verified", "verified"]);
  });

  it.each(["verify", "reject"] as const)("lets a Warden with unknown independence file a labelled %s verdict", async action => {
    const f = setup();
    f.bb.sdk.threads.getPluginMetadata = async () => ({});
    const journal = createJournalStore(f.bb, f.k.store.db, {
      invalidate: () => {},
      roleOf: id => f.runtime.journalRole(id),
      reviewed: review => f.runtime.serviceRecords.reviewed(review),
    });
    Object.assign(f.port, journal);
    const q = await seedQuest(f.k, "lead", "Build", "Build");
    f.k.bind("maker", "smith", "bram", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", errand: false, title: "Build", brief });
    f.k.store.patch("maker", { classExecutionChoice: { providerId: "pi", model: "custom/dev", recordedAt: f.time(), reasoningLevel: null, modelSource: null, reasoningSource: null } });
    const base = planInput(q.id);
    await f.runtime.plan("lead", { ...base, waypoints: [{ ...base.waypoints[0]!, owner: "maker", check: "warden" }], party: [
      { classId: "warden", characterId: null, model: null, purpose: "Check", waypointIds: ["w1"] },
    ] });
    f.k.answerAsk(f.k.store.openAsks("lead", q.id)[0]!.id, "approve", null, "page", "user");
    f.bb.sdk.threads.defaultExecutionOptions = async ({ threadId }) => ({ model: threadId === "maker" ? "custom/dev" : anthropic, permissionMode: "full", reasoningLevel: "high", serviceTier: "standard", source: "client/turn/start" });
    f.bb.sdk.providers.models = async () => catalog([model(anthropic)]);
    const checker = await f.runtime.hire("lead", "project", { classId: "warden", boardQuestId: q.id, waypointId: "w1", title: "Check", brief });
    expect(checker.checkIndependence).toBe("not-established");
    const evidence = [{ kind: "command" as const, ref: "npm test", detail: "All tests pass", exitCode: 0 }];
    const entry = journal.get("maker").entries[0]!;
    expect(await journal.runTool("maker", { action: "done", id: entry.id, evidence })).toMatchObject({ isError: false });
    const verdict = await journal.runTool(checker.threadId, { action, id: entry.id, threadId: "maker", evidence,
      ...(action === "reject" ? { reason: "The evidence does not show the required behavior" } : {}) });
    expect(verdict).toMatchObject({ isError: false, text: expect.stringContaining("check independence not established") });
    expect(f.k.store.all("serviceVerdicts")).toMatchObject([{ verdict: action === "verify" ? "verified" : "rejected", independence: "not-established" }]);
  });

  it("refuses a waypoint whose maker entry is unknown before reserving or spawning", async () => {
    const f = await review();
    const get = f.port.get;
    f.port.get = threadId => ({ ...get(threadId), entries: [] });
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(/maker.*journal entr/i);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(f.k.store.all("hires")).toHaveLength(0);
  });

  it("awaits preparation before reading the maker's entry ids", async () => {
    const f = await review();
    let ready = false;
    const get = f.port.get;
    f.port.prepare = vi.fn(async id => { if (id === "maker") ready = true; });
    f.port.get = id => {
      if (id === "maker") expect(ready).toBe(true);
      return get(id);
    };
    await f.runtime.hire("lead", "project", f.input);
    expect(f.port.prepare).toHaveBeenCalledWith("maker");
  });

  it("puts the not-established label in the hire result, first brief, verdict, Ledger and Insights", async () => {
    const fallback = "check independence not established";
    const f = await review();
    f.bb.sdk.threads.defaultExecutionOptions = async () => ({ model: "custom/dev", permissionMode: "full", reasoningLevel: "high", serviceTier: "standard", source: "client/turn/start" });
    f.bb.sdk.threads.get = async ({ threadId }) => makeThreadResponse({ id: threadId, providerId: "pi" });
    const settings = new SettingsStore(f.k.store.db, f.time);
    const insights = new InsightsReader(f.k.store.db, settings, f.time);
    f.runtime.enableSettings(settings, insights);
    registerTools(f.bb, f.runtime);
    registerRpc(f.bb, f.runtime);
    const text = await f.harness.behavior.invokeAgentTool("tavern_hire", f.input, { threadId: "lead" });
    expect(text).toContain(fallback);
    const member = f.k.store.query("members", "boardQuestId", f.q.id).find(member => member.classId === "warden")!;
    expect(member.checkIndependence).toBe("not-established");
    const spawn = f.harness.inspection.sdk.callsTo("threads.spawn")[0]!.args[0] as { input: { text: string }[] };
    expect(spawn.input[0]!.text).toContain(fallback);
    const report = f.k.report(member.threadId, { status: "done", outcome: "Checked the evidence", evidence: [], artifacts: [], confidence: null, voice: null });
    expect(report.outcome).toContain(fallback);
    const ledger = await f.harness.invokeRpc("ledger", { threadId: "lead" });
    expect(JSON.stringify(ledger)).toContain('"checkIndependence":"not-established"');
    expect(JSON.stringify(ledger)).toContain(fallback);
    const view = await insights.view("7d");
    expect(view.ideas).toContainEqual(expect.objectContaining({ id: "warden-family", action: { kind: "open-setting", key: "classes.warden.model" }, detail: expect.stringContaining(fallback) }));
  });
});
