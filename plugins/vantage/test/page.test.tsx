import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { Overview, PatchRequest, rpcContract } from "../src/contract";
import { clearLoadedCache } from "../src/loaded";
import { disposeSessions } from "../src/session";
import { comments } from "../src/shared";
import { pageChip, pageText, reloadUiState } from "../src/ui-prefs";
import { fileChange, overview, sharedFile, sidebarThread, threadSummary, worktree } from "./fixtures";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const ROOT = worktree({
  key: "host_1:/work/root", threadIds: ["thr_root"], root: "/work/root", branch: "main", label: "Shop",
  uncommitted: [fileChange({ path: "README.md", additions: 4, deletions: 0 })],
});
const CHILD = worktree({
  key: "host_1:/work/child", threadIds: ["thr_child"], root: "/work/child", branch: "bb/pricing", label: "Shop",
  ref: { kind: "workspace", environmentId: "env_child", base: "origin/main" },
  uncommitted: [fileChange({ path: "src/money.js", additions: 6, deletions: 0 })],
  committed: [fileChange({ path: "README.md", additions: 2, deletions: 0 })],
  commits: [{ sha: "a".repeat(40), shortSha: "aaaaaaa", subject: "Document the sale", authorName: "Ada", authoredAt: 1 }],
  aheadCount: 1,
});
const QUIET = worktree({ key: "host_1:/work/quiet", threadIds: ["thr_quiet"], root: "/work/quiet", label: "Shop" });

const SIDEBAR = [
  sidebarThread({ id: "thr_root", displayTitle: "Holiday sale" }),
  sidebarThread({ id: "thr_child", displayTitle: "Pricing", parentThreadId: "thr_root", indicator: "waiting-for-input", indicatorLabel: "Thread needs user input" }),
  sidebarThread({ id: "thr_quiet", displayTitle: "Quiet", parentThreadId: "thr_root" }),
];

function tree(overrides: Partial<Overview> = {}): Overview {
  return overview({
    threadId: "thr_root", target: { kind: "tree", threadId: "thr_root" },
    threads: [
      threadSummary({ id: "thr_root", title: "Holiday sale" }),
      threadSummary({ id: "thr_child", title: "Pricing", parentThreadId: "thr_root", depth: 1, rootThreadId: "thr_root" }),
      threadSummary({ id: "thr_quiet", title: "Quiet", parentThreadId: "thr_root", depth: 1, rootThreadId: "thr_root" }),
    ],
    worktrees: [ROOT, CHILD, QUIET],
    sharedFiles: [sharedFile({ projectId: "proj_1", path: "README.md", worktreeKeys: [ROOT.key, CHILD.key] })],
    ...overrides,
  });
}

