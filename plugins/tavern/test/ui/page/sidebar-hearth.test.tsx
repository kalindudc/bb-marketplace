// @vitest-environment jsdom
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { renderAttentionSlot as renderSlot } from "../attention-fixture";
import { afterEach, expect, it } from "vitest";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";
const slots:RenderedSlot[]=[];
afterEach(()=>{for(const s of slots.splice(0))s.lifecycle.unmount();});
async function sidebar(lit:boolean) {
 const room=structuredClone(scenes.richRoom);
 if(!lit) for(const k of room.keepers){k.status="listening";k.boardQuests=[];k.errands=[];}
 const app=await loadPluginApp(definePluginApp(registerPageSurfaces));
 const s=renderSlot({component:app.navPanels[0]!.experimental_sidebar!},{subPath:"map"},{pluginId:"tavern",rpc:{room:()=>room,registry:()=>scenes.registry}});
 slots.push(s);return s;
}
it("uses the lit14px hearth and names its work without moving the attention count",async()=>{
 const s=await sidebar(true);
 const link=await s.findByRole("button",{name:/Common room.*lit:/i});
 expect(link.querySelector(".tavern-hearth.working svg")?.getAttribute("width")).toBe("14");
 expect(link.querySelector(".tv-snav-c .tavern-hearth")).toBeNull();
 expect(link.getAttribute("aria-label")).toMatch(/lit: 1 Keeper busy, 4 on the road, 4 need you/);
 expect(link.getAttribute("aria-label")).not.toContain("·");
});
it("keeps the home glyph when banked",async()=>{
 const s=await sidebar(false);
 const link=await s.findByRole("button",{name:/Common room/});
 expect(link.querySelector(".tavern-hearth")).toBeNull();
});
