// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Registry } from "../../src/server/registry";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "tavern-registry-"));
  dirs.push(dir);
  return dir;
}
const root = fileURLToPath(new URL("../../", import.meta.url));
describe("class and character registry", () => {
  it("validates all shipped definitions and chooses a compatible non-busy character", () => {
    const registry = new Registry(root, directory());
    const snapshot = registry.read();
    expect(snapshot.problems).toEqual([]);
    expect(snapshot.classes).toHaveLength(5);
    expect(snapshot.characters).toHaveLength(12);
    expect(registry.character("keeper", ["wren"])!.id).toBe("moss");
    expect(() => registry.character("smith", [], null, "wren")).toThrow(/compatible/);
  });
  it("reuses a selected character when the entire selected pool is busy", () => {
    const registry = new Registry(root, directory());
    const snapshot = registry.read();
    snapshot.classes.find((role) => role.id === "ranger")!.characters = ["lark"];
    vi.spyOn(registry, "read").mockReturnValue(snapshot);
    const picked = registry.character("ranger", ["lark"]);
    expect(picked!.id).toBe("lark");
    expect(picked!.classes).toContain("ranger");
  });
  it("applies global then project overrides and reports broken files", () => {
    const home = directory(),
      project = directory();
    mkdirSync(join(home, "classes"));
    mkdirSync(join(project, ".agents/tavern/classes"), { recursive: true });
    const ranger = readFileSync(join(root, "classes/ranger.md"), "utf8");
    writeFileSync(
      join(home, "classes/ranger.md"),
      ranger.replace("label: Ranger", "label: Global"),
    );
    writeFileSync(
      join(project, ".agents/tavern/classes/ranger.md"),
      ranger.replace("label: Ranger", "label: Project"),
    );
    writeFileSync(join(home, "classes/broken.md"), "No frontmatter");
    const registry = new Registry(root, home);
    expect(registry.read(project).classes.find((c) => c.id === "ranger")?.label).toBe("Project");
    expect(registry.read().classes.find((c) => c.id === "ranger")?.label).toBe("Global");
    expect(registry.read().problems[0]?.message).toContain("frontmatter");
  });
  it("adds a seed to a user override without changing the built-in source", () => {
    const home = directory(), source = join(root, "characters/wren.md");
    const raw = readFileSync(source, "utf8");
    const registry = new Registry(root, home);
    const before = registry.read().characters.find(c => c.id === "wren")!;
    const saved = registry.saveAvatar("wren", "1bcabc");
    expect(saved).toEqual({ ...before, avatar: "1bcabc", source: join(home, "characters/wren.md") });
    expect(readFileSync(source, "utf8")).toBe(raw);
    expect(registry.read().characters.find(c => c.id === "wren")).toEqual(saved);
    expect(new Registry(root, home).read().characters.find(c => c.id === "wren")).toEqual(saved);
  });
  it("changes only avatar in an authored file, retaining formatting, comments and body", () => {
    const home = directory();
    mkdirSync(join(home, "characters"));
    const path = join(home, "characters/wren-local.md");
    const raw = readFileSync(join(root, "characters/wren.md"), "utf8")
      .replace("id: wren", "# Keep this comment\nid: wren\navatar: 'old' # The saved roll")
      .replaceAll("\n", "\r\n") + "\r\n  ";
    writeFileSync(path, raw);
    const registry = new Registry(root, home);
    expect(registry.read().characters.find(c => c.id === "wren")?.avatar).toBe("old");
    const result = registry.saveAvatar("wren", "7gqda");
    expect(readFileSync(path, "utf8")).toBe(raw.replace("'old'", '"7gqda"'));
    expect(result.avatar).toBe("7gqda");
    expect(registry.read().characters.find(c => c.id === "wren")).toEqual(result);
  });
  it("round-trips bubble lines without rewriting other frontmatter or the body", () => {
    const home = directory(), source = join(root, "characters/wren.md");
    mkdirSync(join(home, "characters"));
    const path = join(home, "characters/wren-local.md");
    const raw = readFileSync(source, "utf8")
      .replace("id: wren", "# A note about this character\nid: wren")
      .replace("\n---\n", "\navatar: '3v41' # Keep this seed\n---\n")
      .replaceAll("\n", "\r\n") + "\r\n  ";
    writeFileSync(path, raw);
    const registry = new Registry(root, home);
    const original = registry.read().characters.find(c => c.id === "wren")!;
    const { name, hue, charge, temper, style, quirks, lines } = original;
    const says = { working: ["Wind steady.", "Fair road as far as {waypoint}."], verified: [] };
    const saved = registry.saveVoice("wren", { name, hue, charge, temper, style, quirks, lines, says });
    expect(saved).toEqual({ ...original, says });
    expect(new Registry(root, home).read().characters.find(c => c.id === "wren")).toEqual(saved);
    const edited = readFileSync(path, "utf8");
    expect(edited.split("says:")[0]).toBe(raw.split("says:")[0]);
    expect(edited.slice(edited.indexOf("avatar:"))).toBe(raw.slice(raw.indexOf("avatar:")));
    const legacySave = registry.saveVoice("wren", { name, hue, charge, temper, style, quirks, lines });
    expect(legacySave.says).toEqual(says);
  });
  it("saves only validated voice fields to the character override and reloads", () => {
    const home = directory(),
      registry = new Registry(root, home);
    const original = registry.read().characters.find((c) => c.id === "wren")!;
    const voice = {
      name: "Wren",
      hue: original.hue,
      charge: original.charge,
      temper: "brisk",
      style: "Plain short lines",
      quirks: [],
      lines: original.lines,
    };
    registry.saveVoice("wren", voice);
    expect(new Registry(root, home).read().characters.find((c) => c.id === "wren")?.style).toBe(
      "Plain short lines",
    );
    expect(() => registry.saveVoice("../../escape", voice)).toThrow(/Unknown/);
  });
});
