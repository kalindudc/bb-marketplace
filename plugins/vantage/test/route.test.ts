import { describe, expect, it } from "vitest";
import { formatRoute, parseRoute, type PageRoute } from "../src/route";

const KEY = "host_1:/work/one";
const ENCODED = "host_1~3A~2Fwork~2Fone";

const all = (overrides: Partial<PageRoute> = {}): PageRoute => ({ target: { kind: "all" }, view: "worktrees", selectedKey: null, focus: null, ...overrides });
const tree = (overrides: Partial<PageRoute> = {}): PageRoute => all({ target: { kind: "tree", threadId: "thr_ab" }, ...overrides });

describe("parseRoute and formatRoute", () => {
  it.each([
    ["", all()],
    ["repositories", all({ view: "repositories" })],
    [`worktree/${ENCODED}`, all({ selectedKey: KEY })],
    ["tree/thr_ab", tree()],
    ["tree/thr_ab/repositories", tree({ view: "repositories" })],
    [`tree/thr_ab/worktree/${ENCODED}`, tree({ selectedKey: KEY })],
    [`repositories/repo/${ENCODED}`, all({ view: "repositories", focus: { kind: "repo", key: KEY } })],
    ["repositories/other-files", all({ view: "repositories", focus: { kind: "otherFiles" } })],
    [`tree/thr_ab/repositories/repo/${ENCODED}`, tree({ view: "repositories", focus: { kind: "repo", key: KEY } })],
    ["tree/thr_ab/repositories/other-files", tree({ view: "repositories", focus: { kind: "otherFiles" } })],
  ])("round-trips %j", (subPath, route) => {
    expect(parseRoute(subPath)).toEqual({ route, canonical: subPath });
    expect(formatRoute(route)).toBe(subPath);
  });

  it("encodes a key that holds colons and slashes into one segment of letters, digits and . _ - ~ only", () => {
    expect(formatRoute(all({ selectedKey: KEY }))).toBe("worktree/host_1~3A~2Fwork~2Fone");
    const awkward = formatRoute(all({ selectedKey: "host:/a b/ü~%2F?#.-_" }));
    expect(awkward.slice("worktree/".length)).toMatch(/^[A-Za-z0-9._~-]+$/);
  });

  it("survives what bb does to an address: encoding each segment once more leaves it unchanged", () => {
    const { canonical } = parseRoute(`tree/thr_ab/worktree/${ENCODED}`);
    expect(canonical.split("/").map((segment) => encodeURIComponent(segment)).join("/")).toBe(canonical);
  });

  it("round-trips keys with spaces, unicode, tildes, percent signs and slashes", () => {
    for (const key of ["a b", "ü/漢字", "~", "100%/done", "host_1:/work/it's here", "%2F%3A", "a~3Ab"]) {
      expect(parseRoute(formatRoute(all({ selectedKey: key }))).route.selectedKey).toBe(key);
    }
  });

  it("drops a key that is not in this encoding, such as one still percent-encoded", () => {
    for (const bad of ["host_1%3A%2Fwork", "host_1:/work", "a~", "a~G1", "a~zz", "~FF~FE"]) {
      expect(parseRoute(`worktree/${bad}`)).toEqual({ route: all(), canonical: "" });
    }
  });

  it("formats the default route as an empty string", () => {
    expect(formatRoute(all())).toBe("");
  });

  it("drops a selected key in the Repositories view", () => {
    expect(formatRoute(all({ view: "repositories", selectedKey: KEY }))).toBe("repositories");
    const parsed = parseRoute(`repositories/worktree/${ENCODED}`);
    expect(parsed.route).toEqual(all({ view: "repositories" }));
    expect(parsed.canonical).toBe("repositories");
  });

  it("drops a focused repository in the Worktrees view", () => {
    expect(formatRoute(all({ focus: { kind: "repo", key: KEY } }))).toBe("");
    expect(formatRoute(tree({ focus: { kind: "otherFiles" } }))).toBe("tree/thr_ab");
  });

  it("drops a focused repository key that is not in the encoding or is too long, and keeps the Repositories view", () => {
    for (const bad of ["repositories/repo", "repositories/repo/host_1:/work", "repositories/repo/a~G1", `repositories/repo/${"k".repeat(401)}`]) {
      expect(parseRoute(bad)).toEqual({ route: all({ view: "repositories" }), canonical: "repositories" });
    }
    expect(parseRoute("repositories/other-files/bogus").route.focus).toEqual({ kind: "otherFiles" });
  });

  it("falls back to every thread for a bad thread id, and ignores what follows it", () => {
    for (const subPath of ["tree/bad id", "tree/", "tree", `tree/${"a".repeat(65)}/repositories`, "tree/thr.ab"]) {
      const parsed = parseRoute(subPath);
      expect(parsed.route).toEqual(all());
      expect(parsed.canonical).toBe("");
    }
  });

  it("keeps what parsed before an unknown segment", () => {
    expect(parseRoute("bogus")).toEqual({ route: all(), canonical: "" });
    expect(parseRoute("repositories/bogus")).toEqual({ route: all({ view: "repositories" }), canonical: "repositories" });
    expect(parseRoute("tree/thr_ab/bogus")).toEqual({ route: tree(), canonical: "tree/thr_ab" });
    expect(parseRoute("worktree")).toEqual({ route: all(), canonical: "" });
  });

  it("falls back to no selection for a malformed escape or a key over 400 characters", () => {
    expect(parseRoute("worktree/~E0~A4~A")).toEqual({ route: all(), canonical: "" });
    const long = parseRoute(`tree/thr_ab/worktree/${"k".repeat(401)}`);
    expect(long).toEqual({ route: tree(), canonical: "tree/thr_ab" });
    const edge = "k".repeat(400);
    expect(parseRoute(`worktree/${edge}`).route.selectedKey).toBe(edge);
  });

  it("accepts surrounding slashes and gives the plain form as the canonical string", () => {
    expect(parseRoute("/repositories/")).toEqual({ route: all({ view: "repositories" }), canonical: "repositories" });
    expect(parseRoute("tree/thr_ab/")).toEqual({ route: tree(), canonical: "tree/thr_ab" });
  });

  it("never throws and always returns a canonical string that parses to itself", () => {
    for (const subPath of ["%", "%%", "///", "tree//x", "worktree/~00", "worktree//", "😀", "tree/thr_ab/worktree", "..", "repositories/repo//", "repositories/repo/~00"]) {
      const { route, canonical } = parseRoute(subPath);
      expect(parseRoute(canonical)).toEqual({ route, canonical });
    }
  });
});