const key = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, (character) => `~${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
type Slot = ReturnType<typeof renderSlot>;
const mounts: Slot[] = [];

beforeEach(() => { pageText.set(""); pageChip.set(null); });
afterEach(() => {
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  disposeSessions();
  clearLoadedCache();
  for (const draft of ["host_1:/work/child", "host_1:/work/root"]) comments.clear(draft);
  document.body.replaceChildren();
  window.localStorage.clear();
  reloadUiState();
});

interface Options { overview?: Overview; marks?: Record<string, Record<string, string>> }

async function mount(subPath: string, options: Options = {}, part: "page" | "sidebar" | "agent" = "page") {
  const app = await loadPluginApp(() => import("../app"));
  const page = app.navPanels[0]!;
  const stored: Record<string, Record<string, string>> = { ...options.marks };
  const calls = {
    patch: vi.fn(async (input: PatchRequest) => ({ patch: `@@ -1,1 +1,2 @@\n line\n+${input.scope} ${input.path}`, truncated: false, binary: false })),
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
    send: vi.fn(async (_input: { threadId: string; mode: string; input: unknown[] }) => ({ ok: true, delivery: "sent" })),
    commitFiles: vi.fn(async () => ({ files: [fileChange({ path: "README.md", additions: 2, deletions: 0 })] })),
  };
  const registration = part === "page" ? page : part === "sidebar" ? { component: page.experimental_sidebar! } : app.tabs.find((tab) => tab.id === "agent")!;
  const slot = renderSlot<PluginNavPanelProps, typeof rpcContract>(registration as never, { subPath }, {
    pluginId: "vantage",
    rpc: {
      shell: () => new Promise<Overview>(() => {}),
      overview: () => options.overview ?? tree(),
      patch: calls.patch,
      fileSides: () => ({ old: null, new: null }),
      recordedEdits: () => ({ edits: [] }),
      commitFiles: calls.commitFiles,
      reviewed: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map((entry) => [entry, stored[entry] ?? {}])),
      setReviewed: calls.setReviewed,
    } as never,
    sdk: { subscribe: (() => () => {}) as never, threads: { send: calls.send as never, retry: vi.fn() as never }, terminals: { create: vi.fn() as never } },
    sidebarThreads: { status: "ready", threads: SIDEBAR },
    threadActions: (() => []) as never,
  });
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

const treeFiles = (container: HTMLElement) => [...container.querySelectorAll("[data-file-tree] [data-tree-file]")].map((row) => row.getAttribute("data-tree-file"));

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
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel", path: "vantage",
      options: { subPath: `tree/thr_root/worktree/${key(CHILD.key)}`, replace: true },
    }));
  });

  it("offers the repository view when no worktree exists to open", async () => {
    const { slot } = await mount("tree/thr_root", { overview: tree({ worktrees: [] }) });
    const view = within(slot.container);
    await view.findByText("No worktree in this thread or its child threads has changes yet.");
    fireEvent.click(view.getByRole("button", { name: "See every change by repository" }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "vantage", options: { subPath: "tree/thr_root/changes" } });
  });

  it("opens a worktree with every change as a diff, and narrows to what is committed or one commit", async () => {
    const { slot, calls } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`);
    const view = within(slot.container);
    await waitFor(() => expect(slot.container.querySelectorAll("[data-file-card]")).toHaveLength(2));
    await waitFor(() => expect(calls.patch).toHaveBeenCalledTimes(2));
    expect([...slot.container.querySelectorAll("[data-file-card]")].map((card) => card.getAttribute("data-file-card"))).toEqual(["src/money.js", "README.md"]);
    fireEvent.click(view.getByRole("button", { name: /^Committed/ }));
    expect([...slot.container.querySelectorAll("[data-file-card]")].map((card) => card.getAttribute("data-file-card"))).toEqual(["README.md"]);
    fireEvent.click(view.getByRole("button", { name: /Commits 1/ }));
    fireEvent.click(view.getByRole("menuitemradio", { name: /Document the sale/ }));
    await waitFor(() => expect(calls.commitFiles).toHaveBeenCalledWith({ ref: CHILD.ref, sha: "a".repeat(40) }));
  });

  it("collapses every diff at once and expands them again, with the button or X", async () => {
    const marks = { [CHILD.key]: { "uncommitted\0src/money.js": "modified:6:0:" } };
    const { slot } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, { marks });
    const view = within(slot.container);
    await waitFor(() => expect(view.getByRole("button", { name: "Show src/money.js" })).toBeTruthy());
    const open = () => [...slot.container.querySelectorAll("[data-file-card] header button[aria-expanded]")].map((button) => button.getAttribute("aria-expanded"));
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
    await waitFor(() => expect(within(other.slot.container).getByRole("button", { name: "Show README.md" })).toBeTruthy());
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
    const { slot } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, { overview: tree({ worktrees: [ROOT, committedOnly, QUIET] }) });
    const view = within(slot.container);
    await waitFor(() => expect(view.getByRole("button", { name: /^All changes/ }).getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(view.getByRole("button", { name: /^Not committed/ }));
    expect(view.getByRole("button", { name: /^Not committed/ }).getAttribute("aria-pressed")).toBe("true");
    expect(view.getByText("Nothing uncommitted.")).toBeTruthy();
  });

  it("keeps a folder folded when another scope joins it with the folder inside", async () => {
    const split = worktree({
      ...CHILD, uncommitted: [fileChange({ path: "src/lib/round.js" })], committed: [fileChange({ path: "src/money.js" }), fileChange({ path: "README.md" })],
    });
    const { slot } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, { overview: tree({ worktrees: [ROOT, split, QUIET] }) });
    const view = within(slot.container);
    await waitFor(() => expect(treeFiles(slot.container)).toEqual(["src/lib/round.js", "src/money.js", "README.md"]));
    fireEvent.click(view.getByRole("button", { name: "src folder" }));
    fireEvent.click(view.getByRole("button", { name: /^Not committed/ }));
    expect(view.getByRole("button", { name: "src/lib folder" }).getAttribute("aria-expanded")).toBe("false");
    expect(treeFiles(slot.container)).toEqual([]);
    fireEvent.click(view.getByRole("button", { name: "src/lib folder" }));
    fireEvent.click(view.getByRole("button", { name: /^All changes/ }));
    expect(treeFiles(slot.container)).toEqual(["src/lib/round.js", "src/money.js", "README.md"]);
  });

  it("wraps long lines in every diff with the button or W, and remembers it", async () => {
    const { slot } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`);
    const overflow = () => [...slot.container.querySelectorAll("[data-testid='bb-diff']")].map((diff) => diff.getAttribute("data-overflow"));
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
    await waitFor(() => expect(within(back.slot.container).getByRole("button", { name: /^Committed/ }).getAttribute("aria-pressed")).toBe("true"));
    expect([...back.slot.container.querySelectorAll("[data-file-card]")].map((card) => card.getAttribute("data-file-card"))).toEqual(["README.md"]);
  });

  it("lists the files as a tree whose folders fold, and keeps them folded across a reload", async () => {
    const deep = worktree({ ...CHILD, uncommitted: [fileChange({ path: "src/money.js" }), fileChange({ path: "src/lib/round.js" })] });
    const options = { overview: tree({ worktrees: [ROOT, deep, QUIET] }) };
    const first = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, options);
    await waitFor(() => expect(treeFiles(first.slot.container)).toEqual(["src/lib/round.js", "src/money.js", "README.md"]));
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
    await waitFor(() => expect(calls.setReviewed).toHaveBeenCalledWith({ key: CHILD.key, marks: [{ mark: "uncommitted\0src/money.js", signature: "modified:6:0:" }] }));
    await waitFor(() => expect(slot.container.querySelector("[data-review-progress]")?.textContent).toContain("1 of 2 reviewed"));
    expect(view.getByRole("button", { name: "Hide reviewed" })).toBeTruthy();
  });

  it("lists only the files the stream shows when reviewed ones are hidden", async () => {
    const marks = { [CHILD.key]: { "uncommitted\0src/money.js": "modified:6:0:" } };
    const { slot } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, { marks });
    await waitFor(() => expect(slot.container.querySelector("[data-review-progress]")?.textContent).toContain("1 of 2 reviewed"));
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
    calls.send.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
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
    expect(comments.get(CHILD.key).map((entry) => entry.text)).toEqual(["Second"]);
  });

  it("keeps a comment edited while it was being sent, with its new text", async () => {
    const { slot, calls } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`);
    const view = within(slot.container);
    await waitFor(() => expect(slot.container.querySelectorAll("[data-file-card]")).toHaveLength(2));
    let finish: (value: { ok: true; delivery: "sent" }) => void = () => {};
    calls.send.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(view.getByRole("button", { name: "Comment on src/money.js" }));
    fireEvent.change(view.getByRole("textbox", { name: "Comment" }), { target: { value: "Round to the cent" } });
    fireEvent.click(view.getByRole("button", { name: "Add comment" }));
    fireEvent.click(view.getByRole("button", { name: /Send to agent/ }));
    fireEvent.click(view.getByRole("button", { name: "Edit comment" }));
    fireEvent.change(view.getByRole("textbox", { name: "Comment" }), { target: { value: "Round half up to the cent" } });
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    finish({ ok: true, delivery: "sent" });
    await waitFor(() => expect(calls.send).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(calls.send.mock.calls[0]![0])).toContain("Round to the cent");
    await waitFor(() => expect(comments.get(CHILD.key).map((entry) => entry.text)).toEqual(["Round half up to the cent"]));
    expect(view.getByText("1 comment for Pricing")).toBeTruthy();
  });

  it("ticks a file as reviewed and folds a reviewed file away", async () => {
    const marks = { [CHILD.key]: { "uncommitted\0src/money.js": "modified:6:0:" } };
    const { slot, calls } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`, { marks });
    await waitFor(() => expect(slot.container.querySelector("[data-review-progress]")?.textContent).toContain("1 of 2 reviewed"));
    const money = slot.container.querySelector("[data-file-card='src/money.js']")!;
    expect(within(money as HTMLElement).getByRole("button", { name: "Show src/money.js" })).toBeTruthy();
    const readme = slot.container.querySelector("[data-file-card='README.md']") as HTMLElement;
    fireEvent.click(within(readme).getByRole("button", { name: /Reviewed/ }));
    await waitFor(() => expect(calls.setReviewed).toHaveBeenCalledWith({ key: CHILD.key, marks: [{ mark: "committed\0README.md", signature: "modified:2:0:" }] }));
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
    expect(slot.container.querySelector("[data-review-preview]")?.textContent).toContain("1. `src/money.js` (not committed)");
    fireEvent.click(view.getByRole("button", { name: /Send to agent/ }));
    await waitFor(() => expect(calls.send).toHaveBeenCalledTimes(1));
    expect(calls.send.mock.calls[0]![0]).toMatchObject({ threadId: "thr_child", mode: "steer-if-active" });
    expect(JSON.stringify(calls.send.mock.calls[0]![0])).toContain("Round to the cent");
    await waitFor(() => expect(view.queryByText("1 comment for Pricing")).toBeNull());
  });

  it("warns about a file another worktree also changed, and offers to ask for a rebase", async () => {
    const { slot } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`);
    const view = within(slot.container);
    const strip = (await view.findAllByText(/is also changed in/))[0]!.closest("[data-strip]") as HTMLElement;
    expect(strip.textContent).toContain("README.md");
    fireEvent.click(within(strip).getByRole("button", { name: /Ask to rebase onto/ }));
    expect(comments.get(CHILD.key)).toHaveLength(1);
    expect(comments.get(CHILD.key)[0]).toMatchObject({ path: "README.md", part: "committed" });
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
        repos: [{
          key: "repo_1", ref: { kind: "workspace", environmentId: "env_1", base: "origin/main" }, label: "Shop", projectId: "proj_1", root: "/work/root",
          hostId: "host_1", hostName: "Laptop", branch: "main", base: null, aheadCount: null, threadIds: ["thr_root"], state: "ready", message: null,
          files: [fileChange({ path: "README.md" })], otherFiles: [], truncated: false, totals: { files: 1, additions: 2, deletions: 1 }, threadCommits: [],
        }],
      }),
    });
    await waitFor(() => expect(slot.container.querySelector("[data-all-changes] [data-file-card='README.md']")).not.toBeNull());
    const section = slot.container.querySelector("[data-all-changes]") as HTMLElement;
    fireEvent.click(within(section).getByRole("button", { name: "Collapse all diffs" }));
    expect(within(section).getByRole("button", { name: "Show README.md" })).toBeTruthy();
    fireEvent.keyDown(section, { key: "x" });
    expect(within(section).getByRole("button", { name: "Hide README.md" })).toBeTruthy();
  });

  it("titles the page with the worktree, or with the scope when none is selected", async () => {
    const { slot } = await mount(`tree/thr_root/worktree/${key(CHILD.key)}`);
    await waitFor(() => expect(slot.inspection.experimental_pageTitle).toEqual({ title: "Pricing", windowTitle: "Vantage · Pricing" }));
    const scope = await mount("tree/thr_root/overlaps");
    await waitFor(() => expect(scope.slot.inspection.experimental_pageTitle).toEqual({ title: "Overlapping files", windowTitle: "Vantage · Overlapping files" }));
  });
});

