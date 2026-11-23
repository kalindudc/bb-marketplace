// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import guard, { type PiGuardApi } from "../../adapters/pi/extension";
import { bindPaths } from "../../src/scope/paths";
import { scopeForClass } from "../../src/scope/presets";
import { ScopeStore } from "../../src/scope/store";
import { registerWatcher } from "../../src/scope/watch";
import { registerTools } from "../../src/server/tools";
import { registerRpc } from "../../src/server/rpc";
import { makeThreadResponse } from "./host";
import { setup } from "./runtime-fixture";
import { seedQuest, waypointEntry } from "./support";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(role = "keeper", native = false, providerId = "pi", arm = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tavern-merge-gate-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture");
  git("branch", "topic");
  git("branch", "trunk");
  const remote = join(root, "remote.git"), other = join(root, "other.git");
  for (const [path, branch] of [[remote, "main"], [other, "trunk"]] as const) {
    git("init", "--bare", "-b", branch, path);
    git(`--git-dir=${path}`, "fetch", root, `${branch}:refs/heads/${branch}`);
  }
  git("remote", "add", "origin", remote);
  git("remote", "add", "upstream", remote);
  git("remote", "add", "other", other);
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git("symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/main");
  git("update-ref", "refs/remotes/other/trunk", "HEAD");
  git("symbolic-ref", "refs/remotes/other/HEAD", "refs/remotes/other/trunk");
  git("branch", "--set-upstream-to=origin/main", "main");
  const revision = git("rev-parse", "HEAD");
  if (native) git("remote", "add", "local", remote);
  const f = setup({ environments: { get: async () => ({ path: root, hostId: "host" }) } });
  cleanups.push(() => { f.k.store.db.close(); });
  registerTools(f.bb, f.runtime);
  registerRpc(f.bb, f.runtime);
  vi.spyOn(f.runtime, "wakeKeeper").mockResolvedValue(undefined as never);
  const quest = await seedQuest(f.k, "lead", "Update docs", "Docs");
  const policy = join(root, "policy");
  const store = new ScopeStore(policy);
  const scope = bindPaths({ ...scopeForClass(role), threadId: "lead", assignedBranch: "topic", issuedAt: 1,
    ...(role === "smith" ? { workspaceKind: "dedicated-machine" as const, expectedWorktree: root } : {}),
  }, { home: root, tmp: [root], scopesDir: store.directory, worktree: root });
  store.arm(store.write("lead", scope));
  const onViolation = vi.fn();
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  if (native) {
    vi.setSystemTime(f.time());
    f.bb.sdk.threads.storageLocation = async () => ({ hostId: "host", storageRootPath: join(root, "storage") });
    f.runtime.enableScopes({ dataDir: policy, installGuard: false, policyOptions: { home: root } });
    await f.runtime.scopes!.api.writeScope("lead", scope);
  } else registerWatcher(f.bb, store, { onViolation });
  const listener = vi.mocked(f.bb.events.on).mock.calls.find(([name]) => name === "experimental_thread.events")?.[1] as
    (event: { thread: ReturnType<typeof makeThreadResponse>; sequence: number }) => Promise<void>;
  let seq = 0;
  const observe = async (command: string, additional: Record<string, unknown> = {}) => {
    seq++;
    f.bb.sdk.threads.events.list = async () => [{ id: `event-${seq}`, seq, type: providerId === "pi" ? "item/completed" : "item/started", createdAt: Date.now(), data: { item: { type: "commandExecution", command, cwd: root, ...additional } } }] as never;
    await listener({ thread: makeThreadResponse({ id: "lead", providerId }), sequence: seq });
    return (f.runtime.scopes?.api ?? store).violations("lead");
  };
  const open = async (target: object = { commit: revision }) => {
    await f.harness.behavior.invokeAgentTool("tavern_ask", {
      boardQuestId: quest.id, kind: "merge", question: "Merge the documentation branch?", why: "Review is complete",
      target, meanwhile: "Continue reading", holds: [],
      options: [{ id: "approve", label: "Approve", detail: "Allow the merge", recommended: false }],
    }, { threadId: "lead" });
    return f.k.store.openAsks("lead", quest.id).at(-1)!;
  };
  const handlers = new Map<string, Parameters<PiGuardApi["on"]>[1]>();
  if (native) {
    vi.stubEnv("BB_THREAD_ID", "lead");
    vi.stubEnv("TAVERN_SCOPE_FILE", f.runtime.scopes!.api.scopeFile("lead"));
    guard({ on: (name, fn) => { handlers.set(name, fn); }, getActiveTools: () => ["bash"], setActiveTools() {} });
    if (arm && providerId === "pi") handlers.get("session_start")!({}, { cwd: root });
  }
  const start = () => handlers.get("session_start")!({}, { cwd: root });
  const call = (command: string) => handlers.get("tool_call")!({ toolName: "bash", toolCallId: "test-merge", input: { command } }, { cwd: root });
  const result = () => handlers.get("tool_result")!({ toolName: "bash", toolCallId: "test-merge" }, { cwd: root });
  const approve = (askId: string) => f.harness.invokeRpc("answerAsk", { askId, via: "banner", optionId: "approve", note: null });
  const command = `git push local ${revision}:refs/heads/main`;
  const target = { commit: revision, command, merge: { repository: remote, sourceBranch: "topic", targetBranch: "main" } };
  const prFacts = (head = revision, base = "main") => {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const pullRequest = "https://github.com/example/demo/pull/42";
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s' '${JSON.stringify({ url: pullRequest, baseRefName: base, headRefOid: head, state: "OPEN" })}'\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    return { pullRequest, repository: "github.com/example/demo", targetBranch: "main" };
  };
  return { ...f, quest, observe, open, revision, git, command, target, remote, other, start, call, result, approve, prFacts };
}

