import { describe, expect, it } from "vitest";
import { globToRegExp, matchesAny } from "../src/scope";

describe("globToRegExp", () => {
  it("lets ** span directories and * stay inside one", () => {
    expect(globToRegExp("src/**").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("**/*.lock").test("yarn.lock")).toBe(true);
    expect(globToRegExp("**/*.lock").test("deps/yarn.lock")).toBe(true);
  });

  it("treats a pattern without wildcards as a file or a directory prefix", () => {
    expect(globToRegExp("docs").test("docs/a.md")).toBe(true);
    expect(globToRegExp("docs").test("docs2/a.md")).toBe(false);
  });
});

describe("matchesAny", () => {
  it("is true when any glob matches", () => {
    expect(matchesAny("deps/yarn.lock", ["docs/**", "**/*.lock"])).toBe(true);
    expect(matchesAny("src/app/x.ts", ["docs/**", "**/*.lock"])).toBe(false);
  });
});
