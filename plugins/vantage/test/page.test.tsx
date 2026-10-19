import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { Overview, OverviewInput, PatchRequest, ShellInput, rpcContract } from "../src/contract";
import { clearFileCache } from "../src/file-row";
import { allOverview, branchRepo, branchWorktree, checkoutRepo, checkoutWorktree, fileChange, overview, partialOverview, sharedFile, sidebarThread, threadSummary } from "./fixtures";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

/** jsdom has no ResizeObserver: this one reports the width a test chose as soon as the page starts watching. */
class FakeResizeObserver {
  static width = 1200;
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) { this.callback = callback; }
  observe(target: Element): void {
    this.callback([{ contentRect: { width: FakeResizeObserver.width }, target } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

type Slot = ReturnType<typeof renderSlot>;
const mounts: Slot[] = [];

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  FakeResizeObserver.width = 1200;
});
afterEach(() => {
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  vi.unstubAllGlobals();
  clearFileCache();
  document.body.replaceChildren();
  window.localStorage.clear();
});

const SIDEBAR = [
  sidebarThread({ id: "thr_root", displayTitle: "Parent thread", indicator: "runtime" }),
  sidebarThread({ id: "thr_child", displayTitle: "Child worker", indicator: "waiting-for-input", indicatorLabel: "Thread needs user input", parentThreadId: "thr_root" }),
  sidebarThread({ id: "thr_docs", displayTitle: "Docs thread", projectId: "proj_docs" }),
  sidebarThread({ id: "thr_idle", displayTitle: "Idle thread" }),
];

const key = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, (character) => `~${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);

interface Options {
  overview?: (input: OverviewInput) => Overview | Promise<Overview>;
  shell?: (input: ShellInput) => Overview | Promise<Overview>;
  create?: () => unknown;
  openTerminal?: () => boolean;
}

async function mount(subPath = "", options: Options = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const overview = vi.fn(options.overview ?? ((input: OverviewInput) => (
    input.target.kind === "tree" ? allOverview({ target: input.target, threadId: input.target.threadId, windowHours: null }) : allOverview()
  )));
  const shell = vi.fn(options.shell ?? (() => new Promise<Overview>(() => {})));
  const patch = vi.fn(async (input: PatchRequest) => ({ patch: `+patch ${input.scope} ${input.path}`, truncated: false, binary: false }));
  const create = vi.fn(options.create ?? (async () => ({ id: "term_1" })));
  const slot = renderSlot<PluginNavPanelProps, typeof rpcContract>(app.navPanels[0]!, { subPath }, {
    pluginId: "vantage",
    rpc: { shell, overview, patch, recordedEdits: () => ({ edits: [] }), commitFiles: () => ({ files: [] }) },
    sdk: { subscribe: (() => () => {}) as never, terminals: { create: create as never } },
    sidebarThreads: { status: "ready", threads: SIDEBAR }, sidebarPullRequests: {}, threadActions: (() => []) as never,
    openTerminal: options.openTerminal ?? (() => true),
  });
  mounts.push(slot);
  await waitFor(() => expect(overview).toHaveBeenCalled());
  const Panel = app.navPanels[0]!.component;
  const goTo = (next: string) => slot.lifecycle.rerender(<Panel subPath={next} />);
  return { slot, overview, shell, patch, create, goTo };
}

const loaded = async (slot: Slot) => { await waitFor(() => expect(slot.container.querySelector("[data-worktree-list], [data-project-group]")).not.toBeNull()); };
const rows = (slot: Slot): string[] => [...slot.container.querySelectorAll("[data-worktree-row]")].map((node) => node.getAttribute("data-worktree-row")!);
const row = (slot: Slot, worktreeKey: string): HTMLElement => slot.container.querySelector<HTMLElement>(`[data-worktree-row="${worktreeKey}"]`)!;
const summary = (slot: Slot): string => slot.container.querySelector("[data-page-summary]")?.textContent ?? "";
const header = (slot: Slot): string => slot.container.querySelector("[data-worktree-header]")?.textContent ?? "";
const navigations = (slot: Slot) => slot.inspection.navigateCalls;
const pushed = (subPath: string) => ({ method: "toPluginPanel", path: "vantage", options: { subPath } });
const empty = (slot: Slot) => slot.queryByText("Select a worktree to inspect it.");

describe("registration", () => {
  it("is listed in the left navigation as Vantage, with the FolderGit icon and no header content", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.navPanels).toHaveLength(1);
    expect(app.navPanels[0]).toMatchObject({ id: "vantage", title: "Vantage", icon: "FolderGit", path: "vantage" });
    expect(app.navPanels[0]?.headerContent).toBeUndefined();
    expect(app.navPanels[0]?.fixedTabs).toBeUndefined();
  });
});

describe("Vantage page: Worktrees", () => {
  it("asks for every thread, then shows the list beside an empty detail on a wide window", async () => {
    const { slot, overview } = await mount();
    await loaded(slot);
    expect(overview.mock.calls[0]?.[0]).toEqual({ target: { kind: "all" }, scope: "uncommitted", includeArchived: false });
    expect(rows(slot)).toEqual(["k_parent", "k_child", "k_docs"]);
    expect(empty(slot)).not.toBeNull();
    expect(slot.container.querySelector("[data-worktree-header]")).toBeNull();
    expect(slot.container.querySelector("[data-vantage-page]")?.className).not.toContain("hidden");
  });

  it("lays two panes out as a list column and a detail column on a wide window", async () => {
    const { slot } = await mount();
    await loaded(slot);
    const panes = slot.container.querySelector("[data-page-panes]")!;
    expect(panes.className).toContain("grid-cols-[minmax(320px,420px)_minmax(0,1fr)]");
  });

  it("groups the rows by project, with the scope and a summary of what is shown", async () => {
    const { slot } = await mount();
    await loaded(slot);
    expect([...slot.container.querySelectorAll("[data-worktree-group]")].map((node) => node.getAttribute("data-worktree-group"))).toEqual(["Shop", "Docs site"]);
    expect(slot.container.textContent).toContain("All threads · last 24 h");
    expect(summary(slot)).toBe("3 workspaces · 1 running · 1 needs you · 0 failed · 5 files +23 −4 · 2 projects");
  });

  it("says which thread a child worktree is under", async () => {
    const { slot } = await mount();
    await loaded(slot);
    expect(row(slot, "k_child").textContent).toContain("under Parent thread");
    expect(row(slot, "k_parent").textContent).not.toContain("This thread");
  });

  it("records a navigation to the worktree's address when a row is clicked", async () => {
    const { slot } = await mount();
    await loaded(slot);
    fireEvent.click(row(slot, "k_child"));
    expect(navigations(slot)).toEqual([pushed(`worktree/${key("k_child")}`)]);
  });

  it("encodes a key with colons and slashes", async () => {
    const real = allOverview();
    const first = real.worktrees[0]!;
    const rekeyed = { ...first, key: "host_1:/work/shop" };
    const { slot } = await mount("", { overview: () => ({ ...real, worktrees: [rekeyed, ...real.worktrees.slice(1)] }) });
    await loaded(slot);
    fireEvent.click(row(slot, "host_1:/work/shop"));
    expect(navigations(slot)).toEqual([pushed("worktree/host_1~3A~2Fwork~2Fshop")]);
  });

  it("opens the selected worktree's detail beside the list, and marks its row", async () => {
    const { slot } = await mount(`worktree/${key("k_child")}`);
    await loaded(slot);
    await waitFor(() => expect(header(slot)).toContain("Child worker"));
    expect(slot.container.querySelector("[data-worktree-list]")).not.toBeNull();
    expect(row(slot, "k_child").getAttribute("aria-current")).toBe("true");
    expect(row(slot, "k_child").className).toContain("bg-surface-selected");
    expect(empty(slot)).toBeNull();
    expect(header(slot)).toContain("agent/child");
    expect(header(slot)).not.toContain("This thread");
  });

  it("steps to the next worktree with ] and the previous with [", async () => {
    const { slot } = await mount(`worktree/${key("k_child")}`);
    await waitFor(() => expect(header(slot)).toContain("Child worker"));
    const target = slot.container.querySelector("[data-worktree-header]")!;
    fireEvent.keyDown(target, { key: "]" });
    fireEvent.keyDown(target, { key: "[" });
    expect(navigations(slot)).toEqual([pushed(`worktree/${key("k_docs")}`), pushed(`worktree/${key("k_parent")}`)]);
  });

  it("clears the selection with Escape, and with the back button", async () => {
    const { slot } = await mount(`worktree/${key("k_child")}`);
    await waitFor(() => expect(header(slot)).toContain("Child worker"));
    fireEvent.keyDown(slot.container.querySelector("[data-worktree-header]")!, { key: "Escape" });
    expect(navigations(slot)).toEqual([pushed("")]);
    fireEvent.click(slot.getByRole("button", { name: /All worktrees/ }));
    expect(navigations(slot)).toEqual([pushed(""), pushed("")]);
  });

  it("leaves the keys alone while typing in the filter", async () => {
    const { slot } = await mount(`worktree/${key("k_child")}`);
    await waitFor(() => expect(header(slot)).toContain("Child worker"));
    fireEvent.keyDown(slot.getByLabelText("Filter by text"), { key: "Escape" });
    fireEvent.keyDown(slot.getByLabelText("Filter by text"), { key: "]" });
    expect(navigations(slot)).toEqual([]);
  });

  it("steps through the rows the filters leave", async () => {
    const { slot } = await mount(`worktree/${key("k_parent")}`);
    await waitFor(() => expect(header(slot)).toContain("Parent thread"));
    fireEvent.change(slot.getByLabelText("Project"), { target: { value: "proj_docs" } });
    expect(rows(slot)).toEqual(["k_docs"]);
    fireEvent.keyDown(slot.container.querySelector("[data-worktree-header]")!, { key: "]" });
    expect(navigations(slot)).toEqual([pushed(`worktree/${key("k_docs")}`)]);
  });

  it("takes turns between the list and the detail on a narrow window", async () => {
    FakeResizeObserver.width = 600;
    const { slot } = await mount(`worktree/${key("k_child")}`);
    await waitFor(() => expect(header(slot)).toContain("Child worker"));
    expect(slot.container.querySelector("[data-worktree-list]")).toBeNull();
    expect(slot.container.querySelector("[data-page-panes]")?.className ?? "").not.toContain("grid-cols");
    slot.lifecycle.unmount();
    mounts.pop();
    const list = await mount("");
    await loaded(list.slot);
    expect(list.slot.container.querySelector("[data-worktree-list]")).not.toBeNull();
    expect(empty(list.slot)).toBeNull();
    expect(list.slot.container.querySelector("[data-worktree-header]")).toBeNull();
  });

  it("returns to the list from the detail on a narrow window", async () => {
    FakeResizeObserver.width = 600;
    const { slot } = await mount(`worktree/${key("k_child")}`);
    await waitFor(() => expect(header(slot)).toContain("Child worker"));
    fireEvent.click(slot.getByRole("button", { name: /All worktrees/ }));
    expect(navigations(slot)).toEqual([pushed("")]);
  });

  it("falls back to the default route, replacing the address, when the address is not valid", async () => {
    const { slot } = await mount("bogus");
    await loaded(slot);
    expect(navigations(slot)).toEqual([{ method: "toPluginPanel", path: "vantage", options: { subPath: "", replace: true } }]);
  });

  it("does not rewrite an address that is already in its canonical form", async () => {
    const { slot } = await mount(`tree/thr_root/worktree/${key("k_child")}`);
    await loaded(slot);
    expect(navigations(slot)).toEqual([]);
  });

  it("drops a selection that is not in the overview, replacing the address", async () => {
    const { slot } = await mount(`worktree/${key("k_gone")}`);
    await loaded(slot);
    await waitFor(() => expect(navigations(slot)).toEqual([{ method: "toPluginPanel", path: "vantage", options: { subPath: "", replace: true } }]));
  });

  it("opens the thread alone, leaving the page, and offers Chat for every thread", async () => {
    const { slot } = await mount(`worktree/${key("k_parent")}`);
    await waitFor(() => expect(header(slot)).toContain("Parent thread"));
    expect(slot.getByRole("tab", { name: /^Chat/ })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: /Open thread/ }));
    expect(navigations(slot)).toMatchObject([{ method: "toThread", threadId: "thr_root" }]);
    expect((navigations(slot)[0] as { options?: unknown }).options).toBeUndefined();
  });

  it("starts a terminal in the worktree's environment and shows it", async () => {
    const { slot, create } = await mount(`worktree/${key("k_child")}`);
    await waitFor(() => expect(header(slot)).toContain("Child worker"));
    fireEvent.click(slot.getByRole("button", { name: /Terminal here/ }));
    await waitFor(() => expect(navigations(slot)).toEqual([{ method: "experimental_openTerminal", options: { terminalId: "term_1" } }]));
    expect(create).toHaveBeenCalledWith({ cols: 120, rows: 32, scope: { kind: "environment", environmentId: "env_2" }, title: "Child worker · agent/child" });
  });
});

describe("Vantage page: a checkout a thread works in", () => {
  it("starts its terminal in the checkout's folder on its machine, since bb has no environment for it", async () => {
    const study = checkoutWorktree({ key: "k_study", label: "Shop", projectId: "proj_shop", threadIds: ["thr_root"] });
    const { slot, create } = await mount(`worktree/${key("k_study")}`, {
      overview: () => { const base = allOverview(); return { ...base, worktrees: [...base.worktrees, study] }; },
    });
    await waitFor(() => expect(header(slot)).toContain("/trees/study/src"));
    fireEvent.click(slot.getByRole("button", { name: /Terminal here/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({
      cols: 120, rows: 32, scope: { kind: "host_path", hostId: "host_1", cwd: "/trees/study/src" }, title: "Parent thread · study",
    }));
  });
});

describe("Vantage page: filters", () => {
  it("filters by project, naming each project once in the select", async () => {
    const { slot } = await mount();
    await loaded(slot);
    const select = slot.getByLabelText("Project") as HTMLSelectElement;
    expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
      ["", "All projects"], ["proj_docs", "Docs site"], ["proj_shop", "Shop"],
    ]);
    fireEvent.change(select, { target: { value: "proj_shop" } });
    expect(rows(slot)).toEqual(["k_parent", "k_child"]);
    expect(summary(slot)).toBe("2 workspaces · 1 running · 1 needs you · 0 failed · 4 files +16 −2 · 1 project");
    fireEvent.change(select, { target: { value: "" } });
    expect(rows(slot)).toEqual(["k_parent", "k_child", "k_docs"]);
  });

  it("filters by text, matching thread titles, branches and file paths", async () => {
    const { slot } = await mount();
    await loaded(slot);
    const filter = slot.getByLabelText("Filter by text");
    fireEvent.change(filter, { target: { value: "CHILD" } });
    expect(rows(slot)).toEqual(["k_child"]);
    fireEvent.change(filter, { target: { value: "guide.md" } });
    expect(rows(slot)).toEqual(["k_docs"]);
    fireEvent.change(filter, { target: { value: "no such text" } });
    expect(rows(slot)).toEqual([]);
    expect(slot.container.textContent).toContain("No worktrees match the filters.");
    expect(summary(slot)).toContain("0 workspaces");
  });

  it("shows worktrees with no changes once 'With changes only' is turned off", async () => {
    const { slot } = await mount();
    await loaded(slot);
    const toggle = slot.getByLabelText("With changes only") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(rows(slot)).not.toContain("k_idle");
    fireEvent.click(toggle);
    expect(rows(slot)).toEqual(["k_parent", "k_child", "k_idle", "k_docs"].filter((entry) => rows(slot).includes(entry)));
    expect(rows(slot)).toContain("k_idle");
    expect(summary(slot)).toContain("4 workspaces");
  });

  it("keeps the filters while the address changes within the page", async () => {
    const { slot, goTo } = await mount("");
    await loaded(slot);
    fireEvent.change(slot.getByLabelText("Filter by text"), { target: { value: "child" } });
    fireEvent.change(slot.getByLabelText("Project"), { target: { value: "proj_shop" } });
    goTo(`worktree/${key("k_child")}`);
    await waitFor(() => expect(header(slot)).toContain("Child worker"));
    expect((slot.getByLabelText("Filter by text") as HTMLInputElement).value).toBe("child");
    expect((slot.getByLabelText("Project") as HTMLSelectElement).value).toBe("proj_shop");
    expect(rows(slot)).toEqual(["k_child"]);
  });
});

describe("Vantage page: Repositories", () => {
  it("groups the repositories under a header for each project", async () => {
    const { slot } = await mount("repositories");
    await loaded(slot);
    const groups = [...slot.container.querySelectorAll("[data-project-group]")].map((node) => [node.getAttribute("data-project-group"), node.textContent]);
    expect(groups).toEqual([["Docs site", "Docs site · 1 repo · 1 file"], ["Shop", "Shop · 2 repos · 4 files"]]);
    expect([...slot.container.querySelectorAll("[data-repo]")].map((node) => node.getAttribute("data-repo"))).toEqual(["k_docs", "k_parent", "k_child"]);
    expect(slot.container.querySelector("[data-worktree-list]")).toBeNull();
  });

  it("applies the filters, and counts what is shown", async () => {
    const { slot } = await mount("repositories");
    await loaded(slot);
    fireEvent.change(slot.getByLabelText("Project"), { target: { value: "proj_docs" } });
    expect([...slot.container.querySelectorAll("[data-project-group]")].map((node) => node.getAttribute("data-project-group"))).toEqual(["Docs site"]);
    expect(summary(slot)).toBe("1 repo · 1 file +7 −2 · 1 project");
  });

  it("puts a checkout that no project owns under 'Other repositories', after the projects, and lists other files last", async () => {
    const base = allOverview();
    const extra = { ...base.repos[0]!, key: "k_scripts", label: "scripts", projectId: null, ref: { kind: "checkout", hostId: "host_1", root: "/code/scripts", base: null } as const, files: base.repos[0]!.files };
    const { slot } = await mount("repositories", {
      overview: () => ({ ...base, repos: [...base.repos, extra], otherFiles: [{ ...base.repos[0]!.files[0]!, path: "/tmp/notes.txt" }] }),
    });
    await loaded(slot);
    const groups = [...slot.container.querySelectorAll("[data-project-group]")].map((node) => node.getAttribute("data-project-group"));
    expect(groups).toEqual(["Docs site", "Shop", "Other repositories"]);
    expect(slot.container.querySelector("[data-other-files]")?.textContent).toContain("/tmp/notes.txt");
  });

  it("has the scope switch, which asks for the branch scope, and Expand all", async () => {
    const { slot, overview } = await mount("repositories");
    await loaded(slot);
    fireEvent.click(slot.getByRole("button", { name: "Branch" }));
    await waitFor(() => expect(overview).toHaveBeenCalledTimes(2));
    expect(overview.mock.calls[1]?.[0]).toEqual({ target: { kind: "all" }, scope: "branch", includeArchived: false });
    expect(slot.getByRole("button", { name: "Expand all" })).toBeTruthy();
  });

  describe("focused on one row of 'Changed outside worktrees'", () => {
    const CORTEX = "host_1:/code/cortex";
    const withOutside = () => {
      const base = allOverview();
      return {
        ...base,
        repos: [...base.repos, checkoutRepo({ key: CORTEX, projectId: null, threadIds: ["thr_docs"], files: [fileChange({ path: "skills/x.md", additions: 4, deletions: 1 })] })],
        otherFiles: [fileChange({ path: "/tmp/notes.txt" })],
      };
    };
    const repoKeys = (slot: Slot) => [...slot.container.querySelectorAll("[data-repo]")].map((node) => node.getAttribute("data-repo"));
    const chip = (slot: Slot) => slot.container.querySelector("[data-repo-focus]");

    it("goes to the Repositories view focused on the row clicked, keeping the tree", async () => {
      const { slot } = await mount("tree/thr_root", { overview: withOutside });
      await slot.findByText("Changed outside worktrees");
      fireEvent.click(slot.getByRole("button", { name: /cortex/ }));
      fireEvent.click(slot.getByRole("button", { name: /Other files/ }));
      expect(navigations(slot)).toEqual([pushed(`tree/thr_root/repositories/repo/${key(CORTEX)}`), pushed("tree/thr_root/repositories/other-files")]);
    });

    it("shows only the focused repository, says so and counts only it", async () => {
      const { slot } = await mount(`repositories/repo/${key(CORTEX)}`, { overview: withOutside });
      await loaded(slot);
      expect(repoKeys(slot)).toEqual([CORTEX]);
      expect(slot.container.querySelector("[data-other-files]")).toBeNull();
      expect(chip(slot)?.textContent).toContain("Only cortex");
      expect(summary(slot)).toBe("1 repo · 1 file +4 −1 · 1 project");
    });

    it("shows only the other files when they are focused", async () => {
      const { slot } = await mount("repositories/other-files", { overview: withOutside });
      await waitFor(() => expect(slot.container.querySelector("[data-other-files]")).not.toBeNull());
      expect(repoKeys(slot)).toEqual([]);
      expect(chip(slot)?.textContent).toContain("Only Other files");
    });

    it("clears the focus to the plain Repositories address, keeping the tree", async () => {
      const { slot } = await mount(`tree/thr_root/repositories/repo/${key(CORTEX)}`, { overview: withOutside });
      await loaded(slot);
      fireEvent.click(slot.getByRole("button", { name: "Show all repositories" }));
      expect(navigations(slot)).toEqual([pushed("tree/thr_root/repositories")]);
    });

    it("carries the selected worktree into the Repositories view as the focus", async () => {
      const { slot } = await mount(`tree/thr_root/worktree/${key("k_child")}`, { overview: withOutside });
      await loaded(slot);
      fireEvent.click(slot.getByRole("button", { name: "Repositories" }));
      expect(navigations(slot)).toEqual([pushed(`tree/thr_root/repositories/repo/${key("k_child")}`)]);
    });

    it("names a focused workspace by its project and branch", async () => {
      const { slot } = await mount(`repositories/repo/${key("k_child")}`, { overview: withOutside });
      await loaded(slot);
      expect(repoKeys(slot)).toEqual(["k_child"]);
      expect(chip(slot)?.textContent).toContain("Only Shop · agent/child");
    });

    it("has no focus chip on the plain Repositories view", async () => {
      const { slot } = await mount("repositories", { overview: withOutside });
      await loaded(slot);
      expect(chip(slot)).toBeNull();
      expect(repoKeys(slot)).toContain(CORTEX);
    });

    it("still applies the other filters, and says nothing matches", async () => {
      const { slot } = await mount(`repositories/repo/${key(CORTEX)}`, { overview: withOutside });
      await loaded(slot);
      fireEvent.change(slot.getByLabelText("Filter by text"), { target: { value: "no such file" } });
      expect(repoKeys(slot)).toEqual([]);
      expect(slot.container.textContent).toContain("No repositories match the filters.");
      expect(chip(slot)).not.toBeNull();
    });
  });

  it("switches with the view buttons, keeping the tree", async () => {
    const { slot, goTo } = await mount("tree/thr_root");
    await loaded(slot);
    fireEvent.click(slot.getByRole("button", { name: "Repositories" }));
    expect(navigations(slot)).toEqual([pushed("tree/thr_root/repositories")]);
    goTo("tree/thr_root/repositories");
    await waitFor(() => expect(slot.container.querySelector("[data-project-group]")).not.toBeNull());
    fireEvent.click(slot.getByRole("button", { name: "Worktrees" }));
    expect(navigations(slot)).toEqual([pushed("tree/thr_root/repositories"), pushed("tree/thr_root")]);
  });
});

describe("Vantage page: one thread's tree", () => {
  it("asks for the tree and says whose it is, with a way back to every thread", async () => {
    const { slot, overview } = await mount("tree/thr_root");
    await loaded(slot);
    expect(overview.mock.calls[0]?.[0]).toEqual({ target: { kind: "tree", threadId: "thr_root" }, scope: "uncommitted", includeArchived: false });
    expect(slot.container.textContent).toContain("Tree: Parent thread");
    expect(slot.container.textContent).not.toContain("last 24 h");
    fireEvent.click(slot.getByRole("button", { name: "Show all threads" }));
    expect(navigations(slot)).toEqual([pushed("")]);
  });

  it("offers no way back when it already shows every thread", async () => {
    const { slot } = await mount();
    await loaded(slot);
    expect(slot.queryByRole("button", { name: "Show all threads" })).toBeNull();
  });

  it("reads the other tree, and does not read again for a different selection in the same one", async () => {
    const { slot, overview, goTo } = await mount("tree/thr_root");
    await loaded(slot);
    goTo(`tree/thr_root/worktree/${key("k_child")}`);
    await waitFor(() => expect(header(slot)).toContain("Child worker"));
    expect(overview).toHaveBeenCalledTimes(1);
    goTo("tree/thr_docs");
    await waitFor(() => expect(overview.mock.calls.at(-1)?.[0]).toEqual({ target: { kind: "tree", threadId: "thr_docs" }, scope: "uncommitted", includeArchived: false }));
    expect(overview).toHaveBeenCalledTimes(2);
  });
});

describe("Vantage page: loading, errors and notices", () => {
  it("says so when no thread has a worktree in the window", async () => {
    const { slot } = await mount("", { overview: () => allOverview({ worktrees: [], repos: [], threads: [] }) });
    await waitFor(() => expect(slot.container.textContent).toContain("No worktrees in the last 24 hours."));
  });

  it("shows the load error with a Retry that asks the server to forget its cache", async () => {
    let fail = true;
    const { slot, overview } = await mount("", { overview: () => { if (fail) throw new Error("bb is down"); return allOverview(); } });
    await waitFor(() => expect(slot.getByRole("alert").textContent).toContain("Could not load changes: bb is down"));
    fail = false;
    fireEvent.click(within(slot.getByRole("alert")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(overview.mock.calls.at(-1)?.[0]).toEqual({ target: { kind: "all" }, scope: "uncommitted", includeArchived: false, refresh: true }));
    await loaded(slot);
  });

  it("shows the warnings, and says when the list was cut at the thread limit", async () => {
    const { slot } = await mount("", { overview: () => allOverview({ warnings: ["Could not reach Laptop: offline"], truncatedThreads: true }) });
    await loaded(slot);
    const notices = slot.getAllByRole("status").map((node) => node.textContent);
    expect(notices).toContain("Could not reach Laptop: offline");
    expect(notices).toContain("Showing the 4 most recent threads; raise the limit in Settings");
  });

  it("refreshes when the settings change", async () => {
    const { slot, overview } = await mount();
    await loaded(slot);
    await slot.emitRealtime("vantage:settings", {});
    await waitFor(() => expect(overview).toHaveBeenCalledTimes(2));
  });

  it("has a Refresh button that reloads from scratch", async () => {
    const { slot, overview } = await mount();
    await loaded(slot);
    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(overview.mock.calls.at(-1)?.[0]).toEqual({ target: { kind: "all" }, scope: "uncommitted", includeArchived: false, refresh: true }));
  });
});

describe("Vantage page: the instant outline", () => {
  const hold = () => {
    let release: (value: Overview) => void = () => {};
    const promise = new Promise<Overview>((resolve) => { release = resolve; });
    return { promise, release };
  };
  const fullOverview = () => allOverview({ sharedFiles: [sharedFile({ worktreeKeys: ["k_parent", "k_child"] })] });
  const pulses = (node: Element) => node.querySelectorAll("[aria-hidden='true'].animate-pulse");
  const slotText = (slot: Slot) => slot.container.textContent ?? "";

  it("shows 'Loading worktrees' before any result, instead of 'Looking for changes…'", async () => {
    const { slot } = await mount("", { overview: () => new Promise<Overview>(() => {}) });
    expect(slot.getByRole("status", { name: "Loading worktrees" })).toBeTruthy();
    expect(slotText(slot)).not.toContain("Looking for changes…");
  });

  it("makes one shell call and one overview call per load, with the page's archived choice (hidden)", async () => {
    const { slot, shell, overview } = await mount();
    await loaded(slot);
    expect(shell).toHaveBeenCalledTimes(1);
    expect(overview).toHaveBeenCalledTimes(1);
    expect(shell.mock.calls[0]?.[0]).toEqual({ target: { kind: "all" }, includeArchived: false });
    expect(overview.mock.calls[0]?.[0]).toEqual({ target: { kind: "all" }, scope: "uncommitted", includeArchived: false });
  });

  it("draws rows with titles and branches from the outline while the full overview is pending, and fills in the counts when it arrives", async () => {
    const full = hold();
    const { slot } = await mount("", { overview: () => full.promise, shell: () => partialOverview() });
    await loaded(slot);
    expect(rows(slot)).toEqual(["k_parent", "k_child", "k_idle", "k_docs"]);
    expect(row(slot, "k_child").textContent).toContain("Child worker");
    expect(row(slot, "k_child").textContent).toContain("agent/child");
    expect(row(slot, "k_child").textContent).not.toMatch(/[+−]\d|↑|uncommitted|clean/);
    expect(pulses(row(slot, "k_child")).length).toBeGreaterThanOrEqual(2);
    expect(slot.queryByRole("status", { name: "Loading worktrees" })).toBeNull();
    expect(summary(slot)).toContain("4 workspaces · 1 running · 1 needs you · 0 failed");
    expect(pulses(slot.container.querySelector("[data-page-summary]")!).length).toBeGreaterThan(0);
    expect(summary(slot)).not.toMatch(/\d+ files?/);
    full.release(fullOverview());
    await waitFor(() => expect(row(slot, "k_child").textContent).toContain("↑1 ↓0"));
    expect(pulses(row(slot, "k_child"))).toHaveLength(0);
    expect(rows(slot)).toEqual(["k_parent", "k_child", "k_docs"]);
    expect(summary(slot)).toBe("3 workspaces · 1 running · 1 needs you · 0 failed · 5 files +23 −4 · 2 projects");
  });

  it("shows the shared-files banner and the outside edits only with the full result", async () => {
    const full = hold();
    const { slot } = await mount("", { overview: () => full.promise, shell: () => partialOverview() });
    await loaded(slot);
    expect(slotText(slot)).not.toContain("changed in more than one worktree");
    expect(slotText(slot)).toContain("Looking for edits in other repositories…");
    full.release(fullOverview());
    await waitFor(() => expect(slotText(slot)).toContain("changed in more than one worktree"));
    expect(slotText(slot)).not.toContain("Looking for edits in other repositories…");
  });

  it("keeps a selected worktree's address while only the outline is shown, even when the outline lacks it", async () => {
    const full = hold();
    const { slot } = await mount(`worktree/${key("k_docs")}`, {
      overview: () => full.promise, shell: () => partialOverview({ worktrees: partialOverview().worktrees.filter((entry) => entry.key !== "k_docs") }),
    });
    await loaded(slot);
    expect(navigations(slot)).toEqual([]);
    full.release(fullOverview());
    await waitFor(() => expect(header(slot)).toContain("Docs thread"));
    expect(navigations(slot)).toEqual([]);
  });

  it("shows a loading worktree's detail beside the list: header and actions at once, skeleton changes, and Chat", async () => {
    const full = hold();
    const { slot } = await mount(`worktree/${key("k_child")}`, { overview: () => full.promise, shell: () => partialOverview() });
    await waitFor(() => expect(header(slot)).toContain("Child worker"));
    expect(slot.getByRole("status", { name: "Reading this worktree's git status…" })).toBeTruthy();
    fireEvent.click(slot.getByRole("tab", { name: /^Chat/ }));
    expect(slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id")).toBe("thr_child");
  });

  it("draws loading repositories in the Repositories view, ends with a skeleton section, and cannot expand everything yet", async () => {
    const full = hold();
    const { slot } = await mount("repositories", { overview: () => full.promise, shell: () => partialOverview() });
    await waitFor(() => expect(slot.container.querySelector("[data-project-group]")).not.toBeNull());
    const sections = slot.container.querySelectorAll("[data-repo]");
    expect(sections).toHaveLength(4);
    for (const section of sections) expect(section.querySelector("[role='status']")).not.toBeNull();
    const last = slot.container.querySelector("[role='status'][aria-label='Looking for edits in other repositories…']");
    expect(last).not.toBeNull();
    expect((slot.getByRole("button", { name: "Expand all" }) as HTMLButtonElement).disabled).toBe(true);
    full.release(fullOverview());
    await waitFor(() => expect((slot.getByRole("button", { name: "Expand all" }) as HTMLButtonElement).disabled).toBe(false));
    expect(slot.container.querySelector("[aria-label='Looking for edits in other repositories…']")).toBeNull();
  });
});

describe("Vantage page: archived threads", () => {
  const ARCHIVED_KEY = "bb-plugin-vantage:page-archived";
  const HINT = "Add archived threads and their kept branches below the active ones";
  const withHidden = (input: OverviewInput) => allOverview({ archivedHidden: input.includeArchived ? 0 : 2 });

  it("starts without archived threads and offers an unticked 'Include archived (2)' checkbox to add them", async () => {
    const { slot } = await mount("", { overview: withHidden });
    await loaded(slot);
    const toggle = slot.getByRole("checkbox", { name: "Include archived (2)" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(slot.queryByRole("button", { name: /Show archived/ })).toBeNull();
  });

  it("sits after 'With changes only' in the toolbar", async () => {
    const { slot } = await mount("", { overview: withHidden });
    await loaded(slot);
    const toggle = slot.getByRole("checkbox", { name: /Include archived/ });
    const changesOnly = slot.getByLabelText("With changes only");
    expect(changesOnly.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("reloads with archived threads included when clicked, remembers the choice, and keeps it for the next visit", async () => {
    const { slot, overview, shell } = await mount("", { overview: withHidden });
    await loaded(slot);
    fireEvent.click(slot.getByRole("checkbox", { name: "Include archived (2)" }));
    expect(window.localStorage.getItem(ARCHIVED_KEY)).toBe("true");
    await waitFor(() => expect(overview.mock.calls.at(-1)?.[0]).toEqual({ target: { kind: "all" }, scope: "uncommitted", includeArchived: true }));
    expect(shell.mock.calls.at(-1)?.[0]).toEqual({ target: { kind: "all" }, includeArchived: true });
    await waitFor(() => expect((slot.getByRole("checkbox", { name: /Include archived/ }) as HTMLInputElement).checked).toBe(true));
    slot.lifecycle.unmount();
    const again = await mount("", { overview: withHidden });
    expect(again.overview.mock.calls[0]?.[0]).toEqual({ target: { kind: "all" }, scope: "uncommitted", includeArchived: true });
  });

  it("hides them again when clicked a second time", async () => {
    window.localStorage.setItem(ARCHIVED_KEY, "true");
    const { slot, overview } = await mount("", { overview: withHidden });
    await loaded(slot);
    fireEvent.click(slot.getByRole("checkbox", { name: /Include archived/ }));
    expect(window.localStorage.getItem(ARCHIVED_KEY)).toBe("false");
    await waitFor(() => expect(overview.mock.calls.at(-1)?.[0]).toMatchObject({ includeArchived: false }));
  });

  it("explains the toggle in a hint", async () => {
    const { slot } = await mount("", { overview: withHidden });
    await loaded(slot);
    fireEvent.pointerMove(slot.getByText(/Include archived/).closest("label")!, { pointerType: "mouse" });
    expect((await within(document.body).findByRole("tooltip")).textContent).toBe(HINT);
  });

  it("while archived rows are still loading, shows one placeholder for them instead of rows that may vanish", async () => {
    const base = allOverview();
    const gone = threadSummary({ id: "thr_gone", title: "Old work", archived: true, environmentId: "env_9", rootThreadId: "thr_gone" });
    const pending = branchWorktree({ key: "k_gone", label: "Shop", projectId: "proj_shop", threadIds: ["thr_gone"], state: "loading", committed: [] });
    const { slot } = await mount("", { overview: () => overview({ ...base, threads: [...base.threads, gone], worktrees: [...base.worktrees, pending] }) });
    await loaded(slot);
    expect(slot.container.querySelector("[data-worktree-row='k_gone']")).toBeNull();
    expect(slot.getByRole("status", { name: "Loading archived threads" })).toBeTruthy();
  });

  it("lists archived repositories in their own project groups after every active group", async () => {
    window.localStorage.setItem(ARCHIVED_KEY, "true");
    const base = allOverview();
    const gone = threadSummary({ id: "thr_gone", title: "Old work", archived: true, environmentId: "env_9", rootThreadId: "thr_gone" });
    const kept = branchRepo({ key: "r_gone", label: "Shop", projectId: "proj_shop", threadIds: ["thr_gone"], files: [fileChange({ path: "old.ts" })] });
    const { slot } = await mount("repositories", { overview: () => overview({ ...base, threads: [...base.threads, gone], repos: [...base.repos, kept] }) });
    await loaded(slot);
    const headings = [...slot.container.querySelectorAll("[data-project-group]")].map((node) => node.textContent ?? "");
    expect(headings.at(-1)).toMatch(/^Archived · Shop · 1 repo/);
    expect(headings.slice(0, -1).every((heading) => !heading.startsWith("Archived"))).toBe(true);
  });

  it("applies to a thread's tree on the page too, and leaves the side tab's own choice alone", async () => {
    window.localStorage.setItem("bb-plugin-vantage:panel-archived", "false");
    const { slot, overview } = await mount("tree/thr_root");
    await waitFor(() => expect(overview).toHaveBeenCalled());
    expect(overview.mock.calls[0]?.[0]).toEqual({ target: { kind: "tree", threadId: "thr_root" }, scope: "uncommitted", includeArchived: false });
    slot.lifecycle.unmount();
  });
});
