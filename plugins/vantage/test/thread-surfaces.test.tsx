import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Overview, rpcContract } from "../src/contract";
import { panelSelection } from "../src/panel";
import { disposeSessions } from "../src/session";
import { RowLineItem, rowLines } from "../src/thread-surfaces";
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

function options(tree: Overview = TREE) {
  return {
    pluginId: "vantage",
    rpc: {
      shell: () => new Promise<Overview>(() => {}), overview: () => tree,
      reviewed: () => ({}), setReviewed: () => ({}),
    } as never,
    sdk: { subscribe: (() => () => {}) as never },
    sidebarThreads: { status: "ready" as const, threads: SIDEBAR },
    experimental_panel: { openTab: () => true },
  };
}

describe("the composer segment", () => {
  it("keeps its numbers and lets its words take only the row's spare room", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const segment = app.threadContextSegments[0]!;
    const onToggle = vi.fn();
    const slot = renderSlot<object, typeof rpcContract>({ component: segment.summary } as never, { ...PROPS, segments: [], isExpanded: false, onToggle }, options());
    const button = await within(slot.container).findByRole("button", { name: "Vantage: 2 child worktrees · 1 waiting on you · 1 shared file" });
    expect(button.className).toContain("min-w-min");
    expect(button.className).toContain("flex-1");
    const words = [...button.querySelectorAll("[data-promptbox-hide-compact]")].map((entry) => entry.textContent);
    expect(words).toEqual(["child worktrees", "waiting on you", "shared file"]);
    // With the words hidden, what is left is the icons and "2", "1" and "1".
    const kept = [...button.querySelectorAll(":scope > span.shrink-0")].map((entry) => entry.textContent).filter((text) => text !== "");
    expect(kept).toEqual(["2", "1", "1"]);
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
    slot.lifecycle.unmount();
  });

  it("shows a thread's own changes first, for a thread with no child threads too", async () => {
    const alone = overview({
      threadId: "thr_root", target: { kind: "tree", threadId: "thr_root" }, threads: [threadSummary({ id: "thr_root" })],
      worktrees: [worktree({ key: "w_root", threadIds: ["thr_root"], uncommitted: [fileChange({ path: "a.ts", additions: 1200, deletions: 39 }), fileChange({ path: "b.ts", additions: 4, deletions: 0 })] })],
      sharedFiles: [],
    });
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot<object, typeof rpcContract>({ component: app.threadContextSegments[0]!.summary } as never,
      { ...PROPS, segments: [], isExpanded: false, onToggle: vi.fn() }, options(alone));
    const button = await within(slot.container).findByRole("button", { name: "Vantage: this thread +1204 −39" });
    expect(button.querySelector("[data-own]")?.textContent).toBe("+1.2k −39");
    expect([...button.querySelectorAll("[data-promptbox-hide-compact]")].map((entry) => entry.textContent)).toEqual(["2 files"]);
    slot.lifecycle.unmount();
  });

  it("shows above the composer whenever the thread or a child changed something, with bb's card on or off", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const useVisible = app.threadContextSegments[0]!.useVisible!;
    function Probe() {
      return <span data-visible={String(useVisible({ threadId: "thr_root", projectId: "proj_1", environment: null } as never))} />;
    }
    const visible = (slot: ReturnType<typeof renderSlot>) => slot.container.querySelector("[data-visible]")?.getAttribute("data-visible");
    for (const threadContextKind of ["banner", "card"] as const) {
      const slot = renderSlot<object, typeof rpcContract>({ component: Probe } as never, {}, { ...options(), threadContextKind });
      await waitFor(() => expect(visible(slot)).toBe("true"));
      slot.lifecycle.unmount();
    }
    disposeSessions();
    const empty = renderSlot<object, typeof rpcContract>({ component: Probe } as never, {}, options(overview({ ...TREE, worktrees: [], sharedFiles: [] })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(visible(empty)).toBe("false");
    empty.lifecycle.unmount();
  });

  it("draws nothing below the row while folded", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot<object, typeof rpcContract>({ component: app.threadContextSegments[0]!.details! } as never,
      { ...PROPS, segments: [], isExpanded: false, onToggle: vi.fn() }, options());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.container.querySelector("[data-vantage-segment-details]")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("lists at most three lines when expanded, waiting first, and opens a worktree in the thread's tab", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot<object, typeof rpcContract>({ component: app.threadContextSegments[0]!.details! } as never,
      { ...PROPS, segments: [], isExpanded: true, onToggle: vi.fn() }, options());
    const row = await within(slot.container).findByRole("button", { name: /^Pricing/ });
    const lines = within(slot.container).getAllByRole("button").map((button) => button.textContent ?? "");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^Banner · Asked you a question/);
    // A glyph that draws nothing still leaves its cell, so the title stays in the wide column.
    expect(row.firstElementChild?.className).toContain("size-4");
    expect(lines[2]).toMatch(/^1 file changed in more than one worktree/);
    fireEvent.click(row);
    expect(panelSelection.get()).toMatchObject({ threadId: "thr_root", key: "w_b" });
    expect(slot.inspection.experimental_panelCalls).toContainEqual({ method: "openTab", options: { tab: { id: "changes", context: { kind: "thread" }, availability: "action" } } });
    fireEvent.click(within(slot.container).getByRole("button", { name: /changed in more than one worktree/ }));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", options: { subPath: "tree/thr_root/overlaps" } });
    slot.lifecycle.unmount();
  });

  it("offers the rest of the worktrees in the tab when there are more than fit", async () => {
    const many = overview({
      ...TREE,
      worktrees: ["c", "d", "e", "f"].map((id) => worktree({ key: `w_${id}`, threadIds: [`thr_${id}`], uncommitted: [fileChange({ path: `${id}.ts` })] })),
      threads: [threadSummary({ id: "thr_root" }), ...["c", "d", "e", "f"].map((id) => threadSummary({ id: `thr_${id}`, parentThreadId: "thr_root", rootThreadId: "thr_root" }))],
      sharedFiles: [],
    });
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot<object, typeof rpcContract>({ component: app.threadContextSegments[0]!.details! } as never,
      { ...PROPS, segments: [], isExpanded: true, onToggle: vi.fn() },
      { ...options(many), sidebarThreads: { status: "ready" as const, threads: [SIDEBAR[0]!, ...["c", "d", "e", "f"].map((id) => sidebarThread({ id: `thr_${id}`, displayTitle: id.toUpperCase(), parentThreadId: "thr_root" }))] } });
    const more = await within(slot.container).findByRole("button", { name: /1 more worktree/ });
    expect(within(slot.container).getAllByRole("button")).toHaveLength(4);
    fireEvent.click(more);
    expect(slot.inspection.experimental_panelCalls).toHaveLength(1);
    slot.lifecycle.unmount();
  });
});

