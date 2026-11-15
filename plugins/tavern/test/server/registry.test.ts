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
