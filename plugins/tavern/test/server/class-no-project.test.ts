// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classExecutionFacts } from "../../src/server/class-execution";
import { Registry } from "../../src/server/registry";
import { TavernRuntime } from "../../src/server/runtime";
import { registerRpc } from "../../src/server/rpc";
import { rpcContract } from "../../src/shared/contract";
import { catalog, model } from "./provider-fixture";
import { setup } from "./runtime-fixture";

const roots: string[] = [];
const ids = ["keeper", "ranger", "smith", "warden", "wanderer"] as const;
const route = "openai-1m/gpt-6.1-sol";
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const f = setup(), root = mkdtempSync(join(tmpdir(), "tavern-class-no-project-")); roots.push(root);
  const home = join(root, "home"), project = join(root, "project"), builtin = f.runtime.registry.directories().builtin;
  mkdirSync(project, { recursive: true });
  const runtime = new TavernRuntime(f.bb, f.k, new Registry(builtin, join(home, ".agents/tavern")));
  runtime.enableScopes({ dataDir: join(root, "scopes"), installGuard: false, policyOptions: { home } });
  const config = runtime.config();
  runtime.config = () => ({ ...config, classes: { ...config.classes, wanderer: { ...config.classes.wanderer, provider: "pi", model: route } } });
  f.bb.sdk.projects.get = async ({ projectId }) => {
    if (projectId !== "project") throw new Error("A real project id is required");
    return { sources: [{ hostId: "host", path: project, isDefault: true }] } as never;
  };
  f.bb.sdk.providers.models = async args => catalog([
    { ...model("anthropic/claude-opus-5-5"), displayName: "Claude Opus 5.5" },
    { ...model("anthropic/claude-sonnet-5-5", undefined, false), displayName: "Claude Sonnet 5.5" },
    { ...model("openai/gpt-6.1-sol", undefined, false), displayName: "GPT 6.1 Sol" },
    ...(args?.projectId === "project" ? [{ ...model(route, undefined, false), displayName: "GPT 6.1 Sol (1M)" }] : []),
  ]);
  registerRpc(f.bb, runtime);
  return { ...f, runtime, root, home, project, builtin };
}

