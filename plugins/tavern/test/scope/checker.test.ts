// @vitest-environment node
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { scopeForClass } from "../../src/scope/presets";
import { evaluate } from "../../src/scope/engine";
import { prepareCall } from "../../src/scope/prepare";
import { bindPaths, realPath } from "../../src/scope/paths";
import { scopeSchema, type Scope } from "../../src/scope/schema";
import { sandboxCommand, sandboxProfile } from "../../src/scope/sandbox";
import { emulatedGit } from "../host/emulated-git";
import { checkerWritePaths } from "../../src/scope/checker";
import { linkedWorktree } from "./git-fixture";
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "tavern-checker-"))); roots.push(root);
  const { main, worktree, git } = linkedWorktree(root), scratch = join(root, "scratch"), outside = join(root, "outside");
  for (const path of [scratch, outside, join(worktree, "nested")]) mkdirSync(path);
  const scope: Scope & { checks: { worktree?: string; commands: string[] } } = { ...bindPaths(scopeForClass("warden"), { home: root, tmp: [scratch], scopesDir: join(root, "scopes") }), checks: { worktree, commands: [] } };
  const call = (command: string, cwd = worktree) => prepareCall({ kind: "bash", toolName: "bash", input: { command }, cwd }, { scope });
  const run = (command: string, cwd = worktree) => evaluate(scope, call(command, cwd));
  return { root, main, worktree, scratch, outside, scope, git, call, run };
}
it("reports a refused Git listing to the Warden instead of treating it as an empty list", () => {
  const f = fixture();
  vi.stubEnv("PATH", emulatedGit(f.root, true) + ":" + process.env.PATH);
  expect(() => checkerWritePaths(f.scope)).toThrow(/git .*ls-files --cached -z[\s\S]*ls-files --cached refused/);
});
it("gives Wardens checker while preserving readonly Ranger and open Keeper defaults", () => {
  expect(scopeForClass("warden").preset).toBe("checker"); expect(scopeForClass("ranger").preset).toBe("readonly"); expect(scopeForClass("keeper").preset).toBe("open");
  const f = fixture(); expect(scopeSchema.safeParse(f.scope).success).toBe(true);
});
it.each([
  "npm test", "pnpm test", "yarn test", "bun test", "npm run test", "npm run check", "npm run lint", "npm run typecheck", "pnpm run check", "yarn run lint", "bun run typecheck", "npm run build", "npm run verify:all", "npx vitest run", "npx vitest run test/unit.test.ts", "npx vitest run --reporter=dot", "npx tsc", "npx tsc --build", "npx tsc --noEmit false", "npx tsc --noEmit --noEmit=false", "npx tsc -p tsconfig.json --noEmit", "tsc", "tsc --noEmit", "node_modules/.bin/tsc", "vitest run", "node_modules/.bin/vitest run", "jest", "node_modules/.bin/jest --ci", "node node_modules/vitest/vitest.mjs run", "node node_modules/.bin/jest --ci", "pytest", "pytest -q", "go test ./...", "cargo test", "cd nested && npm test",
])("allows a project check only with check metadata: %s", command => {
  expect(fixture().run(command)).toMatchObject({ allow: true, check: true });
});
it.each(["npm publish", "yarn publish", "pnpm publish", "bun publish", "git add .", "git commit -m no", "git push origin topic", "gh pr merge 1", "gh api -X POST repos/o/r/issues", "kubectl apply -f x.yaml", "dev deploy", "terraform apply", "curl -X POST https://example.invalid"])("still refuses consequential commands: %s", command => {
  expect(fixture().run(command).allow).toBe(false);
});
it.each(["npm install", "npx vitest --update", "npx vitest", "vitest --update", "npx eslint .", "node scripts/verify.mjs", "node node_modules/../fixture.mjs", "npm run build --prefix ../outside", "npm run --prefix ../outside build", "npm --workspace ../outside run test", "npm test --prefix ../outside", "npm --prefix ../outside test"])("does not mark other commands as recognised checks: %s", command => {
  expect(fixture().run(command)).toEqual({ allow: true });
});
it("marks exact done-when commands and cd prefixes without marking commands that only share a prefix", () => {
  const f = fixture(); f.scope.checks.commands = ['node --test "test/a file.test.js"', "make verify && node --test"];
  expect(f.run('node --test "test/a file.test.js"')).toMatchObject({ allow: true, check: true });
  expect(f.run('cd nested && node --test "test/a file.test.js"')).toMatchObject({ allow: true, check: true });
  expect(f.run("make verify && node --test")).toMatchObject({ allow: true, check: true });
  expect(f.run("node --test test/other.js")).toEqual({ allow: true });
  expect(f.run('node --test "test/a file.test.js"; npm publish').allow).toBe(false);
  f.scope.checks.commands.push("git add .", "npm publish", "curl -X POST https://example.invalid");
  for (const command of f.scope.checks.commands.slice(-3)) expect(f.run(command).allow).toBe(false);
});
it("requires an explicit maker root, canonical cwd and a proven directory for check execution", () => {
  const f = fixture();
  expect(f.run("npm test", f.outside).allow).toBe(false); expect(f.run("cd ../outside && npm test").allow).toBe(false);
  symlinkSync(f.outside, join(f.worktree, "escape")); expect(f.run("cd escape && npm test").allow).toBe(false);
  expect(f.run('cd "$UNKNOWN" && npm test').allow).toBe(false);
  delete f.scope.checks.worktree; expect(f.run("npm test").allow).toBe(false); expect(f.run("git status", f.outside).allow).toBe(true);
});
it.each(["./gradlew test", "java -version"])("lets an uncontained Warden run %s without a check-runner grant", command => {
  expect(fixture().run(command)).toEqual({ allow: true });
});
it("still blocks uncontained Warden Git commits and redirects to tracked files", () => {
  const f = fixture();
  writeFileSync(join(f.worktree, "tracked.txt"), "original");
  f.git(f.worktree, "add", "tracked.txt");
  expect(f.run("git commit -m no")).toMatchObject({ allow: false, ruleId: "checker-write" });
  expect(f.run("printf changed > tracked.txt")).toMatchObject({ allow: false, ruleId: "shell-write" });
});
it("keeps native writes in the checker worktree blocked", () => {
  const f = fixture();
  expect(evaluate(f.scope, { kind: "write", toolName: "write", input: { path: join(f.worktree, "tracked") }, cwd: f.worktree })).toMatchObject({ allow: false, ruleId: "write-path" });
});
it("fails closed rather than allowing a pre-existing hardlink alias to a tracked file", () => {
  const f = fixture(); writeFileSync(join(f.worktree, "tracked"), "original"); writeFileSync(join(f.worktree, ".gitignore"), "coverage/\\n");
  f.git(f.worktree, "add", "tracked", ".gitignore"); mkdirSync(join(f.worktree, "coverage")); linkSync(join(f.worktree, "tracked"), join(f.worktree, "coverage/alias"));
  expect(() => sandboxProfile(f.scope, true)).toThrow(/hard.link/i);
});
it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))("runs real npm test but denies tracked files, Git metadata, unignored/outside writes and network", async () => {
  const f = fixture(), tracked = join(f.worktree, "tracked.txt"), kept = join(f.worktree, "dist/keep.txt");
  for (const path of ["dist", ".cache", "odd*output", "oddXoutput"]) mkdirSync(join(f.worktree, path));
  writeFileSync(join(f.worktree, ".gitignore"), "node_modules/\ndist/\ncoverage/\n.cache/\nodd\\*output/\n");
  writeFileSync(tracked, "original"); writeFileSync(kept, "kept");
  const gitDir = realPath(f.git(f.worktree, "rev-parse", "--path-format=absolute", "--git-dir").trim());
  const common = realPath(f.git(f.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir").trim());
  writeFileSync(join(f.worktree, "package.json"), JSON.stringify({ scripts: { test: "node verify.cjs" } }));
  writeFileSync(join(f.worktree, "verify.cjs"), `const fs=require('fs'),assert=require('assert');
assert.throws(()=>fs.writeFileSync('node_modules','not a directory'),e=>['EPERM','EACCES'].includes(e.code));
fs.mkdirSync('node_modules',{recursive:true});fs.writeFileSync('node_modules/cache','ok');
fs.mkdirSync('coverage',{recursive:true});fs.writeFileSync('coverage/result.txt','ok');
fs.writeFileSync('odd*output/cache','ok');assert.throws(()=>fs.writeFileSync('oddXoutput/bad','bad'),e=>['EPERM','EACCES'].includes(e.code));
fs.symlinkSync('../tracked.txt','coverage/softlink');assert.throws(()=>fs.writeFileSync('coverage/softlink','bad'),e=>['EPERM','EACCES'].includes(e.code));
assert.throws(()=>fs.linkSync('tracked.txt','coverage/hardlink'),e=>['EPERM','EACCES'].includes(e.code));
for(const path of ${JSON.stringify([tracked, kept, join(f.worktree, ".git"), join(gitDir, "index"), join(common, "config"), join(f.outside, "bad"), join(f.worktree, "not-ignored")])}){assert.throws(()=>fs.writeFileSync(path,'bad'),e=>['EPERM','EACCES'].includes(e.code),path);}
assert.throws(()=>fs.renameSync('dist','.cache/moved'),e=>['EPERM','EACCES'].includes(e.code));
console.log('CHECKER_OK');`);
  f.git(f.worktree, "add", ".gitignore", "tracked.txt", "package.json", "verify.cjs"); f.git(f.worktree, "add", "-f", "dist/keep.txt"); f.git(f.worktree, "commit", "-qm", "checker fixture");
  for (const name of ["user.npmrc", "global.npmrc"]) writeFileSync(join(f.root, name), "");
  const before = readFileSync(join(gitDir, "index"));
  expect(f.run("npm test")).toMatchObject({ allow: true, check: true });
  f.scope.writes.allow.push(f.root, f.root + "/*");
  expect(sandboxProfile(f.scope)).not.toContain("(deny network*)");
  const wrapped = sandboxCommand(f.scope, "npm test", true);
  const result = spawnSync("/bin/bash", ["-c", wrapped], { cwd: f.worktree, encoding: "utf8", env: { ...process.env, TMPDIR: f.scratch, npm_config_cache: join(f.scratch, "npm"), npm_config_userconfig: join(f.root, "user.npmrc"), npm_config_globalconfig: join(f.root, "global.npmrc") }, timeout: 15000 });
  expect(result.stderr + result.stdout).toContain("CHECKER_OK"); expect(result.status).toBe(0);
  expect(readFileSync(tracked, "utf8")).toBe("original"); expect(readFileSync(kept, "utf8")).toBe("kept"); expect(readFileSync(join(gitDir, "index"))).toEqual(before);
  expect(readFileSync(join(f.worktree, "coverage/result.txt"), "utf8")).toBe("ok"); expect(existsSync(join(f.worktree, "not-ignored"))).toBe(false);
  const server = createServer(socket => socket.destroy()); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const script = `const s=require('net').connect(${address.port},'127.0.0.1');s.on('connect',()=>process.exit(1));s.on('error',e=>{console.log(e.code);process.exit(['EPERM','EACCES'].includes(e.code)?0:1)});setTimeout(()=>process.exit(2),1000);`;
    const network = spawnSync("/usr/bin/sandbox-exec", ["-p", sandboxProfile(f.scope, true), process.execPath, "-e", script], { cwd: f.worktree, encoding: "utf8", timeout: 3000 });
    expect(network.status).toBe(0); expect(network.stdout).toMatch(/EPERM|EACCES/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30_000);

it("uses the maker root despite a local Git worktree redirect", () => {
  const f = fixture(), tracked = join(f.worktree, "tracked");
  writeFileSync(tracked, "tracked"); f.git(f.worktree, "add", "tracked");
  f.git(f.worktree, "config", "extensions.worktreeConfig", "true");
  f.git(f.worktree, "config", "--worktree", "core.worktree", f.outside);
  expect(checkerWritePaths(f.scope).deny).toContain(tracked);
  const facts = f.call("cat $(git rev-parse --show-toplevel)/tracked", join(f.worktree, "nested"));
  expect(facts.gitRoots?.[join(f.worktree, "nested")]).toBe(f.worktree);
});