import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { freshBaseOf, gitNetwork, isMultiRepo, repoSettings } from "../src/repos";
import { parseSpec, type Spec } from "../src/spec";
import { freshBase } from "../src/workers";
import { specToml, type Doc } from "./helpers";

function spec(edit?: (doc: Doc) => void): Spec {
  const result = parseSpec(specToml(edit));
  expect(result.errors).toEqual([]);
  return result.spec!;
}

const topLevel = (doc: Doc) => {
  doc.project.base = "develop";
  doc.merge.remote = "origin";
  doc.checks = { commands: ["npm test"], after_merge: ["npm run build"] };
  doc.scope = { protected: ["package-lock.json"] };
};

const multi = (edit?: (doc: Doc) => void) =>
  spec((doc) => {
    topLevel(doc);
    doc.repo = [
      { name: "web", project: "proj_web" },
      { name: "api", project: "proj_api", base: "trunk", remote: "upstream", checks: ["make test"], after_merge: ["make build"], protected: ["vendor/**"] },
      { name: "docs", project: "proj_docs", checks: [], after_merge: [] },
    ];
    doc.ticket[0].repo = "web";
    doc.ticket[1].repo = "api";
    edit?.(doc);
  });

describe("isMultiRepo", () => {
  it("is true only when the spec lists repos", () => {
    expect(isMultiRepo(spec())).toBe(false);
    expect(isMultiRepo(multi())).toBe(true);
    expect(isMultiRepo({ ...spec(), repo: [] })).toBe(false);
  });

  it("reads a spec stored before repos existed, which has no repo key, as single-repo", () => {
    const stored = JSON.parse(JSON.stringify(spec())) as Spec;
    expect("repo" in stored).toBe(false);
    expect(isMultiRepo(stored)).toBe(false);
    expect(repoSettings(stored, null).bbProjectId).toBeNull();
  });
});

