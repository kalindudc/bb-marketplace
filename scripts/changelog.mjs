// The one changelog format for this marketplace, checked rather than described.
//
// Update Shelf reads a plugin's CHANGELOG.md at the tag of the release it offers and shows the sections newer than
// the installed version. That reader (plugins/update-shelf/src/changelog.ts) is deliberately tolerant, because it
// reads other marketplaces' plugins too: it takes a version at any heading depth and any of "## 0.2.6 (2026-10-21)",
// "## [0.2.6] - 2026-10-21" or "## v1.2.0". This file is the strict format we hold our own plugins to, and it is a
// subset of what that reader accepts, so a changelog that passes here always reads correctly there.
//
// scripts/changelog.test.mjs checks every plugin against it and scripts/build.mjs runs it in `npm run check`.
export const SECTIONS = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security", "Compatibility"];

// plugins/update-shelf/src/changelog.ts truncates a version's notes at this many characters.
export const MAX_VERSION_CHARACTERS = 12_000;

const INTRO_PREFIX = "Notable changes to ";
// An older tag the file does not cover is allowed only when the intro says so, in these words.
const DECLARED_HISTORY = "before this file existed are described in their commit messages";

const VERSION_HEADING = /^## (\d+\.\d+\.\d+) \((\d{4}-\d{2}-\d{2})\)$/u;
const UNRELEASED = "Unreleased";
const HEADING = /^(#{1,6}) (.*)$/u;
const BULLET = /^( {2})?- \S/u;
const FENCE = /^\s*(?:```|~~~)/u;

const semver = (text) => text.match(/^(\d+)\.(\d+)\.(\d+)$/u)?.slice(1).map(Number) ?? null;

function compare(left, right) {
  const a = semver(left);
  const b = semver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/**
 * Every way `text` departs from the format, as sentences a person can act on.
 *
 * `version` is the plugin's package.json version and `tags` are its `<id>/vX.Y.Z` releases as `{ version, date }`.
 * Without them the rules that need release history are skipped, so a checkout without tags still checks the format.
 */
export function changelogProblems(text, meta = {}) {
  const { id = "<id>", displayName = null, version = null, tags = [] } = meta;
  const problems = [];
  const add = (message, line = null) => problems.push(line === null ? message : `line ${line}: ${message}`);

  if (!text.endsWith("\n")) add("the file does not end with a newline");
  else if (text.endsWith("\n\n")) add("the file ends with a blank line");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();

  const intro = lines[2] ?? "";
  if (lines[0] !== "# Changelog") add('line 1 must be "# Changelog"', 1);
  if (lines[1] !== "") add("line 2 must be blank", 2);
  if (intro === "") add("line 3 must be one sentence introducing the file", 3);
  else if (HEADING.test(intro)) add("the intro must be a sentence, not a heading", 3);
  else {
    if (displayName !== null && !intro.startsWith(`${INTRO_PREFIX}${displayName},`)) {
      add(`the intro must open with "${INTRO_PREFIX}${displayName}, newest first."`, 3);
    }
    if (!intro.includes(`${id}/v`)) add(`the intro must name the tag prefix \`${id}/vX.Y.Z\``, 3);
  }
  if (lines[3] !== "") add("line 4 must be blank", 4);

  const blocks = [];
  let block = null;
  let section = null;
  let fenced = false;
  let blankAbove = true;

  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    if (FENCE.test(line)) fenced = !fenced;
    if (line !== line.trimEnd()) add("trailing whitespace", number);
    if (line.includes("\t")) add("a tab; indent with two spaces", number);
    if (line === "") {
      if (index > 3 && lines[index - 1] === "") add("two blank lines in a row", number);
      blankAbove = true;
      continue;
    }
    const startsParagraph = blankAbove;
    blankAbove = false;
    if (fenced) continue;
    if (/^---+$/u.test(line.trim())) add("a horizontal rule; a blank line separates blocks", number);
    if (/<[a-zA-Z][/!]?[^>]*>/u.test(line.replace(/`[^`]*`/gu, ""))) add("raw HTML", number);
    if (line.includes("![")) add("an image; use the listing's screenshots", number);

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const depth = heading[1].length;
      if (index === 0) continue;
      if (lines[index - 1] !== "") add("a heading with no blank line above it", number);
      if (lines[index + 1] !== undefined && lines[index + 1] !== "") add("a heading with no blank line below it", number);
      if (depth === 2) {
        block = { line: number, index, text: heading[2], version: null, date: null, sections: [] };
        blocks.push(block);
        section = null;
      } else if (depth === 3 && block !== null) {
        section = { line: number, name: heading[2], body: [] };
        block.sections.push(section);
      } else if (depth === 3) {
        add(`"### ${heading[2]}" is not under a version heading`, number);
      } else {
        add(`a level ${depth} heading; the format stops at ### sections`, number);
      }
      continue;
    }

    if (block === null) {
      if (index > 3) add("text between the intro and the first version heading", number);
      continue;
    }
    if (section === null) {
      // A version may open with one paragraph of context, such as the framing a large release needs.
      block.lead = (block.lead ?? 0) + (startsParagraph ? 1 : 0);
      if (block.lead > 1) add("a second paragraph before the first ### section; one paragraph may frame a release", number);
      if (BULLET.test(line)) add("a bullet outside a ### section", number);
      continue;
    }
    if (BULLET.test(line)) {
      if (line.replace(/^ {2}/u, "").startsWith("- **")) add("a bullet that opens with a bold lead-in", number);
      section.body.push(line);
    } else if (/^ *[*+] /u.test(line)) {
      add('a "*" or "+" bullet; use "- "', number);
    } else if (/^ {2,}\S/u.test(line)) {
      section.body.push(line);
    } else if (/^\s*-\s*$/u.test(line)) {
      add("an empty bullet", number);
    } else {
      add("a line that is not a bullet, under a ### section", number);
    }
  }

  const tagsByVersion = new Map(tags.map((tag) => [tag.version, tag]));
  const versions = [];
  for (const [index, entry] of blocks.entries()) {
    if (entry.text === UNRELEASED) {
      entry.version = UNRELEASED;
      if (index > 0) add(`"## ${UNRELEASED}" is only allowed at the top`, entry.line);
      continue;
    }
    const match = VERSION_HEADING.exec(`## ${entry.text}`);
    if (match === null) {
      add(`"## ${entry.text}" is not "## X.Y.Z (YYYY-MM-DD)" or "## ${UNRELEASED}"`, entry.line);
      continue;
    }
    entry.version = match[1];
    entry.date = match[2];
    if (versions.includes(entry.version)) add(`a second section for ${entry.version}`, entry.line);
    else if (versions.length > 0 && compare(versions.at(-1), entry.version) <= 0) {
      add(`${versions.at(-1)} comes before ${entry.version}; newest goes first`, entry.line);
    }
    versions.push(entry.version);
    const tag = tagsByVersion.get(entry.version);
    if (tag !== undefined && tag.date !== entry.date) {
      add(`${id}/v${entry.version} was tagged ${tag.date}, not ${entry.date}`, entry.line);
    }
    if (tag === undefined && entry.version !== version && (version !== null || tags.length > 0)) {
      add(`${id}/v${entry.version} is not a tag, and package.json is ${version ?? "unknown"}`, entry.line);
    }
    if (entry.sections.length === 0) add(`${entry.version} has no ### section`, entry.line);
  }

  if (version !== null && !versions.includes(version)) {
    add(`package.json is ${version}, but no section describes it; a release's entry belongs in its bump commit`);
  }
  const oldest = versions.reduce((low, seen) => (compare(seen, low) < 0 ? seen : low), versions[0] ?? null);
  for (const tag of tags) {
    if (versions.includes(tag.version)) continue;
    if (oldest !== null && compare(tag.version, oldest) < 0 && intro.includes(DECLARED_HISTORY)) continue;
    add(`the tag ${id}/v${tag.version} has no section; backfill it or declare the gap in the intro`);
  }

  for (const entry of blocks) {
    const seen = new Set();
    let order = -1;
    for (const part of entry.sections) {
      const position = SECTIONS.indexOf(part.name);
      if (position === -1) add(`"### ${part.name}" is not one of ${SECTIONS.join(", ")}`, part.line);
      else if (seen.has(part.name)) add(`a second "### ${part.name}" in ${entry.version}`, part.line);
      else if (position < order) add(`"### ${part.name}" is out of order in ${entry.version}; the order is ${SECTIONS.join(", ")}`, part.line);
      else order = position;
      seen.add(part.name);
      if (part.body.length === 0) add(`"### ${part.name}" in ${entry.version} has no bullets`, part.line);
    }
  }

  // What's new shows a whole version at once and cuts its body at MAX_VERSION_CHARACTERS, headings included.
  for (const [index, entry] of blocks.entries()) {
    const end = blocks[index + 1]?.index ?? lines.length;
    const size = lines.slice(entry.index + 1, end).join("\n").trim().length;
    if (size > MAX_VERSION_CHARACTERS) {
      add(`${entry.version ?? entry.text} is ${size} characters; What's new cuts a version at ${MAX_VERSION_CHARACTERS}`, entry.line);
    }
  }

  return problems;
}
