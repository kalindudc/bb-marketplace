// @vitest-environment node
import { seedQuest } from "./support";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluate } from "../../src/scope";
import { registerTools } from "../../src/server/tools";
import { makeThreadResponse } from "./host";
import { setup } from "./runtime-fixture";
import { planInput, waypointEntry } from "./support";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const brief = { outcome: "Verify the maker", mode: "make-it-work" as const, outOfScope: "Changes", doneWhen: "./bin/unapproved-check", context: [], questions: [], timeboxMinutes: null };
async function fixture(linked = true, doneWhen = "Run `npm test` and `./bin/check-duration --strict`.") {
  const root = mkdtempSync(join(tmpdir(), "tavern-checker-hire-"));
  roots.push(root);
  const repo = join(root, "repo"), makerPath = join(root, "maker"), storage = join(root, "storage");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Tavern test", "-c", "user.email=tavern@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "tracked.txt"), "The maker owns this file\n");
  git("-C", repo, "add", "tracked.txt");
  git("-C", repo, "commit", "-qm", "fixture");
  git("-C", repo, "worktree", "add", "-qb", "maker", makerPath);
  mkdirSync(storage);
  const makerRoot = realpathSync(linked ? makerPath : repo);
  const f = setup();
  f.bb.sdk.threads.get = async ({ threadId }) => makeThreadResponse({ id: threadId, environmentId: threadId === "maker" ? "maker-env" : "keeper-env" });
  f.bb.sdk.environments.get = async ({ environmentId }) => ({ id: environmentId, hostId: "host", path: environmentId === "maker-env" ? makerRoot : repo, isGitRepo: true, isWorktree: environmentId === "maker-env" && linked, environmentProviderId: environmentId === "maker-env" ? "git-worktree" : "project-checkout", branchName: "main" }) as never;
  f.bb.sdk.threads.spawn = async () => makeThreadResponse({ id: "child", environmentId: "keeper-env", parentThreadId: "lead" });
  f.bb.sdk.threads.storageLocation = async () => ({ hostId: "host", storageRootPath: storage });
  f.runtime.enableScopes({ dataDir: root, installGuard: false, policyOptions: { home: root } });
  const q = await seedQuest(f.k,"lead", "Build", "Build");
  f.k.bind("maker", "smith", "bram", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", errand: false, title: "Make", brief });
  const entry = waypointEntry("maker", q.id);
  const get = f.port.get;
  f.port.get = id => ({ ...get(id), entries: id === "maker" ? [entry] : [] });
  f.port.linkedEntries = () => [entry];
  const plan = planInput(q.id);
  f.k.plan("lead", { ...plan, doneWhen, waypoints: [{ ...plan.waypoints[0]!, owner: "maker", doneWhen: "`node --test` passes" }], party: [{ classId: "warden", characterId: null, model: null, purpose: "Verify", waypointIds: ["w1"] }] });
  f.k.answerAsk(f.k.store.openAsks("lead").find(ask => ask.kind === "greenlight")!.id, "approve", null, "page", "user");
  const input = { classId: "warden", boardQuestId: q.id, waypointId: "w1", title: "Check", brief };
  const scope = () => f.runtime.scopes!.api.status().threads.find(row => row.threadId === "child")!.scope!;
  const spawnedBrief = () => (f.harness.inspection.sdk.callsTo("threads.spawn")[0]!.args[0] as { input: { text: string }[] }).input[0]!.text;
  return { ...f, root, q, input, makerRoot, repo, scope, spawnedBrief };
}

