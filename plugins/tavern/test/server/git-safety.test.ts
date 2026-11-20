// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { preserveWorktree, worktreeState } from "../../src/server/member-worktree";
import { cleanRebaseMatches } from "../../src/server/act-patch";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tavern-server-git-"))); roots.push(dir);
  const root = join(dir, "repo"); mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-qb", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "tracked"), "base\n"); git("add", "-A"); git("commit", "-qm", "base");
  return { dir, root, git };
}

it.each([false, true])("reads and preserves a dirty worktree without filters, fsmonitor or hooks (custom hooks path: %s)", async custom => {
  const f = fixture(), fsmonitor = join(f.dir, "monitor"), filtered = join(f.dir, "filtered"), hookRan = join(f.dir, "hook-ran");
  f.git("config", "filter.fixture.clean", `touch "${filtered}"; cat`);
  writeFileSync(join(f.root, ".git/info/attributes"), "tracked filter=fixture\n");
  const monitor = join(f.dir, "fsmonitor.sh");
  writeFileSync(monitor, `#!/bin/sh\ntouch "${fsmonitor}"\n`, { mode: 0o755 });
  f.git("config", "core.fsmonitor", monitor);
  const hooks = custom ? join(f.dir, "hooks") : join(f.root, ".git/hooks"); mkdirSync(hooks, { recursive: true });
  if (custom) f.git("config", "core.hooksPath", hooks);
  for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "reference-transaction", "post-index-change", "pre-push", "pre-auto-gc"])
    writeFileSync(join(hooks, name), `#!/bin/sh\ntouch "${hookRan}"\n`, { mode: 0o755 });
  writeFileSync(join(f.root, "tracked"), "changed content\n");
  expect(await worktreeState(f.root)).toMatchObject({ dirty: true, changed: ["tracked"] });
  expect(await preserveWorktree(f.root)).toMatchObject({ status: "committed", changed: ["tracked"] });
  expect(f.git("show", "HEAD:tracked")).toBe("changed content");
  expect([fsmonitor, filtered, hookRan].filter(existsSync)).toEqual([]);
});

it("reports dirty nested work and defers preservation rather than dropping it", async () => {
  const f = fixture(), source = join(f.dir, "subsource"), module = join(f.root, "module");
  f.git("clone", "-q", ".", source);
  f.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "module");
  f.git("commit", "-qm", "submodule");
  writeFileSync(join(module, "tracked"), "uncommitted tracked edit\n");
  writeFileSync(join(module, "untracked"), "uncommitted file\n");
  expect(await worktreeState(f.root)).toMatchObject({ dirty: true, changed: ["module"] });
  expect(await preserveWorktree(f.root)).toMatchObject({ status: "deferred" });
  expect(existsSync(join(module, "untracked"))).toBe(true);
  writeFileSync(join(module, ".git"), "gitdir: missing\n");
  expect(await preserveWorktree(f.root)).toMatchObject({ status: "deferred", error: expect.stringMatching(/cannot read|submodule/i) });
});

it("does not execute an object repository's signing program during patch verification", async () => {
  const f = fixture(), base = f.git("rev-parse", "HEAD"), sentinel = join(f.dir, "ran"), gpg = join(f.dir, "gpg");
  writeFileSync(join(f.root, "tracked"), "approved\n"); f.git("commit", "-qam", "approved");
  const verified = f.git("rev-parse", "HEAD");
  f.git("checkout", "-qB", "advanced", base);
  writeFileSync(join(f.root, "other"), "unrelated\n"); f.git("add", "-A"); f.git("commit", "-qm", "advanced");
  const destination = f.git("rev-parse", "HEAD"); f.git("cherry-pick", verified);
  const raw = f.git("cat-file", "commit", "HEAD").replace("\n\n", "\ngpgsig -----BEGIN PGP SIGNATURE-----\n test-only\n -----END PGP SIGNATURE-----\n\n");
  const commit = execFileSync("git", ["-C", f.root, "hash-object", "-t", "commit", "-w", "--stdin"], { input: raw, encoding: "utf8" }).trim();
  writeFileSync(gpg, `#!/bin/sh\ntouch "${sentinel}"\n`, { mode: 0o755 });
  f.git("config", "log.showSignature", "true"); f.git("config", "gpg.program", gpg);
  expect(await cleanRebaseMatches(join(f.root, ".git"), verified, commit, destination)).toBe(true);
  expect(existsSync(sentinel)).toBe(false);
});
