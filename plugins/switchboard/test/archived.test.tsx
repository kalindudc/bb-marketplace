import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadActionEntry, PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { archivedThreads } from "../src/archived";
import { EMPTY_LAYOUT } from "../src/layout";
import type { RpcContract } from "../src/rpc";
import { parseSettings } from "../src/settings";
import { layoutWriteFakes, sidebarProject, sidebarSection, sidebarThread } from "./fixtures";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });

const section = sidebarSection("s", "cortex");
const threads = [
  sidebarThread({ id: "live", displayTitle: "Live work", sectionId: "s" }),
  sidebarThread({ id: "old", displayTitle: "Old fix", isArchived: true, archivedAt: 2000, sectionId: "s" }),
  sidebarThread({ id: "newer", displayTitle: "Newer review", isArchived: true, archivedAt: 3000,
    environment: { id: "e", name: null, branchName: "kalindudc/review", path: null, isWorktree: false, providerId: null, workspaceDisplayKind: null } }),
  sidebarThread({ id: "helper", displayTitle: "Hidden helper", isArchived: true, archivedAt: 4000, isHidden: true }),
].map((thread) => ({ ...thread, href: `/projects/p/threads/${thread.id}` }));
const names = { project: () => "bb-marketplace", section: (id: string | null) => id === "s" ? "cortex" : "" };

describe("archived threads", () => {
  it("is a setting that defaults to hidden", () => {
    expect(parseSettings(undefined).showArchived).toBe(false);
    expect(parseSettings({ showArchived: true }).showArchived).toBe(true);
    expect(parseSettings({ showArchived: "yes" }).showArchived).toBe(false);
  });

  it("lists visible archived threads, most recently archived first, matching the query", () => {
    expect(archivedThreads(threads, "", names).map((thread) => thread.id)).toEqual(["newer", "old"]);
    expect(archivedThreads(threads, "REVIEW", names).map((thread) => thread.id)).toEqual(["newer"]);
    expect(archivedThreads(threads, "cortex", names).map((thread) => thread.id)).toEqual(["old"]);
    expect(archivedThreads(threads, "bb-market", names)).toHaveLength(2);
  });
});

async function mount(showArchived: boolean, archivedPage: { hasNextPage: boolean; fetchNextPage: () => Promise<void> }) {
  const app = await loadPluginApp(() => import("../app"));
  const unarchive = vi.fn(async () => undefined);
  const threadActions = (target: { id: string; archivedAt: number | null }): PluginThreadActionEntry[] =>
    target.archivedAt === null ? [] : [{ key: "bb--core/archive", pluginId: "bb--core", group: "4_lifecycle",
      action: { label: "Unarchive", icon: "ArchiveRestore", run: unarchive } }];
  const props: PluginThreadListProps = { activeThreadId: null, activeProjectId: "p", isCompactViewport: false,
    onNavigate: vi.fn(), searchQuery: "" };
  const slot = renderSlot<PluginThreadListProps, RpcContract>(app.threadLists[0]!, props, {
    pluginId: "switchboard", threadActions,
    sidebarThreads: { status: "ready", threads, sections: [section], projects: [sidebarProject("p", "bb-marketplace")],
      experimental_archived: { status: "ready", isFetchingNextPage: false, isFetchNextPageError: false, ...archivedPage } },
    sdk: { plugins: { getSettings: async () => ({ ok: true, schema: {}, values: { showArchived } }), updateSettings: async () => undefined } } as never,
    rpc: { ...layoutWriteFakes, getLayout: () => ({ ...EMPTY_LAYOUT, sectionOrder: [], collapsed: [], order: {},
      sectionHues: {}, sectionSort: {}, snoozes: {} }), setCollapsed: () => ({ collapsed: [] }) },
  });
  await screen.findByLabelText("Live work");
  return { slot, unarchive };
}

describe("archived shelf", () => {
  it("keeps archived threads out of sections while the toggle is off", async () => {
    await mount(false, { hasNextPage: false, fetchNextPage: async () => undefined });
    expect(screen.queryByText("Archived")).toBeNull();
    expect(screen.queryByLabelText("Old fix")).toBeNull();
  });

  it("shows an Archived shelf with unarchive, no jump shortcuts, and more pages", async () => {
    const fetchNextPage = vi.fn(async () => undefined);
    const { unarchive } = await mount(true, { hasNextPage: true, fetchNextPage });
    const shelf = (await screen.findByText("Archived")).closest("section")!;
    const links = within(shelf).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("aria-label"))).toEqual(["Newer review", "Old fix"]);
    expect(links.every((link) => !link.hasAttribute("data-sidebar-thread-id"))).toBe(true);
    expect(within(shelf).queryByLabelText("Hidden helper")).toBeNull();
    const sectionRows = document.querySelectorAll('[data-sidebar-thread-id="old"]');
    expect(sectionRows).toHaveLength(0);
    fireEvent.click(within(shelf).getAllByRole("button", { name: "Unarchive" })[0]!);
    expect(unarchive).toHaveBeenCalledOnce();
    fireEvent.click(within(shelf).getByRole("button", { name: "Show more archived threads" }));
    await waitFor(() => expect(fetchNextPage).toHaveBeenCalledOnce());
  });

  it("filters archived threads with the filter box", async () => {
    await mount(true, { hasNextPage: false, fetchNextPage: async () => undefined });
    await screen.findByText("Archived");
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter threads" }), { target: { value: "review" } });
    expect(screen.getByLabelText("Newer review")).toBeTruthy();
    expect(screen.queryByLabelText("Old fix")).toBeNull();
  });
});
