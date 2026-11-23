// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { gitFixtureTemplate } from "./git-fixture-template";

const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const seed = vi.fn((root: string, content: string) => {
  git(root, "init", "-qb", "main");
  writeFileSync(join(root, "tracked"), content, { mode: 0o755 });
  symlinkSync("tracked", join(root, "link"));
  git(root, "add", "-A");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base");
  return git(root, "rev-parse", "HEAD");
});
const copy = gitFixtureTemplate(seed);

it("seeds each variant once and gives every case independent files, refs and objects", () => {
  const root = mkdtempSync(join(tmpdir(), "fixture-copies-"));
  const first = join(root, "first"), second = join(root, "second"), other = join(root, "other");
  try {
    const base = copy(first, "base");
    writeFileSync(join(first, "tracked"), "first-only");
    git(first, "add", "tracked");
    git(first, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "change");
    const changed = git(first, "rev-parse", "HEAD");
    expect(copy(second, "base")).toBe(base);
    expect(copy(other, "different variant")).not.toBe(base);
    expect(seed).toHaveBeenCalledTimes(2);
    expect(git(second, "rev-parse", "HEAD")).toBe(base);
    expect(git(second, "status", "--porcelain")).toBe("");
    expect(() => git(second, "cat-file", "-e", changed)).toThrow();
    expect(readFileSync(join(second, "tracked"), "utf8")).toBe("base");
    expect(readlinkSync(join(second, "link"))).toBe("tracked");
    expect(statSync(join(second, "tracked")).mode & 0o100).toBe(0o100);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
