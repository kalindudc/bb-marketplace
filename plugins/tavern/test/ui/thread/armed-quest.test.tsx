// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { armNewQuest, disarmNewQuest, ARMED_TTL_MS } from "../../../src/ui/kit";
import { fixtureDecor, fixtureRegistry } from "../../../src/ui/thread/fixtures";

afterEach(cleanup);
beforeEach(() => window.localStorage.clear());

async function keeperRow(opts: { hidden?: boolean; text?: string; member?: boolean } = {}) {
  const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
  const banner = app.composerCustomizations.find(c => c.id === "tavern-thread")!.banners![0]!;
  const decor = opts.member
    ? { ...fixtureDecor, keeperView: null, member: { ...fixtureDecor.member!, role: "member" as const } }
    : { ...fixtureDecor, hidden: opts.hidden ?? false };
  return renderSlot(banner, {}, { composer: { scope: { kind: "thread", threadId: "keeper-1" }, text: opts.text ?? "" }, rpc: { decor: () => decor, registry: () => fixtureRegistry } });
}
const armedLine = (root: HTMLElement) => root.querySelector(".tw-armed");

describe("the armed new-quest line in a Keeper's thread", () => {
  it("is absent until the page arms this thread", async () => {
    const slot = await keeperRow();
    await slot.findByRole("region", { name: "Tavern widget" });
    expect(armedLine(slot.container)).toBeNull();
  });

  it("sends the draft as a new board quest, then ends the arm", async () => {
    armNewQuest("keeper-1");
    const slot = await keeperRow({ text: "Move Vault to envoy-direct" });
    const send = await slot.findByRole("button", { name: "Send as a new quest" });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.click(send); });
    await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
    expect(slot.inspection.composer.submits[0]).toMatchObject({ experimental_data: { route: "new-quest" } });
    await waitFor(() => expect(armedLine(slot.container)).toBeNull());
    expect(window.localStorage.getItem("tavern:armed-quest:v1")).toBeNull();
  });

  it("waits for a draft: Send is disabled and says why while the composer is empty", async () => {
    armNewQuest("keeper-1");
    const slot = await keeperRow();
    const send = (await slot.findByRole("button", { name: "Send as a new quest" })) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.title).toMatch(/Type the goal first/);
  });

  it("Cancel ends the arm and leaves the draft a normal message", async () => {
    armNewQuest("keeper-1");
    const slot = await keeperRow({ text: "just a question" });
    fireEvent.click(await slot.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(armedLine(slot.container)).toBeNull());
    expect(slot.inspection.composer.submits).toHaveLength(0);
  });

  it("shows the armed line alone in a row the user hid, and nothing once it ends", async () => {
    armNewQuest("keeper-1");
    const slot = await keeperRow({ hidden: true });
    await slot.findByRole("button", { name: "Send as a new quest" });
    expect(slot.container.querySelector(".tw-row")).toBeNull();
    act(() => disarmNewQuest("keeper-1"));
    await waitFor(() => expect(slot.container.querySelector(".twidget")).toBeNull());
  });

  it("ignores a stale record, another thread's record and a member thread", async () => {
    window.localStorage.setItem("tavern:armed-quest:v1", JSON.stringify({ threadId: "keeper-1", armedAt: Date.now() - ARMED_TTL_MS - 1000 }));
    const stale = await keeperRow();
    await stale.findByRole("region", { name: "Tavern widget" });
    expect(armedLine(stale.container)).toBeNull();
    stale.lifecycle.unmount();

    armNewQuest("keeper-1");
    armNewQuest("keeper-2");
    const other = await keeperRow();
    await other.findByRole("region", { name: "Tavern widget" });
    expect(armedLine(other.container)).toBeNull();
    other.lifecycle.unmount();

    armNewQuest("keeper-1");
    const member = await keeperRow({ member: true });
    await waitFor(() => expect(member.container.querySelector(".twidget")).not.toBeNull());
    expect(armedLine(member.container)).toBeNull();
  });

  it("disarming one thread never clears a newer arm of another", () => {
    armNewQuest("keeper-2");
    disarmNewQuest("keeper-1");
    expect(JSON.parse(window.localStorage.getItem("tavern:armed-quest:v1")!).threadId).toBe("keeper-2");
  });
});
