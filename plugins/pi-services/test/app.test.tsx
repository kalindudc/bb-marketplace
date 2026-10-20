import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const headerProps = { threadId: "thr_1", projectId: "proj_1", isCompactViewport: false };

describe("plugin app", () => {
  it("registers the header button, the thread action and the settings section", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.threadHeaderActions.map(({ id }) => id)).toEqual(["regenerate-title"]);
    expect(app.threadActions.map(({ id, title, icon, group }) => ({ id, title, icon, group }))).toEqual([
      { id: "regenerate-title", title: "Regenerate title with pi", icon: "RefreshCw", group: "2_organize" },
    ]);
    expect(app.settingsSections.map(({ id }) => id)).toEqual(["pi-services"]);
  });

  it("regenerates the title from the header button", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.threadHeaderActions[0]!, headerProps, {
      pluginId: "pi-services", rpc: { regenerateTitle: () => ({ title: "New title" }) },
    });
    fireEvent.click(within(slot.container).getByRole("button", { name: "Regenerate thread title with pi" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toEqual([
      { method: "regenerateTitle", input: { threadId: "thr_1" } },
    ]));
    slot.lifecycle.unmount();
  });

  it("leaves the phone header to bb", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.threadHeaderActions[0]!, { ...headerProps, isCompactViewport: true }, {
      pluginId: "pi-services",
    });
    expect(within(slot.container).queryByRole("button")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("regenerates the title from the thread actions menu, where phones reach it", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const registration = app.threadActions[0]!;
    const call = vi.fn(async () => ({ title: "New title" }));
    const action = registration.item({
      thread: { id: "thr_2" } as never, data: { call }, sdk: {} as never, navigate: {} as never,
    })!;
    expect(action).toMatchObject({ label: "Regenerate title with pi", icon: "RefreshCw" });
    await action.run({ requestRename: vi.fn() });
    expect(call).toHaveBeenCalledWith("regenerateTitle", { threadId: "thr_2" });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("says so when pi cannot regenerate the title", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const call = vi.fn(async () => {
      throw new Error("pi exited 1");
    });
    const action = app.threadActions[0]!.item({
      thread: { id: "thr_2" } as never, data: { call }, sdk: {} as never, navigate: {} as never,
    })!;
    await action.run({ requestRename: vi.fn() });
    expect(toast.error).toHaveBeenCalledWith("Could not regenerate the title with pi", { description: "pi exited 1" });
  });
});
