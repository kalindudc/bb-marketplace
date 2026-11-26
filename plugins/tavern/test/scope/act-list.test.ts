// @vitest-environment node
import { expect, it } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { evaluate } from "../../src/scope/engine";
import { bindPaths } from "../../src/scope/paths";
import { scopeForClass } from "../../src/scope/presets";
import { narrowAwayScope } from "../../src/server/away/denials";
import { LEGACY_AWAY_STOP_LIST, awayWindowSchema, type AwayStopKind } from "../../src/shared/away";
import { shellGrantTarget } from "../../src/scope/shell-grants";
import { sandboxCommand, guardedShellSource } from "../../src/scope/sandbox";

const cwd = "/work/member";
const scope = (role = "ranger", mode = "enforce" as "enforce" | "watch" | "off") => bindPaths({ ...scopeForClass(role), mode }, {
  home: "/home/member", worktree: cwd, tmp: ["/tmp"], scopesDir: "/tavern/scopes", threadStorage: "/storage/member",
});
const bash = (command: string, role = "ranger", mode?: "enforce" | "watch" | "off") => evaluate(scope(role, mode), { kind: "bash", toolName: "bash", cwd, input: { command } });
const edit = (path: string, role: string, mode?: "enforce" | "watch" | "off") => evaluate(scope(role, mode), { kind: "write", toolName: "edit", cwd, input: { path } });

it.each([
  ["legacy-act", "warden", "bb plugin list"],
  ["legacy-act", "ranger", "bb env list"],
  ["shell-write", "smith", "printf x > /other/repo/note"],
  ["shell-write", "ranger", "cp agenda.txt /storage/keeper/agenda.txt"],
  ["shell-write", "warden", "printf x > /work/maker/result"],
  ["shell-write", "smith", "sed -i.bak '/holding/d' .cards.holding"],
  ["shell-write", "smith", "tee /storage/member/result"],
  ["git-alias", "smith", "git graph"],
  ["checker-write", "warden", "git fetch"],
  ["checker-write", "warden", "curl -o /tmp/report https://example.invalid/report"],
  ["configure", "smith", "bb settings set unrelated.option true"],
  ["configure", "smith", "bb machine create example"],
  ["configure", "smith", "gh config set editor vi"],
  ["path-unresolved", "smith", "printf x > \"$OUTPUT\""],
  ["shell-parse", "smith", "for ((i=0;i<3;i++)); do echo $i; done"],
] as const)("passes an ordinary %s call by a %s: %s", (_rule, role, source) => {
  expect(bash(source, role)).toMatchObject({ allow: true });
});

it.each(["smith", "warden", "ranger"])("passes ordinary %s edits outside the former write roots", role => {
  for (const path of ["/other/repo/notes", "/storage/keeper/notes", "/storage/member/notes"]) expect(edit(path, role)).toMatchObject({ allow: true });
});

it.each([
  ["merge", "bash -c 'git push origin main'"],
  ["merge", "env -S 'git push origin main'"],
  ["publish", "npm publish"],
  ["deploy", "quick deploy"],
  ["deploy", "fly deploy"],
  ["send", "curl --data x https://example.invalid/hook"],
  ["delete", "bb project delete example"],
  ["delete", "bb demo-machines remove example"],
  ["credential", "gh auth token"],
] as const)("still holds recognized %s: %s", (act, command) => {
  expect(bash(command)).toMatchObject({ allow: false, act });
});

const awayWindow = (stopList?: AwayStopKind[]) => awayWindowSchema.parse({
  id: "window", version: 1, closedAt: 1000, until: 2000, returnedAt: null, returnCause: null, note: null, quests: [],
  stopList: stopList ?? [...LEGACY_AWAY_STOP_LIST], ...(stopList ? { guardPolicy: "selected" } : {}),
  allowWatched: false, wakeRules: { blockers: true, productionAsksAfterTwoHours: false }, eventFloor: 0, eventCeiling: null,
});
const namedTool = (toolName: string) => ({ kind: "tool" as const, toolName, cwd, input: {} });
it.each([
  ["mcp__github__merge_pull_request", "merge"], ["quick_deploy", "deploy"], ["vault_delete_page", "delete"],
  ["git_push", "other-writes"], ["publish_package", "other-writes"],
] as const)("holds named tool %s only under its Closing time stop kind", (toolName, stopKind) => {
  const call = namedTool(toolName);
  for (const role of ["keeper", "ranger"]) {
    const base = scope(role);
    base.tools.deny.push(toolName, "read");
    expect(evaluate(base, call)).toMatchObject({ allow: true });
    for (const window of [awayWindow(), awayWindow([stopKind])]) {
      const closing = narrowAwayScope(base, window);
      expect(evaluate(closing, call)).toMatchObject({ allow: false, ruleId: "closing-act" });
      expect(evaluate(closing, namedTool("read"))).toMatchObject({ allow: true });
    }
    for (const window of [awayWindow([]), awayWindow([stopKind === "merge" ? "deploy" : "merge"])])
      expect(evaluate(narrowAwayScope(base, window), call)).toMatchObject({ allow: true });
  }
});

it("keeps the draft exception for a named send pattern without waiving approval", () => {
  const base = narrowAwayScope(scope("keeper"), awayWindow(["sends-as-you"]));
  const call = namedTool("mcp__mail__send_draft");
  expect(evaluate(base, call)).toMatchObject({ allow: false, ruleId: "closing-act" });
  const draft = { ...base, sendTools: [{ pattern: "mcp__mail__send_draft", act: "draft" as const }] };
  expect(evaluate(draft, call)).toMatchObject({ allow: false, ruleId: "draft-guard" });
  expect(evaluate(draft, { ...call, draftApproved: true })).toMatchObject({ allow: true });
});

