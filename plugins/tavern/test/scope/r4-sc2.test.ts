// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actsForCommand, fallbackActs } from "../../src/scope/acts";
import { shellCommands } from "../../src/scope/shell";
import { evaluate } from "../../src/scope/engine";
import { prepareCall } from "../../src/scope/prepare";
import { bindPaths } from "../../src/scope/paths";
import { scopeForClass } from "../../src/scope/presets";
import { ScopeStore } from "../../src/scope/store";
const scope = () => ({ ...bindPaths(scopeForClass("smith"), { home: "/home/me", tmp: ["/tmp"], threadStorage: "/storage", worktree: "/repo", scopesDir: "/scopes" }), assignedBranch: "assigned" });
const call = (command: string) => ({ kind: "bash" as const, toolName: "bash", cwd: "/repo", input: { command }, containment: "sandbox" as const });
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const research = ["bb plugin build .", "bb voice transcribe a.m4a", "bb plugin rpc call shuttle prs", "cortex lane ls", "cortex mv 1 lane", "bb machine providers", "bb machine env", "bb workflows status r1", "gcloud config set project x", "gcloud auth list"];
it.each(research)("is not an act: %s", command => {
  expect(shellCommands(command, "/repo").flatMap(actsForCommand)).toEqual([]);
  expect(evaluate(scope(), call(command)).allow).toBe(true);
});
it.each(["ranger", "warden", "smith", "keeper", "wanderer"])("allows secure credential requests without an act for %s", role => {
  const s = bindPaths(scopeForClass(role), { home: "/home/me", tmp: ["/tmp"], scopesDir: "/scopes", worktree: "/repo" });
  for (const command of ["bb secrets request", "bb --json secrets request --name TOKEN"]) {
    expect(shellCommands(command, "/repo").flatMap(actsForCommand)).toEqual([]);
    expect(fallbackActs(command + " 'unterminated")).toEqual([]);
    for (const mode of ["watch", "enforce"] as const) for (const contained of [true, false]) {
      const result = evaluate({ ...s, mode }, { ...call(command), containment: contained ? "sandbox" : undefined });
      expect(result.allow).toBe(true);
      expect(result).not.toHaveProperty("acts");
    }
    expect(evaluate({ ...s, shell: { ...s.shell, deny: [...s.shell.deny, { id: "away:test", argv: ["false"], why: "Closing time" }] } }, call(command)).allow).toBe(true);
  }
});
const smithReads = ["bb plugin validate .", "bb plugin rpc call shuttle board", "bb forage search x", "bb study measure s1", "bb workflows history r1 --cursor 0 --limit 10", "bb git diff", "cortex tag ls", "cortex workstream show 3", "gcloud auth login"];
it.each(smithReads)("allows ordinary Smith work without an act: %s", command => {
  expect(shellCommands(command, "/repo").flatMap(actsForCommand)).toEqual([]);
  expect(evaluate(scope(), call(command)).allow).toBe(true);
  for (const role of ["ranger", "warden"]) {
    const s = bindPaths(scopeForClass(role), { home: "/home/me", tmp: ["/tmp"], scopesDir: "/scopes", worktree: "/repo" });
    expect(evaluate(s, call(command))).toMatchObject({ allow: false, ruleId: "legacy-act" });
  }
});
it.each([
  ["configure", "bb plugin uninstall x"], ["configure", "bb plugin enable x"], ["configure", "bb plugin disable x"],
  ["configure", "bb plugin dev x"], ["configure", "bb plugin settings x"],
  ...["off", "pair", "revoke"].map(verb => ["configure", "bb lan " + verb]),
  ...["start", "land", "live", "archive", "pause", "resume"].map(verb => ["configure", "bb loom " + verb + " p"]),
  ...["update", "delete", "enable", "disable"].map(verb => ["configure", "bb automations " + verb + " a"]),
  ...["park", "remove"].map(verb => ["configure", "bb aquifer-machines " + verb + " m"]),
  ["configure", "bb machine env unset TOKEN"], ["configure", "bb secrets"],
  ["configure", "cortex reset"], ["configure", "cortex restore"],
  ["deploy", "gcloud run deploy service"], ["deploy", "gcloud app deploy"], ["deploy", "gcloud functions deploy function"],
  ["credential", "gcloud secrets versions access latest --secret s"],
  ["deploy", "gcloud --project p run deploy service"],
  ["credential", "gcloud --project p secrets versions access latest --secret s"],
])("classifies explicit authority as %s: %s", (kind, command) => {
  expect(shellCommands(command, "/repo").flatMap(actsForCommand).map(act => act.kind)).toEqual([kind]);
  for (const role of ["ranger", "warden", "smith"]) {
    const s = bindPaths(scopeForClass(role), { home: "/home/me", tmp: ["/tmp"], scopesDir: "/scopes", worktree: "/repo" });
    expect(evaluate(s, call(command)).allow).toBe(false);
    expect(evaluate(s, call(command + " 'unterminated")).allow).toBe(false);
  }
});
it.each(["localhost", "127.0.0.1", "127.2.3.4", "[::1]"])("local HTTP writes are not sends: %s", host => {
  const command = `curl -X POST http://${host}:3000/api -d x`;
  expect(shellCommands(command, "/repo").flatMap(actsForCommand)).toEqual([]);
  expect(evaluate(scope(), call(command)).allow).toBe(true);
  expect(evaluate(scope(), call(command.replace("http://", ""))).allow).toBe(true);
  expect(evaluate(scope(), call(command + " https://remote.test/api")).allow).toBe(false);
});
it("allows includes only with a lease on the assigned branch", () => {
  expect(evaluate(scope(), call("git push --force-with-lease --force-if-includes origin assigned")).allow).toBe(true);
  expect(evaluate(scope(), call("git push --force-if-includes origin assigned")).allow).toBe(false);
});
it.each(["git push origin colleague", "git push --force-with-lease origin colleague", "gh pr edit 12 --body x", "gh pr comment 12 -b x"])("checkout never transfers ownership: %s", command => {
  const s = scope();
  const readCommand = vi.fn((program: string, args: string[]) => {
    if (program === "git" && args.includes("symbolic-ref")) return "colleague";
    if (program === "git" && args.includes("get-url")) return "https://github.com/o/r.git";
    if (program === "gh" && args[0] === "api") return '{"login":"me"}';
    return JSON.stringify({ isDraft: true, author: { login: "me" }, headRefName: "colleague", headRepositoryOwner: { login: "o" }, headRepository: { name: "r" } });
  });
  expect(evaluate(s, prepareCall(call(command), { scope: s, readCommand })).allow).toBe(false);
  expect(evaluate(s, prepareCall(call("gh pr checkout 12; " + command), { scope: s, readCommand })).allow).toBe(false);
});
it.each([
  ["gh pr create --draft", "assigned", "assigned"],
  ["gh pr create --draft", "assigned", "colleague"],
  ["gh pr edit 12 --body x", "assigned", "colleague"],
  ["gh pr comment 12 -b x", undefined, "colleague"],
])("collects write paths and invalidates later HEAD facts after %s on %s/%s", (command, assignedBranch, head) => {
  const s = { ...scope(), assignedBranch };
  let branchReads = 0;
  const readCommand = vi.fn((_program: string, args: string[]) => args.includes("symbolic-ref") ? ++branchReads === 1 ? head! : "assigned" : "https://github.com/o/r.git");
  const prepared = prepareCall(call(command + " > /repo/out; git push origin HEAD"), { scope: s, readCommand });
  expect(prepared.resolvedPaths).toHaveProperty("/repo/out", "/repo/out");
  expect(prepared.pushHeads?.["/repo\0" + "0"]).toBe(head);
  expect(prepared.pushHeads?.["/repo\0" + "1"]).toBeUndefined();
  expect(branchReads).toBe(1);
});
it.each(["ranger", "warden", "smith"])("retains the %s control-plane floor through the catalogue", role => {
  const s = bindPaths(scopeForClass(role), { home: "/home/me", tmp: ["/tmp"], scopesDir: "/scopes", worktree: "/repo" });
  for (const command of ["bb loom approve project", "bb automations create --name fixture", "bb lan on", "bb settings set x y", "bb aquifer-machines rotate", "cortex agents reset", "gcloud compute instances delete vm", "bb machine env set TOKEN fixture"]) {
    expect(shellCommands(command, "/repo").flatMap(actsForCommand).map(act => act.kind)).toEqual([command.includes(" delete ") ? "delete" : "configure"]);
    for (const mode of ["watch", "enforce"] as const) expect(evaluate({ ...s, mode }, call(command)).allow).toBe(false);
  }
  if (role !== "smith") for (const command of research.slice(0, 5)) expect(evaluate(s, call(command)).allow).toBe(false);
  for (const command of ["gcloud compute instances list", "gcloud config get-value project", "bb status", "cortex update 17 -m fixture"]) expect(evaluate(s, call(command)).allow).toBe(true);
});
it.each(["bb loom approve project", "bb automations create --name fixture", "bb lan on", "bb settings set x y", "bb aquifer-machines rotate", "bb machine env set TOKEN fixture", "cortex agents reset", "gcloud compute instances delete vm"])("retains catalogue refusal when parsing fails: %s", command => {
  for (const role of ["ranger", "warden", "smith"]) {
    const s = bindPaths(scopeForClass(role), { home: "/home/me", tmp: ["/tmp"], scopesDir: "/scopes", worktree: "/repo" });
    expect(evaluate(s, call(command + " 'unterminated")).allow).toBe(false);
  }
});
it("resolves a draft creation redirect through a symlink before allowing the command", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sc2-redirect-"))); roots.push(root);
  const repo = join(root, "repo"), outside = join(root, "outside");
  mkdirSync(repo); mkdirSync(outside); symlinkSync(outside, join(repo, "link"));
  const s = { ...scope(), writes: { mode: "paths" as const, allow: [repo], deny: [] } };
  const prepared = prepareCall({ ...call("gh pr create --draft > link/out"), cwd: repo }, { scope: s, readCommand: () => "assigned" });
  expect(prepared.resolvedPaths?.[join(repo, "link/out")]).toBe(join(outside, "out"));
  expect(evaluate(s, prepared)).toMatchObject({ allow: false, ruleId: "shell-write" });
});
it("keeps the author check even on the assigned head", () => {
  const s = scope();
  const readCommand = (program: string, args: string[]) => program === "git" ? args.includes("get-url") ? "https://github.com/o/r.git" : "assigned" : args[0] === "api" ? '{"login":"me"}' : JSON.stringify({ isDraft: true, author: { login: "colleague" }, headRefName: "assigned", headRepositoryOwner: { login: "o" }, headRepository: { name: "r" } });
  for (const command of ["gh pr edit 12 --body x", "gh pr comment 12 -b x"]) expect(evaluate(s, prepareCall(call(command), { scope: s, readCommand })).allow).toBe(false);
});
it("records allowed acts separately from violations and attention inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "sc2-audit-")); roots.push(root);
  const store = new ScopeStore(root);
  store.recordAct({ threadId: "t1", providerId: "pi", at: 1, eventId: "e1", seq: 1, kind: "publish", call: call("git push origin assigned"), mode: "enforce" });
  expect(store.acts("t1")).toHaveLength(1);
  expect(new ScopeStore(root).acts("t1")).toHaveLength(1);
  expect(store.violations("t1")).toEqual([]);
});
it("keeps ordinary Wanderer acts open but sends an unverified pull request edit to the user", () => {
  const s = bindPaths(scopeForClass("wanderer"), { home: "/home/me", tmp: ["/tmp"], scopesDir: "/scopes" });
  for (const command of ["git push origin feature", "gh pr merge 1", "curl -X POST https://remote.test", "gh pr merge 1 'unterminated"]) expect(evaluate(s, call(command)).allow, command).toBe(true);
  expect(evaluate(s, call("gh pr edit 1 --body x"))).toMatchObject({ allow: false, ruleId: "pr-sends-as-you" });
});
