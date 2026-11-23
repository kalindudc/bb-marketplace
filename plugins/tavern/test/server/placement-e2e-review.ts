import { withMemberFixtures } from "./member-fixture";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeHostResponse, makeThreadResponse, makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { execFileSync } from "node:child_process";
import { realGit } from "../host/emulated-git";
import { gitFixtureTemplate } from "../git-fixture-template";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { createTavernHostEntry } from "../../src/host/entry";
import type { HostMethod } from "../../src/host-contract";
import { registerJournal } from "../../src/server/journal";
import { Keeper } from "../../src/server/keeper/service";
import { KeeperStore } from "../../src/server/keeper/store";
import { MIGRATIONS } from "../../src/server/migrations";
import { TavernRuntime } from "../../src/server/runtime";
import { Registry } from "../../src/server/registry";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights";
import { registerReady } from "../../src/server/tools/ready";
import { placementRuleSchema } from "../../src/shared/placement-settings";
import { planInput, seedQuest } from "./support";
import { providerSdk } from "./provider-fixture";
import { worktreeProvider } from "./environment-fixture";

export const reviewGit = (root: string, ...args: string[]) => execFileSync(realGit, ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
const seedRepos = gitFixtureTemplate(root => {
  const home = join(root, "source"), upstream = join(root, "upstream"); mkdirSync(home);
  reviewGit(home, "init", "-qb", "main"); reviewGit(home, "config", "user.name", "Fixture"); reviewGit(home, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(home, "tracked"), "base\n"); writeFileSync(join(home, ".gitignore"), "ignored\n"); reviewGit(home, "add", "-A"); reviewGit(home, "commit", "-qm", "base");
  const base = reviewGit(home, "rev-parse", "HEAD"); reviewGit(home, "clone", "-q", "--bare", home, upstream);
  reviewGit(home, "remote", "add", "origin", upstream); reviewGit(home, "update-ref", "refs/remotes/origin/main", base); reviewGit(home, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"); reviewGit(home, "branch", "--set-upstream-to=origin/main");
  writeFileSync(join(home, "tracked"), "initial unpushed\n"); reviewGit(home, "commit", "-qam", "initial unpushed");
  return base;
});
export async function reviewFixture(checkerCount = 1) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "placement-review-"))), home = join(root, "source"), upstream = join(root, "upstream");
  const base = seedRepos(root);
  reviewGit(home, "remote", "set-url", "origin", upstream);
  const environments = new Map<string, Environment>(), threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const natives = new Map<string, ReturnType<typeof experimental_createHostEntryHarness>>(), dataDirs = new Map<string, string>(), storage = new Map<string, string>(), trace: string[] = [];
  const artifactPath = join(root, "host.mjs"); writeFileSync(artifactPath, "export function tavernGuard() {}\n");
  const native = (id: string) => {
    const data = join(root, id + "-native"), userHome = join(root, id + "-home"), scratch = join(root, id + "-tmp");
    for (const path of [data, userHome, scratch]) mkdirSync(path);
    dataDirs.set(id, data);
    const entry = createTavernHostEntry({ artifactPath, paths: { home: userHome, tmp: [scratch], piAgentDir: join(userHome, "pi") } });
    natives.set(id, experimental_createHostEntryHarness(entry, { experimental_paths: { dataDir: data, tempDir: scratch } }));
  };
  native("home");
  const environment = (id: string, hostId: string, path: string, branchName: string): Environment => ({ id, projectId: "project", hostId, path, branchName,
    status: "ready", hostLifecycle: "active", lifecycle: { phase: "active", retireAt: null, teardown: null }, isGitRepo: true, isWorktree: false,
    environmentProviderId: "checkout", environmentProviderInstanceKey: null, environmentProviderSelection: null, baseBranch: null, defaultBranch: null, mergeBaseBranch: null,
    name: id, managed: false, workspaceProvisionType: "unmanaged", createdAt: 1, updatedAt: 1 });
  environments.set("home-env", environment("home-env", "home", home, "main"));
  threads.set("keeper", makeThreadResponse({ id: "keeper", projectId: "project", environmentId: "home-env", providerId: "pi", status: "idle" }));
  let intercept: ((method: HostMethod) => void | Promise<void>) | undefined;
  const stop = vi.fn(async () => ({ ok: true as const }));
  const archive = vi.fn(async ({ threadId }: { threadId: string }) => { trace.push("archive:" + threadId); threads.set(threadId, { ...threads.get(threadId)!, archivedAt: 123 }); return { ok: true as const }; });
  const host = createFakePluginHost({ pluginId: "tavern", experimental_hostEntry: true, sdk: {
    system: { config: async () => ({ primaryHostId: "home" }) },
    projects: { get: async () => ({ id: "project", name: "Project", kind: "standard", createdAt: 1, updatedAt: 1, gitRemoteUrl: "https://example.invalid/repo.git", sources: [] }) },
    providers: providerSdk(),
    threads: { get: async ({ threadId }) => structuredClone(threads.get(threadId)!), defaultExecutionOptions: async () => null,
      storageLocation: async ({ threadId }) => ({ hostId: threadId === "keeper" ? "home" : threadId, storageRootPath: storage.get(threadId)! }),
      getPluginMetadata: async () => ({}), updatePluginMetadata: async () => ({}), events: { list: async () => [] },
      queuedMessages: { list: async () => [], delete: async () => ({ ok: true as const }) }, stop, archive,
    },
    plugins: { list: async () => ({ plugins: [] }) },
    environments: { get: async ({ environmentId }) => structuredClone(environments.get(environmentId)!), listProviders: async () => [worktreeProvider({ id: "isolated-checkout", displayName: "Isolated checkout", availability: null,
      inputs: { type: "object", properties: { base: { type: "string" }, branch: { type: "string" } }, required: ["base", "branch"] }, acceptsEmptyInputs: false })] },
    hosts: { get: async ({ hostId }) => makeHostResponse({ id: hostId, name: hostId, status: "connected" }),
      experimental_listProviders: async () => [{ id: "isolated-compute", displayName: "Isolated compute", description: "Fixture", icon: "Server", logoUrl: null, pluginId: "fixture", inputs: null, acceptsEmptyInputs: true, supportsSuspend: false }] },
  }, experimental_callHostRpc: async ({ hostId, method, input, signal }) => {
    trace.push(hostId + ":" + method);
    const result = await natives.get(hostId!)!.experimental_call(method as HostMethod, input as never, { signal });
    await intercept?.(method as HostMethod); return result;
  } });
  const db = host.bb.storage.database(); db.exec(MIGRATIONS.join(";\n")); const keepers = new KeeperStore(db);
  let keeper: Keeper;
  const journal = registerJournal(host.bb, db, { roleOf: id => { const member = keepers.get("members", id); return member ? { ...member, ...(member.classId === "warden" ? { checkerWaypointIds: keeper.checkerWaypoints(id) } : {}) } : null; }, invalidate: () => {} });
  keeper = withMemberFixtures(new Keeper(keepers, journal, () => 1_000_000));
  keeper.bind("keeper", "keeper", "wren", "project");
  const runtime = new TavernRuntime(host.bb, keeper, new Registry(fileURLToPath(new URL("../../", import.meta.url)), "/nonexistent"));
  const settings = new SettingsStore(db); runtime.enableSettings(settings, new InsightsReader(db, settings));
  const rule = (classId: "smith" | "warden") => placementRuleSchema.parse({ id: classId + "-rule", label: classId + " machines", enabled: true, match: { projectIds: ["project"], classes: [classId] },
    target: { kind: "provider", environmentProviderId: "isolated-checkout", inputs: { base: "{source.base}", branch: "{member.branch}" }, machine: { type: "new", machineProviderId: "isolated-compute" }, workspace: "dedicated-machine" },
    consent: { guardInstall: true, remoteDetectionOnly: true, linuxUncontainedChecks: true } });
  const rules = [rule("smith"), rule("warden")]; settings.update({ revision: 0, patch: { machines: { rules } }, why: "Separate machines" });
  const quest = await seedQuest(keeper, "keeper", "Implement", "IMP");
  keeper.plan("keeper", { ...planInput(quest.id), waypoints: [{ ...planInput(quest.id).waypoints[0], doneWhen: "Run `node --test check.test.cjs`" }], party: [
    { classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] },
    ...Array.from({ length: checkerCount }, () => ({ classId: "warden", characterId: null, model: null, purpose: "Check", waypointIds: ["w1"] })),
  ] });
  keeper.answerAsk(keeper.asks("keeper").find(ask => ask.kind === "greenlight" && ask.state === "open")!.id, "approve", null, "page", "user");
  runtime.enableScopes({ dataDir: join(root, "controller-scopes"), installGuard: false }); registerReady(host.bb, runtime);
  const spawn = vi.fn(async (args: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]) => {
    const classId = (args.pluginMetadata as { classId: string }).classId, checkers = [...threads.keys()].filter(id => id.startsWith("checker")).length;
    const id = classId === "smith" ? "maker" : checkers ? `checker-${checkers + 1}` : "checker";
    trace.push("spawn:" + id);
    const selection = args.environment; if (selection?.type !== "provider") throw new Error("Expected provider selection");
    const path = join(root, id), branch = (selection.inputs as { branch: string }).branch;
    reviewGit(home, "clone", "-q", upstream, path); reviewGit(path, "checkout", "-qb", branch, (selection.inputs as { base: string }).base);
    native(id); const store = join(root, id + "-storage"); mkdirSync(store); storage.set(id, store);
    environments.set(id + "-env", environment(id + "-env", id, path, branch));
    const thread = makeThreadResponse({ id, projectId: "project", parentThreadId: "keeper", environmentId: null, providerId: args.providerId, status: "pending" }); threads.set(id, thread);
    expect(await runtime.dispatch(makeMessageDispatchHookContext({ thread, project: { id: "project" }, originPluginId: "tavern", attempt: "start-turn", initiator: "agent",
      experimental_submission: { pluginId: "tavern", data: { hireToken: (args.pluginMetadata as { hireToken: string }).hireToken } },
      requestedExecution: { providerId: args.providerId, model: args.model ?? null, permissionMode: args.permissionMode ?? null } }))).toEqual({ action: "proceed" });
    threads.set(id, { ...thread, environmentId: id + "-env", status: "active" }); return thread;
  }); host.harness.sdk.stub("threads.spawn", spawn);
  const hire = (classId: "smith" | "warden") => runtime.hire("keeper", "project", { classId, boardQuestId: quest.id, waypointId: "w1", title: classId === "smith" ? "Build" : "Check",
    brief: { outcome: "A tested change", mode: "make-it-work", doneWhen: "Tests pass", outOfScope: "No publication", context: [], questions: [], timeboxMinutes: null } });
  const tool = (threadId: string, name: string, params: unknown) => host.harness.behavior.callAgentTool(name, params, { threadId, projectId: "project" });
  const make = async () => {
    await hire("smith"); expect(await tool("maker", "tavern_ready", {})).toContain("Ready.");
    const path = environments.get("maker-env")!.path!;
    writeFileSync(join(path, "tracked"), "submitted\n"); writeFileSync(join(path, "untracked"), "submitted new file\n");
    writeFileSync(join(path, "check.test.cjs"), "const {test}=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs'); test('submitted tree',()=>assert.equal(fs.readFileSync('tracked','utf8'),'submitted\\n'));\n");
    const entry = journal.get("maker").entries.find(entry => entry.link?.waypointId === "w1")!;
    writeFileSync(join(storage.get("maker")!, "report.txt"), "declared report\n");
    expect(await tool("maker", "journal", { action: "done", id: entry.id, evidence: [
      { kind: "command", ref: "node --test check.test.cjs", detail: "Maker check", exitCode: 0 },
      { kind: "file", ref: join(storage.get("maker")!, "report.txt"), detail: "Declared report", exitCode: null },
    ] })).not.toMatchObject({ isError: true });
    threads.set("maker", { ...threads.get("maker")!, status: "idle" }); return entry.id;
  };
  const check = async () => { const member = await hire("warden"); const result = await tool(member.threadId, "tavern_ready", {}); expect(result).toContain("Ready."); return member; };
  const close = async () => { await host.harness.lifecycle.dispose(); await Promise.all([...natives.values()].map(native => native.experimental_dispose())); rmSync(root, { recursive: true, force: true }); };
  return { ...host, root, home, base, environments, threads, natives, dataDirs, storage, trace, stop, archive, spawn, keeper, journal, runtime, settings, quest, rules, hire, tool, make, check, close,
    intercept: (fn: typeof intercept) => { intercept = fn; } };
}

