import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { Overview, OverviewInput, PatchRequest, rpcContract } from "../src/contract";
import { clearFileCache } from "../src/file-row";
import { allOverview, sidebarThread } from "./fixtures";

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
  create?: () => unknown;
  openTerminal?: () => boolean;
}

async function mount(subPath = "", options: Options = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const overview = vi.fn(options.overview ?? ((input: OverviewInput) => (
    input.target.kind === "tree" ? allOverview({ target: input.target, threadId: input.target.threadId, windowHours: null }) : allOverview()
  )));
  const patch = vi.fn(async (input: PatchRequest) => ({ patch: `+patch ${input.scope} ${input.path}`, truncated: false, binary: false }));
  const create = vi.fn(options.create ?? (async () => ({ id: "term_1" })));
  const slot = renderSlot<PluginNavPanelProps, typeof rpcContract>(app.navPanels[0]!, { subPath }, {
    pluginId: "vantage",
    rpc: { overview, patch, recordedEdits: () => ({ edits: [] }), commitFiles: () => ({ files: [] }) },
    sdk: { subscribe: (() => () => {}) as never, terminals: { create: create as never } },
    sidebarThreads: { status: "ready", threads: SIDEBAR }, sidebarPullRequests: {}, threadActions: (() => []) as never,
    openTerminal: options.openTerminal ?? (() => true),
  });
  mounts.push(slot);
  await waitFor(() => expect(overview).toHaveBeenCalled());
  const Panel = app.navPanels[0]!.component;
  const goTo = (next: string) => slot.lifecycle.rerender(<Panel subPath={next} />);
  return { slot, overview, patch, create, goTo };
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
    expect(overview.mock.calls[0]?.[0]).toEqual({ target: { kind: "all" }, scope: "uncommitted" });
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
    expect(overview.mock.calls[1]?.[0]).toEqual({ target: { kind: "all" }, scope: "branch" });
    expect(slot.getByRole("button", { name: "Expand all" })).toBeTruthy();
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
    expect(overview.mock.calls[0]?.[0]).toEqual({ target: { kind: "tree", threadId: "thr_root" }, scope: "uncommitted" });
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
    await waitFor(() => expect(overview.mock.calls.at(-1)?.[0]).toEqual({ target: { kind: "tree", threadId: "thr_docs" }, scope: "uncommitted" }));
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
    await waitFor(() => expect(overview.mock.calls.at(-1)?.[0]).toEqual({ target: { kind: "all" }, scope: "uncommitted", refresh: true }));
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
    await waitFor(() => expect(overview.mock.calls.at(-1)?.[0]).toEqual({ target: { kind: "all" }, scope: "uncommitted", refresh: true }));
  });
});
