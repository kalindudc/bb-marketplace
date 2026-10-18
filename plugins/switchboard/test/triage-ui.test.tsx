import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { createCommands } from "../src/commands";
import { EMPTY_LAYOUT, isCollapseKey, type Layout } from "../src/layout";
import { nextWake } from "../src/triage";
import type { RpcContract } from "../src/rpc";
import { sidebarProject, sidebarSection, sidebarThread, layoutWriteFakes } from "./fixtures";

const { notify, error } = vi.hoisted(() => ({ notify: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(notify, { error }) }));
const NOW = new Date(2025, 1, 10, 12).getTime();
const DAY = 86_400_000;
const section = sidebarSection("test", "Test section");
const threads = [
  sidebarThread({ id: "old", displayTitle: "Old quiet", sectionId: "test", updatedAt: NOW - 5 * DAY, latestAttentionAt: NOW - 5 * DAY }),
  sidebarThread({ id: "child", displayTitle: "Finished child", parentThreadId: "old", isUnread: true, updatedAt: NOW - 4 * DAY, latestAttentionAt: NOW - 4 * DAY }),
  sidebarThread({ id: "fresh", displayTitle: "Fresh quiet", sectionId: "test", updatedAt: NOW - DAY, latestAttentionAt: NOW - DAY }),
  sidebarThread({ id: "need", displayTitle: "Needs help", hasPendingInteraction: true, updatedAt: NOW - 1000, latestAttentionAt: NOW - 1000 }),
  sidebarThread({ id: "fail", displayTitle: "Failed job", status: "error", updatedAt: NOW - 500, latestAttentionAt: NOW - 500 }),
].map((thread) => ({ ...thread, href: `/projects/p/threads/${thread.id}` }));
const props: PluginThreadListProps = { activeThreadId: "fail", activeProjectId: "p",
  isCompactViewport: false, onNavigate: vi.fn(), searchQuery: "" };

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); localStorage.clear(); });

async function mount(initialSettings: Record<string, unknown> = {}, activeThreadId = "fail",
  listThreads = threads) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  let values = { ...initialSettings };
  let layout: Layout = EMPTY_LAYOUT;
  const updateSettings = vi.fn(async ({ values: change }: { values: Record<string, unknown> }) => { values = { ...values, ...change }; });
  const archive = vi.fn(async (_: { threadId: string }) => ({})),
    unarchive = vi.fn(async (_: { threadId: string }) => ({}));
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot<PluginThreadListProps, RpcContract>(app.threadLists[0]!, { ...props, activeThreadId }, {
    pluginId: "switchboard", sidebarThreads: { threads: listThreads, sections: [section], projects: [sidebarProject("p", "Project")] },
    sdk: { plugins: { getSettings: async () => ({ ok: true, schema: {}, values }), updateSettings },
      threads: { archive, unarchive, update: async () => ({}), pin: async () => ({}), unpin: async () => ({}),
        reorderPinned: async () => ({}), markRead: async () => ({}) },
      threadSections: { create: async () => ({ ...section, id: "new" }), update: async () => ({}), delete: async () => ({}) },
    } as never,
    rpc: { ...layoutWriteFakes, getLayout: () => ({ ...layout, sectionOrder: [...layout.sectionOrder],
      collapsed: layout.collapsed.filter(isCollapseKey),
      order: Object.fromEntries(Object.entries(layout.order).map(([key, ids]) => [key, [...ids]])),
      sectionHues: { ...layout.sectionHues },
      sectionSort: { ...layout.sectionSort }, snoozes: { ...layout.snoozes } }),
      setCollapsed: ({ key, collapsed }) => ({ collapsed: collapsed ? [key].filter(isCollapseKey) : [] }),
      setSectionSort: ({ container, mode }) => {
        const sectionSort = { ...layout.sectionSort };
        if (mode === "manual") delete sectionSort[container]; else sectionSort[container] = mode;
        layout = { ...layout, sectionSort }; return { sectionSort };
      },
      snooze: ({ threadIds, until }) => {
        const snoozes = { ...layout.snoozes };
        for (const id of threadIds) snoozes[id] = { at: NOW, until };
        layout = { ...layout, snoozes }; return { snoozes };
      },
      unsnooze: ({ threadIds }) => {
        const snoozes = { ...layout.snoozes };
        for (const id of threadIds) delete snoozes[id];
        layout = { ...layout, snoozes }; return { snoozes };
      },
    },
  });
  await waitFor(() => expect(slot.rpcCalls.some((call) => call.method === "getLayout")).toBe(true));
  return { slot, updateSettings, archive, unarchive, setSettings: (next: Record<string, unknown>) => { values = { ...values, ...next }; } };
}