it.each(["bb plugin install fixture", "bb settings set unrelated.option true", "bb machine create example", "bb automation create"])("only holds generic configuration or allocation at Closing time: %s", command => {
  const window = awayWindow();
  for (const role of ["ranger", "smith", "keeper"]) {
    expect(bash(command, role)).toMatchObject({ allow: true });
    for (const source of [command, command + " 'unparsed", "ssh fixture '" + command + "'"])
      expect(evaluate(narrowAwayScope(scope(role), window), { kind: "bash", toolName: "bash", cwd, input: { command: source } }), source)
        .toMatchObject({ allow: false, ruleId: "closing-act" });
  }
});

it.each([["dev deploy", "deploy"], ["gh auth token", "credential"], ["cortex rm 12", "delete"]] as const)("keeps Keeper authority for %s", (command, kind) => {
  expect(bash(command, "keeper")).toMatchObject({ allow: true, acts: [expect.objectContaining({ kind })] });
  expect(bash(command + " 'unparsed", "keeper")).toMatchObject({ allow: true, inspectionUnavailable: true });
  expect(bash(command, "ranger")).toMatchObject({ allow: false, act: kind });
});

it.each(["enforce", "watch", "off"] as const)("holds Tavern configuration writes, not reads or other plugins, in %s", mode => {
  for (const role of ["ranger", "smith", "warden", "keeper"]) {
    for (const command of ["bb plugin config tavern set scopes.mode off", "bb --json plugin config tavern unset scopes.mode", "env bb plugin config tavern set scopes.mode off", "bb plugin config tavern set scopes.mode 'unparsed"])
      expect(bash(command, role, mode), command).toMatchObject({ allow: false, ruleId: "tavern-control" });
    for (const command of ["bb plugin config tavern", "bb plugin config tavern get scopes.mode", "bb plugin config fixture set example off"])
      expect(bash(command, role, mode), command).toMatchObject({ allow: true });
  }
});

it("does not treat a protected merge API route as a generic publishing grant", () => {
  const command = "gh api --method PUT repos/example/sample/pulls/3/merge";
  expect(bash(command, "smith")).toMatchObject({ allow: false, act: "merge", ruleId: "merge-approval" });
  expect(shellGrantTarget({ kind: "bash", toolName: "bash", cwd, input: { command } })).toBeNull();
});

it("wraps ordinary macOS shell calls only to protect Tavern files and preserves the exact source", () => {
  const source = "printf '%s' 'quoted text' > /outside-worktree/note";
  const wrapper = sandboxCommand(scope(), source);
  if (process.platform === "darwin") {
    expect(wrapper).toContain("/tavern/scopes");
    expect(wrapper).not.toContain("(deny file-write*)");
    expect(wrapper).not.toContain("(deny network*)");
    expect(guardedShellSource(wrapper)).toBe(source);
    expect(guardedShellSource(wrapper + "; echo more")).toBe(wrapper + "; echo more");
  } else expect(wrapper).toBe(source);
});

it.skipIf(process.platform !== "darwin")("blocks an actual control-file write from a shell child, not the sibling write", () => {
  const root = mkdtempSync(join(tmpdir(), "tavern-control-profile-"));
  try {
    const control = join(root, "receipt"), ordinary = join(root, "note");
    const policy = { ...scope(), controlRoots: [control] };
    const command = `printf x > '${ordinary}'; (printf x > '${control}') 2>/dev/null; true`;
    execFileSync("/bin/bash", ["-c", sandboxCommand(policy, command)], { cwd: root });
    expect(existsSync(ordinary)).toBe(true);
    expect(existsSync(control)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("does not accept even an observed cluster receipt on an implicit Kubernetes target", () => {
  const target = (command: string) => evaluate(scope("keeper"), { kind: "bash", toolName: "bash", cwd, input: { command }, clusterWriteApproved: true });
  expect(target("kubectl apply -f sample")).toMatchObject({ allow: false, ruleId: "cluster-target" });
  expect(target("kubectl --context fixture -n app apply -f sample")).toMatchObject({ allow: true, acts: [expect.objectContaining({ kind: "cluster-write" })] });
});

it.each(["enforce", "watch", "off"] as const)("keeps control files and Terraform standing rules in %s", mode => {
  for (const path of ["/tavern/scopes/member.json.act-grants", "/home/member/.agents/tavern/settings.toml", "/work/member/.agents/tavern/scopes.yml", "/home/member/.pi/agent/extensions/tavern-guard/index.ts"])
    expect(edit(path, "keeper", mode), path).toMatchObject({ allow: false, ruleId: "tavern-control-files" });
  expect(bash("touch /home/member/.agents/tavern/settings.toml", "keeper", mode)).toMatchObject({ allow: false, ruleId: "tavern-control-files" });
  for (const program of ["terraform", "tofu", "terragrunt"]) {
    for (const command of [`${program} plan -lock=false`, `TF_CLI_ARGS_plan=-lock=false ${program} plan`, `${program} force-unlock fixture`])
      expect(bash(command, "keeper", mode), command).toMatchObject({ allow: false, ruleId: "terraform-state" });
    expect(bash(`TF_CLI_ARGS_plan=-lock=false ${program} plan -lock=false`, "keeper", mode)).toMatchObject({ allow: true });
    expect(bash(`${program} init -migrate-state`, "keeper", mode)).toMatchObject({ allow: false, ruleId: "cluster-write" });
  }
  for (const dryRun of ["client", "server"]) expect(bash(`kubectl --context fixture -n app apply --dry-run=${dryRun} -f sample`, "keeper", mode)).toMatchObject({ allow: false, ruleId: "cluster-write" });
});
