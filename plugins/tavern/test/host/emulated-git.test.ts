// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emulatedGit, PENDING_LIVE_VERIFICATION, realGit } from "./emulated-git";
it("models live World reads, abbreviated raw IDs and successful config warnings while refusing unsupported forms", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-git-")), member = join(root, "member"); mkdirSync(member);
  try {
    execFileSync(realGit, ["-C", member, "init", "-q"]); writeFileSync(join(member, "tracked"), "base");
    execFileSync(realGit, ["-C", member, "add", "-A"]); execFileSync(realGit, ["-C", member, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base"]);
    const strict = emulatedGit(root);
    const call = (args: string[]) => spawnSync(join(strict, "git"), ["-C", member, ...args], { encoding: "utf8", input: "HEAD\n" });
    for (const args of [["cat-file", "commit", "HEAD"], ["cat-file", "--batch-check"], ["status", "--porcelain", "-z"], ["config", "--type=bool", "--get", "core.filemode"], ["ls-tree", "-r", "-z", "--full-tree", "HEAD", "--", "tracked"], ["ls-files", "--stage", "-z", "--", "tracked"]])
      expect(call(args).status).toBe(0);
    for (const args of [["-c", "unreviewed.key=1", "rev-parse", "--verify", "HEAD"], ["log"], ["status", "--made-up-option"], ["config", "--get", "unreviewed.key"], ["write-tree"], ["ls-files", "--cached"], ...["--no-abbrev", "--no-textconv", "--abbrev=40", "--full-index"].map(flag => ["diff", "--raw", flag, "-z", "HEAD"])])
      expect(call(args).status).toBe(91);
    writeFileSync(join(member, "tracked"), "changed");
    const raw = call(["diff", "--raw", "-z", "HEAD"]); expect(raw.status).toBe(0);
    expect(raw.stdout).toMatch(/^:100644 100644 [a-f0-9]{14} [a-f0-9]{14} M\x00tracked\x00$/);
    const warned = call(["-c", "gc.auto=0", "-c", "maintenance.auto=false", "status", "--porcelain", "-z"]);
    expect(warned.status).toBe(0); expect(warned.stderr).toContain("warning: ignoring -c gc.auto");
    expect(warned.stdout).toContain("tracked"); expect(PENDING_LIVE_VERIFICATION).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
