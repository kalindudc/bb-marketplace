import { describe, expect, it } from "vitest";
import { sliceChangelog } from "../src/changelog";

const KEEP_A_CHANGELOG = `# Changelog

Intro text that is not a release.

## [Unreleased]

## [0.2.7] - 2026-10-25

### Added
- Trusted file directories.

## [0.2.6] - 2026-10-21

### Added
- An **Animations** setting.

## [0.2.5] - 2026-10-21

### Fixed
- Git installs.
`;

const LOOM_STYLE = `# Changelog

## 0.29.3 (2026-10-28)

### Fixed

- A ticket no longer waits on cancelled checks.

\`\`\`sh
## 0.1.0 inside a code block is not a release
\`\`\`

## 0.29.2 (2026-10-28)

### Fixed

- Conflict-marker paths.
`;

describe("sliceChangelog", () => {
  it("keeps the releases after the installed version up to the candidate, newest first", () => {
    const entries = sliceChangelog(KEEP_A_CHANGELOG, { from: "0.2.5", to: "0.2.7" });
    expect(entries.map((entry) => entry.version)).toEqual(["0.2.7", "0.2.6"]);
    expect(entries[0]).toEqual({ version: "0.2.7", title: "0.2.7 - 2026-10-25", body: "### Added\n- Trusted file directories." });
  });

  it("keeps subheadings and code blocks inside their release", () => {
    const [entry, ...rest] = sliceChangelog(LOOM_STYLE, { from: "0.29.2", to: "0.29.3" });
    expect(rest).toEqual([]);
    expect(entry!.title).toBe("0.29.3 (2026-10-28)");
    expect(entry!.body).toContain("### Fixed");
    expect(entry!.body).toContain("## 0.1.0 inside a code block is not a release");
  });

  it("finds nothing when the candidate has no entry yet", () => {
    expect(sliceChangelog(KEEP_A_CHANGELOG, { from: "0.2.7", to: "0.2.8" })).toEqual([]);
  });

  it("keeps every newer release when the candidate's version is unknown", () => {
    expect(sliceChangelog(KEEP_A_CHANGELOG, { from: "0.2.5", to: null }).map((entry) => entry.version)).toEqual(["0.2.7", "0.2.6"]);
  });

  it("keeps only the candidate's release when the installed version is unknown", () => {
    expect(sliceChangelog(KEEP_A_CHANGELOG, { from: null, to: "0.2.6" }).map((entry) => entry.version)).toEqual(["0.2.6"]);
    expect(sliceChangelog(KEEP_A_CHANGELOG, { from: "a713743", to: "0.2.6" }).map((entry) => entry.version)).toEqual(["0.2.6"]);
  });

  it("returns nothing when neither version is known", () => {
    expect(sliceChangelog(KEEP_A_CHANGELOG, { from: null, to: null })).toEqual([]);
  });
});
