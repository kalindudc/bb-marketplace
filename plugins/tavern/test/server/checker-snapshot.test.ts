// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as gitRunner from "../../src/host/git";
import { createJournalStore } from "../../src/server/journal/store";
import { KEEPER_SUBJECT_OWNER } from "../../src/shared/waypoint";
import { evaluate } from "../../src/scope/engine";
import { scopeForClass } from "../../src/scope/presets";
import { sandboxCommand } from "../../src/scope/sandbox";
import { linkedWorktree } from "../scope/git-fixture";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";
import { planInput, seedQuest } from "./support";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const command = "node --test --test-reporter=tap check.cjs";

function fixture(kind: "primary" | "linked" | "not-git" = "primary", hostId = "host", withJournal = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tavern-checker-snapshot-")));
  roots.push(root);
  const { main, worktree, git } = linkedWorktree(root);
  const source = kind === "linked" ? worktree : kind === "primary" ? main : join(root, "ordinary-folder");
  if (kind === "not-git") mkdirSync(source);
  const f = setup({ environments: { get: async () => ({ id: "env", hostId, path: source, isGitRepo: kind !== "not-git", isWorktree: kind === "linked" }) } });
  f.bb.sdk.threads.get = async ({ threadId }) => makeThreadResponse({ id: threadId, environmentId: "env", providerId: "pi", status: "idle" });
  f.bb.sdk.threads.getPluginMetadata = async () => ({});
  f.bb.sdk.threads.storageLocation = async () => ({ hostId, storageRootPath: root });
  f.bb.sdk.threads.stop = async () => ({ ok: true });
  const journal = withJournal ? createJournalStore(f.bb, f.k.store.db, {
    roleOf: threadId => f.runtime.journalRole(threadId), invalidate: () => {},
  }) : undefined;
  if (journal) Object.assign(f.k, { journal });
  f.runtime.enableScopes({ dataDir: root, installGuard: false, policyOptions: { home: root } });
  const scopes = f.runtime.scopes!;
  const bind = (token = randomUUID()) => scopes.checkerChecks("maker-env", [command], token);
  return { ...f, scopes, root, main, source, git, bind, journal };
}

function dirty({ main, git }: ReturnType<typeof fixture>) {
  for (const [path, text] of Object.entries({ tracked: "base\n", removed: "base\n", ".gitignore": "ignored\n" })) writeFileSync(join(main, path), text);
  git(main, "add", "-A"); git(main, "commit", "-qm", "base files");
  writeFileSync(join(main, "tracked"), "stashed\n"); git(main, "stash", "push", "-qm", "keep me");
  writeFileSync(join(main, "tracked"), "staged\n"); git(main, "add", "tracked");
  writeFileSync(join(main, "tracked"), "working tree\n");
  writeFileSync(join(main, "new"), "not yet tracked\n");
  writeFileSync(join(main, "ignored"), "leave this here\n");
  writeFileSync(join(main, "check.cjs"), "require('node:assert/strict').equal(require('node:fs').readFileSync('tracked', 'utf8'), 'working tree\\n');\n");
  rmSync(join(main, "removed"));
}

function identity({ main, git }: ReturnType<typeof fixture>) {
  const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  const files = (dir: string): unknown[] => readdirSync(dir).sort().filter(name => name !== ".git").map(name => {
    const path = join(dir, name), stat = lstatSync(path);
    return [name, stat.mode, stat.isDirectory() ? files(path) : stat.isSymbolicLink() ? readlinkSync(path) : hash(readFileSync(path))];
  });
  return {
    head: git(main, "rev-parse", "HEAD").trim(),
    symbolicHead: hash(readFileSync(join(main, ".git", "HEAD"))),
    index: hash(readFileSync(join(main, ".git", "index"))),
    branches: hash(git(main, "for-each-ref", "refs/heads")),
    stash: hash(git(main, "stash", "list", "--format=%H %gs")),
    workingTree: hash(JSON.stringify(files(main))),
  };
}

