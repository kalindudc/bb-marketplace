import { beforeEach, describe, expect, it } from "vitest";
import { discoverText, gatherFacts, reachErrors, specTargets } from "../src/discover";
import type { EnvironmentProviderInfo } from "../src/ports";
import { parseSpec, type Spec } from "../src/spec";
import { FakeHost, FakePort, GIT_WORKTREE_PROVIDER, specToml, type Doc } from "./helpers";

let bb: FakePort;
let host: FakeHost;

const TREES: EnvironmentProviderInfo = {
  ...GIT_WORKTREE_PROVIDER,
  id: "trees",
  displayName: "Trees",
  description: "Attach a thread to a tree.",
  pluginId: "trees",
  acceptsEmptyInputs: false,
  inputs: { type: "object", properties: { tree: { type: "string" } }, required: ["tree"], additionalProperties: false },
};

beforeEach(() => {
  bb = new FakePort();
  host = new FakeHost();
  bb.checkout = "/repo";
});

const spec = (edit?: (doc: Doc) => void): Spec => {
  const parsed = parseSpec(specToml(edit));
  if (parsed.spec === null) throw new Error(parsed.errors.join("\n"));
  return parsed.spec;
};
const errorsOf = async (edit?: (doc: Doc) => void) => reachErrors(await gatherFacts({ bb, host }, specTargets(spec(edit), "proj_1"), "host_1"));
const report = async () => discoverText(await gatherFacts({ bb, host }, [{ label: "this thread's repository", index: null, bbProjectId: "proj_1", settings: null }], "host_1"));

