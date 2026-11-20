// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { setupScriptCommand, setupScriptPath } from "../../src/shared/setup-forge";
import { inspectSetupForges, probeSetupForges } from "../../src/host/setup-forge";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("only reads paths at preflight, refuses aliases into agent roots and runs a literal executable with only --help on Apply", async () => {
  const root = mkdtempSync(join(tmpdir(), "tavern-forge-setup-")); roots.push(root);
  const worktree = join(root, "worktree"), storage = join(root, "storage");
  mkdirSync(worktree); mkdirSync(storage);
  const path = join(root, "forge helper"), marker = join(root, "ran");
  writeFileSync(path, '#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = --help ] && [ "$FORGE_DRAFT" = 1 ] || exit 9\nprintf yes > "' + marker + '"\n', { mode: 0o700 });
  const worktreeScript = join(worktree, "forge"), storageScript = join(storage, "forge");
  for (const script of [worktreeScript, storageScript]) writeFileSync(script, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const alias = join(root, "alias"), outsideAlias = join(worktree, "outside");
  symlinkSync(storageScript, alias); symlinkSync(path, outsideAlias);
  const target = (open: string) => ({ root, blockedRoots: [worktree, storage], forges: [{ index: 0, profile: { kind: "command" as const, name: "Forge", id: "forge", enabled: true, open } }] });
  for (const script of [alias, outsideAlias, worktreeScript, storageScript]) expect(inspectSetupForges(target(script))).toMatchObject([{ status: "fail", message: expect.stringMatching(/worktree|thread storage/i) }]);
  expect(inspectSetupForges(target(join(root, "absent")))).toMatchObject([{ status: "fail", message: "Script does not exist." }]);
  expect(inspectSetupForges(target(worktree))).toMatchObject([{ status: "fail" }]);
  expect(inspectSetupForges(target("forge"))).toMatchObject([{ status: "fail", message: expect.stringContaining("absolute") }]);
  expect(inspectSetupForges(target(path + " --flag"))).toMatchObject([{ status: "fail" }]);
  expect(inspectSetupForges(target(path))).toMatchObject([{ status: "pass", resolvedPath: expect.stringContaining("forge helper") }]);
  expect(existsSync(marker)).toBe(false);
  expect(await probeSetupForges(target(realpathSync(path)), new AbortController().signal)).toMatchObject([{ status: "pass" }]);
  expect(existsSync(marker)).toBe(true);
});

it("round-trips a literal absolute path with spaces and a quote as one shell word", () => {
  const path = "/bin/agent's helper";
  expect(setupScriptCommand(path)).toBe("'/bin/agent'\\''s helper'");
  expect(setupScriptPath(setupScriptCommand(path))).toBe(path);
});
