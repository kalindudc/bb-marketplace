import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { FilterBar } from "../src/filter-bar";
import { GroupHeader, type GroupHeaderProps } from "../src/group-header";
import { EMPTY_LAYOUT } from "../src/layout";
import { DEFAULT_SETTINGS } from "../src/settings";
import { EMPTY_COUNTS, type RowState } from "../src/status";
import { buildGroups } from "../src/tree";
import { sidebarSection, sidebarThread } from "./fixtures";

installTestPluginRuntime();
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function hintFor(element: HTMLElement): Promise<string> {
  fireEvent.keyDown(document.body, { key: "Tab" });
  act(() => element.focus());
  return (await screen.findByRole("tooltip")).textContent ?? "";
}
async function hoverHintFor(element: HTMLElement): Promise<string> {
  fireEvent.pointerMove(element, { pointerType: "mouse" });
  return (await screen.findByRole("tooltip")).textContent ?? "";
}

function renderBar(active: RowState[] = [], showArchived = false) {
  const onChange = vi.fn(), onSettingsChange = vi.fn();
  render(<FilterBar filter={{ query: "", states: new Set(active) }} inputRef={{ current: null }}
    counts={{ ...EMPTY_COUNTS, failed: 1, running: 2 }} showChips onChange={onChange}
    settings={{ ...DEFAULT_SETTINGS, showArchived }} onSettingsChange={onSettingsChange} />);
  return { onChange, onSettingsChange };
}

describe("icon buttons", () => {
  it("centre their icon whatever classes the button adds", () => {
    const css = readFileSync(join(process.cwd(), "src/switchboard.css"), "utf8");
    const rule = css.match(/\.sb-icon-button\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/display:\s*grid/);
    expect(rule).toMatch(/place-items:\s*center/);
  });
});

describe("filter bar hints", () => {
  it("explains what each status chip does, with no browser title", async () => {
    renderBar();
    const running = screen.getByRole("button", { name: "Running: 2" });
    expect(running.hasAttribute("title")).toBe(false);
    expect(await hintFor(running)).toBe("Show only running threads (2)");
  });

  it("says a chip adds to an active filter, and that an active chip removes it", async () => {
    renderBar(["failed"]);
    expect(await hintFor(screen.getByRole("button", { name: "Running: 2" }))).toBe("Also show running threads (2)");
    cleanup();
    renderBar(["failed"]);
    expect(await hintFor(screen.getByRole("button", { name: "Failed: 1" }))).toBe("Stop filtering by failed threads");
  });

  it("explains the view switch and View options", async () => {
    renderBar();
    const lanes = screen.getByRole("button", { name: "Status lanes view" });
    expect(lanes.hasAttribute("title")).toBe(false);
    expect(await hintFor(lanes)).toBe("Status lanes: threads grouped by state, newest first");
    cleanup();
    renderBar();
    expect(await hintFor(screen.getByRole("button", { name: "Sections view" })))
      .toBe("Sections: your sections, in the order you set");
    cleanup();
    renderBar();
    expect(await hintFor(screen.getByRole("button", { name: "View options" })))
      .toBe("View options: view, density, colours and row details");
  });

  it("opens on hover too, but not when focus returns to a button after a click", async () => {
    renderBar();
    const chip = screen.getByRole("button", { name: "Running: 2" });
    fireEvent.pointerDown(chip, { button: 0, pointerType: "mouse" });
    fireEvent.mouseDown(chip);
    fireEvent.pointerUp(document, { button: 0, pointerType: "mouse" });
    fireEvent.mouseUp(chip);
    fireEvent.click(chip);
    act(() => chip.focus());
    expect(screen.queryByRole("tooltip")).toBeNull();
    cleanup();
    renderBar();
    expect(await hoverHintFor(screen.getByRole("button", { name: "Running: 2" }))).toBe("Show only running threads (2)");
  });

  it("toggles archived threads from a pressed icon button with a hint", async () => {
    const { onSettingsChange } = renderBar();
    const toggle = screen.getByRole("button", { name: "Show archived threads" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(await hintFor(toggle)).toBe("Show archived threads");
    fireEvent.click(toggle);
    expect(onSettingsChange).toHaveBeenCalledWith({ showArchived: true });
    cleanup();
    renderBar([], true);
    expect(screen.getByRole("button", { name: "Hide archived threads" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("section header hints", () => {
  const group = buildGroups({ layout: EMPTY_LAYOUT, sections: [sidebarSection("s", "cortex")],
    threads: [sidebarThread({ sectionId: "s" })] }).find((entry) => entry.kind === "section")!;
  const noop = () => undefined;
  const props: GroupHeaderProps = { group, collapsed: false, sectionColour: "rail", onToggle: noop,
    drag: { onSectionPointerDown: noop, consumeClick: () => false }, renaming: false, dropState: null, hueOverride: null,
    onRename: noop, onRenameSubmit: noop, onRenameCancel: noop, onSetHue: noop, onNewThread: noop,
    onMarkAllRead: noop, onDelete: noop, onSectionMove: noop, sortMode: "recent", onSort: noop, onArchiveStale: noop };

  it("explains the automatic sort indicator", async () => {
    render(<GroupHeader {...props} />);
    expect(await hoverHintFor(screen.getByLabelText("Sorted by recent activity")))
      .toBe("Sorted by recent activity. Change it in Section actions.");
  });

  it("names the new-thread and section actions buttons without browser titles", async () => {
    render(<GroupHeader {...props} />);
    const add = screen.getByRole("button", { name: "New thread in cortex" });
    expect(add.hasAttribute("title")).toBe(false);
    expect(await hintFor(add)).toBe("New thread in cortex");
    cleanup();
    render(<GroupHeader {...props} />);
    const options = screen.getByRole("button", { name: "Section actions" });
    expect(options.hasAttribute("title")).toBe(false);
    expect(await hintFor(options)).toBe("Section actions: rename, colour, sort and more");
  });
});
