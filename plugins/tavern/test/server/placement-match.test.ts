// @vitest-environment node
import { describe, expect, it } from "vitest";
import { placementRuleSchema, placementSettingsSchema } from "../../src/shared/placement-settings";
import { matchPlacementRule, type PlacementFacts } from "../../src/server/placement/match";

const facts: PlacementFacts = {
  projectId: "project", repoRemotes: ["ssh://git@GitHub.com/Shop/Repo.git"],
  keeperPath: "/remote/home/world/trees/work/src", keeperHome: "/remote/home",
  keeperEnvironmentProvider: "world", classId: "smith", questId: "quest",
};
function rule(id: string, match = {}, extra = {}) {
  return placementRuleSchema.parse({ id, label: id, enabled: true, match, target: { kind: "current" }, ...extra });
}
function policy(rules = [rule("catch-all")]) {
  return { state: "valid" as const, revision: 3, settings: placementSettingsSchema.parse({ rules }) };
}

describe("pure machine rule matching", () => {
  it("keeps empty rules and no match on the compatibility path", () => {
    expect(matchPlacementRule(policy([]), facts)).toEqual({ state: "compatibility", revision: 3 });
    expect(matchPlacementRule(policy([rule("other", { projectIds: ["another"] })]), facts).state).toBe("compatibility");
  });

  it("uses first enabled match, with AND between fields and OR within a field", () => {
    const rules = [
      rule("disabled", {}, { enabled: false }),
      rule("wrong-class", { projectIds: ["project"], classes: ["warden"] }),
      rule("match", {
        projectIds: ["other", "project"], repoRemotes: ["github.com/Shop/*"],
        keeperPathGlobs: ["~/world/trees/*/src"], keeperEnvironmentProviders: ["world"],
        classes: ["ranger", "smith"], questIds: ["quest"],
      }),
      rule("catch-all"),
    ];
    const result = matchPlacementRule(policy(rules), facts);
    expect(result.state).toBe("matched");
    if (result.state !== "matched") throw new Error("Expected match");
    expect(result.rule.id).toBe("match");
    expect(result.matchEvidence).toHaveLength(6);
    expect(result.matchEvidence).toContainEqual({ field: "repoRemotes", value: "github.com/Shop/Repo", pattern: "github.com/Shop/*" });
    expect(result.definitionDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not match a required fact that is absent, including errand quest identity", () => {
    for (const [match, absent] of [
      [{ projectIds: ["project"] }, { projectId: null }],
      [{ repoRemotes: ["*"] }, { repoRemotes: null }],
      [{ keeperPathGlobs: ["*"] }, { keeperPath: null }],
      [{ keeperPathGlobs: ["~/*"] }, { keeperHome: null }],
      [{ keeperEnvironmentProviders: ["world"] }, { keeperEnvironmentProvider: null }],
      [{ questIds: ["quest"] }, { questId: null }],
    ] as const) {
      expect(matchPlacementRule(policy([rule("needs-fact", match)]), { ...facts, ...absent }).state).toBe("compatibility");
    }
  });

  it("normalizes Git transports and strips credentials without changing repository case", () => {
    const rules = [rule("repo", { repoRemotes: ["git@github.com:Shop/Repo.git"] })];
    const result = matchPlacementRule(policy(rules), { ...facts, repoRemotes: ["https://user:secret@GITHUB.com/Shop/Repo.git"] });
    expect(result.state).toBe("matched");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(matchPlacementRule(policy(rules), { ...facts, repoRemotes: ["https://github.com/shop/repo.git"] }).state).toBe("compatibility");
  });

  it("expands home and matches paths using supplied host facts, not the server home", () => {
    const rules = [rule("path", { keeperPathGlobs: ["~/world/*"] })];
    expect(matchPlacementRule(policy(rules), facts).state).toBe("matched");
    expect(matchPlacementRule(policy(rules), { ...facts, keeperHome: "/somewhere/else" }).state).toBe("compatibility");
    expect(matchPlacementRule(policy([rule("windows", { keeperPathGlobs: ["~/work/*"] })]), {
      ...facts, keeperHome: "C:\\Remote", keeperPath: "C:\\Remote\\work\\repo",
    }).state).toBe("matched");
  });

  it("makes a corrupt present policy a blocker rather than empty rules", () => {
    const problems = [{ path: "machines.rules", message: "Corrupt stored policy" }];
    expect(matchPlacementRule({ state: "invalid", revision: 4, problems }, facts)).toEqual({
      state: "blocked", revision: 4, code: "invalid-machine-policy", problems,
    });
  });

  it("does not fall through a matching rule whose provider needs runtime repair", () => {
    const first = rule("missing-provider", {}, { target: {
      kind: "provider", environmentProviderId: "uninstalled", machine: { type: "keeper" }, workspace: "linked-worktree",
    } });
    const result = matchPlacementRule(policy([first, rule("fallback")]), facts);
    expect(result.state === "matched" && result.rule.id).toBe("missing-provider");
  });

  it("keeps a canonical definition digest when opaque input key order changes", () => {
    const target = (inputs: object) => ({ kind: "provider", environmentProviderId: "provider", machine: { type: "keeper" }, workspace: "linked-worktree", inputs });
    const first = matchPlacementRule(policy([rule("same", {}, { target: target({ B: null, A: { n: 1 } }) })]), facts);
    const second = matchPlacementRule(policy([rule("same", {}, { target: target({ A: { n: 1 }, B: null }) })]), facts);
    expect(first.state === "matched" && first.definitionDigest).toBe(second.state === "matched" && second.definitionDigest);
  });
});
