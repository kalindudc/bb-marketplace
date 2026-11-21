import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { Overview, OverviewInput, PatchRequest, rpcContract } from "../src/contract";
import { reviewDraftKey } from "../src/comments";
import { clearLoadedCache } from "../src/loaded";
import { disposeSessions } from "../src/session";
import { formatRoute, parseRoute } from "../src/route";
import { newHandoff, type Handoff } from "../src/reading-state";
import { comments } from "../src/shared";
import { pageChip, pageText, reloadUiState } from "../src/ui-prefs";
import { fileChange, overview, sharedFile, sidebarThread, threadSummary, worktree } from "./fixtures";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const ROOT = worktree({
  key: "host_1:/work/root",
  threadIds: ["thr_root"],
  root: "/work/root",
  branch: "main",
  label: "Shop",
  uncommitted: [fileChange({ path: "README.md", additions: 4, deletions: 0 })],
});
const CHILD = worktree({
  key: "host_1:/work/child",
  threadIds: ["thr_child"],
  root: "/work/child",
  branch: "bb/pricing",
  label: "Shop",
  ref: { kind: "workspace", environmentId: "env_child", base: "origin/main" },
  uncommitted: [fileChange({ path: "src/money.js", additions: 6, deletions: 0 })],
  committed: [fileChange({ path: "README.md", additions: 2, deletions: 0 })],
  commits: [
    { sha: "a".repeat(40), shortSha: "aaaaaaa", subject: "Document the sale", authorName: "Ada", authoredAt: 1 },
  ],
  aheadCount: 1,
});
const QUIET = worktree({ key: "host_1:/work/quiet", threadIds: ["thr_quiet"], root: "/work/quiet", label: "Shop" });

const SIDEBAR = [
  sidebarThread({ id: "thr_root", displayTitle: "Holiday sale" }),
  sidebarThread({
    id: "thr_child",
    displayTitle: "Pricing",
    parentThreadId: "thr_root",
    indicator: "waiting-for-input",
    indicatorLabel: "Thread needs user input",
  }),
  sidebarThread({ id: "thr_quiet", displayTitle: "Quiet", parentThreadId: "thr_root" }),
];

function tree(overrides: Partial<Overview> = {}): Overview {
  return overview({
    threadId: "thr_root",
    target: { kind: "tree", threadId: "thr_root" },
    threads: [
      threadSummary({ id: "thr_root", title: "Holiday sale" }),
      threadSummary({
        id: "thr_child",
        title: "Pricing",
        parentThreadId: "thr_root",
        depth: 1,
        rootThreadId: "thr_root",
      }),
      threadSummary({
        id: "thr_quiet",
        title: "Quiet",
        parentThreadId: "thr_root",
        depth: 1,
        rootThreadId: "thr_root",
      }),
    ],
    worktrees: [ROOT, CHILD, QUIET],
    sharedFiles: [sharedFile({ projectId: "proj_1", path: "README.md", worktreeKeys: [ROOT.key, CHILD.key] })],
    ...overrides,
  });
}

