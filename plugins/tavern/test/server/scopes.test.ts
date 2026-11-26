// @vitest-environment node
import { patchThreadFixture, runtimeFixture } from "./member-fixture";
import { seedQuest } from "./support";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";
import { planInput } from "./support";
import { dispatch049 } from "./dispatch-fixture";
import { registerTools } from "../../src/server/tools";
import { registerRpc } from "../../src/server/rpc";
import { registerCli } from "../../src/server/cli";
import { provider } from "./provider-fixture";
import { scopeForClass } from "../../src/scope/presets";
import { BackendScopes } from "../../src/server/scopes";
import { evaluate } from "../../src/scope/engine";
import { armScope } from "../../src/scope/store";
import { holdCommunication, readCommunicationHolds } from "../../src/scope/communication-holds";
import { claimShellGrant } from "../../src/scope/shell-grants";
import { AttentionSnapshot } from "../../src/server/attention";
import { readStatus, statusInput } from "../../src/server/status";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const brief = {
  outcome: "Build",
  mode: "make-it-work" as const,
  outOfScope: "Production",
  doneWhen: "Pass",
  context: [],
  questions: [],
  timeboxMinutes: null,
};
async function fixture(installGuard = false) {
  const root = mkdtempSync(join(tmpdir(), "tavern-backend-scopes-"));
  roots.push(root);
  const work = join(root, "work"),
    storage = join(root, "thread-storage");
  mkdirSync(work);
  mkdirSync(storage);
  const f = setup({
    environments: {
      get: async () => ({
        hostId: "host",
        path: work,
        isGitRepo: true,
        isWorktree: true,
        environmentProviderId: "git-worktree",
      }),
    },
    projects: {
      get: async () => ({
        sources: [{ hostId: "host", path: work, isDefault: true }],
        gitRemoteUrl: "git@github.com:kalindudc/demo.git",
      }),
    },
  });
  f.bb.sdk.threads.get = async ({ threadId }) =>
    makeThreadResponse({ id: threadId, environmentId: "env" });
  f.bb.sdk.threads.storageLocation = async () => ({ hostId: "host", storageRootPath: storage });
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  f.bb.sdk.threads.spawn = vi.fn(async () =>
    makeThreadResponse({ id: "child", environmentId: "env", parentThreadId: "lead" }),
  );
  if (installGuard) mkdirSync(join(root, ".pi/agent"), { recursive: true });
  f.runtime.enableScopes({
    dataDir: root,
    installGuard,
    policyOptions: { home: root },
    guard: { agentDir: join(root, ".pi/agent") },
  });
  const q = await seedQuest(f.k,"lead", "A", "A");
  f.k.plan("lead", {
    ...planInput(q.id),
    party: [
      { classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] },
    ],
  });
  f.k.answerAsk(f.k.asks("lead")[0]!.id, "approve", null, "page", "user");
  return {
    ...f,
    root,
    work,
    storage,
    q,
    input: { classId: "smith", boardQuestId: q.id, waypointId: "w1", title: "Build", brief },
  };
}

