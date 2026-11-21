import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Overview, rpcContract } from "../src/contract";
import { reviewDraftKey } from "../src/comments";
import { incompleteWarning } from "../src/incomplete";
import { clearLoadedCache } from "../src/loaded";
import { CUTOVER_PX, tabbables } from "../src/navigator";
import { panelSelection } from "../src/panel";
import { disposeSessions } from "../src/session";
import { comments } from "../src/shared";
import { reloadUiState } from "../src/ui-prefs";
import { branchWorktree, fileChange, overview, sidebarThread, threadSummary, worktree } from "./fixtures";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

// Root shares its checkout with Side and a Flare companion. Worker has its own worktree, which overlaps Side's.
const SHARED = worktree({
  key: "host_1:/work/root",
  threadIds: ["thr_root", "thr_side", "thr_flares"],
  root: "/work/root",
  branch: "bb/root",
  uncommitted: [fileChange({ path: "notes.md" })],
});
const WORKER = worktree({
  key: "host_1:/work/worker",
  threadIds: ["thr_worker"],
  root: "/work/worker",
  branch: "bb/worker",
  behindCount: 4,
  aheadCount: 1,
  ref: { kind: "workspace", environmentId: "env_worker", base: "origin/main" },
  uncommitted: [fileChange({ path: "src/a.ts" }), fileChange({ path: "src/lib/b.ts" })],
});
const SIDE = worktree({
  key: "host_1:/work/side",
  threadIds: ["thr_side"],
  root: "/work/side",
  branch: "bb/side",
  uncommitted: [fileChange({ path: "src/a.ts" })],
});
const KEPT = branchWorktree({ key: "host_1:/code/proj@bb/wren", threadIds: ["thr_wren"], branch: "bb/wren" });
const recorded = (threadId: string, path: string) =>
  fileChange({ path, status: "clean", edits: { threadIds: [threadId], rawPaths: [path], count: 1 } });

const child = (id: string, title: string, extra: Partial<ReturnType<typeof threadSummary>> = {}) =>
  threadSummary({ id, title, parentThreadId: "thr_root", rootThreadId: "thr_root", depth: 1, ...extra });

const HEAVY: Overview = overview({
  threadId: "thr_root",
  target: { kind: "tree", threadId: "thr_root" },
  threads: [
    threadSummary({ id: "thr_root", title: "Parent", rootThreadId: "thr_root" }),
    child("thr_worker", "Worker"),
    child("thr_side", "Side"),
    child("thr_iris", "Iris", { archived: true }),
    threadSummary({ id: "thr_juno", title: "Juno", parentThreadId: "thr_iris", rootThreadId: "thr_root", depth: 2 }),
    child("thr_wren", "Wren", { archived: true, recordsIncomplete: true }),
    child("thr_sam", "Sam", { archived: true }),
    child("thr_ravi", "Ravi", { archived: true, recordsIncomplete: true }),
    child("thr_probe", "Probe", { hidden: true }),
    child("thr_study", "Study worker", { hidden: true }),
    child("thr_flares", "Flares: Parent", { hidden: true, companionOf: "thr_root" }),
  ],
  worktrees: [SHARED, WORKER, SIDE, KEPT],
  sharedFiles: [{ projectId: "proj_1", path: "src/a.ts", worktreeKeys: [WORKER.key, SIDE.key] }],
  otherFiles: [
    recorded("thr_worker", "/work/root/notes.md"),
    recorded("thr_wren", "/code/proj/src/hires.ts"),
    recorded("thr_sam", "/work/root/sam.ts"),
    recorded("thr_probe", "/work/root/probe.ts"),
  ],
  warnings: [incompleteWarning(2, "tree")],
});
const SIDEBAR = [
  sidebarThread({ id: "thr_root", displayTitle: "Parent" }),
  sidebarThread({ id: "thr_worker", displayTitle: "Worker", parentThreadId: "thr_root", indicator: "runtime" }),
  sidebarThread({ id: "thr_side", displayTitle: "Side", parentThreadId: "thr_root" }),
  sidebarThread({ id: "thr_juno", displayTitle: "Juno", parentThreadId: "thr_iris", indicator: "runtime" }),
];

type Slot = ReturnType<typeof renderSlot>;
const mounts: Slot[] = [];
afterEach(() => {
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  disposeSessions();
  clearLoadedCache();
  panelSelection.set(null);
  for (const key of [reviewDraftKey(WORKER.key, "thr_worker"), reviewDraftKey(KEPT.key, "thr_wren")])
    comments.clear(key);
  document.body.replaceChildren();
  window.localStorage.clear();
  reloadUiState();
  vi.unstubAllGlobals();
});

