import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { CommitFilesInput, CommitFilesOutput, Overview, OverviewInput, PatchOutput, PatchRequest, Repo, ShellInput, Worktree, rpcContract } from "../src/contract";
import { clearFileCache } from "../src/file-row";
import type { RepoFocus } from "../src/filters";
import { VIEW_STORAGE_KEY } from "../src/view-preference";
import { WorktreeDetail, relativeTime, type WorktreeDetailProps } from "../src/worktree-detail";
import { LiveThreadsProvider, WorktreeList } from "../src/worktree-list";
import {
  branchWorktree, checkoutRepo, checkoutWorktree, commit, fileChange, overview as makeOverview, repo, sharedFile, sidebarPullRequest, sidebarThread, threadSummary, worktree,
} from "./fixtures";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

type Slot = ReturnType<typeof renderSlot>;

const mounts: Slot[] = [];
afterEach(() => {
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  clearFileCache();
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
});

const THREADS = [
  threadSummary({ id: "thr_1", title: "Parent thread" }),
  threadSummary({ id: "thr_2", title: "Child A", parentThreadId: "thr_1", depth: 1, environmentId: "env_2" }),
  threadSummary({ id: "thr_3", title: "Child B", parentThreadId: "thr_1", depth: 1, environmentId: "env_3" }),
  threadSummary({ id: "thr_4", title: "Archived child", parentThreadId: "thr_1", depth: 1, archived: true, environmentId: "env_4" }),
  threadSummary({ id: "thr_5", title: "Hidden child", parentThreadId: "thr_1", depth: 1, environmentId: "env_5" }),
  threadSummary({ id: "thr_6", title: "Other project child", parentThreadId: "thr_1", depth: 1, environmentId: "env_6" }),
];

