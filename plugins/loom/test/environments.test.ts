import { describe, expect, it } from "vitest";
import { fillInputs, inputsProblems, spawnEnvironment, threadBranch, unknownPlaceholders } from "../src/environments";
import type { EnvironmentProviderInfo } from "../src/ports";
import { repoSettings } from "../src/repos";
import { parseSpec } from "../src/spec";
import { specToml, type Doc } from "./helpers";

// The World tree provider's inputs schema as `bb environment providers --json` printed it on 2026-10-23.
const TREES_SCHEMA = {"$schema":"https://json-schema.org/draft/2020-12/schema","anyOf":[{"type":"object","properties":{"tree":{"type":"string","minLength":1},"zones":{"maxItems":50,"type":"array","items":{"type":"string","minLength":1}},"zone":{"type":"string","minLength":1},"branch":{"type":"string","minLength":1}},"required":["tree"],"additionalProperties":false},{"type":"object","properties":{"pool":{"type":"object","properties":{"branch":{"type":"string","minLength":1,"maxLength":200,"pattern":"^(?!-)(?!.*\\.\\.)(?!.*\\/\\/)[A-Za-z0-9._/-]+(?<![./])$"},"from":{"type":"string","minLength":1,"pattern":"^[A-Za-z0-9][A-Za-z0-9._-]*$"},"zones":{"minItems":1,"maxItems":50,"type":"array","items":{"type":"string","minLength":1}},"base":{"type":"string","minLength":1,"maxLength":200,"pattern":"^(?!-)[A-Za-z0-9._/@^~-]+$"},"mergeBaseBranch":{"type":"string","minLength":1,"maxLength":200}},"required":["branch","from","zones"],"additionalProperties":false}},"required":["pool"],"additionalProperties":false}]};

const trees: EnvironmentProviderInfo = {
  id: "world-tree",
  displayName: "World tree",
  description: "Attach a thread to the root of a World tree.",
  pluginId: "world-tree",
  acceptsEmptyInputs: false,
  inputs: TREES_SCHEMA,
  available: true,
  unavailableReason: null,
};

const settingsWith = (environment: Doc | undefined) => {
  const parsed = parseSpec(specToml((doc) => (doc.environment = environment)));
  if (parsed.spec === null) throw new Error(parsed.errors.join("\n"));
  return repoSettings(parsed.spec, null);
};

describe("fillInputs and unknownPlaceholders", () => {
  it("fills {branch} and {base} in every string at any depth and leaves everything else as it is", () => {
    const inputs = { pool: { branch: "{branch}", base: "{base}", zones: ["a/{branch}", 3], keep: true } };
    expect(fillInputs(inputs, { branch: "loom/csv/csv-1-1", base: "origin/main" })).toEqual({ pool: { branch: "loom/csv/csv-1-1", base: "origin/main", zones: ["a/loom/csv/csv-1-1", 3], keep: true } });
    expect(inputs.pool.branch).toBe("{branch}");
  });

  it("names the placeholders Loom does not fill", () => {
    expect(unknownPlaceholders({ a: "{branch}", b: ["{ticket}", "{slug} {ticket}"] })).toEqual(["ticket", "slug"]);
  });
});

describe("threadBranch", () => {
  it("is loom/<slug>/<key>-<suffix>, lower-cased", () => {
    expect(threadBranch("csv", "CSV-1", "2")).toBe("loom/csv/csv-1-2");
  });
});

describe("spawnEnvironment", () => {
  const values = { branch: "loom/csv/csv-1-1", base: "origin/main" };

  it("keeps the managed worktree without an environment, and for git-worktree with no inputs", () => {
    expect(spawnEnvironment(settingsWith(undefined), values)).toBeUndefined();
    expect(spawnEnvironment(settingsWith({ provider: "git-worktree" }), values)).toBeUndefined();
  });

  it("names the provider with its inputs filled in, and null inputs when the spec gives none", () => {
    expect(spawnEnvironment(settingsWith({ provider: "world-tree", inputs: { tree: "loom-{branch}" } }), values)).toEqual({ providerId: "world-tree", inputs: { tree: "loom-loom/csv/csv-1-1" } });
    expect(spawnEnvironment(settingsWith({ provider: "elsewhere" }), values)).toEqual({ providerId: "elsewhere", inputs: null });
  });
});

describe("inputsProblems against the World tree schema", () => {
  it("accepts a tree with zones, and a pool claim with Loom's placeholders", () => {
    expect(inputsProblems("environment", trees, { tree: "loom-csv", zones: ["areas/tools/brain"], branch: "{branch}" })).toEqual([]);
    expect(inputsProblems("environment", trees, { pool: { branch: "{branch}", base: "{base}", from: "root", zones: ["areas/tools/brain"] } })).toEqual([]);
  });

  it("refuses missing inputs, inputs without a tree and an unknown key, quoting the provider and its schema", () => {
    const [missing] = inputsProblems("environment", trees, undefined);
    expect(missing).toMatch(/^environment\.inputs: the environment provider World tree \(world-tree: Attach a thread to the root of a World tree\) needs inputs, and its inputs schema is \{/u);
    expect(missing).toContain("Ask the human");
    const [noTree] = inputsProblems("repo[0].environment", trees, { zones: ["areas/tools/brain"] });
    expect(noTree).toMatch(/^repo\[0\]\.environment\.inputs: .*They do not match the environment provider World tree/u);
    expect(inputsProblems("environment", trees, { tree: "x", colour: "red" })).toHaveLength(1);
  });

  it("refuses inputs for a provider that takes none, and accepts none for one that accepts empty inputs", () => {
    const plain = { ...trees, id: "plain", acceptsEmptyInputs: true, inputs: null };
    expect(inputsProblems("environment", plain, { a: 1 })).toEqual(["environment.inputs: the environment provider World tree (plain: Attach a thread to the root of a World tree) takes no inputs. Remove environment.inputs."]);
    expect(inputsProblems("environment", plain, undefined)).toEqual([]);
  });
});
