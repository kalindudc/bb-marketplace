import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ThreadList } from "../src/thread-list";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../src/rpc";
import { isCollapseKey, type CollapseKey } from "../src/layout";
import { layoutWriteFakes, sidebarProject, sidebarSection, sidebarThread } from "./fixtures";

const props: PluginThreadListProps = {
  activeThreadId: null, activeProjectId: null, isCompactViewport: false, onNavigate: vi.fn(), searchQuery: "",
};
const threads = [
  sidebarThread({ id: "pin", displayTitle: "Pinned note", isPinned: true, pinnedAt: 100 }),
  sidebarThread({ id: "parent", displayTitle: "Parent project", sectionId: "a", projectId: "p" }),
  sidebarThread({ id: "child", displayTitle: "Running child", sectionId: "b", projectId: "q", parentThreadId: "parent", status: "active" }),
  sidebarThread({ id: "review", displayTitle: "Review thread", sectionId: "b", status: "error" }),
  sidebarThread({ id: "loose", displayTitle: "Loose thread", hasPendingInteraction: true }),
  sidebarThread({ id: "hidden", displayTitle: "Hidden internal", isHidden: true }),
].map((thread) => ({ ...thread, href: `/projects/${thread.projectId}/threads/${thread.id}` }));
const empty = { sectionOrder: [], sectionHues: {}, collapsed: [], order: {}, sectionSort: {}, snoozes: {}, sectionProjects: {} };
const layout = { panes: [
  { paneId: "p1", threadId: "parent", isFocused: true, rect: { x: 0, y: 0, width: .5, height: 1 } },
  { paneId: "p2", threadId: "review", isFocused: false, rect: { x: .5, y: 0, width: .5, height: 1 } },
] };
const compact = { ...props, isCompactViewport: true };
const dialogProto = HTMLDialogElement.prototype;
const nativeShow = Object.getOwnPropertyDescriptor(dialogProto, "showModal");
const nativeClose = Object.getOwnPropertyDescriptor(dialogProto, "close");
const showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
beforeEach(() => {
  // jsdom has no top layer, so focus and modal mechanics also need a browser check.
  Object.defineProperties(dialogProto, {
    showModal: { value: showModal, configurable: true },
    close: { value(this: HTMLDialogElement) { this.open = false; }, configurable: true },
  });
});
afterEach(() => {
  cleanup(); localStorage.clear(); vi.clearAllMocks();
  for (const [key, descriptor] of [["showModal", nativeShow], ["close", nativeClose]] as const)
    if (descriptor) Object.defineProperty(dialogProto, key, descriptor); else Reflect.deleteProperty(dialogProto, key);
});

async function mount(extra: Record<string, unknown> = {}, slotProps: PluginThreadListProps = props) {
  const app = await loadPluginApp(() => import("../app"));
  expect(app.threadLists).toHaveLength(1);
  expect(app.threadLists[0].id).toBe("switchboard");
  const collapsed: CollapseKey[] = [];
  const slot = renderSlot<PluginThreadListProps, RpcContract>(app.threadLists[0]!, slotProps, {
    pluginId: "switchboard",
    sidebarThreads: {
      threads,
      sections: [sidebarSection("a", "Alpha"), sidebarSection("b", "Beta")],
      projects: [sidebarProject("p", "Main"), sidebarProject("q", "Other project")],
    },
    rpc: {
      ...layoutWriteFakes,
      getLayout: () => ({ ...empty, collapsed: [...collapsed] }),
      setCollapsed: ({ key, collapsed: value }) => {
        if (!isCollapseKey(key)) throw new Error("Invalid collapse key");
        const index = collapsed.indexOf(key);
        if (index >= 0) collapsed.splice(index, 1);
        if (value) collapsed.push(key);
        return { collapsed: [...collapsed] };
      },
    },
    sdk: { plugins: { getSettings: async () => ({ ok: true, schema: {}, values: {} }) } },
    sidebarShortcuts: { pin: { label: "⌘1", ariaKeyshortcuts: "Meta+1" } },
    sidebarRowStatuses: { pin: { icon: "Check", label: "Checked", tone: "success" } },
    sidebarDraftThreadIds: ["loose"],
    threadActions: () => [{ key: "bb--core/archive", pluginId: "bb--core", group: "thread", action: {
      label: "Archive", icon: "Archive", run: async () => {},
    } }],
    ...extra,
  });
  await waitFor(() => expect(slot.rpcCalls.some((call) => call.method === "getLayout")).toBe(true));
  return slot;
}

