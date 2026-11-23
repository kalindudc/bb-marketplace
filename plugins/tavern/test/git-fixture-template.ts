import { constants, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Seed state is path-independent; callers rebind local remotes to the copied repositories.
export function gitFixtureTemplate<Args extends (string | number | boolean)[], State>(
  seed: (root: string, ...args: Args) => State,
) {
  const templates = new Map<string, { root: string; state: State }>();
  afterAll(() => {
    for (const { root } of templates.values()) rmSync(root, { recursive: true, force: true });
    templates.clear();
  });
  return (root: string, ...args: Args): State => {
    const key = JSON.stringify(args);
    let template = templates.get(key);
    if (!template) {
      const seedRoot = mkdtempSync(join(tmpdir(), "git-template-"));
      try {
        template = { root: seedRoot, state: seed(seedRoot, ...args) };
        templates.set(key, template);
      } catch (error) {
        rmSync(seedRoot, { recursive: true, force: true });
        throw error;
      }
    }
    cpSync(template.root, root, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    return template.state;
  };
}