function sectionMenu() {
  fireEvent.pointerDown(document.querySelector("[data-sb-section='test'] .sb-section-menu-trigger")!,
    { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("triage UI", () => {
  it("switches by button, settings signal and command, keeping a child in its own lane with a parent title", async () => {
    const { slot, updateSettings, setSettings } = await mount({ density: "two-line" });
    fireEvent.click(screen.getByRole("button", { name: "Status lanes view" }));
    expect(updateSettings).toHaveBeenCalledWith({ pluginId: "switchboard", values: { view: "status" } });
    setSettings({ view: "status" });
    await slot.behavior.emitRealtime("settings", {});
    await waitFor(() => expect([...slot.container.querySelectorAll(".sb-lane .sb-header-name")]
      .some((header) => header.textContent === "Finished, unread")).toBe(true));
    const lane = screen.getByRole("link", { name: "Finished child" });
    expect(lane.getAttribute("data-sidebar-thread-id")).toBe("child");
    expect(within(lane.closest("[data-sb-row]")!).getByText("Old quiet")).toBeTruthy();
    const command = createCommands().find((item) => item.id === "toggle-view")!;
    void command.run({} as never);
    expect(updateSettings).toHaveBeenLastCalledWith({ pluginId: "switchboard", values: { view: "sections" } });
    slot.unmount();
  });

  it("sorts a test section and refuses root reordering inside it", async () => {
    const { slot } = await mount();
    sectionMenu();
    fireEvent.pointerMove(screen.getByRole("menuitem", { name: "Sort" }));
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Sort" }), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Recent activity" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual(expect.objectContaining({
      method: "setSectionSort", input: { container: "section:test", mode: "recent" },
    })));
    const rows = [...slot.container.querySelectorAll("[data-sb-section='test'] ~ .sb-group-body [data-sidebar-thread-id]")];
    expect(rows.map((row) => row.getAttribute("data-sidebar-thread-id")).slice(0, 2)).toEqual(["fresh", "old"]);
    fireEvent.keyDown(screen.getByRole("link", { name: "Old quiet" }), { key: "ArrowUp", altKey: true });
    expect(screen.getByText("Sorted by recent activity")).toBeTruthy();
    slot.unmount();
  });

  it("fades stale roots, archives only those in the test section, and Undo unarchives the family", async () => {
    const { slot, archive, unarchive } = await mount();
    expect(slot.container.querySelector("[data-sb-row][data-thread-id='old']")?.className).toContain("sb-stale");
    expect(slot.container.querySelector("[data-sb-row][data-thread-id='fresh']")?.className).not.toContain("sb-stale");
    sectionMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Archive stale threads/ }));
    expect(screen.getByText(/Archive 1 thread idle for more than 3 days/)).toBeTruthy();
    expect(screen.getByText(/Their 1 child thread is archived too/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archive stale threads" }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith({ threadId: "old" }));
    expect(archive).toHaveBeenCalledTimes(1);
    expect(notify.mock.lastCall![1].action.label).toBe("Undo");
    notify.mock.lastCall![1].action.onClick();
    await waitFor(() => expect(unarchive).toHaveBeenCalledTimes(2));
    expect(unarchive.mock.calls.map(([arg]) => arg.threadId)).toEqual(["old", "child"]);
    slot.unmount();
  });

  it("snoozes a quiet family, shows a collapsed shortcut-free shelf, and wakes it", async () => {
    const { slot } = await mount();
    const row = within(slot.container.querySelector<HTMLElement>("[data-sb-row][data-thread-id='old']")!);
    fireEvent.click(row.getByRole("button", { name: "Thread actions" }));
    fireEvent.click(row.getByRole("menuitem", { name: /Snooze until tomorrow/i }));
    const until = nextWake(NOW, 9);
    await waitFor(() => expect(slot.rpcCalls).toContainEqual(expect.objectContaining({
      method: "snooze", input: { threadIds: ["old"], until },
    })));
    expect(screen.queryByRole("link", { name: "Old quiet" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Snoozed.*1/i }));
    const shelf = screen.getByRole("link", { name: "Old quiet" });
    expect(shelf.getAttribute("data-sidebar-thread-id")).toBeNull();
    expect(shelf.getAttribute("data-sidebar-thread-shortcut-target")).toBeNull();
    expect(screen.getByText("tomorrow 09:00")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Wake" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual(expect.objectContaining({
      method: "unsnooze", input: { threadIds: ["old"] },
    })));
    slot.unmount();
  });

  it("keeps a family awake while a child runs, and disables fading when staleDays is zero", async () => {
    const busy = threads.map((thread) => thread.id === "child" ? { ...thread, status: "active" as const } : thread);
    const { slot } = await mount({ staleDays: 0 }, "fail", busy);
    await slot.behavior.emitRealtime("layout", { key: "snoozes", value: {
      old: { at: NOW, until: nextWake(NOW, 9) },
    } });
    expect(screen.getByRole("link", { name: "Old quiet" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Snoozed/i })).toBeNull();
    expect(slot.container.querySelector("[data-sb-row][data-thread-id='old']")?.className).not.toContain("sb-stale");
    sectionMenu();
    expect(screen.getByRole("menuitem", { name: /Archive stale threads/ }).hasAttribute("data-disabled")).toBe(true);
    slot.unmount();
  });

  it("mirrors urgent threads without shortcut attributes and navigates to the next one with wrap", async () => {
    const { slot } = await mount({ needsYouShelf: true }, "need");
    await waitFor(() => expect(screen.getAllByRole("link", { name: "Needs help" })).toHaveLength(2));
    const links = screen.getAllByRole("link", { name: "Needs help" });
    expect(links.map((link) => link.getAttribute("data-sidebar-thread-id"))).toEqual([null, "need"]);
    const next = createCommands().find((item) => item.id === "next-needs-you")!;
    void next.run({} as never);
    expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "toThread", threadId: "fail" }));
    slot.unmount();
  });

  it("gives chips, view controls, headers, row actions, shelves and bulk buttons pointer affordances", async () => {
    const { slot, setSettings } = await mount({ needsYouShelf: true });
    const assertControls = () => {
      const nav = slot.container.querySelector<HTMLElement>("nav.sb-list")!;
      const buttons = [...nav.querySelectorAll<HTMLButtonElement>("button")];
      expect(buttons.length).toBeGreaterThan(8);
      expect(buttons.filter((button) => !button.classList.contains("sb-control") &&
        !button.classList.contains("sb-header-main") && !button.classList.contains("sb-caret"))
        .map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim())).toEqual([]);
      expect([...nav.querySelectorAll<HTMLAnchorElement>(".sb-row > a")].every((link) =>
        link.classList.contains("sb-row-link"))).toBe(true);
    };
    assertControls();
    expect(screen.getByRole("button", { name: "View options" }).classList.contains("sb-control")).toBe(true);
    expect(screen.getByRole("button", { name: "Failed: 1" }).classList.contains("sb-control")).toBe(true);
    expect(screen.getByRole("button", { name: "Collapse Old quiet" }).classList.contains("sb-caret")).toBe(true);
    fireEvent.click(screen.getByRole("link", { name: "Fresh quiet" }), { altKey: true });
    expect(screen.getByRole("button", { name: "Clear selection" })).toBeTruthy();
    assertControls();
    setSettings({ view: "status" });
    await slot.behavior.emitRealtime("settings", {});
    await waitFor(() => expect(slot.container.querySelector(".sb-lane")).toBeTruthy());
    assertControls();
    slot.unmount();
  });

  it("focuses the filter through its command and creates a section through the shared action", async () => {
    const { slot } = await mount();
    const commands = createCommands();
    expect(commands.every((command) => command.isAvailable?.({} as never))).toBe(true);
    void commands.find((command) => command.id === "focus-filter")!.run({} as never);
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Filter threads" }));
    void commands.find((command) => command.id === "new-section")!.run({} as never);
    await waitFor(() => expect(slot.inspection.sdkCalls).toContainEqual(expect.objectContaining({
      method: "threadSections.create",
    })));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter threads" }), { target: { value: "Fresh quiet" } });
    void commands.find((command) => command.id === "next-needs-you")!.run({} as never);
    expect(notify).toHaveBeenCalledWith("Nothing needs you right now");
    slot.unmount();
  });
});