// jsdom has no layout: the panel reads its width from ResizeObserver, which reports this.
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

async function mountPanel(tree: Overview = HEAVY, overviewCall = vi.fn()) {
  const app = await loadPluginApp(() => import("../app"));
  const tab = app.tabs.find((entry) => entry.context.kind === "thread")!;
  const slot = renderSlot<{ threadId: string; params: null }, typeof rpcContract>(
    tab as never,
    { threadId: "thr_root", params: null },
    {
      pluginId: "vantage",
      rpc: {
        shell: () => new Promise<Overview>(() => {}),
        overview: (input: unknown) => {
          overviewCall(input);
          return tree;
        },
        patch: () => ({ patch: "@@ -1 +1 @@\n-a\n+b", truncated: false, binary: false }),
        fileSides: () => ({ old: null, new: null }),
        image: () => ({ old: null, new: null, truncated: false }),
        recordedEdits: () => ({ edits: [] }),
        commitFiles: () => ({ files: [] }),
        reviewed: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map((entry) => [entry, {}])),
        setReviewed: () => ({}),
      } as never,
      sdk: {
        subscribe: (() => () => {}) as never,
        terminals: { create: vi.fn() as never },
        threads: { send: vi.fn(async () => ({ delivery: "sent" })) as never },
      },
      sidebarThreads: { status: "ready", threads: SIDEBAR },
      threadActions: (() => []) as never,
    },
  );
  mounts.push(slot);
  await waitFor(() => expect(slot.container.querySelectorAll("[data-trail-thread]").length).toBeGreaterThan(0));
  return { slot, view: within(slot.container) };
}

const panel = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-vantage-panel]")!;
const trail = (slot: Slot) => within(slot.container).getByRole("navigation", { name: "Thread trail" });
const row = (slot: Slot, name: RegExp | string) => within(trail(slot)).getByRole("button", { name });
const threadRow = (slot: Slot, id: string) =>
  trail(slot).querySelector<HTMLElement>(`[data-trail-thread="${id}"] [data-trail-select]`)!;
const tabStops = (root: HTMLElement) =>
  root.querySelectorAll('[data-nav-item][tabindex="0"], [data-file-nav][tabindex="0"]').length;

