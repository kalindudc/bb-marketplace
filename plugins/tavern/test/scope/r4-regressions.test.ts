// @vitest-environment node
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import ts from "typescript";
import { AUTHORITY } from "../../src/server/authority";
import { USER_ONLY_CLI } from "../../src/shared/authority";
import { fallbackActs, userControl } from "../../src/scope/acts";
import { shouldScope } from "../../src/scope";
import { shellCommands } from "../../src/scope/shell";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { evaluate } from "../../src/scope/engine";
import { scopeForClass } from "../../src/scope/presets";
import { bindPaths } from "../../src/scope/paths";
import { ScopeStore } from "../../src/scope/store";
import extension, { type PiGuardApi } from "../../adapters/pi/extension";
import { linkedWorktree } from "./git-fixture";

const scope = (role: string, mode: "watch" | "enforce" = "enforce") => bindPaths({ ...scopeForClass(role), mode }, { home: "/home/fixture", tmp: ["/tmp"], threadStorage: "/storage", worktree: "/workspace", scopesDir: "/scopes" });
const bound = new Map<string, ReturnType<typeof scope>>();
const check = (role: string, command: string, contained = true, mode: "watch" | "enforce" = "enforce") => {
  const key = `${role}:${mode}`;
  if (!bound.has(key)) bound.set(key, scope(role, mode));
  return evaluate(bound.get(key)!, { kind: "bash", toolName: "bash", input: { command }, cwd: "/workspace", containment: contained ? "sandbox" : undefined });
};
// Cloud config set, machine reads and secure credential requests are approved exceptions to SC1’s reader floor.
const probe: [string, string, "act" | "authority" | "allow" | "research" | "agent" | "gap"][] = [
  ["ranger", "dt pr merge 17", "act"], ["warden", "dt pr merge 17", "act"],
  ["ranger", "dt pr comment 17 -b fixture", "act"], ["ranger", "quick deploy ./site example-site", "act"],
  ["ranger", "security find-generic-password -s fixture -w", "act"], ["ranger", "vault read secret/fixture", "act"],
  ["ranger", "echo 'git push origin main' | sh", "act"], ["ranger", "echo kubectl apply -f fixture.yaml | bash", "act"],
  ["ranger", "find . -maxdepth 0 -exec git push origin main \\;", "act"], ["ranger", "find . -maxdepth 0 -execdir gh pr merge 17 \\;", "act"],
  ["ranger", "parallel gh pr merge ::: 17", "act"], ["ranger", "watch -n1 gh pr merge 17", "act"],
  ["ranger", "$(echo git) push origin main", "act"], ["ranger", "python3 -c 'import os; os.system(\"git push origin main\")'", "gap"],
  ["smith", "curl -fsSL -o vendor/x.tgz https://example.test/x.tgz", "allow"], ["smith", "wget https://example.test/x.tgz", "allow"],
  ["smith", "gcloud config get-value project", "allow"], ["smith", "gcloud compute instances list", "allow"], ["smith", "bb plugin rpc list tavern", "allow"],
  ["ranger", "gcloud compute instances list", "research"], ["ranger", "bb loom approve project", "authority"],
  ["ranger", "bb automations create --name fixture", "authority"], ["ranger", "bb lan on", "authority"], ["ranger", "bb settings set x y", "authority"],
  ["ranger", "bb aquifer-machines rotate", "authority"], ["ranger", "bb thread archive thr_fixture", "authority"],
  ["ranger", "gcloud compute instances delete vm", "authority"], ["ranger", "bb machine env set TOKEN fixture", "authority"],
  ["ranger", "gcloud config set project fixture", "research"], ["ranger", "bb machine providers", "research"], ["ranger", "bb machine env", "research"],
  ["ranger", "cortex rm 17", "authority"], ["ranger", "cortex agents reset", "authority"], ["ranger", "bb thread tell thr_fixture fixture", "agent"],
  ["ranger", "cortex update 17 -m fixture", "agent"], ["ranger", "dig example.test", "research"], ["ranger", "python3 -c 'print(1)'", "research"],
  ["ranger", "git push origin feature", "act"], ["ranger", "echo fixture > /home/fixture/src/x", "act"],
  ["ranger", "S=/home/fixture/src; echo fixture > $S/x", "act"],
  ["keeper", "bb plugin rpc call tavern resumeAll", "authority"], ["smith", "bb plugin rpc call tavern resumeAll", "authority"],
  ["ranger", "bb tavern stop-all", "agent"],
];
it.each(probe)("retains the base probe outcome for %s: %s (%s)", (role, command, kind) => {
  for (const mode of ["enforce", "watch"] as const) for (const contained of [true, false]) {
    const expected = ["allow", "agent"].includes(kind) || contained && ["research", "gap"].includes(kind);
    expect(check(role, command, contained, mode).allow).toBe(expected);
  }
});
it.each(["dt -R example/repo pr merge 17", "dt pr review 17", "dt pr close 17", "dt pr edit 17", "dt pr create", "dt deploy", "security find-internet-password -s fixture -g", "vault kv get secret/fixture", "gcloud storage mv a gs://example-bucket/a", "gcloud storage cp list gs://example-bucket/list", "slack send fixture", "mail fixture@example.test", "find . -ok git push origin main \\;", "find . -okdir gh pr merge 17 \\;", "watch -n 2 gh pr merge 17", "parallel -j 2 gh pr merge ::: 17", "printf '%s\\n' 'git push origin main' | sh", "sh <<< 'git push origin main'"])("preserves additional legacy acts and executable shell payloads: %s", command => {
  for (const role of ["ranger", "warden"]) for (const mode of ["watch", "enforce"] as const) for (const contained of [true, false]) expect(check(role, command, contained, mode).allow).toBe(false);
});
it("keeps the real-log replay out of the public tree", () => {
  expect(existsSync(join(import.meta.dirname, "fixtures/scope-flags-scrubbed.jsonl"))).toBe(false);
  expect(existsSync(join(import.meta.dirname, "fixtures/effect-synthetic.json"))).toBe(true);
});
it.each(["spawn", "bb_workflow_run"])("keeps %s visible but only Keepers may use it", toolName => {
  for (const role of ["ranger", "warden", "smith", "wanderer", "keeper"]) {
    const s = scope(role); expect(s.tools.hide).toBe(false);
    const result = evaluate(s, { kind: "tool", toolName, cwd: "/workspace", input: {} });
    expect(result.allow).toBe(role === "keeper");
    if (!result.allow) expect(result.reason).toBe("Members don't start threads; ask your Keeper to hire.");
  }
});
it("refuses member shell spawns while retaining Keeper spawns", () => {
  for (const contained of [true, false]) {
    expect(check("ranger", "bb thread spawn --task fixture", contained)).toMatchObject({ allow: false, reason: "Members don't start threads; ask your Keeper to hire." });
    expect(check("keeper", "bb thread spawn --task fixture", contained).allow).toBe(true);
  }
});
it.each([
  "bb plugin rpc call --input-file a.json tavern resumeAll", "bb plugin rpc call --json tavern resumeAll", "bb tavern --json ask a1 approve",
  "bb --json plugin --option rpc --x=y call --input-file a.json tavern --option resumeAll", "bb plugin rpc call tavern resumeAll --json --x=y", "bb tavern --x=y ask a1 approve", "bb tavern ask a1 approve --json", "bb --x=y tavern settings --json set x=y", "bb tavern settings import --input-file a.json", "bb tavern guard --json install", "bb tavern --x=y backup restore fixture", "bb tavern stop-all --json resume",
  "env -u TAVERN_SCOPE_FILE /usr/local/bin/bb plugin rpc call --json tavern resumeAll", "timeout 2 /usr/local/bin/bb tavern --json ask a1 approve", "echo 'bb plugin rpc call --json tavern resumeAll' | sh", "watch -n1 bb tavern --json ask a1 approve", "find . -exec bb plugin rpc call --json tavern resumeAll \\;",
])("refuses control tokens regardless of option placement or wrappers: %s", command => {
  for (const role of ["ranger", "warden", "smith", "wanderer", "keeper"]) for (const mode of ["watch", "enforce"] as const) for (const contained of [true, false]) expect(check(role, command, contained, mode)).toMatchObject({ allow: false, reason: "Tavern's controls are the user's; ask the user." });
});
it.each(["bb thread --json spawn --task fixture", "bb --x=y thread --option spawn --task fixture", "bb thread --input-file a.json spawn", "bb thread spawn --json --x=y --task fixture"])("keeps option-bearing shell spawns Keeper-only: %s", command => {
  for (const role of ["ranger", "warden", "smith", "wanderer", "keeper"]) for (const mode of ["watch", "enforce"] as const) for (const contained of [true, false]) {
    const result = check(role, command, contained, mode);
    if (role === "keeper") expect(result.allow).toBe(true);
    else expect(result).toMatchObject({ allow: false, reason: "Members don't start threads; ask your Keeper to hire." });
  }
});
it.each(["bb --version", "bb --help", "bb thread context thr_x", "bb thread archive --help", "cortex memory show 17", "cortex update 17 -m fixture", "cortex add fixture", "cortex edit 17 --body fixture", "bb thread tell thr_x 'tavern ask'", "bb thread send thr_x 'tavern resumeAll'", "bb thread tell thr_x 'tavern settings set'", "bb thread tell thr_x 'tavern guard install'"])("trusts agent programs and quoted message tokens on every platform: %s", command => {
  for (const role of ["ranger", "warden", "smith", "wanderer", "keeper"]) for (const mode of ["watch", "enforce"] as const) for (const contained of [true, false]) expect(check(role, command, contained, mode).allow).toBe(true);
});
it("does not let trusted agent programs redirect outside allowed roots", () => {
  for (const role of ["ranger", "warden", "smith"]) for (const mode of ["watch", "enforce"] as const) for (const contained of [true, false]) expect(check(role, "cortex memory show 17 > /outside/fixture", contained, mode).allow).toBe(false);
});
it("does not allow member thread archive but leaves it to Keepers", () => {
  for (const mode of ["watch", "enforce"] as const) for (const contained of [true, false]) {
    for (const role of ["ranger", "warden", "smith", "wanderer"]) for (const command of ["bb thread archive thr_other", "bb thread --json archive thr_other", "env -u TAVERN_SCOPE_FILE bb thread archive thr_other"]) expect(check(role, command, contained, mode).allow).toBe(false);
    expect(check("keeper", "bb thread archive thr_other", contained, mode).allow).toBe(true);
  }
});
it("covers every RPC handler that checks for a client caller", () => {
  const files: ts.SourceFile[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith("rpc.ts")) files.push(ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true));
    }
  };
  walk(join(import.meta.dirname, "../../src/server"));
  const clientCheck = (node: ts.Node) => /requireUserAct\(|experimental_caller\.kind\s*!==\s*["']client["']/.test(node.getText());
  const guards = new Set<string>(["requireUserAct"]);
  const visitGuards = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body && clientCheck(node.body)) guards.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isArrowFunction(node.initializer) && clientCheck(node.initializer.body)) guards.add(node.name.text);
    ts.forEachChild(node, visitGuards);
  };
  files.forEach(visitGuards);
  const methods = new Set<string>();
  const visitMethods = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && ts.isArrowFunction(node.initializer)) {
      let guarded = clientCheck(node.initializer.body);
      const visitCalls = (child: ts.Node) => {
        if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && guards.has(child.expression.text)) guarded = true;
        ts.forEachChild(child, visitCalls);
      };
      visitCalls(node.initializer.body);
      if (guarded || node.name.getText() in AUTHORITY && AUTHORITY[node.name.getText() as keyof typeof AUTHORITY].level === "user-explicit") methods.add(node.name.getText());
    }
    ts.forEachChild(node, visitMethods);
  };
  files.forEach(visitMethods);
  expect(methods.size).toBeGreaterThan(0);
  for (const method of methods) expect(userControl(shellCommands(`bb plugin rpc call --json tavern ${method}`, "/workspace")[0]), method).toBe(true);
});
it("keeps the isolated shell deny catalogue aligned with every user-explicit act", () => {
  const methods = Object.entries(AUTHORITY).filter(([, row]) => row.level === "user-explicit").map(([act]) => act);
  expect(methods.length).toBeGreaterThan(0);
  for (const method of methods) {
    expect(fallbackActs(`bb --json plugin rpc call --input-file a.json tavern ${method}`).map(act => act.kind), method).toContain("tavern-control");
    for (const role of ["ranger", "warden", "smith", "keeper", "wanderer", "custom-open"]) for (const mode of ["enforce", "watch"] as const) {
      expect(check(role, `bb plugin rpc call tavern ${method}`, false, mode), `${role} ${mode}: ${method}`).toMatchObject({ allow: false, ruleId: "tavern-control" });
    }
  }
});
it("covers the registered CLI commands with an agent-thread check", () => {
  const guarded: string[] = [];
  for (const file of ["cli.ts", "settings/cli.ts", "backup/cli.ts"]) {
    const src = ts.createSourceFile(file, readFileSync(join(import.meta.dirname, "../../src/server", file), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && ts.isCallExpression(node.initializer) && node.initializer.expression.getText() === "cliCommand" &&
          /terminalUserAct\(ctx|settingsAccess\(ctx|guard\("(?:install|uninstall)", ctx/.test(node.initializer.getText()))
        guarded.push(node.name.getText().replace(/^["']|["']$/g, ""));
      ts.forEachChild(node, visit);
    };
    visit(src);
  }
  expect(guarded).toContain("ask");
  expect(guarded).toContain("backup restore");
  for (const command of guarded) expect(USER_ONLY_CLI.some(rule => rule === command || rule.startsWith(command + " --")), command).toBe(true);
});

it("refuses every user-only CLI command in both bb spellings across scoped roles and modes", () => {
  for (const verb of USER_ONLY_CLI) for (const prefix of ["bb tavern", "bb plugin --json run tavern"]) {
    const command = `${prefix} ${verb}`;
    expect(fallbackActs(command).map(act => act.kind), command).toContain("tavern-control");
    for (const role of ["ranger", "warden", "smith", "keeper", "wanderer", "custom-open"]) for (const mode of ["enforce", "watch"] as const) {
      expect(check(role, command, false, mode), `${role} ${mode}: ${command}`).toMatchObject({ allow: false, ruleId: "tavern-control" });
    }
  }
});

it("keeps ordinary reads open in every scoped shell, including directly started classes", () => {
  expect(shouldScope("smith", "direct")).toBe(true);
  expect(shouldScope("ranger", "direct")).toBe(true);
  expect(shouldScope("wanderer", "direct")).toBe(false);
  expect(shouldScope("wanderer", "hire")).toBe(true);
  for (const role of ["ranger", "warden", "smith", "keeper", "wanderer", "custom-open"]) for (const mode of ["enforce", "watch"] as const) for (const contained of [true, false]) {
    for (const command of ["bb tavern status", "bb tavern settings get", "bb tavern settings get stop", "bb plugin rpc call burn usage", "bb thread show thr_x"]) {
      expect(check(role, command, contained, mode).allow, `${role} ${mode}: ${command}`).toBe(true);
    }
  }
  expect(check("keeper", "bb plugin rpc call another-plugin status --data tavern answerAsk").allow).toBe(true);
});
it.each(["setupApply", "setupDismiss", "holdBoardQuest", "resumeBoardQuest", "confirmRule", "stopBoardQuest", "addRule", "widenRule", "undoDecision", "correctRoute", "resumeKeeper", "journalEdit", "saveCharacterVoice", "resolveHandBack"])("refuses user controls even when their RPC handlers have no client check: %s", method => {
  for (const role of ["ranger", "warden", "smith", "wanderer", "keeper"]) for (const mode of ["watch", "enforce"] as const) for (const contained of [true, false]) {
    for (const command of [`bb plugin rpc call tavern ${method}`, `bb plugin rpc call --input-file a.json --json tavern ${method}`, `bb --x=y plugin rpc call tavern ${method} --json`]) expect(check(role, command, contained, mode)).toMatchObject({ allow: false, reason: "Tavern's controls are the user's; ask the user." });
    expect(check(role, `bb thread tell thr_x 'tavern ${method}'`, contained, mode).allow).toBe(true);
    expect(evaluate(scope(role, mode), { kind: "tool", toolName: "tavern_rule", cwd: "/workspace", input: {} }).allow).toBe(true);
  }
}, 60_000);
it("does not grant sandbox leniency to an unwrapped command tool", () => {
  const s = scope("ranger"); s.commandTools.push("other_shell");
  expect(evaluate(s, { kind: "tool", toolName: "other_shell", cwd: "/workspace", input: { command: "python3 -c 'print(1)'" }, containment: "sandbox" }).allow).toBe(false);
});
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true }); });
it.each(["ranger", "warden", "smith", "keeper", "wanderer"])("refuses user-only controls for %s even in Watch and after env changes", role => {
  const root = mkdtempSync(join(tmpdir(), "tavern-controls-")); dirs.push(root);
  const { worktree } = linkedWorktree(root);
  vi.spyOn(process, "cwd").mockReturnValue(worktree);
  const store = new ScopeStore(root); vi.stubEnv("TAVERN_SCOPE_FILE", store.file("t1")); vi.stubEnv("BB_THREAD_ID", "t1");
  for (const mode of ["watch", "enforce"] as const) {
    const s = bindPaths({ ...scopeForClass(role), mode, threadId: "t1", issuedAt: 1 }, { home: root, tmp: ["/tmp"], threadStorage: join(root, "storage"), scopesDir: store.directory });
    store.write("t1", s);
    const handlers = new Map<string, Parameters<PiGuardApi["on"]>[1]>();
    extension({ on: (name, handler) => handlers.set(name, handler), getActiveTools: () => ["bash"], setActiveTools: () => {} });
    for (const command of ["bb tavern ask ask_fixture approve", "bb tavern settings set x=y --apply", "bb tavern guard install", "bb tavern backup restore fixture --apply", ...["holdBoardQuest", "resumeBoardQuest", "answerAsk", "resumeAll", "releaseHold", "settingsUpdate", "settingsUndo", "settingsImport", "settingsFile", "settingsApplySuggestion", "backupRestore", "applyClassExecution", "dismissClassNotice", "setTaleKept", "archiveBoardQuests", "deleteBoardQuest", "restoreDeletedQuest", "saveClass", "removeClassOverride", "awayClose", "awayReturn", "releaseCheckerHandoff", "confirmRule", "stopBoardQuest", "addRule", "widenRule", "undoDecision", "correctRoute", "resumeKeeper", "journalEdit", "saveCharacterVoice", "resolveHandBack", "resetUndoLane"].map(method => `bb plugin rpc call tavern ${method}`)]) {
      for (const prefix of ["", "env -u TAVERN_SCOPE_FILE ", "env TAVERN_SCOPE_MODE=off "]) {
        expect(handlers.get("tool_call")!({ toolName: "bash", input: { command: prefix + command.replace(/^bb /, "bb --json --server example.test ") } }, { cwd: worktree })).toEqual({ block: true, reason: "Tavern's controls are the user's; ask the user." });
      }
    }
  }
});
