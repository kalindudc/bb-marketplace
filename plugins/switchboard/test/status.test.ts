import { describe, expect, it } from "vitest";
import { countStates, rowState, worstState } from "../src/status";
import { sidebarThread } from "./fixtures";

describe("thread status", () => {
  it("prioritizes failure over interaction, running and unread", () => {
    expect(rowState(sidebarThread({ status: "error", hasPendingInteraction: true, isUnread: true }))).toBe("failed");
    expect(rowState(sidebarThread({ queuedWork: "failed" }))).toBe("failed");
    for (const indicator of ["unread-error", "queued-failed"] as const) {
      expect(rowState(sidebarThread({ indicator }))).toBe("failed");
    }
  });

  it("detects needs-you before running", () => {
    expect(rowState(sidebarThread({ hasPendingInteraction: true, status: "active" }))).toBe("needs");
    expect(rowState(sidebarThread({ indicator: "waiting-for-input" }))).toBe("needs");
  });

  it("recognizes all live sources without mistaking unknowns for running", () => {
    for (const status of ["starting", "active", "stopping"] as const)
      expect(rowState(sidebarThread({ status }))).toBe("running");
    for (const runtimeStatus of ["provisioning", "waiting-for-host"] as const)
      expect(rowState(sidebarThread({ runtimeStatus }))).toBe("running");
    for (const activity of ["workflows", "backgroundAgents", "backgroundCommands", "planMode", "goals"] as const)
      expect(rowState(sidebarThread({ activity: { ...sidebarThread().activity, [activity]: 1 } }))).toBe("running");
    for (const indicator of ["runtime", "background-agent", "background-command", "workflow", "goal", "plan-mode", "queued-waiting"] as const)
      expect(rowState(sidebarThread({ indicator }))).toBe("running");
    expect(rowState(sidebarThread({ status: "unknown" as never, indicator: "unknown" as never }))).toBe("idle");
  });

  it("uses unread then idle, and computes ranked rollups", () => {
    expect(rowState(sidebarThread({ isUnread: true }))).toBe("unread");
    expect(rowState(sidebarThread())).toBe("idle");
    expect(worstState(["idle", "running", "failed", "needs"])).toBe("failed");
    expect(worstState([])).toBe("idle");
    expect(countStates(["failed", "failed", "needs", "running", "unread", "idle"])).toEqual({
      failed: 2, needs: 1, running: 1, unread: 1,
    });
  });
});
