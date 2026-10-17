import { describe, expect, it } from "vitest";
import { buildGroups, buildModel } from "../src/tree";
import { EMPTY_LAYOUT } from "../src/layout";
import { sidebarSection, sidebarThread } from "./fixtures";

const sections = [sidebarSection("a", "Alpha"), sidebarSection("b", "Beta")];
const t = (id: string, overrides: Parameters<typeof sidebarThread>[0] = {}) =>
  sidebarThread({ id, displayTitle: id, href: `/threads/${id}`, ...overrides });

describe("buildGroups", () => {
  it("orders pinned, configured sections, remaining sections and loose threads", () => {
    const groups = buildGroups({ sections, layout: { ...EMPTY_LAYOUT, sectionOrder: ["b"] }, threads: [
      t("loose"), t("one", { sectionId: "a" }), t("two", { sectionId: "b" }), t("pinned", { isPinned: true }),
    ] });
    expect(groups.map((group) => group.key)).toEqual(["pinned", "section:b", "section:a", "loose"]);
    expect(groups.map((group) => group.threadCount)).toEqual([1, 1, 1, 1]);
    expect(buildGroups({ sections, layout: EMPTY_LAYOUT, threads: [] }).map((group) => group.key))
      .toEqual(["section:a", "section:b", "loose"]);
  });

  it("sorts pins, then unlisted roots newest first before saved order", () => {
    const threads = [
      t("pin-z", { isPinned: true, pinSortKey: "z" }), t("pin-a", { isPinned: true, pinSortKey: "a" }),
      t("older", { createdAt: 5 }), t("saved", { createdAt: 20 }), t("newer", { createdAt: 40 }),
    ];
    const groups = buildGroups({ threads, sections: [], layout: { ...EMPTY_LAYOUT, order: { loose: ["saved"] } } });
    expect(groups[0].roots.map((node) => node.thread.id)).toEqual(["pin-a", "pin-z"]);
    expect(groups[1].roots.map((node) => node.thread.id)).toEqual(["newer", "older", "saved"]);
    const fallback = buildGroups({ threads: [t("p1", { isPinned: true, pinnedAt: 5 }), t("p2", { isPinned: true, pinnedAt: 9 })], sections: [], layout: EMPTY_LAYOUT });
    expect(fallback[0].roots.map((node) => node.thread.id)).toEqual(["p2", "p1"]);
  });

  it("nests children across projects and sections, oldest unlisted child first", () => {
    const groups = buildGroups({ sections, layout: { ...EMPTY_LAYOUT, order: { "parent:root": ["saved"] } }, threads: [
      t("root", { sectionId: "a", status: "idle" }),
      t("saved", { parentThreadId: "root", createdAt: 2, sectionId: "b" }),
      t("new", { parentThreadId: "root", projectId: "other", createdAt: 8, status: "active" }),
      t("old", { parentThreadId: "root", createdAt: 3, hasPendingInteraction: true }),
    ] });
    const group = groups.find((item) => item.key === "section:a")!;
    expect(group.roots[0].children.map((node) => node.thread.id)).toEqual(["old", "new", "saved"]);
    expect(group.threadCount).toBe(4);
    expect(group.counts).toMatchObject({ needs: 1, running: 1 });
    expect(group.roots[0].descendants).toMatchObject({ needs: 1, running: 1 });
  });

  it("sorts each section independently, keeps pins ordered and removes snoozed families from counts", () => {
    const now = 10 * 86_400_000;
    const { groups, snoozed } = buildModel({ now, staleDays: 3, sections, layout: { ...EMPTY_LAYOUT,
      sectionSort: { "section:a": "recent", "section:b": "status" },
      snoozes: { quiet: { at: 10, until: now + 1000 } },
    }, threads: [
      t("pin-z", { isPinned: true, pinSortKey: "z" }), t("pin-a", { isPinned: true, pinSortKey: "a" }),
      t("recent", { sectionId: "a", createdAt: 2, updatedAt: 30, latestAttentionAt: 30 }),
      t("older", { sectionId: "a", createdAt: 3, updatedAt: 20, latestAttentionAt: 20 }),
      t("quiet", { sectionId: "a", createdAt: 4, updatedAt: 1, latestAttentionAt: 1 }),
      t("child", { parentThreadId: "quiet", isUnread: true, latestAttentionAt: 5 }),
      t("idle", { sectionId: "b", createdAt: 30 }),
      t("urgent", { sectionId: "b", createdAt: 1, status: "error" }),
    ] });
    expect(groups[0]!.roots.map((node) => node.thread.id)).toEqual(["pin-a", "pin-z"]);
    expect(groups[1]!.roots.map((node) => node.thread.id)).toEqual(["recent", "older"]);
    expect(groups[1]!.threadCount).toBe(2);
    expect(groups[1]!.counts.unread).toBe(0);
    expect(groups[2]!.roots.map((node) => node.thread.id)).toEqual(["urgent", "idle"]);
    expect(snoozed.map((node) => node.thread.id)).toEqual(["quiet"]);
    expect(snoozed[0]!.children.map((node) => node.thread.id)).toEqual(["child"]);
    expect(groups[1]!.roots[0]!.stale).toBe(true);
  });

  it("does not hide a family after its child wakes and marks only idle stale nodes", () => {
    const now = 10 * 86_400_000;
    const model = buildModel({ now, staleDays: 3, sections: [], layout: { ...EMPTY_LAYOUT,
      snoozes: { root: { at: 10, until: now + 1000 } },
    }, threads: [t("root", { latestAttentionAt: 1, updatedAt: 1 }),
      t("child", { parentThreadId: "root", latestAttentionAt: 11, status: "active" })] });
    expect(model.snoozed).toEqual([]);
    expect(model.groups[0]!.roots[0]!.stale).toBe(false);
  });

  it("promotes orphans, drops hidden threads and breaks cycles", () => {
    const groups = buildGroups({ sections: [], layout: EMPTY_LAYOUT, threads: [
      t("orphan", { parentThreadId: "hidden" }), t("hidden", { isHidden: true }),
      t("a", { parentThreadId: "b" }), t("b", { parentThreadId: "a" }),
    ] });
    const seen: string[] = [];
    const visit = (node: (typeof groups)[number]["roots"][number]) => { seen.push(node.thread.id); node.children.forEach(visit); };
    groups.flatMap((group) => group.roots).forEach(visit);
    expect(seen.sort()).toEqual(["a", "b", "orphan"]);
  });
});
