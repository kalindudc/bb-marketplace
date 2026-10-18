import { describe, expect, it } from "vitest";
import { applyLayoutPatch, defaultHue, EMPTY_LAYOUT, isCollapseKey, MAX_ENTRIES, MAX_KEY_LENGTH, parseLayout } from "../src/layout";

describe("layout", () => {
  it("provides safe defaults and accepts only bounded collapse keys", () => {
    expect(parseLayout(undefined)).toEqual(EMPTY_LAYOUT);
    expect(isCollapseKey("pinned")).toBe(true);
    expect(isCollapseKey("loose")).toBe(true);
    expect(isCollapseKey("section:s")).toBe(true);
    expect(isCollapseKey("lane:failed")).toBe(true);
    expect(isCollapseKey("lane:idle")).toBe(true);
    expect(isCollapseKey("lane:other")).toBe(false);
    expect(isCollapseKey("thread:t")).toBe(true);
    expect(isCollapseKey("section:")).toBe(false);
    expect(isCollapseKey(`thread:${"x".repeat(MAX_KEY_LENGTH)}`)).toBe(false);
    expect(isCollapseKey("order:x")).toBe(false);
  });

  it("keeps valid layout parts while dropping malformed entries", () => {
    expect(parseLayout({ sectionOrder: ["a", "a", 3, "x".repeat(MAX_KEY_LENGTH + 1)],
      sectionHues: { a: "teal", b: "unknown", ["x".repeat(MAX_KEY_LENGTH + 1)]: "pink" },
      collapsed: ["pinned", "section:a", "section:", "thread:a", 5],
      order: { loose: ["a", "b", "a", null], "parent:p": ["c"], "thread:bad": ["d"] } })).toEqual({
      sectionOrder: ["a"], sectionHues: { a: "teal" }, collapsed: ["pinned", "section:a", "thread:a"],
      order: { loose: ["a", "b"], "parent:p": ["c"] }, sectionSort: {}, snoozes: {}, sectionProjects: {},
    });
    expect(parseLayout({ sectionOrder: Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => `s${i}`) }).sectionOrder).toHaveLength(MAX_ENTRIES);
    expect(parseLayout({ sectionSort: { loose: "recent", "section:a": "status", "parent:a": "recent", "section:b": "bad" },
      snoozes: { t: { until: 100, at: 5 }, x: { until: -1, at: 5 }, y: { until: 100, at: NaN } } }))
      .toMatchObject({ sectionSort: { loose: "recent", "section:a": "status" }, snoozes: { t: { until: 100, at: 5 } } });
    expect(parseLayout({ sectionProjects: { loose: "p", "section:a": "q", "parent:a": "p", "section:b": "has space",
      "section:c": "", "section:d": 7 } }).sectionProjects).toEqual({ loose: "p", "section:a": "q" });
  });

  it("applies valid patches without changing unrelated fields or accepting junk", () => {
    const initial = parseLayout({ sectionOrder: ["a"], sectionHues: { a: "teal" }, collapsed: [], order: {} });
    const collapsed = applyLayoutPatch(initial, { key: "collapsed", value: ["thread:a"] });
    expect(collapsed.collapsed).toEqual(["thread:a"]);
    const sections = applyLayoutPatch(collapsed, { key: "section-order", value: ["b", "a"] });
    expect(sections.sectionOrder).toEqual(["b", "a"]);
    const hues = applyLayoutPatch(sections, { key: "section-hues", value: { a: "sand" } });
    expect(hues.sectionHues).toEqual({ a: "sand" });
    const ordered = applyLayoutPatch(hues, { key: "order:parent:a", value: ["c"] });
    expect(ordered.order["parent:a"]).toEqual(["c"]);
    expect(applyLayoutPatch(ordered, { key: "order:parent:a", value: [] }).order).toEqual({});
    expect(applyLayoutPatch(hues, { key: "order:bad", value: [] })).toBe(hues);
    expect(applyLayoutPatch(hues, { key: "collapsed", value: ["bogus"] })).toBe(hues);
    const sorted = applyLayoutPatch(hues, { key: "section-sort", value: { loose: "status" } });
    expect(sorted.sectionSort).toEqual({ loose: "status" });
    const snoozed = applyLayoutPatch(sorted, { key: "snoozes", value: { t: { until: 100, at: 5 } } });
    expect(snoozed.snoozes).toEqual({ t: { until: 100, at: 5 } });
    expect(applyLayoutPatch(sorted, { key: "snoozes", value: { t: { until: -1, at: 5 } } })).toBe(sorted);
    const projects = applyLayoutPatch(sorted, { key: "section-projects", value: { "section:a": "p", loose: "q" } });
    expect(projects.sectionProjects).toEqual({ "section:a": "p", loose: "q" });
    expect(projects.sectionSort).toEqual({ loose: "status" });
    expect(applyLayoutPatch(sorted, { key: "section-projects", value: { "parent:a": "p" } })).toBe(sorted);
    expect(applyLayoutPatch(sorted, { key: "section-projects", value: { loose: "" } })).toBe(sorted);
  });

  it("hashes section IDs deterministically into the seven categorical hues", () => {
    expect(defaultHue("same")).toBe(defaultHue("same"));
    for (const id of ["local", "review", "cortex", "hello", "x"]) expect(defaultHue(id)).not.toBe("slate");
  });
});
