import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Overview, RecordedEditsOutput, rpcContract } from "../src/contract";
import { clearLoadedCache } from "../src/loaded";
import { panelSelection } from "../src/panel";
import { parseRoute } from "../src/route";
import { disposeSessions } from "../src/session";
import { diffView, reloadUiState } from "../src/ui-prefs";
import { fileChange, overview, sidebarThread, threadSummary, worktree } from "./fixtures";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const OWN = worktree({
  key: "host_1:/work/root",
  threadIds: ["thr_root"],
  root: "/work/root",
  uncommitted: [fileChange({ path: "notes.md" })],
});
const CHILD = worktree({
  key: "host_1:/work/child",
  threadIds: ["thr_child"],
  root: "/work/child",
  branch: "bb/child",
  ref: { kind: "workspace", environmentId: "env_child", base: "origin/main" },
  uncommitted: [fileChange({ path: "src/a.ts" })],
});
const SIDEBAR = [
  sidebarThread({ id: "thr_root", displayTitle: "Parent" }),
  sidebarThread({
    id: "thr_child",
    displayTitle: "Worker",
    parentThreadId: "thr_root",
    indicator: "waiting-for-input",
    indicatorLabel: "Thread needs user input",
  }),
];
const TREE = overview({
  threadId: "thr_root",
  target: { kind: "tree", threadId: "thr_root" },
  threads: [
    threadSummary({ id: "thr_root", title: "Parent" }),
    threadSummary({ id: "thr_child", title: "Worker", parentThreadId: "thr_root", rootThreadId: "thr_root", depth: 1 }),
  ],
  worktrees: [OWN, CHILD],
  repos: [
    {
      key: "repo_child",
      ref: CHILD.ref,
      label: "Project",
      projectId: "proj_1",
      root: "/work/child",
      hostId: "host_1",
      hostName: "Laptop",
      branch: "bb/child",
      base: null,
      aheadCount: null,
      threadIds: ["thr_child"],
      state: "ready",
      message: null,
      files: [fileChange({ path: "src/a.ts" })],
      otherFiles: [],
      truncated: false,
      totals: { files: 1, additions: 2, deletions: 1 },
      threadCommits: [],
    },
  ],
});

type Slot = ReturnType<typeof renderSlot>;
const mounts: Slot[] = [];
afterEach(() => {
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  disposeSessions();
  clearLoadedCache();
  panelSelection.set(null);
  document.body.replaceChildren();
  window.localStorage.clear();
  reloadUiState();
});

async function mountPanel(
  rows = 2,
  tree: Overview | (() => Overview) = TREE,
  sidebar = SIDEBAR,
  threadId = "thr_root",
  recordedEdits: () => RecordedEditsOutput = () => ({ edits: [] }),
) {
  const app = await loadPluginApp(() => import("../app"));
  const tab = app.tabs.find((entry) => entry.context.kind === "thread")!;
  const slot = renderSlot<{ threadId: string; params: null }, typeof rpcContract>(
    tab as never,
    { threadId, params: null },
    {
      pluginId: "vantage",
      rpc: {
        shell: () => new Promise<Overview>(() => {}),
        overview: () => (typeof tree === "function" ? tree() : tree),
        patch: () => ({ patch: "@@ -1 +1 @@\n-a\n+b", truncated: false, binary: false }),
        fileSides: () => ({ old: null, new: null }),
        image: () => ({ old: null, new: null, truncated: false }),
        recordedEdits,
        commitFiles: () => ({ files: [] }),
        reviewed: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map((entry) => [entry, {}])),
        setReviewed: () => ({}),
      } as never,
      sdk: { subscribe: (() => () => {}) as never, terminals: { create: vi.fn() as never } },
      sidebarThreads: { status: "ready", threads: sidebar },
      threadActions: (() => []) as never,
    },
  );
  mounts.push(slot);
  if (rows > 0)
    await waitFor(() =>
      expect(slot.container.querySelectorAll("[data-trail-thread]").length).toBeGreaterThanOrEqual(rows),
    );
  return { slot };
}

function leavePanel(slot: Slot) {
  mounts.splice(mounts.indexOf(slot), 1);
  slot.lifecycle.unmount();
  disposeSessions();
  clearLoadedCache();
  reloadUiState();
}

const strip = (slot: Slot) => within(slot.container).getByRole("navigation", { name: "Thread trail" });
const chip = (slot: Slot, name: RegExp | string) =>
  within(name === "All changes" ? slot.container : strip(slot)).getByRole("button", { name });

