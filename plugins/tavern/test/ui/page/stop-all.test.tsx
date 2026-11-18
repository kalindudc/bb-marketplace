import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { settingsView } from "../../../src/ui/page/fixtures-insights";
import { stopAllContract, type StopAllState } from "../../../src/shared/stop-all";
import { settingsContract } from "../../../src/shared/settings";
import { StopAllControls, StopAllNotice } from "../../../src/ui/page/stop-all";

const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
const contract = { ...stopAllContract, ...settingsContract };
function mount(state: StopAllState = { state: "running", since: null, by: null, receipt: null }) {
  const stopAll = vi.fn(async () => ({ ...state, state: "stopped" as const }));
  const resumeAll = vi.fn(async () => ({ ...state, state: "running" as const }));
  const settingsUpdate = vi.fn(async () => ({ code: "stale", revision: 2, problems: [], settings: null }));
  const slot = renderSlot({ component: () => <><StopAllControls /><StopAllNotice /></> }, {}, {
    pluginId: "tavern", experimental_rpcContract: contract,
    rpc: { stopAllStatus: () => state, stopAll, resumeAll,
      settings: () => ({ ...settingsView, revision: 1 }), settingsUpdate } as never,
  });
  slots.push(slot);
  return { view: within(slot.container), stopAll, resumeAll, settingsUpdate };
}
describe("common room brake", () => {
  it("keeps Stop all available while stopped and discloses queued messages and unattested Resume", async () => {
    const f = mount({ state: "stopped", since: 1000000, by: { kind: "agent", threadId: "lead" }, receipt: null });
    const button = await f.view.findByRole("button", { name: "Stop all" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(f.view.getByText("A message queued together with Tavern's own work waits until you resume.")).toBeTruthy();
    expect(f.view.getByText("Tavern can't prove a person pressed Resume")).toBeTruthy();
    expect(f.view.queryByText(/Stopped by you since/)).toBeNull();
    fireEvent.click(button);
    fireEvent.click(f.view.getByRole("button", { name: "Stop everything now" }));
    await waitFor(() => expect(f.stopAll).toHaveBeenCalledTimes(1));
  });
  it("requires a second click with the exact scope, and Cancel stops nothing", async () => {
    const f = mount();
    const button = await f.view.findByRole("button", { name: "Stop all" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect(f.view.getByText("Stops every running Keeper and member turn now, and holds new ticks, briefs and hires until you resume. Quests, parties and machines stay as they are.")).toBeTruthy();
    expect(f.stopAll).not.toHaveBeenCalled();
    fireEvent.click(f.view.getByRole("button", { name: "Cancel" }));
    expect(f.stopAll).not.toHaveBeenCalled();
    fireEvent.click(button);
    fireEvent.click(f.view.getByRole("button", { name: "Stop everything now" }));
    await waitFor(() => expect(f.stopAll).toHaveBeenCalledTimes(1));
  });
  it("uses the same client settings update for Pause every Keeper and surfaces stale settings", async () => {
    const f = mount();
    const pause = await f.view.findByRole("button", { name: "Pause every Keeper" });
    await waitFor(() => expect((pause as HTMLButtonElement).disabled).toBe(false));
    expect(pause.title).toBe("Pauses new Keeper work; running turns finish.");
    fireEvent.click(pause);
    await waitFor(() => expect(f.settingsUpdate).toHaveBeenCalledWith(expect.objectContaining({ revision: 1, patch: { tavern: { paused: true } } })));
    expect(await f.view.findByText(/Settings changed somewhere else/)).toBeTruthy();
  });
  it("shows the receipt, errors and a client Resume without changing Pause", async () => {
    const f = mount({ state: "stopped", since: 1000000, by: { kind: "user" }, receipt: {
      startedAt: 1000000, completedAt: 1000100, elapsedMs: 100,
      stopped: 2, keepersStopped: 1, membersStopped: 1, failed: 1, stillStopping: 1, alreadyIdle: 1,
      entries: [{ threadId: "remote", role: "member", status: "failed", error: "machine unreachable", confirmedAt: null }],
    } });
    expect(await f.view.findByText(/Stopped by you since/)).toBeTruthy();
    expect(f.view.getByText(/1 Keeper and 1 member stopped/)).toBeTruthy();
    fireEvent.click(f.view.getByText("Stop receipt"));
    expect(f.view.getByText(/machine unreachable/)).toBeTruthy();
    fireEvent.click(f.view.getByRole("button", { name: "Resume Tavern" }));
    await waitFor(() => expect(f.resumeAll).toHaveBeenCalledTimes(1));
    expect(f.settingsUpdate).not.toHaveBeenCalled();
  });
});