export async function proveCarryStage() {
  const f = await reviewFixture();
  try {
    await f.make(); const before = readFileSync(join(f.home, ".git/index")), head = reviewGit(f.home, "rev-parse", "HEAD");
    await f.check(); const review = f.runtime.placements().store.byMember("checker")!.reviewTarget!, snapshot = f.runtime.placements().store.snapshot(review.snapshotId)!;
    expect(reviewGit(f.home, "rev-parse", snapshot.homeRef + "^{tree}")).toBe(snapshot.tree);
    expect(reviewGit(f.environments.get("checker-env")!.path!, "rev-parse", "HEAD^{tree}")).toBe(snapshot.tree);
    expect(readFileSync(join(f.home, ".git/index"))).toEqual(before); expect(reviewGit(f.home, "rev-parse", "HEAD")).toBe(head);
    expect(f.stop).not.toHaveBeenCalled();
  } finally { await f.close(); }
}
export async function proveWardenStage() {
  const f = await reviewFixture();
  try {
    await f.make(); await f.check(); const placements = f.runtime.placements().store, maker = placements.byMember("maker")!, checker = placements.byMember("checker")!;
    expect(checker).toMatchObject({ slot: "checker", rule: { id: "warden-rule" }, hostId: "checker", phase: "ready", posture: { aggregate: "remote-detection-only", checker: "detection-only-no-containment" } });
    expect(checker.hostId).not.toBe(maker.hostId); expect(placements.counts("keeper")).toEqual({ makers: 1, checkers: 1 });
    const delivery = f.runtime.placements().deliveries.get(checker.id)!;
    const rendered = JSON.parse(readFileSync(delivery.acknowledged!.scopeFile, "utf8")); expect(rendered.checks.worktree).toBe(checker.root);
    expect(rendered.checks.worktree).not.toBe(maker.root);
    const brief = f.spawn.mock.calls[1][0].input![0] as { text: string }; expect(brief.text).toContain(checker.reviewTarget!.expectedTree); expect(brief.text).toContain("own checkout"); expect(brief.text).not.toContain("exact maker worktree"); expect(brief.text).toContain("posture is shown once the machine is ready");
  } finally { await f.close(); }
}
async function runReviewCheck(f: Awaited<ReturnType<typeof reviewFixture>>) {
  const record = f.runtime.placements().store.byMember("checker")!, delivery = f.runtime.placements().deliveries.get(record.id)!;
  const checked = await f.runtime.placements().host.call(record.hostId!, "prepareCall", { placementId: record.id, generation: record.generation,
    endpointId: "carry-member", operationId: "project-check", scopeRevision: delivery.binding.revision,
    call: { kind: "bash", toolName: "bash", input: { command: "node --test check.test.cjs" }, cwd: record.root! } });
  expect(checked.decision.allow).toBe(true);
  const output = execFileSync(process.execPath, ["--test", "--test-reporter=tap", "check.test.cjs"], { cwd: record.root!, encoding: "utf8" });
  expect(output).toContain("# fail 0"); return output;
}
export async function proveCheckStage() {
  const f = await reviewFixture();
  try {
    const id = await f.make(); await f.check(); const output = await runReviewCheck(f);
    const plan = f.keeper.summary(f.quest.id).plan!, nextVersion = plan.version + 1;
    f.keeper.store.put("plans", `${f.quest.id}:${nextVersion}`, { ...plan, version: nextVersion,
      waypoints: [...plan.waypoints, { ...plan.waypoints[0], id: "unrelated", title: "Unrelated plan edit", optional: true }] });
    f.keeper.store.put("quests", f.quest.id, { ...f.keeper.quest(f.quest.id), planVersion: nextVersion });
    const result = await f.tool("checker", "journal", { action: "verify", threadId: "maker", id, evidence: [{ kind: "command", ref: "node --test check.test.cjs", detail: output, exitCode: 0 }] });
    expect(result).not.toMatchObject({ isError: true }); expect(f.journal.get("maker").entries.find(entry => entry.id === id)!.status).toBe("verified");
  } finally { await f.close(); }
}
export async function proveCompleteChain() {
  const f = await reviewFixture();
  try {
    const id = await f.make(); await f.check(); const output = await runReviewCheck(f);
    expect(await f.tool("checker", "journal", { action: "verify", threadId: "maker", id, evidence: [{ kind: "command", ref: "node --test check.test.cjs", detail: output, exitCode: 0 }] })).not.toMatchObject({ isError: true });
    f.threads.set("checker", { ...f.threads.get("checker")!, status: "idle" });
    expect(f.stop).not.toHaveBeenCalled();
    expect(await f.runtime.stop(f.quest.id, "Complete chain stop")).toMatchObject({ phase: "stopped" });
    for (const id of ["maker", "checker"]) expect(f.runtime.placements().store.byMember(id)).toMatchObject({ phase: "released", preservation: { source: "saved", stopConfirmed: true } });
    expect(f.runtime.placements().store.byMember("maker")!.preservation.artifacts).toBe("saved"); expect(f.archive).toHaveBeenCalledTimes(2);
    const maker = f.runtime.placements().store.byMember("maker")!, manifest = f.runtime.placements().preserve.manifest(maker.preservation.artifactManifestId!)!;
    const report = manifest.files.find(file => file.relativePath === "report.txt")!, saved = manifest.saved.find(receipt => receipt.artifactId === report.id)!;
    expect(readFileSync(join(f.dataDirs.get("home")!, saved.storageKey), "utf8")).toBe("declared report\n");
    expect(f.trace.indexOf("archive:maker")).toBeGreaterThan(f.trace.lastIndexOf("home:finishArtifact")); expect(f.stop).toHaveBeenCalledTimes(2);
  } finally { await f.close(); }
}
