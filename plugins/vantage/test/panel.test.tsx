import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Overview, rpcContract } from "../src/contract";
import { clearLoadedCache } from "../src/loaded";
import { panelSelection, panelView } from "../src/panel";
import { disposeSessions } from "../src/session";
import { reloadUiState } from "../src/ui-prefs";
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
  reloadUiState();
});

async function mountPanel(rows = 2, tree: Overview | (() => Overview) = TREE, sidebar = SIDEBAR) {
  const app = await loadPluginApp(() => import("../app"));
  const tab = app.tabs.find((entry) => entry.context.kind === "thread")!;
  const slot = renderSlot<{ threadId: string; params: null }, typeof rpcContract>(tab as never, { threadId: "thr_root", params: null }, {
    pluginId: "vantage",
    rpc: {
      shell: () => new Promise<Overview>(() => {}), overview: () => (typeof tree === "function" ? tree() : tree),
      patch: () => ({ patch: "@@ -1 +1 @@\n-a\n+b", truncated: false, binary: false }), fileSides: () => ({ old: null, new: null }),
      recordedEdits: () => ({ edits: [] }), commitFiles: () => ({ files: [] }),
      reviewed: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map((entry) => [entry, {}])), setReviewed: () => ({}),
    } as never,
    sdk: { subscribe: (() => () => {}) as never, terminals: { create: vi.fn() as never } },
    sidebarThreads: { status: "ready", threads: sidebar },
    threadActions: (() => []) as never,
  });
  mounts.push(slot);
  // One chip per worktree with changes, then All changes.
  if (rows > 0) await waitFor(() => expect(slot.container.querySelectorAll("[data-worktree-strip] button[aria-pressed]")).toHaveLength(rows + 1));
  return { slot };
}

const strip = (slot: Slot) => slot.container.querySelector("[data-worktree-strip]") as HTMLElement;
const chip = (slot: Slot, name: RegExp | string) => within(strip(slot)).getByRole("button", { name });

