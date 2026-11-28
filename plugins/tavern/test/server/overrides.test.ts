// @vitest-environment node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { stringify } from "yaml";
import { Registry, RegistryConflict } from "../../src/server/registry";
import { parseRegistryDefinition, parseRegistryRecord } from "../../src/server/registry-file";

const source = fileURLToPath(new URL("../../", import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function write(path: string, text: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function patch(id: string, fields: Record<string, unknown>) { return `---\n${stringify({ format: "tavern-registry-patch/1", id, fields })}---\n`; }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tavern-overrides-")); dirs.push(root);
  const builtin = join(root, "shipped"), home = join(root, "global"), projectPath = join(root, "project"), local = join(projectPath, ".agents/tavern");
  mkdirSync(projectPath);
  for (const dir of ["classes", "characters"]) cpSync(join(source, dir), join(builtin, dir), { recursive: true });
  const registry = new Registry(builtin, home);
  return { builtin, home, local, projectPath, registry };
}
const global = { target: "global" } as const;

it("skips a no-op, writes only changed keys, and inherits a later shipped update", () => {
  const { registry, builtin, home } = fixture();
  const file = join(home, "classes/smith.md"), shipped = join(builtin, "classes/smith.md");
  const save = (edit: Parameters<Registry["saveClass"]>[1]) => registry.saveClass("smith", edit, { ...global, revision: registry.classLayers("smith").revision });
  save({ label: "Smith" });
  expect(existsSync(file)).toBe(false);
  save({ label: "Mason", hireable: false, characters: [], body: "" });
  expect(parseRegistryRecord("class", readFileSync(file, "utf8"), file)).toEqual({ format: "patch", id: "smith", fields: { label: "Mason", body: "", characters: [], hireable: false } });
  write(shipped, readFileSync(shipped, "utf8").replace(/^plain: .*/m, "plain: artisan"));
  registry.invalidate();
  expect(registry.read().classes.find(c => c.id === "smith")).toMatchObject({ plain: "artisan", hireable: false, characters: [], body: "" });
  expect(registry.fieldFile("class", "smith", "plain").source).toBe("shipped");
  expect(registry.fieldFile("class", "smith", "body").source).toBe("global");
});

it("isolates a global save from a project layer, and merges a patch over a legacy whole definition", () => {
  const { registry, builtin, home, local, projectPath } = fixture();
  const legacy = join(home, "classes/the-smith.md");
  write(legacy, readFileSync(join(builtin, "classes/smith.md"), "utf8").replace(/^plain: .*/m, "plain: artisan"));
  write(join(local, "classes/smith.md"), patch("smith", { label: "Project", model: null, body: "Project prompt" }));
  expect(registry.read(projectPath).classes.find(c => c.id === "smith")).toMatchObject({ label: "Project", plain: "artisan", model: null });
  registry.saveClass("smith", { label: "Everywhere" }, { ...global, projectPath, revision: registry.classLayers("smith", projectPath).revision });
  const raw = readFileSync(legacy, "utf8");
  expect(parseRegistryDefinition("class", raw, legacy)).toMatchObject({ label: "Everywhere", plain: "artisan" });
  expect(raw).not.toContain("Project prompt");
  expect(registry.read(projectPath).classes.find(c => c.id === "smith")?.label).toBe("Project");
  expect(parseRegistryDefinition("class", registry.file("class", "smith", projectPath).text, "export")).toMatchObject({ label: "Project", plain: "artisan" });
});

it("resets one patch field against its inherited value, preserving another scope and deleting the last key", () => {
  const { registry, home, local, projectPath } = fixture();
  const project = { target: "project", projectPath } as const;
  const file = join(local, "classes/renamed.md"), lower = join(home, "classes/smith.md");
  write(lower, patch("smith", { label: "Global" }));
  write(file, patch("smith", { label: "Smith", scope: "readonly" }));
  const inspect = () => registry.overrideSheet("class", "smith", project);
  expect(inspect()).toMatchObject({ format: "patch", fallback: "global", fields: expect.arrayContaining([{ field: "label", shipped: "Smith", current: "Smith", saved: true }]) });
  const preview = registry.previewReset("class", "smith", project, "scope");
  expect(preview).toMatchObject({ path: file, fields: ["scope"], fallback: "shipped", widening: true });
  registry.resetOverride("class", "smith", { ...project, revision: preview.revision }, "scope");
  expect(readFileSync(file, "utf8")).toBe(patch("smith", { label: "Smith" }));
  const last = registry.previewReset("class", "smith", project, "label");
  registry.resetOverride("class", "smith", { ...project, revision: last.revision }, "label");
  expect(existsSync(file)).toBe(false);
  expect(registry.read(projectPath).classes.find(c => c.id === "smith")?.label).toBe("Global");
  expect(readFileSync(lower, "utf8")).toBe(patch("smith", { label: "Global" }));
});

it("leaves a previously loaded definition untouched and preserves the project file after a global reset", () => {
  const { registry, home, local, projectPath } = fixture();
  const localFile = join(local, "classes/smith.md");
  write(join(home, "classes/smith.md"), patch("smith", { body: "Previously loaded prompt" }));
  write(localFile, patch("smith", { label: "Local" }));
  const loaded = registry.read(projectPath).classes.find(c => c.id === "smith")!;
  const where = { ...global, projectPath };
  const preview = registry.previewReset("class", "smith", where);
  expect(preview).toMatchObject({ fields: ["body"], shadowed: true });
  registry.resetOverride("class", "smith", { ...where, revision: preview.revision });
  expect(loaded.body).toBe("Previously loaded prompt");
  expect(registry.read(projectPath).classes.find(c => c.id === "smith")).toMatchObject({ label: "Local", body: expect.not.stringContaining("Previously loaded prompt") });
  expect(readFileSync(localFile, "utf8")).toBe(patch("smith", { label: "Local" }));
});

it("keeps a legacy identical copy pinned, refuses its field reset, and never resets a custom definition", () => {
  const { registry, builtin, home } = fixture();
  const raw = readFileSync(join(builtin, "classes/smith.md"), "utf8");
  const file = join(home, "classes/another-name.md");
  write(file, raw); write(join(home, "classes/tinker.md"), raw.replace(/^id: smith/m, "id: tinker").replace(/^characters: .*/m, "characters: []"));
  expect(registry.overrideSheet("class", "smith", global)).toMatchObject({ format: "full", fields: [], canReset: true });
  expect(() => registry.previewReset("class", "smith", global, "label")).toThrow(/whole-file/i);
  expect(registry.overrideSheet("class", "tinker", global)).toMatchObject({ hasDefault: false, canReset: false });
  expect(() => registry.previewReset("class", "tinker", global)).toThrow(/no Tavern default/i);
  const preview = registry.previewReset("class", "smith", global);
  registry.resetOverride("class", "smith", { ...global, revision: preview.revision });
  expect(existsSync(file)).toBe(false);
});

it("refuses stale fallback revisions and duplicate parsed IDs without modifying either file", () => {
  const { registry, home, local, projectPath } = fixture();
  const lower = join(home, "classes/smith.md"), file = join(local, "classes/unexpected.md"), duplicate = join(local, "classes/z.md");
  write(lower, patch("smith", { label: "Global" })); write(file, patch("smith", { label: "Local" }));
  const project = { target: "project", projectPath } as const;
  const preview = registry.previewReset("class", "smith", project);
  write(lower, patch("smith", { label: "New" }));
  expect(() => registry.resetOverride("class", "smith", { ...project, revision: preview.revision })).toThrow(RegistryConflict);
  write(duplicate, patch("smith", { label: "Other" }));
  expect(() => registry.previewReset("class", "smith", project)).toThrow(/duplicate/i);
  expect(registry.read(projectPath).problems.map(p => p.message).join()).toMatch(/duplicate/i);
  expect(readFileSync(file, "utf8")).toBe(patch("smith", { label: "Local" }));
  expect(readFileSync(duplicate, "utf8")).toBe(patch("smith", { label: "Other" }));
});

it("does not follow a project registry symlink into another scope for writes", () => {
  const { registry, home, local, projectPath } = fixture();
  const file = join(home, "classes/smith.md");
  write(file, patch("smith", { label: "Global" }));
  mkdirSync(dirname(local), { recursive: true }); symlinkSync(home, local);
  expect(() => registry.previewReset("class", "smith", { target: "project", projectPath })).toThrow(/symbolic/i);
  expect(readFileSync(file, "utf8")).toBe(patch("smith", { label: "Global" }));
});

it("scopes character edits and resets without copying the other character fields", () => {
  const { registry, home, local, projectPath } = fixture();
  const file = join(local, "characters/wren.md");
  const project = { target: "project", projectPath } as const;
  const revision = registry.characterLayers("wren", projectPath).revision;
  registry.saveCharacter("wren", { avatar: "7gqda" }, { ...project, revision });
  expect(readFileSync(file, "utf8")).toBe(patch("wren", { avatar: "7gqda" }));
  expect(existsSync(join(home, "characters/wren.md"))).toBe(false);
  const preview = registry.previewReset("character", "wren", project);
  registry.resetOverride("character", "wren", { ...project, revision: preview.revision });
  expect(existsSync(file)).toBe(false);
});

it("keeps a project patch's narrower scope after resetting a supporting character from the global list", () => {
  const { registry, home, local, projectPath } = fixture();
  const project = { target: "project", projectPath } as const;
  const file = join(local, "classes/smith.md"), saved = patch("smith", { characters: ["wren"], scope: "readonly", label: "Archive Smith" });
  write(join(home, "characters/wren.md"), patch("wren", { classes: ["keeper", "smith"] }));
  write(file, saved);
  expect(registry.character("smith", [], projectPath)?.id).toBe("wren");
  const reset = registry.previewReset("character", "wren", global);
  registry.resetOverride("character", "wren", { ...global, revision: reset.revision });
  expect(registry.read(projectPath).classes.find(c => c.id === "smith")).toMatchObject({ characters: ["wren"], scope: "readonly", label: "Archive Smith" });
  expect(() => registry.character("smith", [], projectPath)).toThrow(/incompatible character.*smith: wren/i);
  const problem = expect.stringMatching(/incompatible character.*wren/i);
  expect(registry.overrideSheet("class", "smith", project)).toMatchObject({ problem, canReset: true });
  expect(registry.overrides(project)).toMatchObject({ rows: [expect.objectContaining({ id: "smith", canReset: true })], problems: [{ path: file, message: problem }] });
  expect(() => registry.saveClass("smith", { label: "Draft Smith" }, { ...project, revision: registry.classLayers("smith", projectPath).revision }))
    .toThrow("Unknown or incompatible character in the Archive Smith pool: wren");
  expect(readFileSync(file, "utf8")).toBe(saved);
  const repair = registry.previewReset("class", "smith", project, "characters");
  expect(repair.widening).toBe(false);
  registry.resetOverride("class", "smith", { ...project, revision: repair.revision }, "characters");
  expect(registry.read(projectPath).classes.find(c => c.id === "smith")?.scope).toBe("readonly");
  expect(registry.character("smith", [], projectPath)?.id).toBe("juno");
});

it("keeps a project patch's narrower scope when a later shipped character drops compatibility", () => {
  const { registry, builtin, local, projectPath } = fixture();
  const project = { target: "project", projectPath } as const;
  const file = join(local, "classes/smith.md"), juno = join(builtin, "characters/juno.md");
  write(file, patch("smith", { characters: ["juno"], scope: "readonly", body: "Keep this prompt." }));
  expect(registry.character("smith", [], projectPath)?.id).toBe("juno");
  write(juno, readFileSync(juno, "utf8").replace(/^classes: .*/m, "classes: [warden]"));
  registry.invalidate();
  expect(registry.read(projectPath).classes.find(c => c.id === "smith")).toMatchObject({ characters: ["juno"], scope: "readonly", body: "Keep this prompt." });
  expect(() => registry.character("smith", [], projectPath)).toThrow(/incompatible character.*smith: juno/i);
  const problem = expect.stringMatching(/incompatible character.*juno/i);
  expect(registry.overrideSheet("class", "smith", project)).toMatchObject({ problem });
  expect(registry.overrides(project).problems).toEqual([{ path: file, message: problem }]);
});

it("reports invalid, orphaned and incompatible patches, and refuses to remove a supporting override", () => {
  const { registry, home, local, projectPath } = fixture();
  write(join(home, "classes/orphan.md"), patch("orphan", { label: "Orphan" }));
  write(join(home, "characters/unknown.md"), patch("wren", { modle: "typo" }));
  write(join(local, "classes/broken.md"), patch("smith", { characters: ["wren"] }));
  expect(registry.read(projectPath).problems.map(p => p.message)).toEqual(expect.arrayContaining([expect.stringMatching(/no lower/i), expect.stringMatching(/modle/i), expect.stringMatching(/incompatible/i)]));
  const file = join(home, "characters/wren.md");
  write(file, patch("wren", { classes: ["keeper", "smith"] }));
  expect(() => registry.previewReset("character", "wren", { ...global, projectPath })).toThrow(/incompatible/i);
  expect(existsSync(file)).toBe(true);
});
