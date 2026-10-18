import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { EMPTY_LAYOUT } from "../src/layout";
import { buildGroups } from "../src/tree";
import { RenameInput, SectionMenu } from "../src/section-menu";
import { sidebarProject, sidebarSection, sidebarThread } from "./fixtures";

installTestPluginRuntime();
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const group = buildGroups({ layout: EMPTY_LAYOUT, sections: [sidebarSection("s", "Section")],
  threads: [sidebarThread({ sectionId: "s", isUnread: true })] })[0]!;

function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Section actions" }),
    { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("section controls", () => {
  it("submits only trimmed nonempty names, and Escape cancels", () => {
    const submit = vi.fn(), cancel = vi.fn();
    const first = render(<RenameInput initial="Section" onSubmit={submit} onCancel={cancel} />);
    const field = screen.getByRole("textbox", { name: "Section name" });
    fireEvent.change(field, { target: { value: "  New name  " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(submit).toHaveBeenCalledWith("New name");
    first.unmount();
    render(<RenameInput initial="Section" onSubmit={submit} onCancel={cancel} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Section name" }), { key: "Escape" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("offers new thread and mark read; confirms a descriptive section delete", () => {
    const onRename = vi.fn(), onDelete = vi.fn(), onNewThread = vi.fn(), onMarkAllRead = vi.fn();
    render(<SectionMenu group={group} unreadCount={1} hueOverride={null} onRename={onRename}
      onSetHue={vi.fn()} onNewThread={onNewThread} onMarkAllRead={onMarkAllRead} onDelete={onDelete} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "New thread here" }));
    expect(onNewThread).toHaveBeenCalledOnce();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark all read" }));
    expect(onMarkAllRead).toHaveBeenCalledOnce();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete section/ }));
    expect(screen.getByText(/Its 1 thread moves to Threads/)).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete section" }));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("offers section sorting and confirms only stale-root archiving with child counts", () => {
    const onSort = vi.fn(), onArchiveStale = vi.fn();
    render(<SectionMenu group={group} unreadCount={0} hueOverride={null} onRename={vi.fn()}
      onSetHue={vi.fn()} onNewThread={vi.fn()} onMarkAllRead={vi.fn()} onDelete={vi.fn()}
      sortMode="manual" staleCount={4} staleChildCount={6} staleDays={3}
      onSort={onSort} onArchiveStale={onArchiveStale} />);
    openMenu();
    fireEvent.pointerMove(screen.getByRole("menuitem", { name: "Sort" }));
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Sort" }), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Recent activity" }));
    expect(onSort).toHaveBeenCalledWith("recent");
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Archive stale threads/ }));
    expect(screen.getByText(/Archive 4 threads idle for more than 3 days/)).toBeTruthy();
    expect(screen.getByText(/Their 6 child threads are archived too/)).toBeTruthy();
    expect(onArchiveStale).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Archive stale threads" }));
    expect(onArchiveStale).toHaveBeenCalledOnce();
  });

  it("picks a default project for new threads, with Automatic as the default", () => {
    const onSetDefaultProject = vi.fn();
    const projects = [sidebarProject("p", "Project"), sidebarProject("q", "Other")];
    const menu = (defaultProjectId: string | null) => <SectionMenu group={group} unreadCount={0} hueOverride={null}
      onRename={vi.fn()} onSetHue={vi.fn()} onNewThread={vi.fn()} onMarkAllRead={vi.fn()} onDelete={vi.fn()}
      projects={projects} defaultProjectId={defaultProjectId} onSetDefaultProject={onSetDefaultProject} />;
    const openProjects = () => {
      openMenu();
      fireEvent.pointerMove(screen.getByRole("menuitem", { name: "Default project" }));
      fireEvent.keyDown(screen.getByRole("menuitem", { name: "Default project" }), { key: "ArrowRight" });
    };
    const view = render(menu(null));
    openProjects();
    expect(screen.getByRole("menuitemradio", { name: "Automatic" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Other" }));
    expect(onSetDefaultProject).toHaveBeenCalledWith("q");
    view.rerender(menu("q"));
    openProjects();
    expect(screen.getByRole("menuitemradio", { name: "Other" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Automatic" }));
    expect(onSetDefaultProject).toHaveBeenLastCalledWith(null);
  });

  it("has no default project choice without a handler", () => {
    render(<SectionMenu group={group} unreadCount={0} hueOverride={null} onRename={vi.fn()}
      onSetHue={vi.fn()} onNewThread={vi.fn()} onMarkAllRead={vi.fn()} onDelete={vi.fn()} />);
    openMenu();
    expect(screen.queryByRole("menuitem", { name: "Default project" })).toBeNull();
  });

  it("exposes automatic and eight hue choices", () => {
    const onSetHue = vi.fn(), onRename = vi.fn();
    render(<SectionMenu group={group} unreadCount={0} hueOverride={null} onRename={onRename}
      onSetHue={onSetHue} onNewThread={vi.fn()} onMarkAllRead={vi.fn()} onDelete={vi.fn()} />);
    openMenu();
    expect(screen.getByRole("menuitem", { name: "Mark all read" }).hasAttribute("data-disabled")).toBe(true);
    fireEvent.pointerMove(screen.getByRole("menuitem", { name: "Colour" }));
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Colour" }), { key: "ArrowRight" });
    expect(document.querySelector(".sb-colour-menu")?.classList.contains("w-max")).toBe(true);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Violet" }));
    expect(onSetHue).toHaveBeenCalledWith("violet");
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onRename).toHaveBeenCalledOnce();
  });
});
