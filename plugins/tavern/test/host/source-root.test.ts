// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hostContract, type Authority, type TransferRegistration } from "../../src/host-contract";
import { inspectHost } from "../../src/host/inspect";
import { HostRegistry } from "../../src/host/registry";
import { createTransport } from "../../src/host/transport";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(format: "sha1" | "sha256" = "sha1") {
  const root = realpathSync(mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES ?? tmpdir(), "source-root-"))); roots.push(root);
  const repo = join(root, "repo"), sub = join(repo, "sub"), data = join(root, "data"); mkdirSync(repo); mkdirSync(sub); mkdirSync(data);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main", "--object-format=" + format); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "outside.txt"), "before"); writeFileSync(join(sub, "inside.txt"), "before"); git("add", "-A"); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "outside.txt"), "after"); writeFileSync(join(sub, "inside.txt"), "after"); git("add", "-A"); git("commit", "-qm", "head");
  const registry = new HostRegistry(data), authority: Authority = { placementId: "source-placement", generation: 1, endpointId: "source", operationId: "inspect-source" };
  const transfer: TransferRegistration = { ...authority, transferId: "source-transfer", snapshotId: "source-snapshot", direction: "bring-home", objectFormat: format, base, head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), fromEndpointId: "source", toEndpointId: "home", allowedRefs: [], uploads: [], artifacts: [] };
  const register = (path: string) => registry.registerEndpoint({ placementId: authority.placementId, generation: authority.generation, endpointId: authority.endpointId, endpoint: { hostId: "source-host", environmentId: "source-environment", root: path }, git: "full", access: "source-read", workspaceKind: null, ownerThreadId: null, objectFormat: format, allowedRefs: [] });
  return { root, repo, sub, git, registry, authority, transfer, register, port: createTransport(registry) };
}
it("keeps exact subdirectory metadata preview without claiming repository export support", async () => {
  const f = fixture(); f.register(f.sub);
  expect(await inspectHost(f.registry, f.authority)).toMatchObject({ root: f.sub, head: f.transfer.head, tree: f.transfer.tree, features: { exportChanges: false } });
});
it("refuses subdirectory export and blob access before granting a parent-repository manifest", async () => {
  const f = fixture(); f.register(f.sub); await inspectHost(f.registry, f.authority); f.registry.registerTransfer(f.transfer);
  const authority = { ...f.authority, transferId: f.transfer.transferId }, index = readFileSync(join(f.repo, ".git/index"));
  await expect(f.port.exportChanges(authority)).rejects.toThrow(/source-root-required.*source checkout must be a repository root.*Keeper environment/);
  expect(f.registry.readTransferState(authority, "export.json", hostContract.exportChanges.output)).toBeNull();
  await expect(f.port.readBlob({ ...authority, sha: f.git("rev-parse", "HEAD:outside.txt"), offset: 0, length: 5 })).rejects.toThrow(/source-root-required/);
  expect(f.git("rev-parse", "HEAD")).toBe(f.transfer.head); expect(readFileSync(join(f.repo, ".git/index")).equals(index)).toBe(true); expect(f.git("status", "--porcelain")).toBe("");
});
it.each(["sha1", "sha256"] as const)("accepts an exact-root symlink and exports the complete authorized %s tree", async format => {
  const f = fixture(format), alias = join(f.root, "repo-alias"); symlinkSync(f.repo, alias); f.register(alias);
  expect(await inspectHost(f.registry, f.authority)).toMatchObject({ root: f.repo, features: { exportChanges: true } });
  f.registry.registerTransfer(f.transfer); const authority = { ...f.authority, transferId: f.transfer.transferId };
  const exported = await f.port.exportChanges(authority);
  expect(exported.changes.map(change => change.path)).toEqual(["outside.txt", "sub/inside.txt"]); expect(exported.tree).toBe(f.transfer.tree);
  const blob = await f.port.readBlob({ ...authority, sha: exported.changes[0]!.blob!, offset: 0, length: 5 });
  expect(Buffer.from(blob.data, "base64").toString()).toBe("after");
});