describe("reachErrors", () => {
  it("accepts a GitHub repository with plain worktrees", async () => {
    expect(await errorsOf()).toEqual([]);
  });

  it("refuses a remote the repository does not have, listing the ones it has", async () => {
    host.remoteList = [{ name: "delta", pushUrls: ["https://delta.example.com/shop/world.git"] }];
    const [error] = await errorsOf();
    expect(error).toBe('merge.remote: the project\'s repository has no git remote "origin"; its remotes are delta (https://delta.example.com/shop/world.git). Ask the human which remote its pull requests go through, and set merge.remote.');
  });

  it("refuses gh where gh is not signed in, naming the host and the forge keys, and accepts a command or push-only forge there", async () => {
    host.remoteList = [{ name: "origin", pushUrls: ["https://review.example.com/shop/world.git"] }];
    host.ghState = "signed_out";
    const [error] = await errorsOf();
    expect(error).toMatch(/^merge\.forge: the project's repository pushes to https:\/\/review\.example\.com\/shop\/world\.git, and gh is not signed in to review\.example\.com, so Loom cannot open its pull requests with gh\. Set merge\.forge to kind = "command"/u);
    expect(await errorsOf((doc) => (doc.merge.forge = { kind: "none" }))).toEqual([]);
    expect(await errorsOf((doc) => (doc.merge.forge = { kind: "command", open: "o", state: "s" }))).toEqual([]);
    expect(host.callsTo("ghStatus")).toHaveLength(1);
  });

  it("refuses a spec with no environment while a plugin offers one, and checks a chosen provider's inputs", async () => {
    bb.environmentProviderList = [GIT_WORKTREE_PROVIDER, TREES];
    bb.pluginList = [...bb.pluginList, { id: "trees", enabled: true, builtin: false }];
    const [error] = await errorsOf();
    expect(error).toMatch(/^environment: bb offers Trees \(trees: Attach a thread to a tree\) for the project's repository on this machine, besides its own git worktrees\. Ask the human/u);
    expect(await errorsOf((doc) => (doc.environment = { provider: "git-worktree" }))).toEqual([]);
    expect(await errorsOf((doc) => (doc.environment = { provider: "trees", inputs: { tree: "loom-{branch}" } }))).toEqual([]);
    const [inputs] = await errorsOf((doc) => (doc.environment = { provider: "trees", inputs: { zones: ["a"] } }));
    expect(inputs).toMatch(/^environment\.inputs: /u);
  });

  it("refuses a provider bb does not offer here, or one that is unavailable", async () => {
    bb.environmentProviderList = [GIT_WORKTREE_PROVIDER, { ...TREES, available: false, unavailableReason: "Only for the shop project." }];
    expect(await errorsOf((doc) => (doc.environment = { provider: "nope" }))).toEqual(['environment.provider: bb has no environment provider "nope" for the project\'s repository on this machine. Use one of: git-worktree.']);
    const [unavailable] = await errorsOf((doc) => (doc.environment = { provider: "trees", inputs: { tree: "t" } }));
    expect(unavailable).toContain("is not available for the project's repository on this machine: Only for the shop project.");
  });

  it("refuses the integration strategy when git refused Loom's own worktree, until a worktree command is set", async () => {
    host.trial = { outcome: "refused", message: "fatal: refusing to create a worktree outside the allowed locations" };
    const [error] = await errorsOf();
    expect(error).toMatch(/^merge\.worktree: Loom cannot add its own worktree of the project's repository on this machine; git said: fatal: refusing/u);
    expect(await errorsOf((doc) => (doc.merge = { strategy: "pr" }))).toEqual([]);
    expect(await errorsOf((doc) => (doc.merge.worktree = { command: "prepare" }))).toEqual([]);
  });

  it("checks a plugin worktree: installed, turned on, and a CLI command of the plugin", async () => {
    const withPlugin = (doc: Doc) => (doc.merge.worktree = { plugin: "trees", command: 'prepare "loom-$LOOM_PROJECT_SLUG"' });
    expect(await errorsOf(withPlugin)).toEqual(['merge.worktree.plugin: bb has no plugin "trees". Install it, or name another plugin, or drop plugin and give a shell command.']);
    bb.pluginList = [...bb.pluginList, { id: "trees", enabled: false, builtin: false }];
    expect((await errorsOf(withPlugin))[0]).toContain('the plugin "trees" is turned off');
    bb.pluginList = bb.pluginList.map((plugin) => (plugin.id === "trees" ? { ...plugin, enabled: true } : plugin));
    expect(await errorsOf(withPlugin)).toEqual([]);
    expect(host.callsTo("exec").at(-1)).toMatchObject({ cwd: "/repo", command: "bb plugin run trees prepare --help" });
    host.execResults.push({ exitCode: 1, output: "unknown command" });
    expect((await errorsOf(withPlugin))[0]).toMatch(/^merge\.worktree\.command: `bb plugin run trees prepare --help` failed/u);
  });

  it("names each [[repo]] by its index", async () => {
    bb.addBbProject("proj_web", { host_1: "/src/web" });
    host.remoteList = [{ name: "origin", pushUrls: ["https://review.example.com/web.git"] }];
    host.ghState = "signed_out";
    const multi = spec((doc) => {
      doc.repo = [{ name: "web", project: "proj_web", forge: { kind: "none" } }, { name: "api", project: "proj_1" }];
      doc.ticket[0].repo = "web";
      doc.ticket[1].repo = "api";
    });
    const errors = reachErrors(await gatherFacts({ bb, host }, specTargets(multi, "proj_1"), "host_1"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^repo\[1\]\.forge: the repo "api" pushes to/u);
  });
});

describe("discoverText", () => {
  it("reports every choice as found for a GitHub repository", async () => {
    const text = await report();
    expect(text).toContain("This thread's repository (bb project proj_1), checkout /repo");
    expect(text).toContain("- Remote: found: origin.");
    expect(text).toContain("- Forge for origin: found: gh can open pull requests on github.com.");
    expect(text).toContain("- Environment: found: no plugin offers an environment");
    expect(text).toContain("- Integration worktree: found: Loom can add its own worktree");
    expect(text).not.toContain("ask:");
  });

  it("reports a World-like repository's choices as ask, with each provider's schema and git's refusal", async () => {
    host.remoteList = [
      { name: "delta", pushUrls: ["https://delta.example.com/shop/world.git"] },
      { name: "github", pushUrls: ["https://github.com/shop/world.git"] },
    ];
    host.ghState = "signed_out";
    host.trial = { outcome: "refused", message: "fatal: outside the allowed worktree locations" };
    bb.environmentProviderList = [GIT_WORKTREE_PROVIDER, TREES];
    bb.pluginList = [...bb.pluginList, { id: "trees", enabled: true, builtin: false }];
    const text = await report();
    expect(text).toContain("- Remote: ask: there is no remote named origin.");
    expect(text).toContain("- Forge for delta: ask: gh is not signed in to delta.example.com.");
    expect(text).toContain("  - Trees (trees: Attach a thread to a tree). It needs inputs; inputs schema: {");
    expect(text).toContain("- Environment: ask:");
    expect(text).toContain("- Integration worktree: ask (only for merge.strategy = \"integration\"): git refused Loom's own worktree: fatal: outside the allowed worktree locations");
  });

  it("says a repository has no checkout here, with the clone command", async () => {
    bb.checkout = null;
    expect(await report()).toContain("- ask: it has no checkout on this machine (host_1). Clone it with `bb project source add proj_1 --clone --machine host_1`");
  });
});