it("runs a check in a detached snapshot without changing a dirty primary checkout", async () => {
  const f = fixture(); dirty(f);
  const before = identity(f), token = randomUUID(), worktrees = f.git(f.main, "worktree", "list", "--porcelain");
  const { checks, problems, snapshot } = await f.bind(token);
  expect(problems).toEqual([]);
  const root = checks.worktree!;
  expect(root.startsWith(f.root + "/checker-snapshots/")).toBe(true);
  expect(checks.sourceWorktree).toBe(f.main);
  expect(f.git(root, "rev-parse", "HEAD").trim()).toBe(snapshot!.commit);
  expect(f.git(root, "rev-parse", "HEAD^").trim()).toBe(before.head);
  expect(f.git(root, "branch", "--show-current")).toBe("");
  expect(readFileSync(join(root, "tracked"), "utf8")).toBe("working tree\n");
  expect(readFileSync(join(root, "new"), "utf8")).toBe("not yet tracked\n");
  expect(existsSync(join(root, "ignored"))).toBe(false);
  expect(existsSync(join(root, "removed"))).toBe(false);
  const scope = { ...scopeForClass("warden"), checks };
  expect(evaluate(scope, { kind: "bash", toolName: "bash", input: { command }, cwd: root })).toMatchObject({ allow: true, check: true });
  expect(evaluate(scope, { kind: "bash", toolName: "bash", input: { command }, cwd: f.main })).toMatchObject({ allow: false });
  expect(evaluate(scope, { kind: "write", toolName: "write", input: { path: join(f.main, "tracked") }, cwd: root })).toMatchObject({ allow: false, ruleId: "checker-write" });
  expect(execFileSync("/bin/bash", ["-c", sandboxCommand(scope, command, true)], { cwd: root, encoding: "utf8" })).toContain("# fail 0");
  if (process.platform === "darwin") {
    const write = `printf overwrite > '${join(f.main, "tracked")}'`;
    for (const checking of [false, true]) expect(() => execFileSync("/bin/bash", ["-c", sandboxCommand(scope, write, checking)], { cwd: root, stdio: "pipe" })).toThrow();
  }
  expect(identity(f)).toEqual(before);
  await f.scopes.checkerSnapshots.remove(token);
  expect(existsSync(root)).toBe(false);
  expect(f.git(f.main, "worktree", "list", "--porcelain")).toBe(worktrees);
  const after = identity(f);
  expect(after).toEqual(before);
  if (process.env.TAVERN_MEASURE_CHECKER_IDENTITY === "1")
    process.stdout.write(`FIXTURE_BEFORE=${JSON.stringify(before)}\nFIXTURE_AFTER=${JSON.stringify(after)}\n`);
});

it("pins a fresh tree after edits without changing the earlier snapshot and sweeps orphaned worktrees", async () => {
  const f = fixture(); dirty(f);
  const first = await f.bind();
  writeFileSync(join(f.main, "tracked"), "next submission\n");
  const second = await f.bind();
  expect(first.snapshot!.commit).not.toBe(second.snapshot!.commit);
  expect(readFileSync(join(first.checks.worktree!, "tracked"), "utf8")).toBe("working tree\n");
  expect(readFileSync(join(second.checks.worktree!, "tracked"), "utf8")).toBe("next submission\n");
  await f.runtime.reconcile();
  expect(existsSync(first.checks.worktree!)).toBe(false);
  expect(existsSync(second.checks.worktree!)).toBe(false);
});

it("protects snapshots from Keeper writes and only lets the owning checker shell write ignored outputs", async () => {
  const f = fixture(); dirty(f);
  const { snapshot, checks } = await f.bind();
  const other = await f.bind();
  const worktree = checks.worktree!, target = join(worktree, "tracked"), ignored = join(worktree, "ignored");
  const keeper = await f.scopes.api.writeScope("lead", scopeForClass("keeper"));
  const warden = await f.scopes.api.writeScope("warden", { ...scopeForClass("warden"), checks });
  const write = `printf tampered > '${target}'`;
  expect.soft(evaluate(keeper, { kind: "write", toolName: "write", input: { path: target }, cwd: f.main }))
    .toMatchObject({ allow: false, ruleId: "tavern-control-files" });
  expect.soft(evaluate(keeper, { kind: "bash", toolName: "bash", input: { command: write }, cwd: f.main }))
    .toMatchObject({ allow: false, ruleId: "tavern-control-files" });
  if (process.platform === "darwin") {
    const shell = (scope: typeof keeper, command: string, checking = false) => execFileSync("/bin/bash", ["-c", sandboxCommand(scope, command, checking)], { cwd: worktree, stdio: "pipe" });
    expect.soft(() => shell(keeper, write)).toThrow();
    expect.soft(() => shell(warden, `printf output > '${ignored}'`)).toThrow();
    expect.soft(() => shell(warden, write, true)).toThrow();
    expect.soft(() => shell(warden, `printf output > '${join(other.checks.worktree!, "ignored")}'`, true)).toThrow();
    shell(warden, `printf output > '${ignored}'`, true);
    expect(readFileSync(ignored, "utf8")).toBe("output");
    expect(readFileSync(target, "utf8")).toBe("working tree\n");
  }
  await f.scopes.checkerSnapshots.remove(snapshot!.id);
  await f.scopes.checkerSnapshots.remove(other.snapshot!.id);
});