describe("Navigator layout", () => {
  it("puts the navigator beside the diffs from CUTOVER_PX and behind a Trail sheet below it", async () => {
    expect(CUTOVER_PX).toBe(720);
    panelWidth(CUTOVER_PX);
    const wide = await mountPanel();
    expect(panel(wide.slot).dataset.layout).toBe("columns");
    expect(wide.slot.container.querySelector("[data-navigator] nav[aria-label='Thread trail']")).not.toBeNull();
    expect(wide.view.queryByRole("button", { name: /^Trail: / })).toBeNull();
    wide.slot.lifecycle.unmount();
    mounts.splice(0);
    disposeSessions();

    panelWidth(CUTOVER_PX - 1);
    const narrow = await mountPanelNarrow();
    expect(panel(narrow.slot).dataset.layout).toBe("sheet");
    expect(narrow.view.queryByRole("navigation", { name: "Thread trail" })).toBeNull();
    const crumb = narrow.view.getByRole("button", { name: /^Trail: 10 threads\. Reading This thread, Checkout Git/ });
    expect(crumb.getAttribute("aria-haspopup")).toBe("dialog");
    expect(crumb.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps one title line and one line of chips above the toolbar, with no strips", async () => {
    panelWidth(900);
    const { slot, view } = await mountPanel();
    fireEvent.click(row(slot, /^Worker/));
    const line = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-thread-line]")!);
    expect(within(line).getByRole("heading", { name: "Worker" })).toBeTruthy();
    const chips = slot.container.querySelector<HTMLElement>("[data-thread-chips]")!;
    expect(within(chips).getByRole("button", { name: /Overlaps · 1 thread/ })).toBeTruthy();
    expect(within(chips).getByRole("button", { name: /bb\/worker/ })).toBeTruthy();
    expect(slot.container.querySelector("[data-strip]")).toBeNull();
    expect(view.queryByText(/so merging may conflict/)).toBeNull();
    expect(view.queryByText(/These diffs update as the agent edits/)).toBeNull();
    // Working explains itself to keyboard and touch, not only on hover.
    const working = within(line).getByRole("button", { name: /^Working/ });
    expect(working.getAttribute("aria-haspopup")).toBe("dialog");
    working.focus();
    fireEvent.click(working);
    const pop = view.getByRole("dialog", { name: "Working" });
    expect(pop.textContent).toMatch(/diffs can change while you read/);
    expect(pop.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(view.queryByRole("dialog", { name: "Working" })).toBeNull();
    expect(document.activeElement).toBe(working);
    // The branch chip opens the checkout card: the base, the copies and Terminal.
    fireEvent.click(within(chips).getByRole("button", { name: /bb\/worker/ }));
    const card = view.getByRole("dialog", { name: "Checkout" });
    expect(card.textContent).toMatch(/vs origin\/main · 1 ahead · 4 behind/);
    for (const name of ["Copy the branch name", "Copy path", "Terminal"])
      expect(within(card).getByRole("button", { name })).toBeTruthy();
  });

  it("says Overlaps · N threads at narrow widths and lists them with Compare only, keeping focus inside", async () => {
    panelWidth(420);
    const { slot, view } = await mountPanelNarrow();
    openSheet(slot);
    fireEvent.click(within(sheet(slot)).getByRole("button", { name: /^Worker/ }));
    fireEvent.keyDown(sheet(slot), { key: "Escape" });
    const chip = await view.findByRole("button", { name: "Overlaps · 1 thread" });
    chip.focus();
    fireEvent.click(chip);
    const pop = view.getByRole("dialog", { name: /^Overlaps/ });
    expect(pop.contains(document.activeElement)).toBe(true);
    expect(within(pop).getByRole("button", { name: "Compare" })).toBeTruthy();
    expect(within(pop).queryByRole("button", { name: /Ask to rebase/ })).toBeNull();
    const focusable = [...pop.querySelectorAll<HTMLElement>("button")];
    focusable.at(-1)!.focus();
    fireEvent.keyDown(focusable.at(-1)!, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);
    fireEvent.keyDown(focusable[0]!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(focusable.at(-1));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(view.queryByRole("dialog", { name: /^Overlaps/ })).toBeNull();
    expect(document.activeElement).toBe(chip);
  });
});

describe("Trail continuity", () => {
  it("keeps archived ancestors of live work, the selected and recently viewed archives in place, and folds the rest", async () => {
    panelWidth(900);
    const { slot } = await mountPanel();
    const nav = trail(slot);
    // Iris is archived but Juno under it is working: it stays in its lineage.
    expect(nav.querySelector('[data-trail-thread="thr_iris"] [data-trail-thread="thr_juno"]')).not.toBeNull();
    // Wren, Sam and Ravi fold into one group under their parent.
    const group = within(nav).getByRole("button", { name: /^3 more archived threads/ });
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(nav.querySelector('[data-trail-thread="thr_wren"]')).toBeNull();
    group.focus();
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(
      within(trail(slot))
        .getByRole("button", { name: /^3 more archived threads/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    // Picking Wren keeps it in place once the group folds again, and it stays as recently viewed.
    fireEvent.click(row(slot, /^Wren/));
    const regroup = within(trail(slot)).getByRole("button", { name: /^2 more archived threads/ });
    regroup.focus();
    fireEvent.keyDown(regroup, { key: "ArrowLeft" });
    expect(regroup.getAttribute("aria-expanded")).toBe("false");
    expect(trail(slot).querySelector('[data-trail-thread="thr_wren"]')).not.toBeNull();
    fireEvent.click(row(slot, /^Side/));
    expect(trail(slot).querySelector('[data-trail-thread="thr_wren"]')).not.toBeNull();
    expect(trail(slot).querySelector('[data-trail-thread="thr_sam"]')).toBeNull();
  });

  it("lists a hidden thread that recorded edits, and counts only confirmed Flare companions in the footer", async () => {
    panelWidth(900);
    const { slot, view } = await mountPanel();
    const probe = row(slot, /^Probe/);
    expect(probe.querySelector('[aria-label="Hidden thread with recorded edits"]')).not.toBeNull();
    // Hidden, no edits, but not a Flare companion: a hidden status alone does not move it.
    expect(row(slot, /^Study worker/)).toBeTruthy();
    expect(trail(slot).querySelector('[data-trail-thread="thr_flares"]')).toBeNull();
    const footer = view.getByRole("button", { name: "1 Flare helper · no edits" });
    expect(footer.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(footer);
    expect(footer.getAttribute("aria-expanded")).toBe("true");
    const list = slot.container.querySelector<HTMLElement>("[data-flare-helpers] ul")!;
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Flares: Parent"]);
  });

  it("labels each source by who owns it, with the shared checkout as a sibling of recorded edits", async () => {
    panelWidth(900);
    const { slot } = await mountPanel();
    const describe = (element: HTMLElement) =>
      document.getElementById(element.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
    const sourcesOf = (id: string) => [
      ...trail(slot).querySelectorAll<HTMLElement>(`[data-trail-thread="${id}"] [data-trail-source]`),
    ];
    fireEvent.click(row(slot, /^Worker/));
    const worker = sourcesOf("thr_worker");
    expect(worker.map((source) => source.dataset.trailSource)).toEqual(["recorded", "checkout"]);
    expect(worker[0]!.getAttribute("aria-label")).toBe("Recorded edits");
    expect(describe(worker[0]!)).toMatch(/only Worker · 1 file/);
    expect(describe(worker[1]!)).toMatch(/its own checkout · 2 files/);
    expect(worker.filter((source) => source.getAttribute("aria-current") === "true")).toHaveLength(1);
    fireEvent.click(row(slot, /^Side/));
    const shared = sourcesOf("thr_side").find((source) => source.dataset.trailCheckout === SHARED.key)!;
    expect(describe(shared)).toMatch(/shared · 3 threads/);
    // Only the selected thread unfolds into its sources.
    expect(sourcesOf("thr_worker")).toEqual([]);
  });
});

describe("Incomplete recorded edits", () => {
  it("replaces the strip with a labelled disclosure that holds the reason, Refresh and the affected threads", async () => {
    panelWidth(900);
    const refresh = vi.fn();
    const { slot, view } = await mountPanel(HEAVY, refresh);
    expect(view.queryByText(incompleteWarning(2, "tree"))).toBeNull();
    const toggle = view.getByRole("button", { name: "Recorded edits may be incomplete · 2" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const region = view.getByRole("region", { name: "Incomplete recorded edits" });
    expect(region.textContent).toMatch(/A count of 0 is not proof that nothing changed/);
    const threads = within(region)
      .getAllByRole("button")
      .filter((button) => button.dataset.incompleteThread !== undefined)
      .map((button) => button.dataset.incompleteThread);
    expect(threads).toEqual(["thr_wren", "thr_ravi"]);
    refresh.mockClear();
    fireEvent.click(within(region).getByRole("button", { name: "Refresh records" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ refresh: true })));
    // Picking a listed thread selects it; its chip opens the same disclosure.
    fireEvent.click(within(region).getByRole("button", { name: /^Ravi/ }));
    expect(threadRow(slot, "thr_ravi").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    const chip = await view.findByRole("button", { name: "Recorded edits may be incomplete" });
    fireEvent.click(chip);
    expect(
      view.getByRole("button", { name: "Recorded edits may be incomplete · 2" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Recorded edits may be incomplete · 2" }));
    // Ravi recorded nothing: the reader says that is not proof.
    expect(
      await view.findByText(/not proof that nothing changed/, { selector: "[data-recorded-review] *" }),
    ).toBeTruthy();
    expect(threadRow(slot, "thr_ravi").getAttribute("aria-describedby")).toBeTruthy();
  });
});

describe("Keyboard", () => {
  it("makes the trail one Tab stop that arrows move through, into the file tree and back", async () => {
    panelWidth(900);
    const { slot } = await mountPanel();
    fireEvent.click(row(slot, /^Worker/));
    const navigator = slot.container.querySelector<HTMLElement>("[data-navigator-tree]")!;
    await waitFor(() => expect(navigator.querySelector("[data-file-nav]")).not.toBeNull());
    expect(tabStops(navigator)).toBe(1);
    const start = navigator.querySelector<HTMLElement>('[tabindex="0"]')!;
    start.focus();
    fireEvent.keyDown(start, { key: "ArrowDown" });
    expect(document.activeElement).not.toBe(start);
    expect(navigator.contains(document.activeElement)).toBe(true);
    const file = navigator.querySelector<HTMLElement>('[data-tree-file="src/a.ts"] [data-file-nav]')!;
    act(() => file.focus());
    expect(tabStops(navigator)).toBe(1);
    expect(file.tabIndex).toBe(0);
    // Left from a file goes to its folder, and from a top folder to the source that holds it.
    fireEvent.keyDown(file, { key: "ArrowLeft" });
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("src folder");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect((document.activeElement as HTMLElement).dataset.trailSource).toBe("checkout");
  });

  it("opens a modal sheet below the cut-over: inert background, focus inside, Esc back to the breadcrumb", async () => {
    panelWidth(420);
    const { slot, view } = await mountPanelNarrow();
    const crumb = view.getByRole("button", { name: /^Trail: / });
    crumb.focus();
    fireEvent.click(crumb);
    const dialog = sheet(slot);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(slot.container.querySelector("[data-panel-background]")!.hasAttribute("inert")).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).getAttribute("aria-pressed")).toBe("true");
    // Arrow keys move through the tree inside the sheet.
    const selectedRow = document.activeElement;
    fireEvent.keyDown(selectedRow!, { key: "ArrowDown" });
    expect(document.activeElement).not.toBe(selectedRow);
    expect(dialog.contains(document.activeElement)).toBe(true);
    // The incomplete-records disclosure is in the sheet; it opens in place and Refresh is the next Tab stop.
    const disclosure = within(dialog).getByRole("button", { name: "Recorded edits may be incomplete · 2" });
    fireEvent.click(disclosure);
    expect(sheet(slot)).toBe(dialog);
    const order = tabbables(dialog);
    expect(order[order.indexOf(disclosure) + 1]).toBe(within(dialog).getByRole("button", { name: "Refresh records" }));
    fireEvent.click(disclosure);
    // Tab cycles inside the sheet.
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"])')];
    focusable.at(-1)!.focus();
    fireEvent.keyDown(focusable.at(-1)!, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);
    // Picking a thread keeps the sheet open, and focus stays on it; the disclosure is inside the sheet.
    const worker = within(dialog).getByRole("button", { name: /^Worker/ });
    worker.focus();
    fireEvent.click(worker);
    expect(sheet(slot)).toBe(dialog);
    expect(document.activeElement).toBe(worker);
    expect(worker.getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).getByRole("button", { name: "Recorded edits may be incomplete · 2" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(slot.container.querySelector("[data-trail-sheet]")).toBeNull();
    expect(slot.container.querySelector("[data-panel-background]")!.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(view.getByRole("button", { name: /^Trail: .*Reading Worker/ }));
    // Picking a file closes the sheet on that file.
    openSheet(slot);
    const file = await waitFor(() =>
      sheet(slot).querySelector<HTMLElement>('[data-tree-file="src/a.ts"] [data-file-nav]')!,
    );
    fireEvent.click(file);
    expect(slot.container.querySelector("[data-trail-sheet]")).toBeNull();
    expect(slot.container.querySelector('[data-file-card="src/a.ts"][data-reading-selected]')).not.toBeNull();
  });

  it("hides the whole navigator but keeps the source, Refresh and full screen visible", async () => {
    panelWidth(900);
    const { slot, view } = await mountPanel();
    fireEvent.click(row(slot, /^Worker/));
    fireEvent.click(await view.findByRole("button", { name: "Hide the trail and file tree" }));
    expect(view.queryByRole("navigation", { name: "Thread trail" })).toBeNull();
    const line = slot.container.querySelector<HTMLElement>("[data-thread-line]")!;
    for (const name of ["All changes", "Refresh", "Open full screen"])
      expect(within(line).getByRole("button", { name })).toBeTruthy();
    const sources = within(slot.container.querySelector<HTMLElement>("[data-thread-chips]")!).getByRole("group", {
      name: "Evidence source",
    });
    expect(sources.textContent).toMatch(/Recorded edits · only Worker/);
    expect(sources.textContent).toMatch(/Checkout Git · its own checkout/);
    fireEvent.click(view.getByRole("button", { name: "Show the trail and file tree" }));
    expect(trail(slot)).toBeTruthy();
  });
});

describe("Review in the panel", () => {
  const draft = (key: string) =>
    comments.add(key, { path: "src/a.ts", part: "uncommitted", quote: "", text: "Name it" });

  it("names the recipient on Send in two columns and in the narrow sheet layout, with Preview in the narrow menu", async () => {
    draft(reviewDraftKey(WORKER.key, "thr_worker"));
    panelWidth(900);
    const wide = await mountPanel();
    fireEvent.click(row(wide.slot, /^Worker/));
    expect(await wide.view.findByRole("button", { name: "Queue for Worker" })).toBeTruthy();
    expect(wide.view.getByText("1 comment for Worker")).toBeTruthy();
    wide.slot.lifecycle.unmount();
    mounts.splice(0);
    disposeSessions();

    panelWidth(420);
    const narrow = await mountPanelNarrow();
    openSheet(narrow.slot);
    fireEvent.click(within(sheet(narrow.slot)).getByRole("button", { name: /^Worker/ }));
    fireEvent.keyDown(sheet(narrow.slot), { key: "Escape" });
    expect(await narrow.view.findByRole("button", { name: "Queue for Worker" })).toBeTruthy();
    fireEvent.click(narrow.view.getByRole("button", { name: "More ways to send" }));
    const menu = narrow.view.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Preview/ })).toBeTruthy();
  });

  it("keeps unsent comments across Chat and Changes and across threads", async () => {
    draft(reviewDraftKey(WORKER.key, "thr_worker"));
    panelWidth(900);
    const { slot, view } = await mountPanel();
    fireEvent.click(row(slot, /^Worker/));
    expect(await view.findByText("1 comment for Worker")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Chat" }));
    expect(view.queryByText("1 comment for Worker")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Changes" }));
    expect(await view.findByText("1 comment for Worker")).toBeTruthy();
    fireEvent.click(row(slot, /^Side/));
    fireEvent.click(row(slot, /^Worker/));
    expect(await view.findByText("1 comment for Worker")).toBeTruthy();
  });

  it("refuses to send to an archived thread, says why, and offers Copy as Markdown", async () => {
    comments.add(reviewDraftKey(KEPT.key, "thr_wren"), {
      path: "README.md",
      part: "committed",
      quote: "",
      text: "Fix",
    });
    panelWidth(900);
    const { slot, view } = await mountPanel(
      overview({
        ...HEAVY,
        worktrees: [
          ...HEAVY.worktrees.filter((entry) => entry !== KEPT),
          { ...KEPT, committed: [fileChange({ path: "README.md" })] },
        ],
      }),
    );
    fireEvent.click(within(trail(slot)).getByRole("button", { name: /^3 more archived threads/ }));
    fireEvent.click(row(slot, /^Wren/));
    fireEvent.click(await view.findByRole("button", { name: "Kept branch" }));
    expect(await view.findByText("Archived threads can't receive comments")).toBeTruthy();
    expect(view.getByRole("button", { name: "Copy as Markdown" })).toBeTruthy();
    expect(view.queryByRole("button", { name: /^Send to/ })).toBeNull();
    expect(view.getByText("Kept branch · committed only")).toBeTruthy();
  });

  it("Excluded checkouts read recorded edits only: a Git-not-read chip with its reason, no Terminal and no Retry", async () => {
    panelWidth(900);
    const excluded = overview({
      ...HEAVY,
      worktrees: [
        SHARED,
        {
          ...WORKER,
          state: "unavailable",
          message: "Vantage does not run Git here: this checkout is excluded in Vantage's settings",
          uncommitted: [],
        },
      ],
      sharedFiles: [],
    });
    const { slot, view } = await mountPanel(excluded);
    fireEvent.click(row(slot, /^Worker/));
    fireEvent.click(await view.findByRole("button", { name: "Recorded edits" }));
    const chip = await view.findByRole("button", { name: "Checkout Git not read" });
    fireEvent.click(chip);
    expect(view.getByRole("dialog", { name: "Checkout Git not read" }).textContent).toMatch(
      /this checkout is excluded/,
    );
    expect(view.queryByRole("button", { name: "Terminal" })).toBeNull();
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

async function mountPanelNarrow() {
  const app = await loadPluginApp(() => import("../app"));
  const tab = app.tabs.find((entry) => entry.context.kind === "thread")!;
  const slot = renderSlot<{ threadId: string; params: null }, typeof rpcContract>(
    tab as never,
    { threadId: "thr_root", params: null },
    {
      pluginId: "vantage",
      rpc: {
        shell: () => new Promise<Overview>(() => {}),
        overview: () => HEAVY,
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
  const view = within(slot.container);
  await view.findByRole("button", { name: /^Trail: / });
  await waitFor(() => expect(slot.container.querySelector("[data-review]")).not.toBeNull());
  return { slot, view };
}
const sheet = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-trail-sheet]")!;
function openSheet(slot: Slot) {
  fireEvent.click(within(slot.container).getByRole("button", { name: /^Trail: / }));
}
