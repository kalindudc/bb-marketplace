import { describe, expect, it } from "vitest";
import { buildLanes } from "../src/lanes";
import { EMPTY_LAYOUT } from "../src/layout";
import { buildModel } from "../src/tree";
import { sidebarSection, sidebarThread } from "./fixtures";

const names = { project: (id: string) => id === "p" ? "Main project" : "Other",
  section: (id: string | null) => id === "s" ? "Reviews" : "" };
const filter = { query: "", states: new Set<"failed" | "needs" | "running" | "unread" | "idle">() };
const groups = () => buildModel({ now: 10_000, staleDays: 0,
  layout: { ...EMPTY_LAYOUT, sectionHues: { s: "violet" }, snoozes: { asleep: { at: 2, until: 20_000 } } },
  sections: [sidebarSection("s", "Reviews")], threads: [
    sidebarThread({ id: "root", displayTitle: "Root", sectionId: "s", updatedAt: 6 }),
    sidebarThread({ id: "child", displayTitle: "Child", parentThreadId: "root", isUnread: true, updatedAt: 7 }),
    sidebarThread({ id: "failed-old", status: "error", updatedAt: 4, latestAttentionAt: 4 }),
    sidebarThread({ id: "failed-new", status: "error", updatedAt: 8, latestAttentionAt: 8 }),
    sidebarThread({ id: "needs", hasPendingInteraction: true }),
    sidebarThread({ id: "running", status: "active" }),
    sidebarThread({ id: "asleep", latestAttentionAt: 1, updatedAt: 1 }),
    sidebarThread({ id: "hidden", isHidden: true, status: "error" }),
  ] }).groups;

describe("status lanes", () => {
  it("lists each visible awake thread once in its own lane, newest attention first", () => {
    const lanes = buildLanes(groups(), filter, names);
    expect(lanes.map((lane) => lane.key)).toEqual([
      "lane:failed", "lane:needs", "lane:running", "lane:unread", "lane:idle",
    ]);
    expect(lanes[0]!.rows.map((row) => row.thread.id)).toEqual(["failed-new", "failed-old"]);
    expect(lanes[3]!.rows[0]).toMatchObject({ parentTitle: "Root", state: "unread", hue: "violet" });
    expect(lanes[4]!.rows[0]).toMatchObject({ parentTitle: null, hue: "violet" });
    const all = lanes.flatMap((lane) => lane.rows.map((row) => row.thread.id));
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain("asleep");
    expect(all).not.toContain("hidden");
  });

  it("filters by own state, title, branch, project or root section and hides empty lanes", () => {
    expect(buildLanes(groups(), { query: "child", states: new Set() }, names)
      .map((lane) => [lane.key, lane.rows.map((row) => row.thread.id)]))
      .toEqual([["lane:unread", ["child"]]]);
    expect(buildLanes(groups(), { query: "reviews", states: new Set(["unread"]) }, names)
      .flatMap((lane) => lane.rows.map((row) => row.thread.id))).toEqual(["child"]);
    expect(buildLanes(groups(), { query: "nothing", states: new Set() }, names)).toEqual([]);
  });
});