it("closes checks if the checkout changes after Git writes the snapshot tree", async () => {
  const f = fixture(); dirty(f);
  const git = gitRunner.git;
  const spy = vi.spyOn(gitRunner, "git").mockImplementation(async (root, args, options) => {
    const value = await git(root, args, options);
    if (root === f.main && args.at(-1) === "write-tree") writeFileSync(join(f.main, "tracked"), "changed during capture\n");
    return value;
  });
  try {
    const result = await f.bind();
    expect(result.checks.worktree).toBeUndefined();
    expect(result.problems.join("\n")).toContain("checkout changed during the snapshot");
    expect(readdirSync(join(f.root, "checker-snapshots"))).toEqual([]);
  } finally { spy.mockRestore(); }
});

it("leaves a linked maker worktree bound directly", async () => {
  const f = fixture("linked");
  const result = await f.bind();
  expect(result).toEqual({ checks: { worktree: f.source, commands: [command] }, problems: [] });
});

it.each([["not-git", "host"], ["primary", "other-host"]] as const)("closes checks for %s on %s", async (kind, host) => {
  const f = fixture(kind, host);
  expect(await f.bind()).toMatchObject({ checks: { commands: [command] }, problems: [expect.stringContaining("checks are closed, ordinary reads remain available")] });
  expect(existsSync(join(f.root, "checker-snapshots"))).toBe(false);
});

async function hireChecker(waypointIds = ["w1"], preSubmitted = waypointIds) {
  const f = fixture("primary", "host", true); dirty(f);
  const journal = f.journal!, q = await seedQuest(f.k, "lead", "Check the proposed change", "CHK");
  const plan = planInput(q.id);
  await f.runtime.plan("lead", { ...plan, waypoints: waypointIds.map(id => ({ ...plan.waypoints[0]!, id, title: `Check ${id}`, owner: KEEPER_SUBJECT_OWNER, check: "warden", doneWhen: "Run `" + command + "`" })), party: [
    { classId: "warden", characterId: null, model: null, purpose: "Check the work", waypointIds },
  ] });
  f.k.answerAsk(f.k.asks("lead").find(ask => ask.kind === "greenlight" && ask.state === "open")!.id, "approve", null, "page", "user");
  await journal.prepare("lead");
  const entries = new Map(waypointIds.map(waypointId => [waypointId, journal.linkWaypoint("lead", { boardQuestId: q.id, waypointId }, `Check ${waypointId}`, "lead", { kind: "tavern" })]));
  const entryId = entries.get("w1")!;
  const submit = (detail: string, waypointId = "w1") => journal.runTool("lead", { action: "done", id: entries.get(waypointId)!, evidence: [{ kind: "file", ref: "tracked", detail, exitCode: null }] });
  for (const waypointId of preSubmitted) expect(await submit("First submission", waypointId)).not.toMatchObject({ isError: true });
  const warden = await f.runtime.hire("lead", "project", { classId: "warden", boardQuestId: q.id, waypointId: "w1", title: "Check", brief: {
    outcome: "Check the proposed change", mode: "make-it-work", outOfScope: "Editing the original", doneWhen: "Checks pass", context: [], questions: [], timeboxMinutes: null,
  } });
  const target = () => f.k.store.runtime(warden.threadId).reviewTarget!;
  expect(warden.executionNotes).not.toContain(expect.stringContaining("checks are closed"));
  expect(target().localSnapshot?.commit).toBeDefined();
  const verify = (waypointId = "w1") => journal.runTool(warden.threadId, { action: "verify", threadId: "lead", id: entries.get(waypointId)!, evidence: [{ kind: "command", ref: command, detail: "Observed result", exitCode: 0 }] });
  const entry = (waypointId = "w1") => journal.get("lead").entries.find(entry => entry.id === entries.get(waypointId))!;
  return { ...f, journal, entryId, warden, target, submit, verify, entry };
}

it.skipIf(process.platform !== "darwin")("records the commit on verdicts and rebinds a revised submission", async () => {
  const f = await hireChecker(), first = f.target();
  const proof = [{ kind: "command" as const, ref: command, detail: "Observed result", exitCode: 0 }];
  const entry = () => f.journal.get("lead").entries.find(entry => entry.id === f.entryId)!;
  expect(await f.journal.runTool(f.warden.threadId, { action: "reject", threadId: "lead", id: f.entryId, reason: "Needs a correction" })).not.toMatchObject({ isError: true });
  expect(entry().review?.evidence).toContainEqual(expect.objectContaining({ ref: first.localSnapshot!.commit }));
  await vi.waitFor(() => expect(existsSync(first.checks!.worktree!)).toBe(false), { timeout: 5000 });
  writeFileSync(join(f.main, "new"), "resubmitted\n");
  expect(await f.submit("Revised submission")).not.toMatchObject({ isError: true });
  const verify = () => f.journal.runTool(f.warden.threadId, { action: "verify", threadId: "lead", id: f.entryId, evidence: proof });
  expect(await verify()).toMatchObject({ isError: true, text: expect.stringContaining("current checker snapshot") });
  await f.runtime.tell("lead", f.warden.threadId, "Please check the revised submission.");
  const second = f.target();
  expect(second.localSnapshot?.commit).not.toBe(first.localSnapshot!.commit);
  expect(readFileSync(join(second.checks!.worktree!, "new"), "utf8")).toBe("resubmitted\n");
  expect(await verify()).not.toMatchObject({ isError: true });
  expect(entry().review?.evidence).toContainEqual(expect.objectContaining({ ref: second.localSnapshot!.commit }));
  await vi.waitFor(() => expect(existsSync(second.checks!.worktree!)).toBe(false), { timeout: 5000 });
});

