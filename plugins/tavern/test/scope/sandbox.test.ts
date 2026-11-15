// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sandboxProfile } from "../../src/scope/sandbox";
import { scopeForClass } from "../../src/scope/presets";
import { realPath } from "../../src/scope/paths";
import { linkedWorktree } from "./git-fixture";

it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))("probes real OS-level writes only within the isolated fixture root", () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "tavern-sandbox-probe-")));
  try {
    const allowed = join(root, "work"), denied = join(root, "outside"), guard = join(allowed, "scopes");
    for (const dir of [allowed, denied, guard]) mkdirSync(dir);
    const scope = scopeForClass("ranger");
    scope.writes.allow = [allowed]; scope.writes.deny = [guard];
    const profile = sandboxProfile(scope);
    const run = (path: string) => spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/bash", "-c", 'printf ok > "$1"', "tavern-probe", path], { encoding: "utf8" });
    const yes = run(join(allowed, "allowed")); expect(yes.stderr).toBe(""); expect(yes.status).toBe(0);
    expect(readFileSync(join(allowed, "allowed"), "utf8")).toBe("ok");
    mkdirSync(join(allowed, ".claude")); mkdirSync(join(allowed, ".agents/tavern"), { recursive: true });
    for (const path of [join(denied, "blocked"), join(guard, "blocked"), join(allowed, ".claude/settings.json"), join(allowed, ".agents/tavern/scopes.yml")]) {
      const no = run(path); expect(no.status).not.toBe(0); expect(no.stderr).toContain("Operation not permitted"); expect(existsSync(path)).toBe(false);
    }
    const device = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/bash", "-c", "echo device-ok > /dev/stderr; echo fd-ok > /dev/fd/2"], { encoding: "utf8" });
    expect(device.status).toBe(0); expect(device.stderr).toContain("device-ok"); expect(device.stderr).toContain("fd-ok");
    scope.writes.allow = [allowed + "/*"]; scope.writes.deny = [guard, allowed + "/*.secret"];
    const globProfile = sandboxProfile(scope);
    const globRun = (path: string) => spawnSync("/usr/bin/sandbox-exec", ["-p", globProfile, "/bin/bash", "-c", 'printf ok > "$1"', "tavern-probe", path], { encoding: "utf8" });
    expect(globRun(join(allowed, "yes.txt")).status).toBe(0);
    expect(globRun(join(allowed, "no.secret")).status).not.toBe(0);
    scope.preset = "keeper"; scope.writes.allow = [allowed]; scope.writes.deny = [];
    const keeper = spawnSync("/usr/bin/sandbox-exec", ["-p", sandboxProfile(scope), "/bin/bash", "-c", 'printf no > "$1"', "tavern-probe", join(allowed, "keeper")], { encoding: "utf8" });
    expect(keeper.status).toBe(0);
    const keeperOutside = spawnSync("/usr/bin/sandbox-exec", ["-p", sandboxProfile(scope), "/bin/bash", "-c", 'printf no > "$1"', "tavern-probe", join(denied, "keeper")], { encoding: "utf8" });
    expect(keeperOutside.status).not.toBe(0);
    console.info("sandbox-exec probe: allowed root writable; outside root and protected scope directory denied");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