describe("the thread context card", () => {
  it("lists the child worktrees and the shared files beside bb's own rows", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot<object, typeof rpcContract>(app.threadContextCardSections[0]! as never, PROPS, { ...options(), threadContextKind: "card" as const });
    await waitFor(() => expect(slot.container.textContent).toContain("Banner"));
    expect(slot.container.textContent).toContain("Pricing");
    expect(slot.container.textContent).toContain("1 shared file");
    fireEvent.click(within(slot.container).getByRole("button", { name: /Pricing/ }));
    expect(panelSelection.get()).toMatchObject({ key: "w_b" });
    slot.lifecycle.unmount();
  });

  it("renders nothing, so bb leaves the section out, while no child worktree has changes", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const empty = overview({ ...TREE, worktrees: [], sharedFiles: [] });
    const slot = renderSlot<object, typeof rpcContract>(app.threadContextCardSections[0]! as never, PROPS,
      options(empty));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.container.textContent).toBe("");
    slot.lifecycle.unmount();
  });
});

describe("the sidebar row line", () => {
  it("adds up a thread's worktrees when it owns more than one", () => {
    const two = overview({ worktrees: [
      worktree({ key: "w_a", threadIds: ["thr_x"], uncommitted: [fileChange({ path: "a.ts", additions: 2, deletions: 1 })] }),
      worktree({ key: "w_b", threadIds: ["thr_x"], uncommitted: [fileChange({ path: "b.ts", additions: 3, deletions: 0 })] }),
    ] });
    expect([...rowLines(two)]).toEqual([["thr_x", { additions: 5, deletions: 1, shared: 0 }]]);
  });

  it("gives each worktree's numbers to its own thread only, and nothing to a thread with none", () => {
    const shared = overview({
      worktrees: [
        worktree({ key: "w_1", threadIds: ["thr_parent", "thr_reviewer"], uncommitted: [fileChange({ path: "a.ts", additions: 7, deletions: 2 })] }),
        worktree({ key: "w_2", threadIds: ["thr_child"], uncommitted: [fileChange({ path: "a.ts", additions: 1, deletions: 0 })] }),
        worktree({ key: "w_3", threadIds: ["thr_idle"] }),
      ],
      sharedFiles: [sharedFile({ path: "a.ts", worktreeKeys: ["w_1", "w_2"] })],
    });
    const lines = rowLines(shared);
    expect([...lines]).toEqual([["thr_parent", { additions: 7, deletions: 2, shared: 1 }], ["thr_child", { additions: 1, deletions: 0, shared: 1 }]]);
    expect(rowLines(overview({ ...shared, partial: true })).size).toBe(0);
  });

  it("draws the counts with a tooltip in words", () => {
    const view = render(<RowLineItem thread={sidebarThread({ id: "thr_parent" })} data={new Map([["thr_parent", { additions: 12_400, deletions: 1630, shared: 2 }]])} />);
    const line = view.container.firstElementChild!;
    expect(line.textContent).toBe("+12k−1.6k2");
    expect(line.getAttribute("title")).toBe("+12400 −1630 in its worktree, 2 files also changed in another worktree");
    expect(render(<RowLineItem thread={sidebarThread({ id: "thr_other" })} data={new Map()} />).container.textContent).toBe("");
  });
});

describe("the Info section", () => {
  it("summarises the child worktrees as counts instead of a second copy of the list", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot<object, typeof rpcContract>(app.threadInfoSections[0]! as never, PROPS, options());
    await waitFor(() => expect(slot.container.textContent).toContain("Waiting on you1"));
    expect(slot.container.textContent).toContain("Ready to review1");
    expect(slot.container.textContent).toContain("Shared files1");
    expect(slot.container.textContent).toContain("1 waiting on you");
    slot.lifecycle.unmount();
  });
});
