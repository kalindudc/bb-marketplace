// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { placementRuleSchema, type PlacementPolicyRead } from "../../src/shared/placement-settings";
import { resolvePlacementRoute } from "../../src/server/placement/routing";
import type { KnownSource, SdkSource, SourceDiscoveryResult } from "../../src/server/placement/source-discovery";

const current = placementRuleSchema.parse({ id: "current", label: "Stay here", enabled: true, match: {}, target: { kind: "current" } });
const provider = placementRuleSchema.parse({ id: "provider", label: "Explicit provider", enabled: true, match: {}, target: {
  kind: "provider", environmentProviderId: "vendor", machine: { type: "existing", hostId: "other" }, workspace: "linked-worktree",
} });
const context = { keeperThreadId: "keeper", projectId: "project", classId: "smith", questId: "quest" };
const identity: SdkSource = { keeperThreadId: "keeper", projectId: "project", environmentProviderId: "vendor-workspace",
  endpoint: { hostId: "guest", environmentId: "env", root: "/sdk/path-spelling" } };
const source: KnownSource = {
  state: "known", keeperThreadId: "keeper", projectId: "project", authorityId: "discovery", generation: 1, endpointId: "source",
  endpoint: { ...identity.endpoint, root: "/guest/home/repo" }, environmentProviderId: identity.environmentProviderId,
  inspection: { root: "/guest/home/repo", platform: "linux", home: "/guest/home", tmp: ["/guest/tmp"], piAgentDir: null,
    head: "1".repeat(40), tree: "2".repeat(40), branch: "main", objectFormat: "sha1", linkedWorktree: false,
    features: { porcelain: true, exportChanges: true, objectImport: true } },
};
function policy(rules: typeof current[]): PlacementPolicyRead { return { state: "valid", revision: 3, settings: { maxMakers: 2, maxCheckers: 2, rules } }; }
function deps() {
  return { readIdentity: vi.fn(async () => structuredClone(identity)), inspectSource: vi.fn(async (): Promise<SourceDiscoveryResult> => structuredClone(source)) };
}

