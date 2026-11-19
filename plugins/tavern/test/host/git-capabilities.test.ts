// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inspectHost } from "../../src/host/inspect";
import { assertRepository, hostContext } from "../../src/host/context";
import { HostRegistry } from "../../src/host/registry";
import * as processModule from "../../src/host/process";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(format: "sha1" | "sha256" = "sha1") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-capabilities-"))); roots.push(root);
  const repo = join(root, "repo"), data = join(root, "data"); mkdirSync(repo); mkdirSync(data);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q", "-b", "worker", "--object-format=" + format); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "tracked"), "base"); git("add", "tracked"); git("commit", "-qm", "base");
  const registry = new HostRegistry(data), authority = { placementId: "placement", generation: 1, endpointId: "source", operationId: "inspect" };
  registry.registerEndpoint({ placementId: authority.placementId, generation: authority.generation, endpointId: authority.endpointId, endpoint: { hostId: "host", environmentId: "env", root: repo }, access: "source-read", workspaceKind: null, ownerThreadId: null, objectFormat: format, allowedRefs: [] });
  return { repo, data, git, registry, authority, inspect: () => inspectHost(registry, authority) };
}
const refused = (stderr: string) => ({ code: 129, stdout: "", stderr, timedOut: false });
it("inspects real sha1 Git without the optional object-format query and leaves the index and refs intact", async () => {
  const f = fixture(), index = readFileSync(join(f.repo, ".git/index")), refs = f.git("show-ref"), original = processModule.runProcess;
  const calls = vi.spyOn(processModule, "runProcess").mockImplementation((program, args, options) => args.includes("--show-object-format") ? Promise.resolve(refused("unknown option")) : original(program, args, options));
  expect(await f.inspect()).toMatchObject({ objectFormat: "sha1", features: { exportChanges: true, objectImport: true } });
  await assertRepository(hostContext(f.registry, f.authority, ["source-read"], new AbortController().signal));
  expect(calls.mock.calls.some(([_program, args]) => args.includes("--show-object-format"))).toBe(false);
  expect(calls.mock.calls.some(([_program, args, options]) => args.includes("status") && !!options.env?.GIT_INDEX_FILE)).toBe(true);
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index); expect(f.git("show-ref")).toBe(refs);
  expect(readdirSync(f.data).filter(name => name.startsWith("git-probe-"))).toEqual([]);
});
it("inspects sha256 when the local Git supports it", async context => {
  const probe = realpathSync(mkdtempSync(join(tmpdir(), "git-format-"))); roots.push(probe);
  if (spawnSync("git", ["init", "-q", "--object-format=sha256", probe]).status !== 0) { context.skip(); return; }
  const f = fixture("sha256"); expect(await f.inspect()).toMatchObject({ objectFormat: "sha256" });
  await assertRepository(hostContext(f.registry, f.authority, ["source-read"], new AbortController().signal));
});
it.each(["--list-cmds=builtins", "commit-tree", "write-tree", "update-index", "read-tree", "status"])("refuses missing transport capability %s with a lasting, bounded Git reason", async command => {
  const f = fixture(), original = processModule.runProcess, error = "not yet implemented: " + "x".repeat(300);
  vi.spyOn(processModule, "runProcess").mockImplementation(async (program, args, options) => {
    if (command === "--list-cmds=builtins" && args.includes(command) || command === "status" && args.includes("status") && options.env?.GIT_INDEX_FILE) return refused(error);
    const result = await original(program, args, options);
    if (args.includes("--list-cmds=builtins") && command !== "status") return { ...result, stdout: result.stdout.split(/\s+/).filter(name => name !== command).join("\n") };
    return result;
  });
  const failure = await f.inspect().catch(error => error);
  expect(failure).toMatchObject({ code: "git-unsupported", retryable: false });
  expect(failure.message).toMatch(/^Tavern host \[git-unsupported\]: This machine's Git can't carry Tavern's work \(.{1,200}\)\. Members can't be placed on it yet\.$/);
  expect(failure.message).toContain(command);
  if (["status", "--list-cmds=builtins"].includes(command)) expect(failure.message).toContain("not yet implemented");
  expect(readdirSync(f.data).filter(name => name.startsWith("git-probe-"))).toEqual([]);
});
it("rejects an object format that contradicts the verified HEAD length", async () => {
  const f = fixture(), original = processModule.runProcess;
  vi.spyOn(processModule, "runProcess").mockImplementation((program, args, options) => args.includes("extensions.objectformat") ? Promise.resolve({ code: 0, stdout: "sha256\n", stderr: "", timedOut: false }) : original(program, args, options));
  await expect(f.inspect()).rejects.toMatchObject({ code: "object-format-mismatch" });
});
