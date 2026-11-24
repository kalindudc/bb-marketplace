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

  it("keeps the split marker inside the row's navigation and selection surface", () => {
    const onSelect = vi.fn();
    const drag = { onRowPointerDown: vi.fn(), consumeClick: vi.fn(() => false) };
    const { slot, onNavigate } = mount({ splitLocation: "Left pane", onSelect, drag });
    const link = screen.getByRole("link", { name: "A thread, Left pane" });
    link.addEventListener("click", (event) => event.preventDefault());
    const marker = slot.container.querySelector<HTMLElement>(".switchboard-split-mark")!;
    const css = readFileSync(join(process.cwd(), "src/switchboard.css"), "utf8");
    expect(css).toMatch(/\.switchboard-split-mark\s*\{[^}]*pointer-events:\s*none/);
    expect(marker.getAttribute("aria-hidden")).toBe("true");
    const aux = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });
    link.dispatchEvent(aux);
    expect(aux.defaultPrevented).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.pointerDown(link, { pointerType: "mouse", button: 0 });
    expect(drag.onRowPointerDown).toHaveBeenCalledWith(expect.anything(), "t");
    fireEvent.click(link, { altKey: true });
    expect(onSelect).toHaveBeenCalledWith("t", "toggle");
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledOnce();
    slot.unmount();
  });

  it("keeps the menu trigger laid out while its menu is open so the menu stays anchored", () => {
    const { slot } = mount({}, { threadActions: () => [{ key: "bb--core/archive", pluginId: "bb--core", group: "thread",
      action: { label: "Archive", icon: "Archive", run: async () => {} } }] });
    const element = slot.container.querySelector<HTMLElement>("[data-switchboard-row]")!;
    expect(element.hasAttribute("data-menu-open")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    expect(element.hasAttribute("data-menu-open")).toBe(true);
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(element.hasAttribute("data-menu-open")).toBe(false);
    const css = readFileSync(join(process.cwd(), "src/switchboard.css"), "utf8");
    const hover = css.slice(css.indexOf("@media (hover: hover)"));
    expect(hover).toMatch(/\.switchboard-row\[data-menu-open\] \.switchboard-menu-trigger[^{]*\{ display: grid; \}/);
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
      const glyph = slot.container.querySelector<HTMLElement>(".switchboard-leading-glyph")!;
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
    const element = slot.container.querySelector<HTMLElement>("[data-switchboard-row]")!;
    expect(element.dataset).toMatchObject({ threadId: "t", depth: "0", lastChild: "true",
      openChildren: "true", selected: "true", dragging: "true", drop: "child", run: "middle" });
    expect(element.className).toContain("switchboard-flash");
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

  it("fades the flash in an overlay on the compositor, and leaves it out for reduced motion", () => {
    const css = readFileSync(join(process.cwd(), "src/switchboard.css"), "utf8");
    expect(css).toContain(".switchboard-row::before, .switchboard-group-header::before, .switchboard-flash::after {");
    expect(css).toContain(".switchboard-flash::after { background: color-mix(in oklch, var(--primary) 28%, transparent); opacity: 0; animation: switchboard-flash .9s ease-out; }");
    expect(css).toContain("@keyframes switchboard-flash { from { opacity: 1; } to { opacity: 0; } }");
    expect(css).not.toMatch(/\.switchboard-flash::before/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{[^}]*\}\s*\.switchboard-flash::after \{ animation: none; \}/);
  });

  it("places nested content, caret and guides from shared spacing variables", () => {
    const nested = { ...row, depth: 2, guides: "|", isLast: false };
    const { slot } = mount({ row: nested });
    const element = slot.container.querySelector<HTMLElement>("[data-switchboard-row]")!;
    expect(element.getAttribute("style")).toContain("var(--switchboard-base)");
    expect(element.getAttribute("style")).toContain("var(--switchboard-indent)");
    const caret = slot.container.querySelector<HTMLElement>(".switchboard-caret")!;
    expect(caret.getAttribute("style")).toContain("var(--switchboard-indent)");
    expect(slot.container.querySelector(".switchboard-elbow")).toBeNull();
    expect(slot.container.querySelector(".switchboard-guide-nested-top")).toBeTruthy();
    expect(slot.container.querySelector(".switchboard-guide-nested-bottom")).toBeTruthy();
    expect(slot.container.querySelector(".switchboard-guide-nested-top")?.getAttribute("style")).toContain("var(--switchboard-base)");
    slot.unmount();
  });

  it("draws a last child's own column as an elbow only, with full lines just for open ancestor columns", () => {
    const trunks = (guides: string) => {
      const { slot } = mount({ row: { ...row, depth: 2, guides, isLast: true, childCount: 0 } });
      const found = slot.container.querySelectorAll(".switchboard-guide.top-0.bottom-0").length;
      expect(slot.container.querySelector(".switchboard-elbow")).toBeTruthy();
      expect(slot.container.querySelector(".switchboard-guide-cont")).toBeNull();
      slot.unmount();
      return found;
    };
    expect(trunks(" ")).toBe(0);
    expect(trunks("|")).toBe(1);
  });

  it.each(["default", "compact", "two-line"] as const)("uses one guide element for a non-last %s leaf", (density) => {
    const leaf = { ...row, depth: 2, guides: "|", isLast: false, childCount: 0 };
    const { slot } = mount({ row: leaf, settings: { ...DEFAULT_SETTINGS, density } });
    try {
      const node = slot.container.querySelector("[data-switchboard-row]")!;
      expect(node.getAttribute("data-last-child")).toBe("false");
      expect(node.querySelectorAll(".switchboard-elbow")).toHaveLength(1);
      expect(node.querySelectorAll(".switchboard-guide")).toHaveLength(1);
      expect(node.querySelector(".switchboard-guide.top-0.bottom-0")).toBeTruthy();
    } finally { slot.unmount(); }
  });

  it("emits neither leaf nor ancestor guides when tree lines are off", () => {
    const { slot } = mount({ row: { ...row, depth: 2, guides: "|", isLast: false, childCount: 0 },
      settings: { ...DEFAULT_SETTINGS, treeGuides: false } });
    expect(slot.container.querySelector(".switchboard-elbow, .switchboard-guide")).toBeNull();
    slot.unmount();
  });

  it("keeps at least six rems for titles before truncating tags", () => {
    const { slot } = mount({ row: { ...row, crossProject: "Other project" }, settings: {
      ...DEFAULT_SETTINGS, showBranch: true, showPullRequests: true,
    } });
    expect(slot.container.querySelector(".switchboard-row-line .min-w-24")).toBeTruthy();
    expect(slot.container.querySelector(".switchboard-meta[title='Other project']")?.className).toContain("shrink");
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

  it("draws the agent provider icon before the title only when provider icons are on, and hands presses on it to the row", () => {
    const providers = { status: "ready", providers: [{ id: "pi", displayName: "Pi" }] };
    const off = mount({}, { providers });
    expect(off.slot.container.querySelector("[data-provider-id]")).toBeNull();
    off.slot.unmount();
    const drag = { onRowPointerDown: vi.fn(), consumeClick: vi.fn(() => false) };
    const onSelect = vi.fn();
    const on = mount({ drag, onSelect, settings: { ...DEFAULT_SETTINGS, showProviderIcons: true } }, { providers });
    const icon = on.slot.container.querySelector(".switchboard-row-line [data-provider-id='pi']");
    expect(icon?.getAttribute("data-provider-kind")).toBe("agent");
    const mark = screen.getByRole("img", { name: "Pi" });
    expect(icon?.closest(".switchboard-provider")).toBe(mark);
    expect(mark.nextElementSibling?.textContent).toBe("A thread");
    screen.getByRole("link", { name: "A thread" }).addEventListener("click", (event) => event.preventDefault());
    fireEvent.pointerDown(mark, { pointerType: "mouse", button: 0 });
    expect(drag.onRowPointerDown).toHaveBeenCalledWith(expect.anything(), "t");
    fireEvent.click(mark);
    expect(on.onNavigate).toHaveBeenCalledOnce();
    fireEvent.click(mark, { altKey: true });
    expect(onSelect).toHaveBeenCalledWith("t", "toggle");
    expect(on.onNavigate).toHaveBeenCalledOnce();
    on.slot.unmount();
    const twoLine = mount({ settings: { ...DEFAULT_SETTINGS, showProviderIcons: true, density: "two-line" } }, { providers });
    expect(twoLine.slot.container.querySelector(".switchboard-two-line-title [data-provider-id='pi']")).toBeTruthy();
    twoLine.slot.unmount();
  });

  it("falls back to the provider id when bb does not list the provider", () => {
    const { slot } = mount({ settings: { ...DEFAULT_SETTINGS, showProviderIcons: true } });
    expect(slot.container.querySelector("[data-provider-id='pi']")).toBeTruthy();
    expect(screen.getByRole("img", { name: "pi" })).toBeTruthy();
    slot.unmount();
  });

  it("passes a reusable environment to bb's menu", () => {
    const target = toActionTarget(sidebarThread({ environment: {
      id: "env", path: "/work", name: "work", branchName: "main", isWorktree: false, providerId: null, workspaceDisplayKind: null,
    } }));
    expect(target.environment).toEqual({ id: "env", path: "/work" });
  });

  it("draws bb's row metadata after a root thread's title and hands presses on it to the row", () => {
    const drag = { onRowPointerDown: vi.fn(), consumeClick: vi.fn(() => false) };
    const onSelect = vi.fn();
    const { slot, onNavigate } = mount({ drag, onSelect });
    const meta = slot.container.querySelector<HTMLElement>("[data-thread-row-metadata]")!;
    expect(meta.getAttribute("data-thread-row-metadata")).toBe("t");
    expect(meta.parentElement!.classList.contains("switchboard-row-meta")).toBe(true);
    expect(slot.container.querySelector(".switchboard-pr-badge")).toBeNull();
    const anchor = screen.getByRole("link", { name: "A thread" });
    anchor.addEventListener("click", (event) => event.preventDefault());
    fireEvent.pointerDown(meta, { pointerType: "mouse", button: 0 });
    expect(drag.onRowPointerDown).toHaveBeenCalledWith(expect.anything(), "t");
    fireEvent.click(meta);
    expect(onNavigate).toHaveBeenCalledOnce();
    fireEvent.click(meta, { shiftKey: true });
    expect(onSelect).toHaveBeenCalledWith("t", "range");
    expect(onNavigate).toHaveBeenCalledOnce();
    slot.unmount();
    const child = mount({ row: { ...row, thread: sidebarThread({ id: "c", parentThreadId: "t", displayTitle: "A thread" }) } });
    expect(child.slot.container.querySelector("[data-thread-row-metadata]")).toBeNull();
    child.slot.unmount();
    const off = mount({ settings: { ...DEFAULT_SETTINGS, showPullRequests: false } });
    expect(off.slot.container.querySelector("[data-thread-row-metadata]")).toBeNull();
    off.slot.unmount();
    const twoLine = mount({ settings: { ...DEFAULT_SETTINGS, density: "two-line" } });
    expect(twoLine.slot.container.querySelector(".switchboard-two-line-title [data-thread-row-metadata]")).not.toBeNull();
    twoLine.slot.unmount();
  });

  it("tells bb's menu whether a child notifies its parent", () => {
    expect(toActionTarget(sidebarThread({ parentThreadId: "p", parentNotifications: "stuck" })).parentNotifications).toBe("stuck");
  });
});
