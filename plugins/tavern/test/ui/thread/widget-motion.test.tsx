// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { renderAttentionSlot as renderSlot } from "../attention-fixture";
import { fixtureDecor, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { TYPING_HOLD_MS, motion } from "../../../src/ui/kit/motion";
import { installAnimations } from "../kit/motion-fakes";

let fx: ReturnType<typeof installAnimations>;
let t = 0;
beforeEach(() => { motion.reset(); t = 1_000_000; motion.now = () => t; fx = installAnimations({ "mo-pulse": 3200 }); });
afterEach(() => { cleanup(); fx.uninstall(); motion.reset(); for (const c of document.querySelectorAll("[data-test-composer]")) c.remove(); });
/** bb's composer: a contenteditable outside the row, focused when a thread opens. */
const composerField = () => {
  const c = document.createElement("div");
  c.setAttribute("contenteditable", "true"); c.tabIndex = 0; c.dataset.testComposer = "";
  document.body.appendChild(c);
  return c;
};

async function widget(keeperView: Partial<NonNullable<typeof fixtureDecor.keeperView>>) {
  const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
  const banner = app.composerCustomizations.find(c => c.id === "tavern-thread")!.banners![0]!;
  const decor = { ...fixtureDecor, keeperView: { ...fixtureDecor.keeperView!, ...keeperView } };
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: "thread", threadId: "keeper-1" } }, rpc: { decor: () => decor, registry: () => fixtureRegistry } });
  await waitFor(() => expect(slot.container.querySelector(".tw-dot")).not.toBeNull());
  return slot;
}
const dot = (slot: { container: HTMLElement }) => slot.container.querySelector(".tw-dot")!;

describe("the widget row's motion", () => {
  it("pulses the busy dot twice when the row comes into view busy, then holds it solid", async () => {
    const slot = await widget({ status: "busy", openAsks: [] });
    await waitFor(() => expect([...motion.cues].map(c => c.kind)).toEqual(["busy dot"]));
    expect(dot(slot).classList.contains("mo-pulse")).toBe(true);
    fx.tick(3200);
    await waitFor(() => expect(dot(slot).classList.contains("mo-pulse")).toBe(false));
    slot.lifecycle.unmount();
  });

  it("cuts a running pulse at the first keystroke in a text field, and starts nothing for 2 s after", async () => {
    const slot = await widget({ status: "busy", openAsks: [] });
    await waitFor(() => expect(motion.cues.size).toBe(1));
    const pulse = fx.all.find(a => a.className === "mo-pulse")!;
    const field = composerField();
    act(() => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "R", bubbles: true })); });
    expect(pulse.playState).toBe("idle");
    expect(dot(slot).classList.contains("mo-pulse")).toBe(false);
    expect(motion.cues.size).toBe(0);
    t += TYPING_HOLD_MS - 1;
    expect(motion.cue("thread:keeper-1", dot(slot), "report", { key: "nod", ms: 400, region: "widget", className: "mo-pulse" })).toBeNull();
    expect(motion.log.at(-1)?.reason).toBe("held");
    t += 1;
    expect(motion.cue("thread:keeper-1", dot(slot), "report", { key: "nod", ms: 400, region: "widget", className: "mo-pulse" })).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("cuts a widget cue to its rest state, never its end frame, even when the cue fills forwards", async () => {
    const slot = await widget({ status: "listening", openAsks: [] });
    const done: string[] = [];
    const nod = dot(slot).animate([{ opacity: 1 }, { opacity: 0.35 }], { duration: 400, fill: "forwards" });
    expect(motion.cue("thread:keeper-1", dot(slot), "report", { key: "nod", ms: 400, region: "widget", run: () => [nod], onDone: () => done.push("nod") })).not.toBeNull();
    act(() => { composerField().dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true })); });
    // Cancelled, not finished: a finished fill-forwards animation would hold its end frame (opacity .35) on the dot.
    expect(nod.playState).toBe("idle");
    expect(done).toEqual(["nod"]);
    slot.lifecycle.unmount();
  });

  it("keeps moving with a draft bb restored in the focused composer: neither the draft nor focus is typing", async () => {
    const slot = await widget({ status: "busy", openAsks: [] });
    await waitFor(() => expect(motion.cues.size).toBe(1));
    const pulse = fx.all.find(a => a.className === "mo-pulse")!;
    const field = composerField();
    act(() => field.focus());
    await slot.behavior.setComposerText("a draft bb restored");
    expect(document.activeElement).toBe(field);
    expect(pulse.playState).toBe("running");
    expect(motion.cue("thread:keeper-1", dot(slot), "report", { key: "nod", ms: 400, region: "widget" })).not.toBeNull();
    expect(motion.log.map(l => l.reason)).not.toContain("held");
    slot.lifecycle.unmount();
  });

  it("holds the row still when an ask is in it", async () => {
    const slot = await widget({ status: "busy" });
    expect(fixtureDecor.keeperView!.openAsks.length).toBeGreaterThan(0);
    await waitFor(() => expect(motion.log.map(l => l.reason)).toContain("held"));
    expect(motion.cues.size).toBe(0);
    expect(dot(slot).classList.contains("mo-pulse")).toBe(false);
    slot.lifecycle.unmount();
  });

  it("never pulses an idle Keeper", async () => {
    const slot = await widget({ status: "listening", openAsks: [] });
    expect(motion.cues.size).toBe(0);
    slot.lifecycle.unmount();
  });
});
