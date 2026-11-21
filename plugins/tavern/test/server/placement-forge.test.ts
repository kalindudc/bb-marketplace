// @vitest-environment node
import { putMemberFixture } from "./member-fixture";
import Sqlite from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { emulatedGit, realGit } from "../host/emulated-git";
import { serveGit } from "../host/git-daemon";
import { HostRegistry } from "../../src/host/registry";
import { inspectHost } from "../../src/host/inspect";
import { createTransport } from "../../src/host/transport";
import { draftPush, draftOpen } from "../../src/host/forge";
import { hostContract } from "../../src/host-contract";
import { createHostPort } from "../../src/host/client";
import { PlacementStore } from "../../src/server/placement/store";
import { PlacementTransport } from "../../src/server/placement/transport";
import { PlacementForge, MEMBER_PR_REFUSAL } from "../../src/server/placement/forge";
import { KeeperStore } from "../../src/server/keeper/store";
import { Keeper } from "../../src/server/keeper/service";
import { ownershipSteps } from "../../src/server/keeper/succession-ownership";
import { fakePort, putQuestFixture } from "./support";
import { boardQuestSchema } from "../../src/shared/schema";
import { managePullRequest } from "../../src/server/pull-request-rules";
import { MIGRATIONS } from "../../src/server/migrations";
import { placementRecord } from "./placement-fixture";
import type { TavernRuntime } from "../../src/server/runtime";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const f of cleanup.splice(0).reverse()) await f(); });
const git = (root: string, ...args: string[]) => execFileSync(realGit, ["-C", root, ...args], { encoding: "utf8" }).trim();
it.each([[undefined, false, false], ["release", false, false], [undefined, true, false], ["release", true, false], [undefined, true, true]] as const)("carries committed trees, pins the target and leases pushes (base: %s, emulation: %s, private: %s)", async (baseOverride, emulate, pushedOnly) => {
  const root = mkdtempSync(join(tmpdir(), "placement-forge-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), source = join(root, "member"), remote = join(root, "remote.git"), importRoot = pushedOnly ? join(root, "private.git") : home;
  mkdirSync(home); git(home, "init", "-qb", "main"); git(home, "config", "user.name", "Fixture"); git(home, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(home, "work.txt"), "base"); git(home, "add", "."); git(home, "commit", "-qm", "base");
  git(root, "clone", "--bare", home, remote);
  const network = await serveGit(remote); cleanup.push(network.close);
  if (pushedOnly) git(root, "clone", "--no-checkout", remote, importRoot);
  git(root, "clone", remote, source); git(source, "config", "user.name", "Maker"); git(source, "config", "user.email", "maker@example.invalid"); git(source, "checkout", "-qb", "member-work");
  git(home, "remote", "add", "origin", remote); git(home, "fetch", "origin"); git(home, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(home, "remote", "set-url", "origin", network.url);
  const base = git(home, "rev-parse", "HEAD");
  writeFileSync(join(source, "work.txt"), "committed"); git(source, "commit", "-qam", "Member subject\n\nMember body"); const memberHead = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "work.txt"), "dirty"); writeFileSync(join(source, "untracked.txt"), "untracked");
  if (emulate) vi.stubEnv("PATH", emulatedGit(root) + ":" + process.env.PATH);
  const registries = new Map(["home", "member"].map(name => { const dir = join(root, name + "-data"); mkdirSync(dir); return [name, new HostRegistry(dir)] as const; }));
  const env = (name: string) => ({ id: name, projectId: "project", hostId: name, path: name === "home" ? home : source, status: "ready", hostLifecycle: "active", lifecycle: { phase: "active" }, branchName: name === "home" ? "main" : "member-work", baseBranch: "wrong-environment-base", environmentProviderId: "checkout" });
  const calls: string[] = [];
  let corruptTree = false;
  const host = createFakePluginHost({ pluginId: "tavern", experimental_hostEntry: true, sdk: {
    threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "project", environmentId: threadId === "keeper" ? "home" : "member" }) },
    environments: { get: async ({ environmentId }: { environmentId: string }) => env(environmentId) },
  }, experimental_callHostRpc: async call => {
    const registry = registries.get(call.hostId!)!, transport = createTransport(registry); calls.push(call.method);
    if (call.method === "registerEndpoint") return registry.registerEndpoint(hostContract.registerEndpoint.input.parse(call.input));
    if (call.method === "registerTransfer") return registry.registerTransfer(hostContract.registerTransfer.input.parse(call.input));
    if (call.method === "inspect") return inspectHost(registry, hostContract.inspect.input.parse(call.input), call.signal);
    if (call.method === "draftPush") { const input = hostContract.draftPush.input.parse(call.input); return draftPush(registry, { ...input, tree: corruptTree ? "c".repeat(40) : input.tree }, call.signal!); }
    if (call.method === "draftOpen") return draftOpen(registry, hostContract.draftOpen.input.parse(call.input), call.signal!);
    if (call.method in transport) return (transport[call.method as keyof typeof transport] as Function)(call.input, call.signal);
    throw new Error(call.method);
  } }); cleanup.push(() => host.harness.lifecycle.dispose());
  const db = new Sqlite(":memory:"); db.exec(MIGRATIONS.join(";\n")); cleanup.push(() => { db.close(); });
  const store = new PlacementStore(db as never), port = createHostPort(host.bb), transport = new PlacementTransport(host.bb, port, store);
  const endpoint = (name: string) => ({ hostId: name, environmentId: name, root: name === "home" ? home : source });
  writeFileSync(join(home, "work.txt"), "user staged"); git(home, "add", "work.txt"); writeFileSync(join(home, "work.txt"), "user unstaged");
  const userBefore = { head: git(home, "rev-parse", "HEAD"), refs: git(home, "show-ref"), objects: git(home, "count-objects", "-v"), index: readFileSync(join(home, ".git/index")) };
  const snapshot = store.captureSnapshot({ purpose: "initial", keeperThreadId: "keeper", projectId: "project", sourceThreadId: "keeper", makerThreadId: null, makerSubmissionId: null, journalTarget: null, objectFormat: "sha1", base, sourceHead: base, tree: git(home, "rev-parse", "HEAD^{tree}"), source: endpoint("home"), home: { ...endpoint("home"), root: importRoot }, fetch: { via: "remote-head", remoteName: "origin", remoteUrl: network.url, trackingRef: "refs/remotes/origin/main", fetchRef: "refs/heads/main" } });
  store.reserve(placementRecord({ memberThreadId: "member", phase: "reserved", hostId: "member", environmentId: "member", root: source, memberBranch: "member-work", sourceSnapshotId: snapshot.id, pullRequests: { at: "home", profile: "forge" } }), { maxMakers: 2, maxCheckers: 2 });
  store.update("placement", 1, value => ({ ...value, phase: "running" }));
  const keepers = new KeeperStore(db as never);
  putMemberFixture(keepers, "member", { threadId: "member", classId: "smith", keeperThreadId: "keeper", boardQuestId: "quest" } as never);
  keepers.patch("member", { projectId: "project" });
  const member = () => keepers.get("members", "member")!;
  const profile = { id: "forge", name: "Forge", enabled: true, kind: "command", open: `test "$GIT_OPTIONAL_LOCKS" = 0 && git status --porcelain >/dev/null && test "$(git rev-parse --show-toplevel)" = ${JSON.stringify(home)} && test "$(git remote get-url origin)" = ${JSON.stringify(network.url)} && test "$FORGE_HEAD" = member-work && test "$LOOM_DRAFT" = 1 && test "$(cat)" = description && echo https://forge.example/pr/12` };
  const runtime = { scopes: { api: { hostTemplate: () => ({ template: { github: "draft-pr-only", preset: "worktree" } }) } }, bb: host.bb, placements: () => ({ store, host: port, transport }), settings: { placementPolicy: () => ({ state: "valid", settings: { forges: [profile] } }) }, keeper: { member, now: () => 1, changed: vi.fn(), store: keepers } } as unknown as TavernRuntime;
  const forge = new PlacementForge(runtime);
  const afterRefresh = emulate && (pushedOnly || baseOverride !== undefined);
  const keeper = new Keeper(keepers, fakePort(), () => 2);
  const cutover = () => {
    keeper.bind("keeper", "keeper", null, "project");
    putQuestFixture(keepers, "quest", boardQuestSchema.parse({ id: "quest", keeperThreadId: "keeper", title: "Draft", short: "Draft", phase: "scout", planVersion: 0, greenlitVersion: null, createdAt: 1, updatedAt: 1, endedAt: null }));
    const op = keeper.succession.propose("keeper", { kind: "user" }, "New context");
    keeper.succession.prepare(op.id, []);
    keeper.succession.bindCandidate(op.id, "successor");
    keeper.succession.cutover(op.id, ownershipSteps(keeper));
  };
  if (afterRefresh && pushedOnly) cutover();
  const result = await forge.forThread("member", { title: "Draft", body: "description", base: baseOverride });
  expect(result).toContain("Draft PR: https://forge.example/pr/12"); expect(result).toContain("untracked.txt"); expect(result).toContain("work.txt");
  expect(host.harness.inspection.experimental_hostRpcCalls).toContainEqual(expect.objectContaining({
    method: "registerEndpoint", input: expect.objectContaining({ endpointId: "draft-forge", git: "full" }),
  }));
  expect(member().draftPush!.memberHead).toBe(memberHead);
  if (afterRefresh && !pushedOnly) cutover();
  expect(keepers.all("pullRequests")[0]?.keeperThreadId).toBe(afterRefresh ? "successor" : "keeper");
  if (pushedOnly) {
    expect(git(home, "rev-parse", "HEAD")).toBe(userBefore.head); expect(git(home, "show-ref")).toBe(userBefore.refs);
    expect(git(home, "count-objects", "-v")).toBe(userBefore.objects); expect(readFileSync(join(home, ".git/index"))).toEqual(userBefore.index);
    expect(readFileSync(join(home, "work.txt"), "utf8")).toBe("user unstaged");
  }
  if (!baseOverride) {
    store.update("placement", 1, value => ({ ...value, pullRequests: { at: "member" } }));
    expect(await forge.forThread("member", { title: "Recorded", url: "https://forge.example/pr/12" })).toContain("Draft PR: https://forge.example/pr/12");
    expect(keepers.all("pullRequests")[0]?.base).toBe("main");
    store.update("placement", 1, value => ({ ...value, pullRequests: { at: "home", profile: "forge" } }));
  }
  const pushed = git(remote, "rev-parse", "refs/heads/member-work"); expect(member().draftPush!.homeHead).toBe(pushed);
  expect(git(remote, "show", "member-work:work.txt")).toBe("committed");
  expect(git(remote, "rev-parse", "member-work^")).toBe(base);
  expect(git(remote, "show", "-s", "--format=%B", "member-work")).toBe("Member subject\n\nMember body");
  expect(git(remote, "show", "-s", "--format=%an", "member-work")).toBe("Maker");
  expect(keepers.roomEvents().some(event => event.type === "member.draft-pr-opened" && event.data.memberHead === memberHead && event.data.homeHead === pushed)).toBe(true);
  expect(await forge.forThread("member", { title: "Draft", body: "description", base: "other" })).toBe(`This branch's draft targets ${baseOverride ?? "main"}; moving it comes later`);
  profile.open = profile.open.replace("/pr/12", "/pr/13");
  git(source, "add", "work.txt"); git(source, "commit", "-qm", "next");
  expect(await forge.forThread("member", { title: "Draft", body: "description", base: baseOverride })).toContain("https://forge.example/pr/13");
  expect(keepers.all("pullRequests")).toHaveLength(1);
  expect(keepers.all("pullRequests")[0]).toMatchObject({ url: "https://forge.example/pr/13", keeperThreadId: afterRefresh ? "successor" : "keeper" });
  if (afterRefresh) {
    const comment = vi.fn(async () => ({ state: "draft" as const }));
    const successorRuntime = { keeper, away: { assertWork: () => {}, store: { snapshot: () => ({ window: null }) } },
      placements: () => ({ forge: { inspect: async () => null, comment } }) } as unknown as TavernRuntime;
    await expect(managePullRequest(successorRuntime, "successor", { action: "comment", pullRequestId: keepers.all("pullRequests")[0]!.id, body: "Local fixture reply" })).resolves.toMatchObject({ keeperThreadId: "successor" });
    expect(comment).toHaveBeenCalledTimes(1);
  }
  expect(calls.filter(name => name === "draftPush")).toHaveLength(2);
  const beforeDefaultRefusal = git(remote, "rev-parse", "refs/heads/member-work");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/member-work");
  expect(await forge.forThread("member", { title: "Draft", body: "description", base: baseOverride })).toContain("Tavern could not open the draft: Tavern never pushes to the base branch");
  expect(git(remote, "rev-parse", "refs/heads/member-work")).toBe(beforeDefaultRefusal);
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  corruptTree = true;
  expect(await forge.forThread("member", { title: "Draft", body: "description", base: baseOverride })).toContain("Tavern could not open the draft: Broken contract");
  corruptTree = false;
  git(remote, "update-ref", "refs/heads/member-work", base);
  expect(await forge.forThread("member", { title: "Draft", body: "description", base: baseOverride })).toContain("lasting");
  expect(git(remote, "rev-parse", "refs/heads/member-work")).toBe(base);
  expect(store.byMember("member")?.phase).toBe("running");
  const pushCount = calls.filter(name => name === "draftPush").length;
  store.update("placement", 1, value => ({ ...value, memberBranch: "main" }));
  git(source, "checkout", "-B", "main");
  expect(await forge.forThread("member", { title: "Draft", body: "description", base: "release" })).toContain("Tavern never pushes to the base branch");
  expect(calls.filter(name => name === "draftPush")).toHaveLength(pushCount);
}, 180_000);
it.each(["none", "read"])("refuses draft creation under GitHub scope %s", async github => {
  const runtime = { placements: () => ({ store: { byMember: () => ({ pullRequests: { at: "home", profile: "forge" } }) } }), scopes: { api: { hostTemplate: () => ({ template: { github, preset: "worktree" } }) } }, keeper: { member: () => ({ classId: "smith" }) } } as unknown as TavernRuntime;
  expect(await new PlacementForge(runtime).forThread("member", { title: "Draft", body: "" })).toBe(`Your worktree scope has GitHub access ${github}; it does not allow opening draft pull requests.`);
});
it.each(["warden", "smith"])("refuses %s when drafts do not open from home", async classId => {
  const runtime = { placements: () => ({ store: { byMember: () => ({ pullRequests: { at: "member" } }) } }), keeper: { member: () => ({ classId }) } } as unknown as TavernRuntime;
  const result = await new PlacementForge(runtime).forThread("member", { title: "Draft", body: "" });
  expect(result).toBe(classId === "smith" ? "Your pull requests open on your own machine; open a draft with your own tools as your scope allows, then call tavern_draft_pr with its URL, title and base to record it." : MEMBER_PR_REFUSAL);
});
