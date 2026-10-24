import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Overview, Prefs, rpcContract } from "../src/contract";
import { clearLoadedCache } from "../src/loaded";
import { panelSelection, panelView } from "../src/panel";
import { disposeSessions } from "../src/session";
import { fileChange, overview, sidebarThread, threadSummary, worktree } from "./fixtures";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const OWN = worktree({ key: "host_1:/work/root", threadIds: ["thr_root"], root: "/work/root", uncommitted: [fileChange({ path: "notes.md" })] });
const CHILD = worktree({
  key: "host_1:/work/child", threadIds: ["thr_child"], root: "/work/child", branch: "bb/child",
  ref: { kind: "workspace", environmentId: "env_child", base: "origin/main" }, uncommitted: [fileChange({ path: "src/a.ts" })],
});
const SIDEBAR = [
  sidebarThread({ id: "thr_root", displayTitle: "Parent" }),
  sidebarThread({ id: "thr_child", displayTitle: "Worker", parentThreadId: "thr_root", indicator: "waiting-for-input", indicatorLabel: "Thread needs user input" }),
];
const TREE = overview({
  threadId: "thr_root", target: { kind: "tree", threadId: "thr_root" },
  threads: [threadSummary({ id: "thr_root", title: "Parent" }), threadSummary({ id: "thr_child", title: "Worker", parentThreadId: "thr_root", rootThreadId: "thr_root", depth: 1 })],
  worktrees: [OWN, CHILD],
  repos: [{
    key: "repo_child", ref: CHILD.ref, label: "Project", projectId: "proj_1", root: "/work/child", hostId: "host_1", hostName: "Laptop", branch: "bb/child",
    base: null, aheadCount: null, threadIds: ["thr_child"], state: "ready", message: null, files: [fileChange({ path: "src/a.ts" })], otherFiles: [],
    truncated: false, totals: { files: 1, additions: 2, deletions: 1 }, threadCommits: [],
  }],
});

type Slot = ReturnType<typeof renderSlot>;
const mounts: Slot[] = [];
afterEach(() => {
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  disposeSessions();
  clearLoadedCache();
  panelView.set("worktrees");
  panelSelection.set(null);
  document.body.replaceChildren();
  window.localStorage.clear();
});

async function mountPanel(prefs: Partial<Prefs> = {}, rows = 2) {
  const app = await loadPluginApp(() => import("../app"));
  const tab = app.tabs.find((entry) => entry.context.kind === "thread")!;
  const setThreadPref = vi.fn(async () => ({ watchByDefault: false, reviewsByDefault: false, threads: {} }));
  const slot = renderSlot<{ threadId: string; params: null }, typeof rpcContract>(tab as never, { threadId: "thr_root", params: null }, {
    pluginId: "vantage",
    rpc: {
      shell: () => new Promise<Overview>(() => {}), overview: () => TREE,
      patch: () => ({ patch: "@@ -1 +1 @@\n-a\n+b", truncated: false, binary: false }), fileSides: () => ({ old: null, new: null }),
      recordedEdits: () => ({ edits: [] }), commitFiles: () => ({ files: [] }),
      prefs: () => ({ watchByDefault: false, reviewsByDefault: false, threads: {}, ...prefs }), setThreadPref,
      reviewed: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map((entry) => [entry, {}])), setReviewed: () => ({}),
    } as never,
    sdk: { subscribe: (() => () => {}) as never, terminals: { create: vi.fn() as never } },
    sidebarThreads: { status: "ready", threads: SIDEBAR },
    threadActions: (() => []) as never,
  });
  mounts.push(slot);
  if (rows > 0) await waitFor(() => expect(slot.container.querySelectorAll("[data-worktree-row]")).toHaveLength(rows));
  return { slot, setThreadPref };
}

describe("the thread's Vantage tab", () => {
  it("lists this thread's own checkout and its child's worktree, without saying the child waits while unwatched", async () => {
    const { slot } = await mountPanel();
    expect(within(slot.container).getByText("This thread")).toBeTruthy();
    expect(slot.container.querySelector("[data-worktree-group='Needs you']")).toBeNull();
  });

  it("watches this thread's tree from its header", async () => {
    const { slot, setThreadPref } = await mountPanel();
    fireEvent.click(within(slot.container).getByRole("button", { name: /^Watch$/ }));
    await waitFor(() => expect(setThreadPref).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thr_root", watch: true })));
  });

  it("opens a worktree in place, steps back, and switches to its agent's chat", async () => {
    const { slot } = await mountPanel({ watchByDefault: true });
    const view = within(slot.container);
    fireEvent.click(slot.container.querySelector(`[data-worktree-row='${CHILD.key}']`)!);
    await waitFor(() => expect(slot.container.querySelector("[data-panel-drill] [data-file-card='src/a.ts']")).not.toBeNull());
    expect(view.getAllByRole("button", { name: "Answer" }).length).toBeGreaterThan(0);
    fireEvent.click(view.getByRole("button", { name: "Chat" }));
    expect(slot.container.querySelector("[data-panel-drill]")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: /All worktrees/ }));
    expect(slot.container.querySelectorAll("[data-worktree-row]")).toHaveLength(2);
  });

  it("collapses and expands every diff of a worktree from the tab's narrow bar", async () => {
    const { slot } = await mountPanel();
    const view = within(slot.container);
    fireEvent.click(slot.container.querySelector(`[data-worktree-row='${CHILD.key}']`)!);
    await waitFor(() => expect(view.getByRole("button", { name: "Hide src/a.ts" })).toBeTruthy());
    const collapse = view.getByRole("button", { name: "Collapse all diffs" });
    expect(collapse.textContent).toBe("");
    fireEvent.click(collapse);
    expect(view.getByRole("button", { name: "Show src/a.ts" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Expand all diffs" }));
    expect(view.getByRole("button", { name: "Hide src/a.ts" })).toBeTruthy();
  });

  it("shows every change of the tree in All changes", async () => {
    const { slot } = await mountPanel();
    fireEvent.click(within(slot.container).getByRole("button", { name: "All changes" }));
    await waitFor(() => expect(slot.container.querySelector("[data-all-changes] [data-file-card='src/a.ts']")).not.toBeNull());
  });

  it("opens the worktree the composer segment asked for before the tab was open", async () => {
    panelSelection.set({ threadId: "thr_root", key: CHILD.key, at: 1 });
    const { slot } = await mountPanel({}, 0);
    await waitFor(() => expect(slot.container.querySelector(`[data-review='${CHILD.key}']`)).not.toBeNull());
    expect(panelSelection.get()).toBeNull();
  });

  it("opens the worktree another surface asked for", async () => {
    const { slot } = await mountPanel();
    panelSelection.set({ threadId: "thr_root", key: CHILD.key, at: 1 });
    await waitFor(() => expect(slot.container.querySelector(`[data-review='${CHILD.key}']`)).not.toBeNull());
  });
});