describe("repoSettings", () => {
  it("gives the project's own repo the top-level values in a single-repo spec", () => {
    expect(repoSettings(spec(topLevel), null)).toStrictEqual({
      name: null,
      bbProjectId: null,
      base: "develop",
      remote: "origin",
      branch: "loom/csv",
      checks: ["npm test"],
      afterMerge: ["npm run build"],
      protected: ["package-lock.json"],
      forge: { kind: "gh" },
      ci: false,
      environment: null,
      worktree: null,
      gitNetworkTimeoutMs: null,
    });
  });

  it("takes base, remote, checks and after_merge from the top level when the repo does not set them", () => {
    expect(repoSettings(multi(), "web")).toStrictEqual({
      name: "web",
      bbProjectId: "proj_web",
      base: "develop",
      remote: "origin",
      branch: "loom/csv",
      checks: ["npm test"],
      afterMerge: ["npm run build"],
      protected: ["package-lock.json"],
      forge: { kind: "gh" },
      ci: false,
      environment: null,
      worktree: null,
      gitNetworkTimeoutMs: null,
    });
  });

  it("uses the repo's own values when it sets them, and adds its protected globs to the top-level ones", () => {
    expect(repoSettings(multi(), "api")).toStrictEqual({
      name: "api",
      bbProjectId: "proj_api",
      base: "trunk",
      remote: "upstream",
      branch: "loom/csv",
      checks: ["make test"],
      afterMerge: ["make build"],
      protected: ["package-lock.json", "vendor/**"],
      forge: { kind: "gh" },
      ci: false,
      environment: null,
      worktree: null,
      gitNetworkTimeoutMs: null,
    });
  });

  it("takes the git network timeout from the repo, else from merge, else leaves it to the host, and sends it only when set", () => {
    const set = multi((doc) => {
      doc.merge.git_network_timeout_seconds = 180;
      doc.repo[1].git_network_timeout_seconds = 300;
    });
    expect(["web", "api", "docs"].map((name) => repoSettings(set, name).gitNetworkTimeoutMs)).toEqual([180_000, 300_000, 180_000]);
    expect(gitNetwork(repoSettings(set, "api"))).toEqual({ networkTimeoutMs: 300_000 });
    expect(repoSettings(spec((doc) => (doc.merge.git_network_timeout_seconds = 90)), null).gitNetworkTimeoutMs).toBe(90_000);
    expect(gitNetwork(repoSettings(multi(), "web"))).toEqual({});
  });

  it("refuses a git network timeout outside 30 to 600 seconds", () => {
    for (const seconds of [29, 601, 1.5]) {
      const result = parseSpec(specToml((doc) => (doc.merge.git_network_timeout_seconds = seconds)));
      expect(result.errors.join("\n")).toContain("git_network_timeout_seconds");
    }
  });

  it("lets a repo replace the top-level commands with none", () => {
    expect(repoSettings(multi(), "docs")).toMatchObject({ checks: [], afterMerge: [] });
  });

  it("relies on the pull request's CI on the pr strategy unless the repo or the top level says ci = false, and never where its forge reports no checks", () => {
    const pr = multi((doc) => {
      doc.merge = { strategy: "pr" };
      doc.checks.after_merge = [];
      doc.repo[1].after_merge = [];
      doc.repo[2].after_merge = [];
    });
    expect(["web", "api", "docs"].map((name) => repoSettings(pr, name).ci)).toEqual([true, true, true]);
    const off = multi((doc) => {
      doc.merge = { strategy: "pr" };
      doc.checks = { commands: ["npm test"], ci: false };
      doc.repo[1].after_merge = [];
      doc.repo[1].ci = true;
      doc.repo[2].after_merge = [];
    });
    expect(["web", "api", "docs"].map((name) => repoSettings(off, name).ci)).toEqual([false, true, false]);
    // A spec approved before ci existed, on a forge that reports no checks, is not proposed again: there is no CI to rely on.
    const stored = { ...spec((doc) => (doc.merge = { strategy: "pr", forge: { kind: "command", open: "x", state: "y" } }, doc.checks.ci = false)), checks: { commands: ["npm test"], after_merge: [], timeout_minutes: 15 } } as Spec;
    expect(repoSettings(stored, null).ci).toBe(false);
    expect(repoSettings(spec((doc) => (doc.merge = { strategy: "pr", forge: { kind: "command", open: "x", state: "y", feedback: "z" } })), null).ci).toBe(true);
  });

  it("has no integration branch on the pr strategy", () => {
    const pr = multi((doc) => {
      doc.merge = { strategy: "pr" };
      doc.checks.after_merge = [];
      doc.repo[1].after_merge = [];
    });
    expect(repoSettings(pr, "api").branch).toBeNull();
    expect(repoSettings(spec((doc) => (doc.merge = { strategy: "pr" })), null).branch).toBeNull();
  });

  it("does not hand out the spec's own arrays", () => {
    const parsed = multi();
    repoSettings(parsed, "api").protected.push("x/**");
    repoSettings(parsed, "web").checks.push("x");
    expect(parsed.scope.protected).toEqual(["package-lock.json"]);
    expect(parsed.checks.commands).toEqual(["npm test"]);
  });

  it("throws for a repo the spec does not list, and for no name in a multi-repo spec", () => {
    expect(() => repoSettings(multi(), "mobile")).toThrow('This spec has no repo "mobile"; its repos are web, api, docs.');
    expect(() => repoSettings(spec(), "web")).toThrow('This spec has no [[repo]] table, so it has no repo "web".');
    expect(() => repoSettings(multi(), null)).toThrow("This spec lists [[repo]] tables, so a repo name is required: one of web, api, docs.");
  });
});

describe("freshBaseOf", () => {
  it("starts every repo from the integration branch on the integration strategy", () => {
    const parsed = multi();
    for (const name of ["web", "api", "docs"]) expect(freshBaseOf(parsed, name)).toBe("loom/csv");
  });

  it("starts each repo from its own remote and base on the pr strategy", () => {
    const pr = multi((doc) => {
      doc.merge = { strategy: "pr" };
      doc.checks.after_merge = [];
      doc.repo[1].after_merge = [];
    });
    expect(freshBaseOf(pr, "web")).toBe("origin/develop");
    expect(freshBaseOf(pr, "api")).toBe("upstream/trunk");
  });

  it("agrees with freshBase for the project's own repo in a single-repo spec", () => {
    for (const merge of [{ strategy: "integration" }, { strategy: "integration", branch: "release/csv" }, { strategy: "pr", remote: "upstream" }]) {
      const parsed = spec((doc) => (doc.merge = merge));
      expect(freshBaseOf(parsed, null)).toBe(freshBase(parsed));
    }
  });
});

describe("src/repos.ts", () => {
  it("imports nothing but types from ./spec, so the page can import it", () => {
    const source = readFileSync(new URL("../src/repos.ts", import.meta.url), "utf8");
    expect(source.match(/^import .*$/gm)).toEqual(['import type { EnvironmentSpec, ForgeSpec, RepoSpec, Spec, WorktreeSpec } from "./spec";']);
  });
});
