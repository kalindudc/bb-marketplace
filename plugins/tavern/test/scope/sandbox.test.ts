// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { sandboxCommand, shellQuote } from "../../src/scope/sandbox";
import { scopeForClass } from "../../src/scope/presets";
import { bindPaths, realPath } from "../../src/scope/paths";

it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))("protects Tavern files without applying legacy write rules to ordinary shell calls", () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "tavern-sandbox-probe-")));
  try {
    const scope = bindPaths(scopeForClass("ranger"), { home: root, tmp: [join(root, "work")], scopesDir: join(root, "scopes") });
    const projectPolicy = join(root, "repo", ".agents", "tavern");
    const writes = [join(root, "work", "ok"), join(root, "outside", "ok"), join(projectPolicy, "scopes.yml.example")];
    const controls = [join(root, "scopes", "member.json.grants"), join(projectPolicy, "scopes.yml"),
      join(projectPolicy, "settings.toml"), join(root, ".agents", "tavern", "settings.toml"),
      join(root, ".pi", "agent", "extensions", "tavern-guard", "index.ts")];
    for (const path of [...writes, ...controls]) mkdirSync(dirname(path), { recursive: true });
    scope.writes.deny.push(join(root, "outside"));
    const run = (command: string) => spawnSync("/bin/bash", ["-c", sandboxCommand(scope, command)], { cwd: root, encoding: "utf8" });
    for (const path of writes) {
      const result = run("printf ok > " + shellQuote(path));
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(path, "utf8")).toBe("ok");
    }
    for (const path of controls) {
      const result = run("printf blocked > " + shellQuote(path));
      expect(result.status, path).not.toBe(0);
      expect(result.stderr).toContain("Operation not permitted");
      expect(existsSync(path)).toBe(false);
    }
    const device = run("echo device-ok > /dev/stderr; echo fd-ok > /dev/fd/2");
    expect(device.status).toBe(0);
    expect(device.stderr).toContain("device-ok");
    expect(device.stderr).toContain("fd-ok");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
