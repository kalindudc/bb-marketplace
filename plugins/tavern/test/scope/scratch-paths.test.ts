// @vitest-environment node
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { evaluate, type ScopeCall } from "../../src/scope/engine";
import { bindPaths, realPath, writeAllowed, writeRoots } from "../../src/scope/paths";
import { prepareCall } from "../../src/scope/prepare";
import { scopeForClass } from "../../src/scope/presets";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(role = "warden") {
  const root = realPath(mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES!, "scratch-reads-")));
  roots.push(root);
  const vars = { home: root, scopesDir: join(root, "policy"), tmp: [join(root, "tmp")], worktree: join(root, "work"),
    threadStorage: join(root, "threads/member"), keeperScratch: join(root, "threads/keeper/scratch/quest_demo") };
  for (const path of [vars.tmp[0], vars.worktree, vars.threadStorage, vars.keeperScratch, vars.scopesDir]) mkdirSync(path, { recursive: true });
  const base = scopeForClass(role);
  const bound = () => bindPaths(base, vars, realPath);
  const run = (scope: ReturnType<typeof bound>, call: Partial<ScopeCall>) => evaluate(scope, prepareCall({ cwd: vars.worktree, kind: "tool", toolName: "bash", input: {}, ...call }, { scope }));
  const shell = (command: string, scope = bound()) => run(scope, { input: { command } });
  const write = (path: string, scope = bound()) => run(scope, { toolName: "write", input: { path } });
  return { vars, base, bound, shell, write };
}

it("follows a relocated grant through either name without following a replacement symlink", () => {
  const { vars, base, bound, write, shell } = fixture("smith");
  const oldRoot = join(vars.home, "original"), moved = join(vars.home, "relocated"), outside = join(vars.home, "unrelated");
  mkdirSync(oldRoot); mkdirSync(outside);
  base.writes.allow.push(oldRoot + "/**");
  base.writes.deny.push(join(oldRoot, "protected"));
  const scope = bound();
  renameSync(oldRoot, moved); symlinkSync(moved, oldRoot);
  for (const root of [oldRoot, moved]) {
    expect(write(join(root, "new/file"), scope).allow).toBe(true);
    expect(shell(`printf x > '${root}/new/file'`, scope).allow).toBe(true);
    expect(writeAllowed(scope, join(root, "protected/file"), vars.worktree)).toBe(false);
    expect(write(join(root, "protected/file"), scope).allow).toBe(true);
  }
  expect(writeRoots(scope)).toContain(moved + "/**");
  rmSync(oldRoot); symlinkSync(outside, oldRoot);
  expect(writeAllowed(scope, join(oldRoot, "file"), vars.worktree)).toBe(false);
  expect(writeAllowed(scope, join(outside, "file"), vars.worktree)).toBe(false);
  expect(writeRoots(scope)).not.toContain(outside + "/**");
});

it("preserves scratch grants and allows ordinary sibling storage writes, but protects linked controls", () => {
  const { vars, base, write, shell } = fixture();
  base.writes.allow = [];
  for (const dir of [vars.threadStorage, vars.keeperScratch]) {
    expect(write(join(dir, "notes.txt")).allow).toBe(true);
    expect(shell(`printf x > '${dir}/notes.txt'`).allow).toBe(true);
  }
  for (const dir of [join(vars.home, "threads/other"), join(vars.home, "threads/keeper/private"), join(vars.keeperScratch, "../quest_other")])
    expect(write(join(dir, "notes.txt")).allow).toBe(true);
  symlinkSync(vars.scopesDir, join(vars.keeperScratch, "escape"));
  expect(write(join(vars.keeperScratch, "escape/out"))).toMatchObject({ ruleId: "tavern-control-files" });
});

it.each([false, true])("does not grant a replacement thread storage target after rebind (narrowed: %s)", (narrowed) => {
  const { vars, base, bound, write, shell } = fixture();
  if (narrowed) base.writes.allow = [];
  const parent = dirname(vars.threadStorage), physicalParent = join(vars.home, "physical-threads");
  renameSync(parent, physicalParent);
  symlinkSync(physicalParent, parent);
  expect(write(join(vars.threadStorage, "note.txt"), bound()).allow).toBe(true);

  const target = join(vars.home, "other-data");
  mkdirSync(target);
  renameSync(vars.threadStorage, join(physicalParent, "previous-storage"));
  symlinkSync(target, vars.threadStorage);
  const rebound = bound();
  for (const dir of [vars.threadStorage, target]) {
    const file = join(dir, "note.txt");
    expect(writeAllowed(rebound, file, vars.worktree)).toBe(false);
    expect(write(file, rebound).allow).toBe(true);
    expect(shell(`printf x > '${file}'`, rebound).allow).toBe(true);
  }
  expect(writeRoots(rebound)).not.toContain(target);
});

it("passes mktemp templates under scratch and the worktree", () => {
  const { vars, shell } = fixture();
  expect(shell(`d=$(mktemp -d '${vars.tmp[0]}/check.XXXXXX') && touch "$d/result"`).allow).toBe(true);
  expect(shell(`d=$(mktemp -d '${vars.worktree}/check.XXXXXX') && touch "$d/result"`).allow).toBe(true);
});
