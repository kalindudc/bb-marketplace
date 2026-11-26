// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Registry, RegistryConflict } from "../../src/server/registry";
import { setup } from "./runtime-fixture";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const directory = () => { const dir = mkdtempSync(join(tmpdir(), "tavern-class-edit-")); dirs.push(dir); return dir; };
const root = fileURLToPath(new URL("../../", import.meta.url));

describe("class editor: saving an override", () => {
  it("writes a patch to the global override, never the shipped file, and reads back", () => {
    const home = directory(), registry = new Registry(root, home);
    const shipped = readFileSync(join(root, "classes/smith.md"), "utf8");
    const { revision } = registry.classLayers("smith");
    const saved = registry.saveClass("smith", { label: "Mason", body: "Build carefully." }, { target: "global", revision });
    expect(saved.label).toBe("Mason");
    expect(readFileSync(join(root, "classes/smith.md"), "utf8")).toBe(shipped);
    const written = readFileSync(join(home, "classes/smith.md"), "utf8");
    expect(written).toMatch(/^---\nformat: tavern-registry-patch\/1\nid: smith\nfields:\n  label: Mason\n  body: Build carefully\.\n---\n$/);
    const reread = registry.read().classes.find((c) => c.id === "smith")!;
    expect(reread).toMatchObject({ label: "Mason", plain: saved.plain, body: "Build carefully.", source: join(home, "classes/smith.md") });
    expect(existsSync(join(home, "classes/smith.md.tmp"))).toBe(false);
  });

  it("writes a project override that wins over the global one for that project only", () => {
    const home = directory(), project = directory(), registry = new Registry(root, home);
    registry.saveClass("ranger", { label: "Global" }, { target: "global", revision: registry.classLayers("ranger").revision });
    registry.saveClass("ranger", { label: "Project" }, { target: "project", projectPath: project, revision: registry.classLayers("ranger", project).revision });
    expect(readFileSync(join(project, ".agents/tavern/classes/ranger.md"), "utf8")).toContain("label: Project");
    expect(registry.read(project).classes.find((c) => c.id === "ranger")!.label).toBe("Project");
    expect(registry.read().classes.find((c) => c.id === "ranger")!.label).toBe("Global");
  });

  it("refuses a stale revision and writes nothing", () => {
    const home = directory(), registry = new Registry(root, home);
    const { revision } = registry.classLayers("smith");
    mkdirSync(join(home, "classes"), { recursive: true });
    writeFileSync(join(home, "classes/smith.md"), readFileSync(join(root, "classes/smith.md"), "utf8").replace(/^label: .*$/m, "label: Elsewhere"));
    registry.invalidate();
    expect(() => registry.saveClass("smith", { label: "Mine" }, { target: "global", revision })).toThrow(RegistryConflict);
    expect(readFileSync(join(home, "classes/smith.md"), "utf8")).toContain("label: Elsewhere");
  });

  it("validates fields with the class schema and keeps the id and file-only fields", () => {
    const registry = new Registry(root, directory());
    const { revision } = registry.classLayers("smith");
    expect(() => registry.saveClass("smith", { label: "" }, { target: "global", revision })).toThrow();
    expect(() => registry.saveClass("smith", { scope: "root" as never }, { target: "global", revision })).toThrow();
    // Fields outside the editable set are ignored, never written.
    expect(registry.saveClass("smith", { tools: ["anything"] } as never, { target: "global", revision }).tools).toEqual(registry.read().classes.find((c) => c.id === "smith")!.tools);
    const before = registry.read().classes.find((c) => c.id === "smith")!;
    const after = registry.saveClass("smith", { plain: "mason" }, { target: "global", revision: registry.classLayers("smith").revision });
    expect(after).toMatchObject({ id: "smith", tools: before.tools, hires: before.hires, budget: before.budget, environment: before.environment, shape: before.shape });
  });

  it("refuses an unknown class, an unknown character in the pool, and a project target without a project", () => {
    const registry = new Registry(root, directory());
    const { revision } = registry.classLayers("smith");
    expect(() => registry.classLayers("nope")).toThrow(/Unknown class/);
    expect(() => registry.saveClass("smith", { characters: ["nobody"] }, { target: "global", revision })).toThrow(/nobody/);
    expect(() => registry.saveClass("smith", { label: "X" }, { target: "project", revision })).toThrow(/project/);
  });

  it("previews with the server's own parser, listing changes and widening, without writing", () => {
    const home = directory(), registry = new Registry(root, home);
    const preview = registry.previewClass("smith", { label: "Mason", scope: "open" }, { target: "global" });
    expect(preview.changes.map((c) => c.field)).toEqual(["label", "scope"]);
    expect(preview.widening).toEqual([{ field: "scope", from: "worktree", to: "open" }]);
    expect(preview.draft.label).toBe("Mason");
    expect(existsSync(join(home, "classes/smith.md"))).toBe(false);
    const narrow = registry.previewClass("smith", { scope: "readonly" }, { target: "global" });
    expect(narrow.widening).toEqual([]);
  });

  it("says when a global save would still lose to a project override", () => {
    const home = directory(), project = directory(), registry = new Registry(root, home);
    registry.saveClass("ranger", { label: "Project" }, { target: "project", projectPath: project, revision: registry.classLayers("ranger", project).revision });
    expect(registry.previewClass("ranger", { label: "Global" }, { target: "global", projectPath: project }).shadowedBy).toBe("project");
    expect(registry.previewClass("ranger", { label: "Global" }, { target: "global" }).shadowedBy).toBeNull();
  });

  it("removes only the override it is told to, falling back to the layer below", () => {
    const home = directory(), registry = new Registry(root, home);
    registry.saveClass("smith", { label: "Mason" }, { target: "global", revision: registry.classLayers("smith").revision });
    registry.removeClassOverride("smith", { target: "global", revision: registry.classLayers("smith").revision });
    expect(existsSync(join(home, "classes/smith.md"))).toBe(false);
    expect(registry.read().classes.find((c) => c.id === "smith")!.label).toBe("Smith");
    expect(() => registry.removeClassOverride("smith", { target: "global", revision: registry.classLayers("smith").revision })).toThrow(/no global override/i);
  });
});

