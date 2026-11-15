import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { settingsContract } from "../../../src/shared/settings";
import { rpcContract } from "../../../src/shared/contract";
import { settingsView } from "../../../src/ui/page/fixtures-insights";
import { registry } from "../../../src/ui/page/fixtures";
import { registerPageSurfaces } from "../../../src/ui/page/register";
const slots: RenderedSlot[]=[];
beforeEach(()=>window.localStorage.clear());
afterEach(()=>{for(const s of slots.splice(0))s.lifecycle.unmount();});
async function section(id:string,view=structuredClone(settingsView),rpc:Record<string,(input: unknown)=>unknown>={}){
 const app=await loadPluginApp(async()=>({default:definePluginApp(registerPageSurfaces)}));
 const slot=renderSlot(app.settingsSections.find(s=>s.id===id)!,{}, {pluginId:"tavern",experimental_rpcContract:{...rpcContract,...settingsContract},rpc:{settings:()=>view,registry:()=>registry,...rpc},providers:{status:"ready",providers:[{id:"codex",displayName:"Codex",available:true}] as never}});
 slots.push(slot);return slot;
}
it("registers fewer sections with kit descriptions and history last",async()=>{
 const app=await loadPluginApp(async()=>({default:definePluginApp(registerPageSurfaces)}));
 expect(app.settingsSections.map(s=>s.id)).toEqual(["tavern","attention","keepers","classes","scopes","machines","motion","journal","tuning","data","settings-history"]);
 for(const s of app.settingsSections){
  expect(s.description??"").toBe("");
  const slot=renderSlot(s,{}, {pluginId:"tavern",experimental_rpcContract:{...rpcContract,...settingsContract},rpc:{settings:()=>settingsView,registry:()=>registry}});slots.push(slot);
  expect(slot.container.querySelector(".tv-set-introwrap > .tv-set-intro")?.textContent).toMatch(/\w+.*\./);
 }
});
it("groups Tavern controls in named cards with guardrail hints",async()=>{
 const s=await section("tavern");await s.findByLabelText("Pause every Keeper");
 expect(s.container.querySelectorAll(".tv-settings-card")).toHaveLength(3);
 expect(s.container.textContent).toContain("Agents in Tavern threads can't change these; only you can.");
 for(const c of s.container.querySelectorAll(".tv-settings-card")){expect(c.querySelector("h3")).toBeTruthy();expect(c.querySelector("svg")).toBeTruthy();expect(c.querySelector(".tv-settings-hint")?.textContent).toMatch(/\w+/);}
});
it("folds history by default, remembers its state and shows newest ten before all",async()=>{
 const view=structuredClone(settingsView);view.history=Array.from({length:24},(_,i)=>({...view.history[0]!,id:`change-${i}`,at:i,reason:`Reason ${i}`}));
 const s=await section("settings-history",view);const fold=await s.findByRole("button",{name:"24 changes"});
 expect(fold.getAttribute("aria-controls")).toBeNull();expect(fold.getAttribute("aria-expanded")).toBe("false");expect(s.container.querySelectorAll(".tv-settings-change")).toHaveLength(0);
 fireEvent.click(fold);expect(document.getElementById(fold.getAttribute("aria-controls")!)).toBeTruthy();expect(s.container.querySelectorAll(".tv-settings-change")).toHaveLength(10);expect(s.container.querySelector(".tv-settings-change")?.textContent).toContain("Reason 23");
 fireEvent.click(s.getByRole("button",{name:"Show all"}));expect(s.container.querySelectorAll(".tv-settings-change")).toHaveLength(24);
 s.lifecycle.unmount();const again=await section("settings-history",view);expect((await again.findByRole("button",{name:"24 changes"})).getAttribute("aria-expanded")).toBe("true");
});
it("limits guardrail hints to protected cards and keeps file and backup guidance",async()=>{
 const keepers=await section("keepers");await keepers.findByLabelText("Strikes before release advice");
 const tuning=await section("tuning");await tuning.findByRole("heading",{name:"Tavern tunes these"});
 const data=await section("data");await data.findByRole("heading",{name:"Import and export"});
 for(const [slot,title] of [[keepers,"Check-ins and memory"],[tuning,"Tavern tunes these"],[data,"Import and export"]] as const){
  const card=slot.getByRole("heading",{name:title}).closest(".tv-settings-card")!;
  expect(card.querySelector(".tv-settings-hint")!.textContent).not.toMatch(/Only you|only you|guardrails from a Tavern thread/);
 }
 expect(data.getByRole("heading",{name:"Import and export"}).closest(".tv-settings-card")!.textContent).toContain("~/.agents/tavern/settings.toml");
 expect(data.getByRole("heading",{name:"Backups"}).closest(".tv-settings-card")!.textContent).toContain("Records add quests, plans, asks, decisions, journals and events; never secrets or transcripts.");
});
it("uses short model ids with full titles and the control labels in history",async()=>{
 const view=structuredClone(settingsView);view.history=[{...view.history[0]!,changes:[
 {key:"classes.smith.model",from:"fireworks/accounts/models/glm-5p3-flash",to:"anthropic/claude-opus",kind:"set"},
 {key:"classes.smith.provider",from:"codex",to:"codex",kind:"set"},
 {key:"classes.smith.reasoning",from:"high",to:"xhigh",kind:"set"},
 {key:"keepers.greenlight",from:"explicit",to:"by-size",kind:"set"},
 {key:"tavern.defaultClass",from:"none",to:"smith",kind:"set"}]}];
 const s=await section("settings-history",view);fireEvent.click(await s.findByRole("button",{name:"1 change"}));
 expect(s.getByText("glm-5p3-flash").getAttribute("title")).toBe("fireworks/accounts/models/glm-5p3-flash");
 expect(s.container.textContent).toContain("Codex to Codex");
 expect(s.container.textContent).toContain("high to xhigh");
 expect(s.container.textContent).toContain("Always ask me to By size");
 expect(s.container.textContent).toContain("None (an ordinary thread) to Smith (builder)");
});
it("shortens the class file model display without losing its full id",async()=>{
 const original=registry.classes[0]!.model;
 registry.classes[0]!.model="fireworks/accounts/models/glm-5p3-flash";
 try { const s=await section("classes");expect((await s.findByText("glm-5p3-flash")).getAttribute("title")).toBe("fireworks/accounts/models/glm-5p3-flash");}
 finally {registry.classes[0]!.model=original;}
});
it("edits a tuned value without pinning and refuses out-of-bounds values",async()=>{
 const update=vi.fn((_input:unknown)=>({code:"ok",revision:settingsView.revision+1,settings:settingsView,problems:[]}));
 const s=await section("tuning",structuredClone(settingsView),{settingsUpdate:update});
 const input=await s.findByRole("spinbutton",{name:"Keeper tick interval"});
 fireEvent.change(input,{target:{value:"95"}});fireEvent.keyDown(input,{key:"Enter"});
 await waitFor(()=>expect(update).toHaveBeenCalledWith(expect.objectContaining({patch:{knobs:{tickSeconds:95}}})));
 expect(update.mock.calls[0]![0]).not.toHaveProperty("pins");
 update.mockClear();
 fireEvent.change(input,{target:{value:"5"}});
 expect(input.getAttribute("aria-invalid")).toBe("true");fireEvent.keyDown(input,{key:"Enter"});
 expect(update).not.toHaveBeenCalled();
 const row=input.closest("li")!;
 expect(within(row).getByRole("button",{name:"Pin"})).toBeTruthy();
});
it("explains the settings and only marks the two hold rows as guardrails",async()=>{
 const s=await section("tuning");const list=(await s.findByRole("spinbutton",{name:"Keeper tick interval"})).closest("ul")!;
 const rows=list.querySelectorAll("li.tv-tuned-row");
 expect(rows).toHaveLength(5);
 for(const row of rows)expect(row.querySelector(".tv-tuned-help")?.textContent).toMatch(/Higher|Lower/);
 expect([...rows].filter(row=>row.textContent?.includes("Agents in Tavern threads can't change these; only you can."))).toHaveLength(2);
});
it.each([
 ["off","Tavern doesn't tune these; they keep their values."],
 ["suggest","Tavern suggests changes from its records; you apply them."],
 ["apply","Tavern changes these from its records; pinned values are never changed."],
] as const)("explains tuning mode %s in sentences",async(mode,words)=>{
 const view=structuredClone(settingsView);view.effective.tuning.mode=mode;
 const s=await section("tuning",view);expect(await s.findByText(words)).toBeTruthy();
});
it("names the Ranger ceiling in its actual section with minutes",async()=>{
 const view=structuredClone(settingsView);view.history=[{...view.history[0]!,changes:[{key:"knobs.rangerTimeboxMaxMinutes",from:12,to:30,kind:"set"}]}];
 const s=await section("settings-history",view);fireEvent.click(await s.findByRole("button",{name:"1 change"}));
 expect(s.container.textContent).toContain("Keepers and decisions · Ranger time-box ceiling: 12 min to 30 min");
});
it("keeps large changes readable with three keys and folded remaining details",async()=>{
 const view=structuredClone(settingsView);view.history=[{...view.history[0]!,changes:Array.from({length:8},(_,i)=>({key:`classes.smith.model${i}`,from:"Before",to:"After",kind:"set" as const}))}];
 const s=await section("settings-history",view);fireEvent.click(await s.findByRole("button",{name:"1 change"}));
 expect(s.container.querySelector(".tv-settings-keys")?.children).toHaveLength(3);
 const more=s.container.querySelector("details");expect(more?.open).toBe(false);expect(more?.querySelector("summary")?.textContent).toContain("5 more settings");
});
it("describes one key, several keys, an import and a tuner change without a stray loading line",async()=>{
 const view=structuredClone(settingsView);view.history=[
 {...view.history[0]!,id:"motion",at:4,changes:[{key:"tavern.repeatSeconds",from:5,to:3,kind:"set"}]},
 {...view.history[0]!,id:"multiple",at:3,changes:[{key:"tavern.voice",from:"full",to:"off",kind:"set"},{key:"attention.notify",from:"all",to:"none",kind:"set"}]},
 {...view.history[0]!,id:"import",at:2,reason:"Imported TOML on the settings page",changes:[{key:"data.historyDays",from:30,to:60,kind:"set"}]},view.history[0]!];
 const s=await section("settings-history",view);fireEvent.click(await s.findByRole("button",{name:"4 changes"}));
 expect(s.container.textContent).toContain("Motion · Repeat every: 5 s to 3 s");expect(s.container.textContent).toContain("Tavern · Character voice: Full to Off");expect(s.container.textContent).toContain("Your attention · Push to your devices: All to None");expect(s.container.textContent).toContain("Data and backups · Keep history: 30 days to 60 days");expect(s.container.textContent).toContain("Imported TOML on the settings page");expect(s.container.textContent).toContain("Tuning · Keeper tick interval: 60 s to 90 s");expect(s.container.textContent).not.toContain("Loading Tavern");
});