it("does not let a chat yes authorize a merge while the card is open", async () => {
  const f = await fixture();
  const ask = await f.open();
  f.k.receiveUser("lead", "Yes, merge the documentation branch.");
  f.k.route("lead", { kind: "steer", boardQuestId: f.quest.id, summary: "The user says yes", notes: [] });
  expect(f.k.store.get("asks", ask.id)).toMatchObject({ state: "open", answer: null });
  expect(await f.observe("gh pr merge 42 --repo example/demo")).toMatchObject([{ ruleId: "merge-approval" }]);
});

it.each([
  "gh api --method PUT repos/example/demo/pulls/42/merge",
  "gh api -XPUT 'repos/example/demo/pulls/{number}/merge'",
  "gh api -f 'query=mutation { mergePullRequest(input: {pullRequestId: \"fixture\"}) { clientMutationId } }' graphql",
  "git push origin main",
  "git push origin @",
  "git push origin HEAD:main",
  "curl -X PUT https://api.example.invalid/repos/example/demo/pulls/42/merge",
  "wget --method=PUT https://api.example.invalid/repos/example/demo/pulls/42/merge",
  `curl --json '{"query":"mutation { mergePullRequest { clientMutationId } }"}' https://api.example.invalid/graphql`,
  "gh api -X PATCH repos/example/demo/git/refs/heads/main",
  "gh api -X PUT repos/example/demo/contents/docs -f branch=main",
  `gh api graphql -f 'query=mutation { createCommitOnBranch { clientMutationId } }'`,
  "git send-pack origin topic:main",
  "git subtree push --prefix=docs origin main",
  "echo main | xargs git push origin",
  "git push origin +topic:main",
  "git push origin --all",
  "git push origin --mirror",
  "git push",
  "git push upstream HEAD:refs/heads/main",
  "git push other HEAD:refs/heads/trunk",
  "git push origin 'refs/heads/*:refs/heads/*'",
  "git merge topic && git push origin main",
])("detects %s without an approval", async command => {
  const f = await fixture();
  expect(await f.observe(command)).toMatchObject([{ ruleId: "merge-approval" }]);
});

it("checks a bare push that Git can set up on a protected branch automatically", async () => {
  const f = await fixture();
  f.git("branch", "--unset-upstream", "main");
  f.git("config", "push.default", "simple");
  f.git("config", "push.autoSetupRemote", "true");
  expect(await f.observe("git push")).toMatchObject([{ ruleId: "merge-approval" }]);
});

it("allows a feature push with stdin but refuses pushes that get arguments from xargs", async () => {
  const f = await fixture("keeper", true);
  expect(f.call("printf 'y\\n' | git push origin topic")).toBeUndefined();
  for (const command of ["echo main | xargs git push origin", "xargs -I{} git push origin {} <<< main"])
    expect(f.call(command), command).toMatchObject({ block: true });
});

