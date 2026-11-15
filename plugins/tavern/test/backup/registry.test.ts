// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Registry } from "../../src/server/registry";

const builtin = fileURLToPath(new URL("../../", import.meta.url));
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "tavern-backup-registry-")); directories.push(root);
  const home = join(root, "global"), project = join(root, "project");
  mkdirSync(join(home, "classes"), { recursive: true });
  mkdirSync(join(project, ".agents/tavern/classes"), { recursive: true });
  return { home, project, registry: new Registry(builtin, home) };
}
it("exports the selected shipped file verbatim", () => {
  const { registry } = setup();
  expect(registry.file("class", "smith")).toEqual({ filename: "smith.md", source: "shipped", path: null, text: readFileSync(join(builtin, "classes/smith.md"), "utf8") });
});
it("retains the original filename when frontmatter ids differ, and respects project precedence", () => {
  const { home, project, registry } = setup();
  const shipped = readFileSync(join(builtin, "classes/smith.md"), "utf8");
  const global = shipped.replace(/label: [^\n]+/, "label: Global smith"), local = shipped.replace(/label: [^\n]+/, "label: Project smith");
  writeFileSync(join(home, "classes/custom-name.md"), global);
  writeFileSync(join(project, ".agents/tavern/classes/another-name.md"), local);
  expect(registry.file("class", "smith")).toMatchObject({ filename: "custom-name.md", source: "global", text: global });
  expect(registry.file("class", "smith", project)).toMatchObject({ filename: "another-name.md", source: "project", text: local });
});
it("keeps the valid selected file when an invalid override is ignored", () => {
  const { home, registry } = setup();
  writeFileSync(join(home, "classes/broken.md"), "not a class definition");
  expect(registry.read().problems).toHaveLength(1);
  expect(registry.file("class", "smith").source).toBe("shipped");
});
