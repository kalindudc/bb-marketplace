import { describe, expect, it } from "vitest";
import { EMPTY_LAYOUT } from "../src/layout";
import { buildGroups } from "../src/tree";
import { flattenGroup } from "../src/rows";
import { filterGroups } from "../src/filter";
import { ageLabel } from "../src/time";
import { sidebarThread } from "./fixtures";

const group = buildGroups({ layout: EMPTY_LAYOUT, sections: [], threads: [
  sidebarThread({ id: "root", projectId: "p" }),
  sidebarThread({ id: "first", parentThreadId: "root", projectId: "q", status: "active", createdAt: 2 }),
  sidebarThread({ id: "last", parentThreadId: "root", hasPendingInteraction: true, createdAt: 3 }),
] })[0];

describe("flattening", () => {
  const options = { collapsed: new Set<string>(), filtering: false, activeThreadId: null,
    projectName: (id: string) => id === "q" ? "Other project" : "Main" };
  it("gives children project tags, depth, guide strings and sibling positions", () => {
    const rows = flattenGroup(group, options);
    expect(rows.map((row) => row.thread.id)).toEqual(["root", "first", "last"]);
    expect(rows[1]).toMatchObject({ depth: 1, crossProject: "Other project", isLast: false, guides: expect.any(String) });
    expect(rows[2]).toMatchObject({ depth: 1, crossProject: null, isLast: true });
    expect(rows[1].guides).toHaveLength(1);
  });

  it("rolls up a collapsed parent but forces the active path open", () => {
    const collapsed = new Set(["thread:root"]);
    const rows = flattenGroup(group, { ...options, collapsed });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ collapsed: true, childCount: 2, rollup: "needs", rollupCount: 1 });
    expect(flattenGroup(group, { ...options, collapsed, activeThreadId: "first" })).toHaveLength(3);
  });

  it("ignores collapse for filters and dims retained ancestors", () => {
    const filtered = filterGroups([group], { query: "Other project", states: new Set() }, {
      project: options.projectName, section: () => "",
    })[0];
    const rows = flattenGroup(filtered, { ...options, collapsed: new Set(["thread:root"]), filtering: true });
    expect(rows.map((row) => [row.thread.id, row.dim])).toEqual([["root", true], ["first", false]]);
  });
});

describe("age labels", () => {
  it("quantizes minutes through weeks", () => {
    const now = 10_000_000_000;
    expect(ageLabel(now, now - 30_000)).toBe("now");
    expect(ageLabel(now, now - 5 * 60_000)).toBe("5m");
    expect(ageLabel(now, now - 3 * 3_600_000)).toBe("3h");
    expect(ageLabel(now, now - 2 * 86_400_000)).toBe("2d");
    expect(ageLabel(now, now - 6 * 7 * 86_400_000)).toBe("6w");
  });
});
