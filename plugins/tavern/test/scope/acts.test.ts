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

const scope = (role: string) => bindPaths({ ...scopeForClass(role), ...(role === "smith" ? { assignedBranch: "feature" } : {}) }, { home: "/home/me", tmp: ["/tmp"], threadStorage: "/storage", worktree: "/repo", scopesDir: "/scopes" });
const call = (command: string) => ({ kind: "bash" as const, toolName: "bash", cwd: "/repo", input: { command }, containment: "sandbox" as const });
const acts = (command: string) => shellCommands(command, "/repo").flatMap(actsForCommand).map(act => act.kind);
const commands = [
  ["merge", "gh pr merge 1"], ["merge", "dt -R shop/world pr merge 1"],
  ["ready", "gh pr ready 1"], ["ready", "dt pr ready 1"],
  ["close", "gh pr close 1"], ["close", "dt pr close 1"],
  ["review", "gh pr review 1 --approve"], ["review", "dt pr review 1"], ["review", "dt pr approve 1"],
  ["publish", "gh pr comment 1 -b hi"], ["publish", "dt pr comment 1 -b hi"],
  ["publish", "gh pr edit 1 --title hi"], ["publish", "dt pr edit 1 --title hi"],
  ["deploy", "kubectl --context x apply -f a"], ["deploy", "quick deploy ./site site"],
  ["send", "curl -X POST https://example.test"], ["delete", "bb thread delete t"],
  ["configure", "bb plugin install x"], ["credential", "gh auth token"],
  ["allocate", "bb machine create --new-machine x"],
] as const;
it.each(commands)("recognises %s: %s for every class", (kind, command) => {
  expect(acts(command)).toContain(kind);
  for (const role of ["ranger", "warden", "smith", "wanderer", "keeper"]) {
    const decision = evaluate(scope(role), call(command));
    expect(decision.allow, role).toBe(role === "keeper" || role === "wanderer");
    if (role === "keeper") expect(decision).toMatchObject({ acts: expect.arrayContaining([expect.objectContaining({ kind })]) });
  }
});
it.each(["kubectl --context x get pods", "cortex update 1175 -m hi", "bb thread spawn --task hi"])("does not catalogue coordination or reads: %s", command => {
  expect(acts(command)).toEqual([]);
  expect(evaluate(scope("keeper"), call(command)).allow).toBe(true);
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
  expect(evaluate(scope("smith"), call(program + " pr create --draft --head someone-else")).allow).toBe(false);
});
it("keeps project narrowing even when it reuses a legacy rule id", () => {
  const s = scope("smith");
  s.shell.deny.push({ id: "deploy", argv: ["npm", "test"], why: "Project-specific restriction" });
  expect(evaluate(s, call("npm test")).allow).toBe(false);
});
it("never tells a recorded act not to try another route", () => {
  const s = scope("smith"); s.mode = "watch";
  const decision = evaluate(s, call("dt pr merge 1"));
  expect(decision).toMatchObject({ allow: false });
  if (!decision.allow) expect(decision.reason).not.toContain("do not try another route");
});
