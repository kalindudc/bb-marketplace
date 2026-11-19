// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { realGit } from "../host/emulated-git";
import { serveGit } from "../host/git-daemon";
import { inspectHost } from "../../src/host/inspect";
import { SourceCapture } from "../../src/server/placement/capture";
import type { KnownSource, SourceDiscovery } from "../../src/server/placement/source-discovery";
import { PlacementTransport } from "../../src/server/placement/transport";
import { placementRecord } from "./placement-fixture";
import { submissionFixture } from "./placement-e2e-submission";
import { preservationFixture } from "./placement-e2e-preserve";
const git = (root: string, ...args: string[]) => execFileSync(realGit, ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
it.each([false, true])("captures only the advertised default tip without source writes (missing objects %s)", async missing => {
  const f = await submissionFixture(), network = await serveGit(f.home);
  try {
    git(f.maker, "remote", "set-url", "origin", network.url);
    writeFileSync(join(f.maker, "local-only"), "unpushed"); git(f.maker, "add", "local-only");
    git(f.maker, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "unpushed");
    writeFileSync(join(f.maker, "local-only"), "dirty local bytes");
    if (missing) { writeFileSync(join(f.home, "remote-only"), "pushed"); git(f.home, "add", "remote-only"); git(f.home, "commit", "-qm", "new default tip"); }
    git(f.home, "branch", "feature", f.base); git(f.maker, "config", "branch.main.merge", "refs/heads/feature");
    const tip = git(f.home, "rev-parse", "HEAD"), tree = git(f.home, "rev-parse", "HEAD^{tree}");
    const authority = { placementId: "pushed", generation: 1, endpointId: "source", operationId: "inspect" };
    const endpoint = { hostId: "maker", environmentId: "maker-env", root: f.maker };
    const registry = f.registries.get("maker")!;
    registry.registerEndpoint({ placementId: authority.placementId, generation: authority.generation, endpointId: authority.endpointId, endpoint, ownerThreadId: null, access: "source-read", git: "full", workspaceKind: null, objectFormat: "sha1", allowedRefs: [] });
    const inspection = await inspectHost(registry, authority);
    const known: KnownSource = { state: "known", keeperThreadId: "maker", projectId: "project", authorityId: "pushed", generation: 1, endpointId: "source", endpoint, environmentProviderId: null, inspection };
    const discovery = { revalidate: vi.fn(async () => {}) } as unknown as SourceDiscovery;
    const capture = new SourceCapture(discovery, f.port, f.placements);
    const before = { head: git(f.maker, "rev-parse", "HEAD"), refs: git(f.maker, "show-ref"), objects: git(f.maker, "count-objects", "-v"), index: readFileSync(join(f.maker, ".git/index")) };
    const snapshot = await capture.initial(known, undefined, { pushedBaseOnly: true });
    expect(snapshot).toMatchObject({ base: tip, sourceHead: tip, tree, includesUncommitted: false, modifiedPaths: 0, untrackedPaths: 0, fetch: { via: "remote-head", fetchRef: "refs/heads/main" } });
    f.placements.reserve(placementRecord({ id: "pushed-placement", hireToken: "pushed-hire", allocationKey: "pushed-allocation", keeperThreadId: "maker", sourceSnapshotId: snapshot.id }), { maxMakers: 2, maxCheckers: 2 });
    const imported = await new PlacementTransport(f.bb, f.port, f.placements).bringHome("pushed-placement", 1, snapshot.id);
    expect(git(snapshot.home.root, "rev-parse", imported.homeCommit! + "^{tree}")).toBe(tree);
    expect(snapshot.home.root).not.toBe(f.maker);
    expect(() => git(snapshot.home.root, "cat-file", "-e", before.head + "^{commit}")).toThrow();
    expect(git(snapshot.home.root, "ls-tree", "--name-only", tip)).not.toMatch(/local-only|untracked/);
    expect(git(f.maker, "rev-parse", "HEAD")).toBe(before.head); expect(git(f.maker, "show-ref")).toBe(before.refs);
    expect(git(f.maker, "count-objects", "-v")).toBe(before.objects); expect(readFileSync(join(f.maker, ".git/index"))).toEqual(before.index);
    expect(readFileSync(join(f.maker, "local-only"), "utf8")).toBe("dirty local bytes");
  } finally { await network.close(); await f.close(); }
}, 120_000);
it("preserves pushed-only work in the recorded private repository without changing the user's checkout", async () => {
  const f = await preservationFixture(), network = await serveGit(f.home);
  try {
    git(f.home, "remote", "add", "origin", network.url);
    writeFileSync(join(f.home, "tracked"), "user staged"); git(f.home, "add", "tracked");
    writeFileSync(join(f.home, "tracked"), "user unstaged");
    const authority = { placementId: "pushed-preserve-source", generation: 1, endpointId: "source", operationId: "inspect" };
    const endpoint = { hostId: "home", environmentId: "home-env", root: f.home }, registry = f.registries.get("home")!;
    registry.registerEndpoint({ placementId: authority.placementId, generation: 1, endpointId: "source", endpoint, ownerThreadId: null, access: "source-read", git: "full", workspaceKind: null, objectFormat: "sha1", allowedRefs: [] });
    const inspection = await inspectHost(registry, authority);
    const source: KnownSource = { state: "known", keeperThreadId: "keeper", projectId: "project", authorityId: authority.placementId, generation: 1, endpointId: "source", endpoint, environmentProviderId: null, inspection };
    const discovery = { revalidate: vi.fn(async () => {}) } as unknown as SourceDiscovery;
    const original = await new SourceCapture(discovery, f.port, f.placements).initial(source, undefined, { pushedBaseOnly: true });
    f.placements.update("placement", 1, value => ({ ...value, sourceSnapshotId: original.id }));
    const before = { head: git(f.home, "rev-parse", "HEAD"), refs: git(f.home, "show-ref"), objects: git(f.home, "count-objects", "-v"), index: readFileSync(join(f.home, ".git/index")) };
    expect(await f.preserve.beforeRelease("maker", "Save pushed-only member")).toMatchObject({ state: "released" });
    const record = f.placements.byMember("maker")!, saved = f.placements.snapshot(record.preservation.snapshotId!)!;
    expect(saved.home).toEqual(original.home);
    expect(git(saved.home.root, "show", saved.homeRef + ":tracked")).toBe("submitted");
    expect(git(f.home, "rev-parse", "HEAD")).toBe(before.head); expect(git(f.home, "show-ref")).toBe(before.refs);
    expect(git(f.home, "count-objects", "-v")).toBe(before.objects); expect(readFileSync(join(f.home, ".git/index"))).toEqual(before.index);
    expect(readFileSync(join(f.home, "tracked"), "utf8")).toBe("user unstaged");
  } finally { await network.close(); await f.close(); }
}, 120_000);
