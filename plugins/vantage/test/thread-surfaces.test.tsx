import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Overview, rpcContract } from "../src/contract";
import { panelSelection } from "../src/panel";
import { disposeSessions } from "../src/session";
import { fileChange, overview, sharedFile, sidebarThread, threadSummary, worktree } from "./fixtures";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const A = worktree({ key: "w_a", threadIds: ["thr_a"], uncommitted: [fileChange({ path: "README.md" })] });
const B = worktree({ key: "w_b", threadIds: ["thr_b"], committed: [fileChange({ path: "README.md" })] });
const TREE = overview({
  threadId: "thr_root", target: { kind: "tree", threadId: "thr_root" },
  threads: [threadSummary({ id: "thr_root" }), threadSummary({ id: "thr_a", parentThreadId: "thr_root", rootThreadId: "thr_root" }), threadSummary({ id: "thr_b", parentThreadId: "thr_root", rootThreadId: "thr_root" })],
  worktrees: [A, B],
  sharedFiles: [sharedFile({ path: "README.md", worktreeKeys: ["w_a", "w_b"] })],
});
const SIDEBAR = [
  sidebarThread({ id: "thr_root", displayTitle: "Parent" }),
  sidebarThread({ id: "thr_a", displayTitle: "Banner", parentThreadId: "thr_root", indicator: "waiting-for-input" }),
  sidebarThread({ id: "thr_b", displayTitle: "Pricing", parentThreadId: "thr_root" }),
];
const PROPS = { threadId: "thr_root", projectId: "proj_1", environment: null };

afterEach(() => {
  disposeSessions();
  panelSelection.set(null);
  document.body.replaceChildren();
});

function options() {
  return {
    pluginId: "vantage",
    rpc: {
      shell: () => new Promise<Overview>(() => {}), overview: () => TREE,
      reviewed: () => ({}), setReviewed: () => ({}),
    } as never,
    sdk: { subscribe: (() => () => {}) as never },
    sidebarThreads: { status: "ready" as const, threads: SIDEBAR },
    openThreadPanel: () => true,
  };
}

describe("the composer segment", () => {
  it("sums up the child worktrees in one line and leaves showing them to the host's toggle", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const segment = app.threadContextSegments[0]!;
    const onToggle = vi.fn();
    const slot = renderSlot<object, typeof rpcContract>({ component: segment.summary } as never, { ...PROPS, segments: [], isExpanded: false, onToggle }, options());
    const button = await within(slot.container).findByRole("button", { expanded: false });
    await waitFor(() => expect(button.textContent).toBe("2 worktrees · 1 needs you · 2 overlaps"));
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
    slot.lifecycle.unmount();
  });

  it("draws nothing below the row while folded", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot<object, typeof rpcContract>({ component: app.threadContextSegments[0]!.details! } as never,
      { ...PROPS, segments: [], isExpanded: false, onToggle: vi.fn() }, options());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.container.querySelector("[data-vantage-segment-details]")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("lists the worktrees when expanded and opens one in the thread's tab", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot<object, typeof rpcContract>({ component: app.threadContextSegments[0]!.details! } as never,
      { ...PROPS, segments: [], isExpanded: true, onToggle: vi.fn() }, options());
    const row = await within(slot.container).findByRole("button", { name: /^Pricing/ });
    fireEvent.click(row);
    expect(panelSelection.get()).toMatchObject({ threadId: "thr_root", key: "w_b" });
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "openThreadPanel", options: { actionId: "changes" } });
    slot.lifecycle.unmount();
  });
});

describe("the Info section", () => {
  it("lists the child worktrees with why each one matters", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot<object, typeof rpcContract>(app.threadInfoSections[0]! as never, PROPS, options());
    await waitFor(() => expect(slot.container.textContent).toContain("Banner"));
    expect(slot.container.textContent).toContain("BannerNeeds you");
    expect(slot.container.textContent).toContain("Overlaps with Banner in README.md");
    slot.lifecycle.unmount();
  });
});
