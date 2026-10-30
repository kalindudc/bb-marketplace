import assert from "node:assert/strict";
import test from "node:test";
import { changelogProblems, MAX_VERSION_CHARACTERS } from "./changelog.mjs";

const TAGS = [
  { version: "0.1.0", date: "2026-10-28" },
  { version: "0.2.0", date: "2026-10-29" },
];
const META = { id: "demo", displayName: "Demo", version: "0.2.0", tags: TAGS };
const INTRO = "Notable changes to Demo, newest first. Releases are tagged `demo/vX.Y.Z` in this repository.";
const HEAD = `# Changelog\n\n${INTRO}\n\n`;
const block = (version, date, section, body) => `## ${version} (${date})\n\n### ${section}\n\n${body}\n`;
const VALID = `${HEAD}${block("0.2.0", "2026-10-29", "Fixed", "- A bullet.")}\n${block("0.1.0", "2026-10-28", "Added", "- Another bullet.")}`;

const check = (text, meta = META) => changelogProblems(text, meta);
const reject = (text, pattern, meta = META) => assert.match(check(text, meta).join("\n"), pattern);
const replace = (from, to) => {
  assert.ok(VALID.includes(from), `the fixture no longer contains ${from}`);
  return VALID.replace(from, to);
};

test("accepts a conforming changelog", () => {
  assert.deepEqual(check(VALID), []);
});

test("accepts one undated Unreleased block at the top", () => {
  assert.deepEqual(check(`# Changelog\n\n${INTRO}\n\n## Unreleased\n\n### Added\n\n- Pending.\n\n${VALID.slice(HEAD.length)}`), []);
});

test("checks the title, the blank lines and the intro", () => {
  reject(replace("# Changelog", "## Changelog"), /line 1 must be/);
  reject(replace("# Changelog\n\n", "# Changelog\n"), /line 2 must be blank/);
  reject(replace(INTRO, "Notable changes to Other, newest first. `demo/vX.Y.Z`."), /intro must open with/);
  reject(replace(INTRO, "Notable changes to Demo, newest first. Releases are tagged `demo/X.Y.Z`."), /tag prefix/);
  reject(replace(INTRO, "## 0.2.0"), /intro must be a sentence/);
});