describe("backend scope integration", () => {
  it("binds only the local Keeper's storage subtree for the member's quest", async () => {
    const f = await fixture();
    const keeperStorage = join(f.root, "keeper-storage");
    mkdirSync(keeperStorage);
    let keeperHost = "host";
    f.bb.sdk.threads.storageLocation = async ({ threadId }) => threadId === "lead"
      ? { hostId: keeperHost, storageRootPath: keeperStorage }
      : { hostId: "host", storageRootPath: f.storage };
    await f.runtime.hire("lead", "project", f.input);
    const scopes = f.runtime.scopes!;
    const expected = join(realpathSync(keeperStorage), "scratch", f.q.id);
    expect(scopes.view("child")?.scope?.writes.allow).toContain(expected);
    expect(scopes.view("child")?.scope?.writes.allow).not.toContain(realpathSync(keeperStorage));
    keeperHost = "another-host";
    expect((await scopes.paths("child")).keeperScratch).toBeUndefined();
  });
  it("distinguishes a freshly hired member from a session running an older guard", async () => {
    const f = await fixture(true);
    await f.runtime.hire("lead", "project", f.input);
    const scopes = f.runtime.scopes!;
    expect(scopes.view("child")?.clusterGuard).toBe("ready");
    const scope = scopes.view("child")!.scope!;
    writeFileSync(join(f.root, "scopes/child.armed"), JSON.stringify({ threadId: "child", issuedAt: scope.issuedAt, pid: process.pid, at: Date.now() }));
    expect(scopes.api.clusterGuardArmed("child")).toBe(false);
    expect(scopes.api.sendGuardArmed("child")).toBe(false);
    expect(scopes.view("child")?.clusterGuard).not.toBe("armed");
    expect(scopes.view("child")?.sendGuard).not.toBe("armed");
    armScope(join(f.root, "scopes/child.json"), scope);
    expect(scopes.view("child")?.sendGuard).toBe("armed");
  });
  it("refreshes a running Off scope and records its held message once", async () => {
    const f = await fixture();
    const scopes = f.runtime.scopes!;
    const original = f.runtime.config();
    await scopes.api.writeScope("lead", scopeForClass("keeper"));
    const rule = { pattern: "*_post", act: "send" as const, targetKey: "to" };
    const config = vi.spyOn(f.runtime, "config").mockReturnValue({ ...original, scopes: { mode: "off", sendTools: [rule] } });
    f.runtime.settingsChanged();
    const local = scopes.api.localScopeRecord("lead")!;
    expect(local.scope).toMatchObject({ mode: "off", sendTools: [rule] });
    const call = { kind: "tool" as const, toolName: "fixture_post", input: { to: "fixture-room", text: "First\nLast" }, cwd: f.work };
    const preview = { act: "send" as const, tool: call.toolName, target: "fixture-room", body: "First\nLast" };
    holdCommunication(local.file, local.scope, call, preview);
    holdCommunication(local.file, local.scope, call, preview);
    await scopes.drainCommunication("lead");
    expect(f.k.store.openAsks("lead").filter(ask => ask.kind === "sends-as-you")).toEqual([
      expect.objectContaining({ effect: { type: "communication-hold", keeperReview: true, hold: expect.objectContaining(preview) }, lane: "keeper" }),
    ]);
    expect(readCommunicationHolds(local.file)).toEqual([]);
    expect(new AttentionSnapshot(f.k.store).asks).toEqual([]);
    const hold = f.k.store.openAsks("lead").find(ask => ask.kind === "sends-as-you")!;
    expect(() => f.k.reviewHeldCommunication("child", hold.id)).toThrow();
    f.k.reviewHeldCommunication("lead", hold.id);
    expect(new AttentionSnapshot(f.k.store).asks.map(ask => ask.id)).toEqual([hold.id]);
    config.mockReturnValue({ ...original, scopes: { mode: "off", sendTools: [] } });
    f.runtime.settingsChanged();
    expect(scopes.api.localScopeRecord("lead")!.scope).not.toHaveProperty("sendTools");
  });
  it("wakes the member for an exact approved draft without a two-minute deadline", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    const rule = { pattern: "fixture_draft", act: "draft" as const, targetKey: "to" };
    const config = f.runtime.config();
    const settings = vi.spyOn(f.runtime, "config").mockReturnValue({ ...config, scopes: { ...config.scopes, sendTools: [rule] } });
    f.runtime.settingsChanged();
    const scopes = f.runtime.scopes!, held = scopes.api.localScopeRecord("child")!;
    holdCommunication(held.file, held.scope, { kind: "tool", toolName: "fixture_draft", input: { to: "room", text: "fixture" }, cwd: f.work },
      { act: "draft", tool: "fixture_draft", target: "room", body: "fixture" });
    await scopes.drainCommunication("child");
    const ask = f.k.store.openAsks("lead", f.q.id).find(item => item.kind === "drafts-as-you")!;
    const send = vi.spyOn(f.bb.sdk.threads, "send");
    registerRpc(f.bb, f.runtime);
    expect(new AttentionSnapshot(f.k.store).asks).toEqual([]);
    const answer = () => f.harness.invokeRpc("answerAsk", { askId: ask.id, optionId: "approve", note: null, via: "page" });
    await expect(answer()).rejects.toThrow(/Keeper must review/);
    f.k.reviewHeldCommunication("lead", ask.id);
    await answer();
    await vi.waitFor(() => expect(send.mock.calls.some(([input]) => input.threadId === "child" && JSON.stringify(input).includes("exact call"))).toBe(true));
    f.advance(360_000);
    scopes.refreshCommunication("child");
    expect(scopes.api.localScopeRecord("child")!.scope.communicationAuthority?.receipts).toEqual([expect.objectContaining({ askId: ask.id })]);
    settings.mockReturnValue({ ...config, scopes: { ...config.scopes, sendTools: [] } });
    f.runtime.settingsChanged();
    settings.mockReturnValue({ ...config, scopes: { ...config.scopes, sendTools: [rule] } });
    f.runtime.settingsChanged();
    expect(scopes.api.localScopeRecord("child")!.scope.communicationAuthority).toBeUndefined();
    expect(f.k.store.get("asks", ask.id)?.draftApprovalInvalidated).toBe(true);
    const local = scopes.api.localScopeRecord("child")!;
    holdCommunication(local.file, local.scope, { kind: "tool", toolName: "fixture_draft", input: { to: "room", text: "new" }, cwd: f.work },
      { act: "draft", tool: "fixture_draft", target: "room", body: "new" });
    await scopes.drainCommunication("child");
    const next = f.k.store.openAsks("lead", f.q.id).find(item => item.kind === "drafts-as-you")!;
    f.k.reviewHeldCommunication("lead", next.id);
    await f.harness.invokeRpc("answerAsk", { askId: next.id, optionId: "approve", note: null, via: "page" });
    expect(scopes.api.localScopeRecord("child")!.scope.communicationAuthority?.receipts).toEqual([expect.objectContaining({ askId: next.id })]);
    await f.runtime.closeAfterRevokingClusterGrants(() => {});
    expect(scopes.api.localScopeRecord("child")!.scope.communicationAuthority).toBeUndefined();
    expect(f.k.store.get("asks", next.id)?.draftApprovalInvalidated).toBe(true);
  });
  it("keeps historic send delegations readable but does not let the Keeper use them", async () => {
    const f = await fixture();
    const config = f.runtime.config();
    const settings = { ...config, keepers: { ...config.keepers, alwaysAsk: config.keepers.alwaysAsk.filter(kind => kind !== "sends-as-you") } };
    vi.spyOn(f.runtime, "config").mockReturnValue(settings);
    vi.spyOn(f.k, "settings").mockReturnValue(settings);
    const grant = { id: "historic", kind: "sends-as-you" as const, surface: "page", at: f.k.now(), revokedAt: null, endedAt: null };
    f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), delegations: [grant] });
    expect(f.k.quest(f.q.id).delegations).toEqual([grant]);
    const scopes = f.runtime.scopes!;
    await scopes.api.writeScope("lead", scopeForClass("keeper"));
    const url = "https://github.com/example/other/pull/10";
    expect(evaluate(scopes.view("lead")!.scope!, { kind: "bash", toolName: "bash", cwd: f.work, input: { command: `gh pr comment ${url} --body hi` } }))
      .toMatchObject({ allow: false, ruleId: "send-guard" });
    const ask = f.k.ask("lead", { boardQuestId: f.q.id, kind: "sends-as-you", question: "Post the comment?", why: "The reviewer asked", draft: { to: url, body: "hi" },
      effect: { type: "decision" }, holds: [], meanwhile: "", options: [{ id: "approve", label: "Post", detail: "Post the comment", recommended: true }] });
    expect(ask.lane).toBe("user");
    expect(ask.options.map(option => option.id)).toEqual(["acknowledge", "deny"]);
    expect(() => f.k.decide("lead", { boardQuestId: f.q.id, askId: ask.id, optionId: "acknowledge", text: "Confirm", why: "Historic grant", reversible: true, source: "keeper" })).toThrow();
  });

  it("rebuilds a live scope on policy change and does not rewrite it for unchanged inputs", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    const scopes = f.runtime.scopes!, before = scopes.view("child")!.scope!;
    await scopes.override("lead", "child", { tools: { deny: ["fixture-local"] } }, "Keep the explicit member restriction.");
    const policyDir = join(f.work, ".agents/tavern");
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(join(policyDir, "scopes.yml"), "v: 1\nrules:\n  - classes:\n      smith:\n        defaults:\n          tools:\n            deny: [fixture-preview]\n            allow: [unauthorized]\n");
    await scopes.refreshLiveScopes();
    expect(scopes.view("child")!.problems).toEqual(expect.arrayContaining([expect.stringContaining("project policies may only narrow")]));
    expect(scopes.view("child")!.scope).toMatchObject({ issuedAt: before.issuedAt, tools: { deny: expect.arrayContaining(["fixture-preview", "fixture-local"]) } });
    const refreshed = () => f.k.store.events("lead").filter(e => e.type === "scope.refreshed" && e.data.memberThreadId === "child");
    expect(refreshed()).toHaveLength(1);
    expect(refreshed()[0]!.text).toContain("Saved tool rules changed");
    await scopes.refreshLiveScopes();
    expect(refreshed()).toHaveLength(1);
    expect(evaluate(scopes.view("child")!.scope!, { kind: "tool", toolName: "fixture-preview", cwd: f.work, input: {} }).allow).toBe(true);
    writeFileSync(join(policyDir, "scopes.yml"), "v: 1\nrules: []\n");
    await scopes.refreshLiveScopes();
    expect(scopes.view("child")!.scope!.tools.deny).not.toContain("fixture-preview");
    expect(scopes.view("child")!.scope!.tools.deny).toContain("fixture-local");
    expect(refreshed()).toHaveLength(2);
  });
  it("keeps the last good live scope when the project policy is malformed", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    const scopes = f.runtime.scopes!;
    const file = join(f.work, ".agents/tavern/scopes.yml");
    mkdirSync(join(f.work, ".agents/tavern"), { recursive: true });
    writeFileSync(file, "v: 1\nrules:\n  - classes:\n      smith:\n        defaults:\n          tools:\n            deny: [first-deny]\n");
    await scopes.refreshLiveScopes();
    const lastGood = scopes.view("child")!.scope;
    writeFileSync(file, "v: [bad");
    await scopes.refreshLiveScopes();
    expect(scopes.view("child")!.scope).toEqual(lastGood);
    expect(scopes.view("child")!.problems).toEqual(expect.arrayContaining([expect.stringContaining("Policy read failed")]));
  });
  it("names only the legacy environment change when nothing else changes", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    const scopes = f.runtime.scopes!, prior = scopes.api.scopeTemplate("child")!;
    await scopes.api.writeScope("child", { ...prior, env: { ...prior.env, poisonGh: true, blockGitPush: true } });
    await scopes.refreshLiveScopes(); await scopes.refreshLiveScopes();
    expect(f.k.store.events("lead").filter(e => e.type === "scope.refreshed" && e.data.memberThreadId === "child").map(e => e.text))
      .toEqual(["No longer set: the GitHub and push environment overrides."]);
  });
  it("pins the hire assignment and ignores later SDK checkout changes", async () => {
    const f = await fixture();
    const get = f.bb.sdk.environments.get;
    f.bb.sdk.environments.get = async args => ({ ...await get(args), branchName: "assigned-at-hire" });
    await f.runtime.hire("lead", "project", f.input);
    expect(f.runtime.scopes!.view("child")!.scope?.assignedBranch).toBe("assigned-at-hire");
    expect(f.k.store.runtime("child").scopeAssignedBranch?.branch).toBe("assigned-at-hire");
    f.bb.sdk.environments.get = async args => ({ ...await get(args), branchName: "colleague" });
    await f.runtime.scopes!.api.rebindScope("child");
    expect(f.runtime.scopes!.view("child")!.scope?.assignedBranch).toBe("assigned-at-hire");
  });
  it("keeps a legacy Keeper’s mode, rules and grants on load", async () => {
    const f = await fixture();
    const scope = { ...scopeForClass("keeper", undefined, "keeper"), threadId: "lead", issuedAt: 1, mode: "watch" as const };
    scope.tools.allow = scope.tools.allow.filter(name => !["check_ui", "ui_examples", "write", "Write", "edit", "Edit"].includes(name));
    scope.tools.deny.push("write", "Write", "edit", "Edit");
    scope.writes.allow.push("/approved/grant");
    const file = join(f.root, "scopes", "lead.json");
    writeFileSync(file, JSON.stringify({ ...scope, bindingTemplate: scope }));
    const restart = () => new BackendScopes(f.runtime, { dataDir: f.root, installGuard: false, mode: "watch", policyOptions: { home: f.root } });
    scope.shell.allow.push({ id: "approved", argv: ["git", "push"], why: "User approved" });
    writeFileSync(file, JSON.stringify({ ...scope, bindingTemplate: scope }));
    restart().refreshScopeProjections();
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved).toMatchObject({ preset: "keeper", mode: "watch", tools: scope.tools, writes: scope.writes, shell: scope.shell });
    restart().refreshScopeProjections();
    expect(f.k.store.events("lead").filter(event => event.type === "scope.refreshed")).toEqual([]);
  });
  it("protects the live policy without rewriting the legacy open snapshot", async () => {
    const f = await fixture();
    const open = scopeForClass("keeper");
    open.writes.deny = [];
    await f.runtime.scopes!.api.writeScope("lead", open);
    const file = join(f.root, "scopes", "lead.json"), before = readFileSync(file, "utf8");
    const reload = new BackendScopes(f.runtime, { dataDir: f.root, installGuard: false, policyOptions: { home: f.root } });
    reload.refreshScopeProjections();
    expect(readFileSync(file, "utf8")).toBe(before);
    const scope = reload.api.status().threads.find(row => row.threadId === "lead")!.scope!;
    expect(evaluate(scope, { kind: "write", toolName: "write", cwd: f.work, input: { path: join(f.root, ".agents/tavern/scopes.yml") } }))
      .toMatchObject({ allow: false, ruleId: "tavern-control-files" });
  });
  it("leaves current wildcard member snapshots and their grants unchanged", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    const scope = { ...scopeForClass("smith", undefined, "readonly"), threadId: "child", issuedAt: 1 };
    scope.tools.allow = scope.tools.allow.filter(name => !["check_ui", "ui_examples"].includes(name));
    scope.writes.allow.push("/approved/grant");
    const file = join(f.root, "scopes", "child.json");
    writeFileSync(file, JSON.stringify({ ...scope, bindingTemplate: scope }));
    const reload = new BackendScopes(f.runtime, { dataDir: f.root, installGuard: false, policyOptions: { home: f.root } });
    reload.refreshScopeProjections();
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.preset).toBe("readonly");
    expect(saved.tools).toEqual(scope.tools);
    expect(saved.writes).toEqual(scope.writes);
    expect(f.k.store.events("lead").find(event => event.type === "scope.refreshed")).toBeUndefined();
  });
  it("returns already in effect for scratch and own storage requests without opening an ask", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    await expect(f.runtime.scopes!.override("lead", "child", { writes: { allow: [`${realpathSync(tmpdir())}/**`, `${f.storage}/**`, "$BB_THREAD_STORAGE/**"] } }, "Keep records")).resolves.toContain("already in effect");
    expect(f.runtime.scopes!.pending("child")).toBeNull();
    expect(f.k.store.openAsks("lead").filter(ask => ask.kind === "scope")).toHaveLength(0);
  });
  it.each(["npm test", "node --test"])("rejects %s as a shell command, not a tool grant, without opening an ask", async command => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    const before = f.runtime.scopes!.view("child")!.scope;
    await expect(f.runtime.scopes!.override("lead", "child", { tools: { allow: [command] } }, "Run checks")).rejects.toThrow(`${command} is a shell command; the Smith preset already allows it`);
    expect(f.runtime.scopes!.pending("child")).toBeNull();
    expect(f.k.store.openAsks("lead").filter(ask => ask.kind === "scope")).toHaveLength(0);
    expect(f.runtime.scopes!.view("child")!.scope).toEqual(before);
  });

  it("does not mistake an old ordinary command restriction for act authority", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    await f.runtime.scopes!.override("lead", "child", { denyRules: [{ id: "no-tests", argv: ["npm", "test"], why: "Tests are outside this task" }] }, "Narrow tests");
    await expect(f.runtime.scopes!.override("lead", "child", { tools: { allow: ["npm test"] } }, "Run checks")).rejects.toThrow(/shell command.*already allows/);
    expect(f.runtime.scopes!.pending("child")).toBeNull();
  });

  it("accepts an undiscovered tool without an availability grant and retains explicit narrowing", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    await expect(f.runtime.scopes!.override("lead", "child", { tools: { allow: ["unknown_checking_tool"] } }, "Checks")).resolves.toContain("No change");
    await expect(f.runtime.scopes!.override("lead", "child", { tools: { deny: ["web_*"] } }, "No web")).resolves.toContain("Scope updated");
    expect(f.runtime.scopes!.pending("child")).toBeNull();
  });

  it("states that a denied widening preserves existing permissions in the answer and tick", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    await f.runtime.scopes!.override("lead", "child", { allowRules: ["git-push-main"] }, "Optional push");
    const askId = f.k.store.runtime("child").scopePending!;
    const before = f.runtime.scopes!.view("child")!.scope;
    await f.runtime.answerAsk(askId, "deny", null, "page");
    expect(f.k.store.events("lead").find(event => event.type === "ask.answered" && event.data.askId === askId)?.text).toContain("does not forbid commands already allowed");
    expect(f.runtime.scopes!.view("child")!.scope).toEqual(before);
    const ask = f.k.store.get("asks", askId)!;
    expect(ask.options.find(option => option.id === "deny")?.detail).toContain("does not forbid commands already allowed");
    f.advance(120_000);
    await f.runtime.tick("lead");
    expect(JSON.stringify(f.harness.inspection.sdk.callsTo("threads.send"))).toContain("does not forbid commands already allowed");
  });

  it("refuses a rebrief held by a later scope ask without creating a zero-attempt pending delivery", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    await f.runtime.scopes!.override("lead", "child", { allowRules: ["git-push-main"] }, "Requested push");
    expect(f.runtime.scopes!.pending("child")?.initialBrief).toBeNull();
    await expect(f.runtime.tell("lead", "child", "Review the new work")).rejects.toThrow("scope decision");
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toBeNull();
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("counts scope-preflight failures against a pending rebrief's retry budget and opens its blocker", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(new Error("offline"));
    await f.runtime.tell("lead", "child", "Review the new work");
    vi.spyOn(f.runtime.scopes!, "ensure").mockRejectedValue(new Error("scope read unavailable"));
    for (let attempt = 1; attempt < 5; attempt++) {
      f.advance(3_600_000);
      await f.runtime.retryInitialBriefs("lead");
    }
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toMatchObject({ attempts: 5 });
    expect(f.k.store.openAsks("lead").filter(ask => ask.kind === "blocker")).toHaveLength(1);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("spawns with the brief, records delivery once and never sends a duplicate initial brief", async () => {
    const f = await fixture();
    f.bb.sdk.threads.send = vi.fn(async () => ({ ok: true as const, delivery: "sent" as const }));
    await f.runtime.hire("lead", "project", f.input);
    const scope = JSON.parse(readFileSync(join(f.root, "scopes/child.json"), "utf8"));
    expect(scope).toMatchObject({ threadId: "child", preset: "worktree" });
    expect(scope.writes.allow).toContain(realpathSync(f.work));
    expect(f.k.member("child")?.keeperThreadId).toBe("lead");
    expect(f.bb.sdk.threads.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ input: [expect.objectContaining({ type: "text", text: expect.stringContaining(brief.outcome) })], permissionMode: "full" }),
    );
    expect(f.bb.sdk.threads.spawn).not.toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.any(String) }),
    );
    expect(f.bb.sdk.threads.send).not.toHaveBeenCalled();
    expect(f.k.store.runtime("child").briefVersion).toBe(1);
    expect(f.runtime.scopes!.api.status().installation).toBe("disabled");
  });
  it("keeps scope-managed native permissions within the provider's supported modes", async () => {
    const f = await fixture();
    f.bb.sdk.providers.list = async () => [provider("pi", ["auto"])];
    await f.runtime.hire("lead", "project", f.input);
    expect(f.bb.sdk.threads.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "auto" }),
    );
  });
  it("persists a late-bound worktree for a child whose spawn brief is queued before provisioning", async () => {
    const f = await fixture();
    f.bb.sdk.threads.get = async ({ threadId }) =>
      makeThreadResponse({ id: threadId, environmentId: threadId === "child" ? null : "env" });
    f.bb.sdk.threads.send = vi.fn(async () => ({ ok: true as const, delivery: "sent" as const }));
    await f.runtime.hire("lead", "project", f.input);
    const scope = JSON.parse(readFileSync(join(f.root, "scopes/child.json"), "utf8"));
    expect(scope.writes.allow).toContain("${worktree}");
    expect(f.bb.sdk.threads.send).not.toHaveBeenCalled();
    expect(f.harness.inspection.sdk.callsTo("threads.restoreEnvironment")).toHaveLength(0);
  });
  it("holds a widening hire, requires an actual ask answer and remembers only with explicit repo consent", async () => {
    const f = await fixture();
    registerTools(f.bb, f.runtime);
    registerRpc(f.bb, f.runtime);
    const text = await f.harness.behavior.invokeAgentTool(
      "tavern_hire",
      { ...f.input, scope: { allowRules: ["git-push-main"] } },
      { threadId: "lead" },
    );
    expect(text).toContain("Awaiting scope approval");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    const ask = f.k.store.openAsks("lead").find((a) => a.kind === "scope")!;
    expect(ask.proceedAt).toBeNull();
    expect(f.runtime.scopes!.api.status().threads[0]!.scope!.shell.allow).toHaveLength(0);
    await f.harness.invokeRpc("answerAsk", {
      askId: ask.id,
      optionId: "remember-repo",
      note: null,
      via: "page",
    });
    expect(
      f.runtime
        .scopes!.api.status()
        .threads[0]!.scope!.shell.allow.some((rule) => rule.id === "git-push-main"),
    ).toBe(true);
    const remembered = readFileSync(join(f.root, ".agents/tavern/scopes.yml"), "utf8");
    expect(remembered).toContain("git-push-main");
    expect(remembered).toContain("github.com/kalindudc/demo");
    expect(existsSync(join(f.work, ".agents/tavern/scopes.yml"))).toBe(false);
    const childSends = () =>
      f.harness.inspection.sdk
        .callsTo("threads.send")
        .filter((call) => (call.args[0] as { threadId: string }).threadId === "child");
    expect(childSends()).toHaveLength(0);
    expect(f.k.store.get("scopeRequests", ask.id)?.state).toBe("applied");
    await f.harness.invokeRpc("answerAsk", {
      askId: ask.id,
      optionId: "remember-repo",
      note: null,
      via: "page",
    });
    expect(childSends()).toHaveLength(0);
  });
  it("refuses a cluster-write scope request without opening an ask", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    registerTools(f.bb, f.runtime);
    await expect(f.harness.behavior.invokeAgentTool("tavern_scope", {
      memberThreadId: "child", reason: "Apply the sample deployment", override: { allowRules: ["cluster-write"] },
    }, { threadId: "lead" })).rejects.toThrow(/Cluster writes can't be granted as scope/);
    expect(f.k.store.openAsks("lead").filter(a => a.kind === "scope")).toHaveLength(0);
  });
  it("applies safe narrowing immediately, refuses foreign members and withholds an unapproved widening", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    registerTools(f.bb, f.runtime);
    const text = await f.harness.behavior.invokeAgentTool(
      "tavern_scope",
      {
        memberThreadId: "child",
        reason: "Push a private repository",
        override: { allowRules: ["git-push-main"], tools: { deny: ["web_*"] } },
      },
      { threadId: "lead" },
    );
    expect(text).toContain("scope");
    let scope = f.runtime.scopes!.api.status().threads[0]!.scope!;
    expect(scope.tools.deny).toContain("web_*");
    expect(scope.shell.allow).toHaveLength(0);
    expect(
      await f.runtime.dispatch(dispatch049({ threadId: "child", pluginId: "tavern" })),
    ).toEqual({ action: "proceed" });
    const ask = f.k.store.openAsks("lead").find((a) => a.kind === "scope")!;
    await f.runtime.answerAsk(ask.id, "deny", null, "page");
    scope = f.runtime.scopes!.api.status().threads[0]!.scope!;
    expect(scope.shell.allow).toHaveLength(0);
    expect(scope.tools.deny).toContain("web_*");
    f.k.bind("other", "keeper", "moss", "project");
    await expect(f.runtime.scopes!.override("other", "child", {}, "No")).rejects.toThrow(
      "own party",
    );
  });
  it("writes typed thread scopes before admission and waits instead of launching on a path failure", async () => {
    const f = await fixture();
    const ctx = dispatch049({
      threadId: "typed",
      status: "pending",
      submission: { pluginId: "tavern", data: { classId: "ranger" } },
    });
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    expect(
      f.runtime.scopes!.api.status().threads.find((row) => row.threadId === "typed")?.scope?.preset,
    ).toBe("readonly");
    f.bb.sdk.threads.storageLocation = async () => {
      throw new Error("storage unavailable");
    };
    const fail = dispatch049({
      threadId: "cold",
      status: "pending",
      submission: { pluginId: "tavern", data: { classId: "ranger" } },
    });
    expect(await f.runtime.dispatch(fail)).toMatchObject({
      action: "wait",
      reason: expect.stringContaining("scope"),
    });
  });
  it.each(["wanderer", null])(
    "leaves a directly started %s unscoped without reading scope paths",
    async (classId) => {
      const f = await fixture();
      const shouldScope = vi.spyOn(f.runtime.scopes!.api, "shouldScope");
      const writeScope = vi.spyOn(f.runtime.scopes!.api, "writeScope");
      f.bb.sdk.threads.storageLocation = vi.fn(async () => {
        throw new Error("No scope paths for a direct general-purpose thread");
      });
      const ctx = dispatch049({
        threadId: "direct",
        status: "pending",
        submission: classId ? { pluginId: "tavern", data: { classId } } : null,
      });
      expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
      await f.runtime.threadStarted(
        makeThreadResponse({ id: "direct", environmentId: "env", status: "active" }),
      );
      if (classId) expect(shouldScope).toHaveBeenCalledWith(classId, "direct");
      expect(writeScope).not.toHaveBeenCalled();
      expect(f.bb.sdk.threads.storageLocation).not.toHaveBeenCalled();
      expect(existsSync(join(f.root, "scopes/direct.json"))).toBe(false);
      expect(f.k.member("direct")?.role ?? null).toBe(classId ? "solo" : null);
    },
  );
  it("scopes a hired Wanderer before its brief and retains hire origin on later dispatch", async () => {
    const f = await fixture();
    const shouldScope = vi.spyOn(f.runtime.scopes!.api, "shouldScope");
    f.bb.sdk.threads.send = vi.fn(async () => ({ ok: true as const, delivery: "sent" as const }));
    await f.runtime.hire("lead", "project", {
      classId: "wanderer",
      boardQuestId: null,
      waypointId: null,
      errand: true,
      title: "Answer a side question",
      brief,
    });
    expect(shouldScope).toHaveBeenCalledWith("wanderer", "hire");
    const scope = JSON.parse(readFileSync(join(f.root, "scopes/child.json"), "utf8"));
    expect(scope).toMatchObject({ preset: "open", sandbox: false, writes: { mode: "any" } });
    expect(scope.writes.deny.length).toBeGreaterThan(0);
    expect(f.bb.sdk.threads.send).not.toHaveBeenCalled();
    f.runtime.scopes!.api.clearScope("child");
    shouldScope.mockClear();
    expect(
      await f.runtime.dispatch(dispatch049({ threadId: "child", pluginId: "tavern" })),
    ).toEqual({ action: "proceed" });
    expect(shouldScope).toHaveBeenCalledWith("wanderer", "hire");
    expect(f.runtime.scopes!.view("child")?.scope?.preset).toBe("open");
  });
  it("never treats a remote path or a shared Smith checkout as a local worktree", async () => {
    const f = await fixture();
    f.bb.sdk.environments.get = async () =>
      ({ hostId: "remote", path: f.work, isGitRepo: true, isWorktree: true, environmentProviderId: "git-worktree", branchName: "main" }) as never;
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow("No machine rule places Smith members for this project, and this Keeper runs on another machine. Add a rule in Settings, Where work runs.");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
  it("records one Keeper notice and no user ask, while keeping the evidence visible", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    registerRpc(f.bb, f.runtime);
    const violation = {
      threadId: "child",
      providerId: "pi",
      at: f.time(),
      eventId: "blocked",
      seq: 3,
      ruleId: "git-push-main",
      reason: "Blocked push",
      stopped: false,
      stopError: "interrupt failed",
      latencyMs: 12,
    };
    await f.runtime.scopes!.violation(violation);
    await f.runtime.scopes!.violation(violation);
    expect(f.k.store.openAsks("lead").filter((a) => a.kind === "blocker")).toHaveLength(0);
    expect(new AttentionSnapshot(f.k.store).asks).toEqual([]);
    expect(f.k.store.events("lead").filter((e) => e.type === "scope.violation")).toMatchObject([{ data: violation }]);
    expect(readStatus(f.runtime, "lead", statusInput.parse({}))).toMatchObject({ scopeBlocks: [{ data: violation }] });
    expect(f.k.member("child")?.state).toBe("waiting");
    const decor = (await f.harness.invokeRpc("decor", { threadId: "child" })) as {
      scope: unknown;
      violations: unknown[];
    };
    expect(decor.scope).toMatchObject({ scope: { preset: "worktree" } });
    expect(decor.violations).toHaveLength(1);
    for (const method of ["ledger", "boardQuest"]) {
      const result = (await f.harness.invokeRpc(
        method,
        method === "ledger" ? { threadId: "lead" } : { id: f.q.id },
      )) as { scopes: unknown[]; violations: unknown[] };
      expect(result.scopes.length).toBeGreaterThan(0);
      expect(result.violations).toHaveLength(1);
    }
    expect(f.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    f.k.store.patch("lead", { userAt: null });
    await f.runtime.tick("lead");
    const ticks = f.harness.inspection.sdk
      .callsTo("threads.send")
      .filter((call) => (call.args[0] as { threadId: string }).threadId === "lead");
    expect(JSON.stringify(ticks)).toContain("STOP FAILED");
  });
  it("records distinct violations without the legacy repeated-refusal notice", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    const scopes = f.runtime.scopes!;
    const refused = (seq: number, ruleId = "tavern-control-files") => scopes.violation({ threadId: "child", providerId: "pi",
      at: f.time(), eventId: `blocked-${seq}`, seq, ruleId, reason: "Blocked write", mode: "enforce", prevented: true, stopped: false, latencyMs: 0 });
    const notices = () => f.k.store.events("lead").filter(e => e.type === "scope.repeated-refusal");
    await refused(1); await refused(1); await refused(2); await refused(3);
    await refused(4, "checker-write");
    expect(notices()).toEqual([]);
    const violations = f.k.store.events("lead").filter(e => e.type === "scope.violation");
    expect(violations.map(event => event.data.eventId)).toEqual(["blocked-1", "blocked-2", "blocked-3", "blocked-4"]);
    expect(new AttentionSnapshot(f.k.store).asks).toEqual([]);
    expect(f.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  });
  it("lets the Keeper request one manual Pi repair and keeps Done open until the guard is armed", async () => {
    const f = await fixture(true);
    await f.runtime.hire("lead", "project", f.input);
    registerRpc(f.bb, f.runtime);
    registerTools(f.bb, f.runtime);
    const scopes = f.runtime.scopes!;
    expect(scopes.view("child")?.guardCheckFailed).toBe(false);
    const violation = { threadId: "child", providerId: "pi", at: f.time(), eventId: "missing-guard", seq: 3,
      ruleId: "guard-not-loaded", reason: "Guard not loaded", mode: "enforce" as const, stopped: true, latencyMs: 1 };
    await scopes.violation(violation);
    expect(new AttentionSnapshot(f.k.store).asks).toEqual([]);
    expect(scopes.view("child")?.guardCheckFailed).toBe(true);
    expect(() => scopes.requestGuardRepair("child", "child")).toThrow();
    const result = await f.harness.behavior.invokeAgentTool("tavern_scope", { memberThreadId: "child", repairGuard: true }, { threadId: "lead" });
    const ask = f.k.store.openAsks("lead").find(a => a.effect?.type === "repair-guard")!;
    expect(result).toContain(`::tavern-ask{id="${ask.id}"}`);
    expect(scopes.requestGuardRepair("lead", "child").id).toBe(ask.id);
    expect(scopes.view("child")?.repairAskId).toBe(ask.id);
    expect(new AttentionSnapshot(f.k.store).asks).toEqual([expect.objectContaining({
      id: ask.id, question: expect.stringMatching(/Restart .*Pi session/), options: [expect.objectContaining({ id: "done", label: "Done" })],
    })]);
    const done = () => f.harness.invokeRpc("answerAsk", { askId: ask.id, optionId: "done", note: null, via: "page" });
    await expect(done()).rejects.toThrow(/not armed/i);
    expect(f.k.store.get("asks", ask.id)?.state).toBe("open");
    const local = scopes.api.localScopeRecord("child")!;
    armScope(local.file, local.scope);
    expect(scopes.view("child")?.guardCheckFailed).toBe(false);
    await done();
    expect(f.k.store.get("asks", ask.id)).toMatchObject({ state: "answered", answer: { optionId: "done", by: "user" } });
    expect(new AttentionSnapshot(f.k.store).asks).toEqual([]);
  });

  it("still presents a real scope-grant choice to the user", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    await f.runtime.scopes!.override("lead", "child", { allowRules: ["git-push-main"] }, "Requested push");
    expect(new AttentionSnapshot(f.k.store).asks).toEqual([expect.objectContaining({
      effect: { type: "grant-scope", memberThreadId: "child" }, options: expect.arrayContaining([expect.objectContaining({ id: "approve" }), expect.objectContaining({ id: "deny" })]),
    })]);
  });

  it("does not project a closed widening ask as pending", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    await f.runtime.scopes!.override("lead", "child", { allowRules: ["git-push-main"] }, "Requested push");
    registerRpc(f.bb, f.runtime);
    const askId = f.k.store.runtime("child").scopePending!;
    const decor = () => f.harness.invokeRpc("decor", { threadId: "child" });
    expect(await decor()).toMatchObject({ scope: { pendingAskId: askId } });
    f.k.withdrawAsk(askId, "plan-superseded");
    expect(f.k.store.runtime("child").scopePending).toBe(askId);
    expect(await decor()).toMatchObject({ openScopeAsk: false, scope: { pendingAskId: null } });
  });

  it("allows policy-covered grants from trusted remotes without opening an ask", async () => {
    const f = await fixture();
    mkdirSync(join(f.root, ".agents/tavern"), { recursive: true });
    writeFileSync(
      join(f.root, ".agents/tavern/scopes.yml"),
      "v: 1\nrules:\n  - remote: github.com/kalindudc/*\n    classes:\n      smith:\n        keeperMayAllow: [git-push-main]\n",
    );
    await f.runtime.hire("lead", "project", {
      ...f.input,
      scope: { allowRules: ["git-push-main"] },
    });
    expect(f.k.store.openAsks("lead").filter((ask) => ask.kind === "scope")).toHaveLength(0);
    expect(f.runtime.scopes!.api.status().threads[0]!.scope!.shell.allow[0]?.id).toBe(
      "git-push-main",
    );
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
  it("does not remember an allow-once answer and never exposes approval ids to tools", async () => {
    const f = await fixture();
    registerTools(f.bb, f.runtime);
    await f.runtime.hire("lead", "project", {
      ...f.input,
      scope: { allowRules: ["git-push-main"] },
    });
    const ask = f.k.store.openAsks("lead").find((ask) => ask.kind === "scope")!;
    expect(ask.scopeChange).toMatchObject({
      memberThreadId: "child",
      override: { allowRules: ["git-push-main"] },
      widenings: ["git-push-main"],
      projectRoot: f.work,
    });
    expect(
      await f.runtime.dispatch(dispatch049({ threadId: "child", pluginId: "tavern" })),
    ).toMatchObject({ action: "wait" });
    await f.runtime.answerAsk(ask.id, "approve", null, "page");
    expect(existsSync(join(f.work, ".agents/tavern/scopes.yml"))).toBe(false);
    await expect(
      f.harness.behavior.invokeAgentTool(
        "tavern_scope",
        {
          memberThreadId: "child",
          reason: "Forge",
          override: { approvedRuleIds: ["git-push-force"] },
        },
        { threadId: "lead" },
      ),
    ).rejects.toThrow();
  });
  it("declines a held hire without sending its brief or retaining its allocation", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", {
      ...f.input,
      scope: { allowRules: ["git-push-main"] },
    });
    const ask = f.k.store.openAsks("lead").find((ask) => ask.kind === "scope")!;
    await f.runtime.answerAsk(ask.id, "deny", null, "page");
    expect(f.k.member("child")).toMatchObject({ engagement: "archived", disposition: "released" });
    expect(f.k.store.allocated(f.q.id, "smith")).toBe(0);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(f.runtime.scopes!.api.status().threads).toHaveLength(0);
  });
  it("installs the marked shim at startup and exposes bounded scope, violation and guard CLI commands", async () => {
    const f = await fixture(true);
    registerCli(f.bb, f.runtime);
    expect(f.runtime.scopes!.api.status().installation).toBe("installed");
    const shim = join(f.root, ".pi/agent/extensions/tavern-guard/index.ts");
    expect(readFileSync(shim, "utf8")).toContain("adapters/pi/extension.ts");
    await f.runtime.hire("lead", "project", f.input);
    const cli = f.harness.inspection.registrations.cli[0]!;
    expect((await cli.run(["scope", "child"], {})).stdout).toContain("worktree");
    expect((await cli.run(["violations", "child"], {})).stdout).toContain("[]");
    expect((await cli.run(["guard", "status"], {})).stdout).toContain("installed");
    const refused = await cli.run(["guard", "uninstall"], { threadId: "lead" });
    expect(refused.exitCode).not.toBe(0);
    expect(existsSync(shim)).toBe(true);
    expect((await cli.run(["guard", "uninstall"], {})).exitCode).toBe(0);
    expect(existsSync(shim)).toBe(false);
    expect((await cli.run(["guard", "install"], {})).exitCode).toBe(0);
    expect(existsSync(shim)).toBe(true);
  });
  it("restores an approved pending scope after a retryable application failure", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", {
      ...f.input,
      scope: { allowRules: ["git-push-main"] },
    });
    const ask = f.k.store.openAsks("lead").find((ask) => ask.kind === "scope")!;
    const apply = f.runtime.scopes!.api.applyOverride;
    f.runtime.scopes!.api.applyOverride = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockImplementation(apply);
    await expect(f.runtime.answerAsk(ask.id, "approve", null, "page")).rejects.toThrow(
      "disk unavailable",
    );
    expect(f.k.store.get("scopeRequests", ask.id)?.state).toBe("pending");
    await f.runtime.scopes!.resume("lead");
    expect(f.k.store.get("scopeRequests", ask.id)?.state).toBe("applied");
  });
  it("retains archived scopes and cursors, keeps unarchive scoped, and clears only on deletion", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    await f.runtime.scopes!.violation({
      threadId: "child",
      providerId: "pi",
      at: f.time(),
      eventId: "history",
      seq: 1,
      ruleId: "no-main",
      reason: "Main is protected",
      stopped: true,
      latencyMs: 2,
    });
    const file = join(f.root, "scopes/child.json");
    writeFileSync(file + ".cursor", JSON.stringify({ cursor: 17, pendingStop: false }));
    const before = readFileSync(file, "utf8");
    await f.runtime.threadLifecycle("thread.archived", {
      thread: makeThreadResponse({ id: "child", archivedAt: f.time(), environmentId: "env" }),
    });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(file + ".cursor", "utf8")).cursor).toBe(17);
    await f.runtime.threadLifecycle("thread.unarchived", {
      thread: makeThreadResponse({ id: "child", environmentId: "env" }),
    });
    expect(readFileSync(file, "utf8")).toBe(before);
    f.runtime.updateThread(
      makeThreadResponse({ id: "child", archivedAt: f.time(), deletedAt: f.time() }),
    );
    expect(existsSync(file)).toBe(false);
    expect(f.runtime.scopes!.violations(["child"])).toHaveLength(1);
  });
  it("retains the scope when wrapping archives the party", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    patchThreadFixture(f.k.store, "child", { archivePending: true });
    f.bb.sdk.threads.archive = vi.fn(async () => ({
      ok: true as const,
      archivedThreadIds: ["child"],
    }));
    await f.runtime.sweep();
    expect(f.bb.sdk.threads.archive).toHaveBeenCalledWith({ threadId: "child" });
    expect(f.runtime.scopes!.view("child")).toMatchObject({ scope: { preset: "worktree" } });
  });
  it("returns only JSON values for a member hired before guard postures existed", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    const { guardPosture: _absent, ...member } = f.k.member("child")!;
    f.k.store.put("members", "child", member);
    const undefinedPaths = (value: unknown, path = "$"): string[] =>
      value === undefined
        ? [path]
        : value !== null && typeof value === "object"
          ? Object.entries(value).flatMap(([key, item]) => undefinedPaths(item, `${path}.${key}`))
          : [];
    expect(undefinedPaths(f.runtime.scopes!.view("child"))).toEqual([]);
  });
  it("pins an expected root after a deferred worktree becomes provisioned", async () => {
    const f = await fixture();
    let provisioned = false;
    f.bb.sdk.threads.get = async ({ threadId }) =>
      makeThreadResponse({
        id: threadId,
        environmentId: threadId === "child" && !provisioned ? null : "env",
      });
    await f.runtime.hire("lead", "project", f.input);
    const scopes = f.runtime.scopes!;
    const problem = "The Smith runs as a Ranger until its worktree is bound.";
    expect(scopes.view("child")?.scope?.expectedWorktree).toBeUndefined();
    await scopes.pinWorktree("child");
    expect(scopes.view("child")?.problems).toContain(problem);
    provisioned = true;
    await f.runtime.threadStarted(
      makeThreadResponse({ id: "child", environmentId: "env", status: "active" }),
    );
    expect(scopes.view("child")?.scope?.expectedWorktree).toBe(realpathSync(f.work));
    expect(scopes.view("child")?.problems).not.toContain(problem);
    f.k.store.patch("child", { scopeProblems: [problem] });
    expect(scopes.view("child")?.problems).not.toContain(problem);
    await scopes.pinWorktree("child");
    expect(f.k.store.runtime("child").scopeProblems).not.toContain(problem);
  });
  it("surfaces ignored class and project policy widening in member RPCs and hire notes", async () => {
    const f = await fixture();
    mkdirSync(join(f.work, ".agents/tavern"), { recursive: true });
    writeFileSync(
      join(f.work, ".agents/tavern/scopes.yml"),
      "v: 1\nrules:\n  - classes:\n      smith:\n        keeperMayAllow: [git-push-main]\n",
    );
    const snapshot = structuredClone(f.runtime.snapshot());
    snapshot.classes.find((role) => role.id === "smith")!.scope = "open";
    vi.spyOn(f.runtime, "snapshot").mockReturnValue(snapshot);
    const hired = await f.runtime.hire("lead", "project", f.input);
    registerRpc(f.bb, f.runtime);
    expect(hired.executionNotes.join(" ")).toContain("Ignored class scope");
    const decor = (await f.harness.invokeRpc("decor", { threadId: "child" })) as {
      scope: { problems: string[]; mode: string };
    };
    expect(decor.scope.mode).toBe("enforce");
    expect(decor.scope).toHaveProperty("guard.sandbox");
    expect(
      decor.scope.problems.some((problem) => problem.includes("project policies may only narrow")),
    ).toBe(true);
    expect(decor.scope.problems.some((problem) => problem.includes("Ignored class scope"))).toBe(
      true,
    );
  });
  it("lets a human choose the trusted push destination when remembering a grant with several remotes", async () => {
    const f = await fixture();
    const context = {
      projectRoot: f.work,
      remotes: ["https://github.com/kalindudc/demo.git", "https://github.com/company/demo.git"],
    };
    vi.spyOn(f.runtime, "scopeProjectContext").mockReturnValue(context);
    await f.runtime.hire("lead", "project", {
      ...f.input,
      scope: { allowRules: ["git-push-main"] },
    });
    const ask = f.k.store.openAsks("lead").find((ask) => ask.kind === "scope")!;
    const choice = ask.options.find((option) => option.label.includes("company/demo"))!;
    expect(choice).toBeDefined();
    await f.runtime.answerAsk(ask.id, choice.id, null, "page");
    const remembered = readFileSync(join(f.root, ".agents/tavern/scopes.yml"), "utf8");
    expect(remembered).toContain("github.com/company/demo");
    expect(remembered).not.toContain("kalindudc/demo");
  });
  it("lists the held act with its ask kind in the Keeper's tick and keeps Watch neutral", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    f.k.store.patch("lead", { cursor: f.k.store.eventSequence("lead"), userAt: null, reanchor: null });
    const base = { threadId: "child", at: f.time(), eventId: "held", act: "merge" as const };
    f.runtime.scopes!.observeAct({ ...base, mode: "enforce", preflight: true });
    f.runtime.scopes!.observeAct({ ...base, eventId: "recorded", mode: "watch" });
    f.runtime.scopes!.observeAct({ ...base, eventId: "recorded", mode: "watch" });
    const restatement = f.k.restatement("lead");
    expect(restatement).toContain("Held merge; needs a merge ask.");
    expect(restatement).toContain("would have needed a grant: 1 merge");
    expect(restatement).not.toContain("tavern_report status needs-decision");
    await f.runtime.tick("lead");
    const ticks = f.harness.inspection.sdk.callsTo("threads.send").filter(call => (call.args[0] as { threadId: string }).threadId === "lead");
    expect(JSON.stringify(ticks)).toContain("Held merge; needs a merge ask.");
    expect(f.k.store.events("lead").filter(e => e.type === "scope.act-held")).toHaveLength(1);
    expect(f.k.store.openAsks("lead").filter(a => a.kind === "blocker")).toHaveLength(0);
    expect(f.k.member("child")?.state).toBe("idle");
  });
  it("opens an ask for the held command and directory without retyping either, then clears the hold", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    const scopes = f.runtime.scopes!, command = "npm publish --tag 'proof'";
    const cwd = join(f.work, "nested");
    mkdirSync(cwd);
    scopes.observeAct({ threadId: "child", eventId: "exact", at: f.time(), mode: "enforce", preflight: true, act: "publish", command, cwd });
    expect(f.k.restatement("lead")).toContain('heldEventId="child:exact"');
    const ask = scopes.askAct("lead", { heldEventId: "child:exact", why: "The plan calls for this package." });
    expect(ask.effect).toMatchObject({ type: "grant-shell-act", target: { command, cwd: realpathSync(cwd) }, heldEventId: "child:exact" });
    f.k.decide("lead", { askId: ask.id, optionId: "deny", boardQuestId: f.q.id, text: "Do not publish", why: "Keep the dry run.", source: "keeper", reversible: true });
    expect(f.k.restatement("lead")).not.toContain('heldEventId="child:exact"');
    expect(() => scopes.askAct("lead", { heldEventId: "child:exact", why: "Old hold." })).toThrow(/open held shell act/i);
    scopes.observeAct({ threadId: "child", eventId: "again", at: f.time(), mode: "enforce", preflight: true, act: "publish", command, cwd });
    const allow = scopes.askAct("lead", { heldEventId: "child:again", why: "Publish the verified package." });
    f.k.decide("lead", { askId: allow.id, optionId: "once", boardQuestId: f.q.id, text: "Publish", why: "The plan covers it.", source: "keeper", reversible: true });
    expect(f.k.restatement("lead")).not.toContain('heldEventId="child:again"');
  });
  it("does not create a generic configuration ask or let an ask authorize Tavern controls", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    const scopes = f.runtime.scopes!, scope = scopes.view("child")!.scope!;
    const configuration = "bb plugin install fixture", control = "bb plugin config tavern set scopes.mode off";
    expect(evaluate(scope, { kind: "bash", toolName: "bash", cwd: f.work, input: { command: configuration } }).allow).toBe(true);
    expect(evaluate(scope, { kind: "bash", toolName: "bash", cwd: f.work, input: { command: control } }))
      .toMatchObject({ allow: false, ruleId: "tavern-control" });
    for (const command of [configuration, control])
      expect(() => scopes.askAct("lead", { memberThreadId: "child", command, why: "Change fixture configuration." })).toThrow(/literal shell act/);
    expect(f.k.store.openAsks("lead")).toEqual([]);
  });
  it("issues an exact member grant in the Keeper lane and expires it on release", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    const ask = f.runtime.scopes!.askAct("lead", { memberThreadId: "child", command: "npm publish --registry https://registry.example.test", why: "The plan calls for publishing the package." });
    expect(ask.effect?.type).toBe("grant-shell-act");
    expect(f.k.authority.lane(ask)).toBe("keeper");
    expect(ask.options.map(a => a.id)).toEqual(["once", "quest", "deny"]);
    f.k.decide("lead", { askId: ask.id, optionId: "quest", boardQuestId: f.q.id, text: "Publish this package only", why: "The approved plan calls for it.", source: "keeper", reversible: true });
    expect(f.k.store.events("lead").filter(e => e.type === "grant.issued")).toHaveLength(1);
    expect(f.runtime.scopes!.view("child")?.shellGrants).toMatchObject([{ scope: "quest", state: "issued", usable: false }]);
    const decision = f.k.decide("lead", { boardQuestId: f.q.id, text: "Release the publisher", why: "No more calls", source: "keeper", reversible: true });
    await f.runtime.release("lead", "child", "No more calls", { kind: "decision", id: decision.id });
    expect(f.k.store.events("lead").filter(e => e.type === "grant.expired")).toHaveLength(1);
  });
  it("requires the user for a merge grant and never offers an ordinary cluster grant", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    const ask = f.runtime.scopes!.askAct("lead", { memberThreadId: "child", command: `gh pr merge https://github.example.test/org/repo/pull/42 --merge --match-head-commit ${"a".repeat(40)}`, why: "Merge verified work." });
    expect(ask.kind).toBe("merge");
    expect(f.k.authority.lane(ask)).toBe("user");
    expect(() => f.k.decide("lead", { askId: ask.id, optionId: "once", boardQuestId: f.q.id, text: "Merge", why: "Checked", source: "keeper", reversible: true })).toThrow("This ask belongs to the user");
    expect(() => f.runtime.scopes!.askAct("lead", { memberThreadId: "child", command: "kubectl apply -f object.yaml", why: "Apply change." })).toThrow(/cluster writes/i);
    expect(f.k.store.events("lead").filter(e => e.type === "grant.issued")).toHaveLength(0);
  });
  it("records grant.used once after the granted shell command completes in Enforce", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    const scopes = f.runtime.scopes!, command = "npm publish --tag proof";
    const ask = scopes.askAct("lead", { memberThreadId: "child", command, why: "Publish the reviewed package." });
    f.k.decide("lead", { askId: ask.id, optionId: "once", boardQuestId: f.q.id, text: "Publish", why: "The plan covers it.", source: "keeper", reversible: true });
    const record = scopes.api.localScopeRecord("child")!, receipt = "a".repeat(36);
    armScope(record.file, record.scope);
    expect(claimShellGrant(record.file, record.scope, ask.id, receipt, [command])).toBe(true);
    const event = { id: "completion", seq: 1, createdAt: Date.now(), type: "item/completed", data: { item: { id: "call1", type: "commandExecution", command, cwd: f.work, status: "completed", aggregatedOutput: `published\nTavern shell grant receipt: ${ask.id} ${receipt}` } } };
    f.bb.sdk.threads.events.list = vi.fn(async () => [event]) as never;
    const hooks = vi.mocked(f.bb.events.on).mock.calls as unknown as [string, (payload: unknown) => Promise<void>][];
    const watcher = hooks.find(([name]) => name === "experimental_thread.events")![1];
    await watcher({ thread: makeThreadResponse({ id: "child", providerId: "pi" }), sequence: 1 });
    await watcher({ thread: makeThreadResponse({ id: "child", providerId: "pi" }), sequence: 1 });
    expect(f.bb.sdk.threads.stop).not.toHaveBeenCalled();
    expect(scopes.violations(["child"])).toEqual([]);
    expect(f.k.store.get("shellGrants", ask.id)?.state).toBe("used");
    expect(f.k.store.events("lead").filter(e => e.type === "grant.used")).toHaveLength(1);
  });
  it("revokes an exact grant from the member panel and ends a different grant when the quest stops", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    registerRpc(f.bb, f.runtime);
    const ask = (command: string) => f.runtime.scopes!.askAct("lead", { memberThreadId: "child", command, why: "The plan calls for this package." , unsure: true });
    const first = ask("npm publish --registry https://registry.example.test");
    const second = ask("npm publish --registry https://registry2.example.test");
    for (const row of [first, second]) await f.harness.invokeRpc("answerAsk", { askId: row.id, optionId: "quest", via: "page" });
    await f.harness.invokeRpc("revokeShellGrant", { threadId: "child", id: first.id });
    expect(f.k.store.get("shellGrants", first.id)?.state).toBe("revoked");
    await f.runtime.stop(f.q.id);
    expect(f.k.store.get("shellGrants", second.id)?.state).toBe("expired");
    expect(f.k.store.events("lead").filter(e => e.type === "grant.revoked")).toHaveLength(1);
    expect(f.k.store.events("lead").filter(e => e.type === "grant.expired")).toHaveLength(1);
  });
  it("returns watch-only observations in RPCs without opening blockers or marking the member waiting", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    registerRpc(f.bb, f.runtime);
    f.runtime.scopes!.api.setMode("watch");
    const observation = {
      threadId: "child",
      providerId: "pi",
      at: f.time(),
      eventId: "observed",
      seq: 9,
      ruleId: "no-main",
      reason: "Observed",
      mode: "watch",
      stopped: false,
      latencyMs: 1,
    };
    writeFileSync(join(f.root, "scope-violations.jsonl"), JSON.stringify(observation) + "\n");
    const decor = (await f.harness.invokeRpc("decor", { threadId: "child" })) as {
      violations: (typeof observation)[];
    };
    expect(decor.violations).toHaveLength(1);
    expect(decor.violations[0]!.mode).toBe("watch");
    expect(f.k.store.openAsks("lead").filter((ask) => ask.kind === "blocker")).toHaveLength(0);
    expect(f.k.member("child")?.state).toBe("idle");
  });
  it("clears a pending scope request only after quest Stop is confirmed", async () => {
    const f = await fixture();
    registerRpc(f.bb, f.runtime);
    await f.runtime.hire("lead", "project", f.input);
    await f.runtime.scopes!.override("lead", "child", { allowRules: ["git-push-main"] }, "Requested push");
    const askId = f.k.store.runtime("child").scopePending!;
    expect(f.k.store.get("scopeRequests", askId)?.state).toBe("pending");
    expect(f.k.store.get("asks", askId)?.state).toBe("open");
    const get = f.bb.sdk.threads.get;
    let status: "active" | "idle" = "active";
    f.bb.sdk.threads.get = async args => ({
      ...(await get(args)),
      status: args.threadId === "child" ? status : "idle",
    });
    expect(await f.harness.invokeRpc("stopBoardQuest", { id: f.q.id })).toEqual({ phase: "stopping", unconfirmed: 1 });
    expect(f.k.store.runtime("child").scopePending).toBe(askId);
    expect(f.k.store.get("scopeRequests", askId)?.state).toBe("pending");
    expect(f.runtime.scopes!.api.status().threads).toHaveLength(1);
    status = "idle";
    f.advance(5000);
    await f.runtime.retryStops("lead");
    expect(f.k.quest(f.q.id).phase).toBe("stopped");
    expect(f.bb.sdk.threads.stop).toHaveBeenCalledWith({ threadId: "child" });
    expect(f.runtime.scopes!.api.status().threads).toHaveLength(0);
    expect(f.k.store.get("scopeRequests", askId)?.state).toBe("declined");
    expect(f.k.store.runtime("child").scopePending).toBeNull();
    expect(f.runtime.scopes!.pending("child")).toBeNull();
    expect(f.k.store.get("asks", askId)?.state).toBe("withdrawn");
  });
  it("clears a released member's scope only after stop confirmation and withdraws pending scope asks", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    await f.runtime.scopes!.override(
      "lead",
      "child",
      { allowRules: ["git-push-main"] },
      "Requested push",
    );
    const ask = f.k.store.openAsks("lead").find((ask) => ask.kind === "scope")!;
    const get = f.bb.sdk.threads.get;
    let status = "active" as "active" | "idle";
    f.bb.sdk.threads.get = async (args) => ({
      ...(await get(args)),
      status: args.threadId === "child" ? status : "idle",
    });
    expect(await f.runtime.release("lead", "child", "Replace it")).toBe(false);
    expect(f.runtime.scopes!.api.status().threads).toHaveLength(1);
    status = "idle";
    await f.runtime.sweep();
    expect(f.runtime.scopes!.api.status().threads).toHaveLength(0);
    expect(f.bb.sdk.threads.stop).toHaveBeenCalledWith({ threadId: "child" });
    expect(f.k.store.get("asks", ask.id)?.state).toBe("withdrawn");
    expect(f.k.store.runtime("child").scopePending).toBeNull();
  });
});
