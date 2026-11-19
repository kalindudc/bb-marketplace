// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AWAY_STOP_LIST, awayWindowSchema } from "../../src/shared/away";
import { scopeForClass } from "../../src/scope/presets";
import { bindPaths } from "../../src/scope/paths";
import { evaluate } from "../../src/scope/engine";
import { setup } from "./runtime-fixture";
import { hasAwayDenials, localAwayPrevention, narrowAwayScope } from "../../src/server/away/denials";

const window = awayWindowSchema.parse({ id: "away-test", version: 1, closedAt: 1000, until: 2000, note: null, quests: [], allowWatched: false,
  wakeRules: { blockers: true, productionAsksAfterTwoHours: false }, stopList: [...AWAY_STOP_LIST], eventFloor: 1, eventCeiling: null, returnedAt: null, returnCause: null });
const cwd = "/tmp/tavern-away-denials/worktree";
function bound() {
  const scope = scopeForClass("smith");
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
    const ruleId = ["git merge feature", "rm -rf build", "find . -delete"].includes(command) ? expect.stringMatching(/^away:/) : "closing-act";
    expect(decision).toMatchObject({ allow: false, ruleId });
  });
  it.each(["slack_send", "deploy_service", "delete_file", "merge_pr"])("blocks an outward or destructive tool: %s", toolName => {
    expect(evaluate(narrowAwayScope(bound(), window), { kind: "tool", toolName, input: {}, cwd }).allow).toBe(false);
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
    expect(evaluate(scope, { kind: "write", toolName: "write", input: { path: cwd + "/draft.md" }, cwd }).allow).toBe(true);
  });
});
