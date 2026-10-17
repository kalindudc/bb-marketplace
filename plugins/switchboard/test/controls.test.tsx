import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { GroupHeader } from "../src/group-header";
import { FilterBar } from "../src/filter-bar";
import { EMPTY_COUNTS } from "../src/status";
import { EMPTY_LAYOUT } from "../src/layout";
import { buildGroups } from "../src/tree";
import { sidebarSection, sidebarThread } from "./fixtures";

afterEach(cleanup);
const group = buildGroups({ sections: [sidebarSection("s", "Review")], layout: EMPTY_LAYOUT, threads: [
  sidebarThread({ sectionId: "s", id: "t", status: "error" }),
] })[0];

describe("list controls", () => {
  it("shows the section marker, padded thread count and collapsed rollups", () => {
    const onToggle = vi.fn();
    const slot = renderSlot({ component: GroupHeader }, { group, collapsed: true, sectionColour: "tint" as const, onToggle,
      drag: { onSectionPointerDown: vi.fn(), consumeClick: vi.fn(() => false) }, renaming: false, dropState: null, hueOverride: null,
      onRename: vi.fn(), onRenameSubmit: vi.fn(), onRenameCancel: vi.fn(), onSetHue: vi.fn(),
      onNewThread: vi.fn(), onMarkAllRead: vi.fn(), onDelete: vi.fn(), onSectionMove: vi.fn() });
    const button = screen.getByRole("button", { name: /^Review/i });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("01")).toBeTruthy();
    expect(screen.getByLabelText("Failed")).toBeTruthy();
    const header = slot.container.querySelector<HTMLElement>("[data-sb-section=s]")!;
    expect(header.classList.contains("sb-group-header")).toBe(true);
    expect(header.classList.contains("sb-pill-hued")).toBe(true);
    expect(header.classList.contains("sb-tint")).toBe(true);
    expect(header.className).not.toContain("hover:bg-sidebar-accent");
    expect(header.querySelector(".sb-section-slot .sb-section-rollups")).toBeTruthy();
    expect(header.querySelector(".sb-section-slot .sb-section-controls button[aria-label='Section actions']")).toBeTruthy();
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledWith("section:s");
    slot.unmount();
  });

  it("does not collapse a section on the click after its drag", () => {
    const onToggle = vi.fn();
    const slot = renderSlot({ component: GroupHeader }, { group, collapsed: false, sectionColour: "rail" as const, onToggle,
      drag: { onSectionPointerDown: vi.fn(), consumeClick: vi.fn(() => true) },
      renaming: false, dropState: null, hueOverride: null,
      onRename: vi.fn(), onRenameSubmit: vi.fn(), onRenameCancel: vi.fn(), onSetHue: vi.fn(),
      onNewThread: vi.fn(), onMarkAllRead: vi.fn(), onDelete: vi.fn(), onSectionMove: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: /^Review/i }));
    expect(onToggle).not.toHaveBeenCalled();
    slot.unmount();
  });

  it("aligns an empty section drop box without padding into the rail", () => {
    const empty = buildGroups({ sections: [sidebarSection("empty", "Empty")], layout: EMPTY_LAYOUT, threads: [] })[0]!;
    const slot = renderSlot({ component: GroupHeader }, { group: empty, collapsed: false, sectionColour: "rail" as const,
      onToggle: vi.fn(), drag: { onSectionPointerDown: vi.fn(), consumeClick: vi.fn(() => false) },
      renaming: false, dropState: null, hueOverride: null, onRename: vi.fn(), onRenameSubmit: vi.fn(),
      onRenameCancel: vi.fn(), onSetHue: vi.fn(), onNewThread: vi.fn(), onMarkAllRead: vi.fn(),
      onDelete: vi.fn(), onSectionMove: vi.fn() });
    expect(slot.container.querySelector(".sb-empty-drop[data-sb-drop='section:empty']")).toBeTruthy();
    slot.unmount();
  });

  it("filters with chips and clears both query and chips on Escape", () => {
    const onChange = vi.fn();
    const inputRef = { current: null };
    const filter = { query: "work", states: new Set(["running" as const]) };
    const { rerender } = render(<FilterBar filter={filter} counts={{ ...EMPTY_COUNTS, failed: 2, running: 1 }}
      showChips inputRef={inputRef} onChange={onChange} />);
    expect(screen.queryByRole("button", { name: /needs you/i })).toBeNull();
    const failed = screen.getByRole("button", { name: "Failed: 2" });
    expect(failed.hasAttribute("title")).toBe(false);
    expect(failed.textContent?.toLowerCase()).not.toContain("failed");
    expect(screen.getByRole("searchbox", { name: "Filter threads" }).getAttribute("placeholder")).toBe("Filter threads");
    fireEvent.click(failed);
    expect(onChange.mock.lastCall?.[0].states).toEqual(new Set(["running", "failed"]));
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Filter threads" }), { key: "Escape" });
    expect(onChange).toHaveBeenLastCalledWith({ query: "", states: new Set() });
    rerender(<FilterBar filter={{ query: "", states: new Set() }} counts={EMPTY_COUNTS}
      showChips={false} inputRef={inputRef} onChange={onChange} />);
    expect(screen.queryByRole("button", { name: /failed/i })).toBeNull();
  });
});
