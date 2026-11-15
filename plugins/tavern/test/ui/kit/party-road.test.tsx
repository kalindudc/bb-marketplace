// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
// The picture places a member by its state, so the tests move a member by changing its state; the stored place is left stale on purpose.
let move: ((state: typeof base.state) => void) | null = null;
function Party() {
  const [m, setM] = useState({ ...base, place: "table" as const, state: "idle" as typeof base.state });
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

  it("never moves a failed member, who waits at the table", async () => {
    const slot = await mount();
    act(() => move!("failed"));
    expect(slot.container.querySelector(".zone.table [data-member]")).not.toBeNull();
    expect(motion.cues.size).toBe(0);
    slot.lifecycle.unmount();
  });
});
