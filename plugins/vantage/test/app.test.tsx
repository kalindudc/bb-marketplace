import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginCommandContext, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { PANEL_ACTION_ID, createCommands } from "../src/commands";
import type { rpcContract } from "../src/contract";
import { overview } from "./fixtures";

afterEach(() => {
  document.body.replaceChildren();
});

describe("plugin app", () => {
  it("registers the flush Changes tab titled Vantage and a thread-header action", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.threadPanelActions).toHaveLength(1);
    expect(app.threadPanelActions[0]).toMatchObject({ id: "changes", title: "Vantage", icon: "FolderGit", layout: "flush" });
    expect(app.threadHeaderActions.map(({ id, title }) => ({ id, title }))).toEqual([{ id: "open", title: "Vantage" }]);
    expect(app.contentScripts).toHaveLength(0);
  });

  it("opens the panel from the header button", async () => {
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

  it("names Vantage in a tooltip on hover and keyboard focus, not a native title", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.threadHeaderActions[0]!, { threadId: "thr_1", projectId: "proj_1", isCompactViewport: false }, {
      pluginId: "vantage", openThreadPanel: () => true,
    });
    const button = within(slot.container).getByRole("button", { name: "Open Vantage" });
    expect(button.hasAttribute("title")).toBe(false);
    fireEvent.pointerMove(button, { pointerType: "mouse" });
    expect((await screen.findByRole("tooltip")).textContent).toBe(TOOLTIP);
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    slot.lifecycle.unmount();

    const again = renderSlot(app.threadHeaderActions[0]!, { threadId: "thr_1", projectId: "proj_1", isCompactViewport: false }, {
      pluginId: "vantage", openThreadPanel: () => true,
    });
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => within(again.container).getByRole("button", { name: "Open Vantage" }).focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe(TOOLTIP);
    again.lifecycle.unmount();
  });
});

const TOOLTIP = "Vantage: what this thread and its child threads changed, by worktree and repository";

describe("full-screen page", () => {
  it("registers a Vantage entry for bb's left navigation", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.navPanels.map(({ id, title, icon, path }) => ({ id, title, icon, path }))).toEqual([
      { id: "vantage", title: "Vantage", icon: "FolderGit", path: "vantage" },
    ]);
  });

  it("opens that thread's tree on the page from the side panel's Open full screen button, and names it in a tooltip", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot<PluginThreadPanelProps, typeof rpcContract>(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      pluginId: "vantage",
      rpc: { overview: () => overview(), patch: () => ({ patch: "", truncated: false, binary: false }), recordedEdits: () => ({ edits: [] }), commitFiles: () => ({ files: [] }) },
      sdk: { subscribe: (() => () => {}) as never },
      sidebarThreads: { status: "ready", threads: [] }, sidebarPullRequests: {}, threadActions: (() => []) as never,
    });
    const button = within(slot.container).getByRole("button", { name: "Open full screen" });
    expect(button.querySelector("[data-icon='Maximize2']")).not.toBeNull();
    expect(button.hasAttribute("title")).toBe(false);
    fireEvent.click(button);
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "vantage", options: { subPath: "tree/thr_1" } }]);
    fireEvent.pointerMove(button, { pointerType: "mouse" });
    expect((await screen.findByRole("tooltip")).textContent).toBe("Open Vantage full screen for this thread tree");
    slot.lifecycle.unmount();
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
    expect(PANEL_ACTION_ID).toBe("changes");
  });

  it("is available only where a thread is in view", () => {
    const open = createCommands()[0]!;
    expect(open.isAvailable?.(context({ threadId: null, projectId: null }))).toBe(false);
    expect(open.isAvailable?.(context())).toBe(true);
  });

  it("opens the Changes panel", async () => {
    const open = createCommands()[0]!;
    const ready = context();
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
      skills: ["./skills/vantage"],
    });
    expect(manifest.bb.branding.experimental_icons).toBeUndefined();
    expect(manifest.engines).toEqual({ bb: ">=0.46", bbPluginSdk: ">=0.6.49" });
  });

  it("keeps the SDK a dev dependency and bundles zod", () => {
    expect(manifest.dependencies).toEqual({ zod: "^4.3.6" });
    expect(manifest.devDependencies["@get-bb/plugin-sdk"]).toBe("0.6.49");
  });
});
