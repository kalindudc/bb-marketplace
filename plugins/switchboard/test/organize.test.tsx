import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../src/rpc";
import type { CollapseKey, HueId } from "../src/layout";
import { layoutWriteFakes, sidebarProject, sidebarSection, sidebarThread } from "./fixtures";

const { notify, error } = vi.hoisted(() => ({ notify: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(notify, { error }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });
const props: PluginThreadListProps = { activeThreadId: null, activeProjectId: "p",
  isCompactViewport: false, onNavigate: vi.fn(), searchQuery: "" };
const threads = [
  sidebarThread({ id: "a", displayTitle: "A", createdAt: 30 }),
  sidebarThread({ id: "child", displayTitle: "A child", parentThreadId: "a", createdAt: 31 }),
  sidebarThread({ id: "b", displayTitle: "B", createdAt: 20 }),
  sidebarThread({ id: "r", displayTitle: "Review", sectionId: "s", isUnread: true, createdAt: 10 }),
].map((thread) => ({ ...thread, href: `/projects/p/threads/${thread.id}` }));

async function mount() {
  const app = await loadPluginApp(() => import("../app"));
  let layout = { sectionOrder: [] as string[], sectionHues: {} as Record<string, HueId>,
    collapsed: [] as CollapseKey[], order: {} as Record<string, string[]>, sectionSort: {}, snoozes: {} };
  const sdk = {
    plugins: { getSettings: async () => ({ ok: true, schema: {}, values: {} }) },
    threads: {
      update: async () => ({}), pin: async () => ({}), unpin: async () => ({}),
      reorderPinned: async () => ({}), archive: async () => ({}), unarchive: async () => ({}), markRead: async () => ({}),
    },
    threadSections: {
      create: async () => ({ id: "new", name: "New section", createdAt: 1, updatedAt: 1 }),
      update: async () => ({}), delete: async () => ({}),
    },
  };
  const slot = renderSlot<PluginThreadListProps, RpcContract>(app.threadLists[0]!, props, {
    pluginId: "switchboard", sidebarThreads: { threads, sections: [sidebarSection("s", "Section")], projects: [sidebarProject("p", "Project")] },
    rpc: {
      ...layoutWriteFakes,
      getLayout: () => layout,
      setCollapsed: ({ key, collapsed }) => ({ collapsed: layout.collapsed = collapsed ?
        [...layout.collapsed.filter((id) => id !== key), key as CollapseKey] : layout.collapsed.filter((id) => id !== key) }),
      setOrder: ({ container, ids }) => { layout = { ...layout, order: { ...layout.order, [container]: ids } }; return { ids }; },
      setSectionOrder: ({ ids }) => { layout = { ...layout, sectionOrder: ids }; return { ids }; },
      setSectionHue: ({ sectionId, hue }) => {
        const sectionHues = { ...layout.sectionHues };
        if (hue) sectionHues[sectionId] = hue;
        else delete sectionHues[sectionId];
        layout = { ...layout, sectionHues }; return { sectionHues };
      },
    },
    sdk: sdk as never,
  });
  await waitFor(() => expect(slot.rpcCalls.some((call) => call.method === "getLayout")).toBe(true));
  return slot;
}

const link = (name: string) => screen.getByRole("link", { name });
const sdkCalls = (slot: Awaited<ReturnType<typeof mount>>, method: string) =>
  slot.inspection.sdkCalls.filter((call) => call.method === method);

describe("organize in the sidebar", () => {
  it("nests with Alt+Right and Undo restores the bb parent; Alt+Up stores sibling order", async () => {
    const slot = await mount();
    fireEvent.keyDown(link("B"), { key: "ArrowRight", altKey: true });
    await waitFor(() => expect(sdkCalls(slot, "threads.update")).toContainEqual(expect.objectContaining({
      args: [{ threadId: "b", parentThreadId: "a" }],
    })));
    expect(notify.mock.calls[0]![1].description).toContain("2 seconds");
    notify.mock.calls[0]![1].action.onClick();
    await waitFor(() => expect(sdkCalls(slot, "threads.update")).toContainEqual(expect.objectContaining({
      args: [{ threadId: "b", parentThreadId: null }],
    })));
    fireEvent.keyDown(link("B"), { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(slot.rpcCalls).toContainEqual(expect.objectContaining({
      method: "setOrder", input: { container: "loose", ids: ["b", "a"] },
    })));
    slot.unmount();
  });

  it("Alt-selects two roots, moves them into a section and archives roots with child count", async () => {
    const slot = await mount();
    fireEvent.click(link("A"), { altKey: true });
    fireEvent.click(link("B"), { altKey: true });
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Move to" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Section" }));
    await waitFor(() => expect(sdkCalls(slot, "threads.update").map((call) => call.args[0])).toEqual([
      { threadId: "a", sectionId: "s" }, { threadId: "b", sectionId: "s" },
    ]));
    fireEvent.click(link("A"), { altKey: true });
    fireEvent.click(link("B"), { altKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(screen.getByText(/Their 1 child thread is archived too/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archive threads" }));
    await waitFor(() => expect(sdkCalls(slot, "threads.archive").map((call) => call.args[0])).toEqual([
      { threadId: "a" }, { threadId: "b" },
    ]));
    slot.unmount();
  });

  it("Shift-click selects a visible range and archive Undo unarchives parent and child", async () => {
    const slot = await mount();
    fireEvent.click(link("A"), { altKey: true });
    fireEvent.click(link("B"), { shiftKey: true });
    expect(screen.getByText("3 selected")).toBeTruthy();
    expect([...slot.container.querySelectorAll<HTMLElement>("[data-run]")].map((row) =>
      [row.dataset.threadId, row.dataset.run])).toEqual([
      ["a", "start"], ["child", "middle"], ["b", "end"],
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive threads" }));
    await waitFor(() => expect(sdkCalls(slot, "threads.archive")).toHaveLength(2));
    notify.mock.calls.at(-1)![1].action.onClick();
    await waitFor(() => expect(sdkCalls(slot, "threads.unarchive").map((call) => call.args[0])).toEqual([
      { threadId: "a" }, { threadId: "child" }, { threadId: "b" },
    ]));
    slot.unmount();
  });

  it("renames, colours, composes, marks read, deletes and creates sections", async () => {
    const slot = await mount();
    const actions = () => screen.getAllByRole("button", { name: "Section actions" })[0]!;
    const open = () => fireEvent.pointerDown(actions(), { button: 0, ctrlKey: false, pointerType: "mouse" });
    open(); fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(sdkCalls(slot, "threadSections.update")).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Section name" })));
    fireEvent.change(screen.getByRole("textbox", { name: "Section name" }), { target: { value: "  Renamed  " } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Section name" }), { key: "Enter" });
    await waitFor(() => expect(sdkCalls(slot, "threadSections.update")[0]?.args[0]).toEqual({ id: "s", name: "Renamed" }));
    open(); fireEvent.pointerMove(screen.getByRole("menuitem", { name: "Colour" }));
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Colour" }), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Violet" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual(expect.objectContaining({
      method: "setSectionHue", input: { sectionId: "s", hue: "violet" },
    })));
    open(); fireEvent.click(screen.getByRole("menuitem", { name: "New thread here" }));
    expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({
      method: "toCompose", options: { projectId: "p", placement: { sectionId: "s", pinned: false }, focusPrompt: true },
    }));
    open(); fireEvent.click(screen.getByRole("menuitem", { name: "Mark all read" }));
    await waitFor(() => expect(sdkCalls(slot, "threads.markRead")[0]?.args[0]).toEqual({ threadId: "r" }));
    open(); fireEvent.click(screen.getByRole("menuitem", { name: /Delete section/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete section" }));
    await waitFor(() => expect(sdkCalls(slot, "threadSections.delete")[0]?.args[0]).toEqual({ id: "s" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual(expect.objectContaining({
      method: "setOrder", input: { container: "section:s", ids: [] },
    })));
    fireEvent.click(screen.getByRole("button", { name: /New section/ }));
    await waitFor(() => expect(sdkCalls(slot, "threadSections.create")[0]?.args[0]).toEqual({ name: "New section" }));
    slot.unmount();
  });

  it("disables pointer drags while filtering", async () => {
    const slot = await mount();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter threads" }), { target: { value: "A" } });
    fireEvent.pointerDown(link("A"), { pointerId: 1, pointerType: "mouse", button: 0, clientX: 40, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: "mouse", clientX: 40, clientY: 120 });
    expect(slot.container.querySelector(".sb-ghost")).toBeNull();
    slot.unmount();
  });
});
