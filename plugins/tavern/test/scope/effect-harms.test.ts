// @vitest-environment node
import { expect, it } from "vitest";
import { evaluate } from "../../src/scope/engine";
import { bindPaths } from "../../src/scope/paths";
import { scopeForClass } from "../../src/scope/presets";

const scope = (role: string) => bindPaths(scopeForClass(role), { home: "/home/me", tmp: ["/tmp"], threadStorage: "/storage", worktree: "/repo", scopesDir: "/scopes" });
const cases = [
  ["smith", "git push origin HEAD:refs/heads/main"],
  ["smith", "git push --force origin feature"],
  ["ranger", "git push origin feature"],
  ["smith", "gh pr merge 123 --squash"],
  ["ranger", "gh pr comment 123 -b fixture"],
  ["ranger", "gh api -X POST repos/o/r/issues -f title=fixture"],
  ["smith", "kubectl --context fixture apply -f x.yaml"],
  ["ranger", "kubectl --context fixture delete pod web"],
  ["ranger", "kubectl exec web -- sh"],
  ["smith", "terraform apply -auto-approve"],
  ["smith", "helm upgrade web ./chart"],
  ["smith", "dev deploy production"],
  ["smith", "npm publish"],
  ["ranger", "curl -X POST https://example.test -d fixture"],
  ["ranger", "gcloud storage cp report.json gs://fixture/report.json"],
  ["ranger", "bb plugin rpc call tavern answerAsk --input-file a.json"],
  ["ranger", "bb tavern ask ask_fixture approve"],
  ["ranger", "bb plugin install fixture"],
  ["ranger", "bb thread delete thr_fixture"],
  ["ranger", "gh auth token"],
  ["ranger", "rm -rf /home/me/src/repo"],
  ["ranger", "echo fixture >> ~/.ssh/authorized_keys"],
  ["smith", "echo fixture > ~/.agents/tavern/scopes.yml"],
];
it.each(cases)("still catches harm for %s: %s", (role, command) => {
  for (const containment of ["sandbox", undefined] as const) expect(evaluate(scope(role), { kind: "bash", toolName: "bash", input: { command }, cwd: "/repo", containment }).allow).toBe(false);
});
it("states the accepted interpreter blind spot rather than claiming subprocess act detection", () => {
  expect(evaluate(scope("ranger"), { kind: "bash", toolName: "bash", input: { command: 'python3 -c "import subprocess; subprocess.run([\'gh\',\'pr\',\'merge\',\'1\'])"' }, cwd: "/repo", containment: "sandbox" }).allow).toBe(true);
});
it.each(["ranger", "warden", "smith", "keeper"])("trusts cortex agent-facing writes for %s", role => {
  for (const command of ["cortex update 17 -m fixture", "bb thread tell thr_fixture fixture"]) for (const containment of ["sandbox", undefined] as const) expect(evaluate(scope(role), { kind: "bash", toolName: "bash", input: { command }, cwd: "/repo", containment }).allow).toBe(true);
});
