// Reads each plugin's changelog and its release tags, so the format can be checked by hand, by `npm run check` and by
// the test suite: `node scripts/changelog-files.mjs [id...]` prints every problem and exits non-zero.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { changelogProblems } from "./changelog.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const git = (cwd, args) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

/** The plugin's releases as `{ version, date }`, newest first; empty when the checkout has no tags. */
export function releaseTags(pluginRoot, id) {
  const listed = git(pluginRoot, ["tag", "--list", `${id}/v*`]);
  if (listed === null) return [];
  return listed
    .split("\n")
    .filter(Boolean)
    .map((tag) => ({
      version: tag.slice(`${id}/v`.length),
      date: git(pluginRoot, ["log", "-1", "--format=%ad", "--date=short", tag]) ?? "",
    }))
    .filter((tag) => /^\d+\.\d+\.\d+$/u.test(tag.version))
    .sort((left, right) => (left.version < right.version ? 1 : -1));
}

/** Every problem with one plugin's changelog, as full sentences; a missing file is one of them. */
export function pluginChangelogProblems(base, plugin) {
  const dir = join(base, plugin.subdir);
  const path = join(dir, "CHANGELOG.md");
  if (!existsSync(path)) return [`${plugin.subdir}/CHANGELOG.md does not exist`];
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return changelogProblems(readFileSync(path, "utf8"), {
    id: plugin.id,
    displayName: plugin.displayName,
    version: manifest.version ?? null,
    tags: releaseTags(base, plugin.id),
  }).map((problem) => `${plugin.subdir}/CHANGELOG.md: ${problem}`);
}

/** Every problem across the marketplace's own plugins, filtered to the ids given. */
export function marketplaceChangelogProblems(base = root, only = null) {
  const entries = readdirSync(join(base, "entries"))
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(base, "entries", file), "utf8")))
    .filter((entry) => entry.source?.git?.subdir !== undefined)
    .filter((entry) => only === null || only.includes(entry.id));
  return entries.flatMap((entry) => pluginChangelogProblems(base, { ...entry, subdir: entry.source.git.subdir }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv.slice(2);
  const problems = marketplaceChangelogProblems(root, only.length > 0 ? only : null);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log("every changelog follows the format");
}
