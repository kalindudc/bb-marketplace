import { describe, expect, it } from "vitest";
import { EMPTY_LAYOUT } from "../src/layout";
import { buildGroups } from "../src/tree";
import { chipCounts, filterGroups } from "../src/filter";
import { sidebarSection, sidebarThread } from "./fixtures";

const groups = buildGroups({ layout: EMPTY_LAYOUT, sections: [sidebarSection("s", "Review")], threads: [
  sidebarThread({ id: "root", displayTitle: "Parent", sectionId: "s", projectId: "p" }),
  sidebarThread({ id: "child", displayTitle: "Implementation", parentThreadId: "root", sectionId: "other", projectId: "q",
    environment: { id: "e", name: "checkout", branchName: "feature/new", path: "/tmp", isWorktree: true, providerId: null, workspaceDisplayKind: null },
    status: "active" }),
  sidebarThread({ id: "loose", displayTitle: "Unrelated", hasPendingInteraction: true }),
] });
const names = { project: (id: string) => id === "q" ? "Cortex" : "Marketplace", section: (id: string | null) => id === "s" ? "Review" : "" };
const query = (value: string) => filterGroups(groups, { query: value, states: new Set() }, names);

describe("filtering", () => {
  it("matches titles, project names, branches and the root section name", () => {
    for (const text of ["implementation", "cortex", "feature/new"]) {
      const found = query(text);
      expect(found.map((group) => group.key)).toEqual(["section:s"]);
      expect(found[0].roots[0].matches).toBe(false);
      expect(found[0].roots[0].children[0].matches).toBe(true);
    }
    expect(query("review")[0].roots[0].children[0].matches).toBe(true);
    expect(query("parent")[0].roots[0].children).toEqual([]);
  });

  it("combines selected chips with OR and text with AND while retaining ancestors", () => {
    const filtered = filterGroups(groups, { query: "implementation", states: new Set(["running", "needs"]) }, names);
    expect(filtered[0].roots[0].children.map((node) => node.thread.id)).toEqual(["child"]);
    expect(filterGroups(groups, { query: "", states: new Set(["needs"]) }, names).map((group) => group.key)).toEqual(["loose"]);
    expect(chipCounts(groups)).toEqual({ failed: 0, needs: 1, running: 1, unread: 0 });
  });
});
