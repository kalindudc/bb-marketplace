import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ThreadRow, type ThreadRowProps, toActionTarget } from "../src/thread-row";
import { DEFAULT_SETTINGS } from "../src/settings";
import { sidebarThread } from "./fixtures";

const thread = sidebarThread({ id: "t", displayTitle: "A thread", href: "/projects/p/threads/t" });
const row = { thread, state: "idle" as const, depth: 0, guides: "", isLast: true,
  childCount: 1, collapsed: false, rollup: null, rollupCount: 0, crossProject: null, dim: false };
function mount(overrides: Partial<ThreadRowProps> = {}, options: Record<string, unknown> = {}) {
  const onNavigate = vi.fn();
  const onToggle = vi.fn();
  const props: ThreadRowProps = { row, isActive: false, settings: DEFAULT_SETTINGS,
    now: 180_000, projectName: "Marketplace", onNavigate, onToggle,
    drag: { onRowPointerDown: vi.fn(), consumeClick: vi.fn(() => false) },
    isSelected: false, isDragging: false, dropState: null, flash: false,
    onSelect: vi.fn(), onKeyboardMove: vi.fn(), ...overrides };
  const slot = renderSlot({ component: ThreadRow }, props, {
    sidebarThreads: { threads: [thread] }, ...options,
  });
  return { slot, onNavigate, onToggle };
}

