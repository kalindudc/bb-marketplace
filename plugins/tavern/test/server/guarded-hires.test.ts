// @vitest-environment node
import { seedQuest } from "./support";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { catalog, model, provider } from "./provider-fixture";
import { makeThreadResponse } from "./host";
import { planInput } from "./support";
import { registerTools } from "../../src/server/tools";
import { registerRpc } from "../../src/server/rpc";
import { registerCli } from "../../src/server/cli";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights";
import { placementRuleSchema } from "../../src/shared/placement-settings";

const wanted = "openai/gpt-6.1-sol";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(classId = "smith", piOffersModel = true) {
  const f = setup();
  const root = mkdtempSync(join(tmpdir(), "tavern-guarded-hire-"));
  roots.push(root);
  const worktree = join(root, "work"), storage = join(root, "storage");
  mkdirSync(worktree); mkdirSync(storage);
  f.bb.sdk.environments.get = async () => ({ id: "env", hostId: "host", path: worktree, isGitRepo: true, isWorktree: true, environmentProviderId: "git-worktree", branchName: "main" }) as never;
  f.bb.sdk.threads.storageLocation = async () => ({ hostId: "host", storageRootPath: storage });
  f.bb.sdk.threads.spawn = vi.fn(async () => makeThreadResponse({ id: "child", environmentId: "env", parentThreadId: "lead", providerId: "codex" }));
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  f.bb.sdk.providers.list = async () => [provider("codex"), provider("pi")];
  f.bb.sdk.providers.models = async args => {
    if (!args?.providerId) throw new Error("Fixture requires a provider id");
    return catalog([model(args.providerId === "pi" && !piOffersModel ? "anthropic/claude-sonnet-5-5" : wanted)], [provider(args.providerId)]);
  };
  const snapshot = f.runtime.snapshot();
  vi.spyOn(f.runtime, "snapshot").mockReturnValue({ ...snapshot, classes: snapshot.classes.map(role => role.id === classId ? { ...role, provider: "codex", model: wanted } : role) });
  f.runtime.enableScopes({ dataDir: root, installGuard: false, policyOptions: { home: root } });
  let questId: string | null = null;
  if (classId === "smith") {
    const q = await seedQuest(f.k,"lead", "Build", "Build");
    questId = q.id;
    f.k.plan("lead", { ...planInput(q.id), party: [{ classId, characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] }] });
    f.k.answerAsk(f.k.asks("lead").find(ask => ask.kind === "greenlight")!.id, "approve", null, "page", "user");
  }
  const input = {
    classId, boardQuestId: questId, waypointId: questId ? "w1" : null,
    errand: !questId, title: "Bounded work",
    brief: { outcome: "Check the result", mode: "make-it-work" as const, outOfScope: "External writes", doneWhen: "Checks pass", context: [], questions: classId === "ranger" ? ["What exists?"] : [], timeboxMinutes: classId === "ranger" ? 5 : null },
  };
  registerTools(f.bb, f.runtime);
  registerRpc(f.bb, f.runtime);
  registerCli(f.bb, f.runtime);
  return {
    ...f, root, input,
    hire: (extra: { requestDetectionOnly?: boolean; detectionOnlyAskId?: string } = {}) => f.runtime.hire("lead", "project", { ...input, ...extra }),
    tool: (extra: { requestDetectionOnly?: boolean; detectionOnlyAskId?: string } = {}) => f.harness.behavior.invokeAgentTool("tavern_hire", { ...input, ...extra }, { threadId: "lead" }),
    spawns: () => f.harness.inspection.sdk.callsTo("threads.spawn"),
  };
}
async function detectionAsk(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.tool({ requestDetectionOnly: true });
  expect(result).toContain("Not hired");
  const ask = f.k.store.openAsks("lead").find(ask => ask.kind === "scope")!;
  expect(ask).toBeDefined();
  return ask;
}