it.each(["git push origin topic", "git merge topic", "gh pr create --draft --title Draft --body Work", "gh api repos/example/demo/pulls/42/merge"])("does not flag ordinary work: %s", async command => {
  const f = await fixture();
  expect(await f.observe(command)).toEqual([]);
});

it.each(["smith", "warden"])("retains the %s refusal", async role => {
  const f = await fixture(role);
  expect(await f.observe("gh pr merge 42 --repo example/demo")).toMatchObject([{ ruleId: "gh-merge" }]);
});

it("prevents the chat-approved merge before dispatch", async () => {
  const f = await fixture("keeper", true);
  const ask = await f.open();
  f.k.receiveUser("lead", "Yes, merge the documentation branch.");
  f.k.route("lead", { kind: "steer", boardQuestId: f.quest.id, summary: "Says yes", notes: [] });
  expect(f.k.store.get("asks", ask.id)?.answer).toBeNull();
  expect(f.call("gh pr merge 42 --repo example/demo")).toMatchObject({ block: true, reason: expect.stringContaining("tavern_ask") });
});

it.each([false, true])("records outside completion without granting a run (previously approved=%s)", async approved => {
  const f = await fixture("keeper", true);
  const ask = await f.open(f.target);
  if (approved) await f.approve(ask.id);
  await expect(f.harness.behavior.invokeAgentTool("tavern_ask", { mergeAskId: ask.id, action: "withdraw", reason: "done outside Tavern" }, { threadId: "lead" })).resolves.toContain("withdrawn");
  expect(f.k.store.get("asks", ask.id)).toMatchObject({ state: "withdrawn", withdrawnCause: "merge-moot" });
  expect(f.k.store.events("lead")).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "ask.withdrawn", text: "done outside Tavern", data: expect.objectContaining({ askId: ask.id }) }),
  ]));
  expect(f.call(f.command)).toMatchObject({ block: true });
});

it("allows one card-approved protected push and records its use through the watcher", async () => {
  const f = await fixture("keeper", true);
  const ask = await f.open(f.target);
  await f.approve(ask.id);
  expect(f.call(f.command)).toBeUndefined();
  expect(await f.observe(f.command, { status: "completed", exitCode: 0, result: f.result() })).toEqual([]);
  expect(f.k.store.events("lead")).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "merge.used", boardQuestId: f.quest.id, data: expect.objectContaining({ askId: ask.id, revision: f.revision }) }),
  ]));
  expect(f.call(f.command)).toMatchObject({ block: true });
});

it.each(["claude-code", "codex"])("records one approved merge without stopping a %s Keeper", async provider => {
  const f = await fixture("keeper", true, provider);
  const command = "dt pr merge 42";
  const ask = await f.open({ ...f.target, command });
  await f.approve(ask.id);
  expect(await f.observe(command)).toEqual([]);
  expect(f.k.store.get("asks", ask.id)?.mergeUse).toMatchObject({ succeeded: false });
  expect(await f.observe(command)).toMatchObject([{ ruleId: "merge-approval", stopped: true }]);
});

it("keeps a card approval given before the Pi guard starts", async () => {
  const f = await fixture("keeper", true, "pi", false);
  const ask = await f.open(f.target);
  await f.approve(ask.id);
  expect(f.k.store.get("asks", ask.id)?.mergeApproval).toBeDefined();
  f.start();
  expect(await f.observe("git status")).toEqual([]);
  expect(f.call(f.command)).toBeUndefined();
});

it.each(["$(git branch --show-current)", '"$(git rev-parse --abbrev-ref HEAD)"'])("checks current-branch substitution %s without blocking feature pushes", async substitution => {
  const f = await fixture("keeper", true);
  f.git("remote", "add", "offline", "/does-not-exist");
  f.git("switch", "topic");
  expect(f.call("git push offline " + substitution)).toBeUndefined();
  f.git("switch", "main");
  expect(f.call("git push offline " + substitution)).toMatchObject({ block: true });
});

