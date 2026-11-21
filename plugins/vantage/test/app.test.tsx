import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginCommandContext } from "@get-bb/plugin-sdk/app";
import { PANEL_ACTION_ID, createCommands } from "../src/commands";
import { sidebarThread } from "./fixtures";
import { disposeSessions } from "../src/session";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

afterEach(() => {
  vi.mocked(toast.error).mockClear();
  disposeSessions();
  document.body.replaceChildren();
});

describe("plugin app", () => {
  it("registers the page with its sidebar, title bar and page title but no navigation badge, and an Agent tab beside it", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.navPanels).toHaveLength(1);
    const page = app.navPanels[0]!;
    expect(page).toMatchObject({ id: "vantage", title: "Vantage", icon: "vantage/vantage", path: "vantage" });
    expect(page.experimental_sidebar).toBeTypeOf("function");
    expect(page.headerContent).toBeTypeOf("function");
    expect(page.experimental_usePageTitle).toBeTypeOf("function");
    expect(page.experimental_useBadge).toBeUndefined();
    expect(app.tabs.map(({ id, context, availability }) => ({ id, context, availability }))).toEqual([
      { id: "agent", context: { kind: "nav-panel", panelId: "vantage" }, availability: "fixed" },
      { id: "changes", context: { kind: "thread" }, availability: "action" },
    ]);
  });

  it("keeps the thread tab's id from the retired panel action, so a tab left open keeps working", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.tabs.find((tab) => tab.context.kind === "thread")).toMatchObject({
      id: PANEL_ACTION_ID,
      title: "Vantage",
      icon: "vantage/vantage",
      layout: "flush",
    });
  });

  it("adds a composer segment, an Info section, one thread menu entry and the toasts", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.threadContextSegments.map(({ id, group }) => ({ id, group }))).toEqual([
      { id: "worktrees", group: "3_git" },
    ]);
    expect(app.threadContextSegments[0]!.details).toBeTypeOf("function");
    expect(app.threadContextSegments[0]!.useVisible).toBeTypeOf("function");
    expect(app.threadInfoSections.map(({ id, group }) => ({ id, group }))).toEqual([
      { id: "worktrees", group: "2_changes" },
    ]);
    expect(app.threadActions.map(({ id, group, placement }) => ({ id, group, placement }))).toEqual([
      { id: "review", group: "1_open", placement: undefined },
      { id: "open", group: "1_open", placement: "header" },
    ]);
    expect(app.appOverlays.map(({ id }) => id)).toEqual(["attention"]);
    expect(app.threadContextCardSections.map(({ id, title, group, order }) => ({ id, title, group, order }))).toEqual([
      { id: "worktrees", title: "Worktrees", group: "1_related", order: 5 },
    ]);
    expect(app.threadRowMetadata.map(({ id, order }) => ({ id, order }))).toEqual([{ id: "changes", order: 50 }]);
    expect(app.threadRowMetadata[0]!.useData).toBeTypeOf("function");
    expect(app.contentScripts).toHaveLength(0);
  });
});

describe("the thread header's Vantage action", () => {
  it("uses Vantage's icon and asks bb to toggle its thread tab", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const action = app.threadActions.find((entry) => entry.id === "open")!;
    const toggleTab = vi.fn(() => true);
    const item = action.item({ experimental_panel: { toggleTab } } as never)!;
    expect(item).toMatchObject({ label: "Vantage", icon: "vantage/vantage" });
    await item.run({ requestRename: vi.fn() });
    expect(toggleTab).toHaveBeenCalledWith({
      tab: { id: "changes", context: { kind: "thread" }, availability: "action" },
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("says so when bb cannot show the tab", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const action = app.threadActions.find((entry) => entry.id === "open")!;
    await action.item({ experimental_panel: { toggleTab: () => false } } as never)!.run({ requestRename: vi.fn() });
    expect(toast.error).toHaveBeenCalledWith("bb could not open the Vantage tab");
  });
});

describe("commands", () => {
  const context = (overrides: Partial<PluginCommandContext> = {}): PluginCommandContext => ({
    threadId: "thr_1",
    projectId: "proj_1",
    experimental_panel: {
      openTab: vi.fn(() => true),
      toggleTab: vi.fn(() => true),
      selectTab: vi.fn(() => true),
      closeTab: vi.fn(() => true),
      close: vi.fn(() => true),
      getTabs: vi.fn(),
    },
    ...overrides,
  });

  it("registers one command, without a default shortcut", () => {
    const commands = createCommands();
    expect(commands.map((command) => command.id)).toEqual(["open"]);
    expect(commands[0]?.title).toBe("Vantage: Show changes across repositories");
    expect(commands[0]?.defaultShortcut).toBeUndefined();
  });

  it("is available only where a thread is in view, and opens the thread tab", async () => {
    const open = createCommands()[0]!;
    expect(open.isAvailable?.(context({ threadId: null, projectId: null }))).toBe(false);
    const ready = context();
    expect(open.isAvailable?.(ready)).toBe(true);
    await open.run(ready);
    expect(ready.experimental_panel.openTab).toHaveBeenCalledWith({
      tab: { id: "changes", context: { kind: "thread" }, availability: "action" },
    });
  });
});

describe("manifest", () => {
  const root = join(__dirname, "..");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  it("declares the server, app, host entry, skill and Vantage's own icon", () => {
    expect(manifest.name).toBe("bb-plugin-vantage");
    expect(manifest.bb).toMatchObject({
      name: "Vantage",
      branding: { icon: "./icons/vantage.svg", experimental_icons: { vantage: "./icons/vantage.svg" } },
      server: "./server.ts",
      app: "./app.tsx",
      host: "./host.ts",
      skills: ["./skills"],
    });
    expect(manifest.engines).toEqual({ bb: ">=0.49", bbPluginSdk: ">=0.6.132" });
  });

  it("keeps the SDK a dev dependency pinned to the version bb 0.49 ships, and bundles zod", () => {
    expect(Object.keys(manifest.dependencies)).toEqual(["zod"]);
    expect(manifest.devDependencies["@get-bb/plugin-sdk"]).toBe("0.6.132");
  });
});