describe("the thread's Vantage tab", () => {
  it("opens on this thread's own worktree, with one chip per worktree and All changes, and no switches", async () => {
    const { slot } = await mountPanel();
    const view = within(slot.container);
    const tabs = [...strip(slot).querySelectorAll("button[aria-pressed]")].map((entry) => entry.textContent ?? "");
    expect(tabs[0]).toMatch(/^This thread/);
    expect(tabs[1]).toMatch(/^Worker/);
    expect(tabs[2]).toBe("All changes");
    expect(chip(slot, /^This thread/).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(slot.container.querySelector(`[data-review='${OWN.key}']`)).not.toBeNull());
    expect(view.getByRole("button", { name: /This thread's work/ })).toBeTruthy();
    expect(view.queryByRole("button", { name: /Watch/ })).toBeNull();
    expect(view.queryByRole("button", { name: /Track reviews/ })).toBeNull();
  });

  it("opens on the child worktree that most needs a person when the thread's own has no changes", async () => {
    const { slot } = await mountPanel(1, overview({ ...TREE, worktrees: [{ ...OWN, uncommitted: [] }, CHILD] }));
    await waitFor(() => expect(slot.container.querySelector(`[data-review='${CHILD.key}']`)).not.toBeNull());
    expect(chip(slot, /^Worker/).getAttribute("aria-pressed")).toBe("true");
  });

  it("switches to a child worktree from the strip, then to its agent's chat and back", async () => {
    const { slot } = await mountPanel();
    const view = within(slot.container);
    fireEvent.click(chip(slot, /^Worker/));
    await waitFor(() => expect(slot.container.querySelector("[data-panel-drill] [data-file-card='src/a.ts']")).not.toBeNull());
    expect(view.getAllByRole("button", { name: "Answer" }).length).toBeGreaterThan(0);
    expect(view.getByRole("button", { name: /Its work/ })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Chat" }));
    expect(slot.container.querySelector("[data-panel-drill]")).toBeNull();
    fireEvent.click(chip(slot, /^Worker/));
    expect(slot.container.querySelector("[data-panel-drill]")).not.toBeNull();
  });

  it("moves worktrees past the fourth into a menu, and keeps a picked one in sight", async () => {
    const extra = ["c", "d", "e", "f"].map((id) => worktree({ key: `host_1:/work/${id}`, threadIds: [`thr_${id}`], root: `/work/${id}`, uncommitted: [fileChange({ path: `${id}.ts` })] }));
    const many = overview({
      ...TREE, worktrees: [OWN, CHILD, ...extra],
      threads: [...TREE.threads, ...["c", "d", "e", "f"].map((id) => threadSummary({ id: `thr_${id}`, title: id.toUpperCase(), parentThreadId: "thr_root", rootThreadId: "thr_root", depth: 1 }))],
    });
    const { slot } = await mountPanel(4, many);
    const view = within(slot.container);
    fireEvent.click(view.getByRole("button", { name: /2 more/ }));
    fireEvent.click(view.getByRole("menuitem", { name: /^F/ }));
    await waitFor(() => expect(slot.container.querySelector("[data-review='host_1:/work/f']")).not.toBeNull());
    expect(chip(slot, /^F/).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps as many chips as fit beside the menu and All changes, and moves the rest into the menu", async () => {
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([{ contentRect: { width: 450 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      const extra = ["c", "d"].map((id) => worktree({ key: `host_1:/work/${id}`, threadIds: [`thr_${id}`], root: `/work/${id}`, uncommitted: [fileChange({ path: `${id}.ts` })] }));
      const many = overview({ ...TREE, worktrees: [OWN, CHILD, ...extra],
        threads: [...TREE.threads, ...["c", "d"].map((id) => threadSummary({ id: `thr_${id}`, title: id.toUpperCase(), parentThreadId: "thr_root", rootThreadId: "thr_root", depth: 1 }))] });
      // 450px less 190 for the menu and All changes leaves room for two 120px chips.
      const { slot } = await mountPanel(2, many);
      expect(within(strip(slot)).getByRole("button", { name: /2 more/ })).toBeTruthy();
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it("collapses and expands every diff of a worktree from the tab's narrow bar", async () => {
    const { slot } = await mountPanel();
    const view = within(slot.container);
    fireEvent.click(chip(slot, /^Worker/));
    await waitFor(() => expect(view.getByRole("button", { name: "Hide src/a.ts" })).toBeTruthy());
    const collapse = view.getByRole("button", { name: "Collapse all diffs" });
    expect(collapse.textContent).toBe("");
    fireEvent.click(collapse);
    expect(view.getByRole("button", { name: "Show src/a.ts" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Expand all diffs" }));
    expect(view.getByRole("button", { name: "Hide src/a.ts" })).toBeTruthy();
  });

  it("wraps long lines from the tab's narrow bar and in All changes", async () => {
    const { slot } = await mountPanel();
    const view = within(slot.container);
    fireEvent.click(chip(slot, /^Worker/));
    await waitFor(() => expect(slot.container.querySelector("[data-testid='bb-diff']")?.getAttribute("data-overflow")).toBe("scroll"));
    fireEvent.click(view.getByRole("button", { name: "Wrap long lines" }));
    expect(slot.container.querySelector("[data-testid='bb-diff']")?.getAttribute("data-overflow")).toBe("wrap");
    fireEvent.click(chip(slot, "All changes"));
    await waitFor(() => expect(slot.container.querySelector("[data-all-changes] [data-testid='bb-diff']")?.getAttribute("data-overflow")).toBe("wrap"));
    expect(view.getByRole("button", { name: "Wrap long lines" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows every change of the tree in All changes", async () => {
    const { slot } = await mountPanel();
    fireEvent.click(chip(slot, "All changes"));
    await waitFor(() => expect(slot.container.querySelector("[data-all-changes] [data-file-card='src/a.ts']")).not.toBeNull());
    expect(chip(slot, "All changes").getAttribute("aria-pressed")).toBe("true");
  });

  it("opens the worktree the composer segment asked for before the tab was open", async () => {
    panelSelection.set({ threadId: "thr_root", key: CHILD.key, at: 1 });
    const { slot } = await mountPanel(0);
    await waitFor(() => expect(slot.container.querySelector(`[data-review='${CHILD.key}']`)).not.toBeNull());
    expect(panelSelection.get()).toBeNull();
  });

  it("keeps the worktree it opened on when a more urgent one appears, so its chat does not swap", async () => {
    // Late waits on you too and shares a file with Side, so it sorts before Worker.
    const LATE = worktree({ key: "host_1:/work/late", threadIds: ["thr_late"], root: "/work/late", uncommitted: [fileChange({ path: "z.ts" })] });
    const SIDE = worktree({ key: "host_1:/work/side", threadIds: ["thr_side"], root: "/work/side", uncommitted: [fileChange({ path: "z.ts" })] });
    const first = overview({ ...TREE, worktrees: [{ ...OWN, uncommitted: [] }, CHILD] });
    const second = overview({
      ...first, worktrees: [...first.worktrees, LATE, SIDE],
      threads: [...TREE.threads, ...["late", "side"].map((id) => threadSummary({ id: `thr_${id}`, title: id, parentThreadId: "thr_root", rootThreadId: "thr_root", depth: 1 }))],
      sharedFiles: [{ projectId: "proj_1", path: "z.ts", worktreeKeys: [LATE.key, SIDE.key] }],
    });
    let calls = 0;
    const { slot } = await mountPanel(1, () => (calls++ === 0 ? first : second),
      [...SIDEBAR, sidebarThread({ id: "thr_late", displayTitle: "Late", parentThreadId: "thr_root", indicator: "waiting-for-input" })]);
    await waitFor(() => expect(slot.container.querySelector(`[data-review='${CHILD.key}']`)).not.toBeNull());
    fireEvent.click(within(slot.container).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(chip(slot, /^Late/)).toBeTruthy());
    expect(chip(slot, /^Worker/).getAttribute("aria-pressed")).toBe("true");
    expect(slot.container.querySelector(`[data-review='${CHILD.key}']`)).not.toBeNull();
  });

  it("opens the worktree another surface asked for", async () => {
    const { slot } = await mountPanel();
    panelSelection.set({ threadId: "thr_root", key: CHILD.key, at: 1 });
    await waitFor(() => expect(slot.container.querySelector(`[data-review='${CHILD.key}']`)).not.toBeNull());
  });
});
