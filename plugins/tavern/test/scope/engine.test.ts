// @vitest-environment node
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/scope/engine";
import { scopeForClass } from "../../src/scope/presets";
import { scopeSchema } from "../../src/scope/schema";
import { bindPaths } from "../../src/scope/paths";

const scope = (role: string) => bindPaths(scopeForClass(role, undefined, role === "keeper" ? "keeper" : undefined), { home: "/home/me", tmp: ["/tmp", "/private/tmp"], worktree: "/repo", threadStorage: "/storage/t1", scopesDir: "/data/scopes" });
const bash = (role: string, command: string) => evaluate(scope(role), { kind: "bash", toolName: "bash", input: { command }, cwd: "/repo" });

describe("scope engine", () => {
  it("validates presets and rejects invalid rules and unknown versions", () => {
    for (const role of ["ranger", "warden", "smith", "keeper", "wanderer", "unknown"]) expect(scopeSchema.safeParse(scope(role)).success).toBe(true);
    expect(scopeSchema.safeParse({ ...scope("ranger"), v: 2 }).success).toBe(false);
    expect(scopeSchema.safeParse({ ...scope("ranger"), shell: { deny: [{ id: "bad", regex: "[", why: "bad" }], allow: [] } }).success).toBe(false);
  });
  it("allows open threads without changing their tools", () => {
    expect(bash("wanderer", "git push --force origin main").allow).toBe(true);
    expect(evaluate(scope("unknown"), { kind: "tool", toolName: "anything", input: {}, cwd: "/repo" }).allow).toBe(true);
  });
  it("makes reads, reports and other plugin tools available", () => {
    for (const name of ["read", "quest", "tavern_report", "flare", "mcp__tool_gateway__slack_read_thread"]) expect(evaluate(scope("ranger"), { kind: "tool", toolName: name, input: {}, cwd: "/repo" }).allow).toBe(true);
    for (const role of ["ranger", "smith", "keeper"]) for (const name of ["mcp__tool_gateway__slack_post_message", "slack_send", "other_write_file", "spawn"]) expect(evaluate(scope(role), { kind: "tool", toolName: name, input: {}, cwd: "/repo" }).allow).toBe(name !== "spawn" || role === "keeper");
  });
  it("keeps Keeper domain writes out, but permits Tavern coordination", () => {
    expect(evaluate(scope("keeper"), { kind: "tool", toolName: "tavern_hire", input: {}, cwd: "/repo" }).allow).toBe(true);
    expect(evaluate(scope("keeper"), { kind: "write", toolName: "write", input: { path: "/tmp/note" }, cwd: "/repo" }).allow).toBe(true);
    expect(bash("keeper", "git status && ls src").allow).toBe(true);
    expect(bash("keeper", "npm test").allow).toBe(false);
  });
  it("limits writes by root, not string prefix, and protects guard files", () => {
    for (const path of ["src/a.ts", "/tmp/a"]) expect(evaluate(scope("smith"), { kind: "write", toolName: "write", input: { path }, cwd: "/repo" }).allow).toBe(true);
    for (const path of ["/repo-other/a", "../outside", "/data/scopes/t.json", "/home/me/.pi/agent/extensions/a", "/repo/.claude/settings.local.json", "/repo/.agents/tavern/scopes.yml"]) expect(evaluate(scope("smith"), { kind: "write", toolName: "edit", input: { path }, cwd: "/repo" }).allow).toBe(false);
    expect(evaluate(scope("ranger"), { kind: "write", toolName: "write", input: { path: "a" }, cwd: "/repo" }).allow).toBe(false);
  });
  it.each([
    "git push origin feature", "sudo env X=1 timeout 10 git -C /repo push origin feature", "bash -lc 'git push origin feature'", "xargs -I {} git push origin feature", "echo $(git push origin feature)", "for x in a; do git push origin feature; done", "gh pr create --draft", "gh api repos/a/b -f title=x", "gh api -X POST repos/a/b", "kubectl --context staging apply -f a.yaml", "helm upgrade x y", "terraform apply", "dev deploy", "terraform -chdir=/tmp apply", "kapp --app foo deploy", "helm --kube-context staging install a b"
  ])("blocks readonly shell: %s", command => expect(bash("ranger", command).allow).toBe(false));
  it.each(["git status", "gh pr view 1", "echo 'git push origin main'", "kubectl get pods", "cat a | head -1", "git diff > /tmp/report"])("allows readonly shell: %s", command => expect(bash("ranger", command).allow).toBe(true));
  it.each([
    "git push origin main", "git push origin HEAD:master", "git push origin HEAD:refs/notes/test", "git push origin tag v1", "git push --follow-tags origin feature", "git push --prune origin feature", "git push --force-with-lease origin topic", "git push origin +HEAD:topic", "git push origin :topic", "git push --mirror origin", "git push origin", "git push", "gh pr create --title x", "gh pr create --draft=false", "gh pr ready 1", "gh pr merge 1", "gh api repos/a/b -X PATCH", "kubectl rollout restart deployment/a", "echo x > ../outside", "cd /outside && touch x", "tee /outside/a < a", "git -C /outside checkout x", "git -C /outside branch topic", "git -C /outside remote add upstream url", "git config --global user.email x@y"
  ])("blocks Smith overreach: %s", command => expect(bash("smith", command).allow).toBe(false));
  it.each(["git push origin HEAD:refs/heads/topic", "git push -u origin feature", "gh pr create --draft --title x", "git add src && git commit -m test", "echo x > src/a", "mkdir -p build", "npm test"])("allows Smith work: %s", command => expect(bash("smith", command).allow).toBe(true));
  it("checks named exceptions without bypassing unrelated deny rules", () => {
    const s = scope("ranger");
    s.shell.allow.push({ id: "git-push", argv: ["git", "push", "origin", "safe"], why: "specific exception" });
    expect(evaluate(s, { kind: "bash", toolName: "bash", input: { command: "git push origin safe; gh pr merge 1" }, cwd: "/repo" }).allow).toBe(false);
  });
  it("block reasons explain the next action", () => {
    const result = bash("smith", "gh pr merge 1");
    expect(result.allow).toBe(false);
    if (!result.allow) expect(result.reason).toContain("tavern_report status needs-decision");
  });
  it("preserves late worktree bindings but refuses evaluation until bound and rejects widening", () => {
    const late = bindPaths(scopeForClass("smith"), { home: "/home/me", tmp: ["/tmp"], scopesDir: "/data/scopes" });
    expect(late.writes.allow).toContain("${worktree}");
    expect(evaluate(late, { kind: "write", toolName: "write", input: { path: "/repo/file" }, cwd: "/repo" })).toMatchObject({ allow: false, ruleId: "worktree-unresolved" });
    expect(scopeForClass("ranger", { tools: { allow: ["spawn"] } }).tools.allow).toEqual(["spawn"]);
  });
});
