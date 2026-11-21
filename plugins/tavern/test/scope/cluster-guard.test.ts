// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "../../adapters/pi/extension";
import { ScopeStore } from "../../src/scope/store";
import { bindPaths } from "../../src/scope/paths";
import { scopeForClass } from "../../src/scope/presets";
import { publishShellGrants, readShellGrants, shellGrantTarget } from "../../src/scope/shell-grants";
import { issueActGrant, actTargetDigest } from "../../src/scope/act-grants";
import { evaluate } from "../../src/scope/engine";
import { fallbackActs } from "../../src/scope/acts";
import { commandWritePaths, shellCommands } from "../../src/scope/shell";
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const command = "kustomize build . | kubectl --context fixture -n demo apply -f -";
function fixture(role = "keeper", mode: "enforce" | "watch" | "off" = "enforce", threadId = "lead") {
  const root = mkdtempSync(join(tmpdir(), "cluster-guard-")); roots.push(root);
  const store = new ScopeStore(root);
  const scope = bindPaths({ ...scopeForClass(role), threadId, issuedAt: 1, mode }, { home: root, tmp: [root], scopesDir: store.directory, worktree: root });
  store.write(threadId, scope);
  const file = store.file(threadId);
  vi.stubEnv("TAVERN_SCOPE_FILE", file); vi.stubEnv("BB_THREAD_ID", threadId);
  const handlers = new Map<string, (event: any, context: { cwd: string }) => unknown>();
  extension({ on: (name, fn) => handlers.set(name, fn), getActiveTools: () => ["bash"], setActiveTools() {} });
  const call = (command: string, name = "bash") => handlers.get("tool_call")!({ toolName: name, toolCallId: "call-1", input: { command } }, { cwd: root });
  const grant = (extra = {}) => issueActGrant(file, { act: "cluster-write", threadId, target: command, targetDigest: actTargetDigest(command), askId: "ask-1", scope: "once", issuedAt: Date.now(), expiresAt: Date.now() + 60_000, usedAt: null, ...extra });
  return { store, scope, file, grant, call, version: () => handlers.get("session_start")!({}, { cwd: root }) };
}
it.each(["enforce", "watch", "off"] as const)("requires a cluster ask in %s, even on an old-format open Keeper scope", mode => {
  const f = fixture("keeper", mode);
  const saved = readFileSync(f.file, "utf8"); expect(saved).not.toContain("clusterWrite");
  expect(f.call(command)).toMatchObject({ block: true, reason: expect.stringMatching(/tavern_ask.*cluster-write.*meanwhile/i) });
  expect(f.call("kubectl --context fixture -n demo get pods")).toBeUndefined();
  expect(f.call("kubectl logs deploy/example")).toBeUndefined();
});
it.each(["enforce", "watch", "off"] as const)("claims one exact pipeline in %s, refuses changed targets and cannot replay the grant", mode => {
  const f = fixture("keeper", mode); f.grant();
  expect(f.call(command.replace("-n demo", "-n other"))).toMatchObject({ block: true });
  expect(f.call(command)).toBeUndefined();
  expect(f.call(command)).toMatchObject({ block: true });
});
it.each(["enforce", "watch", "off"] as const)("checks ordinary wrapper, alias and dynamic command forms in %s", mode => {
  const f = fixture("keeper", mode);
  for (const source of [
    "alias kube=kubectl; kube apply -f sample", "alias kube='kubectl --context fixture'; kube apply -f sample", "k apply -f sample", "K=kubectl; $K apply -f sample", "$CLUSTER_CMD --context fixture apply -f sample",
    "caffeinate -t 2 kubectl apply -f sample", "stdbuf -oL kubectl delete deployment sample",
    "script -q /dev/null kubectl apply -f sample", "script -q /dev/null kubectl exec -c sample pod -- true", "script -q -c 'kubectl apply -f sample' /dev/null",
    "ssh -p 22 fixture kubectl apply -f sample", "ssh fixture 'kubectl apply -f sample'",
    "su -c 'kubectl apply -f sample'", "unbuffer kubectl apply -f sample", "chronic kubectl apply -f sample",
    "ionice -c 2 kubectl apply -f sample", "taskset -c 0 kubectl apply -f sample",
    "flock -x /tmp/fixture kubectl apply -f sample", "doas -u fixture kubectl apply -f sample",
    "runuser -u fixture -- kubectl apply -f sample",
  ]) expect(f.call(source), source).toMatchObject({ block: true });
  for (const source of [
    "kubectl kustomize .", "kubectl completion zsh", "kubectl plugin list", "kubectl config use-context fixture",
    "kubectl config set-context fixture --namespace=sample", "kubectl config get-contexts", "kubectl config current-context",
    "ssh fixture 'kubectl get pods'", "k --context fixture get pods", "$TOOL --help", "echo 'kubectl apply -f sample'",
    "$NPM run test", "$NPM install", "$GIT diff", "$GIT apply p.patch", "$MAKE test",
  ]) expect(f.call(source), source).toBeUndefined();
});
it("only recognises k as a command word in the cluster fallback", () => {
  const cluster = (source: string) => fallbackActs(source).some(act => act.kind === "cluster-write");
  for (const source of ["curl -k https://x | npm run test", "ls -k && make run", "printf 'k set x'"]) expect(cluster(source), source).toBe(false);
  for (const source of ["k apply -f sample", "echo ready && k delete pod test", "echo x | kubectl apply -f -"]) expect(cluster(source), source).toBe(true);
});