test("checks version headings", () => {
  reject(replace("## 0.2.0 (2026-10-29)", "## 0.2.0"), /is not "## X\.Y\.Z \(YYYY-MM-DD\)"/);
  reject(replace("## 0.2.0 (2026-10-29)", "## [0.2.0] (2026-10-29)"), /is not "## X\.Y\.Z/);
  reject(replace("## 0.2.0 (2026-10-29)", "## v0.2.0 (2026-10-29)"), /is not "## X\.Y\.Z/);
  reject(replace("## 0.2.0 (2026-10-29)", "## 0.2.0 (2026-10-29) Extra"), /is not "## X\.Y\.Z/);
});

test("orders versions newest first, once each", () => {
  const first = block("0.2.0", "2026-10-29", "Fixed", "- A bullet.");
  const second = block("0.1.0", "2026-10-28", "Added", "- Another bullet.");
  reject(`${HEAD}${second}\n${first}`, /0\.1\.0 comes before 0\.2\.0/);
  reject(`${HEAD}${first}\n${first}`, /a second section for 0\.2\.0/);
  reject(`# Changelog\n\n${INTRO}\n\n${VALID.slice(HEAD.length)}\n## Unreleased\n\n### Fixed\n\n- Pending.\n`, /only allowed at the top/);
});

test("dates a version from its tag and names the version it releases", () => {
  reject(replace("## 0.2.0 (2026-10-29)", "## 0.2.0 (2026-10-30)"), /was tagged 2026-10-29, not 2026-10-30/);
  reject(`${HEAD}${block("0.3.0", "2026-10-30", "Added", "- New.")}\n${VALID.slice(HEAD.length)}`, /demo\/v0\.3\.0 is not a tag, and package\.json is 0\.2\.0/);
  reject(VALID, /package\.json is 0\.3\.0/, { ...META, version: "0.3.0" });
});

test("covers every tag, unless the intro declares the history it predates", () => {
  const without = HEAD + block("0.2.0", "2026-10-29", "Fixed", "- A bullet.");
  reject(without, /the tag demo\/v0\.1\.0 has no section/);
  const declared = `# Changelog\n\n${INTRO} Releases before this file existed are described in their commit messages.\n\n${without.slice(HEAD.length)}`;
  assert.deepEqual(check(declared), []);
  // A declared gap does not excuse a release the file is old enough to know about.
  reject(`${HEAD}${block("0.1.0", "2026-10-28", "Added", "- Another bullet.")}`, /package\.json is 0\.2\.0/);
});

test("uses only the fixed sections, in the fixed order, never empty", () => {
  reject(replace("### Fixed", "### Notes"), /"### Notes" is not one of/);
  reject(
    `${HEAD}## 0.2.0 (2026-10-29)\n\n### Fixed\n\n- A bullet.\n\n### Added\n\n- Another.\n`,
    /"### Added" is out of order in 0\.2\.0/,
  );
  reject(`${HEAD}## 0.2.0 (2026-10-29)\n\n### Fixed\n\n- A bullet.\n\n### Fixed\n\n- Another.\n`, /a second "### Fixed"/);
  reject(`${HEAD}## 0.2.0 (2026-10-29)\n\n### Fixed\n\n### Added\n\n- Another.\n`, /"### Fixed" in 0\.2\.0 has no bullets/);
  reject(replace("### Fixed", "#### Fixed"), /a level 4 heading/);
});

test("allows one paragraph framing a release, and only one", () => {
  const framed = HEAD + "## 0.2.0 (2026-10-29)\n\nContext for this release.\n\n### Fixed\n\n- A bullet.\n";
  assert.deepEqual(check(`${framed}\n${block("0.1.0", "2026-10-28", "Added", "- Another bullet.")}`), []);
  reject(
    HEAD + "## 0.2.0 (2026-10-29)\n\nOne paragraph.\n\nA second one.\n\n### Fixed\n\n- A bullet.\n",
    /a second paragraph before the first ### section/,
  );
});

test("keeps one bullet style", () => {
  reject(replace("- A bullet.", "* A bullet."), /a "\*" or "\+" bullet/);
  reject(replace("- A bullet.", "- **A bullet.** More."), /a bullet that opens with a bold lead-in/);
  reject(replace("- A bullet.", "Just prose."), /not a bullet, under a ### section/);
  reject(replace("- A bullet.", "-"), /an empty bullet/);
  reject(replace("- A bullet.", "- A bullet.\n  - **Nested lead.** More."), /a bullet that opens with a bold lead-in/);
});

test("keeps the spacing and the ending", () => {
  reject(VALID.replace("\n\n## 0.1.0", "\n\n\n## 0.1.0"), /two blank lines in a row/);
  reject(replace("\n\n### Fixed", "\n### Fixed"), /blank line above it/);
  reject(replace("### Fixed\n\n- A bullet.", "### Fixed\n- A bullet."), /blank line below it/);
  reject(replace("- A bullet.\n", "- A bullet.\n\n---\n"), /horizontal rule/);
  reject(replace("- A bullet.", "- A bullet. "), /trailing whitespace/);
  reject(replace("- A bullet.", "\t- A bullet."), /a tab/);
  reject(replace("- A bullet.", "- A <b>bullet</b>."), /raw HTML/);
  reject(replace("- A bullet.", "- ![shot](x.png)"), /an image/);
  assert.match(check(VALID.trimEnd()).join("\n"), /does not end with a newline/);
  assert.match(check(`${VALID}\n`).join("\n"), /ends with a blank line/);
});

test("keeps a version inside what Update Shelf shows", () => {
  // What's new reads a version's whole body, so two sections are measured together.
  const half = `- ${"x".repeat(MAX_VERSION_CHARACTERS / 2)}`;
  const text = HEAD + block("0.2.0", "2026-10-29", "Fixed", `${half}\n\n### Added\n\n${half}`);
  reject(text, /What's new cuts a version at 12000/);
});

test("passes a checkout with no tags, and skips only the history rules", () => {
  assert.deepEqual(check(VALID, { id: "demo", displayName: "Demo" }), []);
  assert.deepEqual(check(VALID, { id: "demo", displayName: "Demo", tags: [] }), []);
});

// Update Shelf reads other marketplaces' plugins, so it must accept what this format writes. These are the two
// patterns plugins/update-shelf/src/changelog.ts finds a version and a section with.
test("stays inside what Update Shelf's reader accepts", () => {
  const VERSION = /^\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?(?=$|[\s(\-–—:,])/u;
  const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/u;
  const versions = [];
  for (const line of VALID.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading === null) continue;
    if (heading[1].length === 2) {
      const version = VERSION.exec(heading[2])?.[1];
      assert.ok(version !== undefined, `${line} is not a version heading its reader finds`);
      versions.push(version);
    } else if (heading[1].length > 2) {
      assert.ok(heading[1].length === 3, `${line} sits deeper than the reader shows`);
    }
  }
  assert.deepEqual(versions, ["0.2.0", "0.1.0"]);
});
