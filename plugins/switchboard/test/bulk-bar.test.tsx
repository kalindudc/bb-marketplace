import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BulkBar } from "../src/bulk-bar";
import { buildGroups } from "../src/tree";
import { EMPTY_LAYOUT } from "../src/layout";
import { sidebarSection, sidebarThread } from "./fixtures";

afterEach(() => { cleanup(); vi.clearAllMocks(); });
const groups = buildGroups({ layout: EMPTY_LAYOUT, sections: [sidebarSection("s", "Section")], threads: [
  sidebarThread({ id: "p", isPinned: true, pinnedAt: 1 }), sidebarThread({ id: "a", sectionId: "s" }),
] });

describe("bulk selection bar", () => {
  it("moves to a coloured section, pinned or Threads", () => {
    const onMove = vi.fn();
    render(<BulkBar count={2} childCount={5} groups={groups} onMove={onMove} onArchive={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByText("2 selected")).toBeTruthy();
    expect(screen.getByLabelText("Selected threads").classList.contains("sb-bulk-bar")).toBe(true);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Move to" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Section" }));
    expect(onMove).toHaveBeenCalledWith("section:s");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Move to" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Pinned" }));
    expect(onMove).toHaveBeenCalledWith("pinned");
  });

  it("only permits Snooze when every selected family is quiet", () => {
    const onSnooze = vi.fn();
    const { rerender } = render(<BulkBar count={2} childCount={0} groups={groups} onMove={vi.fn()}
      onArchive={vi.fn()} onClear={vi.fn()} onSnooze={onSnooze} canSnooze={false} />);
    expect(screen.getByRole("button", { name: "Snooze" }).hasAttribute("disabled")).toBe(true);
    rerender(<BulkBar count={2} childCount={0} groups={groups} onMove={vi.fn()}
      onArchive={vi.fn()} onClear={vi.fn()} onSnooze={onSnooze} canSnooze />);
    fireEvent.click(screen.getByRole("button", { name: "Snooze" }));
    expect(onSnooze).toHaveBeenCalledOnce();
  });

  it("confirms archive with selected and child counts and can clear selection", () => {
    const onArchive = vi.fn(), onClear = vi.fn();
    render(<BulkBar count={3} childCount={5} groups={groups} onMove={vi.fn()} onArchive={onArchive} onClear={onClear} />);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(screen.getByText(/Their 5 child threads are archived too/)).toBeTruthy();
    expect(onArchive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Archive threads" }));
    expect(onArchive).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});
