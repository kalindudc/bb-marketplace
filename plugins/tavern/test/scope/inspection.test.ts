// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { evaluate, readonlyProgram } from "../../src/scope/engine";
import { bindPaths, realPath } from "../../src/scope/paths";
import { prepareCall } from "../../src/scope/prepare";
import { scopeForClass } from "../../src/scope/presets";
import { shellCommands } from "../../src/scope/shell";
import { linkedWorktree } from "./git-fixture";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const inspections = [
  "od -c input", "od -An -tx1 input", "tail -c 20 input | od -c | tail -3",
  "xxd input", "xxd -g 1 -l 32 input", "xxd -s+8 -c16 input", "xxd -n byte_array -i input", "xxd -R never input", "xxd -r input.hex", "xxd input -", "xxd input /dev/null", "xxd -- -input",
  "hexdump -C input", "hexdump -n 20 input", "file input", "file -b --mime-type input", "file -- -C", "file -m -C input", "file -bm-C input", "file --magic-file=-C input", "stat input", "stat -f '%z' input",
];
it.each(inspections)("recognizes stdout-only inspection: %s", source => {
  expect(shellCommands(source, process.cwd()).every(readonlyProgram)).toBe(true);
});
it.each([
  "xxd input output", "xxd -r input output", "xxd input -p", "xxd -l 16 input output", "xxd -r -s 8 input output", "xxd -n name -i input output", "xxd -R never input output", "xxd -- input output", "xxd -unknown input", "xxd -l",
  "file -C", "file -bC -m magic", "file --compile -m magic", "file --comp -m magic", "file input --compile",
])("does not classify output-file or compile modes as reads: %s", source => {
  expect(shellCommands(source, process.cwd()).every(readonlyProgram)).toBe(false);
});
it.each(["ranger", "keeper", "warden"])("permits inspection but not writes with an unproven cwd for %s", role => {
  const root = realPath(mkdtempSync(join(tmpdir(), "tavern-inspection-"))); roots.push(root);
  const { worktree } = linkedWorktree(root), scratch = join(root, "scratch"); mkdirSync(scratch); writeFileSync(join(worktree, "input"), "inspect\n");
  const scope = bindPaths(scopeForClass(role, undefined, role === "keeper" ? "keeper" : undefined), { home: root, tmp: [scratch], scopesDir: join(root, "scopes") });
  if (role === "warden") scope.checks = { worktree, commands: [] };
  const check = (source: string) => evaluate(scope, prepareCall({ kind: "bash", toolName: "bash", cwd: worktree, input: { command: source } }, { scope }));
  for (const source of inspections) expect(check(`W='${worktree}'; cd $W && ${source}`), source).toEqual({ allow: true });
  expect(check("W=unknown; cd $W && touch tracked").allow).toBe(false);
  expect(check("W=unknown; cd $W && npm test").allow).toBe(false);
  expect(check("W=unknown; cd $W && xxd input output").allow).toBe(false);
  expect(check("W=unknown; cd $W && file -C -m magic").allow).toBe(false);
  expect(check("od -c input > input").allow).toBe(false);
  if (role === "warden") {
    expect(check(`cd '${worktree}' && npm test`)).toEqual({ allow: true, check: true });
    expect(check(`cd '${scratch}' && npm test`).allow).toBe(false);
  }
});
