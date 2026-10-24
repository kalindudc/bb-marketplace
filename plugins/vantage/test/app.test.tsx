import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginCommandContext } from "@get-bb/plugin-sdk/app";
import { PANEL_ACTION_ID, createCommands } from "../src/commands";
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

  it("adds a composer segment, an Info section, two thread menu entries and the toasts for watched threads", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.threadContextSegments.map(({ id, group }) => ({ id, group }))).toEqual([{ id: "worktrees", group: "3_git" }]);
    expect(app.threadContextSegments[0]!.details).toBeTypeOf("function");
    expect(app.threadContextSegments[0]!.useVisible).toBeTypeOf("function");
    expect(app.threadInfoSections.map(({ id, group }) => ({ id, group }))).toEqual([{ id: "worktrees", group: "2_changes" }]);
    expect(app.threadActions.map(({ id, group }) => ({ id, group }))).toEqual([{ id: "review", group: "1_open" }, { id: "prefs", group: "3_settings" }]);
    expect(app.appOverlays.map(({ id }) => id)).toEqual(["attention"]);
    expect(app.threadHeaderActions.map(({ id, title }) => ({ id, title }))).toEqual([{ id: "open", title: "Vantage" }]);
    expect(app.contentScripts).toHaveLength(0);
  });

  it("opens the thread tab from the header button", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.threadHeaderActions[0]!, { threadId: "thr_1", projectId: "proj_1", isCompactViewport: false }, {
      pluginId: "vantage", openThreadPanel: () => true,
    });
    const button = within(slot.container).getByRole("button", { name: "Open Vantage" });
    expect(button.querySelector("[data-icon='FolderGit']")).not.toBeNull();
    fireEvent.click(button);
    expect(slot.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "changes" } }]);
    slot.lifecycle.unmount();
  });

  it("leaves the phone header to bb, since the panel launcher already opens the tab", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.threadHeaderActions[0]!, { threadId: "thr_1", projectId: "proj_1", isCompactViewport: true }, {
      pluginId: "vantage", openThreadPanel: () => true,
    });
    expect(within(slot.container).queryByRole("button")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("names Vantage in a tooltip on hover and keyboard focus, not a native title", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.threadHeaderActions[0]!, { threadId: "thr_1", projectId: "proj_1", isCompactViewport: false }, {
      pluginId: "vantage", openThreadPanel: () => true,
    });
    const button = within(slot.container).getByRole("button", { name: "Open Vantage" });
    expect(button.hasAttribute("title")).toBe(false);
    fireEvent.pointerMove(button, { pointerType: "mouse" });
    expect((await screen.findByRole("tooltip")).textContent).toBe("Vantage: what this thread and its child threads changed");
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    slot.lifecycle.unmount();

    const again = renderSlot(app.threadHeaderActions[0]!, { threadId: "thr_1", projectId: "proj_1", isCompactViewport: false }, {
      pluginId: "vantage", openThreadPanel: () => true,
    });
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => within(again.container).getByRole("button", { name: "Open Vantage" }).focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe("Vantage: what this thread and its child threads changed");
    again.lifecycle.unmount();
  });
});

describe("commands", () => {
  const context = (overrides: Partial<PluginCommandContext> = {}): PluginCommandContext => ({
    threadId: "thr_1", projectId: "proj_1", openPanel: vi.fn(() => true), ...overrides,
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
    expect(ready.openPanel).toHaveBeenCalledWith({ actionId: "changes" });
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
    expect(manifest.engines).toEqual({ bb: ">=0.47", bbPluginSdk: ">=0.6.75" });
  });

  it("keeps the SDK a dev dependency pinned to the version bb 0.47 ships, and bundles zod", () => {
    expect(manifest.dependencies).toEqual({ zod: "^4.3.6" });
    expect(manifest.devDependencies["@get-bb/plugin-sdk"]).toBe("0.6.75");
  });
});
