import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginCommandContext } from "@get-bb/plugin-sdk/app";
import { PANEL_ACTION_ID, createCommands } from "../src/commands";
import { useVantageBadge } from "../src/notify";
import { sidebarThread } from "./fixtures";
import { disposeSessions } from "../src/session";

afterEach(() => {
  disposeSessions();
  document.body.replaceChildren();
});

describe("plugin app", () => {
  it("registers the page with its sidebar, title bar, page title and badge, and an Agent tab beside it", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.navPanels).toHaveLength(1);
    const page = app.navPanels[0]!;
    expect(page).toMatchObject({ id: "vantage", title: "Vantage", icon: "FolderGit", path: "vantage" });
    expect(page.experimental_sidebar).toBeTypeOf("function");
    expect(page.headerContent).toBeTypeOf("function");
    expect(page.experimental_usePageTitle).toBeTypeOf("function");
    expect(page.experimental_useBadge).toBeTypeOf("function");
    expect(app.tabs.map(({ id, context, availability }) => ({ id, context, availability }))).toEqual([
      { id: "agent", context: { kind: "nav-panel", panelId: "vantage" }, availability: "fixed" },
      { id: "changes", context: { kind: "thread" }, availability: "action" },
    ]);
  });

  it("keeps the thread tab's id from the retired panel action, so a tab left open keeps working", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.tabs.find((tab) => tab.context.kind === "thread")).toMatchObject({ id: PANEL_ACTION_ID, title: "Vantage", icon: "FolderGit", layout: "flush" });
  });

  it("adds a composer segment, an Info section, one thread menu entry and the toasts", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.threadContextSegments.map(({ id, group }) => ({ id, group }))).toEqual([{ id: "worktrees", group: "3_git" }]);
    expect(app.threadContextSegments[0]!.details).toBeTypeOf("function");
    expect(app.threadContextSegments[0]!.useVisible).toBeTypeOf("function");
    expect(app.threadInfoSections.map(({ id, group }) => ({ id, group }))).toEqual([{ id: "worktrees", group: "2_changes" }]);
    expect(app.threadActions.map(({ id, group }) => ({ id, group }))).toEqual([{ id: "review", group: "1_open" }]);
    expect(app.appOverlays.map(({ id }) => id)).toEqual(["attention"]);
    expect(app.threadHeaderActions).toEqual([]);
    expect(app.threadContextCardSections.map(({ id, title, group, order }) => ({ id, title, group, order }))).toEqual([
      { id: "worktrees", title: "Worktrees", group: "1_related", order: 5 },
    ]);
    expect(app.threadRowMetadata.map(({ id, order }) => ({ id, order }))).toEqual([{ id: "changes", order: 50 }]);
    expect(app.threadRowMetadata[0]!.useData).toBeTypeOf("function");
    expect(app.contentScripts).toHaveLength(0);
  });
});

describe("commands", () => {
  const context = (overrides: Partial<PluginCommandContext> = {}): PluginCommandContext => ({
    threadId: "thr_1", projectId: "proj_1",
    experimental_panel: { openTab: vi.fn(() => true), toggleTab: vi.fn(() => true), selectTab: vi.fn(() => true), closeTab: vi.fn(() => true), close: vi.fn(() => true), getTabs: vi.fn() },
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
    expect(ready.experimental_panel.openTab).toHaveBeenCalledWith({ tab: { id: "changes", context: { kind: "thread" }, availability: "action" } });
  });
});

describe("manifest", () => {
  const root = join(__dirname, "..");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  it("declares the server, app, host entry, skill and the FolderGit brand icon", () => {
    expect(manifest.name).toBe("bb-plugin-vantage");
    expect(manifest.bb).toMatchObject({
      name: "Vantage", branding: { icon: "FolderGit" }, server: "./server.ts", app: "./app.tsx", host: "./host.ts",
      skills: ["./skills"],
    });
    expect(manifest.engines).toEqual({ bb: ">=0.48.1", bbPluginSdk: ">=0.6.104" });
  });

  it("keeps the SDK a dev dependency pinned to the version bb 0.48.1 ships, and bundles zod", () => {
    expect(manifest.dependencies).toEqual({ zod: "^4.3.6" });
    expect(manifest.devDependencies["@get-bb/plugin-sdk"]).toBe("0.6.104");
  });
});

describe("the Vantage icon's badge", () => {
  const threads = [
    sidebarThread({ id: "thr_a", displayTitle: "Asks", indicator: "waiting-for-input" }),
    sidebarThread({ id: "thr_b", displayTitle: "Broke", indicator: "unread-error" }),
    sidebarThread({ id: "thr_c", displayTitle: "Busy", indicator: "runtime" }),
  ];
  function Probe() {
    return <output>{JSON.stringify(useVantageBadge())}</output>;
  }
  const badge = (settings?: Record<string, boolean>) => {
    const slot = renderSlot({ component: Probe }, {}, { pluginId: "vantage", sidebarThreads: { status: "ready", threads }, ...(settings ? { settings } : {}) });
    const value = JSON.parse(slot.container.querySelector("output")!.textContent!);
    slot.lifecycle.unmount();
    return value;
  };

  it("counts every thread that waits for you or failed when the badge setting is on", () => {
    expect(badge({ badge: true, toasts: false })).toEqual({ count: 2, tone: "warning", label: "2 threads need you" });
  });

  it("shows nothing when the setting is off or not loaded yet", () => {
    expect(badge({ badge: false, toasts: false })).toBeNull();
    expect(badge()).toBeNull();
  });
});
