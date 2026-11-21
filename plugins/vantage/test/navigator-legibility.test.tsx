import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Overview, rpcContract } from "../src/contract";
import { clearLoadedCache } from "../src/loaded";
import { NAV_WIDTH_MIN } from "../src/navigator";
import { panelSelection } from "../src/panel";
import { disposeSessions } from "../src/session";
import { reloadUiState } from "../src/ui-prefs";
import { fileChange, overview, sidebarThread, threadSummary, worktree } from "./fixtures";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

// Root shares its checkout with Side. Worker has its own worktree with a nested folder.
const SHARED = worktree({
  key: "host_1:/work/root",
  threadIds: ["thr_root", "thr_side"],
  root: "/work/root",
  branch: "worker/feature-with-a-branch-name-too-long-for-the-navigator",
  uncommitted: [fileChange({ path: "README.md" }), fileChange({ path: "entries/vantage.json" })],
});
const WORKER = worktree({
  key: "host_1:/work/worker",
  threadIds: ["thr_worker"],
  root: "/work/worker",
  branch: "bb/worker",
  uncommitted: [fileChange({ path: "src/a.ts" }), fileChange({ path: "src/lib/b.ts" })],
});
const recorded = (threadId: string, path: string) =>
  fileChange({ path, status: "clean", edits: { threadIds: [threadId], rawPaths: [path], count: 1 } });
const child = (id: string, title: string, extra: Partial<ReturnType<typeof threadSummary>> = {}) =>
  threadSummary({ id, title, parentThreadId: "thr_root", rootThreadId: "thr_root", depth: 1, ...extra });

const TREE: Overview = overview({
  threadId: "thr_root",
  target: { kind: "tree", threadId: "thr_root" },
  threads: [
    threadSummary({ id: "thr_root", title: "Prepare the next release and check the results", rootThreadId: "thr_root" }),
    child("thr_worker", "Worker"),
    child("thr_side", "Side"),
    threadSummary({ id: "thr_juno", title: "Juno", parentThreadId: "thr_worker", rootThreadId: "thr_root", depth: 2 }),
    child("thr_iris", "Iris", { archived: true }),
    child("thr_sam", "Sam", { archived: true }),
    child("thr_flares", "Flares: Parent", { hidden: true, companionOf: "thr_root" }),
  ],
  worktrees: [SHARED, WORKER],
  otherFiles: [recorded("thr_worker", "/work/root/notes.md"), recorded("thr_root", "/work/root/README.md")],
});
const SIDEBAR = [
  sidebarThread({ id: "thr_root", displayTitle: "Prepare the next release and check the results" }),
  sidebarThread({ id: "thr_worker", displayTitle: "Worker", parentThreadId: "thr_root", indicator: "runtime" }),
  sidebarThread({ id: "thr_side", displayTitle: "Side", parentThreadId: "thr_root" }),
  sidebarThread({ id: "thr_juno", displayTitle: "Juno", parentThreadId: "thr_worker" }),
];

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
  vi.unstubAllGlobals();
});

function panelWidth(width: number) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ target, contentRect: { width } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
}

async function mountPanel(tree: Overview = TREE) {
  const app = await loadPluginApp(() => import("../app"));
  const tab = app.tabs.find((entry) => entry.context.kind === "thread")!;
  const slot = renderSlot<{ threadId: string; params: null }, typeof rpcContract>(
    tab as never,
    { threadId: "thr_root", params: null },
    {
      pluginId: "vantage",
      rpc: {
        shell: () => new Promise<Overview>(() => {}),
        overview: () => tree,
        patch: () => ({ patch: "@@ -1 +1 @@\n-a\n+b", truncated: false, binary: false }),
        fileSides: () => ({ old: null, new: null }),
        image: () => ({ old: null, new: null, truncated: false }),
        recordedEdits: () => ({ edits: [] }),
        commitFiles: () => ({ files: [] }),
        reviewed: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map((entry) => [entry, {}])),
        setReviewed: () => ({}),
      } as never,
      sdk: { subscribe: (() => () => {}) as never, terminals: { create: vi.fn() as never } },
      sidebarThreads: { status: "ready", threads: SIDEBAR },
      threadActions: (() => []) as never,
    },
  );
  mounts.push(slot);
  // Below the cut-over the trail sits in a closed sheet, so wait for the review instead.
  await waitFor(() =>
    expect(slot.container.querySelectorAll("[data-trail-thread], [data-review]").length).toBeGreaterThan(0),
  );
  return { slot, view: within(slot.container) };
}

