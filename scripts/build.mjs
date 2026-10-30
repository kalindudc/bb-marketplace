// Writes marketplace.json from marketplace.base.json and entries/*.json, with
// each overview file inlined (bb reads the text, not a path). bb reads
// marketplace.json from the repository root, so commit the output.
// `--check` fails when the committed file is out of date. Both report every
// problem in scripts/rules.mjs and here before writing anything.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPOSITORY_URL, pluginChangelogProblems } from "./changelog-files.mjs";
import { entryProblems, overviewProblems } from "./rules.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const readText = (path) => readFileSync(join(root, path), "utf8");
const readJson = (path) => JSON.parse(readText(path));
const problems = [];
const fail = (message) => {
  console.error(`marketplace: ${message}`);
  process.exit(1);
};

const base = readJson("marketplace.base.json");
const categoryIds = new Set((base.categories ?? []).map((category) => category.id));

const plugins = readdirSync(join(root, "entries"))
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => {
    const entry = readJson(join("entries", file));
    const problem = (message) => problems.push(`${entry.id ?? file}: ${message}`);
    if (`${entry.id}.json` !== file) problem(`entries/${file} has the id "${entry.id}"`);
    for (const message of entryProblems(entry)) problem(message);
    if (entry.category !== undefined && !categoryIds.has(entry.category)) {
      problem(`the category "${entry.category}" is not in marketplace.base.json`);
    }

    const git = entry.source?.git;
    if (git?.url === REPOSITORY_URL) {
      const manifest = readJson(join(git.subdir, "package.json"));
      if (manifest.name !== `bb-plugin-${entry.id}`) {
        problem(`${git.subdir}/package.json is named "${manifest.name}", not "bb-plugin-${entry.id}"`);
      }
      if (manifest.engines?.bb === undefined) problem(`${git.subdir}/package.json has no engines.bb range`);
      if (git.tagPrefix !== `${entry.id}/`) problem(`tagPrefix must be "${entry.id}/"`);
      // Update Shelf shows these notes in What's new, so they are read before a release is offered.
      for (const message of pluginChangelogProblems(root, { id: entry.id, displayName: entry.displayName, subdir: git.subdir })) {
        problem(message);
      }
      // bb reads each bb.skills entry as a folder of skill folders; pointing at one skill's own folder loads nothing.
      for (const skillsRoot of manifest.bb?.skills ?? []) {
        const dir = join(root, git.subdir, skillsRoot);
        const skills = existsSync(dir)
          ? readdirSync(dir, { withFileTypes: true }).filter((item) => item.isDirectory() && existsSync(join(dir, item.name, "SKILL.md")))
          : [];
        if (skills.length === 0) {
          problem(`bb.skills entry "${skillsRoot}" holds no skill folder with a SKILL.md; list the folder that contains the skill folders, such as "./skills"`);
        }
      }
    }

    if (typeof entry.overview !== "string") return entry;
    if (!existsSync(join(root, entry.overview))) {
      problem(`${entry.overview} does not exist`);
      return entry;
    }
    const text = readText(entry.overview);
    for (const message of overviewProblems(text)) problem(`${entry.overview}: ${message}`);
    return { ...entry, overview: text.trim() };
  });

if (problems.length > 0) fail(`${problems.length} problem(s)\n${problems.map((message) => `  - ${message}`).join("\n")}`);

const output = `${JSON.stringify({ ...base, plugins }, null, 2)}\n`;
const target = join(root, "marketplace.json");

if (process.argv.includes("--check")) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current !== output) fail("marketplace.json is out of date; run `npm run build`");
  console.log("marketplace.json is up to date");
} else {
  writeFileSync(target, output);
  console.log(`wrote marketplace.json with ${plugins.length} plugin(s)`);
}
