// @vitest-environment jsdom
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rpcContract } from "../../../src/shared/contract";
import { motion } from "../../../src/ui/kit/motion";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import { installAnimations, installMatchMedia } from "../kit/motion-fakes";
import * as scenes from "./scenes";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const ID = scenes.readmeDetail.quest.id;
const slots: RenderedSlot[] = [];
let fx: ReturnType<typeof installAnimations>, mm: ReturnType<typeof installMatchMedia>;
beforeEach(() => { window.localStorage.clear(); mm = installMatchMedia(); motion.reset(); motion.now = () => 1_000_000; fx = installAnimations({ "mo-tale": 900 }); });
afterEach(() => { for (const s of slots.splice(0)) s.lifecycle.unmount(); fx.uninstall(); mm.uninstall(); motion.reset(); });

async function open(path: string) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot(plugin.navPanels[0]!, { subPath: path }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(scenes.richRoom), boardQuest: () => structuredClone(scenes.readmeDetail) } as Partial<Handlers> as Handlers });
  slots.push(slot);
  if (path.startsWith("quest/")) fireEvent.click(await slot.findByRole("button", { name: /^The party/ }));
  await waitFor(() => expect(slot.container.querySelector(".tv-credits .tv-credit")).not.toBeNull());
  return slot;
}
const tale = () => [...motion.cues].filter(c => c.kind === "tale told");

describe("the party's credit cards", () => {
  it("stay still on the quest record: no animation registers when it opens", async () => {
    const slot = await open(`quest/${ID}`);
    expect(slot.container.querySelector(".mo-tale")).toBeNull();
    expect(motion.cues.size).toBe(0);
    expect(fx.all).toHaveLength(0);
  });

  it("deal once per device on the tale, and never again when it reopens", async () => {
    const first = await open(`tale/${ID}`);
    expect(tale()).toHaveLength(1);
    expect(first.container.querySelector(".tv-credits")!.classList.contains("mo-tale")).toBe(true);
    first.lifecycle.unmount(); slots.splice(slots.indexOf(first), 1); motion.reset(); motion.now = () => 1_000_000;
    const again = await open(`tale/${ID}`);
    expect(tale()).toHaveLength(0);
    expect(again.container.querySelector(".mo-tale")).toBeNull();
  });

  it("move nothing on the tale under reduced motion", async () => {
    mm.set(true);
    const slot = await open(`tale/${ID}`);
    expect(tale()).toHaveLength(0);
    expect(slot.container.querySelector(".mo-tale")).toBeNull();
    expect(fx.all.filter(a => a.playState === "running")).toHaveLength(0);
  });
});
