// @vitest-environment jsdom
import { withAttention } from "../attention-fixture";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";
const slots: RenderedSlot[] = [];
afterEach(() => { for(const slot of slots.splice(0)) slot.lifecycle.unmount(); });
beforeEach(() => window.localStorage.clear());
async function mount(calm: boolean) {
  const room = structuredClone(scenes.richRoom);
  if(calm) { room.asks=[];room.decidedForYou=[];room.decidedCount=0;room.review={waiting:0,budget:3,items:[]}; for(const k of room.keepers)for(const q of k.boardQuests) delete q.checkerHandoffHold; }
  const app = await loadPluginApp(definePluginApp(registerPageSurfaces));
  const slot=renderSlot(app.navPanels[0]!,{subPath:"room"},{pluginId:"tavern",rpc:{room:()=>withAttention(room),registry:()=>scenes.registry}});
  slots.push(slot);return slot;
}
it("collapses empty attention containers only around the calm line", async()=>{
  const slot=await mount(true);
  const calm=await slot.findByText("Nothing needs you.");
  expect(calm.closest(".rm-o1")!.querySelectorAll("[data-sec]:empty")).toHaveLength(1);
  const css=readFileSync("src/ui/page/page.css","utf8");
  expect(css).toMatch(/\.rm-o1:has\(> \.rm-calm\) > \[data-sec\]:empty\s*\{\s*display: none/);
  expect(css).not.toMatch(/\.rm-a-grid:has\(\.rm-calm\) \.rm-o[14]\s*\{\s*order:/);
  expect(css).toMatch(/\.rm-calm\s*\{\s*padding: 0; margin: 0/);
  expect(css).toMatch(/\.rm-a-rail:has\(> \.rm-o1 > \.rm-calm\)\s*\{\s*gap: 12px/);
});
it("keeps needs-you attention present without the calm line", async()=>{
  const slot=await mount(false);
  await slot.findByText("Needs you");
  expect(slot.container.querySelector(".rm-calm")).toBeNull();
  expect(slot.container.querySelector("[data-sec=needs]")?.textContent).toContain("Needs you");
});