const WORKTREES = [
  worktree({ key: "wt0", threadIds: ["thr_1"], branch: "feature/main", aheadCount: 0, behindCount: 0 }),
  worktree({
    key: "wt1", threadIds: ["thr_2"], branch: "agent/a", aheadCount: 2, behindCount: 1,
    uncommitted: [fileChange({ path: "a.ts", additions: 3, deletions: 1 }), fileChange({ path: "README.md", additions: 2, deletions: 0 })],
    committed: [fileChange({ path: "c.ts", additions: 10, deletions: 0 })],
    commits: [
      commit({ sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", shortSha: "a1b2c3d", subject: "Add the thing", authorName: "Ada", authoredAt: Date.now() - 12 * 60_000 }),
      commit({ sha: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3", shortSha: "b2c3d4e", subject: "Fix the other thing", authorName: "Grace", authoredAt: Date.now() - 3 * 3_600_000 }),
    ],
  }),
  worktree({ key: "wt2", threadIds: ["thr_3"], branch: "agent/b", aheadCount: 0, behindCount: 0, uncommitted: [fileChange({ path: "README.md" })] }),
  branchWorktree({ key: "wt3", threadIds: ["thr_4"], branch: "agent/old", aheadCount: 1, behindCount: 0, committed: [fileChange({ path: "old.ts" })] }),
  worktree({ key: "wt4", threadIds: ["thr_5"], branch: null, state: "unavailable", message: "Folder is gone", aheadCount: null, behindCount: null }),
  worktree({ key: "wt5", projectId: "proj_2", label: "Other project", threadIds: ["thr_6"], branch: "other/x", aheadCount: 0, behindCount: 0 }),
];

function sampleOverview(overrides: Partial<Overview> = {}): Overview {
  return makeOverview({
    threads: THREADS, worktrees: WORKTREES,
    sharedFiles: [sharedFile({ path: "README.md", worktreeKeys: ["wt1", "wt2"] })],
    repos: [checkoutRepo({ label: "commons", files: [fileChange({ additions: 4, deletions: 1 })], threadIds: ["thr_4"] })],
    otherFiles: [fileChange({ path: "/tmp/notes.txt" })],
    ...overrides,
  });
}

const SIDEBAR: PluginSidebarThread[] = [
  sidebarThread({ id: "thr_1", displayTitle: "Parent thread", indicator: "runtime" }),
  sidebarThread({ id: "thr_2", displayTitle: "Child A (live)", indicator: "waiting-for-input", indicatorLabel: "Thread needs user input" }),
  sidebarThread({ id: "thr_3", displayTitle: "Child B", indicator: "unread-error" }),
  sidebarThread({ id: "thr_4", displayTitle: "Archived child", isArchived: true, archivedAt: 5, indicator: "none" }),
  sidebarThread({ id: "thr_6", displayTitle: "Other project child", indicator: "unread-success" }),
];

const row = (slot: Slot, key: string): HTMLElement => {
  const found = slot.container.querySelector<HTMLElement>(`[data-worktree-row="${key}"]`);
  if (found === null) throw new Error(`no row ${key}`);
  return found;
};

function mountList(options: {
  overview?: Overview; onOpen?: (key: string) => void; onShowRepositories?: (focus: RepoFocus) => void; pullRequests?: Record<string, ReturnType<typeof sidebarPullRequest>>;
  currentThreadId?: string | null; selectedKey?: string | null; worktrees?: readonly Worktree[]; showSummary?: boolean;
} = {}) {
  const onOpen = options.onOpen ?? vi.fn();
  const onShowRepositories = options.onShowRepositories ?? vi.fn();
  const slot = renderSlot({
    component: () => (
      <LiveThreadsProvider>
        <WorktreeList overview={options.overview ?? sampleOverview()} currentThreadId={options.currentThreadId === undefined ? "thr_1" : options.currentThreadId}
          selectedKey={options.selectedKey} worktrees={options.worktrees} showSummary={options.showSummary} onOpen={onOpen} onShowRepositories={onShowRepositories} />
      </LiveThreadsProvider>
    ),
  }, {}, { sidebarThreads: { status: "ready", threads: SIDEBAR }, sidebarPullRequests: options.pullRequests ?? {} });
  mounts.push(slot);
  return { slot, onOpen, onShowRepositories };
}

describe("WorktreeList", () => {
  it("summarises the workspaces by what bb says each thread is doing", () => {
    const { slot } = mountList();
    expect(slot.container.textContent).toContain("6 workspaces · 1 running · 1 needs you · 1 failed");
  });

  it("shows one row for each worktree, the parent's own reading 'This thread'", () => {
    const { slot } = mountList();
    expect(slot.container.querySelectorAll("[data-worktree-row]")).toHaveLength(6);
    expect(row(slot, "wt0").textContent).toContain("This thread");
    expect(row(slot, "wt1").textContent).toContain("Child A (live)");
    expect(row(slot, "wt1").textContent).toContain("agent/a");
  });

  it("draws bb's own status glyph for each row", () => {
    const { slot } = mountList();
    expect(row(slot, "wt0").querySelector('[data-thread-status-glyph="runtime"]')).not.toBeNull();
    expect(row(slot, "wt1").querySelector('[data-thread-status-glyph="waiting-for-input"]')).not.toBeNull();
    expect(row(slot, "wt2").querySelector('[data-thread-status-glyph="unread-error"]')).not.toBeNull();
    expect(row(slot, "wt3").querySelector('[data-thread-status-glyph="archived"]')).not.toBeNull();
  });

  it("shows commits ahead and behind, uncommitted files and the line counts", () => {
    const { slot } = mountList();
    const second = row(slot, "wt1");
    expect(second.textContent).toContain("↑2 ↓1");
    expect(second.textContent).toContain("2 uncommitted");
    expect(within(second).getByText("+15")).toBeTruthy();
    expect(within(second).getByText("−1")).toBeTruthy();
    expect(row(slot, "wt0").textContent).toContain("clean");
  });

  it("badges a row that needs you or failed, and one that shares files", () => {
    const { slot } = mountList();
    expect(within(row(slot, "wt1")).getByText("Needs you")).toBeTruthy();
    expect(within(row(slot, "wt2")).getByText("Failed")).toBeTruthy();
    expect(within(row(slot, "wt1")).getByText("1 shared")).toBeTruthy();
    expect(within(row(slot, "wt2")).getByText("1 shared")).toBeTruthy();
    expect(row(slot, "wt0").textContent).not.toContain("shared");
    expect(row(slot, "wt0").textContent).not.toContain("Needs you");
  });

  it("shows the pull request, coloured by how ready it is", () => {
    const { slot } = mountList({
      pullRequests: {
        thr_2: sidebarPullRequest({ number: 12, state: "open", attention: "ready_to_merge" }),
        thr_3: sidebarPullRequest({ number: 13, state: "open", attention: "checks_failed" }),
        thr_6: sidebarPullRequest({ number: 14, state: "draft", attention: "draft" }),
      },
    });
    const ready = within(row(slot, "wt1")).getByText("#12 open");
    expect(ready.className).toContain("text-success");
    expect(within(row(slot, "wt2")).getByText("#13 open").className).toContain("text-destructive-text");
    expect(within(row(slot, "wt5")).getByText("#14 draft").className).toContain("text-muted-foreground");
    expect(row(slot, "wt0").textContent).not.toContain("#");
  });

  it("falls back to the overview's title for a thread bb's sidebar does not list, and marks an unavailable worktree", () => {
    const { slot } = mountList();
    const hidden = row(slot, "wt4");
    expect(hidden.textContent).toContain("Hidden child");
    const unavailable = within(hidden).getByText("unavailable");
    expect(unavailable.className).toContain("text-destructive-text");
    expect(hidden.querySelector("[data-thread-status-glyph]")).toBeNull();
  });

  it("collapses the files changed in more than one worktree into a banner that opens to list them", () => {
    const { slot } = mountList();
    const banner = slot.getByRole("button", { name: /1 file is changed in more than one worktree/ });
    expect(banner.getAttribute("aria-expanded")).toBe("false");
    expect(slot.container.textContent).not.toContain("Child A (live), Child B");
    fireEvent.click(banner);
    expect(banner.getAttribute("aria-expanded")).toBe("true");
    expect(slot.container.textContent).toContain("README.md");
    expect(slot.container.textContent).toContain("Child A (live), Child B");
  });

  it("has no banner without shared files", () => {
    const { slot } = mountList({ overview: sampleOverview({ sharedFiles: [] }) });
    expect(slot.container.textContent).not.toContain("changed in more than one worktree");
  });

  it("groups the rows by project, in tree order, with archived rows in their own group at the end", () => {
    const { slot } = mountList();
    const groups = [...slot.container.querySelectorAll("[data-worktree-group]")].map((node) => node.textContent);
    expect(groups).toEqual(["Project · 4 workspaces", "Other project · 1 worktree", "Archived · Project · 1 archived branch"]);
  });

  it("names the machine in the group only when the tree spans more than one", () => {
    const single = mountList();
    expect(single.slot.container.textContent).not.toContain("Dev box");
    single.slot.lifecycle.unmount();
    const { slot } = mountList({ overview: sampleOverview({ worktrees: [...WORKTREES.slice(0, 5), { ...WORKTREES[5]!, hostId: "host_2", hostName: "Dev box" }] }) });
    expect(slot.container.querySelector('[data-worktree-group="Other project"]')!.textContent).toContain("Dev box");
  });

  it("opens a worktree when its row is clicked", () => {
    const { slot, onOpen } = mountList();
    fireEvent.click(row(slot, "wt2"));
    expect(onOpen).toHaveBeenCalledWith("wt2");
  });

  it("links to the repositories view, focused on the row clicked, from the changes made outside worktrees", () => {
    const { slot, onShowRepositories } = mountList();
    expect(slot.container.textContent).toContain("Changed outside worktrees");
    const commons = slot.getByRole("button", { name: /commons/ });
    expect(commons.textContent).toContain("1 file");
    fireEvent.click(commons);
    fireEvent.click(slot.getByRole("button", { name: /Other files/ }));
    expect(onShowRepositories).toHaveBeenNthCalledWith(1, { kind: "repo", key: "host_1:/code/commons" });
    expect(onShowRepositories).toHaveBeenNthCalledWith(2, { kind: "otherFiles" });
  });

  it("lists a checkout a thread works in as a worktree row, not as a change outside worktrees", () => {
    const side = checkoutWorktree({ threadIds: ["thr_1"] });
    const { slot } = mountList({ overview: sampleOverview({
      worktrees: [side], otherFiles: [],
      repos: [checkoutRepo({ key: side.key, ref: side.ref as Repo["ref"], label: "side", root: side.root })],
    }) });
    expect(row(slot, side.key).textContent).toContain("side-work· in clones/side");
    expect(slot.container.textContent).not.toContain("Changed outside worktrees");
  });

  it("leaves out the outside section when only worktrees changed", () => {
    const { slot } = mountList({ overview: sampleOverview({ repos: [], otherFiles: [] }) });
    expect(slot.container.textContent).not.toContain("Changed outside worktrees");
  });

  it("marks a row on its base branch and counts the commits its threads made there, instead of ahead and behind", () => {
    const onMain = worktree({
      key: "main", threadIds: ["thr_2"], branch: "main", base: "main", onBase: true,
      threadCommits: [commit(), commit({ sha: "b".repeat(40), shortSha: "bbbbbbb" })],
    });
    const { slot } = mountList({ overview: sampleOverview({ worktrees: [onMain, worktree({ key: "quiet", threadIds: ["thr_3"], branch: "main", base: "main", onBase: true })] }) });
    expect(row(slot, "main").textContent).toContain("on base");
    expect(row(slot, "main").textContent).toContain("2 commits");
    expect(row(slot, "main").textContent).not.toContain("↑0 ↓0");
    expect(within(row(slot, "main")).getByTitle("Works on main, its base branch, so nothing counts as ahead")).toBeTruthy();
    expect(row(slot, "quiet").textContent).toContain("on base");
    expect(row(slot, "quiet").textContent).not.toContain("commit");
  });

  it("says so when there is no worktree", () => {
    const { slot } = mountList({ overview: sampleOverview({ worktrees: [], sharedFiles: [], repos: [], otherFiles: [] }) });
    expect(slot.container.textContent).toContain("No worktrees in this thread or its child threads yet.");
  });
});


describe("relativeTime", () => {
  const NOW = 1_700_000_000_000;
  it("reads recent times as minutes, hours and days ago", () => {
    expect(relativeTime(NOW - 5_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 12 * 60_000, NOW)).toBe("12 min ago");
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe("2 d ago");
  });

  it("falls back to the date after a month, and never reads a future time as negative", () => {
    expect(relativeTime(NOW - 40 * 86_400_000, NOW)).toMatch(/\d{4}|[A-Z][a-z]{2}/);
    expect(relativeTime(NOW + 60_000, NOW)).toBe("just now");
  });
});

type Tab = WorktreeDetailProps["tab"];

function mountDetail(options: {
  key?: string; tab?: Tab; overview?: Overview; currentHostId?: string | null; onStep?: (delta: -1 | 1) => void; onBack?: () => void; onTab?: (tab: Tab) => void;
  patch?: (input: PatchRequest) => PatchOutput | Promise<PatchOutput>; commitFiles?: (input: CommitFilesInput) => CommitFilesOutput | Promise<CommitFilesOutput>;
  openTerminal?: () => boolean; create?: () => unknown; pullRequests?: Record<string, ReturnType<typeof sidebarPullRequest>>;
  sidebar?: PluginSidebarThread[]; threadActions?: (thread: unknown) => never[];
  currentThreadId?: string | null; terminal?: WorktreeDetailProps["terminal"]; worktrees?: readonly Worktree[];
} = {}) {
  const patch = vi.fn(async (input: PatchRequest) => (options.patch ?? ((request: PatchRequest) => ({
    patch: `+patch ${request.scope} ${request.sha ?? "-"} ${request.path}`, truncated: false, binary: false,
  })))(input));
  const commitFiles = vi.fn(async (input: CommitFilesInput) => (options.commitFiles ?? (() => ({ files: [fileChange({ path: "in-commit.ts" })] })))(input));
  const recordedEdits = vi.fn(async () => ({ edits: [] }));
  const create = vi.fn(options.create ?? (async () => ({ id: "term_1" })));
  const threadActions = vi.fn(options.threadActions ?? (() => []));
  const onStep = options.onStep ?? vi.fn();
  const onBack = options.onBack ?? vi.fn();
  const onTab = options.onTab ?? vi.fn();
  function Harness() {
    const [tab, setTab] = useState<Tab>(options.tab ?? "changes");
    return (
      <LiveThreadsProvider>
        <WorktreeDetail overview={options.overview ?? sampleOverview()} worktreeKey={options.key ?? "wt1"} tab={tab}
          currentThreadId={options.currentThreadId === undefined ? "thr_1" : options.currentThreadId} terminal={options.terminal} worktrees={options.worktrees}
          currentHostId={options.currentHostId === undefined ? "host_1" : options.currentHostId}
          onTab={(next) => { onTab(next); setTab(next); }} onStep={onStep} onBack={onBack}
          loaders={{ patch, recordedEdits, commitFiles }} />
      </LiveThreadsProvider>
    );
  }
  const slot = renderSlot({ component: Harness }, {}, {
    sidebarThreads: { status: "ready", threads: options.sidebar ?? SIDEBAR }, sidebarPullRequests: options.pullRequests ?? {},
    threadActions: threadActions as never, openTerminal: options.openTerminal ?? (() => true),
    sdk: { terminals: { create: create as never } },
  });
  mounts.push(slot);
  return { slot, patch, commitFiles, create, threadActions, onStep, onBack, onTab };
}

const button = (slot: Slot, name: RegExp | string) => slot.getByRole("button", { name });
const tab = (slot: Slot, name: RegExp | string) => slot.getByRole("tab", { name });

describe("WorktreeDetail header", () => {
  it("names the worktree with its title, branch, ahead and behind, status, machine and path", () => {
    const { slot } = mountDetail({ pullRequests: { thr_2: sidebarPullRequest({ number: 12, attention: "ready_to_merge" }) } });
    const header = slot.container.querySelector("[data-worktree-header]")!;
    expect(header.textContent).toContain("Child A (live)");
    expect(header.textContent).toContain("agent/a");
    expect(header.textContent).toContain("↑2 ↓1 on origin/main");
    expect(header.textContent).toContain("Needs you");
    expect(header.textContent).toContain("Laptop");
    expect(header.textContent).toContain("/work/one");
    expect(within(header as HTMLElement).getByText("#12 open")).toBeTruthy();
    expect(header.querySelector('[data-thread-status-glyph="waiting-for-input"]')).not.toBeNull();
  });

  it("explains a request that needs you or a failure with bb's own label", () => {
    const needs = mountDetail();
    expect(needs.slot.getByRole("status").textContent).toBe("Thread needs user input");
    needs.slot.lifecycle.unmount();
    const failed = mountDetail({
      key: "wt2",
      sidebar: [sidebarThread({ id: "thr_3", displayTitle: "Child B", indicator: "unread-error", indicatorLabel: "Thread failed" })],
    });
    expect(failed.slot.getByRole("status").textContent).toBe("Thread failed");
  });

  it("reads 'This thread' on the parent's own worktree", () => {
    const { slot } = mountDetail({ key: "wt0" });
    expect(slot.container.querySelector("[data-worktree-header]")!.textContent).toContain("This thread · Parent thread");
  });

  it("steps through the worktrees, from the first to the last, and goes back to the list", () => {
    const first = mountDetail({ key: "wt0" });
    expect(first.slot.container.textContent).toContain("1 of 6");
    expect((button(first.slot, "Previous worktree") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button(first.slot, "Next worktree"));
    expect(first.onStep).toHaveBeenCalledWith(1);
    fireEvent.click(button(first.slot, /All worktrees/));
    expect(first.onBack).toHaveBeenCalledTimes(1);
    first.slot.lifecycle.unmount();
    const last = mountDetail({ key: "wt5" });
    expect(last.slot.container.textContent).toContain("6 of 6");
    expect((button(last.slot, "Next worktree") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button(last.slot, "Previous worktree"));
    expect(last.onStep).toHaveBeenCalledWith(-1);
  });

  it("counts the files and commits in the tabs, and has no Chat tab on the parent's own worktree", () => {
    const { slot, onTab } = mountDetail();
    expect(tab(slot, /^Changes/).textContent).toContain("3");
    expect(tab(slot, /^Commits/).textContent).toContain("2");
    expect(tab(slot, /^Changes/).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tab(slot, /^Chat/));
    expect(onTab).toHaveBeenCalledWith("chat");
    expect(tab(slot, /^Chat/).getAttribute("aria-selected")).toBe("true");
    slot.lifecycle.unmount();
    const own = mountDetail({ key: "wt0" });
    expect(own.slot.queryByRole("tab", { name: /^Chat/ })).toBeNull();
    expect(own.slot.queryByRole("button", { name: "Thread actions" })).toBeNull();
    expect(own.slot.queryByRole("button", { name: /Open thread/ })).toBeNull();
  });
});

describe("WorktreeDetail changes", () => {
  it("lists the uncommitted files and the committed ones in two sections with totals", () => {
    const { slot } = mountDetail();
    const text = slot.container.textContent!;
    expect(text).toContain("Uncommitted · 2 files · +5 −1");
    expect(text).toContain("Committed on this branch · 1 file · +10 −0");
    expect(slot.container.querySelector('[data-file-row="a.ts"]')).not.toBeNull();
    expect(slot.container.querySelector('[data-file-row="c.ts"]')).not.toBeNull();
  });

  it("flags a shared file with the titles of the other worktrees that changed it", () => {
    const { slot } = mountDetail();
    const readme = slot.container.querySelector<HTMLElement>('[data-file-row="README.md"]')!;
    expect(readme.textContent).toContain("also in Child B");
    expect(slot.container.querySelector<HTMLElement>('[data-file-row="a.ts"]')!.textContent).not.toContain("also in");
  });

  it("loads a committed file's patch with the committed scope and an uncommitted file's with the uncommitted one", async () => {
    const { slot, patch } = mountDetail();
    fireEvent.click(slot.container.querySelector('[data-file-row="c.ts"] button')!);
    await slot.findByText("+patch committed - c.ts");
    fireEvent.click(slot.container.querySelector('[data-file-row="a.ts"] button')!);
    await slot.findByText("+patch uncommitted - a.ts");
    expect(patch.mock.calls.map((call) => (call[0] as PatchRequest).scope)).toEqual(["committed", "uncommitted"]);
    expect(patch.mock.calls[0]?.[0]).toMatchObject({ ref: { kind: "workspace", environmentId: "env_1" } });
  });

  it("keeps the two rows of a file that is both uncommitted and committed apart", async () => {
    const both = sampleOverview({
      worktrees: WORKTREES.map((entry) => (entry.key === "wt1"
        ? { ...entry, uncommitted: [fileChange({ path: "x.ts" })], committed: [fileChange({ path: "x.ts" })] } : entry)),
      sharedFiles: [],
    });
    const { slot } = mountDetail({ overview: both });
    const rows = slot.container.querySelectorAll('[data-file-row="x.ts"] button');
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[0]!);
    await slot.findByText("+patch uncommitted - x.ts");
    expect(slot.container.textContent).not.toContain("+patch committed - x.ts");
  });

  it("labels an archived branch's committed work as kept, and says the worktree is gone", () => {
    const { slot } = mountDetail({ key: "wt3" });
    expect(slot.container.querySelector("[data-worktree-header]")!.textContent).toContain("kept in /code/proj");
    expect(slot.container.textContent).toContain("Committed on the kept branch");
    expect(slot.container.textContent).toContain("The worktree was removed, so only committed work remains.");
  });

  it("leaves the committed section out of the parent's own checkout when nothing is committed", () => {
    const { slot } = mountDetail({ key: "wt0" });
    expect(slot.container.textContent).toContain("Nothing uncommitted.");
    expect(slot.container.textContent).not.toContain("Committed on this branch");
  });

  it("says there is nothing committed yet on a worktree that is not ahead", () => {
    const { slot } = mountDetail({ key: "wt2" });
    expect(slot.container.textContent).toContain("No commits ahead of origin/main yet.");
  });

  it("shows the reason an unavailable worktree cannot be read", () => {
    const { slot } = mountDetail({ key: "wt4" });
    expect(slot.getByRole("alert").textContent).toContain("Folder is gone");
  });
});

describe("WorktreeDetail commits", () => {
  it("lists each commit with its short id, subject, author and age", () => {
    const { slot } = mountDetail({ tab: "commits" });
    const first = slot.getByRole("button", { name: /Add the thing/ });
    expect(first.textContent).toContain("a1b2c3d");
    expect(first.textContent).toContain("Ada · 12 min ago");
    expect(slot.getByRole("button", { name: /Fix the other thing/ }).textContent).toContain("Grace · 3 h ago");
    expect(slot.container.textContent).toContain("2 commits ahead of origin/main");
  });

  it("asks for a commit's files once, on the first expand, and loads its patch for that commit", async () => {
    const { slot, commitFiles, patch } = mountDetail({ tab: "commits" });
    const toggle = slot.getByRole("button", { name: /Add the thing/ });
    fireEvent.click(toggle);
    await slot.findByText("in-commit.ts");
    expect(commitFiles).toHaveBeenCalledTimes(1);
    expect(commitFiles.mock.calls[0]?.[0]).toEqual({
      ref: { kind: "workspace", environmentId: "env_1", base: "origin/main" }, sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    await slot.findByText("in-commit.ts");
    expect(commitFiles).toHaveBeenCalledTimes(1);
    fireEvent.click(slot.container.querySelector('[data-file-row="in-commit.ts"] button')!);
    await slot.findByText("+patch committed a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 in-commit.ts");
    expect(patch.mock.calls[0]?.[0]).toMatchObject({ scope: "committed", sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" });
  });

  it("shows why a commit's files could not be listed, and retries", async () => {
    let attempt = 0;
    const { slot, commitFiles } = mountDetail({
      tab: "commits",
      commitFiles: () => { if (attempt++ === 0) throw new Error("No such commit"); return { files: [fileChange({ path: "later.ts" })] }; },
    });
    fireEvent.click(slot.getByRole("button", { name: /Add the thing/ }));
    await waitFor(() => expect(slot.getByRole("alert").textContent).toContain("No such commit"));
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await slot.findByText("later.ts");
    expect(commitFiles).toHaveBeenCalledTimes(2);
  });

  it("lists the commits its threads made on the base branch it works on, and opens their files", async () => {
    const onMain = worktree({
      key: "main", threadIds: ["thr_2"], branch: "main", base: "main", onBase: true,
      threadCommits: [commit({ sha: "f".repeat(40), shortSha: "fffffff", subject: "Add the parser", authoredAt: Date.now() - 5 * 60_000 })],
    });
    const { slot, commitFiles } = mountDetail({ tab: "commits", key: "main", overview: sampleOverview({ worktrees: [onMain] }) });
    expect(slot.container.querySelector("[data-worktree-header]")!.textContent).toContain("on main, its base branch");
    expect(tab(slot, /Commits/).textContent).toContain("1");
    expect(slot.container.textContent).toContain("1 commit its threads made on main");
    fireEvent.click(slot.getByRole("button", { name: /Add the parser/ }));
    await slot.findByText("in-commit.ts");
    expect(commitFiles.mock.calls[0]?.[0]).toMatchObject({ sha: "f".repeat(40) });
  });

  it("explains a worktree on its base branch whose threads made no commits", () => {
    const quiet = worktree({ key: "main", threadIds: ["thr_2"], branch: "main", base: "main", onBase: true });
    const overview = sampleOverview({ worktrees: [quiet] });
    const commits = mountDetail({ tab: "commits", key: "main", overview });
    expect(commits.slot.container.textContent).toContain("Works on main, its base branch, so nothing counts as ahead. No commits its threads made were found.");
    const changes = mountDetail({ tab: "changes", key: "main", overview });
    expect(changes.slot.container.textContent).toContain("Works on main, its base branch, so nothing counts as committed ahead.");
  });

  it("says so when there are no commits ahead", () => {
    const { slot } = mountDetail({ tab: "commits", key: "wt2" });
    expect(slot.container.textContent).toContain("No commits ahead of origin/main.");
  });
});

describe("WorktreeDetail chat", () => {
  it("shows the child's own conversation in bb's chat component", () => {
    const { slot } = mountDetail({ tab: "chat" });
    const chat = slot.getByTestId("bb-thread-chat");
    expect(chat.getAttribute("data-thread-id")).toBe("thr_2");
    expect(chat.getAttribute("data-variant")).toBe("compact");
    expect(chat.getAttribute("data-layout")).toBe("contained");
    expect(chat.getAttribute("data-permission-policy")).toBe("inherit");
    expect(chat.parentElement!.className).toContain("min-h-0");
  });

  it("lets you choose among several threads that share the worktree", () => {
    const shared = sampleOverview({
      worktrees: WORKTREES.map((entry) => (entry.key === "wt1" ? { ...entry, threadIds: ["thr_2", "thr_3"] } : entry)),
    });
    const { slot } = mountDetail({ tab: "chat", overview: shared });
    expect(slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id")).toBe("thr_2");
    fireEvent.click(slot.getByRole("button", { name: "Child B" }));
    expect(slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id")).toBe("thr_3");
  });
});

describe("WorktreeDetail actions", () => {
  it("starts a terminal in the worktree, scoped to the parent thread, and shows it", async () => {
    const { slot, create } = mountDetail();
    fireEvent.click(button(slot, /Terminal here/));
    await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([{ method: "experimental_openTerminal", options: { terminalId: "term_1" } }]));
    expect(create).toHaveBeenCalledWith({
      cols: 120, rows: 32, scope: { kind: "thread", threadId: "thr_1" }, title: "Child A (live) · agent/a",
      start: { mode: "command", command: `cd '/work/one' && exec "\${SHELL:-/bin/sh}" -l` },
    });
  });

  it("tells you when bb could not show the terminal, or could not start it", async () => {
    const refused = mountDetail({ openTerminal: () => false });
    fireEvent.click(button(refused.slot, /Terminal here/));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("bb could not show the terminal"));
    refused.slot.lifecycle.unmount();
    const failed = mountDetail({ create: async () => { throw new Error("no shell"); } });
    fireEvent.click(button(failed.slot, /Terminal here/));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not start a terminal: no shell"));
  });

  it("disables the terminal where there is nothing on disk, or the machine is not this thread's", () => {
    const states: Array<[Parameters<typeof mountDetail>[0], boolean, string | null]> = [
      [{ key: "wt3" }, true, "removed"],
      [{ key: "wt4" }, true, "cannot be read"],
      [{ currentHostId: "host_9" }, true, "another machine"],
      [{ currentHostId: null }, true, "another machine"],
      [{}, false, null],
    ];
    for (const [options, disabled, reason] of states) {
      const { slot } = mountDetail(options);
      const terminal = button(slot, /Terminal here/) as HTMLButtonElement;
      expect(terminal.disabled).toBe(disabled);
      if (reason !== null) expect(terminal.getAttribute("title")).toContain(reason);
      slot.lifecycle.unmount();
    }
  });

  it("opens the thread in a split pane", () => {
    const { slot } = mountDetail();
    fireEvent.click(button(slot, /Open thread/));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_2", options: { split: true } }]);
  });

  it("copies the worktree's path", async () => {
    const { slot } = mountDetail();
    fireEvent.click(button(slot, /Copy path/));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Copied"));
    expect(slot.inspection.experimental_clipboardWrites).toEqual([{ text: "/work/one" }]);
  });

  it("offers bb's thread menu for the thread, built from the sidebar thread", () => {
    const { slot, threadActions } = mountDetail();
    fireEvent.click(button(slot, "Thread actions"));
    expect(slot.getByTestId("bb-thread-actions-menu").getAttribute("data-thread-id")).toBe("thr_2");
    expect(threadActions.mock.calls[0]?.[0]).toEqual({
      id: "thr_2", projectId: "proj_1", parentThreadId: null, archivedAt: null, pinnedAt: null, sectionId: null, isUnread: false,
      status: "idle", environment: { id: "env_1", path: "/work/one" },
    });
  });

  it("leaves the thread menu out when bb's sidebar does not list the thread", () => {
    const { slot } = mountDetail({ key: "wt4" });
    expect(slot.queryByRole("button", { name: "Thread actions" })).toBeNull();
  });
});


describe("WorktreeList on the full-screen page", () => {
  it("marks the selected row as current and leaves the others unmarked", () => {
    const { slot } = mountList({ currentThreadId: null, selectedKey: "wt1" });
    expect(row(slot, "wt1").getAttribute("aria-current")).toBe("true");
    expect(row(slot, "wt1").className).toContain("bg-surface-selected");
    expect(row(slot, "wt2").hasAttribute("aria-current")).toBe(false);
    expect(row(slot, "wt2").className).not.toContain("bg-surface-selected");
  });

  it("marks nothing when nothing is selected, and never in the side panel", () => {
    const { slot } = mountList();
    expect(slot.container.querySelector("[aria-current]")).toBeNull();
  });

  it("has no 'This thread' label, since the page belongs to no thread", () => {
    const { slot } = mountList({ currentThreadId: null });
    expect(row(slot, "wt0").textContent).not.toContain("This thread");
    expect(row(slot, "wt0").textContent).toContain("Parent thread");
  });

  it("says which thread a child's row is under, using the live title of the root", () => {
    const { slot } = mountList({ currentThreadId: null });
    expect(row(slot, "wt1").textContent).toContain("under Parent thread");
    expect(row(slot, "wt0").textContent).not.toContain("under");
    const sidePanel = mountList();
    expect(row(sidePanel.slot, "wt1").textContent).not.toContain("under");
  });

  it("leaves out 'under' when the parent is not in the overview", () => {
    const orphan = sampleOverview({ threads: THREADS.map((thread) => (thread.id === "thr_2" ? { ...thread, parentThreadId: "thr_gone" } : thread)) });
    const { slot } = mountList({ currentThreadId: null, overview: orphan });
    expect(row(slot, "wt1").textContent).not.toContain("under");
  });

  it("shows only the worktrees it is given, and counts only those in its summary", () => {
    const shown = WORKTREES.filter((worktree) => worktree.key === "wt1" || worktree.key === "wt2");
    const { slot } = mountList({ currentThreadId: null, worktrees: shown });
    expect(slot.container.querySelectorAll("[data-worktree-row]")).toHaveLength(2);
    expect(slot.container.textContent).toContain("2 workspaces · 0 running · 1 needs you · 1 failed");
    expect(slot.container.querySelector('[data-worktree-group="Other project"]')).toBeNull();
  });

  it("keeps the shared-files banner to files that a shown worktree changed", () => {
    const outside = mountList({ currentThreadId: null, worktrees: WORKTREES.filter((worktree) => worktree.key === "wt0" || worktree.key === "wt5") });
    expect(outside.slot.container.textContent).not.toContain("changed in more than one worktree");
    const inside = mountList({ currentThreadId: null, worktrees: WORKTREES.filter((worktree) => worktree.key === "wt1") });
    expect(inside.slot.container.textContent).toContain("1 file is changed in more than one worktree");
  });

  it("counts and draws a running thread that bb's sidebar does not list, from the status the overview carries", () => {
    const hidden = sampleOverview({
      threads: THREADS.map((thread) => (thread.id === "thr_6" ? { ...thread, status: "active" } : thread)),
    });
    const sidebar = SIDEBAR.filter((thread) => thread.id !== "thr_6");
    const slot = renderSlot({
      component: () => (
        <LiveThreadsProvider><WorktreeList overview={hidden} currentThreadId={null} onOpen={vi.fn()} onShowRepositories={vi.fn()} /></LiveThreadsProvider>
      ),
    }, {}, { sidebarThreads: { status: "ready", threads: sidebar }, sidebarPullRequests: {} });
    mounts.push(slot);
    expect(slot.container.textContent).toContain("6 workspaces · 2 running · 1 needs you · 1 failed");
    expect(row(slot, "wt5").querySelector('[data-thread-status-glyph="runtime"]')).not.toBeNull();
  });

  it("does not guess a status for an idle thread that the sidebar does not list", () => {
    const { slot } = mountList({ currentThreadId: null });
    expect(slot.container.textContent).toContain("6 workspaces · 1 running");
  });

  it("can leave out its own summary, when the page shows one", () => {
    const { slot } = mountList({ currentThreadId: null, showSummary: false });
    expect(slot.container.textContent).not.toContain("workspaces ·");
    expect(slot.container.querySelectorAll("[data-worktree-row]")).toHaveLength(6);
  });
});

describe("WorktreeDetail on the full-screen page", () => {
  it("offers Chat and bb's thread menu for every thread, the first one included", () => {
    const { slot } = mountDetail({ currentThreadId: null, key: "wt0", sidebar: SIDEBAR });
    expect(tab(slot, /^Chat/)).toBeTruthy();
    expect(button(slot, /Open thread/)).toBeTruthy();
    expect(button(slot, "Thread actions")).toBeTruthy();
    expect(slot.container.querySelector("[data-worktree-header]")!.textContent).not.toContain("This thread");
  });

  it("starts a terminal in the worktree's environment, with no start command and no machine check", async () => {
    const { slot, create } = mountDetail({ currentThreadId: null, terminal: "environment", currentHostId: null });
    const terminal = button(slot, /Terminal here/) as HTMLButtonElement;
    expect(terminal.disabled).toBe(false);
    fireEvent.click(terminal);
    await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([{ method: "experimental_openTerminal", options: { terminalId: "term_1" } }]));
    expect(create).toHaveBeenCalledWith({
      cols: 120, rows: 32, scope: { kind: "environment", environmentId: "env_1" }, title: "Child A (live) · agent/a",
    });
  });

  it("still has no terminal for a removed worktree or one that cannot be read", () => {
    for (const [key, reason] of [["wt3", "removed"], ["wt4", "cannot be read"]] as const) {
      const { slot } = mountDetail({ currentThreadId: null, terminal: "environment", key });
      const terminal = button(slot, /Terminal here/) as HTMLButtonElement;
      expect(terminal.disabled).toBe(true);
      expect(terminal.getAttribute("title")).toContain(reason);
      slot.lifecycle.unmount();
    }
  });

  it("steps through the sequence it is given and shows its position there", () => {
    const sequence = WORKTREES.filter((worktree) => worktree.key === "wt1" || worktree.key === "wt2");
    const first = mountDetail({ currentThreadId: null, worktrees: sequence });
    expect(first.slot.container.textContent).toContain("1 of 2");
    expect((button(first.slot, "Previous worktree") as HTMLButtonElement).disabled).toBe(true);
    expect((button(first.slot, "Next worktree") as HTMLButtonElement).disabled).toBe(false);
    first.slot.lifecycle.unmount();
    const last = mountDetail({ currentThreadId: null, worktrees: sequence, key: "wt2" });
    expect(last.slot.container.textContent).toContain("2 of 2");
    expect((button(last.slot, "Next worktree") as HTMLButtonElement).disabled).toBe(true);
  });

  it("still shows a worktree that the filters hide, without a position", () => {
    const sequence = WORKTREES.filter((worktree) => worktree.key === "wt2");
    const { slot } = mountDetail({ currentThreadId: null, worktrees: sequence, key: "wt1" });
    expect(slot.container.querySelector("[data-worktree-header]")!.textContent).toContain("Child A (live)");
    expect(slot.container.textContent).not.toMatch(/\d of \d/);
    expect((button(slot, "Previous worktree") as HTMLButtonElement).disabled).toBe(true);
    expect((button(slot, "Next worktree") as HTMLButtonElement).disabled).toBe(true);
  });
});

async function mountPanel(options: {
  overview?: (input: OverviewInput) => Overview | Promise<Overview>; shell?: (input: ShellInput) => Overview | Promise<Overview>; threadActions?: () => never[];
} = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const overview = vi.fn(options.overview ?? (() => sampleOverview()));
  const shell = vi.fn(options.shell ?? (() => new Promise<Overview>(() => {})));
  const patch = vi.fn(async (input: PatchRequest) => ({ patch: `+patch ${input.scope} ${input.path}`, truncated: false, binary: false }));
  const create = vi.fn(async () => ({ id: "term_1" }));
  const slot = renderSlot<PluginThreadPanelProps, typeof rpcContract>(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
    pluginId: "vantage",
    rpc: { shell, overview, patch, recordedEdits: () => ({ edits: [] }), commitFiles: () => ({ files: [] }) },
    sdk: { subscribe: (() => () => {}) as never, terminals: { create: create as never } },
    sidebarThreads: { status: "ready", threads: SIDEBAR }, sidebarPullRequests: {}, threadActions: (options.threadActions ?? (() => [])) as never,
    openTerminal: () => true,
  });
  mounts.push(slot);
  return { slot, overview, shell, patch, create };
}

const panelRoot = (slot: Slot): HTMLElement => slot.container.querySelector<HTMLElement>("[data-vantage-panel]")!;
const header = (slot: Slot): string => slot.container.querySelector("[data-worktree-header]")?.textContent ?? "";

describe("Vantage panel: the Worktrees view", () => {
  it("opens on the Worktrees view, with the Repositories sections one switch away", async () => {
    const { slot } = await mountPanel();
    await slot.findByText("Child A (live)");
    expect(slot.getByRole("button", { name: "Worktrees" }).getAttribute("aria-pressed")).toBe("true");
    expect(slot.getByRole("button", { name: "Repositories" }).getAttribute("aria-pressed")).toBe("false");
    expect(slot.container.querySelector("[data-repo]")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Repositories" }));
    expect(slot.container.querySelector("[data-repo]")).not.toBeNull();
    expect(slot.container.querySelector("[data-worktree-list]")).toBeNull();
  });

  it("remembers the chosen view on this device", async () => {
    const first = await mountPanel();
    await first.slot.findByText("Child A (live)");
    fireEvent.click(first.slot.getByRole("button", { name: "Repositories" }));
    expect(window.localStorage.getItem(VIEW_STORAGE_KEY)).toBe("repositories");
    first.slot.lifecycle.unmount();
    const second = await mountPanel();
    await second.slot.findByText("commons");
    expect(second.slot.getByRole("button", { name: "Repositories" }).getAttribute("aria-pressed")).toBe("true");
    expect(second.slot.container.querySelector("[data-worktree-list]")).toBeNull();
  });

  it("shows the scope switch and Expand all only on the Repositories view", async () => {
    const { slot } = await mountPanel();
    await slot.findByText("Child A (live)");
    expect(slot.queryByRole("group", { name: "Scope" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Expand all" })).toBeNull();
    expect(slot.getByRole("button", { name: "Refresh" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Repositories" }));
    expect(slot.getByRole("group", { name: "Scope" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Expand all" })).toBeTruthy();
  });

  it("opens a worktree's detail from its row and goes back to the list", async () => {
    const { slot } = await mountPanel();
    await slot.findByText("Child A (live)");
    fireEvent.click(row(slot, "wt1"));
    expect(header(slot)).toContain("Child A (live)");
    expect(slot.container.querySelector("[data-worktree-list]")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /All worktrees/ }));
    expect(slot.container.querySelector("[data-worktree-list]")).not.toBeNull();
  });

  it("steps to the next and previous worktree with ] and [, and back to the list with Escape", async () => {
    const { slot } = await mountPanel();
    await slot.findByText("Child A (live)");
    fireEvent.click(row(slot, "wt1"));
    expect(header(slot)).toContain("2 of 6");
    expect(fireEvent.keyDown(panelRoot(slot), { key: "]" })).toBe(false);
    expect(header(slot)).toContain("3 of 6");
    expect(header(slot)).toContain("Child B");
    expect(fireEvent.keyDown(panelRoot(slot), { key: "[" })).toBe(false);
    expect(fireEvent.keyDown(panelRoot(slot), { key: "[" })).toBe(false);
    expect(header(slot)).toContain("1 of 6");
    fireEvent.keyDown(panelRoot(slot), { key: "[" });
    expect(header(slot)).toContain("1 of 6");
    expect(fireEvent.keyDown(panelRoot(slot), { key: "Escape" })).toBe(false);
    expect(slot.container.querySelector("[data-worktree-list]")).not.toBeNull();
  });

  it("leaves keys alone while typing, with a modifier held, in the list and in the Repositories view", async () => {
    const { slot } = await mountPanel();
    await slot.findByText("Child A (live)");
    expect(fireEvent.keyDown(panelRoot(slot), { key: "]" })).toBe(true);
    fireEvent.click(row(slot, "wt1"));
    const textarea = document.createElement("textarea");
    panelRoot(slot).appendChild(textarea);
    expect(fireEvent.keyDown(textarea, { key: "]" })).toBe(true);
    expect(fireEvent.keyDown(textarea, { key: "Escape" })).toBe(true);
    expect(header(slot)).toContain("2 of 6");
    expect(fireEvent.keyDown(panelRoot(slot), { key: "]", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(panelRoot(slot), { key: "]", metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(panelRoot(slot), { key: "]", altKey: true })).toBe(true);
    expect(header(slot)).toContain("2 of 6");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    panelRoot(slot).appendChild(editable);
    expect(fireEvent.keyDown(editable, { key: "]" })).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: "Repositories" }));
    expect(fireEvent.keyDown(panelRoot(slot), { key: "]" })).toBe(true);
  });

  it("ignores keys pressed outside the panel, such as in bb's thread menu", async () => {
    const { slot } = await mountPanel();
    await slot.findByText("Child A (live)");
    fireEvent.click(row(slot, "wt1"));
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    fireEvent.keyDown(outside, { key: "Escape" });
    expect(header(slot)).toContain("2 of 6");
  });

  it("keeps the open worktree across a refresh and returns to the list when it disappears", async () => {
    let calls = 0;
    const { slot, overview } = await mountPanel({
      overview: () => {
        calls++;
        return calls < 3 ? sampleOverview() : sampleOverview({ worktrees: WORKTREES.filter((entry) => entry.key !== "wt1"), sharedFiles: [] });
      },
    });
    await slot.findByText("Child A (live)");
    fireEvent.click(row(slot, "wt1"));
    fireEvent.click(slot.getByRole("tab", { name: /^Commits/ }));
    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(overview).toHaveBeenCalledTimes(2));
    expect(header(slot)).toContain("Child A (live)");
    expect(slot.getByRole("tab", { name: /^Commits/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(overview).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(slot.container.querySelector("[data-worktree-list]")).not.toBeNull());
    expect(slot.container.querySelector('[data-worktree-row="wt1"]')).toBeNull();
  });

  it("shows the changes of an opened worktree with its committed patch, and the child's chat", async () => {
    const { slot, patch } = await mountPanel();
    await slot.findByText("Child A (live)");
    fireEvent.click(row(slot, "wt1"));
    fireEvent.click(slot.container.querySelector('[data-file-row="c.ts"] button')!);
    await slot.findByText("+patch committed c.ts");
    expect(patch.mock.calls[0]?.[0]).toMatchObject({ scope: "committed", path: "c.ts" });
    fireEvent.click(slot.getByRole("tab", { name: /^Chat/ }));
    expect(slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id")).toBe("thr_2");
  });

  it("has no Chat tab on the parent's own worktree", async () => {
    const { slot } = await mountPanel();
    await slot.findByText("This thread");
    fireEvent.click(row(slot, "wt0"));
    expect(slot.queryByRole("tab", { name: /^Chat/ })).toBeNull();
    expect(header(slot)).toContain("This thread · Parent thread");
  });

  it("starts a terminal in the worktree from the parent's thread scope, and records it", async () => {
    const { slot, create } = await mountPanel();
    await slot.findByText("Child A (live)");
    fireEvent.click(row(slot, "wt1"));
    fireEvent.click(slot.getByRole("button", { name: /Terminal here/ }));
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "experimental_openTerminal", options: { terminalId: "term_1" } }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: "thread", threadId: "thr_1" } }));
  });

  it("disables the terminal for a worktree on another machine than this thread's", async () => {
    const other = { ...WORKTREES[1]!, hostId: "host_2", hostName: "Dev box" };
    const { slot } = await mountPanel({ overview: () => sampleOverview({ worktrees: [WORKTREES[0]!, other, ...WORKTREES.slice(2)] }) });
    await slot.findByText("Child A (live)");
    fireEvent.click(row(slot, "wt1"));
    expect((slot.getByRole("button", { name: /Terminal here/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens the thread in a split pane and copies the path", async () => {
    const { slot } = await mountPanel();
    await slot.findByText("Child A (live)");
    fireEvent.click(row(slot, "wt1"));
    fireEvent.click(slot.getByRole("button", { name: /Open thread/ }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_2", options: { split: true } });
    fireEvent.click(slot.getByRole("button", { name: /Copy path/ }));
    await waitFor(() => expect(slot.inspection.experimental_clipboardWrites).toEqual([{ text: "/work/one" }]));
  });

  it("switches to the Repositories view from the changes made outside worktrees", async () => {
    const { slot } = await mountPanel();
    await slot.findByText("Changed outside worktrees");
    fireEvent.click(slot.getByRole("button", { name: /commons/ }));
    expect(slot.getByRole("button", { name: "Repositories" }).getAttribute("aria-pressed")).toBe("true");
    expect(slot.container.querySelector("[data-repo]")).not.toBeNull();
    expect(window.localStorage.getItem(VIEW_STORAGE_KEY)).toBe("repositories");
  });

  describe("focused on the row clicked", () => {
    const withWorkspace = () => sampleOverview({
      repos: [
        repo({ key: "wt1", label: "Project", threadIds: ["thr_2"], files: [fileChange({ path: "a.ts", additions: 3, deletions: 1 })] }),
        checkoutRepo({ label: "commons", files: [fileChange({ additions: 4, deletions: 1 })], threadIds: ["thr_4"] }),
      ],
    });
    const repoKeys = (slot: Slot) => [...slot.container.querySelectorAll("[data-repo]")].map((node) => node.getAttribute("data-repo"));
    const chip = (slot: Slot) => slot.container.querySelector("[data-repo-focus]");

    it("shows only that repository, says so, and counts only what it shows", async () => {
      const { slot } = await mountPanel({ overview: withWorkspace });
      await slot.findByText("Changed outside worktrees");
      fireEvent.click(slot.getByRole("button", { name: /commons/ }));
      expect(repoKeys(slot)).toEqual(["host_1:/code/commons"]);
      expect(slot.container.querySelector("[data-other-files]")).toBeNull();
      expect(chip(slot)?.textContent).toContain("Only commons");
      expect(slot.container.querySelector("[data-repo-summary]")!.textContent).toContain("1 repo · 1 file · +4 −1 · 1 thread");
    });

    it("shows only the other files from their row", async () => {
      const { slot } = await mountPanel({ overview: withWorkspace });
      await slot.findByText("Changed outside worktrees");
      fireEvent.click(slot.getByRole("button", { name: /Other files/ }));
      expect(repoKeys(slot)).toEqual([]);
      expect(slot.container.querySelector("[data-other-files]")?.textContent).toContain("/tmp/notes.txt");
      expect(chip(slot)?.textContent).toContain("Only Other files");
    });

    it("shows every repository again when the focus is cleared", async () => {
      const { slot } = await mountPanel({ overview: withWorkspace });
      await slot.findByText("Changed outside worktrees");
      fireEvent.click(slot.getByRole("button", { name: /commons/ }));
      fireEvent.click(slot.getByRole("button", { name: "Show all repositories" }));
      expect(chip(slot)).toBeNull();
      expect(repoKeys(slot)).toEqual(["wt1", "host_1:/code/commons"]);
      expect(slot.container.querySelector("[data-other-files]")).not.toBeNull();
    });

    it("carries the open worktree into the Repositories view as the focus", async () => {
      const { slot } = await mountPanel({ overview: withWorkspace });
      await slot.findByText("Child A (live)");
      fireEvent.click(row(slot, "wt1"));
      fireEvent.click(slot.getByRole("button", { name: "Repositories" }));
      expect(repoKeys(slot)).toEqual(["wt1"]);
      expect(chip(slot)?.textContent).toContain("Only Project · feature/work");
    });

    it("forgets the focus when the view is switched, so the Repositories switch shows everything", async () => {
      const { slot } = await mountPanel({ overview: withWorkspace });
      await slot.findByText("Changed outside worktrees");
      fireEvent.click(slot.getByRole("button", { name: /commons/ }));
      fireEvent.click(slot.getByRole("button", { name: "Worktrees" }));
      fireEvent.click(slot.getByRole("button", { name: "Repositories" }));
      expect(chip(slot)).toBeNull();
      expect(repoKeys(slot)).toEqual(["wt1", "host_1:/code/commons"]);
    });

    it("offers Collapse all once every file shown is open, whatever the hidden repositories hold", async () => {
      const { slot } = await mountPanel({ overview: withWorkspace });
      await slot.findByText("Changed outside worktrees");
      fireEvent.click(slot.getByRole("button", { name: /commons/ }));
      fireEvent.click(slot.container.querySelector('[data-file-row="src/a.ts"] button')!);
      expect(slot.getByRole("button", { name: "Collapse all" })).toBeTruthy();
    });
  });

  it("shows the load error and the warnings above the worktrees too", async () => {
    const { slot } = await mountPanel({ overview: () => sampleOverview({ warnings: ["Could not reach Dev box: offline"], truncatedThreads: true }) });
    await slot.findByText("Child A (live)");
    expect(slot.container.textContent).toContain("Could not reach Dev box: offline");
    expect(slot.container.textContent).toContain("Only the first 200 threads");
    fireEvent.click(row(slot, "wt1"));
    expect(slot.container.textContent).toContain("Could not reach Dev box: offline");
  });
});

describe("loading states", () => {
  const LOADING = [
    worktree({ key: "wl0", threadIds: ["thr_1"], branch: "feature/main", state: "loading", aheadCount: null, behindCount: null }),
    worktree({ key: "wl1", threadIds: ["thr_2"], branch: "agent/a", state: "loading", aheadCount: null, behindCount: null }),
  ];
  const outline = (overrides: Partial<Overview> = {}): Overview => sampleOverview({
    worktrees: LOADING, partial: true, archivedHidden: 2, sharedFiles: [], repos: [], otherFiles: [], ...overrides,
  });
  const pulses = (node: Element) => node.querySelectorAll("[aria-hidden='true'].animate-pulse");

  it("keeps a loading row's title, glyph, branch and badges, and shows skeletons where the numbers go", () => {
    const { slot } = mountList({ overview: outline(), currentThreadId: null });
    const loading = row(slot, "wl1");
    expect(loading.textContent).toContain("Child A (live)");
    expect(loading.textContent).toContain("agent/a");
    expect(loading.textContent).toContain("Needs you");
    expect(loading.querySelector('[data-thread-status-glyph="waiting-for-input"]')).not.toBeNull();
    expect(loading.textContent).not.toMatch(/[+−]\d|uncommitted|clean|↑/);
    expect(loading.querySelector(".w-14.animate-pulse")).not.toBeNull();
    expect(loading.querySelector(".w-20.animate-pulse")).not.toBeNull();
  });

  it("counts a loading worktree in the tally from bb's sidebar, since that needs no git", () => {
    const { slot } = mountList({ overview: outline() });
    expect(slot.container.textContent).toContain("2 workspaces · 1 running · 1 needs you · 0 failed");
  });

  it("hides the shared-files banner and shows one skeleton row under 'Changed outside worktrees' while the overview is partial", () => {
    const { slot } = mountList({ overview: outline({ sharedFiles: [sharedFile({ worktreeKeys: ["wl0", "wl1"] })] }) });
    expect(slot.container.textContent).not.toContain("changed in more than one worktree");
    const outside = [...slot.container.querySelectorAll("h3")].find((heading) => heading.textContent === "Changed outside worktrees")!;
    expect(outside).toBeTruthy();
    expect(outside.parentElement!.textContent).toContain("Looking for edits in other repositories…");
    expect(pulses(outside.parentElement!).length).toBeGreaterThan(0);
    expect(slot.container.textContent).not.toContain("recorded edits only");
  });

  it("shows the banner and the real outside rows once the overview is full", () => {
    const { slot } = mountList({ overview: sampleOverview() });
    expect(slot.container.textContent).toContain("changed in more than one worktree");
    expect(slot.container.textContent).not.toContain("Looking for edits in other repositories…");
    expect(slot.container.textContent).toContain("recorded edits only");
  });

  it("shows a loading worktree's header and actions, skeleton Changes and Commits, and a working Chat", () => {
    const { slot } = mountDetail({ overview: outline(), key: "wl1", currentThreadId: null, terminal: "environment" });
    const header = slot.container.querySelector("[data-worktree-header]")!;
    expect(header.textContent).toContain("Child A (live)");
    expect(header.textContent).toContain("agent/a");
    expect((button(slot, /Terminal here/) as HTMLButtonElement).disabled).toBe(false);
    expect(button(slot, /Open thread/)).toBeTruthy();
    expect(header.textContent).not.toMatch(/↑\d|[+−]\d/);
    expect(slot.getByRole("status", { name: "Reading this worktree's git status…" }).querySelectorAll("[aria-hidden='true'].animate-pulse").length).toBeGreaterThanOrEqual(3);
    fireEvent.click(tab(slot, /^Commits/));
    expect(slot.getByRole("status", { name: "Reading this worktree's git status…" })).toBeTruthy();
    fireEvent.click(tab(slot, /^Chat/));
    expect(slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id")).toBe("thr_2");
    expect(slot.queryByRole("status", { name: "Reading this worktree's git status…" })).toBeNull();
  });

  it("shows a loading repository's header with skeleton totals and three skeleton file rows", async () => {
    const { slot } = await mountPanel({
      overview: () => outline({ repos: [repo({ key: "wl1", label: "Loading repo", state: "loading", threadIds: ["thr_2"] })] }),
    });
    await slot.findByText("Child A (live)");
    fireEvent.click(slot.getByRole("button", { name: "Repositories" }));
    const section = slot.container.querySelector("[data-repo='wl1']")!;
    expect(section.textContent).toContain("Loading repo");
    expect(section.textContent).not.toMatch(/\d+ files?|[+−]\d/);
    expect(pulses(section).length).toBeGreaterThanOrEqual(2 + 9);
    expect(section.querySelector("[role='status']")).not.toBeNull();
  });
});

describe("Vantage panel: the instant outline and archived threads", () => {
  const outlineOf = () => sampleOverview({
    partial: true, archivedHidden: 2, sharedFiles: [], repos: [], otherFiles: [],
    worktrees: WORKTREES.map((entry) => ({ ...entry, state: "loading" as const, aheadCount: null, behindCount: null, uncommitted: [], committed: [], commits: [] })),
  });
  const hold = () => {
    let release: (value: Overview) => void = () => {};
    const promise = new Promise<Overview>((resolve) => { release = resolve; });
    return { promise, release };
  };

  it("shows 'Loading worktrees' before any result", async () => {
    const { slot } = await mountPanel({ overview: () => new Promise<Overview>(() => {}) });
    expect(slot.getByRole("status", { name: "Loading worktrees" })).toBeTruthy();
    expect(slot.container.textContent).not.toContain("Looking for changes…");
  });

  it("draws rows with titles and branches from the outline, then fills in the numbers from the full overview", async () => {
    const full = hold();
    const { slot } = await mountPanel({ overview: () => full.promise, shell: () => outlineOf() });
    await slot.findByText("Child A (live)");
    expect(row(slot, "wt1").textContent).toContain("agent/a");
    expect(row(slot, "wt1").textContent).not.toMatch(/[+−]\d/);
    expect(slot.queryByRole("status", { name: "Loading worktrees" })).toBeNull();
    full.release(sampleOverview());
    await waitFor(() => expect(row(slot, "wt1").textContent).toContain("↑2 ↓1"));
    expect(row(slot, "wt1").querySelector(".animate-pulse")).toBeNull();
  });

  it("makes one shell call and one overview call for a load, both with the side tab's archived choice (shown)", async () => {
    const { slot, overview, shell } = await mountPanel();
    await slot.findByText("Child A (live)");
    expect(shell).toHaveBeenCalledTimes(1);
    expect(overview).toHaveBeenCalledTimes(1);
    expect(shell.mock.calls[0]?.[0]).toEqual({ target: { kind: "tree", threadId: "thr_1" }, includeArchived: true });
    expect(overview.mock.calls[0]?.[0]).toEqual({ target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
  });

  it("has an 'Include archived' checkbox, ticked by default, that leaves them out and is remembered", async () => {
    const first = await mountPanel();
    await first.slot.findByText("Child A (live)");
    const toggle = first.slot.getByRole("checkbox", { name: "Include archived (1)" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(window.localStorage.getItem("bb-plugin-vantage:panel-archived")).toBe("false");
    await waitFor(() => expect(first.overview).toHaveBeenCalledTimes(2));
    expect(first.overview.mock.calls[1]?.[0]).toMatchObject({ includeArchived: false });
    expect(first.shell.mock.calls[1]?.[0]).toMatchObject({ includeArchived: false });
    expect((first.slot.getByRole("checkbox", { name: /Include archived/ }) as HTMLInputElement).checked).toBe(false);
    first.slot.lifecycle.unmount();
    const second = await mountPanel();
    await waitFor(() => expect(second.overview).toHaveBeenCalled());
    expect(second.overview.mock.calls[0]?.[0]).toMatchObject({ includeArchived: false });
  });

  it("says how many archived threads are hidden in the toggle's label", async () => {
    window.localStorage.setItem("bb-plugin-vantage:panel-archived", "false");
    const { slot } = await mountPanel({ overview: () => sampleOverview({ archivedHidden: 2 }) });
    await slot.findByText("Child A (live)");
    expect((slot.getByRole("checkbox", { name: "Include archived (2)" }) as HTMLInputElement).checked).toBe(false);
  });

  it("shows the hint for the toggle on hover", async () => {
    const { slot } = await mountPanel();
    await slot.findByText("Child A (live)");
    fireEvent.pointerMove(slot.getByText(/Include archived/).closest("label")!, { pointerType: "mouse" });
    expect((await within(document.body).findByRole("tooltip")).textContent).toBe("Add archived threads and their kept branches below the active ones");
  });

  it("puts archived workspaces in their own groups after every active group", async () => {
    const { slot } = await mountPanel();
    await slot.findByText("Child A (live)");
    const rows = [...slot.container.querySelectorAll("[data-worktree-row]")].map((row) => row.getAttribute("data-worktree-row"));
    expect(rows.at(-1)).toBe("wt3");
    const headings = [...slot.container.querySelectorAll("[data-worktree-group]")].map((heading) => heading.textContent ?? "");
    expect(headings.at(-1)).toMatch(/^Archived · /);
    expect(headings.slice(0, -1).every((heading) => !heading.startsWith("Archived"))).toBe(true);
  });

  it("says how many archived workspaces are in view, and lists them after the active ones", async () => {
    const { slot } = await mountPanel();
    await slot.findByText("Child A (live)");
    expect(slot.container.textContent).toContain("6 workspaces · 1 running · 1 needs you · 1 failed · 1 archived");
  });
});
