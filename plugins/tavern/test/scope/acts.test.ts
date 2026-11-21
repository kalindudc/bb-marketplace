// @vitest-environment node
import { expect, it } from "vitest";
import { actsForCommand, ACT_CATALOGUE } from "../../src/scope/acts";
import { draftEditKey } from "../../src/scope/github";
import { shellCommands } from "../../src/scope/shell";
import { evaluate } from "../../src/scope/engine";
import { bindPaths } from "../../src/scope/paths";
import { scopeForClass } from "../../src/scope/presets";
import { narrowAwayScope } from "../../src/server/away/denials";
import { LEGACY_AWAY_STOP_LIST, awayWindowSchema } from "../../src/shared/away";

const closed = awayWindowSchema.parse({
  id: "window", version: 1, closedAt: 1000, until: 2000, returnedAt: null, returnCause: null, note: null, quests: [],
  stopList: [...LEGACY_AWAY_STOP_LIST], allowWatched: false, wakeRules: { blockers: true, productionAsksAfterTwoHours: false },
  eventFloor: 0, eventCeiling: null,
});

const scope = (role: string) => bindPaths({ ...scopeForClass(role), ...(role === "smith" ? { assignedBranch: "feature" } : {}) }, { home: process.env.TAVERN_TEST_FIXTURES!, tmp: ["/tmp"], threadStorage: "/storage", worktree: "/repo", scopesDir: "/scopes" });
const call = (command: string) => ({ kind: "bash" as const, toolName: "bash", cwd: "/repo", input: { command }, containment: "sandbox" as const });
const acts = (command: string) => shellCommands(command, "/repo").flatMap(actsForCommand).map(act => act.kind);
const commands = [
  ["merge", "gh pr merge 1"], ["merge", "dt -R shop/world pr merge 1"],
  ["ready", "gh pr ready 1"], ["ready", "dt pr ready 1"],
  ["close", "gh pr close 1"], ["close", "dt pr close 1"],
  ["review", "gh pr review 1 --approve"], ["review", "dt pr review 1"], ["review", "dt pr approve 1"],
  ["publish", "gh pr comment 1 -b hi"], ["publish", "dt pr comment 1 -b hi"],
  ["publish", "gh pr edit 1 --title hi"], ["publish", "dt pr edit 1 --title hi"],
  ["cluster-write", "kubectl --context x apply -f a"], ["deploy", "quick deploy ./site site"],
  ["cluster-write", "kubectl apply --dry-run=server -f a"], ["cluster-write", "kubectl apply --dry-run=client -f a"],
  ["cluster-write", "kubectl port-forward svc/demo 8080:80"],
  ["cluster-write", "kubectl exec pod -- app --help"], ["cluster-write", "kubectl cp pod:/source ./copy"],
  ["cluster-write", "terraform -chdir=infra apply"], ["cluster-write", "helm upgrade release ./chart"], ["cluster-write", "kapp deploy -a fixture"],
  ["send", "curl -X POST https://example.test"], ["delete", "bb thread delete t"],
  ["configure", "bb plugin install x"], ["credential", "gh auth token"],
  ["allocate", "bb machine create --new-machine x"],
] as const;
it.each(commands)("recognises %s: %s for every class", (kind, command) => {
  expect(acts(command)).toContain(kind);
  for (const role of ["ranger", "warden", "smith", "wanderer", "keeper"]) {
    const decision = evaluate(scope(role), call(command));
    const managed = ["ready", "close", "review"].includes(kind) || /\bpr (?:comment|edit)\b/.test(command);
    expect(decision.allow, role).toBe(kind !== "cluster-write" && !managed && role === "keeper");
    if (role === "keeper" && !managed && kind !== "cluster-write") expect(decision).toMatchObject({ acts: expect.arrayContaining([expect.objectContaining({ kind })]) });
    if (managed && role === "keeper" && kind !== "ready") expect(decision).toMatchObject({ reason: expect.stringContaining("tavern_pull_request") });
  }
});
it.each(["kubectl --context x get pods", "kubectl describe pod web", "kubectl logs web", "kubectl events", "kubectl auth can-i get pods", "kubectl rollout status deployment/demo", "kubectl rollout history deployment/demo", "helm template release ./chart", "cortex update 1175 -m hi", "bb thread spawn --task hi"])("does not catalogue coordination or reads: %s", command => {
  expect(acts(command)).toEqual([]);
  expect(evaluate(scope("keeper"), call(command)).allow).toBe(true);
  if (/^(kubectl|helm|terraform) /.test(command)) expect(evaluate(scope("ranger"), call(command)).allow).toBe(true);
});
it("does not catalogue Terraform plan as a cluster write or run it in a read-only host preset", () => {
  const command = "terraform plan";
  expect(acts(command)).toEqual([]);
  expect(evaluate(scope("ranger"), { ...call(command), containment: undefined })).toMatchObject({ allow: false, ruleId: "readonly-shell" });
});
it.each(["--kubeconfig-context demo", "--kubeconfig ./config", "--yes", "-y", "--yes=false"])("catalogues kapp with global flag %s", flag => {
  expect(acts(`kapp ${flag} deploy -a demo`)).toEqual(["cluster-write"]);
});
it.each([
  "--debug", "--debug=false", "--kube-context demo", "--kubeconfig ./config", "--namespace tools", "-n tools",
  "--burst-limit 100", "--kube-apiserver https://example.test", "--kube-as-group readers", "--kube-as-user demo",
  "--kube-ca-file ./ca", "--kube-insecure-skip-tls-verify", "--kube-tls-server-name example.test", "--kube-token fixture",
  "--qps 10", "--registry-config ./registry.json", "--repository-cache ./cache", "--repository-config ./repos.yaml",
  "--content-cache ./charts", "--color never", "--colour auto",
])("catalogues Helm with global flag %s", flag => {
  expect(acts(`helm ${flag} upgrade release ./chart`)).toEqual(["cluster-write"]);
});
it.each(["--new-machine x", "--machine=x", "--host x", "--environment-provider x", "--project other"])("recognises placement even before subcommands: %s", flag => {
  expect(acts(`bb ${flag} thread spawn --task hi`)).toContain("allocate");
  expect(evaluate(scope("smith"), call(`bb ${flag} thread spawn --task hi`)).allow).toBe(false);
});
it("allows only lease-protected own branch rewrites", () => {
  for (const flag of ["", "--force-with-lease", "--force-with-lease=feature:abc"]) expect(evaluate(scope("smith"), { ...call(`git push ${flag} origin feature`) }).allow).toBe(true);
  for (const command of ["git push --force origin feature", "git push --force-with-lease origin main", "git push --force-with-lease origin other", "git push origin other"]) expect(evaluate(scope("smith"), { ...call(command) }).allow).toBe(false);
  expect(evaluate({ ...scope("smith"), assignedBranch: undefined }, call("git push origin feature")).allow).toBe(false);
});
it.each(commands)("refuses %s during Closing time for every class: %s", (_kind, command) => {
  expect(new Set(commands.map(([kind]) => kind)).size).toBe(ACT_CATALOGUE.filter(act => act.kind !== "tavern-control").length);
  for (const role of ["keeper", "smith", "ranger", "warden", "wanderer"]) expect(evaluate(narrowAwayScope(scope(role), closed), call(command)).allow, role + command).toBe(false);
});
it.each(["gh", "dt"])("grants %s comments and title/body edits only with verified own-head facts", program => {
  for (const action of ["comment 1 -b hi", "edit 1 --title hi --body text"]) {
    const command = program + " pr " + action;
    const key = draftEditKey(shellCommands(command, "/repo")[0]);
    expect(evaluate(scope("smith"), call(command)).allow).toBe(false);
    expect(evaluate(scope("smith"), { ...call(command), ownedPrs: [key] }).allow).toBe(true);
  }
  const reviewers = program + " pr edit 1 --add-reviewer example";
  const key = draftEditKey(shellCommands(reviewers, "/repo")[0]);
  for (const role of ["smith", "keeper", "wanderer"]) {
    expect(evaluate(scope(role), { ...call(reviewers), ownedPrs: [key] })).toMatchObject({ allow: false, reason: expect.stringContaining("tavern_pull_request") });
  }
  expect(evaluate(scope("smith"), call(program + " pr create --draft --head someone-else")).allow).toBe(false);
});
it("keeps project narrowing even when it reuses a legacy rule id", () => {
  const s = scope("smith");
  s.shell.deny.push({ id: "deploy", argv: ["npm", "test"], why: "Project-specific restriction" });
  expect(evaluate(s, call("npm test")).allow).toBe(false);
});
it.each([
  ["dt pr merge 1", "merge", "merge"],
  ["npm publish", "publish", "decision"],
  ["quick deploy ./site demo", "deploy", "production"],
  ["curl -X POST https://example.test", "send", "sends-as-you"],
  ["bb thread delete fixture", "delete", "destructive"],
  ["gh auth token", "credential", "credential"],
])("names the act and ask without stalling unrelated work: %s", (command, kind, ask) => {
  const decision = evaluate(scope("smith"), call(command));
  expect(decision).toMatchObject({ allow: false, act: kind });
  if (decision.allow) throw new Error("Expected a refusal");
  expect(decision.reason).toContain(`needs a ${ask} ask`);
  expect(decision.reason).toContain("Nothing was done.");
  expect(decision.reason).toContain("Tell your Keeper what you need it for and carry on with other work.");
  expect(decision.reason).not.toMatch(/tavern_report|do not try another route/i);
});
