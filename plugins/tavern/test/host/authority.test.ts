// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as gitHost from "../../src/host/git";
import { z } from "zod";
import { hostContract, type HostInput } from "../../src/host-contract";
import { HostRegistry } from "../../src/host/registry";
import { inspectHost } from "../../src/host/inspect";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES ?? tmpdir(), "tavern-host-")); roots.push(root);
  const repo = join(root, "repo"), data = join(root, "data"); mkdirSync(repo); mkdirSync(data);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "worker"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "tracked"), "initial\n"); git("add", "tracked"); git("commit", "-qm", "fixture");
  const registry = new HostRegistry(data);
  const endpoint: HostInput<"registerEndpoint"> = { placementId: "placement-a", generation: 1, endpointId: "member-a", endpoint: { hostId: "guest-a", environmentId: "environment-a", root: repo }, ownerThreadId: "member-thread", access: "member-write", workspaceKind: "dedicated-machine", objectFormat: "sha1", allowedRefs: ["refs/heads/worker"] };
  const authority = { placementId: endpoint.placementId, generation: endpoint.generation, endpointId: endpoint.endpointId, operationId: "operation-a" };
  const transfer = { ...authority, transferId: "transfer-a", snapshotId: "snapshot-a", direction: "carry-out" as const, objectFormat: "sha1" as const, base: git("rev-parse", "HEAD"), head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), fromEndpointId: "home-a", toEndpointId: endpoint.endpointId, allowedRefs: [], uploads: ["upload-a"], artifacts: [] };
  return { root, repo, data, registry, endpoint, authority, transfer, git };
}
it("declares strict authority-bearing contracts without activating a host worker", () => {
  const f = fixture();
  expect(hostContract.registerEndpoint.input.parse(f.endpoint)).toEqual(f.endpoint);
  expect(hostContract.registerEndpoint.input.safeParse({ ...f.endpoint, ownsEverything: true }).success).toBe(false);
  for (const name of ["importChunk", "dropUploads", "importCommit", "carryStart", "carryWrite", "carryDelete", "carryFinish", "carryAbort", "artifactChunk", "finishArtifact"] as const) {
    const input = hostContract[name].input.safeParse({ worktree: f.repo, upload: "upload-a" });
    expect(input.success, name).toBe(false);
  }
});
it("exports every host input and output as JSON Schema", () => {
  for (const method of Object.values(hostContract)) {
    expect(() => z.toJSONSchema(method.input, { io: "input" })).not.toThrow();
    expect(() => z.toJSONSchema(method.output, { io: "output" })).not.toThrow();
  }
});
it("registers an endpoint idempotently and persists it across worker restarts", () => {
  const f = fixture();
  expect(f.registry.registerEndpoint(f.endpoint)).toEqual({ registered: true, generation: 1 });
  expect(f.registry.registerEndpoint(f.endpoint)).toEqual({ registered: true, generation: 1 });
  expect(new HostRegistry(f.data).endpoint(f.authority).registration.endpoint).toEqual(f.endpoint.endpoint);
});
it("refuses an endpoint identity or access change within one generation", () => {
  const f = fixture(); f.registry.registerEndpoint(f.endpoint);
  expect(() => f.registry.registerEndpoint({ ...f.endpoint, access: "source-read", allowedRefs: [] })).toThrow(/endpoint-conflict/);
  expect(() => f.registry.registerEndpoint({ ...f.endpoint, endpoint: { ...f.endpoint.endpoint, hostId: "another-host" } })).toThrow(/endpoint-conflict/);
  expect(() => f.registry.endpoint({ ...f.authority, endpointId: "other" })).toThrow(/endpoint-missing/);
  expect(() => f.registry.endpoint(f.authority, ["home-import"])).toThrow(/endpoint-access/);
});
it("fences stale, revoked and cancelled generations durably", () => {
  const f = fixture(); f.registry.registerEndpoint(f.endpoint);
  expect(f.registry.revokePlacement({ placementId: f.endpoint.placementId, generation: 1, reason: "cancelled" })).toEqual({ revoked: true, generation: 1 });
  expect(() => f.registry.endpoint(f.authority)).toThrow(/placement-revoked/);
  expect(() => new HostRegistry(f.data).registerEndpoint(f.endpoint)).toThrow(/placement-revoked/);
  f.registry.registerEndpoint({ ...f.endpoint, generation: 2 });
  expect(() => f.registry.endpoint(f.authority)).toThrow(/stale-generation/);
  expect(f.registry.endpoint({ ...f.authority, generation: 2 }).registration.generation).toBe(2);
  expect(() => f.registry.revokePlacement({ placementId: f.endpoint.placementId, generation: 1, reason: "late cancel" })).toThrow(/stale-generation/);
});
it("refuses roots replaced after registration, including retargeted symlinks", () => {
  const f = fixture(), alias = join(f.root, "alias"); symlinkSync(f.repo, alias);
  f.registry.registerEndpoint({ ...f.endpoint, endpoint: { ...f.endpoint.endpoint, root: alias } });
  expect(f.registry.endpoint(f.authority).realRoot).toBe(f.repo);
  renameSync(f.repo, join(f.root, "original")); mkdirSync(f.repo);
  expect(() => f.registry.endpoint(f.authority)).toThrow(/endpoint-replaced/);
});
it("rejects filesystem roots, home and symlink aliases as member-write roots", () => {
  const f = fixture();
  for (const root of ["/", process.env.HOME!]) expect(() => f.registry.registerEndpoint({ ...f.endpoint, endpoint: { ...f.endpoint.endpoint, root } })).toThrow(/unsafe-root/);
  const alias = join(f.root, "home-alias"); symlinkSync(process.env.HOME!, alias);
  expect(() => f.registry.registerEndpoint({ ...f.endpoint, endpoint: { ...f.endpoint.endpoint, root: alias } })).toThrow(/unsafe-root/);
});
it("claims home refs by exact placement and rejects non-Tavern ref writes", () => {
  const f = fixture(), endpoint = { ...f.endpoint, access: "home-import" as const, allowedRefs: ["refs/tavern/keeper/snapshot"] };
  expect(() => f.registry.registerEndpoint({ ...endpoint, allowedRefs: ["refs/heads/main"] })).toThrow(/ref-ownership/);
  f.registry.registerEndpoint(endpoint);
  expect(() => f.registry.registerEndpoint({ ...endpoint, placementId: "placement-b", endpointId: "home-b" })).toThrow(/ref-ownership/);
  expect(f.git("status", "--porcelain")).toBe("");
});
it("requires inspected repository facts before authorizing a source transfer", async () => {
  const f = fixture(); f.registry.registerEndpoint(f.endpoint);
  expect(() => f.registry.registerTransfer(f.transfer)).toThrow(/endpoint-uninspected/);
  const result = await inspectHost(f.registry, f.authority);
  expect(result).toMatchObject({ root: f.repo, objectFormat: "sha1", linkedWorktree: false, branch: "worker", head: f.transfer.head, tree: f.transfer.tree, features: { porcelain: true, exportChanges: true, objectImport: true } });
  expect(f.registry.registerTransfer(f.transfer)).toEqual({ registered: true, transferId: "transfer-a" });
  expect(f.registry.transfer({ ...f.authority, transferId: "transfer-a" }).registration.tree).toBe(f.transfer.tree);
});
it("pins transfer identity, refs, upload handles and object format to its generation", async () => {
  const f = fixture(); f.registry.registerEndpoint(f.endpoint); await inspectHost(f.registry, f.authority);
  f.registry.registerTransfer(f.transfer);
  expect(() => f.registry.registerTransfer({ ...f.transfer, tree: "0".repeat(40) })).toThrow(/transfer-conflict/);
  expect(() => f.registry.registerTransfer({ ...f.transfer, transferId: "other", objectFormat: "sha256", base: "0".repeat(64), head: "1".repeat(64), tree: "2".repeat(64) })).toThrow(/object-format-mismatch/);
  expect(() => f.registry.registerTransfer({ ...f.transfer, transferId: "other", toEndpointId: "another-member" })).toThrow(/transfer-endpoint/);
  expect(() => f.registry.registerTransfer({ ...f.transfer, transferId: "other", allowedRefs: ["refs/heads/main"] })).toThrow(/ref-ownership/);
  expect(() => f.registry.transfer({ ...f.authority, transferId: "missing" })).toThrow(/transfer-missing/);
  f.registry.revokePlacement({ placementId: f.endpoint.placementId, generation: 1, reason: "cancelled" });
  expect(() => f.registry.transfer({ ...f.authority, transferId: "transfer-a" })).toThrow(/placement-revoked/);
});
it("reports canonical host-owned artifact storage without creating it during inspection", async () => {
  const f = fixture(); f.registry.registerEndpoint(f.endpoint);
  expect(existsSync(f.registry.artifactDirectory)).toBe(false);
  const alias = join(f.root, "data-alias"); symlinkSync(f.data, alias);
  expect(await inspectHost(new HostRegistry(alias), f.authority)).toMatchObject({ artifactDirectory: join(f.data, "artifacts") });
  expect(existsSync(f.registry.artifactDirectory)).toBe(false);
});
it("reports the canonical exact SDK endpoint root without widening a source-read subdirectory", async () => {
  const f = fixture(), subdirectory = join(f.repo, "subproject"); mkdirSync(subdirectory);
  f.registry.registerEndpoint({ ...f.endpoint, access: "source-read", allowedRefs: [], workspaceKind: null, ownerThreadId: null, endpoint: { ...f.endpoint.endpoint, root: subdirectory } });
  expect(await inspectHost(f.registry, f.authority)).toMatchObject({ root: subdirectory, head: f.transfer.head, tree: f.transfer.tree });
});
it("detects repository object-format mismatch during inspection", async () => {
  const f = fixture(); f.registry.registerEndpoint({ ...f.endpoint, objectFormat: "sha256" });
  await expect(inspectHost(f.registry, f.authority)).rejects.toThrow(/object-format-mismatch/);
});
it("distinguishes real linked worktrees from dedicated repositories", async () => {
  const f = fixture(), path = join(f.root, "linked"); f.git("worktree", "add", "-qb", "linked", path);
  f.registry.registerEndpoint({ ...f.endpoint, endpoint: { ...f.endpoint.endpoint, root: path }, workspaceKind: "linked-worktree", allowedRefs: ["refs/heads/linked"] });
  expect(await inspectHost(f.registry, f.authority)).toMatchObject({ root: path, linkedWorktree: true, branch: "linked" });
  const changed = readFileSync(join(path, ".git"), "utf8"); expect(changed).toContain("gitdir:");
});
it("does not run repository hooks or honor ambient Git repository redirection during inspection", async () => {
  const f = fixture(), marker = join(f.root, "hook-ran");
  writeFileSync(join(f.repo, ".git/hooks/post-index-change"), `#!/bin/sh\nprintf ran > '${marker}'\n`, { mode: 0o700 });
  f.registry.registerEndpoint(f.endpoint);
  const previous = process.env.GIT_DIR; process.env.GIT_DIR = join(f.root, "not-a-repository");
  try { expect((await inspectHost(f.registry, f.authority)).head).toBe(f.transfer.head); }
  finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
  expect(existsSync(marker)).toBe(false);
  expect(f.git("status", "--porcelain")).toBe("");
});
it("fences cancellation even when allocation has not registered any endpoint yet", () => {
  const f = fixture(); f.registry.revokePlacement({ placementId: f.endpoint.placementId, generation: 1, reason: "cancel before allocation" });
  expect(() => new HostRegistry(f.data).registerEndpoint(f.endpoint)).toThrow(/placement-revoked/);
});
it("does not let another live member acquire the same writable workspace", () => {
  const f = fixture(); f.registry.registerEndpoint(f.endpoint);
  expect(() => f.registry.registerEndpoint({ ...f.endpoint, placementId: "other-placement", endpointId: "other-member", ownerThreadId: "other-thread" })).toThrow(/workspace-ownership/);
});
it("fails closed for corrupted and dangling-symlink authority records", () => {
  const f = fixture(); f.registry.registerEndpoint(f.endpoint);
  const file = join(f.data, "authority", readdirSync(join(f.data, "authority")).find(name => /^[a-f0-9]{64}\.json$/.test(name))!);
  writeFileSync(file, "not JSON");
  expect(() => f.registry.endpoint(f.authority)).toThrow(/authority-state-invalid/);
  rmSync(file); symlinkSync(join(f.root, "missing-state"), file);
  expect(() => f.registry.registerEndpoint(f.endpoint)).toThrow(/authority-state-invalid/);
});
it("registers the two ends of one same-host transfer without conflating their handles", async () => {
  const f = fixture(); f.registry.registerEndpoint(f.endpoint); await inspectHost(f.registry, f.authority);
  const source = { ...f.endpoint, endpointId: "home-a", access: "source-read" as const, allowedRefs: [] };
  f.registry.registerEndpoint(source);
  const sourceAuthority = { ...f.authority, endpointId: "home-a" }; await inspectHost(f.registry, sourceAuthority);
  f.registry.registerTransfer(f.transfer); f.registry.registerTransfer({ ...f.transfer, ...sourceAuthority });
  expect(f.registry.transfer({ ...f.authority, transferId: f.transfer.transferId }).registration.endpointId).toBe("member-a");
  expect(f.registry.transfer({ ...sourceAuthority, transferId: f.transfer.transferId }).registration.endpointId).toBe("home-a");
  expect(f.registry.registerTransfer({ ...f.transfer, operationId: "retried-operation" }).registered).toBe(true);
});
it("prevents shared-Git ref ownership bypass through another linked worktree", async () => {
  const f = fixture(), linked = join(f.root, "linked"); f.git("worktree", "add", "-qb", "linked", linked);
  const home = { ...f.endpoint, endpointId: "home-a", access: "home-import" as const, allowedRefs: ["refs/tavern/keeper/snapshot"] };
  f.registry.registerEndpoint(home); await inspectHost(f.registry, { ...f.authority, endpointId: home.endpointId });
  f.registry.registerEndpoint({ ...home, placementId: "placement-b", endpointId: "home-b", endpoint: { ...home.endpoint, root: linked } });
  await expect(inspectHost(f.registry, { ...f.authority, placementId: "placement-b", endpointId: "home-b" })).rejects.toThrow(/ref-ownership/);
});
it("refuses a member whose agent switched away from the trusted provisioned branch", async () => {
  const f = fixture(); f.registry.registerEndpoint(f.endpoint); await inspectHost(f.registry, f.authority);
  f.git("checkout", "-qb", "another-branch");
  await expect(inspectHost(f.registry, f.authority)).rejects.toThrow(/branch-mismatch/);
});
it("reports actual fetch and push remotes after Git rewrites without credentials", async () => {
  const f = fixture(); f.registry.registerEndpoint(f.endpoint);
  f.git("remote", "add", "origin", "https://alice:fetch-secret@fetch.example/team/repo.git?access_token=fetch-secret#fragment");
  f.git("remote", "set-url", "--push", "origin", "ssh://git:push-secret@push.example:2222/team/repo.git?token=push-secret#fragment");
  f.git("remote", "add", "mirror", "short:repo.git"); f.git("config", "url.https://bob:rewrite-secret@rewritten.example/team/.insteadOf", "short:");
  f.git("remote", "add", "scp", "git@github.example:team/repo.git");
  const result = await inspectHost(f.registry, f.authority);
  expect(result.repoRemotes).toEqual(["github.example:team/repo.git", "https://fetch.example/team/repo.git", "https://rewritten.example/team/repo.git", "ssh://push.example:2222/team/repo.git"]);
  expect(JSON.stringify(result)).not.toMatch(/fetch-secret|push-secret|rewrite-secret|alice|bob/);
});
it("distinguishes known-empty remotes from unavailable metadata", async () => {
  const f = fixture(); f.registry.registerEndpoint(f.endpoint);
  expect((await inspectHost(f.registry, f.authority)).repoRemotes).toEqual([]);
  const original = gitHost.runGit;
  const spy = vi.spyOn(gitHost, "runGit").mockImplementation((root, args, options) => args[0] === "remote" ? Promise.reject(new Error("Remote metadata unavailable")) : original(root, args, options));
  try { expect(await inspectHost(f.registry, f.authority)).not.toHaveProperty("repoRemotes"); } finally { spy.mockRestore(); }
});
it("omits unsafe or oversized remote identities rather than leaking or truncating them", async () => {
  const f = fixture(); f.registry.registerEndpoint(f.endpoint);
  for (const url of ["ext::sh -c secret-command", "https://host.example/" + "a".repeat(4096), "https://host.example/" + "é".repeat(800)]) {
    f.git("config", "remote.origin.url", url);
    expect(await inspectHost(f.registry, f.authority)).not.toHaveProperty("repoRemotes");
  }
});
it("preserves configured local remote URLs without resolving them on another host", async () => {
  const f = fixture(); f.registry.registerEndpoint(f.endpoint);
  for (const url of ["../sibling.git", "sibling.git", "/opt/local/repo.git", "file:///tmp/repo"]) {
    f.git("config", "remote.origin.url", url);
    expect((await inspectHost(f.registry, f.authority)).repoRemotes).toEqual([url]);
  }
});
it("bounds the inspected remote identity DTO", async () => {
  const f = fixture(); f.registry.registerEndpoint(f.endpoint); const result = await inspectHost(f.registry, f.authority);
  expect(hostContract.inspect.output.safeParse({ ...result, repoRemotes: Array(201).fill("https://host.example/repo") }).success).toBe(false);
  expect(hostContract.inspect.output.safeParse({ ...result, repoRemotes: ["x".repeat(4097)] }).success).toBe(false);
});
it("keeps stale transfer handles unusable after a replacement generation", async () => {
  const f = fixture(); f.registry.registerEndpoint(f.endpoint); await inspectHost(f.registry, f.authority); f.registry.registerTransfer(f.transfer);
  f.registry.registerEndpoint({ ...f.endpoint, generation: 2 });
  expect(() => f.registry.transfer({ ...f.authority, generation: 2, transferId: f.transfer.transferId })).toThrow(/transfer-missing/);
  expect(() => f.registry.transfer({ ...f.authority, transferId: f.transfer.transferId })).toThrow(/stale-generation/);
});