const key = (value: string) =>
  value.replace(
    /[^A-Za-z0-9._-]/g,
    (character) => `~${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
type Slot = ReturnType<typeof renderSlot>;
const mounts: Slot[] = [];

beforeEach(() => {
  pageText.set("");
  pageChip.set(null);
});
afterEach(() => {
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  disposeSessions();
  clearLoadedCache();
  document.body.replaceChildren();
  window.localStorage.clear();
  reloadUiState();
  const unsubscribe = comments.subscribe(() => {});
  window.dispatchEvent(new StorageEvent("storage", { key: "bb-plugin-vantage:comments" }));
  unsubscribe();
});

interface Options {
  overview?: Overview | ((input: OverviewInput) => Overview);
  sidebar?: typeof SIDEBAR;
  marks?: Record<string, Record<string, string>>;
}

async function mount(subPath: string, options: Options = {}, part: "page" | "sidebar" | "agent" = "page") {
  const app = await loadPluginApp(() => import("../app"));
  const page = app.navPanels[0]!;
  const stored: Record<string, Record<string, string>> = { ...options.marks };
  const calls = {
    patch: vi.fn(async (input: PatchRequest) => ({
      patch: `@@ -1,1 +1,2 @@\n line\n+${input.scope} ${input.path}`,
      truncated: false,
      binary: false,
    })),
    // Kept like the server keeps them, so a tick survives the reload its mutation asks for.
    setReviewed: vi.fn(async (input: { key: string; marks: Array<{ mark: string; signature: string | null }> }) => {
      const row = { ...stored[input.key] };
      for (const { mark, signature } of input.marks) {
        if (signature === null) delete row[mark];
        else row[mark] = signature;
      }
      stored[input.key] = row;
      return row;
    }),
    send: vi.fn(async (_input: { threadId: string; mode: string; input: unknown[] }) => ({
      ok: true,
      delivery: "sent",
    })),
    commitFiles: vi.fn(async () => ({ files: [fileChange({ path: "README.md", additions: 2, deletions: 0 })] })),
    setWhole: vi.fn(async (_input: { key: string; whole: boolean }) => ({ ok: true })),
  };
  const registration =
    part === "page"
      ? page
      : part === "sidebar"
        ? { component: page.experimental_sidebar! }
        : app.tabs.find((tab) => tab.id === "agent")!;
  const slot = renderSlot<PluginNavPanelProps, typeof rpcContract>(
    registration as never,
    { subPath },
    {
      pluginId: "vantage",
      rpc: {
        shell: () => new Promise<Overview>(() => {}),
        overview: (input: OverviewInput) =>
          typeof options.overview === "function" ? options.overview(input) : (options.overview ?? tree()),
        patch: calls.patch,
        fileSides: () => ({ old: null, new: null }),
        image: () => ({ old: null, new: null, truncated: false }),
        recordedEdits: () => ({ edits: [] }),
        commitFiles: calls.commitFiles,
        reviewed: ({ keys }: { keys: string[] }) =>
          Object.fromEntries(keys.map((entry) => [entry, stored[entry] ?? {}])),
        setReviewed: calls.setReviewed,
        setWhole: calls.setWhole,
      } as never,
      sdk: {
        subscribe: (() => () => {}) as never,
        threads: { send: calls.send as never, retry: vi.fn() as never },
        terminals: { create: vi.fn() as never },
      },
      sidebarThreads: { status: "ready", threads: options.sidebar ?? SIDEBAR },
      threadActions: (() => []) as never,
    },
  );
  mounts.push(slot);
  return { slot, calls, page };
}

// Leaves and comes back after a reload, so only what this device stored remains.
async function comeBack(slot: Slot, subPath: string, options: Options = {}, part: "page" | "sidebar" = "page") {
  mounts.splice(mounts.indexOf(slot), 1);
  slot.lifecycle.unmount();
  disposeSessions();
  reloadUiState();
  return mount(subPath, options, part);
}

const addressOf = (target: string, handoff: Handoff) =>
  formatRoute({
    target: { kind: "tree", threadId: target },
    view: "overview",
    selectedKey: null,
    focus: null,
    handoff,
  });

function routedSubPath(slot: Slot): string {
  const nav = slot.inspection.navigateCalls.at(-1);
  if (nav?.method !== "toPluginPanel" || nav.options?.subPath === undefined)
    throw new Error("Missing Vantage navigation");
  return nav.options.subPath;
}

function addDraft(view: ReturnType<typeof within>, path: string, text: string) {
  fireEvent.click(view.getByRole("button", { name: `Comment on ${path}` }));
  fireEvent.change(view.getByRole("textbox", { name: "Comment" }), { target: { value: text } });
  fireEvent.click(view.getByRole("button", { name: "Add comment" }));
}

const treeFiles = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-file-tree] [data-tree-file]")].map((row) => row.getAttribute("data-tree-file"));

describe("Trail page", () => {
  const address = `tree/thr_root/worktree/${key(CHILD.key)}`;
  const img = "src/lib/logo.png";
  const nested = tree({
    worktrees: [
      ROOT,
      {
        ...CHILD,
        committed: [
          fileChange({ path: "README.md" }),
          fileChange({ path: img, binary: true }),
          fileChange({ path: "src/index.ts" }),
        ],
      },
    ],
  });

  it("keeps shared-checkout drafts with their recipient across combined, solo and reordered membership", async () => {
    const combined = tree({ worktrees: [{ ...CHILD, threadIds: ["thr_root", "thr_child"] }] });
    const checkout = { worktreeKey: CHILD.key, source: "checkout", scope: "all" } as const;
    const childAddress = addressOf("thr_root", { ...checkout, threadId: "thr_child" });
    const parentAddress = addressOf("thr_root", { ...checkout, threadId: "thr_root" });
    let current = await mount(parentAddress, { overview: combined });
    let view = within(current.slot.container);
    await view.findByRole("button", { name: "Comment on src/money.js" });
    addDraft(view, "src/money.js", "Parent rationale");
    current = await comeBack(current.slot, childAddress, { overview: combined });
    view = within(current.slot.container);
    await view.findByRole("button", { name: "Comment on src/money.js" });
    addDraft(view, "src/money.js", "Child rationale");
    const solo = {
      ...combined,
      target: { kind: "tree" as const, threadId: "thr_child" },
      threadId: "thr_child",
      threads: [combined.threads[1]!],
      worktrees: [CHILD],
    };
    current = await comeBack(current.slot, addressOf("thr_child", { ...checkout, threadId: "thr_child" }), {
      overview: solo,
    });
    view = within(current.slot.container);
    fireEvent.click(await view.findByRole("button", { name: "Preview" }));
    expect(view.getByText("Message to Pricing")).toBeTruthy();
    const preview = current.slot.container.querySelector("[data-review-preview]");
    expect(preview?.textContent).toContain("Child rationale");
    expect(preview?.textContent).not.toContain("Parent rationale");
    fireEvent.click(view.getByRole("button", { name: "Send to agent" }));
    expect(current.calls.send).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thr_child" }));
    current = await comeBack(current.slot, parentAddress, {
      overview: { ...combined, worktrees: [{ ...CHILD, threadIds: ["thr_child", "thr_root"] }] },
    });
    view = within(current.slot.container);
    fireEvent.click(await view.findByRole("button", { name: "Preview" }));
    expect(view.getByText("Message to Holiday sale")).toBeTruthy();
    expect(current.slot.container.querySelector("[data-review-preview]")?.textContent).toContain("Parent rationale");
    fireEvent.click(view.getByRole("button", { name: "Send to agent" }));
    expect(current.calls.send).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thr_root" }));
  });

  it.each(["branch", "recorded"] as const)(
    "recovers exact archived %s evidence from the initially filtered page",
    async (source) => {
      const prefix = source === "branch" ? "" : "/work/child/";
      const firstPath = `${prefix}src/a.ts`;
      const secondPath = `${prefix}src/b.ts`;
      const files = [firstPath, secondPath].map((path) =>
        fileChange({
          path,
          status: "clean",
          edits: { threadIds: ["thr_child"], rawPaths: [path], count: 1 },
        }),
      );
      const branch = worktree({
        ...CHILD,
        key: "kept:pricing",
        kind: "branch",
        ref: { kind: "branch", hostId: "host_1", root: CHILD.root, base: "main", head: "bb/pricing" },
        uncommitted: [],
        committed: files.map((file) => ({ ...file, status: "modified" })),
      });
      const archived = { ...tree().threads[1]!, archived: true };
      const base = tree({ worktrees: [ROOT], threads: [tree().threads[0]!], archivedHidden: 1 });
      const expanded = tree({
        threads: [...base.threads, archived],
        worktrees: source === "branch" ? [ROOT, branch] : [ROOT],
        otherFiles: source === "recorded" ? files : [],
      });
      const requested: boolean[] = [];
      const options: Options = {
        overview: ({ includeArchived }) => {
          requested.push(includeArchived);
          return includeArchived ? expanded : base;
        },
      };
      const part = source === "recorded" ? "recorded" : "committed";
      const handoff = {
        threadId: "thr_child",
        source,
        scope: part,
        part,
        file: secondPath,
        ...(source === "branch" ? { worktreeKey: branch.key } : {}),
      } as const;
      const url = addressOf("thr_root", newHandoff(handoff));
      let current = await mount(url, options);
      let view = within(current.slot.container);
      const recover = await view.findByRole("button", { name: "Include archived threads in this view" });
      expect(requested).toEqual([false]);
      expect(view.queryByText(/not available from this source/i)).toBeNull();
      fireEvent.click(recover);
      await waitFor(() =>
        expect(
          current.slot.container.querySelector(`[data-reading-selected][data-file-card="${secondPath}"]`),
        ).not.toBeNull(),
      );
      expect(requested).toEqual([false, true]);
      expect(window.localStorage.getItem("bb-plugin-vantage:page-archived")).toBeNull();
      fireEvent.click(
        current.slot.container.querySelector<HTMLButtonElement>(`[data-tree-file="${firstPath}"] button`)!,
      );
      current = await comeBack(current.slot, url, options);
      view = within(current.slot.container);
      fireEvent.click(await view.findByRole("button", { name: "Include archived threads in this view" }));
      await waitFor(() =>
        expect(
          current.slot.container.querySelector(`[data-reading-selected][data-file-card="${firstPath}"]`),
        ).not.toBeNull(),
      );
      const repeat = addressOf("thr_root", newHandoff(handoff));
      const Page = current.page.component;
      current.slot.lifecycle.rerender(<Page subPath={repeat} />);
      await waitFor(() =>
        expect(
          current.slot.container.querySelector(`[data-reading-selected][data-file-card="${secondPath}"]`),
        ).not.toBeNull(),
      );
    },
  );

  it("keeps nested folder folds apart from card folds, and returns focus without losing the split reader", async () => {
    const { slot } = await mount(address, { overview: nested });
    const view = within(slot.container);
    const lib = await view.findByRole("button", { name: "src/lib folder" });
    expect(slot.container.querySelector('[data-tree-dir="src"] [data-tree-dir="src/lib"]')).not.toBeNull();
    fireEvent.click(slot.container.querySelector<HTMLButtonElement>(`[data-tree-file="${img}"] button`)!);
    fireEvent.click(view.getByRole("button", { name: "Side by side diff" }));
    fireEvent.keyDown(slot.container.querySelector("[data-diff-stream]")!, { key: "Escape" });
    expect(document.activeElement?.closest("[data-tree-file]")?.getAttribute("data-tree-file")).toBe(img);
    fireEvent.click(lib);
    fireEvent.click(view.getByRole("button", { name: "Collapse all diffs" }));
    expect(view.getByRole("button", { name: `Show ${img}` })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Expand all diffs" }));
    expect(lib.getAttribute("aria-expanded")).toBe("false");
    const hide = view.getByRole("button", { name: "Hide the file tree" });
    fireEvent.click(hide);
    expect(document.activeElement).toBe(hide);
    expect(slot.container.querySelector("[data-file-tree]")).toBeNull();
    expect(slot.container.querySelector(`[data-file-card="${img}"][data-reading-selected]`)).not.toBeNull();
    expect(view.getByRole("button", { name: "Side by side diff" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(hide);
    expect(view.getByRole("button", { name: "src/lib folder" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("focuses the page without rebuilding the stream or moving its reading anchor", async () => {
    const options = { overview: { ...nested, warnings: ["Some worktrees are unavailable."] } };
    const { slot } = await mount(address, options);
    const view = within(slot.container);
    const path = "src/money.js";
    await view.findByRole("heading", { name: "Pricing" });
    expect(view.getByText("Some worktrees are unavailable.")).toBeTruthy();
    const fileButton = slot.container.querySelector<HTMLButtonElement>(`[data-tree-file="${path}"] button`)!;
    fireEvent.click(fileButton);
    fireEvent.click(view.getByRole("button", { name: "Side by side diff" }));
    const stream = slot.container.querySelector<HTMLElement>("[data-diff-stream]")!;
    const card = stream.querySelector<HTMLElement>(`[data-file-card="${path}"]`)!;
    const focused = () => view.queryByRole("button", { name: "Exit focus", pressed: true }) !== null;
    const top = () => (focused() ? 36 : 110);
    const cardTop = () => top() + 53 + (focused() ? 22 : 0) - stream.scrollTop;
    stream.getBoundingClientRect = () => ({ top: top(), bottom: 400 }) as DOMRect;
    card.getBoundingClientRect = () => ({ top: cardTop(), bottom: cardTop() + 150 }) as DOMRect;
    stream.scrollTop = 60;
    const fold = view.getByRole("button", { name: `Hide ${path}` });
    fold.focus();
    fireEvent.keyDown(fold, { key: "f" });
    const exit = view.getByRole("button", { name: "Exit focus", pressed: true });
    expect(document.activeElement).toBe(stream);
    expect(view.queryByRole("heading", { name: "Pricing" })).toBeNull();
    expect(view.queryByText("Some worktrees are unavailable.")).toBeNull();
    expect(slot.container.querySelector("[data-file-tree]")).toBeNull();
    expect(slot.container.querySelector("[data-diff-stream]")).toBe(stream);
    expect(stream.scrollTop).toBe(82);
    expect(cardTop() - top()).toBe(-7);
    const bar = within(exit.closest<HTMLElement>("[data-review-bar]")!);
    expect(bar.getByRole("group", { name: "Evidence source" })).toBeTruthy();
    expect(bar.getByRole("button", { name: "Side by side diff", pressed: true })).toBeTruthy();
    await waitFor(() => expect(within(card).getByTestId("bb-diff").getAttribute("data-view")).toBe("split"));
    expect(bar.getByRole("button", { name: "Collapse all diffs" })).toBeTruthy();
    expect(view.getByRole("button", { name: `Comment on ${path}` })).toBeTruthy();
    exit.focus();
    fireEvent.keyDown(exit, { key: "Escape" });
    expect(view.getByRole("button", { name: "Focus on diffs", pressed: false })).toBeTruthy();
    expect(document.activeElement).toBe(stream);
    expect(view.getByRole("heading", { name: "Pricing" })).toBeTruthy();
    expect(stream.scrollTop).toBe(60);
    expect(cardTop() - top()).toBe(-7);
    fireEvent.keyDown(stream, { key: "Escape" });
    expect(document.activeElement).toBe(slot.container.querySelector(`[data-tree-file="${path}"] button`));
  });

  it("remembers page focus across a remount and keeps the commit scope reachable", async () => {
    const { slot } = await mount(address, { overview: nested });
    fireEvent.click(await within(slot.container).findByRole("button", { name: "Focus on diffs", pressed: false }));
    const back = await comeBack(slot, address, { overview: nested });
    const view = within(back.slot.container);
    await view.findByRole("button", { name: "Exit focus", pressed: true });
    const scope = view.getByRole("combobox", { name: "Which changes" });
    fireEvent.change(scope, { target: { value: `commit:${CHILD.commits[0]!.sha}` } });
    await waitFor(() => expect(back.calls.commitFiles).toHaveBeenCalledOnce());
    await view.findByRole("button", { name: "Hide README.md" });
    expect(view.queryByRole("button", { name: "Hide src/money.js" })).toBeNull();
  });

  it("reopens the page with its scope and anchor, and gives explicit handoff precedence without substituting a missing image", async () => {
    const first = await mount(address, { overview: nested });
    const view = within(first.slot.container);
    fireEvent.click(await view.findByRole("button", { name: /^Committed/ }));
    const selected = first.slot.container.querySelector<HTMLElement>(`[data-file-card="${img}"]`)!;
    const stream = first.slot.container.querySelector<HTMLElement>("[data-diff-stream]")!;
    const rect = (top: number, bottom: number) => ({ top, bottom }) as DOMRect;
    stream.getBoundingClientRect = () => rect(20, 200);
    selected.getBoundingClientRect = () => rect(13, 120);
    fireEvent.click(first.slot.container.querySelector<HTMLButtonElement>(`[data-tree-file="${img}"] button`)!);
    fireEvent.scroll(stream);
    fireEvent.click(view.getByRole("button", { name: "Hide the file tree" }));
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.fileCard === img || Object.hasOwn(this.dataset, "diffStream")) return rect(20, 120);
      return rect(0, 0);
    });
    let again: Awaited<ReturnType<typeof comeBack>>;
    try {
      again = await comeBack(first.slot, "tree/thr_root", { overview: nested });
      const againView = within(again.slot.container);
      expect((await againView.findByRole("button", { name: /^Committed/ })).getAttribute("aria-pressed")).toBe("true");
      expect(again.slot.container.querySelector(`[data-file-card="${img}"][data-reading-selected]`)).not.toBeNull();
      expect(againView.getByRole("button", { name: "Show the file tree" })).toBeTruthy();
      await waitFor(() =>
        expect(again.slot.container.querySelector<HTMLElement>("[data-diff-stream]")!.scrollTop).toBe(7),
      );
    } finally {
      bounds.mockRestore();
    }
    const handoff = {
      threadId: "thr_child",
      source: "checkout",
      worktreeKey: CHILD.key,
      scope: "uncommitted",
      file: "old/image.png",
      part: "uncommitted",
      anchor: { file: "old/image.png", part: "uncommitted", offset: 7 },
    };
    const explicit = await comeBack(again.slot, `tree/thr_root/review/${key(JSON.stringify(handoff))}`, {
      overview: nested,
    });
    const explicitView = within(explicit.slot.container);
    expect(await explicitView.findByText(/not available from this source/i)).toBeTruthy();
    expect(explicit.slot.container.querySelector('[data-reading-unavailable="old/image.png"]')).not.toBeNull();
    expect(explicitView.getByRole("button", { name: "Show the file tree" })).toBeTruthy();
    expect(explicit.calls.patch).not.toHaveBeenCalledWith(expect.objectContaining({ path: "old/image.png" }));
  });
  it.each([false, true])(
    "keeps preview but refuses delivery when sidebar archived=%s disagrees with the overview",
    async (sidebarArchived) => {
      const archived = worktree({
        ...CHILD,
        key: "kept:old",
        kind: "branch",
        threadIds: ["thr_old"],
        ref: { kind: "branch", hostId: "host_1", root: "/work/child", base: "main", head: "bb/old" },
        uncommitted: [],
      });
      const { slot, calls } = await mount(`tree/thr_root/worktree/${key(archived.key)}`, {
        sidebar: [
          ...SIDEBAR,
          sidebarThread({ id: "thr_old", displayTitle: "Archive worker", isArchived: sidebarArchived }),
        ],
        overview: tree({
          threads: [threadSummary({ id: "thr_old", title: "Archive worker", archived: !sidebarArchived })],
          worktrees: [archived],
        }),
      });
      const view = within(slot.container);
      try {
        fireEvent.click(await view.findByRole("button", { name: "Comment on README.md" }));
        fireEvent.change(view.getByRole("textbox", { name: "Comment" }), { target: { value: "Keep the rationale." } });
        fireEvent.click(view.getByRole("button", { name: "Add comment" }));
        expect(view.getByText("1 comment for Archive worker")).toBeTruthy();
        fireEvent.click(view.getByRole("button", { name: "Preview" }));
        expect(view.getByText("Message to Archive worker")).toBeTruthy();
        expect(view.getByRole<HTMLButtonElement>("button", { name: "Send to agent" }).disabled).toBe(true);
        fireEvent.click(view.getByRole("button", { name: "More ways to use this draft" }));
        const sendNow = view.getByRole<HTMLButtonElement>("menuitem", { name: /Send now/ });
        const queue = view.getByRole<HTMLButtonElement>("menuitem", { name: /Queue after its current turn/ });
        expect(sendNow.disabled && queue.disabled).toBe(true);
        fireEvent.click(sendNow);
        fireEvent.click(queue);
        fireEvent.keyDown(slot.container.querySelector("[data-review]")!, { key: "Enter", metaKey: true });
        fireEvent.keyDown(slot.container.querySelector("[data-review]")!, { key: "Enter", ctrlKey: true });
        expect(calls.send).not.toHaveBeenCalled();
        fireEvent.click(view.getByRole("menuitem", { name: "Copy as Markdown" }));
        expect(slot.inspection.experimental_clipboardWrites).toEqual([
          { text: expect.stringContaining("Keep the rationale.") },
        ]);
      } finally {
        comments.clear(reviewDraftKey(archived.key, "thr_old"));
      }
    },
  );

  it("pins an overlap draft recipient even if another thread becomes first in the checkout", async () => {
    const combined = tree({ worktrees: [ROOT, { ...CHILD, threadIds: ["thr_child", "thr_quiet"] }] });
    const { slot, calls } = await mount("tree/thr_root/overlaps", { overview: combined });
    const view = within(slot.container);
    fireEvent.click(await view.findByRole("button", { name: "Ask Pricing to rebase onto Holiday sale" }));
    const routed = routedSubPath(slot);
    expect(parseRoute(routed).route.handoff?.threadId).toBe("thr_child");
    const next = await comeBack(slot, routed, {
      overview: { ...combined, worktrees: [ROOT, { ...CHILD, threadIds: ["thr_quiet", "thr_child"] }] },
    });
    const nextView = within(next.slot.container);
    fireEvent.click(await nextView.findByRole("button", { name: "Preview" }));
    expect(nextView.getByText("Message to Pricing")).toBeTruthy();
    fireEvent.click(nextView.getByRole("button", { name: "Send to agent" }));
    expect(next.calls.send).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thr_child" }));
    expect(calls.send).not.toHaveBeenCalled();
  });

  it("offers only preview and copy for a legacy bare-key draft or unavailable checkout draft", async () => {
    const legacy = { path: "src/money.js", part: "uncommitted", quote: "", text: "Old unassigned notes" } as const;
    comments.add(CHILD.key, legacy);
    const wanted = addressOf("thr_root", {
      threadId: "thr_child",
      source: "checkout",
      worktreeKey: CHILD.key,
      scope: "uncommitted",
      part: "uncommitted",
      file: legacy.path,
    });
    const active = await mount(wanted);
    const activeView = within(active.slot.container);
    const legacyOnly = await activeView.findByRole("region", { name: "Unattributed draft" });
    expect(within(legacyOnly).getByRole("button", { name: "Preview unattributed draft" })).toBeTruthy();
    expect(activeView.queryByRole("button", { name: /Send|Queue/ })).toBeNull();
    addDraft(activeView, legacy.path, "Known recipient notes");
    const { slot, calls } = await comeBack(active.slot, wanted, {
      overview: tree({ worktrees: [ROOT, { ...CHILD, state: "unavailable", message: "Checkout is unavailable" }] }),
    });
    const view = within(slot.container);
    const unattributed = within(await view.findByRole("region", { name: "Unattributed draft" }));
    fireEvent.click(unattributed.getByRole("button", { name: "Preview unattributed draft" }));
    expect(unattributed.getByText(/Old unassigned notes/)).toBeTruthy();
    expect(unattributed.queryByText(/Known recipient notes/)).toBeNull();
    fireEvent.click(unattributed.getByRole("button", { name: "Copy as Markdown" }));
    const known = within(view.getByRole("region", { name: "Draft for Pricing" }));
    fireEvent.click(known.getByRole("button", { name: "Preview" }));
    expect(known.getByText(/Known recipient notes/)).toBeTruthy();
    fireEvent.click(known.getByRole("button", { name: "Copy as Markdown" }));
    expect(slot.inspection.experimental_clipboardWrites).toEqual([
      { text: expect.stringContaining("Old unassigned notes") },
      { text: expect.stringContaining("Known recipient notes") },
    ]);
    expect(view.getByRole("button", { name: "Open thread" })).toBeTruthy();
    expect(view.getAllByRole("button", { name: "Copy path" }).length).toBeGreaterThanOrEqual(1);
    expect(view.queryByRole("button", { name: /Send|Queue|Terminal/ })).toBeNull();
    expect(calls.send).not.toHaveBeenCalled();
    expect(calls.patch).not.toHaveBeenCalled();
    expect(comments.get(CHILD.key)).toHaveLength(1);
  });

  it("keeps page keyboard focus on the chosen evidence after the router applies the SDK navigation", async () => {
    const path = "/work/child/src/money.js";
    const otherFiles = [fileChange({ path, edits: { threadIds: ["thr_child"], rawPaths: [path], count: 1 } })];
    const { slot, page } = await mount(address, { overview: tree({ otherFiles }) });
    const view = within(slot.container);
    const button = await view.findByRole("button", { name: "Recorded edits" });
    button.focus();
    fireEvent.click(button);
    const Page = page.component;
    slot.lifecycle.rerender(<Page subPath={routedSubPath(slot)} />);
    const recorded = await view.findByRole("button", { name: "Recorded edits", pressed: true });
    expect(document.activeElement).toBe(recorded);
  });

  it("keeps a missing checkout source selected even when that thread has recorded evidence", async () => {
    const handoff = {
      threadId: "thr_child",
      source: "checkout",
      worktreeKey: CHILD.key,
      scope: "uncommitted",
      file: "src/money.js",
      part: "uncommitted",
    };
    const recorded = fileChange({
      path: "src/money.js",
      edits: { threadIds: ["thr_child"], rawPaths: ["src/money.js"], count: 1 },
    });
    const options = { overview: tree({ worktrees: [ROOT], otherFiles: [recorded] }) };
    const { slot, calls } = await mount(`tree/thr_root/review/${key(JSON.stringify(handoff))}`, options);
    const view = within(slot.container);
    expect(await view.findByText(/not available from this source/i)).toBeTruthy();
    expect(view.getByRole("button", { name: "Recorded edits" }).getAttribute("aria-pressed")).toBe("false");
    expect(calls.patch).not.toHaveBeenCalled();
    expect(slot.inspection.rpcCalls.filter(({ method }) => method === "recordedEdits")).toHaveLength(0);
  });
});

describe("the page", () => {
  it("opens the worktree that needs you first, with no switches to turn on", async () => {
    const { slot } = await mount("tree/thr_root");
    const view = within(slot.container);
    await waitFor(() => expect(slot.container.querySelector("[data-review-header]")).not.toBeNull());
    expect(view.getByRole("heading", { name: "Pricing" })).toBeTruthy();
    expect(view.getAllByRole("button", { name: "Answer" }).length).toBeGreaterThan(0);
    expect(view.queryByRole("button", { name: /Watch/ })).toBeNull();
    expect(view.queryByRole("button", { name: /Track reviews/ })).toBeNull();
    // The address is replaced once, not pushed on every render.
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "vantage",
        options: { subPath: `tree/thr_root/worktree/${key(CHILD.key)}`, replace: true },
      }),
    );
  });

  // A sticky header sticks inside its scroll container's padding, so top padding leaves scrolled code showing above it.
  it("gives the page's scrolling views no top padding, so stuck headers meet the top edge", async () => {
    const paddedTop = (element: Element) => /(^|\s)(p|pt|py)-/.test(element.className);
    const review = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`);
    await waitFor(() => expect(review.slot.container.querySelectorAll("[data-file-card]")).toHaveLength(2));
    expect(paddedTop(review.slot.container.querySelector("[data-diff-stream]")!)).toBe(false);
    const changes = await mount("tree/thr_root/changes");
    await waitFor(() => expect(changes.slot.container.querySelector("[data-all-changes]")).not.toBeNull());
    expect(paddedTop(changes.slot.container.querySelector("[data-all-changes]")!.parentElement!)).toBe(false);
  });

  it("offers the repository view when no worktree exists to open", async () => {
    const { slot } = await mount("tree/thr_root", { overview: tree({ worktrees: [] }) });
    const view = within(slot.container);
    await view.findByText("No worktree in this thread or its child threads has changes yet.");
    fireEvent.click(view.getByRole("button", { name: "See every change by repository" }));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "vantage",
      options: { subPath: "tree/thr_root/changes" },
    });
  });

  it("opens a worktree with every change as a diff, and narrows to what is committed or one commit", async () => {
    const { slot, calls } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`);
    const view = within(slot.container);
    await waitFor(() => expect(slot.container.querySelectorAll("[data-file-card]")).toHaveLength(2));
    await waitFor(() => expect(calls.patch).toHaveBeenCalledTimes(2));
    expect(
      [...slot.container.querySelectorAll("[data-file-card]")].map((card) => card.getAttribute("data-file-card")),
    ).toEqual(["src/money.js", "README.md"]);
    fireEvent.click(view.getByRole("button", { name: /^Committed/ }));
    expect(
      [...slot.container.querySelectorAll("[data-file-card]")].map((card) => card.getAttribute("data-file-card")),
    ).toEqual(["README.md"]);
    fireEvent.click(view.getByRole("button", { name: /Commits 1/ }));
    fireEvent.click(view.getByRole("menuitemradio", { name: /Document the sale/ }));
    await waitFor(() => expect(calls.commitFiles).toHaveBeenCalledWith({ ref: CHILD.ref, sha: "a".repeat(40) }));
  });

  it("collapses every diff at once and expands them again, with the button or X", async () => {
    const marks = { [CHILD.key]: { "uncommitted\0src/money.js": "modified:6:0:" } };
    const { slot } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, { marks });
    const view = within(slot.container);
    await waitFor(() => expect(view.getByRole("button", { name: "Show src/money.js" })).toBeTruthy());
    const open = () =>
      [...slot.container.querySelectorAll("[data-file-card] header button[aria-expanded]")].map((button) =>
        button.getAttribute("aria-expanded"),
      );
    expect(open()).toEqual(["false", "true"]);
    fireEvent.click(view.getByRole("button", { name: "Collapse all diffs" }));
    expect(open()).toEqual(["false", "false"]);
    fireEvent.click(view.getByRole("button", { name: "Expand all diffs" }));
    expect(open()).toEqual(["true", "true"]);
    fireEvent.keyDown(slot.container.querySelector("[data-review]")!, { key: "x" });
    expect(open()).toEqual(["false", "false"]);
    fireEvent.keyDown(slot.container.querySelector("[data-review]")!, { key: "x" });
    expect(open()).toEqual(["true", "true"]);
  });

  it("opens the next worktree collapsed after Collapse all, and keeps a file opened by hand open, across a reload", async () => {
    const first = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`);
    await waitFor(() => expect(first.slot.container.querySelectorAll("[data-file-card]")).toHaveLength(2));
    fireEvent.click(within(first.slot.container).getByRole("button", { name: "Collapse all diffs" }));
    fireEvent.click(within(first.slot.container).getByRole("button", { name: "Show README.md" }));
    const other = await comeBack(first.slot, `tree/thr_root/worktree/${key(ROOT.key)}`);
    await waitFor(() =>
      expect(within(other.slot.container).getByRole("button", { name: "Show README.md" })).toBeTruthy(),
    );
    const back = await comeBack(other.slot, `tree/thr_root/worktree/${key(CHILD.key)}`);
    const view = within(back.slot.container);
    await waitFor(() => expect(view.getByRole("button", { name: "Show src/money.js" })).toBeTruthy());
    expect(view.getByRole("button", { name: "Hide README.md" })).toBeTruthy();
  });

  it("lets a later Collapse all elsewhere fold the reviewed files that Expand all opened", async () => {
    const marks = { [CHILD.key]: { "uncommitted\0src/money.js": "modified:6:0:" } };
    const first = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, { marks });
    const view = within(first.slot.container);
    await waitFor(() => expect(view.getByRole("button", { name: "Show src/money.js" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Collapse all diffs" }));
    fireEvent.click(view.getByRole("button", { name: "Expand all diffs" }));
    expect(view.getByRole("button", { name: "Hide src/money.js" })).toBeTruthy();
    const other = await comeBack(first.slot, `tree/thr_root/worktree/${key(ROOT.key)}`, { marks });
    fireEvent.click(await within(other.slot.container).findByRole("button", { name: "Collapse all diffs" }));
    const back = await comeBack(other.slot, `tree/thr_root/worktree/${key(CHILD.key)}`, { marks });
    const again = within(back.slot.container);
    await waitFor(() => expect(again.getByRole("button", { name: "Show src/money.js" })).toBeTruthy());
    expect(again.getByRole("button", { name: "Show README.md" })).toBeTruthy();
  });

  it("keeps a file open when its tick is taken back, even after Collapse all", async () => {
    const marks = { [CHILD.key]: { "uncommitted\0src/money.js": "modified:6:0:" } };
    const { slot } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, { marks });
    const view = within(slot.container);
    await waitFor(() => expect(view.getByRole("button", { name: "Show src/money.js" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Collapse all diffs" }));
    fireEvent.click(view.getByRole("button", { name: "Show src/money.js" }));
    const money = slot.container.querySelector("[data-file-card='src/money.js']") as HTMLElement;
    fireEvent.click(within(money).getByRole("button", { name: /^Reviewed/ }));
    await waitFor(() => expect(slot.container.querySelector("[data-review-progress]")).toBeNull());
    expect(view.getByRole("button", { name: "Hide src/money.js" })).toBeTruthy();
  });

  it("shows All changes when the kept choice is empty now, but not when it was just picked", async () => {
    window.localStorage.setItem("bb-plugin-vantage:review-scopes", JSON.stringify([[CHILD.key, "uncommitted"]]));
    reloadUiState();
    const committedOnly = worktree({ ...CHILD, uncommitted: [] });
    const { slot } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, {
      overview: tree({ worktrees: [ROOT, committedOnly, QUIET] }),
    });
    const view = within(slot.container);
    await waitFor(() =>
      expect(view.getByRole("button", { name: /^Checkout changes/ }).getAttribute("aria-pressed")).toBe("true"),
    );
    fireEvent.click(view.getByRole("button", { name: /^Not committed/ }));
    expect(view.getByRole("button", { name: /^Not committed/ }).getAttribute("aria-pressed")).toBe("true");
    expect(view.getByText("Nothing uncommitted.")).toBeTruthy();
  });

  it("keeps a folder folded when another scope joins it with the folder inside", async () => {
    const split = worktree({
      ...CHILD,
      uncommitted: [fileChange({ path: "src/lib/round.js" })],
      committed: [fileChange({ path: "src/money.js" }), fileChange({ path: "README.md" })],
    });
    const { slot } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, {
      overview: tree({ worktrees: [ROOT, split, QUIET] }),
    });
    const view = within(slot.container);
    await waitFor(() => expect(treeFiles(slot.container)).toEqual(["src/lib/round.js", "src/money.js", "README.md"]));
    fireEvent.click(view.getByRole("button", { name: "src folder" }));
    fireEvent.click(view.getByRole("button", { name: /^Not committed/ }));
    expect(view.getByRole("button", { name: "src/lib folder" }).getAttribute("aria-expanded")).toBe("false");
    expect(treeFiles(slot.container)).toEqual([]);
    fireEvent.click(view.getByRole("button", { name: "src/lib folder" }));
    fireEvent.click(view.getByRole("button", { name: /^Checkout changes/ }));
    expect(treeFiles(slot.container)).toEqual(["src/lib/round.js", "src/money.js", "README.md"]);
  });

  it("wraps long lines in every diff with the button or W, and remembers it", async () => {
    const { slot } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`);
    const overflow = () =>
      [...slot.container.querySelectorAll("[data-testid='bb-diff']")].map((diff) => diff.getAttribute("data-overflow"));
    await waitFor(() => expect(overflow()).toEqual(["scroll", "scroll"]));
    fireEvent.click(within(slot.container).getByRole("button", { name: "Wrap long lines" }));
    expect(overflow()).toEqual(["wrap", "wrap"]);
    expect(window.localStorage.getItem("bb-plugin-vantage:diff-wrap")).toBe("true");
    fireEvent.keyDown(slot.container.querySelector("[data-review]")!, { key: "w" });
    expect(overflow()).toEqual(["scroll", "scroll"]);
  });

  it("remembers which changes a worktree showed", async () => {
    const first = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`);
    await waitFor(() => expect(first.slot.container.querySelectorAll("[data-file-card]")).toHaveLength(2));
    fireEvent.click(within(first.slot.container).getByRole("button", { name: /^Committed/ }));
    const back = await comeBack(first.slot, `tree/thr_root/worktree/${key(CHILD.key)}`);
    await waitFor(() =>
      expect(
        within(back.slot.container)
          .getByRole("button", { name: /^Committed/ })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(
      [...back.slot.container.querySelectorAll("[data-file-card]")].map((card) => card.getAttribute("data-file-card")),
    ).toEqual(["README.md"]);
  });

  it("lists the files as a tree whose folders fold, and keeps them folded across a reload", async () => {
    const deep = worktree({
      ...CHILD,
      uncommitted: [fileChange({ path: "src/money.js" }), fileChange({ path: "src/lib/round.js" })],
    });
    const options = { overview: tree({ worktrees: [ROOT, deep, QUIET] }) };
    const first = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, options);
    await waitFor(() =>
      expect(treeFiles(first.slot.container)).toEqual(["src/lib/round.js", "src/money.js", "README.md"]),
    );
    const files = first.slot.container.querySelector("[data-file-tree]") as HTMLElement;
    fireEvent.click(within(files).getByRole("button", { name: "src/lib folder" }));
    expect(treeFiles(first.slot.container)).toEqual(["src/money.js", "README.md"]);
    fireEvent.click(within(files).getByRole("button", { name: "src folder" }));
    expect(treeFiles(first.slot.container)).toEqual(["README.md"]);
    const back = await comeBack(first.slot, `tree/thr_root/worktree/${key(CHILD.key)}`, options);
    await waitFor(() => expect(treeFiles(back.slot.container)).toEqual(["README.md"]));
    fireEvent.click(within(back.slot.container).getByRole("button", { name: "Expand every folder" }));
    expect(treeFiles(back.slot.container)).toEqual(["src/lib/round.js", "src/money.js", "README.md"]);
  });

  it("does not fold the diffs when X is typed into a comment", async () => {
    const { slot } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`);
    const view = within(slot.container);
    await waitFor(() => expect(slot.container.querySelectorAll("[data-file-card]")).toHaveLength(2));
    fireEvent.click(view.getByRole("button", { name: "Comment on src/money.js" }));
    fireEvent.keyDown(view.getByRole("textbox", { name: "Comment" }), { key: "x" });
    expect(view.getByRole("button", { name: "Collapse all diffs" })).toBeTruthy();
  });

  it("offers a Reviewed tick on every file, and shows progress only once a file is ticked", async () => {
    const { slot, calls } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`);
    const view = within(slot.container);
    await waitFor(() => expect(slot.container.querySelectorAll("[data-file-card]")).toHaveLength(2));
    expect(view.getAllByRole("button", { name: /^Reviewed/ })).toHaveLength(2);
    expect(slot.container.querySelector("[data-review-progress]")).toBeNull();
    expect(view.queryByRole("button", { name: "Hide reviewed" })).toBeNull();
    fireEvent.keyDown(slot.container.querySelector("[data-review]")!, { key: "j" });
    fireEvent.keyDown(slot.container.querySelector("[data-review]")!, { key: "v" });
    await waitFor(() =>
      expect(calls.setReviewed).toHaveBeenCalledWith({
        key: CHILD.key,
        marks: [{ mark: "uncommitted\0src/money.js", signature: "modified:6:0:" }],
      }),
    );
    await waitFor(() =>
      expect(slot.container.querySelector("[data-review-progress]")?.textContent).toContain("1 of 2 reviewed"),
    );
    expect(view.getByRole("button", { name: "Hide reviewed" })).toBeTruthy();
  });

  it("lists only the files the stream shows when reviewed ones are hidden", async () => {
    const marks = { [CHILD.key]: { "uncommitted\0src/money.js": "modified:6:0:" } };
    const { slot } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, { marks });
    await waitFor(() =>
      expect(slot.container.querySelector("[data-review-progress]")?.textContent).toContain("1 of 2 reviewed"),
    );
    fireEvent.click(within(slot.container).getByRole("button", { name: "Hide reviewed" }));
    const tree = slot.container.querySelector("[data-file-tree]") as HTMLElement;
    expect(within(tree).queryByTitle("src/money.js")).toBeNull();
    expect(within(tree).getByTitle("README.md")).toBeTruthy();
    fireEvent.click(within(slot.container).getByRole("button", { name: "Hide reviewed" }));
  });

  it("keeps a comment written while the previous ones were being sent", async () => {
    const { slot, calls } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`);
    const view = within(slot.container);
    await waitFor(() => expect(slot.container.querySelectorAll("[data-file-card]")).toHaveLength(2));
    let finish: (value: { ok: true; delivery: "sent" }) => void = () => {};
    calls.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const comment = (path: string, text: string) => {
      fireEvent.click(view.getByRole("button", { name: `Comment on ${path}` }));
      fireEvent.change(view.getByRole("textbox", { name: "Comment" }), { target: { value: text } });
      fireEvent.click(view.getByRole("button", { name: "Add comment" }));
    };
    comment("src/money.js", "First");
    fireEvent.click(view.getByRole("button", { name: /Send to agent/ }));
    comment("README.md", "Second");
    finish({ ok: true, delivery: "sent" });
    await waitFor(() => expect(view.getByText("1 comment for Pricing")).toBeTruthy());
    expect(comments.get(reviewDraftKey(CHILD.key, "thr_child")).map((entry) => entry.text)).toEqual(["Second"]);
  });

  it("keeps a comment edited while it was being sent, with its new text", async () => {
    const { slot, calls } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`);
    const view = within(slot.container);
    await waitFor(() => expect(slot.container.querySelectorAll("[data-file-card]")).toHaveLength(2));
    let finish: (value: { ok: true; delivery: "sent" }) => void = () => {};
    calls.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(view.getByRole("button", { name: "Comment on src/money.js" }));
    fireEvent.change(view.getByRole("textbox", { name: "Comment" }), { target: { value: "Round to the cent" } });
    fireEvent.click(view.getByRole("button", { name: "Add comment" }));
    fireEvent.click(view.getByRole("button", { name: /Send to agent/ }));
    fireEvent.click(view.getByRole("button", { name: "Edit comment" }));
    fireEvent.change(view.getByRole("textbox", { name: "Comment" }), {
      target: { value: "Round half up to the cent" },
    });
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    finish({ ok: true, delivery: "sent" });
    await waitFor(() => expect(calls.send).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(calls.send.mock.calls[0]![0])).toContain("Round to the cent");
    await waitFor(() =>
      expect(comments.get(reviewDraftKey(CHILD.key, "thr_child")).map((entry) => entry.text)).toEqual([
        "Round half up to the cent",
      ]),
    );
    expect(view.getByText("1 comment for Pricing")).toBeTruthy();
  });

  it("ticks a file as reviewed and folds a reviewed file away", async () => {
    const marks = { [CHILD.key]: { "uncommitted\0src/money.js": "modified:6:0:" } };
    const { slot, calls } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, { marks });
    await waitFor(() =>
      expect(slot.container.querySelector("[data-review-progress]")?.textContent).toContain("1 of 2 reviewed"),
    );
    const money = slot.container.querySelector("[data-file-card='src/money.js']")!;
    expect(within(money as HTMLElement).getByRole("button", { name: "Show src/money.js" })).toBeTruthy();
    const readme = slot.container.querySelector("[data-file-card='README.md']") as HTMLElement;
    fireEvent.click(within(readme).getByRole("button", { name: /Reviewed/ }));
    await waitFor(() =>
      expect(calls.setReviewed).toHaveBeenCalledWith({
        key: CHILD.key,
        marks: [{ mark: "committed\0README.md", signature: "modified:2:0:" }],
      }),
    );
  });

  it("collects a comment and sends it to the worktree's agent as one message", async () => {
    const { slot, calls } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`);
    const view = within(slot.container);
    await waitFor(() => expect(slot.container.querySelectorAll("[data-file-card]")).toHaveLength(2));
    fireEvent.click(view.getByRole("button", { name: "Comment on src/money.js" }));
    fireEvent.change(view.getByRole("textbox", { name: "Comment" }), { target: { value: "Round to the cent" } });
    fireEvent.click(view.getByRole("button", { name: "Add comment" }));
    expect(view.getByText("1 comment for Pricing")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Preview" }));
    expect(slot.container.querySelector("[data-review-preview]")?.textContent).toContain(
      "1. `src/money.js` (not committed)",
    );
    fireEvent.click(view.getByRole("button", { name: /Send to agent/ }));
    await waitFor(() => expect(calls.send).toHaveBeenCalledTimes(1));
    expect(calls.send.mock.calls[0]![0]).toMatchObject({ threadId: "thr_child", mode: "steer-if-active" });
    expect(JSON.stringify(calls.send.mock.calls[0]![0])).toContain("Round to the cent");
    await waitFor(() => expect(view.queryByText("1 comment for Pricing")).toBeNull());
  });

  it("warns about a file another worktree also changed, and offers to ask for a rebase", async () => {
    const { slot } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`);
    const view = within(slot.container);
    const strip = (await view.findAllByText(/also changed in/))[0]!.closest("[data-strip]") as HTMLElement;
    expect(strip.textContent).toMatch(/^1 file also changed in .+, so merging may conflict\./);
    expect(slot.container.querySelectorAll("[data-strip='warning']")).toHaveLength(1);
    expect(strip.querySelector("[title]")?.getAttribute("title")).toBe("README.md");
    fireEvent.click(within(strip).getByRole("button", { name: /Ask to rebase onto/ }));
    const drafts = comments.get(reviewDraftKey(CHILD.key, "thr_child"));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ path: "README.md", part: "committed" });
  });

  it("says which base it compared with when it picked a closer one, and offers the one bb records", async () => {
    const picked = tree({
      worktrees: [
        ROOT,
        {
          ...CHILD,
          base: "origin/main",
          skippedBase: { name: "master", aheadCount: 2794 },
          aheadCount: 1,
          behindCount: 0,
        },
        QUIET,
      ],
    });
    const { slot, calls } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, { overview: picked });
    const view = within(slot.container);
    const strip = (await view.findByText(/which would count/)).closest("[data-strip]") as HTMLElement;
    expect(strip.textContent).toBe(
      "Compared with origin/main, not master, which would count 2794 commits this branch did not add.Use master",
    );
    expect(slot.container.querySelector("[data-base-line]")?.textContent).toBe("vs origin/main · 1 ahead · 0 behind");
    // A long base name is cut short in the button, with all of it in the tooltip.
    expect(within(strip).getByRole("button", { name: "Use master" }).getAttribute("title")).toBe("Use master");
    expect(within(strip).getByRole("button", { name: "Use master" }).querySelector(".truncate")).not.toBeNull();
    fireEvent.click(within(strip).getByRole("button", { name: "Use master" }));
    await waitFor(() => expect(calls.setWhole).toHaveBeenCalledWith({ key: CHILD.key, whole: true }));
  });

  it("says when it left a branch's history out, and shows the whole branch when asked", async () => {
    const trimmed = tree({
      worktrees: [ROOT, { ...CHILD, leftOut: { aheadCount: 612, kept: 2 }, aheadCount: 2, behindCount: 3 }, QUIET],
    });
    const { slot, calls } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, { overview: trimmed });
    const view = within(slot.container);
    const strip = (await view.findByText(/ahead of/)).closest("[data-strip]") as HTMLElement;
    expect(strip.textContent).toBe(
      "This branch is 612 commits ahead of origin/main, and its threads made 2 of them. Showing those 2 and the uncommitted files.Show all 612",
    );
    expect(slot.container.querySelector("[data-base-line]")?.textContent).toBe("vs origin/main · 612 ahead · 3 behind");
    fireEvent.click(within(strip).getByRole("button", { name: "Show all 612" }));
    await waitFor(() => expect(calls.setWhole).toHaveBeenCalledWith({ key: CHILD.key, whole: true }));
  });

  it("says so when the whole-branch choice could not be saved, and lets the button be clicked again", async () => {
    const { toast } = await import("sonner");
    const picked = tree({ worktrees: [ROOT, { ...CHILD, skippedBase: { name: "master", aheadCount: 2794 } }, QUIET] });
    const { slot, calls } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, { overview: picked });
    calls.setWhole.mockRejectedValueOnce(new Error("kv is down"));
    const button = await within(slot.container).findByRole("button", { name: "Use master" });
    fireEvent.click(button);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("kv is down")));
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("offers a rebase onto the worktree it shares the most files with when it shares files with several", async () => {
    const other = worktree({
      key: "host_1:/work/other",
      threadIds: ["thr_quiet"],
      root: "/work/other",
      label: "Shop",
      uncommitted: [fileChange({ path: "README.md" })],
    });
    const shared = tree({
      worktrees: [ROOT, CHILD, other],
      sharedFiles: [
        sharedFile({ projectId: "proj_1", path: "README.md", worktreeKeys: [ROOT.key, CHILD.key, other.key] }),
      ],
    });
    const { slot } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, { overview: shared });
    const strip = (await within(slot.container).findAllByText(/also changed in/))[0]!.closest(
      "[data-strip]",
    ) as HTMLElement;
    expect(strip.textContent).toMatch(/1 file also changed in .+, and 1 in /);
    expect(within(strip).getByRole("button", { name: /Ask to rebase onto/ })).toBeTruthy();
  });

  it("offers to count only its threads' work again for a worktree shown whole", async () => {
    const whole = tree({ worktrees: [ROOT, { ...CHILD, whole: true }, QUIET] });
    const { slot, calls } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, { overview: whole });
    fireEvent.click(await within(slot.container).findByRole("button", { name: "Count only its work" }));
    await waitFor(() => expect(calls.setWhole).toHaveBeenCalledWith({ key: CHILD.key, whole: false }));
  });

  it("shows a folded untracked folder as one line no count includes, with its files on request", async () => {
    const folder = fileChange({
      path: "vendor/",
      status: "untracked",
      untracked: true,
      additions: null,
      deletions: null,
      folder: { files: 3000, repository: false, sample: ["vendor/a.js", "vendor/b.js"] },
    });
    const folded = tree({ worktrees: [ROOT, { ...CHILD, uncommitted: [...CHILD.uncommitted, folder] }, QUIET] });
    const { slot, calls } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, { overview: folded });
    const view = within(slot.container);
    const row = await waitFor(() => {
      const found = slot.container.querySelector("[data-folder='vendor/']");
      if (found === null) throw new Error("no folder yet");
      return found as HTMLElement;
    });
    expect(row.textContent).toContain("untracked · 3000 files · not counted");
    expect(slot.container.querySelector("[data-file-card='vendor/']")).toBeNull();
    expect(view.getByRole("button", { name: /^Checkout changes/ }).textContent).toBe("Checkout changes2");
    fireEvent.click(within(row).getByRole("button", { name: "Show files" }));
    expect(row.textContent).toContain("vendor/a.js");
    expect(row.textContent).toContain("and 2998 more files");
    expect(calls.patch.mock.calls.some(([input]) => input.path === "vendor/")).toBe(false);
  });

  it("compares an overlapping file on the overlaps page and guesses whether it will conflict", async () => {
    const { slot } = await mount("tree/thr_root/overlaps");
    const card = await waitFor(() => {
      const found = slot.container.querySelector("[data-overlap='README.md']");
      if (found === null) throw new Error("no card yet");
      return found as HTMLElement;
    });
    await waitFor(() => expect(card.querySelector("[data-verdict='conflict']")).not.toBeNull());
  });

  it("shows every change by repository in All changes", async () => {
    const { slot } = await mount("tree/thr_root/changes", {
      overview: tree({
        repos: [
          {
            key: "repo_1",
            ref: { kind: "workspace", environmentId: "env_1", base: "origin/main" },
            label: "Shop",
            projectId: "proj_1",
            root: "/work/root",
            hostId: "host_1",
            hostName: "Laptop",
            branch: "main",
            base: null,
            aheadCount: null,
            threadIds: ["thr_root"],
            state: "ready",
            message: null,
            files: [fileChange({ path: "README.md" })],
            otherFiles: [],
            truncated: false,
            totals: { files: 1, additions: 2, deletions: 1 },
            threadCommits: [],
          },
        ],
      }),
    });
    await waitFor(() =>
      expect(slot.container.querySelector("[data-all-changes] [data-file-card='README.md']")).not.toBeNull(),
    );
    const section = slot.container.querySelector("[data-all-changes]") as HTMLElement;
    fireEvent.click(within(section).getByRole("button", { name: "Collapse all diffs" }));
    expect(within(section).getByRole("button", { name: "Show README.md" })).toBeTruthy();
    fireEvent.keyDown(section, { key: "x" });
    expect(within(section).getByRole("button", { name: "Hide README.md" })).toBeTruthy();
  });

  it("titles the page with the worktree, or with the scope when none is selected", async () => {
    const { slot } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`);
    await waitFor(() =>
      expect(slot.inspection.experimental_pageTitle).toEqual({ title: "Pricing", windowTitle: "Vantage · Pricing" }),
    );
    const scope = await mount("tree/thr_root/overlaps");
    await waitFor(() =>
      expect(scope.slot.inspection.experimental_pageTitle).toEqual({
        title: "Overlapping files",
        windowTitle: "Vantage · Overlapping files",
      }),
    );
  });
});

describe("the page's sidebar", () => {
  it("groups the worktrees by what needs doing and hides those with no changes", async () => {
    const { slot } = await mount("tree/thr_root", {}, "sidebar");
    const view = within(slot.container);
    await waitFor(() => expect(slot.container.querySelectorAll("[data-worktree-row]")).toHaveLength(2));
    expect(
      [...slot.container.querySelectorAll("[data-worktree-group]")].map((group) =>
        group.getAttribute("data-worktree-group"),
      ),
    ).toEqual(["Waiting on you", "Ready to review"]);
    expect(view.getByText("1 worktree with no changes is hidden.")).toBeTruthy();
    expect(view.getByText("Tree: Holiday sale")).toBeTruthy();
    // The row says what it needs in a sentence, not in git's words.
    expect(view.getByText(/The agent asked you a question/)).toBeTruthy();
    expect(view.queryByText(/uncommitted/)).toBeNull();
  });

  it("folds a group of worktrees and keeps it folded, still showing the open worktree", async () => {
    const first = await mount("tree/thr_root", {}, "sidebar");
    await waitFor(() => expect(first.slot.container.querySelectorAll("[data-worktree-row]")).toHaveLength(2));
    fireEvent.click(within(first.slot.container).getByRole("button", { name: "Waiting on you" }));
    const rows = (slot: Slot) =>
      [...slot.container.querySelectorAll("[data-worktree-row]")].map((row) => row.getAttribute("data-worktree-row"));
    expect(rows(first.slot)).toEqual([ROOT.key]);
    const back = await comeBack(first.slot, `tree/thr_root/worktree/${key(CHILD.key)}`, {}, "sidebar");
    await waitFor(() =>
      expect(back.slot.container.querySelector("[data-worktree-group='Waiting on you']")).not.toBeNull(),
    );
    expect(
      within(back.slot.container).getByRole("button", { name: "Waiting on you" }).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(rows(back.slot)).toEqual([CHILD.key, ROOT.key]);
  });

  it("files a thread that waits for you under Waiting on you", async () => {
    const { slot } = await mount("tree/thr_root", {}, "sidebar");
    await waitFor(() => expect(slot.container.querySelector("[data-worktree-group='Waiting on you']")).not.toBeNull());
    expect(within(slot.container).getByRole("button", { name: /1Waiting on you/ })).toBeTruthy();
  });

  it("opens a worktree on the page", async () => {
    const { slot } = await mount("tree/thr_root", {}, "sidebar");
    const row = await waitFor(() => {
      const found = slot.container.querySelector(`[data-worktree-row='${CHILD.key}']`);
      if (found === null) throw new Error("no row yet");
      return found as HTMLElement;
    });
    fireEvent.click(row);
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "vantage",
      options: { subPath: `tree/thr_root/worktree/${key(CHILD.key)}` },
    });
  });
});

describe("the Agent tab", () => {
  it("asks for a worktree when none is selected", async () => {
    const { slot } = await mount("tree/thr_root", {}, "agent");
    expect(within(slot.container).getByText("Select a worktree to talk to its agent here.")).toBeTruthy();
  });
});