describe("Trail panel", () => {
  it("keeps source focus and returns from a recorded card to its folded absolute-path folder", async () => {
    const path = "/work/root/src/deep/record.ts";
    const edits = { threadIds: ["thr_root"], rawPaths: [path], count: 1 };
    const { slot } = await mountPanel(1, {
      ...TREE,
      repos: [],
      otherFiles: [
        fileChange({ path: "/other/one.ts", status: "clean", edits }),
        fileChange({ path, status: "renamed", previousPath: "old.ts", edits }),
      ],
    });
    const view = within(slot.container);
    const source = await view.findByRole("button", { name: "Recorded edits" });
    source.focus();
    fireEvent.click(source);
    const active = view.getByRole("button", { name: "Recorded edits" });
    expect(document.activeElement).toBe(active);
    const treeFile = slot.container.querySelector<HTMLButtonElement>(`[data-tree-file="${path}"] button`)!;
    fireEvent.click(treeFile);
    const folder = view.getByRole("button", { name: "work/root/src/deep folder" });
    fireEvent.click(folder);
    const card = slot.container.querySelector<HTMLElement>(`[data-file-card="${path}"]`)!;
    fireEvent.keyDown(within(card).getByRole("button", { name: `Hide ${path}` }), { key: "Escape" });
    expect(document.activeElement).toBe(folder);
    expect(card.querySelector('[title*="Renamed"]')).toBeNull();
    expect(within(card).getByRole("button", { name: "Copy path" })).toBeTruthy();
    expect(view.queryByText("unchanged")).toBeNull();
  });

  it("focuses recorded evidence and keeps focus when switching sources", async () => {
    const path = "/work/root/record.ts";
    const { slot } = await mountPanel(1, {
      ...TREE,
      otherFiles: [
        fileChange({ path, status: "clean", edits: { threadIds: ["thr_root"], rawPaths: [path], count: 1 } }),
      ],
    });
    const view = within(slot.container);
    fireEvent.click(await view.findByRole("button", { name: "Recorded edits" }));
    const stream = slot.container.querySelector<HTMLElement>("[data-diff-stream]")!;
    fireEvent.keyDown(stream, { key: "f" });
    expect(view.getByRole("button", { name: "Exit focus", pressed: true })).toBeTruthy();
    expect(document.activeElement).toBe(stream);
    expect(view.queryByRole("navigation", { name: "Thread trail" })).toBeNull();
    expect(slot.container.querySelector("[data-file-tree]")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Checkout Git" }));
    const exit = await view.findByRole("button", { name: "Exit focus", pressed: true });
    fireEvent.click(exit);
    expect(view.getByRole("navigation", { name: "Thread trail" })).toBeTruthy();
  });

  it("retries recorded events without retrying an archived checkout", async () => {
    const path = "/work/child/records.ts";
    const read = vi
      .fn<() => RecordedEditsOutput>()
      .mockImplementationOnce(() => {
        throw new Error("Events could not be loaded");
      })
      .mockReturnValue({ edits: [] });
    const { slot } = await mountPanel(
      1,
      {
        ...TREE,
        threads: [TREE.threads[0]!, { ...TREE.threads[1]!, archived: true }],
        worktrees: [OWN],
        repos: [],
        otherFiles: [fileChange({ path, edits: { threadIds: ["thr_child"], rawPaths: [path], count: 1 } })],
      },
      SIDEBAR,
      "thr_root",
      read,
    );
    const view = within(slot.container);
    fireEvent.click(await view.findByRole("button", { name: /^Worker/ }));
    const retry = await view.findByRole("button", { name: "Retry recorded edits" });
    expect(view.getByText(/archived and cannot receive review messages/)).toBeTruthy();
    const gitBefore = slot.inspection.rpcCalls.filter(({ method }) => method === "patch").length;
    fireEvent.click(retry);
    expect(await view.findByText(/No diff was recorded/)).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
    expect(slot.inspection.rpcCalls.filter(({ method }) => method === "patch")).toHaveLength(gitBefore);
    expect(view.queryByRole("button", { name: "Terminal" })).toBeNull();
  });

  it("labels shared checkout scope and does not invent zero line counts", async () => {
    const shared = {
      ...OWN,
      threadIds: ["thr_root", "thr_child"],
      uncommitted: [fileChange({ path: "unknown.ts", additions: null, deletions: null })],
    };
    const { slot } = await mountPanel(2, { ...TREE, worktrees: [shared], repos: [] });
    const view = within(slot.container);
    fireEvent.click(chip(slot, /^Worker/));
    const scope = await view.findByRole<HTMLSelectElement>("combobox", { name: "Which changes" });
    expect(scope.selectedOptions[0]!.textContent).toBe("Checkout changes (1)");
    const total = slot.container.querySelector<HTMLElement>("[data-trail-checkout]")!;
    expect(document.getElementById(total.getAttribute("aria-describedby")!)!.textContent).toContain(
      "shared · 2 threads",
    );
    expect(total.textContent).not.toContain("+0");
  });

  it("keeps an archived ancestor and a live shared-checkout grandchild, with only recorded evidence for the ancestor", async () => {
    const edits = { threadIds: ["thr_old", "thr_child"], rawPaths: ["/work/root/src/lib/a.ts"], count: 2 };
    const file = fileChange({ path: "src/lib/a.ts", edits });
    const { slot } = await mountPanel(
      0,
      overview({
        ...TREE,
        threads: [
          TREE.threads[0]!,
          threadSummary({
            id: "thr_old",
            title: "Archived worker",
            archived: true,
            parentThreadId: "thr_root",
            depth: 1,
          }),
          { ...TREE.threads[1]!, parentThreadId: "thr_old", depth: 2 },
        ],
        worktrees: [{ ...OWN, threadIds: ["thr_root", "thr_child"], uncommitted: [file] }],
        repos: [],
        otherFiles: [fileChange({ path: "/work/root/src/lib/a.ts", status: "clean", edits })],
      }),
    );
    const view = within(slot.container);
    const old = await view.findByRole("button", { name: /^Archived worker/ });
    expect(
      slot.container.querySelector('[data-trail-thread="thr_old"] [data-trail-thread="thr_child"]'),
    ).not.toBeNull();
    expect(slot.container.querySelectorAll("[data-trail-checkout]")).toHaveLength(1);
    const priorPatches = slot.inspection.rpcCalls.filter(({ method }) => method === "patch").length;
    fireEvent.click(old);
    expect(await view.findByText(/No diff was recorded/)).toBeTruthy();
    expect(slot.inspection.rpcCalls.filter(({ method }) => method === "patch")).toHaveLength(priorPatches);
    expect(view.queryByRole("button", { name: "Terminal" })).toBeNull();
    expect(view.getByRole("button", { name: "Open thread" })).toBeTruthy();
  });

  it("never requests Git, previews or a terminal for an excluded checkout with recorded-only evidence", async () => {
    const ref = { ...CHILD.ref };
    const file = fileChange({
      path: "src/lib/example.ts",
      status: "clean",
      edits: {
        threadIds: ["thr_child"],
        rawPaths: ["/checkouts/example/src/lib/example.ts"],
        count: 1,
      },
    });
    const { slot } = await mountPanel(
      0,
      overview({
        ...TREE,
        worktrees: [
          {
            ...CHILD,
            ref,
            state: "unavailable",
            message: "Vantage does not run Git here: this checkout is excluded in Vantage's settings",
            uncommitted: [],
          },
        ],
        repos: [{ ...TREE.repos[0]!, ref: { kind: "recorded" }, state: "unavailable", files: [file] }],
      }),
    );
    const view = within(slot.container);
    fireEvent.click(await view.findByRole("button", { name: "Checkout Git not read" }));
    expect(await view.findByText("Vantage does not run Git here: this checkout is excluded in Vantage's settings")).toBeTruthy();
    expect(await view.findByText(/No diff was recorded/)).toBeTruthy();
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    const terminal = view.queryByRole<HTMLButtonElement>("button", { name: "Terminal" });
    expect(terminal === null || terminal.disabled).toBe(true);
    expect(
      slot.inspection.rpcCalls.filter(({ method }) => ["patch", "image", "fileSides", "commitFiles"].includes(method)),
    ).toEqual([]);
    expect(slot.inspection.rpcCalls.filter(({ method }) => method === "recordedEdits")).toMatchObject([
      {
        input: { threadIds: ["thr_child"], rawPaths: ["/checkouts/example/src/lib/example.ts"] },
      },
    ]);
  });

  it("resumes panel A after opening B, with focus mode, a non-default scope, file and hidden tree", async () => {
    const tree = overview({
      ...TREE,
      worktrees: [
        OWN,
        {
          ...CHILD,
          committed: [fileChange({ path: "README.md" }), fileChange({ path: "src/lib/second.ts" })],
        },
      ],
    });
    const a = (await mountPanel(0, tree)).slot;
    const view = within(a.container);
    fireEvent.click(await view.findByRole("button", { name: /^Worker/ }));
    fireEvent.change(await view.findByRole("combobox", { name: "Which changes" }), { target: { value: "committed" } });
    const file = a.container.querySelector<HTMLButtonElement>('[data-tree-file="src/lib/second.ts"] button')!;
    fireEvent.click(file);
    fireEvent.click(view.getByRole("button", { name: "Hide the trail and file tree" }));
    fireEvent.click(view.getByRole("button", { name: "Focus on diffs", pressed: false }));
    leavePanel(a);
    const bTree = overview({
      threadId: "thr_other",
      target: { kind: "tree", threadId: "thr_other" },
      threads: [threadSummary({ id: "thr_other", title: "Other" })],
      worktrees: [{ ...OWN, threadIds: ["thr_other"] }],
    });
    const b = (await mountPanel(1, bTree, [], "thr_other")).slot;
    expect(await within(b.container).findByRole("button", { name: "Focus on diffs", pressed: false })).toBeTruthy();
    leavePanel(b);
    const reopened = (await mountPanel(0, tree)).slot;
    const reopenedView = within(reopened.container);
    const exit = await reopenedView.findByRole("button", { name: "Exit focus", pressed: true });
    expect(reopenedView.queryByRole("navigation", { name: "Thread trail" })).toBeNull();
    fireEvent.click(exit);
    expect(reopenedView.getByRole<HTMLSelectElement>("combobox", { name: "Which changes" }).value).toBe("committed");
    expect(
      reopened.container.querySelector('[data-file-card="src/lib/second.ts"][data-reading-selected]'),
    ).not.toBeNull();
    expect(reopenedView.getByRole("button", { name: "Show the trail and file tree" })).toBeTruthy();
    fireEvent.click(reopenedView.getByRole("button", { name: "Open full screen" }));
    expect(reopened.inspection.navigateCalls.at(-1)).toMatchObject({
      method: "toPluginPanel",
      path: "vantage",
      options: { subPath: expect.stringMatching(/\/review\//) },
    });
    fireEvent.click(reopenedView.getByRole("button", { name: "Open full screen" }));
    const handoffs = reopened.inspection.navigateCalls.flatMap((call) =>
      call.method === "toPluginPanel" && call.options?.subPath !== undefined
        ? [parseRoute(call.options.subPath).route.handoff]
        : [],
    );
    expect(handoffs).toHaveLength(2);
    expect(handoffs[0]).toMatchObject({
      threadId: "thr_child",
      file: "src/lib/second.ts",
      scope: "committed",
      arrival: expect.any(String),
    });
    expect(handoffs[1]?.arrival).not.toBe(handoffs[0]?.arrival);
  });
});

describe("the thread's Vantage tab", () => {
  it("opens on this thread's own checkout, with nested thread rows, All changes, and no switches", async () => {
    const { slot } = await mountPanel();
    const view = within(slot.container);
    const tabs = [...strip(slot).querySelectorAll("button[aria-pressed][data-trail-select]")].map(
      (entry) => entry.textContent ?? "",
    );
    expect(tabs[0]).toMatch(/^This thread/);
    expect(tabs[1]).toMatch(/^Worker/);
    expect(tabs).toHaveLength(2);
    expect(chip(slot, "All changes")).toBeTruthy();
    expect(chip(slot, /^This thread/).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(slot.container.querySelector(`[data-review='${OWN.key}']`)).not.toBeNull());
    expect(view.getByRole("option", { name: /Checkout changes/ })).toBeTruthy();
    expect(view.queryByRole("button", { name: /Watch/ })).toBeNull();
    expect(view.queryByRole("button", { name: /Track reviews/ })).toBeNull();
  });

  it("opens on the child worktree that most needs a person when the thread's own has no changes", async () => {
    const { slot } = await mountPanel(1, overview({ ...TREE, worktrees: [{ ...OWN, uncommitted: [] }, CHILD] }));
    await waitFor(() => expect(slot.container.querySelector(`[data-review='${CHILD.key}']`)).not.toBeNull());
    expect(chip(slot, /^Worker/).getAttribute("aria-pressed")).toBe("true");
  });

  it("switches to a child thread from the Trail, then to its agent's chat and back", async () => {
    const { slot } = await mountPanel();
    const view = within(slot.container);
    fireEvent.click(chip(slot, /^Worker/));
    await waitFor(() =>
      expect(slot.container.querySelector("[data-panel-drill] [data-file-card='src/a.ts']")).not.toBeNull(),
    );
    expect(view.getAllByRole("button", { name: "Answer" }).length).toBeGreaterThan(0);
    expect(view.getByRole("option", { name: /Checkout changes/ })).toBeTruthy();
    const chat = view.getByRole("button", { name: "Chat" });
    chat.focus();
    fireEvent.click(chat);
    expect(slot.container.querySelector("[data-panel-drill]")).toBeNull();
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Chat" }));
    const changes = view.getByRole("button", { name: "Changes" });
    changes.focus();
    fireEvent.click(changes);
    expect(slot.container.querySelector("[data-panel-drill]")).not.toBeNull();
    expect(document.activeElement).toBe(changes);
  });

  it("keeps every worker reachable in a bounded Trail as the tree grows", async () => {
    const ids = ["c", "d", "e", "f"];
    const extra = ids.map((id) =>
      worktree({
        key: `host_1:/work/${id}`,
        threadIds: [`thr_${id}`],
        root: `/work/${id}`,
        uncommitted: [fileChange({ path: `${id}.ts` })],
      }),
    );
    const many = overview({
      ...TREE,
      worktrees: [OWN, CHILD, ...extra],
      threads: [
        ...TREE.threads,
        ...ids.map((id) =>
          threadSummary({
            id: `thr_${id}`,
            title: id.toUpperCase(),
            parentThreadId: "thr_root",
            rootThreadId: "thr_root",
            depth: 1,
          }),
        ),
      ],
    });
    const { slot } = await mountPanel(6, many);
    expect(strip(slot).className).toContain("overflow-y-auto");
    fireEvent.click(chip(slot, "F"));
    expect(slot.container.querySelector("[data-review='host_1:/work/f']")).not.toBeNull();
    expect(chip(slot, "F").getAttribute("aria-pressed")).toBe("true");
  });

  it("folds a branch of the Trail without disturbing its selected checkout", async () => {
    const { slot } = await mountPanel();
    fireEvent.click(chip(slot, /^Worker/));
    const trail = within(strip(slot));
    const toggle = trail.getByRole("button", { name: /^Hide descendants of This thread/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(trail.queryByRole("button", { name: /^Worker/ })).toBeNull();
    expect(slot.container.querySelector(`[data-review='${CHILD.key}']`)).not.toBeNull();
    fireEvent.click(toggle);
    expect(chip(slot, /^Worker/).getAttribute("aria-pressed")).toBe("true");
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

  it("keeps the narrow panel unified outside focus, even when the page reads side by side", async () => {
    diffView.set("split");
    const { slot } = await mountPanel();
    const view = within(slot.container);
    fireEvent.click(chip(slot, /^Worker/));
    const path = "src/a.ts";
    await view.findByRole("button", { name: `Hide ${path}` });
    expect(view.queryByRole("group", { name: "Diff layout" })).toBeNull();
    await waitFor(() => expect(view.getByTestId("bb-diff").getAttribute("data-view")).toBe("unified"));
    fireEvent.click(view.getByRole("button", { name: "Focus on diffs", pressed: false }));
    expect(view.getByRole("group", { name: "Diff layout" })).toBeTruthy();
    await waitFor(() => expect(view.getByTestId("bb-diff").getAttribute("data-view")).toBe("split"));
    diffView.set("unified");
  });

  it("gives diffs the panel while keeping the compact title, controls and folds", async () => {
    const { slot } = await mountPanel();
    const view = within(slot.container);
    fireEvent.click(chip(slot, /^Worker/));
    const folder = await view.findByRole("button", { name: "src folder" });
    fireEvent.click(folder);
    const path = "src/a.ts";
    fireEvent.click(view.getByRole("button", { name: `Hide ${path}` }));
    const focus = view.getByRole("button", { name: "Focus on diffs", pressed: false });
    fireEvent.click(focus);
    const exit = view.getByRole("button", { name: "Exit focus", pressed: true });
    expect(document.activeElement).toBe(exit);
    expect(view.queryByRole("navigation", { name: "Thread trail" })).toBeNull();
    expect(slot.container.querySelector("[data-file-tree]")).toBeNull();
    expect(view.queryByRole("button", { name: "Terminal" })).toBeNull();
    expect(view.queryByText("Thread needs user input.")).toBeNull();
    const summary = within(view.getByRole("heading", { name: "Worker" }).parentElement!);
    expect(summary.getByText("1 file")).toBeTruthy();
    const bar = within(exit.closest<HTMLElement>("[data-review-bar]")!);
    expect(bar.getByRole("group", { name: "Evidence source" })).toBeTruthy();
    expect(bar.getByRole("combobox", { name: "Which changes" })).toBeTruthy();
    expect(bar.getByRole("button", { name: "Wrap long lines" })).toBeTruthy();
    expect(view.getByRole("button", { name: `Show ${path}` })).toBeTruthy();
    fireEvent.click(bar.getByRole("button", { name: "Side by side diff" }));
    fireEvent.click(view.getByRole("button", { name: `Show ${path}` }));
    await waitFor(() => expect(view.getByTestId("bb-diff").getAttribute("data-view")).toBe("split"));
    fireEvent.click(bar.getByRole("button", { name: "Collapse all diffs" }));
    expect(view.getByRole("button", { name: `Show ${path}` })).toBeTruthy();
    fireEvent.click(exit);
    expect(view.getByRole("button", { name: "Focus on diffs", pressed: false })).toBe(document.activeElement);
    expect(view.getByRole("navigation", { name: "Thread trail" })).toBeTruthy();
    expect(view.getByRole("button", { name: "src folder", expanded: false })).toBeTruthy();
    expect(view.queryByRole("group", { name: "Diff layout" })).toBeNull();
    expect(diffView.get()).toBe("split");
    expect(view.getByRole("button", { name: `Show ${path}` })).toBeTruthy();
    expect(view.getByRole("button", { name: "Terminal" })).toBeTruthy();
    diffView.set("unified");
  });

  it("wraps long lines from the tab's narrow bar and in All changes", async () => {
    const { slot } = await mountPanel();
    const view = within(slot.container);
    fireEvent.click(chip(slot, /^Worker/));
    await waitFor(() =>
      expect(slot.container.querySelector("[data-testid='bb-diff']")?.getAttribute("data-overflow")).toBe("scroll"),
    );
    fireEvent.click(view.getByRole("button", { name: "Wrap long lines" }));
    expect(slot.container.querySelector("[data-testid='bb-diff']")?.getAttribute("data-overflow")).toBe("wrap");
    fireEvent.click(chip(slot, "All changes"));
    await waitFor(() =>
      expect(
        slot.container.querySelector("[data-all-changes] [data-testid='bb-diff']")?.getAttribute("data-overflow"),
      ).toBe("wrap"),
    );
    expect(view.getByRole("button", { name: "Wrap long lines" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows every change of the tree in All changes", async () => {
    const { slot } = await mountPanel();
    fireEvent.click(chip(slot, "All changes"));
    await waitFor(() =>
      expect(slot.container.querySelector("[data-all-changes] [data-file-card='src/a.ts']")).not.toBeNull(),
    );
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
    const LATE = worktree({
      key: "host_1:/work/late",
      threadIds: ["thr_late"],
      root: "/work/late",
      uncommitted: [fileChange({ path: "z.ts" })],
    });
    const SIDE = worktree({
      key: "host_1:/work/side",
      threadIds: ["thr_side"],
      root: "/work/side",
      uncommitted: [fileChange({ path: "z.ts" })],
    });
    const first = overview({ ...TREE, worktrees: [{ ...OWN, uncommitted: [] }, CHILD] });
    const second = overview({
      ...first,
      generatedAt: first.generatedAt + 1,
      worktrees: [...first.worktrees, LATE, SIDE],
      threads: [
        ...TREE.threads,
        ...["late", "side"].map((id) =>
          threadSummary({ id: `thr_${id}`, title: id, parentThreadId: "thr_root", rootThreadId: "thr_root", depth: 1 }),
        ),
      ],
      sharedFiles: [{ projectId: "proj_1", path: "z.ts", worktreeKeys: [LATE.key, SIDE.key] }],
    });
    let calls = 0;
    const { slot } = await mountPanel(1, () => (calls++ === 0 ? first : second), [
      ...SIDEBAR,
      sidebarThread({
        id: "thr_late",
        displayTitle: "Late",
        parentThreadId: "thr_root",
        indicator: "waiting-for-input",
      }),
    ]);
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
