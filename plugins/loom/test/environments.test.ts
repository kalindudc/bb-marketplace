import { describe, expect, it } from "vitest";
import { environmentFor, fillInputs, inputsProblems, mergePatch, spawnEnvironment, threadBranch, unknownPlaceholders, usesNewMachine } from "../src/environments";
import type { EnvironmentProviderInfo } from "../src/ports";
import { repoSettings } from "../src/repos";
import { parseSpec } from "../src/spec";
import { specToml, type Doc } from "./helpers";

// A provider's inputs schema shaped like a real one: a named tree with paths, or a claim of a pooled checkout.
const TREES_SCHEMA = {"$schema":"https://json-schema.org/draft/2020-12/schema","anyOf":[{"type":"object","properties":{"tree":{"type":"string","minLength":1},"paths":{"maxItems":50,"type":"array","items":{"type":"string","minLength":1}},"path":{"type":"string","minLength":1},"branch":{"type":"string","minLength":1}},"required":["tree"],"additionalProperties":false},{"type":"object","properties":{"pool":{"type":"object","properties":{"branch":{"type":"string","minLength":1,"maxLength":200,"pattern":"^(?!-)(?!.*\\.\\.)(?!.*\\/\\/)[A-Za-z0-9._/-]+(?<![./])$"},"from":{"type":"string","minLength":1,"pattern":"^[A-Za-z0-9][A-Za-z0-9._-]*$"},"paths":{"minItems":1,"maxItems":50,"type":"array","items":{"type":"string","minLength":1}},"base":{"type":"string","minLength":1,"maxLength":200,"pattern":"^(?!-)[A-Za-z0-9._/@^~-]+$"},"mergeBaseBranch":{"type":"string","minLength":1,"maxLength":200}},"required":["branch","from","paths"],"additionalProperties":false}},"required":["pool"],"additionalProperties":false}]};

const trees: EnvironmentProviderInfo = {
  id: "example-trees",
  displayName: "Example trees",
  description: "Attach a thread to a prepared tree.",
  pluginId: "example-trees",
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
    const inputs = { pool: { branch: "{branch}", base: "{base}", paths: ["a/{branch}", 3], keep: true } };
    expect(fillInputs(inputs, { branch: "loom/csv/csv-1-1", base: "origin/main" })).toEqual({ pool: { branch: "loom/csv/csv-1-1", base: "origin/main", paths: ["a/loom/csv/csv-1-1", 3], keep: true } });
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
    expect(spawnEnvironment(settingsWith({ provider: "example-trees", inputs: { tree: "loom-{branch}" } }), values)).toEqual({ providerId: "example-trees", inputs: { tree: "loom-loom/csv/csv-1-1" } });
    expect(spawnEnvironment(settingsWith({ provider: "elsewhere" }), values)).toEqual({ providerId: "elsewhere", inputs: null });
  });
});

