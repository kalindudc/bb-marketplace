// Writes marketplace.json from marketplace.base.json and entries/*.json, with
// each overview file inlined (bb reads the text, not a path). bb reads
// marketplace.json from the repository root, so commit the output.
// `--check` fails when the committed file is out of date.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_URL = "https://github.com/kalindudc/bb-marketplace.git";
const OVERVIEW_MAX_CHARACTERS = 4000;

const readText = (path) => readFileSync(join(root, path), "utf8");
const readJson = (path) => JSON.parse(readText(path));
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
    if (`${entry.id}.json` !== file) fail(`entries/${file} has the id "${entry.id}"`);
    if (entry.category !== undefined && !categoryIds.has(entry.category)) {
      fail(`${entry.id}: the category "${entry.category}" is not in marketplace.base.json`);
    }

    const git = entry.source?.git;
    if (git?.url === REPOSITORY_URL) {
      const manifest = readJson(join(git.subdir, "package.json"));
      if (manifest.name !== `bb-plugin-${entry.id}`) {
        fail(`${git.subdir}/package.json is named "${manifest.name}", not "bb-plugin-${entry.id}"`);
      }
      if (git.tagPrefix !== `${entry.id}/`) fail(`${entry.id}: tagPrefix must be "${entry.id}/"`);
      // bb reads each bb.skills entry as a folder of skill folders; pointing at one skill's own folder loads nothing.
      for (const skillsRoot of manifest.bb?.skills ?? []) {
        const dir = join(root, git.subdir, skillsRoot);
        const skills = existsSync(dir)
          ? readdirSync(dir, { withFileTypes: true }).filter((item) => item.isDirectory() && existsSync(join(dir, item.name, "SKILL.md")))
          : [];
        if (skills.length === 0) {
          fail(`${entry.id}: bb.skills entry "${skillsRoot}" holds no skill folder with a SKILL.md; list the folder that contains the skill folders, such as "./skills"`);
        }
      }
    }

    if (entry.overview === undefined) return entry;
    if (!existsSync(join(root, entry.overview))) fail(`${entry.id}: ${entry.overview} does not exist`);
    const overview = readText(entry.overview).trim();
    if (overview.length > OVERVIEW_MAX_CHARACTERS) {
      fail(`${entry.id}: the overview has ${overview.length} characters, more than ${OVERVIEW_MAX_CHARACTERS}`);
    }
    return { ...entry, overview };
  });

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