describe("scoped provider admission through the strict host", () => {
  it("hires an open-scope Wanderer on its configured provider without a detection-only ask", async () => {
    const f = await fixture("wanderer", false);
    await f.hire();
    expect(f.spawns()[0]?.args[0]).toMatchObject({ providerId: "codex", model: wanted });
    expect(f.k.store.openAsks("lead").filter(ask => ask.kind === "scope")).toEqual([]);
    expect(f.k.member("child")?.guardPosture).toBeUndefined();
  });
  it.each([true, false])("a current rule preserves ordinary guarded admission (Pi model available: %s)", async piOffersModel => {
    const f = await fixture("ranger", piOffersModel);
    const settings = new SettingsStore(f.k.store.db, f.time);
    f.runtime.enableSettings(settings, new InsightsReader(f.k.store.db, settings, f.time));
    settings.update({ revision: 0, patch: { machines: { rules: [placementRuleSchema.parse({
      id: "current", label: "Keep current guard policy", enabled: true, match: {}, target: { kind: "current" },
    })] } }, why: "Legacy guard remains required" });
    if (piOffersModel) {
      await f.hire();
      expect(f.spawns()[0]?.args[0]).toMatchObject({ providerId: "pi", model: wanted });
      expect(f.k.member("child")?.guardPosture).toMatchObject({ mode: "pre-exec" });
    } else {
      await expect(f.hire()).rejects.toThrow(/only pi/i);
      expect(f.spawns()).toHaveLength(0);
    }
    expect(f.k.store.openAsks("lead").filter(ask => ask.kind === "scope")).toEqual([]);
    expect(f.k.store.db.prepare("SELECT count(*) AS n FROM tavern_placements").get()).toEqual({ n: 0 });
  });
  it.each(["smith", "ranger"])("prefers Pi for a scoped %s even when its class selects Codex", async classId => {
    const f = await fixture(classId);
    const text = await f.tool();
    expect(f.spawns()[0]?.args[0]).toMatchObject({ providerId: "pi", model: wanted });
    expect(text).toContain("pre-exec guard");
    expect(text).toContain("codex -> pi");
    expect(text).not.toContain("detection only (not prevented)");
    expect(f.k.member("child")?.guardPosture).toMatchObject({ providerId: "pi", mode: "pre-exec" });
  });
  it("keeps an advertised model alias and a provider substitution visible when Pi offers its canonical model", async () => {
    const f = await fixture();
    const snapshot = f.runtime.snapshot();
    vi.mocked(f.runtime.snapshot).mockReturnValue({ ...snapshot, classes: snapshot.classes.map(role => role.id === "smith" ? { ...role, model: "codex-alias" } : role) });
    f.bb.sdk.providers.models = async args => {
      if (!args?.providerId) throw new Error("Fixture requires a provider id");
      return catalog([{ ...model(wanted), id: args.providerId === "codex" ? "codex-alias" : wanted }], [provider(args.providerId)]);
    };
    const text = await f.tool();
    expect(f.spawns()[0]?.args[0]).toMatchObject({ providerId: "pi", model: wanted });
    expect(text).toMatch(/^[^\n]*model codex-alias -> openai\/gpt-6.1-sol/);
    expect(text).toContain("Tell the user in this turn");
  });
  it.each(["smith", "ranger"])("refuses an unguarded %s by default without spawning or retaining a reservation", async classId => {
    const f = await fixture(classId, false);
    await expect(f.hire()).rejects.toThrow(new RegExp(`${wanted}.*only pi`, "i"));
    expect(f.spawns()).toHaveLength(0);
    expect(f.k.store.all("hires")).toEqual([]);
    expect(f.k.store.openAsks("lead").filter(ask => ask.kind === "scope")).toHaveLength(0);
  });
  it("refuses an unknown provider default rather than requesting an approval for an unnamed model", async () => {
    const f = await fixture();
    const snapshot = f.runtime.snapshot();
    vi.mocked(f.runtime.snapshot).mockReturnValue({ ...snapshot, classes: snapshot.classes.map(role => role.id === "smith" ? { ...role, model: null, reasoning: null } : role) });
    f.bb.sdk.providers.models = async args => {
      if (!args?.providerId) throw new Error("Fixture requires a provider id");
      return catalog([], [provider(args.providerId)]);
    };
    await expect(f.hire({ requestDetectionOnly: true })).rejects.toThrow(/provider default.*classes[.]smith[.]model/);
    expect(f.spawns()).toHaveLength(0);
    expect(f.k.store.openAsks("lead").filter(ask => ask.kind === "scope")).toHaveLength(0);
  });

  it("rejects a command misfiled as a tool grant before either spawning or asking", async () => {
    const f = await fixture();
    await expect(f.runtime.hire("lead", "project", { ...f.input, scope: { tools: { allow: ["npm test"] } } })).rejects.toThrow(/npm test is a shell command/);
    expect(f.spawns()).toHaveLength(0);
    expect(f.k.store.openAsks("lead").filter(ask => ask.kind === "scope")).toHaveLength(0);
  });

  it("opens an explicit consequential scope ask without hiring, and deduplicates the request", async () => {
    const f = await fixture("ranger", false);
    const ask = await detectionAsk(f);
    expect(ask).toMatchObject({ kind: "scope", proceedAt: null });
    expect(ask.question).toContain("codex with detection only");
    expect(ask.question).toContain("can't prevent it");
    expect(ask.options.find(option => option.id === "approve")?.detail).toContain(wanted);
    expect(f.spawns()).toHaveLength(0);
    expect(f.k.store.all("hires")).toEqual([]);
    await f.tool({ requestDetectionOnly: true });
    expect(f.k.store.openAsks("lead").filter(ask => ask.kind === "scope")).toHaveLength(1);
  });
  it("does not accept a pending or denied exception", async () => {
    const f = await fixture("ranger", false);
    const ask = await detectionAsk(f);
    await expect(f.hire({ detectionOnlyAskId: ask.id })).rejects.toThrow(/user.*approv/i);
    await f.runtime.answerAsk(ask.id, "deny", null, "page");
    await expect(f.hire({ detectionOnlyAskId: ask.id })).rejects.toThrow(/user.*approv/i);
    expect(f.spawns()).toHaveLength(0);
  });
  it("does not treat a generic scope answer as a provider exception", async () => {
    const f = await fixture("ranger", false);
    const ask = f.k.ask("lead", { effect: {type:"decision"}, kind: "scope", question: "Allow a path?", why: "A different request", options: [{ id: "approve", label: "Yes", detail: "A path", recommended: false }], meanwhile: "Scout", holds: [] });
    await f.runtime.answerAsk(ask.id, "approve", null, "page");
    await expect(f.hire({ detectionOnlyAskId: ask.id })).rejects.toThrow(/exact hire|does not match/i);
    expect(f.spawns()).toHaveLength(0);
  });
  it("binds the user's exception to the exact model, class, scope and brief", async () => {
    const f = await fixture("ranger", false);
    const ask = await detectionAsk(f);
    await f.runtime.answerAsk(ask.id, "approve", null, "page");
    await expect(f.runtime.hire("lead", "project", { ...f.input, title: "Different task", detectionOnlyAskId: ask.id })).rejects.toThrow(/exact hire|does not match/i);
    expect(f.spawns()).toHaveLength(0);
  });
  it("labels a user-approved exception in the result, first brief, Ledger and scope CLI", async () => {
    const f = await fixture("ranger", false);
    const ask = await detectionAsk(f);
    await f.runtime.answerAsk(ask.id, "approve", null, "page");
    const text = await f.tool({ detectionOnlyAskId: ask.id });
    expect(text).toContain("detection only (not prevented)");
    expect(text).not.toContain("hooks installed");
    const spawn = f.spawns()[0]?.args[0] as { providerId: string; input: { text: string }[] };
    expect(spawn.providerId).toBe("codex");
    expect(spawn.input[0]!.text).toContain("detection only (not prevented)");
    const ledger = await f.harness.invokeRpc("ledger", { threadId: "lead" });
    expect(JSON.stringify(ledger)).toContain("detection only (not prevented)");
    expect(f.runtime.scopes!.view("child")?.guardPosture).toMatchObject({ mode: "detection-only", approvalAskId: ask.id });
    const cli = f.harness.inspection.registrations.cli[0]!;
    expect((await cli.run(["scope", "child"], {})).stdout).toContain("detection only (not prevented)");
  });
  it("requires fresh approval if the resolved effective scope changes", async () => {
    const f = await fixture("ranger", false);
    const ask = await detectionAsk(f);
    await f.runtime.answerAsk(ask.id, "approve", null, "page");
    const resolve = f.runtime.scopes!.api.resolve;
    vi.spyOn(f.runtime.scopes!.api, "resolve").mockImplementation((...args) => {
      const result = resolve(...args);
      return { ...result, scope: { ...result.scope, tools: { ...result.scope.tools, deny: [...result.scope.tools.deny, "test_scope_change"] } } };
    });
    await expect(f.hire({ detectionOnlyAskId: ask.id })).rejects.toThrow(/exact hire|does not match/i);
    expect(f.spawns()).toHaveLength(0);
  });

  it("does not reuse one approval for a second hire", async () => {
    const f = await fixture("ranger", false);
    const ask = await detectionAsk(f);
    await f.runtime.answerAsk(ask.id, "approve", null, "page");
    await f.hire({ detectionOnlyAskId: ask.id });
    await expect(f.hire({ detectionOnlyAskId: ask.id })).rejects.toThrow(/exact hire|does not match|already used/i);
    expect(f.spawns()).toHaveLength(1);
  });
  it("returns an approval after a definite spawn refusal", async () => {
    const f = await fixture("ranger", false);
    const ask = await detectionAsk(f);
    await f.runtime.answerAsk(ask.id, "approve", null, "page");
    vi.mocked(f.bb.sdk.threads.spawn).mockRejectedValueOnce(Object.assign(new Error("HTTP 400: unavailable"), { status: 400 }));
    await expect(f.hire({ detectionOnlyAskId: ask.id })).rejects.toThrow("HTTP 400");
    await expect(f.hire({ detectionOnlyAskId: ask.id })).resolves.toMatchObject({ guardPosture: { mode: "detection-only" } });
    expect(f.spawns()).toHaveLength(2);
  });
});
