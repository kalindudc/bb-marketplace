// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixtureDetail, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { QuestMapCard } from "../../../src/ui/thread/cards";
import { motion } from "../../../src/ui/kit/motion";
import { installAnimations } from "../kit/motion-fakes";

let fx: ReturnType<typeof installAnimations>;
beforeEach(() => { motion.reset(); motion.now = () => 1_000_000; fx = installAnimations({ "mo-seal": 1200 }); localStorage.clear(); });
afterEach(() => { cleanup(); fx.uninstall(); motion.reset(); });

const sealedDetail = { ...fixtureDetail, quest: { ...fixtureDetail.quest, greenlitVersion: 1 } };
let seal: (() => void) | null = null;
function Card({ start }: { start: typeof fixtureDetail }) {
  const [detail, setDetail] = useState(start);
  seal = () => setDetail(sealedDetail);
  return <QuestMapCard detail={detail} version={1} />;
}
async function mount(start: typeof fixtureDetail) {
  await loadPluginApp(definePluginApp(registerThreadSurfaces));
  const slot = renderSlot({ component: () => <Card start={start} /> } as never, {}, { composer: { scope: { kind: "thread", threadId: "keeper-1" } }, rpc: { registry: () => fixtureRegistry, answerAsk: () => ({ ok: true }) } });
  await waitFor(() => expect(slot.container.querySelector("[data-part='QuestMapCard']")).not.toBeNull());
  return slot;
}
const card = (slot: { container: HTMLElement }) => slot.container.querySelector<HTMLElement>("[data-part='QuestMapCard']")!;

describe("the two moments play once", () => {
  it("plays the seal the first time this device sees the card sealed, and not on a remount", async () => {
    const first = await mount(sealedDetail);
    expect([...motion.cues].map(c => c.kind)).toEqual(["party forms"]);
    expect(card(first).classList.contains("mo-seal")).toBe(true);
    first.lifecycle.unmount();
    motion.reset(); motion.now = () => 1_000_000;
    const again = await mount(sealedDetail);
    expect(motion.cues.size).toBe(0);
    expect(card(again).classList.contains("mo-seal")).toBe(false);
    again.lifecycle.unmount();
  });

  it("plays when the seal is pressed here", async () => {
    const slot = await mount(fixtureDetail);
    expect(motion.cues.size).toBe(0);
    act(() => seal!());
    await waitFor(() => expect(card(slot).classList.contains("mo-seal")).toBe(true));
    slot.lifecycle.unmount();
  });

  it("finishes on Escape inside the card", async () => {
    const slot = await mount(sealedDetail);
    const anim = fx.all.find(a => a.className === "mo-seal")!;
    fireEvent.keyDown(card(slot), { key: "Escape" });
    expect(anim.playState).toBe("finished");
    expect(card(slot).classList.contains("mo-seal")).toBe(false);
    slot.lifecycle.unmount();
  });

  it("never swallows the key: Enter on Form the party still greenlights in the same press", async () => {
    const slot = await mount(fixtureDetail);
    let reached = false;
    const listen = () => { reached = true; };
    document.addEventListener("keydown", listen);
    const button = await slot.findByRole("button", { name: "Form the party (greenlight)" });
    expect(fireEvent.keyDown(button, { key: "Enter" })).toBe(true); // not defaultPrevented
    expect(reached).toBe(true); // not stopped on the way up
    fireEvent.click(button);
    await waitFor(() => expect(slot.inspection.rpcCalls.some((c: { method: string }) => c.method === "answerAsk")).toBe(true));
    document.removeEventListener("keydown", listen);
    slot.lifecycle.unmount();
  });
});