describe("Switchboard sidebar", () => {
  it("shows each visible row once in pinned, section and loose order with cross-project children", async () => {
    const slot = await mount();
    const headers = screen.getAllByRole("button", { name: /Pinned|Alpha|Beta|Threads/i });
    expect(headers.map((button) => button.textContent).join(" ")).toMatch(/Pinned.*Alpha.*Beta.*Threads/i);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(5);
    expect(links.map((link) => link.getAttribute("data-sidebar-thread-id"))).toEqual(["pin", "parent", "child", "review", "loose"]);
    for (const link of links) {
      expect(link.getAttribute("href")).toContain("/threads/");
      expect(link.getAttribute("data-sidebar-thread-shortcut-target")).toBe("");
    }
    expect(screen.queryByText("Hidden internal")).toBeNull();
    expect(screen.getByText("Other project")).toBeTruthy();
    expect(screen.getByText("⌘1")).toBeTruthy();
    expect(slot.container.querySelectorAll("[data-thread-status-glyph]")).toHaveLength(1);
    slot.unmount();
  });

  it("collapses a section optimistically, responds to realtime and preserves the active path", async () => {
    const slot = await mount();
    fireEvent.click(screen.getByRole("button", { name: /^Alpha/i }));
    await waitFor(() => expect(slot.rpcCalls.some((call) => call.method === "setCollapsed" &&
      JSON.stringify(call.input).includes("section:a"))).toBe(true));
    expect(screen.queryByRole("link", { name: "Parent project" })).toBeNull();
    await slot.behavior.emitRealtime("layout", { key: "collapsed", value: ["section:b"] });
    expect(screen.queryByRole("link", { name: "Review thread" })).toBeNull();
    slot.unmount();
  });

  it("filters children with their parents and filters by status chips", async () => {
    const slot = await mount();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter threads" }), { target: { value: "Running child" } });
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("data-sidebar-thread-id"))).toEqual(["parent", "child"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter threads" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Failed: 1" }));
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("data-sidebar-thread-id"))).toEqual(["review"]);
    slot.unmount();
  });

  it("leads with Needs you and treats Draft as an independent facet, retaining ancestor context", async () => {
    const slot = await mount({ sidebarDraftThreadIds: ["child", "hidden"] });
    const needs = screen.getByRole("button", { name: "Needs you: 1" });
    const drafts = screen.getByRole("button", { name: "Draft: 1" });
    expect(needs.textContent).toContain("Needs you");
    expect(needs.parentElement!.firstElementChild).toBe(needs);
    fireEvent.click(drafts);
    const visible = () => screen.getAllByRole("link").map((link) => link.getAttribute("data-sidebar-thread-id"));
    expect(visible()).toEqual(["parent", "child"]);
    fireEvent.click(needs);
    expect(visible()).toEqual(["parent", "child", "loose"]);
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    expect(drafts.getAttribute("aria-pressed")).toBe("false");
    expect(visible()).toEqual(["pin", "parent", "child", "review", "loose"]);
    slot.unmount();
  });

  it("shows split location in compact rows when the host supplies layout, and omits it without layout", async () => {
    const plain = await mount({ sidebarDraftThreadIds: undefined }, compact);
    expect(screen.getByRole("link", { name: "Parent project" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Draft:/ })).toBeNull();
    plain.unmount();
    const slot = await mount({ sidebarSplitLayout: layout }, compact);
    expect(screen.getByRole("link", { name: "Parent project, Left pane" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review thread, Right pane" })).toBeTruthy();
    expect(slot.container.querySelector('[aria-label="1 child threads"]')?.textContent).toContain("1");
    slot.unmount();
  });

  it("opens read-only details without switching threads and restores focus to the exact shelf trigger", async () => {
    const outsideClick = vi.fn();
    render(<button onClick={outsideClick}>Composer control</button>);
    const slot = await mount({ sdk: { plugins: { getSettings: async () => ({ ok: true, schema: {}, values: { needsYouShelf: true } }) } } });
    const shelf = await waitFor(() => {
      const node = slot.container.querySelector<HTMLElement>(".switchboard-needs-shelf");
      expect(node).not.toBeNull();
      return node!;
    });
    const trigger = within(shelf).getByRole("button", { name: "Info for Loose thread" });
    const treeTrigger = screen.getAllByRole("button", { name: "Info for Loose thread" }).at(-1);
    expect(treeTrigger).not.toBe(trigger);
    act(() => trigger.focus());
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Loose thread" });
    expect(showModal).not.toHaveBeenCalled();
    const heading = within(dialog).getByRole("heading");
    const close = within(dialog).getByRole("button", { name: "Close details" });
    expect(document.activeElement).toBe(heading);
    expect(heading.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(dialog).getByText("No workspace")).toBeTruthy();
    expect(within(dialog).getByText("Changes").nextElementSibling?.textContent).toBe("Not applicable");
    expect(within(dialog).queryAllByRole("link")).toEqual([]);
    const composer = screen.getByRole("button", { name: "Composer control" });
    act(() => composer.focus());
    fireEvent.click(composer);
    expect(outsideClick).toHaveBeenCalledOnce();
    act(() => trigger.focus());
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(heading);
    act(() => composer.focus());
    fireEvent.keyDown(composer, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {});
    expect(document.activeElement).toBe(composer);
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("heading", { name: "Loose thread" }), { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(slot.inspection.navigateCalls).toEqual([]);
    expect(props.onNavigate).not.toHaveBeenCalled();
    slot.unmount();
  });

  it.each([
    ["ordinary single pane", props, undefined, "Parent project", "No split location reported"],
    ["compact host's null layout", compact, undefined, "Parent project", "No split location reported"],
    ["known pane", props, layout, "Parent project", "Left pane"],
    ["thread outside a known split", props, layout, "Loose thread", "No split pane"],
  ] as const)("describes %s without guessing a hidden location", async (_name, listProps, sidebarSplitLayout, title, location) => {
    const slot = await mount({ sidebarSplitLayout }, listProps);
    const trigger = screen.getByRole("button", { name: `Info for ${title}` });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: title });
    expect(within(dialog).getByText("Open in").nextElementSibling?.textContent).toBe(location);
    expect(showModal).toHaveBeenCalledTimes(listProps.isCompactViewport ? 1 : 0);
    fireEvent.keyDown(within(dialog).getByRole("heading"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    slot.unmount();
  });

  it("returns compact details to the filter if a live layout update removed the launcher or Info is turned Off", async () => {
    let infoCard = "glance";
    const slot = await mount({ sdk: { plugins: { getSettings: async () => ({ ok: true, schema: {}, values: { infoCard } }) } } }, compact);
    const trigger = screen.getByRole("button", { name: "Info for Parent project" });
    fireEvent.click(trigger);
    await slot.behavior.emitRealtime("layout", { key: "collapsed", value: ["section:a"] });
    expect(trigger.isConnected).toBe(false);
    fireEvent.keyDown(screen.getByRole("heading", { name: "Parent project" }), { key: "Escape" });
    const filter = screen.getByRole("searchbox");
    await waitFor(() => expect(document.activeElement).toBe(filter));
    fireEvent.click(screen.getByRole("button", { name: "Info for Loose thread" }));
    infoCard = "off";
    await slot.behavior.emitRealtime("settings", {});
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("button", { name: /^Info for / })).toBeNull();
      expect(document.activeElement).toBe(filter);
    });
    slot.unmount();
  });

  it("keeps Info on modifier selection but closes without restoring old focus on an ordinary row open", async () => {
    const slot = await mount();
    const launcher = screen.getByRole("button", { name: "Info for Parent project" });
    fireEvent.click(launcher);
    const link = screen.getByRole("link", { name: "Review thread" });
    fireEvent.click(link, { altKey: true });
    fireEvent.click(link, { shiftKey: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(link.closest("[data-switchboard-row]")?.getAttribute("data-selected")).toBe("true");
    expect(props.onNavigate).not.toHaveBeenCalled();
    link.addEventListener("click", event => event.preventDefault(), { once: true });
    fireEvent.click(link);
    expect(props.onNavigate).toHaveBeenCalledOnce();
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).not.toBe(launcher);
    slot.unmount();
  });

  it.each([props, compact])("closes Info on an external active-thread change without restoring old focus", async (listProps) => {
    const slot = await mount({}, listProps);
    const launcher = screen.getByRole("button", { name: "Info for Parent project" });
    act(() => launcher.focus());
    fireEvent.click(launcher);
    expect(screen.getByRole("dialog")).toBeTruthy();
    slot.rerender(<ThreadList {...listProps} activeThreadId="review" />);
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).not.toBe(launcher);
    expect(screen.getByRole("link", { name: "Review thread" }).getAttribute("aria-current")).toBe("page");
    expect(props.onNavigate).not.toHaveBeenCalled();
    slot.unmount();
  });

  it("intersects Draft with the search in status lanes without adding an extra lane", async () => {
    const slot = await mount({ sidebarDraftThreadIds: ["child", "loose"],
      sdk: { plugins: { getSettings: async () => ({ ok: true, schema: {}, values: { view: "status" } }) } } });
    await waitFor(() => expect(slot.container.querySelector(".switchboard-lane")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Draft: 2" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Running child" } });
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("data-sidebar-thread-id"))).toEqual(["child"]);
    expect(slot.container.querySelectorAll(".switchboard-lane")).toHaveLength(1);
    slot.unmount();
  });

  it("keeps the opt-in shelf restricted to matching urgent drafts", async () => {
    const slot = await mount({ sidebarDraftThreadIds: ["child", "loose"],
      sdk: { plugins: { getSettings: async () => ({ ok: true, schema: {}, values: { needsYouShelf: true } }) } } });
    const shelf = await waitFor(() => {
      const shelf = slot.container.querySelector<HTMLElement>(".switchboard-needs-shelf");
      expect(shelf).not.toBeNull();
      return shelf!;
    });
    fireEvent.click(screen.getByRole("button", { name: "Draft: 2" }));
    expect(within(shelf).getAllByRole("link").map((link) => link.getAttribute("aria-label"))).toEqual(["Loose thread"]);
    expect(screen.getByRole("link", { name: "Running child" })).toBeTruthy();
    slot.unmount();
  });

  it("opens bb's menus, invokes navigation and focuses the filter with slash", async () => {
    const slot = await mount();
    fireEvent.click(screen.getAllByRole("button", { name: "Thread actions" })[0]);
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeTruthy();
    const anchor = screen.getByRole("link", { name: "Pinned note" });
    anchor.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(anchor);
    expect(props.onNavigate).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole("navigation", { name: "Threads" }), { key: "/" });
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Filter threads" }));
    slot.unmount();
  });

  it("keeps a collapsed active path open without rewriting its saved state", async () => {
    const slot = await mount({}, { ...props, activeThreadId: "child" });
    await slot.behavior.emitRealtime("layout", { key: "collapsed", value: ["section:a", "thread:parent"] });
    expect(screen.getByRole("link", { name: "Running child" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Alpha/i }).getAttribute("aria-expanded")).toBe("true");
    expect(slot.rpcCalls.filter((call) => call.method === "setCollapsed")).toHaveLength(0);
    slot.unmount();
  });

  it("refreshes density on a server settings signal and opens a right-click menu", async () => {
    let density = "default";
    const slot = await mount({ sdk: { plugins: { getSettings: async () => ({ ok: true, schema: {}, values: { density } }) } } });
    density = "two-line";
    await slot.behavior.emitRealtime("settings", {});
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Threads" }).className).toContain("switchboard-density-two-line"));
    fireEvent.contextMenu(screen.getByRole("link", { name: "Pinned note" }));
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeTruthy();
    slot.unmount();
  });
});
