import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });

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
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Threads" }).className).toContain("sb-density-two-line"));
    fireEvent.contextMenu(screen.getByRole("link", { name: "Pinned note" }));
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeTruthy();
    slot.unmount();
  });
});
