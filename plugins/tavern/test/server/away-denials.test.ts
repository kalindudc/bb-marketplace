// @vitest-environment node
import { describe, expect, it } from "vitest";
import { LEGACY_AWAY_STOP_LIST, awayWindowSchema } from "../../src/shared/away";
import { scopeForClass } from "../../src/scope/presets";
import { bindPaths } from "../../src/scope/paths";
import { scopeFileSchema } from "../../src/scope/schema";
import { evaluate } from "../../src/scope/engine";
import { closingAct, fallbackActs } from "../../src/scope/acts";
import { setup } from "./runtime-fixture";
import { hasAwayDenials, localAwayPrevention, narrowAwayScope } from "../../src/server/away/denials";

const window = awayWindowSchema.parse({ id: "away-test", version: 1, closedAt: 1000, until: 2000, note: null, quests: [], allowWatched: false,
  wakeRules: { blockers: true, productionAsksAfterTwoHours: false }, stopList: [...LEGACY_AWAY_STOP_LIST], eventFloor: 1, eventCeiling: null, returnedAt: null, returnCause: null });
const selected = (stopList: string[]) => awayWindowSchema.parse({ ...window, guardPolicy: "selected", stopList });
const current = () => selected(["merge", "deploy", "production", "sends-as-you", "delete", "other-writes"]);
const cwd = "/tmp/tavern-away-denials/worktree";
function bound(role = "smith") {
  const scope = scopeForClass(role);
  scope.shell.allow = structuredClone(scope.shell.deny);
  return bindPaths(scope, { home: "/tmp/tavern-away-denials/home", tmp: ["/tmp"], scopesDir: "/tmp/tavern-away-denials/scopes", worktree: cwd, threadStorage: "/tmp/tavern-away-denials/thread" }, value => value);
}
describe("Closing time local denials", () => {
  it("is byte-inert without a closed window and preserves original grants", () => {
    const base = bound(), before = structuredClone(base);
    expect(narrowAwayScope(base, null)).toEqual(before);
    const changed = narrowAwayScope(base, window);
    expect(base).toEqual(before);
    expect(changed.shell.allow).toEqual(before.shell.allow);
    expect(changed.writes).toEqual(before.writes);
    expect(hasAwayDenials(changed, window)).toBe(true);
    expect(hasAwayDenials(changed, { ...window, version: 2 })).toBe(false);
  });
  it.each(["git merge feature", "gh pr merge 12", "git push origin feature", "dev deploy", "terraform apply", "kubectl --context production apply -f prod.yml", "slack send channel text", "rm -rf build", "find . -delete", "gh pr create --draft", "curl -X POST https://example.test"])("blocks named stop-list action before execution: %s", command => {
    const decision = evaluate(narrowAwayScope(bound(), window), { kind: "bash", toolName: "bash", input: { command }, cwd });
    expect(evaluate(narrowAwayScope(bound(), current()), { kind: "bash", toolName: "bash", input: { command }, cwd })).toEqual(decision);
    const ruleId = ["git merge feature", "rm -rf build", "find . -delete"].includes(command) ? expect.stringMatching(/^away:/) : command.startsWith("slack send") ? "send-guard" : "closing-act";
    expect(decision).toMatchObject({ allow: false, ruleId });
  });
  it.each(["slack_send", "deploy_service", "delete_file", "merge_pr"])("blocks an outward or destructive tool: %s", toolName => {
    const call = { kind: "tool" as const, toolName, input: {}, cwd };
    const legacy = evaluate(narrowAwayScope(bound(), window), call);
    expect(legacy.allow).toBe(false);
    expect(evaluate(narrowAwayScope(bound(), current()), call)).toEqual(legacy);
  });
  it.each(["keeper", "smith", "ranger", "warden", "wanderer"])("writes the exact legacy scope bytes at the six-item default for %s", role => {
    const base = { ...bound(role), threadId: "sample" };
    const legacy = narrowAwayScope(base, window), all = narrowAwayScope(base, current());
    expect(JSON.stringify(all)).toBe(JSON.stringify(legacy));
    expect(scopeFileSchema.parse(JSON.parse(JSON.stringify(all)))).toEqual(all);
    expect(hasAwayDenials(all, current())).toBe(true);
    expect(hasAwayDenials(legacy, current())).toBe(true);
  });
  it("narrows the scope only for selected kinds and checks that same policy", () => {
    const selection = selected(["merge", "deploy", "delete"]);
    const base = bound(), scope = narrowAwayScope(base, selection);
    expect(hasAwayDenials(scope, selection)).toBe(true);
    expect(scope).not.toHaveProperty("awayPolicy");
    expect(scope.shell.deny.filter(rule => rule.id.startsWith("away:")).some(rule => rule.id.includes(":policy:"))).toBe(true);
    expect(scopeFileSchema.safeParse({ ...scope, threadId: "sample" }).success).toBe(true);
    expect(hasAwayDenials(scope, selected(["production", "sends-as-you", "other-writes"]))).toBe(false);
    expect(scope.tools.deny.slice(base.tools.deny.length)).toEqual(["*merge*", "*deploy*", "*delete*", "*remove*"]);
    const run = (s: typeof scope, command: string) => evaluate(s, { kind: "bash", toolName: "bash", input: { command }, cwd });
    for (const command of ["git merge feature", "dev deploy", "rm build.log"]) expect(run(scope, command).allow).toBe(false);
    for (const command of ["git push origin feature", "slack send channel text", "gh pr create --draft"]) expect(run(scope, command)).toEqual(run(base, command));
  });
  it("classifies the fallback command using the same selected policy", () => {
    const blocked = (items: string[], source: string) => {
      const scope = narrowAwayScope(bound(), selected(items));
      return fallbackActs(source).some(act => closingAct(scope, act, source));
    };
    expect(blocked(["production"], "kubectl scale dev")).toBe(true);
    expect(blocked(["deploy"], "kubectl scale dev")).toBe(false);
    expect(blocked(["deploy"], "helm upgrade sample")).toBe(true);
    expect(blocked(["sends-as-you"], "curl -X POST https://example.test")).toBe(false);
    expect(blocked(["other-writes"], "curl -X POST https://example.test")).toBe(true);
    expect(blocked(["sends-as-you"], "slack send channel text")).toBe(true);
  });
  it("puts unambiguous merges and pushes to main under Merge, not Other writes", () => {
    const base = bound("keeper"), merge = narrowAwayScope(base, selected(["merge"]));
    const others = narrowAwayScope(base, selected(["deploy", "production", "sends-as-you", "delete", "other-writes"]));
    const call = (command: string) => ({kind:"bash" as const, toolName:"bash", input:{command}, cwd});
    const fallback = (scope: typeof base, source: string) => fallbackActs(source).some(act => closingAct(scope, act, source));
    for (const command of ["gh pr merge 12", "git push origin main", "git push origin HEAD:main", "git push origin HEAD:refs/heads/master"]) {
      expect(evaluate(base, call(command)), command).toMatchObject({ allow: false, ruleId: "merge-approval" });
      const approved = { ...call(command), mergeMatches: true };
      expect(evaluate(base, approved).allow, command).toBe(true);
      expect(evaluate(merge, approved), command).toMatchObject({ allow: false, ruleId: "closing-act" });
      expect(evaluate(others, approved).allow, command).toBe(true);
      expect(fallback(merge, command), command).toBe(true);
      expect(fallback(others, command), command).toBe(false);
    }
    expect(evaluate(others, call("git push origin feature")).allow).toBe(false);
    expect(evaluate(others, call("git push origin main feature")).allow).toBe(false);
    expect(fallback(others, "git push origin feature")).toBe(true);
    expect(fallback(others, "git push origin main feature")).toBe(true);
    expect(narrowAwayScope(base, selected(["sends-as-you"])).tools.deny).not.toContain("*post*");
    expect(others.tools.deny).toContain("*post*");
  });
  it("still refuses an approved cluster write when all optional stops are unchecked", () => {
    const base = bound(), empty = selected([]), closed = narrowAwayScope(base, empty);
    expect(closed.tools).toEqual(base.tools);
    expect(hasAwayDenials(base, empty)).toBe(false);
    expect(hasAwayDenials(closed, empty)).toBe(true);
    expect(evaluate(closed, { kind: "bash", toolName: "bash", input: { command: "kubectl scale testing" }, cwd, clusterWriteApproved: true })).toMatchObject({ allow: false, ruleId: "closing-act" });
    expect(hasAwayDenials(narrowAwayScope(base, current()), empty)).toBe(false);
  });
  it("requires the exact current local policy before claiming prevention", () => {
    const f = setup(), member = { ...f.k.bind("child", "ranger", "pip", "project"), guardPosture: { providerId: "pi", mode: "pre-exec" as const, label: "Pi", approvalAskId: null } };
    const status: NonNullable<Parameters<typeof localAwayPrevention>[0]> = { mode: "enforce", installation: "disabled",
      guard: { installed: true, stale: false, file: "/tmp/test-guard", claude: "phase-2-not-installed", sandbox: "not-applicable" },
      threads: [{ threadId: "child", scope: bound(), error: undefined, hasTemplate: true, armed: true }] };
    expect(localAwayPrevention(status, member, null)).toBe(true);
    expect(localAwayPrevention(status, member, window)).toBe(false);
    status.threads[0]!.scope = narrowAwayScope(bound(), window);
    expect(localAwayPrevention(status, member, window)).toBe(true);
    expect(localAwayPrevention(status, member, { ...window, version: 2 })).toBe(false);
    status.threads[0]!.hostScope = "acknowledged";
    expect(localAwayPrevention(status, member, window)).toBe(false);
    delete status.threads[0]!.hostScope;
    status.guard.stale = true;
    expect(localAwayPrevention(status, member, window)).toBe(false);
    status.guard.stale = false; status.mode = "watch";
    expect(localAwayPrevention(status, member, window)).toBe(false);
    status.mode = "enforce";
    expect(localAwayPrevention(status, { ...member, guardPosture: { ...member.guardPosture, mode: "detection-only" } }, window)).toBe(false);
  });
  it("keeps ordinary reads and private writes available", () => {
    const scope = narrowAwayScope(bound(), window);
    expect(evaluate(scope, { kind: "bash", toolName: "bash", input: { command: "git status" }, cwd }).allow).toBe(true);
    const call = { kind: "write" as const, toolName: "write", input: { path: cwd + "/draft.md" }, cwd };
    expect(evaluate(scope, call).allow).toBe(true);
    expect(evaluate(narrowAwayScope(bound(), current()), call)).toEqual(evaluate(scope, call));
    const patch = { ...call, toolName: "apply_patch" };
    expect(evaluate(narrowAwayScope(bound(), current()), patch)).toEqual(evaluate(scope, patch));
  });
});
