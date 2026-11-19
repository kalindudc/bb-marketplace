// @vitest-environment node
import { expect, it, vi } from "vitest";
import { PlacementForge } from "../../src/server/placement/forge";
import type { TavernRuntime } from "../../src/server/runtime";
import { placementRuleSchema, placementSettingsSchema } from "../../src/shared/placement-settings";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

it.each([false, true])("records a member-machine draft without pushing (placed: %s)", async placed => {
  const host = { call: vi.fn(async (_host: string, method: string, _input?: unknown) => {
    if (method === "registerEndpoint") return { registered: true, generation: 1 };
    if (method === "inspect") return { platform: "linux", home: "/home", tmp: ["/tmp"], piAgentDir: null, root: "/repo", branch: "member-work", head: "a".repeat(40), tree: "b".repeat(40), objectFormat: "sha1", sourceBase: { outcome: "ok", via: "upstream", base: "a".repeat(40), remoteName: "origin", remoteUrl: "/remote", trackingRef: "refs/remotes/origin/main", fetchRef: placed ? "refs/heads/wrong-inspection-base" : "refs/heads/main" }, linkedWorktree: false, features: { porcelain: true, exportChanges: true, objectImport: true } };
    throw new Error("Unexpected mutation: " + method);
  }) };
  const recordPullRequest = vi.fn(input => ({ ...input, id: "pr" }));
  const member = { classId: "smith", keeperThreadId: "keeper", boardQuestId: "quest" };
  const runtime = { bb: { sdk: { threads: { get: async () => ({ id: "member", projectId: "project", environmentId: "env", archivedAt: null, deletedAt: null }) }, environments: { get: async () => ({ id: "env", projectId: "project", status: "ready", hostLifecycle: "active", lifecycle: { phase: "active" }, hostId: "host", path: "/repo", environmentProviderId: "checkout", branchName: "member-work", baseBranch: "wrong-environment-base" }) } } }, placements: () => ({ host, store: { byMember: () => placed ? { sourceSnapshotId: "initial", pullRequests: { at: "member" } } : null, snapshot: () => ({ fetch: { fetchRef: "refs/heads/main" } }) } }), keeper: { member: () => member, changed: vi.fn(), now: () => 1, store: { all: () => [], runtime: () => ({ projectId: "project" }), recordPullRequest } } } as unknown as TavernRuntime;
  expect(await new PlacementForge(runtime).forThread("member", { title: "Draft", url: "https://forge.example/pr/12" })).toContain("draft; owner: member");
  expect(recordPullRequest).toHaveBeenCalledWith(expect.objectContaining({ forge: null, base: "main", memberHead: "a".repeat(40), pushedHead: null, owner: "member", state: "draft" }), 1);
  expect(host.call.mock.calls.map(call => call[1])).toEqual(["registerEndpoint", "inspect"]);
  expect(host.call.mock.calls[0]![2]).toMatchObject({ git: placed ? "porcelain" : "full" });
});
it("keeps an explicit member rule unchanged through settings parsing", () => {
  const rule = placementRuleSchema.parse({ id: "work", label: "Work", enabled: true, match: {}, target: { kind: "current" }, pullRequests: { at: "member" } });
  expect(placementSettingsSchema.parse({ rules: [rule] }).rules[0]).toEqual(rule);
});
it("contains no machine provider or private forge integration in source", () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
  const forbidden = /\baquifer\b|delta\.shopify|github\.com\/Shopify|shop\/world|\bWorld\b|["']dt (?:pr|deploy|status)\b/i;
  const matches = walk(join(import.meta.dirname, "../../src")).filter(path => {
    if (!/\.(?:ts|tsx|md|css)$/.test(path)) return false;
    const source = readFileSync(path, "utf8");
    let checked = source;
    if (path === join(import.meta.dirname, "../../src/scope/acts.ts")) {
      // The scope catalogue classifies these command names; they are not provider coupling.
      checked = checked.replaceAll(/(?<![\w-])aquifer-machines(?![\w-])/g, "classified-command");
      for (const label of ["dt pr merge", "dt pr approve", "dt pr create|edit|comment", "dt deploy"])
        checked = checked.replaceAll(JSON.stringify(label), JSON.stringify("classified-command"));
    }
    return forbidden.test(checked);
  });
  expect(matches).toEqual([]);
});
