import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entryProblems, OVERVIEW_MAX_CHARACTERS, overviewProblems } from "./rules.mjs";

const entry = (overrides = {}) => ({
  id: "demo",
  displayName: "Demo",
  description: "Shows a demo.",
  icon: "FolderGit",
  tags: ["git", "side-panel"],
  author: { name: "Ada", github: "ada-l" },
  category: "thread-content",
  screenshots: ["https://raw.githubusercontent.com/ada-l/m/main/screenshots/demo/one.png", "./screenshots/demo/two.webp"],
  overview: "./plugins/demo/PLUGIN_OVERVIEW.md",
  source: { git: { url: "https://github.com/ada-l/m.git", subdir: "plugins/demo", range: ">=0.1.0 <1.0.0", tagPrefix: "demo/" } },
  ...overrides,
});

describe("overviewProblems", () => {
  it("accepts a plain overview with sections, code and https links", () => {
    assert.deepEqual(overviewProblems("Does a thing.\n\n## Use\n\nRun `bb demo <id>`; see [docs](https://example.com/a).\n"), []);
  });

  it("counts the file as it is, so the final newline counts toward the limit", () => {
    assert.deepEqual(overviewProblems("x".repeat(OVERVIEW_MAX_CHARACTERS)), []);
    assert.deepEqual(overviewProblems(`${"x".repeat(OVERVIEW_MAX_CHARACTERS - 1)}\n`), []);
    assert.deepEqual(overviewProblems(`${"x".repeat(OVERVIEW_MAX_CHARACTERS)}\n`), [
      "the overview has 4001 characters, final newline included; the limit is 4000",
    ]);
  });

  it("rejects a # title, raw HTML, images and links that are not absolute https", () => {
    assert.deepEqual(overviewProblems("# Demo\n"), ["the overview opens with a \"# \" title"]);
    assert.deepEqual(overviewProblems("A <b>bold</b> claim."), ["the overview contains raw HTML"]);
    assert.deepEqual(overviewProblems("![shot](https://example.com/a.png)"), ["the overview contains an image; use screenshots"]);
    assert.deepEqual(overviewProblems("See [the README](./README.md)."), ["the overview has a link that is not absolute https"]);
    assert.deepEqual(overviewProblems("See [it](http://example.com)."), ["the overview has a link that is not absolute https"]);
  });

  it("allows angle brackets inside code", () => {
    assert.deepEqual(overviewProblems("Open `<computer>.local` or run `bb x <thread>`."), []);
  });
});

describe("entryProblems", () => {
  it("accepts a complete entry", () => {
    assert.deepEqual(entryProblems(entry()), []);
  });

  it("rejects fields the schema does not know, and generated ones", () => {
    assert.deepEqual(entryProblems(entry({ publishedAt: "2026-01-01T00:00:00Z" })), ["unknown field \"publishedAt\""]);
  });

  it("requires a category, an overview and non-empty names", () => {
    assert.deepEqual(entryProblems(entry({ category: undefined, overview: undefined, displayName: "", description: " " })), [
      "displayName must not be empty", "description must not be empty", "category is required", "overview is required",
    ]);
  });

  it("limits tags to 10, each at most 32 lowercase characters joined by dashes", () => {
    const eleven = Array.from({ length: 11 }, (_, index) => `tag-${index}`);
    assert.deepEqual(entryProblems(entry({ tags: eleven })), ["11 tags; the limit is 10"]);
    assert.deepEqual(entryProblems(entry({ tags: ["Side Panel", "a".repeat(33), "ok-tag"] })), [
      "the tag \"Side Panel\" must be lowercase letters and digits joined by dashes",
      `the tag "${"a".repeat(33)}" is longer than 32 characters`,
    ]);
  });

  it("limits screenshots to 6 https or ./screenshots/<id>/ images", () => {
    const seven = Array.from({ length: 7 }, (_, index) => `https://example.com/${index}.png`);
    assert.deepEqual(entryProblems(entry({ screenshots: seven })), ["7 screenshots; the limit is 6"]);
    assert.deepEqual(entryProblems(entry({ screenshots: ["http://example.com/a.png", "./media/a.png", "https://example.com/a.gif"] })), [
      "the screenshot \"http://example.com/a.png\" must be an https URL or ./screenshots/<id>/<file>, as png, jpg or webp",
      "the screenshot \"./media/a.png\" must be an https URL or ./screenshots/<id>/<file>, as png, jpg or webp",
      "the screenshot \"https://example.com/a.gif\" must be an https URL or ./screenshots/<id>/<file>, as png, jpg or webp",
    ]);
  });

  it("keeps the author to a name, a GitHub user name and an https URL", () => {
    assert.deepEqual(entryProblems(entry({ author: { name: "Ada", email: "ada@example.com" } })), ["unknown author field \"email\""]);
    assert.deepEqual(entryProblems(entry({ author: { name: "", github: "not a user", url: "http://ada.dev" } })), [
      "author.name must not be empty", "author.github \"not a user\" is not a GitHub user name", "author.url must start with https://",
    ]);
  });

  it("checks the id and an icon name", () => {
    assert.deepEqual(entryProblems(entry({ id: "Demo_1", icon: "folder-git" })), [
      "the id \"Demo_1\" must be lowercase letters, digits and dashes", "the icon \"folder-git\" is not an icon name",
    ]);
    assert.deepEqual(entryProblems(entry({ icon: { url: "./icons/demo.svg" } })), []);
  });
});