const trail = (slot: Slot) => within(slot.container).getByRole("navigation", { name: "Thread trail" });
const rowOf = (slot: Slot, id: string) =>
  trail(slot).querySelector<HTMLElement>(`[data-trail-thread="${id}"] > [data-row="thread"]`)!;
const selectThread = (slot: Slot, id: string) =>
  fireEvent.click(rowOf(slot, id).querySelector<HTMLElement>("[data-trail-select]")!);
const filesSection = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-navigator-files]");
const before = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe("Navigator levels", () => {
  it("gives threads a 32 px row with a 16 px status slot, a foreground title and a right-aligned count", async () => {
    panelWidth(900);
    const { slot } = await mountPanel();
    for (const id of ["thr_root", "thr_worker", "thr_side"]) {
      const row = rowOf(slot, id);
      expect(row.className).toMatch(/\bmin-h-8\b/);
      expect(row.querySelector("[data-status-slot]")!.className).toMatch(/\bsize-4\b/);
      const title = row.querySelector<HTMLElement>("[data-row-title]")!;
      expect(title.className).toMatch(/text-\[13px\]/);
      expect(title.className).toMatch(/\btext-foreground\b/);
      const count = row.querySelector<HTMLElement>("[data-row-count]")!;
      expect(count.className).toMatch(/\btabular-nums\b/);
      expect(count.className).toMatch(/\btext-right\b/);
    }
  });

  it("indents 16 px per level with one 1 px guide per ancestor", async () => {
    panelWidth(900);
    const { slot } = await mountPanel();
    selectThread(slot, "thr_worker");
    const depthOf = (row: HTMLElement) => Number(row.dataset.depth);
    const juno = rowOf(slot, "thr_juno");
    expect(depthOf(rowOf(slot, "thr_root"))).toBe(0);
    expect(depthOf(rowOf(slot, "thr_worker"))).toBe(1);
    expect(depthOf(juno)).toBe(2);
    expect(juno.style.paddingLeft).toBe("32px");
    const guides = [...juno.querySelectorAll<HTMLElement>("[data-indent-guide]")];
    expect(guides).toHaveLength(2);
    for (const guide of guides) expect(guide.className).toMatch(/\bw-px\b/);
    // Folders in the Files section use the same step.
    const nested = await waitFor(() => filesSection(slot)!.querySelector<HTMLElement>('[data-tree-dir="src/lib"]')!);
    const folderRow = nested.querySelector<HTMLElement>("[data-file-nav]")!;
    expect(folderRow.querySelectorAll("[data-indent-guide]")).toHaveLength(1);
  });

  it("shows evidence rows only under the selected thread, on one line, at least 28 px tall", async () => {
    panelWidth(900);
    const { slot } = await mountPanel();
    selectThread(slot, "thr_worker");
    const sources = [
      ...trail(slot).querySelectorAll<HTMLElement>('[data-trail-thread="thr_worker"] > ul > li > [data-row="source"]'),
    ];
    expect(
      sources.map((source) => source.querySelector("[data-trail-source]")!.getAttribute("data-trail-source")),
    ).toEqual(["recorded", "checkout"]);
    for (const source of sources) {
      expect(source.className).toMatch(/\bmin-h-7\b/);
      const label = source.querySelector<HTMLElement>("[data-row-title]")!;
      const qualifier = source.querySelector<HTMLElement>("[data-row-qualifier]")!;
      // The qualifier sits on the label's line, not on a second line below it.
      expect(label.parentElement).toBe(qualifier.parentElement);
      expect(label.parentElement!.className).not.toMatch(/flex-col/);
    }
    expect(sources[1]!.textContent).toMatch(/Checkout Git.*its own checkout/);
    expect(trail(slot).querySelector('[data-trail-thread="thr_root"] > ul > li > [data-row="source"]')).toBeNull();
  });
});