it("checks remote acts without treating remote writes as local paths", () => {
  const { scope } = fixture("smith");
  const cwd = scope.expectedWorktree!;
  const call = (command: string) => evaluate(scope, { kind: "bash", toolName: "bash", input: { command }, cwd });
  expect(call("ssh fixture 'cd /srv && git pull'")).toMatchObject({ allow: true });
  expect(call("ssh fixture 'kubectl apply -f sample'")).toMatchObject({ allow: false, ruleId: "cluster-write" });
  expect(call("ssh fixture 'dev deploy'")).toMatchObject({ allow: false });
  expect(call("ssh fixture 'mail fixture@example.invalid'")).toMatchObject({ allow: false });
  expect(call("ssh fixture 'git pull' > /srv/local-copy")).toMatchObject({ allow: false, ruleId: "shell-write" });
});

it("retains script and flock output paths, including a script with no command", () => {
  const { scope } = fixture("ranger");
  const cwd = scope.writes.allow[0] ?? "/fixture-workspace";
  for (const source of ["script -q /srv/out.log", "script -q /srv/out.log echo hi", "script -q -c 'echo hi' /srv/out.log", "flock -x /srv/out.lock echo hi", "flock -x /srv/out.lock -c 'echo hi'"]) {
    const path = source.includes("out.log") ? "/srv/out.log" : "/srv/out.lock";
    expect(shellCommands(source, cwd).flatMap(commandWritePaths), source).toContain(path);
    expect(evaluate(scope, { kind: "bash", toolName: "bash", input: { command: source }, cwd }), source).toMatchObject({ allow: false });
  }
  const wrapped = shellCommands("script -q capture.log git -C /srv status", cwd);
  expect(wrapped.flatMap(commandWritePaths)).toContain(join(cwd, "capture.log"));
});

it("keeps ordinary shell and cluster grants independent and removes both on release", () => {
  const f = fixture("wanderer"), directory = join(f.store.directory, "..");
  const shellCommand = "npm publish";
  const target = shellGrantTarget({ kind: "bash", toolName: "bash", cwd: directory, input: { command: shellCommand } })!;
  const shellGrant = { id: "ordinary", digest: target.digest, scope: "once" as const };
  f.grant();
  publishShellGrants(f.file, f.scope, [shellGrant]);
  expect(readShellGrants(f.file, f.scope)).toEqual([shellGrant]);
  expect(f.call(command)).toBeUndefined();
  expect(f.call(shellCommand)).toBeUndefined();
  expect(f.call(command)).toMatchObject({ block: true });
  expect(f.call(shellCommand)).toMatchObject({ block: true });
  expect(existsSync(f.file + ".grants")).toBe(true);
  expect(existsSync(f.file + ".act-grants")).toBe(true);
  f.store.clear(f.scope.threadId);
  expect(existsSync(f.file + ".grants")).toBe(false);
  expect(existsSync(f.file + ".act-grants")).toBe(false);
});
it("tells a member to ask the Keeper rather than use a Keeper-only tool", () => {
  const f = fixture("wanderer");
  const result = f.call(command);
  expect(result).toMatchObject({ block: true, reason: expect.stringMatching(/Tell your Keeper.*exact command/) });
  expect((result as { reason: string }).reason).not.toContain("tavern_ask");
});
it("refuses other-thread, expired and Closing time grants without falling back to an open scope", () => {
  const f = fixture("wanderer", "watch", "child");
  f.grant({ threadId: "lead" }); expect(f.call(command)).toMatchObject({ block: true });
  f.grant({ askId: "ask-2", issuedAt: Date.now() - 120_000, expiresAt: Date.now() - 60_000 }); expect(f.call(command)).toMatchObject({ block: true });
  f.grant({ askId: "ask-3" });
  f.scope.shell.deny.push({ id: "away:fixture", regex: "(?!)", why: "Closing time" });
  f.store.write("child", f.scope);
  expect(f.call(command)).toMatchObject({ block: true, reason: expect.stringContaining("Closing time") });
});
