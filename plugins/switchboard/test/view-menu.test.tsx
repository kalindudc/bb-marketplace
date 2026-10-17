import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ViewMenu, ViewSwitch } from "../src/view-menu";
import { useUpdateSettings } from "../src/use-update-settings";
import { useSwitchboardSettings } from "../src/use-settings";
import { DEFAULT_SETTINGS } from "../src/settings";

const { error } = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("view controls", () => {
  it("switches sections and status lanes with accessible labels", () => {
    const onChange = vi.fn();
    const slot = renderSlot({ component: ViewSwitch }, { view: "sections", onChange });
    expect(screen.getByRole("button", { name: "Sections view" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Status lanes view" }));
    expect(onChange).toHaveBeenCalledWith("status");
    slot.unmount();
  });

  it("shows density, colour, toggles and idle-fade choices in View options", () => {
    const onChange = vi.fn();
    const slot = renderSlot({ component: ViewMenu }, { settings: DEFAULT_SETTINGS, onChange });
    fireEvent.pointerDown(screen.getByRole("button", { name: "View options" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" });
    expect(screen.getByRole("menuitemradio", { name: "Status lanes" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Two lines" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Tint" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Needs-you shelf" }));
    expect(onChange).toHaveBeenCalledWith({ needsYouShelf: true });
    slot.unmount();
  });

  it("updates settings optimistically then shows an error when a write fails", async () => {
    const updateSettings = vi.fn().mockRejectedValue(new Error("offline"));
    function Test() {
      const settings = useSwitchboardSettings();
      const change = useUpdateSettings();
      return <><output>{settings.view}</output><button onClick={() => change({ view: "status" })}>Change</button></>;
    }
    const slot = renderSlot({ component: Test }, {}, { pluginId: "switchboard", sdk: { plugins: {
      getSettings: async () => ({ ok: true, schema: {}, values: {} }), updateSettings,
    } } });
    await waitFor(() => expect(screen.getByText("sections")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByText("status")).toBeTruthy();
    expect(updateSettings).toHaveBeenCalledWith({ pluginId: "switchboard", values: { view: "status" } });
    await waitFor(() => expect(error).toHaveBeenCalledWith("Switchboard could not change that setting"));
    slot.unmount();
  });
});
