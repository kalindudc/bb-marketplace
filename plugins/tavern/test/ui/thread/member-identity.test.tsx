// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { readFileSync } from "node:fs";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { clearThreadState } from "../../../src/ui/thread/state";
import { fixtureDecor, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { scopeForClass } from "../../../src/scope/presets";
afterEach(()=>{cleanup();clearThreadState();});
it("opens Member from the named crest button and keeps identity above its brief",async()=>{
 const registry={...fixtureRegistry,classes:[{...fixtureRegistry.classes[0]!,id:"wanderer",label:"Wanderer",plain:"general",description:"Keeps work moving."}]};
 const decor={...fixtureDecor,member:{...fixtureDecor.member!,role:"member" as const,classId:"wanderer",displayName:"Pip"},keeperView:null,brief:"Deliver the fix.",scope:{threadId:"keeper-1",scope:scopeForClass("wanderer"),armed:true,error:null,pendingAskId:null,mode:"enforce" as const}};
 const slot=renderSlot({component:ThreadWidget},{threadId:"keeper-1"},{rpc:{registry:()=>registry,decor:()=>decor}});
 const name=await slot.findByRole("button",{name:"Pip, Wanderer (general) · scope: open · only protected files guarded"});
 expect(name.getAttribute("title")).toBe("Pip, Wanderer (general) · scope: open · only protected files guarded");
 expect(name.textContent).toContain("Pip"); expect(name.textContent).toContain("Wanderer");
 fireEvent.click(name);
 expect(name.getAttribute("aria-expanded")).toBe("true");
 const panel=slot.container.querySelector('[aria-label="Member"]')!;
 expect(panel).not.toBeNull();
 expect(panel.querySelector('[data-part="MemberIdentity"]')).not.toBeNull();
 expect(panel.textContent).toMatch(/Pip.*Wanderer.*Keeps work moving.*Deliver the fix/s);
 expect(slot.getByRole("button",{name:/Member: show/})).toBeTruthy();
 slot.lifecycle.unmount();
});
it("defines class-first, name-second collapse rules and retains the crest",()=>{
 const css=readFileSync("src/ui/kit/components.css","utf8");
 expect(css).toMatch(/max-width: 420px[^}]*tw-member-class[^}]*display: none/);
 expect(css).toMatch(/max-width: 340px[^}]*tw-id \.tw-name[^}]*display: none/);
 expect(css).not.toMatch(/v-member \.tw-id \{ display: none/);
 expect(css).not.toMatch(/max-width: 760px[^}]*v-member[^}]*\.anc[^}]*display: none/);
});