describe("Warden checker scope at strict-host hire", () => {
  it("defaults to the maker's other repo before selecting any environment", async () => {
    const f = await fixture();
    f.k.store.patch("maker", { projectId: "other" });
    f.k.store.put("members", "maker", { ...f.k.member("maker")!, repo: "other" });
    f.bb.sdk.projects.get = async ({ projectId }) => ({ id: projectId, sources: [] }) as never;
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow("Repo other has no checkout on this host");
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("refuses an explicit Warden repo that differs from its maker", async () => {
    const f = await fixture();
    f.k.store.patch("maker", { projectId: "other" });
    f.k.store.put("members", "maker", { ...f.k.member("maker")!, repo: "other" });
    await expect(f.runtime.hire("lead", "project", { ...f.input, repo: "project" })).rejects.toThrow(/Warden.*maker.*other/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("binds plan commands to the maker’s real linked worktree before its first brief", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    expect(f.scope()).toMatchObject({ preset: "checker", checks: { worktree: f.makerRoot, commands: ["npm test", "./bin/check-duration --strict", "node --test"] } });
    expect(f.scope().checks!.worktree).not.toBe(realpathSync(f.repo));
    expect(f.spawnedBrief()).toContain(f.makerRoot);
    expect(f.spawnedBrief()).toContain("./bin/check-duration --strict");
    expect(f.spawnedBrief()).toMatch(/default.*test.*check.*lint.*typecheck/i);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
  it("allows routine test/check execution without a scope or blocker ask", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    expect(evaluate(f.scope(), { kind: "bash", toolName: "bash", input: { command: "npm test" }, cwd: f.makerRoot })).toMatchObject({ allow: true, check: true });
    expect(f.k.store.openAsks("lead").filter(ask => ["scope", "blocker"].includes(ask.kind))).toEqual([]);
    registerTools(f.bb, f.runtime);
    await expect(f.harness.behavior.invokeAgentTool("tavern_scope", { memberThreadId: "child", override: { tools: { allow: ["npm test"] } }, reason: "Tests" }, { threadId: "lead" })).rejects.toThrow(/preset already allows/);
    expect(f.k.store.openAsks("lead").filter(ask => ["scope", "blocker"].includes(ask.kind))).toEqual([]);
  });
  it("never turns prose or the agent’s extra brief into custom check permissions", async () => {
    const f = await fixture(true, "All duration assertions pass; consult the user if anything differs.");
    await f.runtime.hire("lead", "project", f.input);
    expect(f.scope().checks!.commands).toEqual(["node --test"]);
    expect(evaluate(f.scope(), { kind: "bash", toolName: "bash", input: { command: "./bin/unapproved-check" }, cwd: f.makerRoot }).allow).toBe(false);
  });
  it("keeps ordinary reads available but checks closed when no linked maker root is known", async () => {
    const f = await fixture(false);
    await f.runtime.hire("lead", "project", f.input);
    expect(f.scope()).toMatchObject({ preset: "checker", checks: { commands: ["npm test", "./bin/check-duration --strict", "node --test"] } });
    expect(f.scope().checks!.worktree).toBeUndefined();
    expect(evaluate(f.scope(), { kind: "bash", toolName: "bash", input: { command: "npm test" }, cwd: f.makerRoot }).allow).toBe(false);
    expect(evaluate(f.scope(), { kind: "read", toolName: "read", input: { path: join(f.makerRoot, "tracked.txt") }, cwd: f.makerRoot }).allow).toBe(true);
    expect(f.spawnedBrief()).toMatch(/maker.*worktree.*unavailable|missing.*maker.*root/i);
    expect(f.k.store.openAsks("lead").filter(ask => ["scope", "blocker"].includes(ask.kind))).toEqual([]);
  });
  it("persists an unplaced Warden's checks for a cold scope rewrite", async () => {
    const f = await fixture();
    const member = await f.runtime.hire("lead", "project", f.input);
    const expected = { worktree: f.makerRoot, commands: ["npm test", "./bin/check-duration --strict", "node --test"] };
    const stored = f.k.store.runtime(member.threadId).reviewTarget;
    expect(stored?.snapshotId).toBeFalsy();
    expect.soft(stored?.checks).toEqual(expected);
    f.runtime.scopes!.api.clearScope(member.threadId);
    await f.runtime.scopes!.ensure(member);
    expect(f.scope()).toMatchObject({ preset: "checker", checks: expected });
  });
  it("retains the maker binding through rebind, narrowing and cold scope recovery", async () => {
    const f = await fixture();
    const member = await f.runtime.hire("lead", "project", f.input);
    const checks = f.scope().checks;
    await f.runtime.scopes!.api.rebindScope("child");
    await f.runtime.scopes!.api.applyOverride("child", { tools: { deny: ["web_search"] } });
    expect(f.scope().checks).toEqual(checks);
    f.runtime.scopes!.api.clearScope("child");
    await f.runtime.scopes!.ensure(member);
    expect(f.scope().checks).toEqual(checks);
  });
});
