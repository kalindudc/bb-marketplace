// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { useState } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { PartyPicture } from "../../../src/ui/kit";
import { motion } from "../../../src/ui/kit/motion";
import { liveRoom, registry } from "../page/scenes";
import { flush, installAnimations } from "./motion-fakes";

let fx: ReturnType<typeof installAnimations>;
beforeEach(() => { motion.reset(); motion.now = () => 1_000_000; fx = installAnimations({ "mo-walk": 2800 }); });
afterEach(() => { cleanup(); fx.uninstall(); motion.reset(); });

const base = liveRoom.keepers[0]!.boardQuests.flatMap(q => q.members)[0]!;
let move: ((state: typeof base.state) => void) | null = null;
function Party() {
  const [m, setM] = useState({ ...base, engagement: "active" as const, state: "idle" as typeof base.state });
  move = state => setM(prev => ({ ...prev, state }));
  return <div className="tavern"><PartyPicture members={[m]} registry={registry} /></div>;
}
async function mount() {
  const app = await loadPluginApp(definePluginApp(a => { a.slots.navPanel({ id: "probe", title: "Probe", path: "probe", icon: "list", component: Party } as never); }));
  return renderSlot(app.navPanels[0]!, { subPath: "" }, {});
}

describe("PartyPicture", () => {
  it("moves a member who sets out onto the road, then takes one step, and is still on first render", async () => {
    const slot = await mount();
    expect(motion.cues.size).toBe(0);
    act(() => move!("working"));
    expect([...motion.cues].map(c => c.kind)).toEqual(["sets out"]);
    fx.tick(450); await flush();
    await waitFor(() => expect([...motion.cues].map(c => c.kind)).toEqual(["road step"]));
    expect(slot.container.querySelector(".pm.mo-walk")).not.toBeNull();
    fx.tick(2800); await flush();
    await waitFor(() => expect(slot.container.querySelector(".pm.mo-walk")).toBeNull());
    slot.lifecycle.unmount();
  });

  it("does not re-read party geometry for equivalent member data but measures a road transition", async () => {
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect");
    try {
      const slot = await mount();
      try {
        rect.mockClear();
        act(() => move!("idle"));
        const unrelated = rect.mock.calls.length;
        rect.mockClear();
        act(() => move!("working"));
        const transition = rect.mock.calls.length;
        console.log("L1 party reads", JSON.stringify({ unrelated, transition }));
        expect(unrelated).toBe(0);
        expect(transition).toBeGreaterThan(0);
        expect([...motion.cues].map(c => c.kind)).toEqual(["sets out"]);
      } finally { slot.lifecycle.unmount(); }
    } finally { rect.mockRestore(); }
  });

  it("slides a member onto the road after the page scrolls without a layout change", async () => {
    let scroll = 0;
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const row = (this as HTMLElement).dataset.place;
      const top = 100 - scroll + (row === "table" ? 100 : 0);
      return { left: 0, top, width: 100, height: 24, right: 100, bottom: top + 24, x: 0, y: top, toJSON: () => ({}) };
    });
    const slot = await mount();
    try {
      scroll = 400;
      act(() => move!("idle"));
      act(() => move!("working"));
      const frame = fx.all.find(animation => animation.target.matches('[data-place="road"]'))?.keyframes[0];
      console.log("L1 party after scroll", JSON.stringify(frame));
      expect(frame).toEqual({ transform: "translate(0px, 100px)" });
    } finally { slot.lifecycle.unmount(); rect.mockRestore(); }
  });

  it("never moves a failed member, who waits at the table", async () => {
    const slot = await mount();
    act(() => move!("failed"));
    expect(slot.container.querySelector(".zone.table [data-member]")).not.toBeNull();
    expect(motion.cues.size).toBe(0);
    slot.lifecycle.unmount();
  });
});
