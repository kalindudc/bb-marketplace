import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { ENABLED_STORAGE_KEY } from "../src/preference";
import { flush, thoughtRow } from "./fake-timeline";

vi.mock("sonner", () => ({ toast: vi.fn() }));

afterEach(() => {
  window.localStorage.clear();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const headerProps = {
  threadId: "thr_1",
  projectId: "proj_1",
  isCompactViewport: false,
};

describe("plugin app", () => {
  it("registers the content script and the thread header toggle", async () => {
    const app = await loadPluginApp(() => import("../app"));

    expect(app.contentScripts.map((script) => script.id)).toEqual([
      "follow-thinking",
    ]);
    expect(app.threadHeaderActions.map((action) => action.id)).toEqual([
      "toggle",
    ]);
  });

  it("expands thinking rows once the content script mounts and stops on dispose", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const first = thoughtRow("row-1");
    document.body.append(first.element);

    const scripts = await mountPluginContentScripts(app, {
      pluginId: "follow-thinking",
    });
    expect(first.isExpanded()).toBe(true);

    await scripts.lifecycle.dispose();
    const second = thoughtRow("row-2");
    document.body.append(second.element);
    await flush();

    expect(scripts.inspection.disposed).toBe(true);
    expect(second.isExpanded()).toBe(false);
  });

  it("shows whether it is on in the thread header and toggles on click", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.threadHeaderActions[0]!, headerProps, {
      pluginId: "follow-thinking",
    });
    const button = slot.getByRole("button", { name: "Follow thinking" });

    expect(button.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button);

    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(window.localStorage.getItem(ENABLED_STORAGE_KEY)).toBe("false");
    slot.lifecycle.unmount();
  });

  it("leaves the phone header to bb", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.threadHeaderActions[0]!, { ...headerProps, isCompactViewport: true }, {
      pluginId: "follow-thinking",
    });
    expect(slot.queryByRole("button")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("offers the toggle in the thread actions menu, where phones reach it", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.threadActions.map(({ id, title, icon, group }) => ({ id, title, icon, group }))).toEqual([
      { id: "toggle", title: "Follow thinking", icon: "AiBrain01", group: "3_settings" },
    ]);
    const registration = app.threadActions[0]!;
    const enabled = renderHook(() => registration.useData!({ threadIds: ["thr_1"] }));
    const item = () => registration.item({
      thread: { id: "thr_1" } as never, data: enabled.result.current, sdk: {} as never, navigate: {} as never,
    })!;

    expect(item()).toMatchObject({ label: "Follow thinking", detail: "On", icon: "AiBrain01" });
    act(() => void item().run({ requestRename: vi.fn() }));
    expect(window.localStorage.getItem(ENABLED_STORAGE_KEY)).toBe("false");
    expect(toast).toHaveBeenCalledWith("Follow thinking is off");
    expect(item()).toMatchObject({ detail: "Off" });
    enabled.unmount();
  });
});
