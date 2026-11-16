// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { resolveHireExecution } from "../../src/server/execution";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights";
import { registerRpc } from "../../src/server/rpc";
import { registerTools } from "../../src/server/tools";
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
  f.k.answerAsk(f.k.store.openAsks("lead").find(ask => ask.kind === "greenlight")!.id, "approve", null, "page");
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
