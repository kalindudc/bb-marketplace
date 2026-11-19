// @vitest-environment jsdom
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, it } from "vitest";
import { EventList } from "../../../src/ui/page/room";
import { History } from "../../../src/ui/page/record";
import { eventContext, eventLines } from "../../../src/ui/page/model";
import { moveTime } from "../../../src/shared/time";
import type { TavernEvent } from "../../../src/shared/schema";
import { richRoom, richDetails, registry, wren } from "./scenes";
it.each(["feed", "quest story"])("%s distinguishes pre-approved and delegated answers from user answers", async surface => {
 const at = Date.now(), q = richDetails.vault!;
 const events: TavernEvent[] = [
  {id:9001,at,keeperThreadId:wren.threadId,boardQuestId:q.quest.id,type:"ask.answered",text:"Party approved",actor:{kind:"user"},data:{answeredBy:"preapproval",preapproval:{id:"record",at,surface:"page (client, unattested)"}}},
  {id:9002,at:at+1,keeperThreadId:wren.threadId,boardQuestId:q.quest.id,type:"ask.answered",text:"Credential allowed",actor:{kind:"agent",threadId:wren.threadId},data:{answeredBy:"keeper",keeperName:"Wren",delegation:{id:"delegation"}}},
  {id:9003,at:at+2,keeperThreadId:wren.threadId,boardQuestId:q.quest.id,type:"decision.made",text:"Credential decision",actor:{kind:"agent",threadId:wren.threadId},data:{answeredBy:"keeper",keeperName:"Wren",delegation:{id:"delegation"}}},
 ];
 const app=await loadPluginApp(definePluginApp(a=>a.slots.homepageSection({id:"authority-receipts",title:"Receipts",component:()=>surface==="feed" ? <EventList lines={eventLines(events,eventContext(richRoom,registry))} registry={registry}/> : <History detail={{...q,events,plans:[],routes:[]}} registry={registry} room={richRoom} bare/>})));
 const slot=renderSlot(app.homepageSections[0]!,{projectId:null});
 expect(slot.container.textContent).toContain(`Pre-approved by you at ${moveTime(at,at)}`);
 const lines=[...slot.container.querySelectorAll(".tv-ev-h")].map(e=>e.textContent);
 expect(lines.filter(line=>line?.includes("Wren") && line.includes("decided (delegated by you)"))).toHaveLength(2);
 expect(slot.container.textContent).not.toMatch(/You answered|You formed the party/);
 slot.lifecycle.unmount();
});
