import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { PluginNavPanelProps, PluginSettingsSectionProps } from "@get-bb/plugin-sdk/app";
import { app, callsTo, DAY, handlers, mount, NOW, overview, unmountAll, type Handlers } from "./helpers";

afterEach(unmountAll);

async function controls(rpc: Partial<Handlers> = {}, settings = false) {
  const loaded = await app();
  if (settings) {
    const section = loaded.settingsSections.find((item) => item.id === "automations")!;
    return mount<PluginSettingsSectionProps>(section.component, {}, handlers(rpc));
  }
  return mount<PluginNavPanelProps>(loaded.navPanels[0]!.experimental_sidebar!, { subPath: "" }, handlers(rpc));
}

async function open(slot: Awaited<ReturnType<typeof controls>>) {
  fireEvent.click(await slot.findByRole("button", { name: "Pause automations" }));
  return screen.getByRole("dialog", { name: "Pause automations" });
}

describe("timed automation pause controls", () => {
  it("pauses for today until midnight in the browser's local timezone", async () => {
    const slot = await controls({ setAutomationPause: () => overview({ paused: true }) });
    const dialog = await open(slot);
    expect((within(dialog).getByRole("combobox", { name: "Pause for" }) as HTMLSelectElement).value).toBe("today");
    fireEvent.click(within(dialog).getByRole("button", { name: "Pause automations" }));
    const tomorrow = new Date(NOW);
    tomorrow.setHours(24, 0, 0, 0);
    await waitFor(() => expect(callsTo(slot, "setAutomationPause")).toEqual([{ mode: "until", until: tomorrow.getTime() }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it.each([["day", DAY], ["week", 7 * DAY]] as const)("offers a fixed %s duration in Automations settings", async (duration, ms) => {
    const slot = await controls({ setAutomationPause: () => overview({ paused: true }) }, true);
    const dialog = await open(slot);
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Pause for" }), { target: { value: duration } });
    const before = Date.now();
    fireEvent.click(within(dialog).getByRole("button", { name: "Pause automations" }));
    const after = Date.now();
    await waitFor(() => expect(callsTo(slot, "setAutomationPause")).toHaveLength(1));
    const input = callsTo(slot, "setAutomationPause")[0] as { mode: string; until: number };
    expect(input.mode).toBe("until");
    expect(input.until).toBeGreaterThanOrEqual(before + ms);
    expect(input.until).toBeLessThanOrEqual(after + ms);
  });

  it("accepts a custom return time and refuses an empty or past one", async () => {
    const slot = await controls({ setAutomationPause: () => overview({ paused: true }) });
    const dialog = await open(slot);
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Pause for" }), { target: { value: "custom" } });
    const submit = within(dialog).getByRole("button", { name: "Pause automations" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    const field = within(dialog).getByLabelText("Resume at");
    fireEvent.change(field, { target: { value: "2020-01-01T09:00" } });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(callsTo(slot, "setAutomationPause")).toEqual([]);
    fireEvent.change(field, { target: { value: "2099-12-01T09:00" } });
    fireEvent.click(submit);
    await waitFor(() => expect(callsTo(slot, "setAutomationPause")).toEqual([{ mode: "until", until: new Date("2099-12-01T09:00").getTime() }]));
  });

  it("keeps indefinite pause available", async () => {
    const slot = await controls({ setAutomationPause: () => overview({ paused: true }) });
    const dialog = await open(slot);
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Pause for" }), { target: { value: "indefinite" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Pause automations" }));
    await waitFor(() => expect(callsTo(slot, "setAutomationPause")).toEqual([{ mode: "indefinite" }]));
  });

  it("shows the resume time and lets you resume early or change the pause", async () => {
    const until = NOW + 7 * DAY;
    const slot = await controls({
      overview: () => overview({ paused: true, pauseUntil: until }),
      setAutomationPause: () => overview(),
    });
    const status = await slot.findByRole("status");
    expect(status.textContent).toContain("Resumes ");
    expect(status.querySelector("time")!.dateTime).toBe(new Date(until).toISOString());
    expect(slot.getByRole("button", { name: "Change pause" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Resume now" }));
    await waitFor(() => expect(callsTo(slot, "setAutomationPause")).toEqual([{ mode: "resume" }]));
  });

  it("keeps save failures visible and does not close the dialog", async () => {
    const slot = await controls({ setAutomationPause: () => { throw new Error("Could not save the pause"); } });
    const dialog = await open(slot);
    fireEvent.click(within(dialog).getByRole("button", { name: "Pause automations" }));
    expect(await within(dialog).findByText(/Could not save the pause/u)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Pause automations" })).toBeTruthy();
  });
});