it.skipIf(process.platform !== "darwin")("refuses a resubmission against an old snapshot that is still open", async () => {
  const f = await hireChecker(), first = f.target();
  writeFileSync(join(f.main, "new"), "changed while the snapshot was open\n");
  expect(await f.submit("New evidence")).not.toMatchObject({ isError: true });
  expect(f.target()).toEqual(first);
  expect(existsSync(first.checks!.worktree!)).toBe(true);
  expect(await f.verify()).toMatchObject({ isError: true, text: expect.stringContaining("current checker snapshot") });
  expect(f.entry().status).toBe("done");
});

it.skipIf(process.platform !== "darwin")("verifies two Keeper-made waypoints in one Warden's initial snapshot", async () => {
  const f = await hireChecker(["w1", "w2"]), first = f.target();
  expect(f.k.checkerWaypoints(f.warden.threadId)).toEqual(["w1", "w2"]);
  expect(await f.verify("w2")).not.toMatchObject({ isError: true });
  expect(existsSync(first.checks!.worktree!)).toBe(true);
  expect(await f.verify("w1")).not.toMatchObject({ isError: true });
  for (const waypoint of ["w1", "w2"]) expect(f.entry(waypoint).review?.evidence).toContainEqual(expect.objectContaining({ ref: first.localSnapshot!.commit }));
  await vi.waitFor(() => expect(existsSync(first.checks!.worktree!)).toBe(false), { timeout: 5000 });
});

it.skipIf(process.platform !== "darwin")("rebriefs the same Warden to check a submission on its second waypoint", async () => {
  const f = await hireChecker(["w1", "w2"], ["w1"]), first = f.target();
  expect(await f.verify("w1")).not.toMatchObject({ isError: true });
  await vi.waitFor(() => expect(existsSync(first.checks!.worktree!)).toBe(false), { timeout: 5000 });
  writeFileSync(join(f.main, "new"), "second waypoint\n");
  expect(await f.submit("Second waypoint", "w2")).not.toMatchObject({ isError: true });
  await f.runtime.tell("lead", f.warden.threadId, "Please check w2.", undefined, undefined, ["w2"]);
  const second = f.target();
  expect(second.localSnapshot?.commit).not.toBe(first.localSnapshot!.commit);
  expect(await f.verify("w2")).not.toMatchObject({ isError: true });
  expect(f.entry("w2").review?.evidence).toContainEqual(expect.objectContaining({ ref: second.localSnapshot!.commit }));
  await vi.waitFor(() => expect(existsSync(second.checks!.worktree!)).toBe(false), { timeout: 5000 });
});

it.skipIf(process.platform !== "darwin")("refuses a missing snapshot and rebinds it on rebrief without a changed submission", async () => {
  const f = await hireChecker(), first = f.target();
  await f.scopes.checkerSnapshots.remove(first.localSnapshot!.id);
  expect(f.target()).toEqual(first);
  expect(await f.verify()).toMatchObject({ isError: true, text: expect.stringContaining("current checker snapshot") });
  await f.runtime.tell("lead", f.warden.threadId, "Please check the submission.");
  const second = f.target();
  expect(second.localSnapshot?.id).not.toBe(first.localSnapshot!.id);
  expect(await f.verify()).not.toMatchObject({ isError: true });
  await vi.waitFor(() => expect(existsSync(second.checks!.worktree!)).toBe(false), { timeout: 5000 });
});

it.skipIf(process.platform !== "darwin")("keeps an active snapshot on startup and removes it on Warden release", async () => {
  const f = await hireChecker(), root = f.target().checks!.worktree!;
  await f.runtime.reconcile();
  expect(existsSync(root)).toBe(true);
  await f.runtime.release("lead", f.warden.threadId, "Another Warden will check this.");
  await vi.waitFor(() => expect(existsSync(root)).toBe(false), { timeout: 5000 });
});