it.each(["cli", "api"])("allows an exact pinned %s merge once and rejects a changed PR head or target", async route => {
  const f = await fixture("keeper", true);
  const command = route === "cli" ? `gh pr merge 42 --repo example/demo --merge --match-head-commit ${f.revision}` :
    `gh api -X PUT repos/example/demo/pulls/42/merge -f sha=${f.revision}`;
  const ask = await f.open({ command, commit: f.revision, merge: f.prFacts() });
  await f.approve(ask.id);
  f.prFacts(f.revision, "release");
  expect(f.call(command)).toMatchObject({ block: true });
  f.prFacts();
  expect(f.call(command)).toBeUndefined();
  expect(await f.observe(command, { status: "completed", exitCode: 0, result: f.result() })).toEqual([]);
  expect(f.call(command)).toMatchObject({ block: true });
});

it.each(["expired", "superseded", "different command", "different repository"])("refuses an %s approval", async disposition => {
  const f = await fixture("keeper", true);
  const ask = await f.open(f.target);
  await f.approve(ask.id);
  if (disposition === "expired") vi.setSystemTime(f.time() + 11 * 60_000);
  if (disposition === "superseded") await f.open(f.target);
  if (disposition === "different repository") f.git("remote", "set-url", "local", f.other);
  expect(f.call(disposition === "different command" ? f.command.replace(" local ", " origin ") : f.command)).toMatchObject({ block: true });
});

it("revokes an approval when a PR head changes even if it later returns", async () => {
  const f = await fixture("keeper", true);
  const command = `gh pr merge 42 --repo example/demo --match-head-commit ${f.revision}`;
  const ask = await f.open({ command, commit: f.revision, merge: f.prFacts() });
  await f.approve(ask.id);
  f.prFacts("b".repeat(40));
  expect(f.call(command)).toMatchObject({ block: true });
  f.prFacts();
  expect(f.call(command)).toMatchObject({ block: true });
});

it.each(["local", "tracked remote"])("rejects the pinned push after the %s source branch moves and returns", async where => {
  const f = await fixture("keeper", true);
  const ask = await f.open(f.target);
  await f.approve(ask.id);
  f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Moved");
  if (where === "local") f.git("branch", "-f", "topic", "HEAD");
  else f.git("update-ref", "refs/remotes/local/topic", "HEAD");
  expect(f.call(f.command)).toMatchObject({ block: true });
  f.git("update-ref", where === "local" ? "refs/heads/topic" : "refs/remotes/local/topic", f.revision);
  expect(f.call(f.command)).toMatchObject({ block: true });
});

it.each([false, true])("requires the delegated Warden verdict to stay current (stale=%s)", async stale => {
  const f = await fixture("keeper", true);
  f.k.authority.delegate(f.quest.id, "merge", { act: "delegateQuest", surface: "page (client, unattested)", attribution: "user" });
  const ask = await f.open(f.target);
  const warden = f.k.bind("reviewer", "warden", null, "project");
  f.k.store.put("members", warden.threadId, { ...warden, role: "member", boardQuestId: f.quest.id, keeperThreadId: "lead", checkerMakerThreadId: "maker", checkerWaypointId: "w1" });
  const entry = { ...waypointEntry("maker", f.quest.id), status: "verified" as const, review: { actor: { kind: "agent" as const, threadId: "reviewer" }, at: f.time(), evidence: [{ kind: "command" as const, ref: f.revision, detail: "Checked revision", exitCode: 0 }], reason: null, previousNote: null, memberEvidenceAt: f.time() } };
  vi.spyOn(f.port, "linkedEntries").mockReturnValue([entry]);
  f.k.authority.recordVerdict("reviewer", ask.id, entry.id, { commit: f.revision });
  await f.harness.behavior.invokeAgentTool("tavern_decide", { boardQuestId: f.quest.id, source: "keeper", askId: ask.id, optionId: "approve", text: "Approve the reviewed branch", why: "Current Warden review", reversible: true, unsure: false,
    consequence: { change: "Update main", audience: "Readers", undo: "Revert the change" },
  }, { threadId: "lead" });
  if (stale) {
    vi.mocked(f.port.linkedEntries).mockReturnValue([{ ...entry, status: "doing", review: null }]);
    f.k.store.event(f.time(), "lead", f.quest.id, "journal.changed", "The review reopened");
    await Promise.resolve();
    expect(f.call(f.command)).toMatchObject({ block: true, reason: expect.stringContaining(`Get a current Warden verdict on ${f.revision}`) });
  } else expect(f.call(f.command)).toBeUndefined();
});
