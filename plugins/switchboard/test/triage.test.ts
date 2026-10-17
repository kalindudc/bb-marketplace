import { describe, expect, it } from "vitest";
import { EMPTY_LAYOUT } from "../src/layout";
import { buildGroups } from "../src/tree";
import { canSnooze, isSnoozed, isStale, lastActivity, nextWake, sortRoots, wakeLabel } from "../src/triage";
import { sidebarThread } from "./fixtures";

const DAY = 86_400_000;
const now = 20 * DAY;
const nodes = (...threads: ReturnType<typeof sidebarThread>[]) =>
  buildGroups({ threads, sections: [], layout: EMPTY_LAYOUT }).at(-1)!.roots;

describe("triage", () => {
  it("uses the latest attention or update for activity and only fades quiet, unpinned families past the threshold", () => {
    expect(lastActivity(sidebarThread({ updatedAt: 2, latestAttentionAt: 3 }))).toBe(3);
    expect(lastActivity(sidebarThread({ updatedAt: 4, latestAttentionAt: 3 }))).toBe(4);
    const [idle] = nodes(sidebarThread({ updatedAt: now - 4 * DAY, latestAttentionAt: now - 5 * DAY }));
    expect(isStale(idle!, now, 3)).toBe(true);
    expect(isStale(idle!, now, 0)).toBe(false);
    expect(isStale(idle!, now - DAY, 3)).toBe(false);
    const pinned = buildGroups({ threads: [sidebarThread({ isPinned: true, updatedAt: 1 })],
      sections: [], layout: EMPTY_LAYOUT })[0]!.roots[0]!;
    expect(isStale(pinned, now, 3)).toBe(false);
    expect(isStale(nodes(sidebarThread({ isUnread: true, updatedAt: 1 }))[0]!, now, 3)).toBe(false);
    const [family] = nodes(sidebarThread({ id: "parent", updatedAt: 1 }),
      sidebarThread({ id: "child", parentThreadId: "parent", status: "active" }));
    expect(isStale(family!, now, 3)).toBe(false);
  });

  it("only snoozes quiet families and wakes on activity or urgent descendants", () => {
    const [family] = nodes(sidebarThread({ id: "parent", updatedAt: 1, latestAttentionAt: 1 }),
      sidebarThread({ id: "child", parentThreadId: "parent", isUnread: true, latestAttentionAt: 2 }));
    expect(canSnooze(family!)).toBe(true);
    expect(isSnoozed(family!, { at: 2, until: now + DAY }, now)).toBe(true);
    expect(isSnoozed(family!, { at: 1, until: now + DAY }, now)).toBe(false);
    expect(isSnoozed(family!, { at: 2, until: now }, now)).toBe(false);
    expect(isSnoozed(family!, undefined, now)).toBe(false);
    const [urgent] = nodes(sidebarThread({ id: "parent" }),
      sidebarThread({ id: "child", parentThreadId: "parent", hasPendingInteraction: true }));
    expect(canSnooze(urgent!)).toBe(false);
    expect(isSnoozed(urgent!, { at: now, until: now + DAY }, now)).toBe(false);
  });

  it("uses tomorrow's local hour even across midnight and a month end", () => {
    expect(nextWake(new Date(2025, 0, 31, 23, 59).getTime(), 9)).toBe(new Date(2025, 1, 1, 9).getTime());
    expect(nextWake(new Date(2025, 2, 1, 0, 1).getTime(), 0)).toBe(new Date(2025, 2, 2, 0).getTime());
    const friday = new Date(2025, 0, 31, 11).getTime();
    expect(wakeLabel(nextWake(friday, 9), friday)).toBe("tomorrow 09:00");
    expect(wakeLabel(new Date(2025, 1, 3, 7).getTime(), friday)).toBe("Mon 07:00");
  });

  it("sorts roots by recent activity or family's worst state, stably", () => {
    const roots = nodes(
      sidebarThread({ id: "a", createdAt: 2, updatedAt: 10, latestAttentionAt: 10 }),
      sidebarThread({ id: "b", createdAt: 3, updatedAt: 10, latestAttentionAt: 10 }),
      sidebarThread({ id: "c", createdAt: 1, updatedAt: 20, latestAttentionAt: 20 }),
      sidebarThread({ id: "child", parentThreadId: "a", status: "error" }),
    );
    const ids = (mode: "manual" | "recent" | "status") => sortRoots(roots, mode).map((node) => node.thread.id);
    expect(ids("manual")).toEqual(roots.map((node) => node.thread.id));
    expect(ids("recent")).toEqual(["c", "b", "a"]);
    expect(ids("status")).toEqual(["a", "b", "c"]);
    expect(sortRoots(roots, "manual")).not.toBe(roots);
  });
});
