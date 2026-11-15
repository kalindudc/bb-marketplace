// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, mountPluginContentScripts } from "@get-bb/plugin-sdk/testing/app";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { motion } from "../../../src/ui/kit/motion";
import { installAnimations } from "../kit/motion-fakes";

let fx: ReturnType<typeof installAnimations>;
beforeEach(() => { motion.reset(); motion.now = () => 1_000_000; fx = installAnimations(); });
afterEach(() => { vi.restoreAllMocks(); fx.uninstall(); motion.reset(); document.body.innerHTML = ""; });

const COORDINATOR = new Set(["visibilitychange", "input", "keydown", "compositionstart", "compositionupdate", "compositionend", "focusout"]);
type Call = [target: string, type: string, fn: unknown];
function listeners() {
  const added: Call[] = [], removed: Call[] = [];
  for (const [name, target] of [["document", document], ["window", window]] as const) {
    const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type, fn, o) => { if (COORDINATOR.has(type)) added.push([name, type, fn]); add(type, fn, o); });
    vi.spyOn(target, "removeEventListener").mockImplementation((type, fn, o) => { if (COORDINATOR.has(type)) removed.push([name, type, fn]); remove(type, fn, o); });
  }
  return { added, removed };
}
const span = () => { const e = document.createElement("span"); document.body.appendChild(e); return e; };
const slide = (e: Element) => [e.animate([{ transform: "translateY(4px)" }, { transform: "none" }], { duration: 400 })];

describe("the motion coordinator's lifecycle", () => {
  it("installs on the content script's mount, and its disposer removes every listener and finishes running cues", async () => {
    const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
    const seen = listeners();
    const mounted = await mountPluginContentScripts(app, { pluginId: "tavern" });
    expect(mounted.inspection.mountedIds).toContain("tavern-motion");
    expect(new Set(seen.added.map(([, type]) => type))).toEqual(COORDINATOR);
    expect(motion.cue("page", span(), "report", { key: "a", ms: 400, run: slide })).not.toBeNull();
    const running = fx.all[0]!;
    await mounted.lifecycle.dispose();
    for (const call of seen.added) expect(seen.removed).toContainEqual(call);
    expect(running.playState).toBe("finished");
  });

  it("counts mounts, so one mount's disposer leaves the coordinator to a mount still active", async () => {
    const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
    const seen = listeners();
    const first = await mountPluginContentScripts(app, { pluginId: "tavern" });
    const second = await mountPluginContentScripts(app, { pluginId: "tavern", generation: 2 });
    await first.lifecycle.dispose();
    expect(seen.removed).toHaveLength(0);
    expect(motion.cue("page", span(), "report", { key: "a", ms: 400, run: slide })).not.toBeNull();
    await second.lifecycle.dispose();
    for (const call of seen.added) expect(seen.removed).toContainEqual(call);
    expect(motion.cue("page", span(), "report", { key: "b", ms: 400, run: slide })).toBeNull();
  });

  it("stays ended after disposal, so an old tree's last render can't install listeners again, until the next mount", async () => {
    const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
    const seen = listeners();
    await (await mountPluginContentScripts(app, { pluginId: "tavern" })).lifecycle.dispose();
    const before = seen.added.length;
    const done = vi.fn();
    expect(motion.cue("page", span(), "report", { key: "b", ms: 400, run: slide, onDone: done })).toBeNull();
    expect(done).toHaveBeenCalledTimes(1);
    motion.install();
    expect(seen.added).toHaveLength(before);
    const next = await mountPluginContentScripts(app, { pluginId: "tavern", generation: 2 });
    expect(seen.added.length).toBeGreaterThan(before);
    expect(motion.cue("page", span(), "report", { key: "c", ms: 400, run: slide })).not.toBeNull();
    await next.lifecycle.dispose();
  });
});