describe("lazy trusted placement matching", () => {
  it.each([{ rules: [] }, { rules: [{ ...current, enabled: false }] }])("keeps no/disabled rules entirely on compatibility without asking for source facts", async ({ rules }) => {
    const d = deps(), result = await resolvePlacementRoute(policy(rules), context, d);
    expect(result.match).toEqual({ state: "compatibility", revision: 3 });
    expect(d.readIdentity).not.toHaveBeenCalled(); expect(d.inspectSource).not.toHaveBeenCalled();
  });

  it("blocks invalid policy without looking up source facts", async () => {
    const d = deps(), p: PlacementPolicyRead = { state: "invalid", revision: 3, problems: [{ path: "rules", message: "Corrupt" }] };
    expect((await resolvePlacementRoute(p, context, d)).match).toMatchObject({ state: "blocked", code: "invalid-machine-policy" });
    expect(d.readIdentity).not.toHaveBeenCalled(); expect(d.inspectSource).not.toHaveBeenCalled();
  });

  it("does not inspect earlier rules that already miss known class/project/quest facts", async () => {
    const d = deps();
    const rules = [
      { ...provider, match: { classes: ["ranger"], keeperPathGlobs: ["/**"] } },
      { ...provider, id: "other-project", match: { projectIds: ["other"], repoRemotes: ["*"] } },
      { ...provider, id: "other-quest", match: { questIds: ["other"], keeperEnvironmentProviders: ["vendor-workspace"] } },
      current,
    ];
    expect((await resolvePlacementRoute(policy(rules), context, d)).match).toMatchObject({ state: "matched", rule: { id: "current" } });
    expect(d.readIdentity).not.toHaveBeenCalled(); expect(d.inspectSource).not.toHaveBeenCalled();
  });

  it("an explicit current catch-all does not inspect later provider rules or reserve anything", async () => {
    const d = deps();
    expect((await resolvePlacementRoute(policy([current, { ...provider, match: { keeperPathGlobs: ["/**"] } }]), context, d)).match)
      .toMatchObject({ state: "matched", rule: { target: { kind: "current" } } });
    expect(d.readIdentity).not.toHaveBeenCalled(); expect(d.inspectSource).not.toHaveBeenCalled();
  });

  it("reads only SDK identity for a provider-id condition, not native paths", async () => {
    const d = deps(), rule = { ...current, match: { keeperEnvironmentProviders: ["vendor-workspace"] } };
    const result = await resolvePlacementRoute(policy([rule]), context, d);
    expect(result.match).toMatchObject({ state: "matched", rule: { id: "current" } });
    expect(result.identity).toEqual(identity);
    expect(d.readIdentity).toHaveBeenCalledOnce(); expect(d.inspectSource).not.toHaveBeenCalled();
  });

  it("does not probe native paths after the SDK provider already fails the rule", async () => {
    const d = deps(), rule = { ...provider, match: { keeperEnvironmentProviders: ["missing"], keeperPathGlobs: ["/**"] } };
    expect((await resolvePlacementRoute(policy([rule, current]), context, d)).match).toMatchObject({ state: "matched", rule: { id: "current" } });
    expect(d.readIdentity).toHaveBeenCalledOnce(); expect(d.inspectSource).not.toHaveBeenCalled();
  });

  it("matches path globs using the inspected guest root/home, not the SDK spelling or server home", async () => {
    const d = deps(), rule = { ...provider, match: { keeperPathGlobs: ["~/repo"] } };
    const result = await resolvePlacementRoute(policy([rule]), context, d);
    expect(result.match).toMatchObject({ state: "matched", matchEvidence: [{ field: "keeperPathGlobs", value: "/guest/home/repo", pattern: "~/repo" }] });
    expect(result.source).toEqual(source);
    expect(d.inspectSource).toHaveBeenCalledOnce(); expect(d.readIdentity).not.toHaveBeenCalled();
  });

  it("uses actual inspected repository identities and preserves a missing remote fact as unknown", async () => {
    const d = deps(), rule = { ...provider, match: { repoRemotes: ["example.test/Org/repo"] } };
    expect((await resolvePlacementRoute(policy([rule]), context, d)).match.state).toBe("compatibility");
    d.inspectSource.mockResolvedValueOnce({ ...source, inspection: Object.assign({}, source.inspection, { repoRemotes: ["https://secret@example.test/Org/repo.git"] }) });
    const result = await resolvePlacementRoute(policy([rule]), context, d);
    expect(result.match).toMatchObject({ state: "matched", matchEvidence: [{ field: "repoRemotes", value: "example.test/Org/repo", pattern: "example.test/Org/repo" }] });
  });

  it("an unavailable fact misses its condition visibly; it is not a broken winning target fallback", async () => {
    const d = deps();
    d.inspectSource.mockResolvedValue({ state: "unavailable", code: "source-unavailable", message: "Host disconnected" });
    const result = await resolvePlacementRoute(policy([{ ...provider, match: { keeperPathGlobs: ["/**"] } }, current]), context, d);
    expect(result.match).toMatchObject({ state: "matched", rule: { id: "current" } });
    expect(result.facts.keeperPath).toBeNull();
    expect(result.warnings).toContain("Host disconnected");
  });

  it("keeps a winning provider target even if a current rule follows it", async () => {
    const d = deps(), result = await resolvePlacementRoute(policy([provider, current]), context, d);
    expect(result.match).toMatchObject({ state: "matched", rule: { id: "provider", target: { kind: "provider" } } });
    expect(d.inspectSource).not.toHaveBeenCalled();
  });

  it("loads native facts once for several candidate rules", async () => {
    const d = deps();
    const result = await resolvePlacementRoute(policy([
      { ...provider, match: { keeperPathGlobs: ["/no"] } }, { ...current, match: { keeperPathGlobs: ["~/repo"] } },
    ]), context, d);
    expect(result.match).toMatchObject({ state: "matched", rule: { id: "current" } });
    expect(d.inspectSource).toHaveBeenCalledOnce();
  });

  it("does not publish cancelled matching facts, even if the dependency ignores its signal", async () => {
    const d = deps(), cancellation = new AbortController();
    d.inspectSource.mockImplementation(async () => { cancellation.abort(new Error("Preview superseded")); return source; });
    await expect(resolvePlacementRoute(policy([{ ...provider, match: { keeperPathGlobs: ["/**"] } }]), { ...context, signal: cancellation.signal }, d))
      .rejects.toThrow("Preview superseded");
  });
});