describe("the page's sidebar", () => {
  it("groups the worktrees by what needs doing and hides those with no changes", async () => {
    const { slot } = await mount("tree/thr_root", {}, "sidebar");
    const view = within(slot.container);
    await waitFor(() => expect(slot.container.querySelectorAll("[data-worktree-row]")).toHaveLength(2));
    expect([...slot.container.querySelectorAll("[data-worktree-group]")].map((group) => group.getAttribute("data-worktree-group"))).toEqual(["Waiting on you", "Ready to review"]);
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
    const rows = (slot: Slot) => [...slot.container.querySelectorAll("[data-worktree-row]")].map((row) => row.getAttribute("data-worktree-row"));
    expect(rows(first.slot)).toEqual([ROOT.key]);
    const back = await comeBack(first.slot, `tree/thr_root/worktree/${key(CHILD.key)}`, {}, "sidebar");
    await waitFor(() => expect(back.slot.container.querySelector("[data-worktree-group='Waiting on you']")).not.toBeNull());
    expect(within(back.slot.container).getByRole("button", { name: "Waiting on you" }).getAttribute("aria-expanded")).toBe("false");
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
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "vantage", options: { subPath: `tree/thr_root/worktree/${key(CHILD.key)}` } });
  });
});

describe("the Agent tab", () => {
  it("asks for a worktree when none is selected", async () => {
    const { slot } = await mount("tree/thr_root", {}, "agent");
    expect(within(slot.container).getByText("Select a worktree to talk to its agent here.")).toBeTruthy();
  });
});