describe("class editor: who may save", () => {
  it("refuses a save or a removal from anyone but the client, before touching a file", async () => {
    const { requireClassClient } = await import("../../src/server/registry-rpc");
    expect(() => requireClassClient(undefined)).toThrow(/explicit client action/);
    expect(() => requireClassClient({ experimental_caller: { kind: "plugin" } } as never)).toThrow(/explicit client action/);
    expect(() => requireClassClient({ experimental_caller: { kind: "client" } } as never)).not.toThrow();
  });
});

describe("class editor: handlers", () => {
  async function handlers(over: Record<string, unknown> = {}) {
    const { classEditorHandlers } = await import("../../src/server/registry-rpc");
    const home = directory();
    const recordExternal = vi.fn(() => "rec-1");
    const invalidate = vi.fn();
    const f = setup();
    vi.spyOn(f.k.store, "all").mockReturnValue([{ threadId: "a", classId: "smith", state: "working" }, { threadId: "b", classId: "smith", state: "done" }, { threadId: "c", classId: "ranger", state: "idle" }] as never);
    const runtime = {
      registry: new Registry(root, home), settings: { recordExternal }, config: () => ({ classes: { smith: { model: "openai/gpt-x" } } }),
      keeper: f.k, now: f.time,
      bb: { rpc: { experimental_invalidate: invalidate } }, prepareRegistry: async () => undefined, projectPath: () => null, ...over,
    };
    return { h: classEditorHandlers(runtime as never), home, recordExternal, invalidate };
  }
  const client = { experimental_caller: { kind: "client" } } as never;

  it("reads the class with its revision, the effective models and where they come from, and the running members", async () => {
    const { h } = await handlers();
    const out = await h.classEditor({ classId: "smith", projectId: null });
    expect(out.models.model).toMatchObject({ value: "openai/gpt-x", source: "settings" });
    expect(out.models.reasoning).toEqual({ value: out.current.reasoning, source: "file", file: out.current.reasoning });
    expect(out.running).toBe(1);
    expect(out.layers.map((l) => l.source)).toEqual(["shipped", "global"]);
    expect(out.revision).toMatch(/^[0-9a-f]{32}$/);
  });

  it("records each save in the settings history with the fields it changed, and the prompt by size only", async () => {
    const { h, recordExternal, invalidate } = await handlers();
    const { revision } = await h.classEditor({ classId: "smith", projectId: null });
    const out = await h.saveClass({ classId: "smith", projectId: null, target: "global", edit: { label: "Mason", body: "One\nTwo" }, revision }, client);
    expect(out.code).toBe("ok");
    expect(recordExternal).toHaveBeenCalledWith("user", expect.stringMatching(/^Classes page: saved the Mason class to .*classes\/smith\.md \(every project\)\.$/), expect.arrayContaining([
      { key: "class.smith.label", from: "Smith", to: "Mason", kind: "set" },
      expect.objectContaining({ key: "class.smith.body", to: "2 lines" }),
    ]));
    expect(invalidate).toHaveBeenCalled();
  });

  it("answers stale without writing or recording when the class changed, and records a removal", async () => {
    const { h, recordExternal, home } = await handlers();
    expect(await h.saveClass({ classId: "smith", projectId: null, target: "global", edit: { label: "Mason" }, revision: "old" }, client)).toEqual({ code: "stale" });
    expect(recordExternal).not.toHaveBeenCalled();
    const { revision } = await h.classEditor({ classId: "smith", projectId: null });
    await h.saveClass({ classId: "smith", projectId: null, target: "global", edit: { label: "Mason" }, revision }, client);
    const next = (await h.classEditor({ classId: "smith", projectId: null })).revision;
    expect((await h.removeClassOverride({ classId: "smith", projectId: null, target: "global", revision: next }, client)).code).toBe("ok");
    expect(existsSync(join(home, "classes/smith.md"))).toBe(false);
    expect(recordExternal).toHaveBeenLastCalledWith("user", expect.stringMatching(/removed the global override of smith/), [expect.objectContaining({ key: "class.smith", kind: "unset" })]);
  });

  it("only previews a reset for the person at the client to apply, and rejects an unconfirmed revision", async () => {
    const { h, home, recordExternal, invalidate } = await handlers();
    const { revision } = await h.classEditor({ classId: "smith", projectId: null });
    await h.saveClass({ classId: "smith", projectId: null, target: "global", edit: { scope: "readonly" }, revision }, client);
    recordExternal.mockClear(); invalidate.mockClear();
    const input = { kind: "class", id: "smith", target: "global", projectId: null } as const;
    await expect(h.previewOverrideReset(input, { experimental_caller: { kind: "plugin" } } as never)).rejects.toThrow(/explicit client action/);
    const preview = await h.previewOverrideReset(input, client);
    expect(preview).toMatchObject({ code: "ok", name: "Smith", fallback: "shipped", fields: ["scope"], widening: true });
    if (preview.code !== "ok") throw new Error("Expected a reset preview");
    const apply = { ...input, revision: preview.revision };
    await expect(h.resetOverride(apply, { experimental_caller: { kind: "plugin" } } as never)).rejects.toThrow(/explicit client action/);
    expect(await h.resetOverride({ ...apply, revision: "another-override" }, client)).toEqual({ code: "stale" });
    expect(existsSync(join(home, "classes/smith.md"))).toBe(true);
    expect(recordExternal).not.toHaveBeenCalled(); expect(invalidate).not.toHaveBeenCalled();
    expect(await h.resetOverride(apply, client)).toMatchObject({ code: "ok" });
    expect(existsSync(join(home, "classes/smith.md"))).toBe(false);
    expect(recordExternal).toHaveBeenCalledOnce(); expect(invalidate).toHaveBeenCalledOnce();
  });

  it("keeps the original override bytes when recording the reset fails", async () => {
    const { h, home, recordExternal, invalidate } = await handlers();
    const { revision } = await h.classEditor({ classId: "smith", projectId: null });
    await h.saveClass({ classId: "smith", projectId: null, target: "global", edit: { label: "Mason" }, revision }, client);
    const file = join(home, "classes/smith.md"), original = readFileSync(file, "utf8");
    const input = { kind: "class", id: "smith", target: "global", projectId: null } as const;
    const preview = await h.previewOverrideReset(input, client);
    if (preview.code !== "ok") throw new Error("Expected a reset preview");
    invalidate.mockClear(); recordExternal.mockImplementationOnce(() => { throw new Error("Injected history failure"); });
    await expect(h.resetOverride({ ...input, revision: preview.revision }, client)).resolves.toMatchObject({ code: "invalid", problems: ["Injected history failure"] });
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("refuses a save from a plugin or agent caller", async () => {
    const { h, home } = await handlers();
    const { revision } = await h.classEditor({ classId: "smith", projectId: null });
    await expect(h.saveClass({ classId: "smith", projectId: null, target: "global", edit: { label: "Mason" }, revision }, { experimental_caller: { kind: "plugin" } } as never)).rejects.toThrow(/explicit client action/);
    expect(existsSync(join(home, "classes/smith.md"))).toBe(false);
  });
});

describe("class editor: settings history", () => {
  it("records a class change in the settings history without changing the settings or their revision, and it can't be undone there", async () => {
    const { setup } = await import("./runtime-fixture");
    const { SettingsStore } = await import("../../src/server/settings/store");
    const f = setup();
    const settings = new SettingsStore(f.k.store.db, f.time);
    const before = settings.snapshot();
    settings.recordExternal("user", "Classes page: saved the Mason class to ~/.agents/tavern/classes/smith.md (every project).", [{ key: "class.smith.label", from: "Smith", to: "Mason", kind: "set" }]);
    const after = settings.snapshot();
    expect(after.revision).toBe(before.revision);
    expect(after.effective).toEqual(before.effective);
    expect(after.history[0]).toMatchObject({ by: "user", reason: expect.stringMatching(/^Classes page: saved/), changes: [{ key: "class.smith.label", from: "Smith", to: "Mason" }], undoable: false });
  });
});

describe("effective class execution", () => {
  it("takes Settings key by key over the class file and keeps the file's value beside it", async () => {
    const { effectiveExecution } = await import("../../src/shared/class-execution");
    expect(effectiveExecution({ provider: null, model: "openai/gpt-6.1-sol", reasoning: "xhigh" }, { provider: "codex", model: "gpt-6.1-sol", reasoning: "high" })).toEqual({
      provider: { value: "codex", source: "settings", file: null },
      model: { value: "gpt-6.1-sol", source: "settings", file: "openai/gpt-6.1-sol" },
      reasoning: { value: "high", source: "settings", file: "xhigh" },
    });
    expect(effectiveExecution({ reasoning: "xhigh" }, { reasoning: null }).reasoning).toEqual({ value: null, source: "settings", file: "xhigh" });
    expect(effectiveExecution({ model: "m" }).model).toEqual({ value: "m", source: "file", file: "m" });
  });
});
