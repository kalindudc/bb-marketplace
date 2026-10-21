import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import type { PluginCommandContext } from "@get-bb/plugin-sdk/app";
import {
  LOG_ACTION_ID, consumePanelFocus, createCommands, onPanelFocusRequest, requestPanelFocus,
} from "../src/commands";
import { EXPANDED_STORAGE_KEY, createPreference } from "../src/preference";
import type { SessionLogSdk } from "../src/types";
import { FakeResizeObserver, commandRow, timelineResponse, userRow } from "./fixtures";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  FakeResizeObserver.instances = [];
  window.localStorage.clear();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("Session Log commands", () => {
  it("registers the open shortcut, only where a thread exists", () => {
    const commands = createCommands(createPreference(window));
    expect(commands.map((command) => command.id)).toEqual(["open", "toggle-expanded"]);
    const open = commands[0]!;
    expect(open.title).toBe("Session Log: Open for this thread");
    expect(open.defaultShortcut).toEqual({ key: "l", mod: true, shift: true });
    expect(open.isAvailable?.({ threadId: null, projectId: null, openPanel: vi.fn() })).toBe(false);
    expect(open.isAvailable?.({ threadId: "thr_1", projectId: "proj_1", openPanel: vi.fn() })).toBe(true);
    expect(commands[1]?.defaultShortcut).toBeUndefined();
  });

  it("opens the panel and requests focus only when the host accepts it", async () => {
    const open = createCommands(createPreference(window))[0]!;
    const accepted: PluginCommandContext = {
      threadId: "thr_open", projectId: "proj_1", openPanel: vi.fn(() => true),
    };
    await open.run(accepted);
    expect(accepted.openPanel).toHaveBeenCalledWith({ actionId: LOG_ACTION_ID });
    expect(consumePanelFocus("thr_open")).toBe(true);
    expect(consumePanelFocus("thr_open")).toBe(false);

    const declined: PluginCommandContext = {
      threadId: "thr_declined", projectId: "proj_1", openPanel: vi.fn(() => false),
    };
    await open.run(declined);
    expect(consumePanelFocus("thr_declined")).toBe(false);
    await open.run({ threadId: null, projectId: null, openPanel: declined.openPanel });
    expect(declined.openPanel).toHaveBeenCalledTimes(1);
  });

  it("hands the latest focus request to exactly one matching panel and notifies listeners", () => {
    const listener = vi.fn();
    const unsubscribe = onPanelFocusRequest(listener);
    requestPanelFocus("thr_first");
    requestPanelFocus("thr_second");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(consumePanelFocus("thr_first")).toBe(false);
    expect(consumePanelFocus("thr_second")).toBe(true);
    expect(consumePanelFocus("thr_second")).toBe(false);
    unsubscribe();
    requestPanelFocus("thr_third");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(consumePanelFocus("thr_third")).toBe(true);
  });

  it("toggles expanded view and announces the mode", async () => {
    const preference = createPreference(window);
    const toggle = createCommands(preference)[1]!;
    const context: PluginCommandContext = { threadId: null, projectId: null, openPanel: vi.fn() };
    await toggle.run(context);
    expect(preference.isExpanded()).toBe(true);
    expect(window.localStorage.getItem(EXPANDED_STORAGE_KEY)).toBe("true");
    expect(toast).toHaveBeenCalledWith("Session log: everything expanded");
    await toggle.run(context);
    expect(preference.isExpanded()).toBe(false);
    expect(toast).toHaveBeenCalledWith("Session log: previews");
  });
});

describe("plugin app", () => {
  const headerProps = { threadId: "thr_header", projectId: "proj_1", isCompactViewport: false };

  it("registers the flush log panel and its thread-header action without a content script", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.threadPanelActions).toHaveLength(1);
    expect(app.threadPanelActions[0]).toMatchObject({
      id: "log", title: "Session log", icon: "session-log/logs", layout: "flush",
    });
    expect(app.threadHeaderActions.map(({ id }) => id)).toEqual(["open-log"]);
    expect(app.contentScripts).toHaveLength(0);
  });

  it("opens the panel from the header button and hands focus to its panel", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.threadHeaderActions[0]!, headerProps, {
      pluginId: "session-log", openThreadPanel: () => true,
    });
    fireEvent.click(within(slot.container).getByRole("button", { name: "Open session log" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "openThreadPanel", options: { actionId: "log" } },
    ]);
    expect(consumePanelFocus("thr_header")).toBe(true);
    slot.lifecycle.unmount();
  });

  it("leaves the phone header to bb, since the panel launcher already opens the log", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.threadHeaderActions[0]!, { ...headerProps, isCompactViewport: true }, {
      pluginId: "session-log", openThreadPanel: () => true,
    });
    expect(within(slot.container).queryByRole("button")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("does not request focus if the host refuses to open the panel", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.threadHeaderActions[0]!, headerProps, {
      pluginId: "session-log", openThreadPanel: () => false,
    });
    fireEvent.click(within(slot.container).getByRole("button", { name: "Open session log" }));
    expect(consumePanelFocus("thr_header")).toBe(false);
    slot.lifecycle.unmount();
  });

  it("renders the registered panel with the SDK and shared expanded preference", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const output = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
    const timeline = vi.fn(async () => timelineResponse([userRow("request"), commandRow("cmd", { output })]));
    const sdk = {
      threads: {
        timeline,
        get: async () => ({ projectId: "proj_personal" }) as Awaited<ReturnType<SessionLogSdk["threads"]["get"]>>,
        events: { list: async () => [] },
      },
      plugins: { getSettings: async () => ({ ok: true, schema: {}, values: {} }) },
      subscribe: () => () => {},
    } as unknown as SessionLogSdk;
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      pluginId: "session-log", sdk,
    });
    await waitFor(() => expect(slot.container.querySelector('[data-entry-id="cmd"]')).toBeTruthy());
    expect(timeline).toHaveBeenCalledWith({ threadId: "thr_1", includeNestedRows: "true" });
    expect(within(slot.container).getByRole("link", { name: "Show in chat" }).getAttribute("href"))
      .toBe("/threads/thr_1#msg=10");
    const row = slot.container.querySelector('[data-entry-id="cmd"]') as HTMLElement;
    const toggle = row.querySelector("button[aria-expanded]") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    window.localStorage.setItem(EXPANDED_STORAGE_KEY, "true");
    fireEvent(window, new StorageEvent("storage", { key: EXPANDED_STORAGE_KEY, newValue: "true" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    slot.lifecycle.unmount();
  });
});

describe("manifest", () => {
  const root = join(__dirname, "..");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  it("brands the plugin with the Logs glyph and declares it for the header and tab", () => {
    expect(manifest.bb.branding).toEqual({ icon: "./icons/logs.svg", experimental_icons: { logs: "./icons/logs.svg" } });
    const entry = JSON.parse(readFileSync(join(root, "../../entries/session-log.json"), "utf8"));
    expect(entry.icon).toEqual({ url: "plugins/session-log/icons/logs.svg" });
  });

  it("ships a monochrome 24px SVG that bb's icon validator accepts", () => {
    const path = join(root, "icons/logs.svg");
    expect(existsSync(path)).toBe(true);
    const svg = readFileSync(path, "utf8");
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24"/);
    expect(svg).not.toMatch(/<!DOCTYPE|<\?xml|<(script|style|image|foreignObject|a)\b|\son[a-z]+=|url\(|href=/i);
    expect(Buffer.byteLength(svg)).toBeLessThan(32 * 1024);
  });
});