describe("Files section", () => {
  it("lists the selected source's files below the trail, never between threads", async () => {
    panelWidth(900);
    const { slot } = await mountPanel();
    selectThread(slot, "thr_worker");
    const files = await waitFor(() => {
      const section = filesSection(slot)!;
      expect(section.querySelector("[data-tree-file]")).not.toBeNull();
      return section;
    });
    expect(trail(slot).querySelector("[data-tree-file], [data-tree-dir]")).toBeNull();
    expect(trail(slot).contains(files)).toBe(false);
    // Every thread row, including Side after Worker and the group of archived threads, comes before the first file.
    const lastThread = [...trail(slot).querySelectorAll("[data-trail-thread], [data-trail-archived-group]")].at(-1)!;
    expect(before(lastThread, files.querySelector("[data-tree-file]")!)).toBe(true);
    const header = files.querySelector<HTMLElement>("[data-files-header]")!;
    expect(header.textContent).toMatch(/Files/);
    expect(header.textContent).toMatch(/Checkout Git/);
    expect(header.textContent).toMatch(/2$/);
    // Collapse every folder lives in the header, not on a row of its own.
    expect(within(header).getByRole("button", { name: "Collapse every folder" })).toBeTruthy();
    // The header folds the file list away and gives the room back to the trail.
    const toggle = within(header).getByRole("button", { name: /^Files/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(
      within(filesSection(slot)!)
        .getByRole("button", { name: /^Files/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(filesSection(slot)!.querySelector("[data-tree-file]")).toBeNull();
  });

  it("keeps the trail's warnings above the files and lets each part scroll on its own", async () => {
    panelWidth(900);
    const { slot, view } = await mountPanel();
    selectThread(slot, "thr_worker");
    const files = await waitFor(() => {
      const section = filesSection(slot)!;
      expect(section.querySelector("[data-files-scroll]")).not.toBeNull();
      return section;
    });
    const nav = trail(slot);
    expect(nav.className).toMatch(/overflow-y-auto/);
    expect(nav.className).toMatch(/max-h-\[/);
    const footer = view.getByRole("button", { name: "1 Flare helper · no edits" });
    expect(nav.contains(footer)).toBe(true);
    expect(files.querySelector("[data-files-scroll]")!.className).toMatch(/overflow-y-auto/);
  });

  it("steps from the last trail row into the files with the arrows, and Right on the source opens its files", async () => {
    panelWidth(900);
    const { slot } = await mountPanel();
    selectThread(slot, "thr_worker");
    const root = slot.container.querySelector<HTMLElement>("[data-navigator-tree]")!;
    await waitFor(() => expect(filesSection(slot)!.querySelector("[data-file-nav]")).not.toBeNull());
    const source = trail(slot).querySelector<HTMLElement>('[data-trail-source="checkout"]')!;
    source.focus();
    fireEvent.keyDown(source, { key: "ArrowRight" });
    expect(filesSection(slot)!.contains(document.activeElement)).toBe(true);
    // Left folds the open top folder first, then goes to the source that lists it.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement!.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(source);
    expect(root.querySelectorAll('[data-nav-item][tabindex="0"], [data-file-nav][tabindex="0"]')).toHaveLength(1);
  });
});

describe("Selection style", () => {
  it("marks the selected thread and the selected file with an accent bar and fill, and nothing else", async () => {
    panelWidth(900);
    const { slot } = await mountPanel();
    selectThread(slot, "thr_worker");
    const selected = [...slot.container.querySelectorAll<HTMLElement>('[data-navigator-tree] [data-selected="true"]')];
    expect(selected).toEqual([rowOf(slot, "thr_worker")]);
    expect(rowOf(slot, "thr_worker").querySelector("[data-selection-bar]")!.className).toMatch(/\bbg-primary\b/);
    // The active source is current, but it does not repeat the selection fill.
    const source = trail(slot).querySelector<HTMLElement>('[data-trail-source="checkout"]')!;
    expect(source.getAttribute("aria-current")).toBe("true");
    expect(source.closest("[data-row]")!.hasAttribute("data-selected")).toBe(false);
    expect(source.closest("[data-row]")!.className).not.toMatch(/bg-surface-selected/);
    const file = await waitFor(() =>
      filesSection(slot)!.querySelector<HTMLElement>('[data-tree-file="src/a.ts"] [data-file-nav]')!,
    );
    fireEvent.click(file);
    const fileRow = filesSection(slot)!.querySelector<HTMLElement>('[data-tree-file="src/a.ts"]')!;
    await waitFor(() => expect(fileRow.dataset.selected).toBe("true"));
    expect(fileRow.querySelector("[data-selection-bar]")).not.toBeNull();
    // Keyboard focus is a visible ring on every row.
    expect(file.className).toMatch(/focus-visible:ring-2/);
    expect(rowOf(slot, "thr_side").querySelector("[data-trail-select]")!.className).toMatch(/focus-visible:ring-2/);
  });

  it("draws group and disclosure rows quietly: no fill, a chevron and muted text, the footer on one line", async () => {
    panelWidth(900);
    const { slot, view } = await mountPanel();
    const group = within(trail(slot)).getByRole("button", { name: /^2 more archived threads/ });
    const groupRow = group.closest<HTMLElement>("[data-row]")!;
    expect(groupRow.dataset.quiet).toBe("true");
    expect(groupRow.className).not.toMatch(/bg-surface-selected/);
    expect(group.className).not.toMatch(/bg-surface-selected/);
    expect(group.querySelector("[data-chevron]")).not.toBeNull();
    const footer = view.getByRole("button", { name: "1 Flare helper · no edits" });
    expect(footer.dataset.quiet).toBe("true");
    expect(footer.className).toMatch(/\bw-full\b/);
    expect(footer.className).toMatch(/\btext-left\b/);
    expect(footer.querySelector<HTMLElement>("[data-row-title]")!.className).toMatch(/\btruncate\b/);
  });

  it("lifts muted text, counts and the selection fill from bb's own tokens on the navigator", async () => {
    panelWidth(900);
    const { slot } = await mountPanel();
    const aside = slot.container.querySelector<HTMLElement>("[data-navigator]")!;
    const tone = (name: string) => aside.style.getPropertyValue(name);
    expect(tone("--vantage-nav-muted")).toMatch(
      /color-mix\(in oklab, var\(--muted-foreground\) \d+%, var\(--foreground\)\)/,
    );
    expect(tone("--vantage-nav-removed")).toMatch(/var\(--diff-removed\).*var\(--foreground\)/);
    expect(tone("--vantage-nav-added")).toMatch(/var\(--diff-added\).*var\(--foreground\)/);
    expect(tone("--vantage-nav-selected")).toMatch(/var\(--primary\)/);
    selectThread(slot, "thr_worker");
    const counts = await waitFor(() =>
      filesSection(slot)!.querySelector<HTMLElement>('[data-tree-file="src/a.ts"] [data-counts]')!,
    );
    expect(counts.innerHTML).toMatch(/--vantage-nav-removed/);
    expect(counts.innerHTML).toMatch(/--vantage-nav-added/);
    // The status letter beside the name is lifted the same way.
    const letter = filesSection(slot)!.querySelector<HTMLElement>('[data-tree-file="src/a.ts"] [title="Modified"]');
    expect(letter?.className ?? "").toMatch(/--vantage-nav-warning/);
  });

  it("gives folder and file rows at least 28 px and the tick a 24 px target", async () => {
    panelWidth(900);
    const { slot } = await mountPanel();
    selectThread(slot, "thr_worker");
    const files = await waitFor(() => {
      const section = filesSection(slot)!;
      expect(section.querySelector("[data-tree-file]")).not.toBeNull();
      return section;
    });
    expect(files.querySelector<HTMLElement>('[data-tree-dir="src"] > [data-file-nav]')!.className).toMatch(
      /\bmin-h-7\b/,
    );
    const fileRow = files.querySelector<HTMLElement>('[data-tree-file="src/a.ts"]')!;
    expect(fileRow.className).toMatch(/\bmin-h-7\b/);
    const tick = within(fileRow).getByRole("button", { name: "Mark src/a.ts as reviewed" });
    expect(tick.className).toMatch(/\bsize-6\b/);
  });
});

describe("Resizable navigator", () => {
  const separator = (slot: Slot) => within(slot.container).getByRole("separator", { name: "Resize the trail" });
  // The column reads its width from this property, which jsdom keeps verbatim.
  const width = (slot: Slot) =>
    slot.container.querySelector<HTMLElement>("[data-navigator]")!.style.getPropertyValue("--vantage-nav-width");

  it("defaults to clamp(260px, 34%, 380px) and moves with the arrows between 220 px and half the panel", async () => {
    panelWidth(900);
    const { slot } = await mountPanel();
    const handle = separator(slot);
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.tabIndex).toBe(0);
    expect(width(slot)).toBe("clamp(260px, 34%, 380px)");
    expect(handle.getAttribute("aria-valuenow")).toBe("306");
    expect(handle.getAttribute("aria-valuemin")).toBe(String(NAV_WIDTH_MIN));
    expect(handle.getAttribute("aria-valuemax")).toBe("450");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("322");
    expect(width(slot)).toBe("clamp(220px, 322px, 50%)");
    for (let i = 0; i < 20; i++) fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("450");
    for (let i = 0; i < 30; i++) fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle.getAttribute("aria-valuenow")).toBe("220");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle.getAttribute("aria-valuenow")).toBe("306");
    expect(width(slot)).toBe("clamp(260px, 34%, 380px)");
  });

  it("follows a drag and remembers the width for the side panel", async () => {
    panelWidth(900);
    const first = await mountPanel();
    const handle = separator(first.slot);
    act(() => {
      fireEvent.pointerDown(handle, { clientX: 306, pointerId: 1, button: 0 });
      fireEvent.pointerMove(handle, { clientX: 346, pointerId: 1 });
      fireEvent.pointerUp(handle, { clientX: 346, pointerId: 1 });
    });
    expect(handle.getAttribute("aria-valuenow")).toBe("346");
    first.slot.lifecycle.unmount();
    mounts.splice(0);
    disposeSessions();
    const second = await mountPanel();
    expect(separator(second.slot).getAttribute("aria-valuenow")).toBe("346");
    expect(width(second.slot)).toBe("clamp(220px, 346px, 50%)");
  });
});

describe("Folded cards", () => {
  const card = (slot: Slot, path: string) => slot.container.querySelector<HTMLElement>(`[data-file-card="${path}"]`);

  it("opens the first cards with their diffs when nothing was folded", async () => {
    panelWidth(900);
    const { slot } = await mountPanel();
    await waitFor(() => expect(card(slot, "README.md")).not.toBeNull());
    const fold = within(card(slot, "README.md")!).getByRole("button", { name: "Hide README.md" });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(card(slot, "README.md")!.querySelector("[data-card-body]")).not.toBeNull());
  });

  it("folds every card, the first included, after a Collapse all saved on this device, and says so on the bar", async () => {
    window.localStorage.setItem("bb-plugin-vantage:fold-all", "true");
    reloadUiState();
    panelWidth(900);
    const { slot, view } = await mountPanel();
    await waitFor(() => expect(card(slot, "entries/vantage.json")).not.toBeNull());
    for (const path of ["README.md", "entries/vantage.json"]) {
      const show = within(card(slot, path)!).getByRole("button", { name: `Show ${path}` });
      expect(show.getAttribute("aria-expanded")).toBe("false");
      expect(card(slot, path)!.hasAttribute("data-body-deferred")).toBe(false);
    }
    // The panel's compact bar names the state, so a fold left over from another view reads as a choice to undo.
    const expand = view.getByRole("button", { name: "Expand all diffs" });
    expect(expand.textContent).toMatch(/Expand all/);
    fireEvent.click(expand);
    expect(window.localStorage.getItem("bb-plugin-vantage:fold-all")).toBe("false");
    await waitFor(() => expect(card(slot, "README.md")!.querySelector("[data-card-body]")).not.toBeNull());
  });
});

describe("Panel chrome", () => {
  it("caps the branch chip so the chips stay on one line beside the navigator", async () => {
    panelWidth(900);
    const { slot } = await mountPanel();
    const chips = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-thread-chips]")!);
    const label = chips.querySelector<HTMLElement>("[data-branch-label]")!;
    expect(label.className).toMatch(/max-w-24/);
    expect(label.closest("button")!.title).toBe(SHARED.branch);
  });

  it("puts the narrow thread line in the breadcrumb band instead of a band of its own", async () => {
    panelWidth(420);
    const { slot } = await mountPanel();
    const crumbs = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-panel-crumbs]")!);
    const line = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-thread-line]")!);
    expect(crumbs.contains(line)).toBe(true);
    expect(within(crumbs).getByRole("button", { name: "Terminal" })).toBeTruthy();
    expect(crumbs.className).not.toMatch(/\bborder-b\b/);
  });

  it("says the shared checkout's full-page handoff opens this review, not a roster", async () => {
    panelWidth(900);
    const { slot, view } = await mountPanel();
    const chips = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-thread-chips]")!);
    fireEvent.click(within(chips).getByRole("button", { name: /^Shared checkout/ }));
    const dialog = view.getByRole("dialog", { name: /^Shared checkout/ });
    const open = within(dialog).getByRole("button", { name: "Open this review on the full page" });
    const note = document.getElementById(open.getAttribute("aria-describedby") ?? "")!;
    expect(note.textContent).toMatch(/not a list of the threads/i);
  });
});
