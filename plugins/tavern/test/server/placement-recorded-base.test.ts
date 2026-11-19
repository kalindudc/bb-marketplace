// @vitest-environment node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { emulatedGit, realGit } from "../host/emulated-git";
import { readyFixture } from "./placement-e2e-ready";
import { preservationFixture } from "./placement-e2e-preserve";
const git = (root: string, ...args: string[]) => execFileSync(realGit, ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
afterEach(() => vi.unstubAllEnvs());
it.each([false, true])("carries the submission into a Warden from its recorded base when origin/main is ahead (emulation %s)", async emulate => {
  const f = await readyFixture(true);
  git(f.member, "fetch", "origin"); expect(git(f.member, "rev-parse", "origin/main")).not.toBe(f.base);
  if (emulate) vi.stubEnv("PATH", emulatedGit(f.root) + ":" + process.env.PATH);
  expect(await f.make().forThread("member")).toContain("Ready.");
  expect(git(f.member, "rev-parse", "HEAD^{tree}")).toBe(f.tree);
}, 120_000);
it.each([false, true])("captures submission and preservation from the recorded base, not an ahead tracking ref (emulation %s)", async emulate => {
  const f = await preservationFixture();
  try {
    git(f.maker, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-am", "member edit");
    writeFileSync(join(f.maker, "dirty"), "uncommitted member bytes");
    writeFileSync(join(f.home, "tracked"), "upstream edit"); writeFileSync(join(f.home, "upstream-new"), "upstream addition");
    git(f.home, "add", "-A"); git(f.home, "commit", "-qm", "upstream ahead"); git(f.maker, "fetch", "origin");
    expect(git(f.maker, "rev-parse", "origin/main")).not.toBe(f.base);
    if (emulate) vi.stubEnv("PATH", emulatedGit(join(f.maker, "..")) + ":" + process.env.PATH);
    const submitted = await f.submissions.capture("maker", "waypoint"); expect(submitted.state).toBe("captured");
    if (submitted.state !== "captured") throw new Error("Expected submission");
    expect(submitted.snapshot.base).toBe(f.base);
    expect(git(f.home, "rev-parse", submitted.snapshot.homeCommit! + "^")).toBe(f.base);
    expect(git(f.home, "diff", "--name-only", f.base, submitted.snapshot.homeCommit!).split("\n").sort()).toEqual(["dirty", "tracked", "untracked"]);
    writeFileSync(join(f.maker, "dirty"), "preserved later bytes");
    expect(await f.preserve.beforeRelease("maker", "Release")).toMatchObject({ state: "released" });
    const preserved = f.placements.snapshot(f.placements.byMember("maker")!.preservation.snapshotId!)!;
    expect(preserved.base).toBe(f.base); expect(git(f.home, "rev-parse", preserved.homeCommit! + "^")).toBe(f.base);
  } finally { await f.close(); }
}, 120_000);