describe("thread row", () => {
  it("preserves navigation and shortcut hooks and bb's thread menu", () => {
    const { slot, onNavigate, onToggle } = mount({}, {
      sidebarShortcuts: { t: { label: "⌘1", ariaKeyshortcuts: "Meta+1" } },
      threadActions: () => [{ key: "bb--core/archive", pluginId: "bb--core", group: "thread", action: {
        label: "Archive", icon: "Archive", run: async () => {},
      } }],
    });
    const anchor = screen.getByRole("link", { name: "A thread" });
    expect(anchor.getAttribute("href")).toBe(thread.href);
    expect(anchor.getAttribute("data-sidebar-thread-shortcut-target")).toBe("");
    expect(anchor.getAttribute("data-sidebar-thread-id")).toBe("t");
    expect(anchor.getAttribute("aria-keyshortcuts")).toBe("Meta+1");
    expect(screen.getByText("⌘1")).toBeTruthy();
    anchor.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(anchor);
    expect(onNavigate).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /collapse a thread/i }));
    expect(onToggle).toHaveBeenCalledWith("thread:t");
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeTruthy();
    slot.unmount();
  });

  it("keeps the menu trigger laid out while its menu is open so the menu stays anchored", () => {
    const { slot } = mount({}, { threadActions: () => [{ key: "bb--core/archive", pluginId: "bb--core", group: "thread",
      action: { label: "Archive", icon: "Archive", run: async () => {} } }] });
    const element = slot.container.querySelector<HTMLElement>("[data-sb-row]")!;
    expect(element.hasAttribute("data-menu-open")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    expect(element.hasAttribute("data-menu-open")).toBe(true);
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(element.hasAttribute("data-menu-open")).toBe(false);
    const css = readFileSync(join(process.cwd(), "src/switchboard.css"), "utf8");
    const hover = css.slice(css.indexOf("@media (hover: hover)"));
    expect(hover).toMatch(/\.sb-row\[data-menu-open\] \.sb-menu-trigger[^{]*\{ display: grid; \}/);
    slot.unmount();
  });

  const pinAndArchive = (target: { archivedAt: number | null }) => [
    { key: "bb--core/pin", pluginId: "bb--core", group: "state", action: { label: "Pin", icon: "Pin", run: async () => {} } },
    { key: "bb--core/archive", pluginId: "bb--core", group: "lifecycle", action: {
      label: target.archivedAt === null ? "Archive" : "Unarchive", icon: "Archive", run: async () => {} } },
  ];

  it("names its buttons for screen readers without browser tooltips", () => {
    const { slot } = mount({ onSnooze: vi.fn() }, { threadActions: pinAndArchive });
    for (const name of ["Archive", "Thread actions"]) {
      expect(screen.getByRole("button", { name }).hasAttribute("title")).toBe(false);
    }
    slot.unmount();
  });

  it("keeps Pin and Snooze in the thread menus instead of on the row", () => {
    const onSnooze = vi.fn();
    const { slot } = mount({ onSnooze }, { threadActions: pinAndArchive });
    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();
    expect(screen.queryByRole("button", { name: /snooze/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    expect(screen.getByRole("menuitem", { name: "Pin" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Snooze until tomorrow 09:00" }));
    expect(onSnooze).toHaveBeenCalledOnce();
    fireEvent.contextMenu(screen.getByRole("link", { name: "A thread" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Snooze until tomorrow 09:00" }));
    expect(onSnooze).toHaveBeenCalledTimes(2);
    slot.unmount();
  });

  it("leaves Snooze out of the menu when the family cannot snooze", () => {
    const { slot } = mount({}, { threadActions: pinAndArchive });
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    expect(screen.getByRole("menuitem", { name: "Pin" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /snooze/i })).toBeNull();
    slot.unmount();
  });

  it("gives a status lane row the thread menu with Snooze", () => {
    const onSnooze = vi.fn();
    const { slot } = mount({ variant: "lane", onSnooze }, { threadActions: pinAndArchive });
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Snooze until tomorrow 09:00" }));
    expect(onSnooze).toHaveBeenCalledOnce();
    slot.unmount();
  });

  it("centres the leading status glyph in its box instead of on the text baseline", () => {
    for (const state of ["running", "failed", "idle"] as const) {
      const { slot } = mount({ row: { ...row, state } });
      const glyph = slot.container.querySelector<HTMLElement>(".sb-leading-glyph")!;
      expect(glyph.className).toMatch(/(^| )grid( |$)/);
      expect(glyph.className).toContain("place-items-center");
      slot.unmount();
    }
  });

  it("offers only Unarchive and bb's menu on an archived row, without jump shortcuts", () => {
    const archived = { ...thread, isArchived: true, archivedAt: 120_000, isUnread: true };
    const { slot } = mount({ variant: "archived", row: { ...row, thread: archived, state: "unread", childCount: 0 } },
      { sidebarThreads: { threads: [archived] }, threadActions: pinAndArchive });
    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();
    expect(screen.getByRole("button", { name: "Unarchive" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Thread actions" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Archived" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "A thread" }).hasAttribute("data-sidebar-thread-id")).toBe(false);
    const title = slot.container.querySelector(".min-w-24")!;
    expect(title.className).not.toContain("font-semibold");
    expect(title.className).toContain("text-muted-foreground");
    slot.unmount();
  });

  it("uses bb's glyph for a draft or another plugin's row status", () => {
    const { slot } = mount({}, { sidebarDraftThreadIds: ["t"] });
    expect(slot.container.querySelector('[data-thread-status-glyph="draft"]')).toBeTruthy();
    slot.unmount();
    const second = mount({}, { sidebarRowStatuses: { t: { icon: "Check", label: "Checked", tone: "success" } } });
    expect(second.slot.container.querySelector('[data-thread-status-glyph]')).toBeTruthy();
    second.slot.unmount();
  });

  it("composes drag after bb's anchor, selects with Alt and Shift, and intercepts Alt+arrows", () => {
    const drag = { onRowPointerDown: vi.fn(), consumeClick: vi.fn(() => false) };
    const onSelect = vi.fn(), onKeyboardMove = vi.fn();
    const { slot, onNavigate } = mount({ drag, onSelect, onKeyboardMove, isSelected: true, isDragging: true,
      dropState: "child", flash: true, selectedRun: "middle" });
    const anchor = screen.getByRole("link", { name: "A thread" });
    const element = slot.container.querySelector<HTMLElement>("[data-sb-row]")!;
    expect(element.dataset).toMatchObject({ threadId: "t", depth: "0", lastChild: "true",
      openChildren: "true", selected: "true", dragging: "true", drop: "child", run: "middle" });
    expect(element.className).toContain("sb-flash");
    expect(element.className).not.toContain("hover:bg-sidebar-accent");
    expect(element.className).not.toContain("bg-state-active");
    fireEvent.pointerDown(anchor, { pointerType: "mouse", button: 0 });
    expect(drag.onRowPointerDown).toHaveBeenCalledWith(expect.anything(), "t");
    fireEvent.click(anchor, { altKey: true });
    fireEvent.click(anchor, { shiftKey: true });
    expect(onSelect.mock.calls).toEqual([["t", "toggle"], ["t", "range"]]);
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.keyDown(anchor, { key: "ArrowRight", altKey: true });
    expect(onKeyboardMove).toHaveBeenCalledWith("t", "right");
    slot.unmount();
  });

  it("places nested content, caret and guides from shared spacing variables", () => {
    const nested = { ...row, depth: 2, guides: "||", isLast: false };
    const { slot } = mount({ row: nested });
    const element = slot.container.querySelector<HTMLElement>("[data-sb-row]")!;
    expect(element.getAttribute("style")).toContain("var(--sb-base)");
    expect(element.getAttribute("style")).toContain("var(--sb-indent)");
    const caret = slot.container.querySelector<HTMLElement>(".sb-caret")!;
    expect(caret.getAttribute("style")).toContain("var(--sb-indent)");
    expect(slot.container.querySelector(".sb-elbow")).toBeNull();
    expect(slot.container.querySelector(".sb-guide-nested-top")).toBeTruthy();
    expect(slot.container.querySelector(".sb-guide-nested-bottom")).toBeTruthy();
    expect(slot.container.querySelector(".sb-guide-nested-top")?.getAttribute("style")).toContain("var(--sb-base)");
    slot.unmount();
  });

  it("keeps at least six rems for titles before truncating tags", () => {
    const { slot } = mount({ row: { ...row, crossProject: "Other project" }, settings: {
      ...DEFAULT_SETTINGS, showBranch: true, showPullRequests: true,
    } });
    expect(slot.container.querySelector(".sb-row-line .min-w-24")).toBeTruthy();
    expect(slot.container.querySelector(".sb-meta[title='Other project']")?.className).toContain("shrink");
    slot.unmount();
  });

  it("limits shortcut attributes and interactions to canonical rows and wakes the shelf row", () => {
    const onWake = vi.fn(), onSelect = vi.fn();
    const lane = mount({ variant: "lane", parentTitle: "Parent", settings: { ...DEFAULT_SETTINGS, density: "two-line" }, onSelect });
    expect(lane.slot.container.querySelector("[data-sidebar-thread-id='t']")).toBeTruthy();
    expect(screen.getByText("Parent")).toBeTruthy();
    lane.slot.unmount();
    const mirror = mount({ variant: "mirror", onSelect });
    expect(mirror.slot.container.querySelector("[data-sidebar-thread-id]")).toBeNull();
    expect(mirror.slot.container.querySelector("[data-sidebar-thread-shortcut-target]")).toBeNull();
    mirror.slot.unmount();
    const shelf = mount({ variant: "snoozed", wakeLabel: "tomorrow 09:00", onWake });
    expect(shelf.slot.container.querySelector("[data-sidebar-thread-id]")).toBeNull();
    expect(screen.getByText("tomorrow 09:00")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Wake" }));
    expect(onWake).toHaveBeenCalledOnce();
    shelf.slot.unmount();
  });

  it("passes a reusable environment to bb's menu", () => {
    const target = toActionTarget(sidebarThread({ environment: {
      id: "env", path: "/work", name: "work", branchName: "main", isWorktree: false, providerId: null, workspaceDisplayKind: null,
    } }));
    expect(target.environment).toEqual({ id: "env", path: "/work" });
  });
});
