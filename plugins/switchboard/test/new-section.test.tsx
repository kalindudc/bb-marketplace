import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarSection, PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../src/rpc";
import { leastUsedHue } from "../src/layout";
import { layoutWriteFakes, sidebarProject, sidebarSection, sidebarThread } from "./fixtures";

const { notify, error } = vi.hoisted(() => ({ notify: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(notify, { error }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });
const props: PluginThreadListProps = { activeThreadId: null, activeProjectId: "p",
  isCompactViewport: false, onNavigate: vi.fn(), searchQuery: "" };
const threads = [sidebarThread({ id: "t", displayTitle: "Fix the build", sectionId: "a" })]
  .map((thread) => ({ ...thread, href: `/projects/p/threads/${thread.id}` }));
const created = (id: string, name: string) => ({ id, name, createdAt: 1, updatedAt: 1 });

async function mount(options: {
  sections?: PluginSidebarSection[];
  view?: "sections" | "status";
  create?(args: { name: string }): Promise<unknown>;
  update?(args: { id: string; name: string }): Promise<unknown>;
} = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const layout = { sectionOrder: [], sectionHues: {}, collapsed: [], order: {}, sectionSort: {}, snoozes: {}, sectionProjects: {} };
  const sdk = {
    plugins: {
      getSettings: async () => ({ ok: true, schema: {}, values: options.view ? { view: options.view } : {} }),
      updateSettings: async () => undefined,
    },
    threads: { update: async () => ({}), markRead: async () => ({}) },
    threadSections: {
      create: options.create ?? (async ({ name }: { name: string }) => created("new", name)),
      update: options.update ?? (async () => ({})), delete: async () => ({}),
    },
  };
  const slot = renderSlot<PluginThreadListProps, RpcContract>(app.threadLists[0]!, props, {
    pluginId: "switchboard",
    sidebarThreads: { threads, projects: [sidebarProject("p", "Project")],
      sections: options.sections ?? [sidebarSection("a", "Alpha"), sidebarSection("b", "Beta")] },
    rpc: { ...layoutWriteFakes, getLayout: () => layout, setCollapsed: () => ({ collapsed: [] }) },
    sdk: sdk as never,
  });
  await waitFor(() => expect(slot.rpcCalls.some((call) => call.method === "getLayout")).toBe(true));
  return slot;
}
type Slot = Awaited<ReturnType<typeof mount>>;
const sdkCalls = (slot: Slot, method: string) => slot.inspection.sdkCalls.filter((call) => call.method === method);
const rpcInputs = (slot: Slot, method: string) => slot.rpcCalls.filter((call) => call.method === method).map((call) => call.input);
const field = () => screen.getByRole("textbox", { name: "Section name" }) as HTMLInputElement;
const draft = () => screen.queryByRole("region", { name: "New section" });
const newSectionButton = () => screen.getByRole("button", { name: "+ New section" });
const header = (name: RegExp) => screen.getByRole("button", { name });
const openSectionMenu = (index: number) => fireEvent.pointerDown(screen.getAllByRole("button", { name: "Section actions" })[index]!,
  { button: 0, ctrlKey: false, pointerType: "mouse" });
const type = async (name: string) => {
  await waitFor(() => expect(document.activeElement).toBe(field()));
  fireEvent.change(field(), { target: { value: name } });
  fireEvent.keyDown(field(), { key: "Enter" });
  await act(async () => { await Promise.resolve(); });
};

describe("new section", () => {
  it("opens an empty draft at the end of the sections and creates nothing on Escape", async () => {
    const slot = await mount();
    fireEvent.click(newSectionButton());
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect(field().value).toBe("");
    expect(sdkCalls(slot, "threadSections.create")).toHaveLength(0);
    const sections = [...document.querySelectorAll(".sb-list > section")];
    expect(sections.indexOf(draft()!)).toBe(sections.findIndex((section) => section.textContent?.includes("Threads")) - 1);
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(draft()).toBeNull();
    expect(sdkCalls(slot, "threadSections.create")).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(newSectionButton()));
  });

  it("creates the typed name, saves the draft's position and colour, then focuses the new header", async () => {
    const slot = await mount({ sections: [sidebarSection("a", "Alpha"), sidebarSection("b", "Beta"), sidebarSection("new", "Created")] });
    openSectionMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "New section below" }));
    await waitFor(() => expect(document.activeElement).toBe(field()));
    const sections = [...document.querySelectorAll(".sb-list > section")];
    expect(sections[sections.indexOf(draft()!) - 1]?.textContent).toContain("Alpha");
    const hue = leastUsedHue(["a", "b", "new"], {});
    expect(draft()!.querySelector(".sb-group-header")!.classList.contains(`sb-hue-${hue}`)).toBe(true);
    await type("  Infra ");
    expect(sdkCalls(slot, "threadSections.create").map((call) => call.args[0])).toEqual([{ name: "Infra" }]);
    await waitFor(() => expect(rpcInputs(slot, "setSectionOrder")).toEqual([{ ids: ["a", "new", "b"] }]));
    expect(rpcInputs(slot, "setSectionHue")).toEqual([{ sectionId: "new", hue }]);
    await waitFor(() => expect(draft()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(header(/^Created/)));
    expect(document.activeElement!.closest(".sb-group-header")!.classList.contains("sb-flash")).toBe(true);
  });

  it("keeps the draft, read-only, until bb lists the new section", async () => {
    const slot = await mount({ create: async ({ name }) => created("later", name) });
    fireEvent.click(newSectionButton());
    await type("Infra");
    await waitFor(() => expect(sdkCalls(slot, "threadSections.create")).toHaveLength(1));
    expect(draft()).toBeTruthy();
    expect(field().readOnly).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Creating…");
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects a taken name inline, and retries a failed create after an edit", async () => {
    let calls = 0;
    const slot = await mount({ create: async ({ name }) => {
      if (++calls === 1) throw new Error("bb is offline");
      return created("new", name);
    } });
    fireEvent.click(newSectionButton());
    await type("Beta");
    expect(screen.getByRole("alert").textContent).toBe("A section named \u201cBeta\u201d already exists");
    expect(sdkCalls(slot, "threadSections.create")).toHaveLength(0);
    await type("Infra");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("bb is offline"));
    expect(field().readOnly).toBe(false);
    await type("Infra team");
    await waitFor(() => expect(sdkCalls(slot, "threadSections.create").map((call) => call.args[0]))
      .toEqual([{ name: "Infra" }, { name: "Infra team" }]));
    expect(error).not.toHaveBeenCalled();
  });

  it("clears the filter so the draft is visible", async () => {
    await mount();
    const filter = screen.getByRole("searchbox", { name: "Filter threads" }) as HTMLInputElement;
    fireEvent.change(filter, { target: { value: "nothing matches" } });
    expect(screen.queryByRole("button", { name: /^Alpha/ })).toBeNull();
    fireEvent.click(newSectionButton());
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect(filter.value).toBe("");
    expect(header(/^Alpha/)).toBeTruthy();
  });

  it("starts from View options in the status lanes view by switching to sections", async () => {
    const slot = await mount({ view: "status" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "+ New section" })).toBeNull());
    fireEvent.pointerDown(screen.getByRole("button", { name: "View options" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(screen.getByRole("menuitem", { name: "New section" }));
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect(sdkCalls(slot, "plugins.updateSettings").map((call) => call.args[0])).toContainEqual(
      expect.objectContaining({ values: { view: "sections" } }));
  });
});

describe("rename section", () => {
  it("selects the old name, skips unchanged names, and retries after a failed save", async () => {
    let calls = 0;
    const slot = await mount({ update: async () => { if (++calls === 1) throw new Error("bb is offline"); return {}; } });
    openSectionMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect([field().value, field().selectionStart, field().selectionEnd]).toEqual(["Alpha", 0, 5]);
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(sdkCalls(slot, "threadSections.update")).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(header(/^Alpha/)));
    openSectionMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    await type("Beta");
    expect(screen.getByRole("alert").textContent).toBe("A section named \u201cBeta\u201d already exists");
    await type("Gamma");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("bb is offline"));
    await type("Gamma team");
    await waitFor(() => expect(sdkCalls(slot, "threadSections.update").map((call) => call.args[0])).toEqual([
      { id: "a", name: "Gamma" }, { id: "a", name: "Gamma team" },
    ]));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Section name" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(header(/^Alpha/)));
  });
});