describe("class execution facts without a project", () => {
  it.each(ids)("returns user/built-in %s facts for both modes without querying a project or model catalog", async classId => {
    const f = fixture();
    const prepare = vi.spyOn(f.runtime, "prepareRegistry");
    for (const mode of ["start", "hire"] as const) {
      const facts = await classExecutionFacts(f.runtime, { classId, providerId: "pi", mode });
      expect(facts.errors).toEqual([]);
      expect(facts.fields.length).toBeGreaterThan(7);
      expect(facts.execution).toBeNull();
      expect(facts.projectOverrides).toEqual([]);
      expect(facts.fields.find(field => field.field === "model")).toMatchObject({ dependsOnProject: true });
      expect(facts.fields.find(field => field.field === "scope")).toMatchObject({ dependsOnProject: true });
      expect(facts.fields.find(field => field.field === "tools")?.dependsOnProject).not.toBe(true);
      expect(facts.notes.join(" ")).toMatch(/depends on the project/i);
    }
    expect(prepare).not.toHaveBeenCalled();
    for (const method of ["projects.get", "system.config", "providers.list", "providers.models", "hosts.list", "hosts.experimental_listProviders", "environments.listProviders", "threads.get", "threads.defaultExecutionOptions"]) {
      expect(f.harness.inspection.sdk.callsTo(method), method).toHaveLength(0);
    }
  });

  it.each(ids)("never marks %s's forced facts as Keeper- or project-dependent", async classId => {
    const f = fixture();
    for (const projectId of [undefined, "project"]) for (const mode of ["start", "hire"] as const) {
      const facts = await classExecutionFacts(f.runtime, { classId, projectId, mode });
      if (facts.requiresPi) {
        const provider = facts.fields.find(field => field.field === "provider")!;
        expect(provider).toMatchObject({ value: "pi", source: "forced", rule: "Required by the class's guard." });
        expect(provider.path).toBeUndefined();
      }
      for (const field of facts.fields.filter(field => field.source === "forced")) {
        expect(field.dependsOnProject, `${classId}/${mode}/${field.field}`).not.toBe(true);
        expect(field.varies, `${classId}/${mode}/${field.field}`).toBeUndefined();
      }
    }
  });

  it.each([
    ["ranger", "start", "Claude Sonnet 5.5"],
    ["smith", "start", "GPT 6.1 Sol"], ["warden", "hire", "Claude Sonnet 5.5"],
  ] as const)("resolves %s's model label using its certain guard provider without a parent provider", async (classId, mode, label) => {
    const f = fixture();
    const facts = await classExecutionFacts(f.runtime, { classId, projectId: "project", mode });
    expect(facts.errors).toEqual([]);
    expect(facts.execution?.providerId).toBe("pi");
    expect(facts.fields.find(field => field.field === "model")?.valueLabel).toBe(label);
    expect(f.harness.inspection.sdk.callsTo("providers.models")).toHaveLength(1);
  });

  it("does not force an open Keeper onto Pi or guess its composer provider", async () => {
    const f = fixture();
    const facts = await classExecutionFacts(f.runtime, { classId: "keeper", projectId: "project", mode: "start" });
    expect(facts.errors).toEqual([]);
    expect(facts.requiresPi).toBe(false);
    expect(facts.execution?.providerId).toBeUndefined();
    expect(facts.fields.find(field => field.field === "model")?.valueLabel).toBeUndefined();
    expect(f.harness.inspection.sdk.callsTo("providers.models")).toHaveLength(0);
  });
  it.each(["watch", "off"] as const)("does not guess a provider or model label in %s mode", async mode => {
    const f = fixture(), config = f.runtime.config();
    f.runtime.config = () => ({ ...config, scopes: { mode } });
    const facts = await classExecutionFacts(f.runtime, { classId: "ranger", projectId: "project", mode: "hire" });
    expect(facts.requiresPi).toBe(false);
    expect(facts.execution).toBeNull();
    expect(facts.fields.find(field => field.field === "provider")).toMatchObject({ value: null, source: "keeper", varies: "keeper" });
    expect(facts.fields.find(field => field.field === "model")?.valueLabel).toBeUndefined();
    expect(f.harness.inspection.sdk.callsTo("providers.models")).toHaveLength(0);
  });

  it("leaves an open class's model id unlabelled when the provider is unknown", async () => {
    const f = fixture(), config = f.runtime.config();
    f.runtime.config = () => ({ ...config, classes: { ...config.classes, wanderer: { model: route } } });
    const facts = await classExecutionFacts(f.runtime, { classId: "wanderer", projectId: "project", mode: "start" });
    expect(facts.requiresPi).toBe(false);
    expect(facts.execution).toBeNull();
    expect(facts.fields.find(field => field.field === "model")).toMatchObject({ value: route });
    expect(facts.fields.find(field => field.field === "model")?.valueLabel).toBeUndefined();
    expect(f.harness.inspection.sdk.callsTo("providers.models")).toHaveLength(0);
  });

  it("keeps a warmed project's files and policy out of the no-project RPC", async () => {
    const f = fixture();
    const userClasses = join(f.home, ".agents/tavern/classes"), projectClasses = join(f.project, ".agents/tavern/classes");
    mkdirSync(userClasses, { recursive: true }); mkdirSync(projectClasses, { recursive: true });
    const ranger = readFileSync(join(f.builtin, "classes/ranger.md"), "utf8");
    writeFileSync(join(userClasses, "ranger.md"), ranger + "\nPersonal baseline.\n");
    writeFileSync(join(projectClasses, "ranger.md"), ranger + "\nProject-only body that must not leak into a no-project preview.\n");
    const warmed = await f.runtime.prepareRegistry("project");
    const baseline = f.runtime.snapshot().classes.find(role => role.id === "ranger")!;
    expect(warmed.classes.find(role => role.id === "ranger")?.body).not.toBe(baseline.body);
    const entries = rpcContract.classExecutions.output.parse(await f.harness.invokeRpc("classExecutions", {})).classes;
    expect(entries).toHaveLength(5);
    for (const entry of entries) for (const facts of [entry.start, entry.hire]) {
      expect(facts.errors).toEqual([]);
      expect(facts.fields.some(field => field.source === "project-file")).toBe(false);
    }
    const facts = entries.find(entry => entry.classId === "ranger")!.start;
    expect(facts.body.bytes).toBe(Buffer.byteLength(baseline.body));
    expect(facts.fields.find(field => field.field === "role prompt")).toMatchObject({ source: "user-file", path: join(userClasses, "ranger.md") });
    expect(f.harness.inspection.sdk.callsTo("projects.get")).toHaveLength(1);
    expect(f.harness.inspection.sdk.callsTo("providers.models")).toHaveLength(0);
  });

  it("resolves user-level scope rules without reading project policy", async () => {
    const f = fixture();
    mkdirSync(join(f.home, ".agents/tavern"), { recursive: true });
    mkdirSync(join(f.project, ".agents/tavern"), { recursive: true });
    writeFileSync(join(f.home, ".agents/tavern/scopes.yml"), "v: 1\nrules:\n  - classes:\n      smith:\n        defaults:\n          denyRules: [{id: global-test-denial, argv: [git, status], why: User policy}]\n");
    writeFileSync(join(f.project, ".agents/tavern/scopes.yml"), "v: 1\nrules:\n  - classes:\n      smith:\n        defaults:\n          denyRules: [{id: project-test-denial, argv: [git, log], why: Project policy}]\n");
    await f.runtime.prepareRegistry("project");
    const resolve = vi.spyOn(f.runtime.scopes!.api, "resolve");
    const facts = await classExecutionFacts(f.runtime, { classId: "smith", mode: "start" });
    expect(facts.errors).toEqual([]);
    expect(resolve).toHaveBeenCalledWith("smith", {}, undefined);
    const scope = resolve.mock.results[0]!.value.scope;
    expect(scope.shell.deny.some((rule: { id: string }) => rule.id === "global-test-denial")).toBe(true);
    expect(scope.shell.deny.some((rule: { id: string }) => rule.id === "project-test-denial")).toBe(false);
  });

  it("marks the project-routed Wanderer model as dependent, then verifies its name and id for a chosen project", async () => {
    const f = fixture();
    const baseline = await classExecutionFacts(f.runtime, { classId: "wanderer", mode: "start" });
    expect(baseline.errors).toEqual([]);
    expect(baseline.fields.find(field => field.field === "model")).toMatchObject({ value: route, dependsOnProject: true });
    expect(baseline.execution).toBeNull();
    const facts = await classExecutionFacts(f.runtime, { classId: "wanderer", projectId: "project", mode: "start" });
    expect(facts.errors).toEqual([]);
    expect(facts.execution?.model).toBe(route);
    expect(facts.fields.find(field => field.field === "model")).toMatchObject({ value: route, valueLabel: "GPT 6.1 Sol (1M)" });
    expect(f.harness.inspection.sdk.callsTo("providers.models")).toHaveLength(1);
  });

  it("keeps one class's scope failure in that entry and preserves its configured model", async () => {
    const f = fixture();
    const resolve = f.runtime.scopes!.resolve.bind(f.runtime.scopes!);
    vi.spyOn(f.runtime.scopes!, "resolve").mockImplementation(async (...args) => {
      if (args[0] === "ranger") throw new Error("Ranger scope failed");
      return resolve(...args);
    });
    const entries = rpcContract.classExecutions.output.parse(await f.harness.invokeRpc("classExecutions", { projectId: "project" })).classes;
    const ranger = entries.find(entry => entry.classId === "ranger")!.start;
    expect(ranger.errors.join(" ")).toContain("Ranger scope failed");
    expect(ranger.execution).toBeNull();
    expect(ranger.fields.find(field => field.field === "model")?.value).toBe("anthropic/claude-sonnet-5-5");
    const wanderer = entries.find(entry => entry.classId === "wanderer")!.start;
    expect(wanderer.errors).toEqual([]);
    expect(wanderer.fields.find(field => field.field === "model")).toMatchObject({ value: route, valueLabel: "GPT 6.1 Sol (1M)" });
  });

  it("defers character-pool validation when its characters may come from a project", async () => {
    const f = fixture(), userClasses = join(f.home, ".agents/tavern/classes"), projectCharacters = join(f.project, ".agents/tavern/characters");
    mkdirSync(userClasses, { recursive: true }); mkdirSync(projectCharacters, { recursive: true });
    writeFileSync(join(userClasses, "ranger.md"), readFileSync(join(f.builtin, "classes/ranger.md"), "utf8").replace(/characters:.*\n/, "characters: [project-scout]\n"));
    writeFileSync(join(projectCharacters, "project-scout.md"), readFileSync(join(f.builtin, "characters/pip.md"), "utf8").replace("id: pip", "id: project-scout").replace("classes: [wanderer]", "classes: [ranger]"));
    const baseline = await classExecutionFacts(f.runtime, { classId: "ranger", mode: "start" });
    expect(baseline.errors).toEqual([]);
    expect(baseline.fields.find(field => field.field === "characters")).toMatchObject({ value: "project-scout", dependsOnProject: true });
    const facts = await classExecutionFacts(f.runtime, { classId: "ranger", projectId: "project", providerId: "pi", mode: "start" });
    expect(facts.errors).toEqual([]);
  });

  it("does not weaken an unknown model error when a project is selected", async () => {
    const f = fixture(), config = f.runtime.config();
    f.runtime.config = () => ({ ...config, classes: { ...config.classes, wanderer: { provider: "pi", model: "missing-project-model" } } });
    const facts = await classExecutionFacts(f.runtime, { classId: "wanderer", projectId: "project", mode: "start" });
    expect(facts.errors.join(" ")).toContain("missing-project-model");
    expect(facts.execution).toBeNull();
    expect(facts.fields.find(field => field.field === "model")?.value).toBe("missing-project-model");
  });

  it("keeps a catalog/model failure in one batch entry while the other classes resolve", async () => {
    const f = fixture(), config = f.runtime.config();
    f.runtime.config = () => ({ ...config, classes: { ...config.classes, wanderer: { provider: "pi", model: "missing-project-model" } } });
    const entries = rpcContract.classExecutions.output.parse(await f.harness.invokeRpc("classExecutions", { projectId: "project" })).classes;
    const failed = entries.find(entry => entry.classId === "wanderer")!.start;
    expect(failed.errors.join(" ")).toContain("missing-project-model");
    expect(failed.fields.find(field => field.field === "model")?.value).toBe("missing-project-model");
    for (const entry of entries.filter(entry => entry.classId !== "wanderer")) {
      const mode = f.runtime.snapshot().classes.find(role => role.id === entry.classId)!.startable ? "start" : "hire";
      expect(entry[mode].errors, entry.classId).toEqual([]);
    }
  });

  it("adds readable model labels without another catalog fetch", async () => {
    const f = fixture();
    const facts = await classExecutionFacts(f.runtime, { classId: "ranger", projectId: "project", providerId: "pi", mode: "start" });
    expect(facts.errors).toEqual([]);
    expect(facts.fields.find(field => field.field === "model")).toMatchObject({ value: "anthropic/claude-sonnet-5-5", valueLabel: "Claude Sonnet 5.5" });
    expect(f.harness.inspection.sdk.callsTo("providers.models")).toHaveLength(1);
  });
});