describe("inputsProblems against a provider's schema", () => {
  it("accepts a tree with paths, and a pool claim with Loom's placeholders", () => {
    expect(inputsProblems("environment", trees, { tree: "loom-csv", paths: ["services/orders"], branch: "{branch}" })).toEqual([]);
    expect(inputsProblems("environment", trees, { pool: { branch: "{branch}", base: "{base}", from: "root", paths: ["services/orders"] } })).toEqual([]);
  });

  it("refuses missing inputs, inputs without a tree and an unknown key, quoting the provider and its schema", () => {
    const [missing] = inputsProblems("environment", trees, undefined);
    expect(missing).toMatch(/^environment\.inputs: the environment provider Example trees \(example-trees: Attach a thread to a prepared tree\) needs inputs, and its inputs schema is \{/u);
    expect(missing).toContain("Ask the human");
    const [noTree] = inputsProblems("repo[0].environment", trees, { paths: ["services/orders"] });
    expect(noTree).toMatch(/^repo\[0\]\.environment\.inputs: .*They do not match the environment provider Example trees/u);
    expect(inputsProblems("environment", trees, { tree: "x", colour: "red" })).toHaveLength(1);
  });

  it("refuses inputs for a provider that takes none, and accepts none for one that accepts empty inputs", () => {
    const plain = { ...trees, id: "plain", acceptsEmptyInputs: true, inputs: null };
    expect(inputsProblems("environment", plain, { a: 1 })).toEqual(["environment.inputs: the environment provider Example trees (plain: Attach a thread to a prepared tree) takes no inputs. Remove environment.inputs."]);
    expect(inputsProblems("environment", plain, undefined)).toEqual([]);
  });
});

describe("mergePatch", () => {
  it("merges tables key by key, removes a key for null, and replaces arrays and plain values", () => {
    const target = { pool: { branch: "{branch}", paths: ["a", "b"], setup: true }, keep: 1 };
    expect(mergePatch(target, { pool: { paths: ["a"], setup: null }, extra: "x" })).toEqual({ pool: { branch: "{branch}", paths: ["a"] }, keep: 1, extra: "x" });
    expect(target.pool.paths).toEqual(["a", "b"]);
    expect(mergePatch({ a: 1 }, "plain")).toBe("plain");
    expect(mergePatch("plain", { a: { b: 1 } })).toEqual({ a: { b: 1 } });
  });
});

describe("environmentFor: reviewers and tickets", () => {
  const values = { branch: "loom/csv/csv-1-1", base: "origin/main" };
  const pool = { provider: "example-pool", inputs: { pool: { branch: "{branch}", base: "{base}", paths: ["services/orders", "services/billing"], setup: true } } };

  it("applies a ticket's own patch over the repo's inputs", () => {
    const ticket = { pool: { paths: ["services/orders"] } };
    expect(environmentFor(settingsWith(pool), ticket)).toEqual({ provider: "example-pool", inputs: { pool: { branch: "{branch}", base: "{base}", paths: ["services/orders"], setup: true } } });
    expect(spawnEnvironment(settingsWith(pool), values)).toEqual({ providerId: "example-pool", inputs: { pool: { branch: values.branch, base: values.base, paths: ["services/orders", "services/billing"], setup: true } } });
    expect(environmentFor(settingsWith(undefined), ticket)).toBeNull();
  });

  it("refuses environment.reviewer, and a ticket patch where the repo has no environment", () => {
    expect(parseSpec(specToml((doc) => (doc.environment = { ...pool, reviewer: { inputs: { at: "{base}" } } }))).errors).toEqual([
      "environment.reviewer: Loom no longer reads this key. Reviewers, the spec reviewer and the summary agent start in the repo's own environment, as workers do: remove the key.",
    ]);
    expect(parseSpec(specToml((doc) => (doc.ticket[0].environment = { inputs: { pool: { paths: ["a"] } } }))).errors).toContain(
      "ticket[0].environment: the ticket's repo starts its threads in git worktrees, with no environment inputs to patch. Remove ticket[0].environment, or set an [environment] with a provider for the repo.",
    );
    const ok = parseSpec(specToml((doc) => {
      doc.environment = pool;
      doc.ticket[0].environment = { inputs: { pool: { paths: ["services/orders"] } } };
    }));
    expect(ok.errors).toEqual([]);
    expect(ok.spec!.ticket[0]!.environment).toEqual({ inputs: { pool: { paths: ["services/orders"] } } });
  });
});

describe("environmentFor: new machines", () => {
  const values = { branch: "loom/csv/csv-1-1", base: "origin/main" };
  const onBoxes = { provider: "git-worktree", machine: { provider: "boxes", inputs: { name: "{branch}" } } };
  const settingsOn = (environment: Doc) => {
    const parsed = parseSpec(specToml((doc) => ((doc.merge = { strategy: "pr", stack: false }), (doc.environment = environment))));
    if (parsed.spec === null) throw new Error(parsed.errors.join("\n"));
    return repoSettings(parsed.spec, null);
  };

  it("starts workers on a new machine from the repo's machine provider, with its inputs filled in", () => {
    const settings = settingsOn(onBoxes);
    // bb refuses null inputs for git-worktree; the named base is the one the managed worktree starts from.
    expect(spawnEnvironment(settings, values)).toEqual({ providerId: "git-worktree", inputs: { branch: { kind: "named", name: values.base } }, machine: { providerId: "boxes", inputs: { name: values.branch } } });
    expect(usesNewMachine(settings)).toBe(true);
    expect(usesNewMachine(settingsWith(undefined))).toBe(false);
    expect(usesNewMachine(settingsWith({ provider: "git-worktree" }))).toBe(false);
  });

});
