import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, settingsContract } from "../../../src/shared/settings";
import { rpcContract } from "../../../src/shared/contract";
import { backupContract } from "../../../src/shared/backup";
import { settingsView } from "../../../src/ui/page/fixtures-insights";
import { registry } from "../../../src/ui/page/fixtures";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import { richRoom } from "./scenes";
const slots: RenderedSlot[]=[];
beforeEach(()=>window.localStorage.clear());
afterEach(()=>{for(const s of slots.splice(0))s.lifecycle.unmount();});
async function section(id:string,view=structuredClone(settingsView),rpc:Record<string,(input: unknown)=>unknown>={}){
 const app=await loadPluginApp(async()=>({default:definePluginApp(registerPageSurfaces)}));
 const slot=renderSlot(app.settingsSections.find(s=>s.id===id)!,{}, {pluginId:"tavern",experimental_rpcContract:{...rpcContract,...settingsContract,...backupContract},rpc:{settings:()=>view,registry:()=>registry,backupList:()=>({dir:"/fixture/backups",keep:14,backups:[],error:null,dataBytes:0,exportLimitBytes:8388608}),...rpc},providers:{status:"ready",providers:[{id:"codex",displayName:"Codex",available:true}] as never}});
 slots.push(slot);return slot;
}
it("lets people add a named tool rule without widening the default scope", async () => {
 const update=vi.fn(()=>({code:"ok",revision:settingsView.revision+1,settings:settingsView,problems:[]}));
 const s=await section("scopes",structuredClone(settingsView),{settingsUpdate:update});
 fireEvent.click(await s.findByRole("button",{name:"Add tool rule"}));
 fireEvent.change(s.getByLabelText("Tool name pattern"),{target:{value:"*_create_draft"}});
 fireEvent.change(s.getByLabelText("Act"),{target:{value:"draft"}});
 fireEvent.change(s.getByLabelText("Target key"),{target:{value:"recipient"}});
 fireEvent.click(s.getByRole("button",{name:"Save tool rules"}));
 await waitFor(()=>expect(update).toHaveBeenCalledWith(expect.objectContaining({patch:{scopes:{sendTools:[{pattern:"*_create_draft",act:"draft",targetKey:"recipient"}]}}})));
});
it("saves a literal shell prefix independently of tool patterns", async () => {
 const update=vi.fn(()=>({code:"ok",revision:settingsView.revision+1,settings:settingsView,problems:[]}));
 const s=await section("scopes",structuredClone(settingsView),{settingsUpdate:update});
 fireEvent.click(await s.findByRole("button",{name:"Add shell rule"}));
 fireEvent.change(s.getByLabelText("Shell command prefix"),{target:{value:"fixture-cli post"}});
 expect(s.queryByLabelText("Target key")).toBeNull();
 fireEvent.click(s.getByRole("button",{name:"Save tool rules"}));
 await waitFor(()=>expect(update).toHaveBeenCalledWith(expect.objectContaining({patch:{scopes:{sendTools:[{shell:"fixture-cli post",act:"send"}]}}})));
});
it.runIf(!!process.env.TAVERN_SEND_SETTINGS_MARKUP)("renders named rules for browser measurements", async () => {
 const view=structuredClone(settingsView);
 view.effective.scopes.sendTools=[{pattern:"*_post_message",act:"send"},{pattern:"*_create_draft",act:"draft",targetKey:"recipient"},{shell:"fixture-cli post",act:"send"}];
 const s=await section("scopes",view);
 await s.findByRole("region",{name:"Sending and drafting"});
 const controls = s.getAllByRole("combobox",{name:"Act"}) as HTMLSelectElement[];
 expect(controls.map(control => control.value)).toEqual(["send","draft","send"]);
 for (const control of controls) for (const option of control.options) option.toggleAttribute("selected", option.selected);
 process.stdout.write("SEND_SETTINGS_MARKUP=" + JSON.stringify(s.container.innerHTML) + "\n");
});
it("registers Setup first, kit descriptions for each section, and history last",async()=>{
 const app=await loadPluginApp(async()=>({default:definePluginApp(registerPageSurfaces)}));
 expect(app.settingsSections.map(s=>s.id)).toEqual(["setup","tavern","attention","keepers","classes","scopes","machines","atmosphere","away","journal","tuning","data","settings-history"]);
 expect(app.settingsSections.filter(s=>s.title==="Atmosphere").map(s=>s.id)).toEqual(["atmosphere"]);
 for(const s of app.settingsSections){
  expect(s.description??"").toBe("");
  const slot=renderSlot(s,{}, {pluginId:"tavern",experimental_rpcContract:{...rpcContract,...settingsContract},rpc:{settings:()=>settingsView,registry:()=>registry}});slots.push(slot);
  expect(slot.container.querySelector(".tv-set-introwrap > .tv-set-intro")?.textContent).toMatch(/\w+.*\./);
 }
});
it("shows the schema's user knobs with defaults and only offers Reset for changed values",async()=>{
 const expected=Object.entries(DEFAULT_SETTINGS).flatMap(([group,keys])=>Object.keys(keys).map(key=>`${group}.${key}`));
 // Class records, machine rules and forge profiles have dedicated editors.
 const exceptions=new Set(["machines.rules","machines.forges"]);
 const app=await loadPluginApp(async()=>({default:definePluginApp(registerPageSurfaces)}));
 const shown=new Set<string>();
 for(const entry of app.settingsSections){
  const s=await section(entry.id);
  await waitFor(()=>expect(s.container.querySelector(".tv-loading")).toBeNull());
  if(entry.id==="data") await s.findByLabelText("Keep the newest");
  expect(s.container.querySelector(".locked input:disabled, input:disabled[readonly]")).toBeNull();
  expect(s.container.textContent).not.toMatch(/Fixed, not tunable|cannot be tuned\./i);
  for(const fold of s.container.querySelectorAll<HTMLDetailsElement>("details.tv-set-advanced")) fold.open=true;
  for(const row of s.container.querySelectorAll("[data-setting-keys]")){
   for(const key of row.getAttribute("data-setting-keys")!.split(" ")) shown.add(key);
   expect(row.textContent).toMatch(/default|changed from/i);
   const reset=within(row as HTMLElement).queryByRole("button",{name:/reset.*default/i});
   expect(!!reset).toBe(!!row.querySelector("[data-setting-changed]"));
  }
  s.lifecycle.unmount();
 }
 expect(expected.filter(key=>!exceptions.has(key)&&!shown.has(key))).toEqual([]);
});
it("lets the user confirm a test alert and shows the last real failure separately", async () => {
 let route: import("../../../src/shared/alert-route").AlertRouteView = { proven: false, lastTest: null, lastFailure: { at: Date.now(), error: "Fixture delivery failed" } };
 const lastTest = { id: 23, at: Date.now(), outcome: "sent", response: null } as const;
 const send = vi.fn(() => route = { ...route, lastTest });
 const confirm = vi.fn(() => route = { ...route, proven: true, lastTest: { ...lastTest, response: "arrived" } });
 const s = await section("attention", settingsView, { alertRoute: () => route, alertTestSend: send, alertTestConfirm: confirm });
 expect(await s.findByText("No test alert yet.")).toBeTruthy();
 expect(s.getByText("Fixture delivery failed")).toBeTruthy();
 fireEvent.click(s.getByRole("button", { name: "Send a test alert" }));
 expect(await s.findByRole("button", { name: "It did not" })).toBeTruthy();
 fireEvent.click(s.getByRole("button", { name: "It arrived" }));
 await waitFor(() => expect(confirm).toHaveBeenCalledWith({ id: 23, arrived: true }));
 expect(await s.findByText("You confirmed it arrived.")).toBeTruthy();
 expect(s.queryByRole("button", { name: "It arrived" })).toBeNull();
});
it("resets using the same recorded save path",async()=>{
 const view=structuredClone(settingsView);view.effective.tavern.repeatSeconds=42;
 const update=vi.fn(()=>({code:"ok",revision:view.revision+1,settings:view,problems:[]}));
 const s=await section("atmosphere",view,{settingsUpdate:update});
 const repeat=(await s.findByRole("spinbutton",{name:"Repeat every"})).closest("[data-setting-keys]")!;
 fireEvent.click(within(repeat as HTMLElement).getByRole("button",{name:/reset.*default/i}));
 await waitFor(()=>expect(update).toHaveBeenCalledWith(expect.objectContaining({patch:{},reset:["tavern.repeatSeconds"]})));
});
it("folds the agent limits with a counted difference and uses the control labels for defaults",async()=>{
 const view=structuredClone(settingsView);view.effective.keepers.tickFactChars=15900;view.effective.attention.quietHours=null;
 const k=await section("keepers",view), t=await section("tuning",view), a=await section("away",view), att=await section("attention",view), d=await section("data",view);
 for(const [slot,count] of [[k,"1 changed"],[t,"0 changed"]] as const){
  await waitFor(()=>expect(slot.container.querySelector("details.tv-set-advanced")).toBeTruthy());
  const details=slot.container.querySelector<HTMLDetailsElement>("details.tv-set-advanced")!;
  expect(details.open).toBe(false);
  expect(details.querySelector("summary")?.textContent).toContain(count);
  expect(details.textContent).not.toContain("No changes recorded.");
 }
 expect(k.container.textContent).toContain("Changed from 14,000 characters");
 expect(k.container.textContent).toContain("Default: Always ask me");
 expect(a.container.textContent).toContain("Default: Drafts ready");
 expect(att.container.textContent).toContain("Default: Off");
 expect(await d.findByText("14 backups")).toBeTruthy();
});
it("groups Tavern controls in named cards with guardrail hints",async()=>{
 const s=await section("tavern");await s.findByLabelText("Pause every Keeper");
 expect(s.getAllByRole("heading",{level:3}).map(h=>h.textContent)).toEqual(["Control of Tavern","New threads"]);
 expect(s.container.querySelector(".tv-set-intro")?.textContent).not.toMatch(/characters/i);
 expect(s.container.textContent).toContain("Agents in Tavern threads can't change these; only you can.");
 for(const c of s.container.querySelectorAll(".tv-settings-card")){expect(c.querySelector("h3")).toBeTruthy();expect(c.querySelector("svg")).toBeTruthy();expect(c.querySelector(".tv-settings-hint")?.textContent).toMatch(/\w+/);}
});
it("groups Atmosphere controls and links to the character sheets",async()=>{
 const s=await section("atmosphere");
 const party=await s.findByRole("region",{name:"The party"});
 const motion=s.getByRole("region",{name:"Motion"});
 expect(s.getByText("How the tavern looks and feels: its characters, their speech and its motion.")).toBeTruthy();
 expect(s.getAllByRole("heading",{level:3}).map(h=>h.textContent)).toEqual(["The party","Motion","Lantern","Character cues"]);
 const labels=(el:HTMLElement)=>[...el.querySelectorAll(".tv-set-row label")].map(l=>l.textContent);
 expect(labels(party)).toEqual(["Show characters","Speech bubbles","Levels and crest notches"]);
 expect(labels(motion)).toEqual(["Ambient motion","Character quiet","Repeat every"]);
 expect(labels(s.getByRole("region",{name:"Lantern"}))).toEqual(["Lantern light","Strength","Light bb's surfaces"]);
 expect(s.container.querySelector("#tavern-settings-atmosphere")).toBeTruthy();
 expect(s.container.querySelector("#motion")?.closest("#tavern-settings-atmosphere")).toBeTruthy();
 for(const text of s.container.querySelectorAll("p")){
  if(text.closest(".tv-set-row")?.querySelector("label")?.textContent==="Speech bubbles") expect(text.textContent).toMatch(/Show speech bubbles/i);
  expect(text.textContent).not.toMatch(/allow.*(?:line|replies)|voice check/i);
 }
 fireEvent.click(within(party).getByRole("button",{name:"Character sheets"}));
 expect(s.inspection.navigateCalls).toEqual([{method:"toPluginPanel",path:"tavern",options:{subPath:"characters"}}]);
});
it.each(["#tavern-settings-atmosphere","#motion"])("lands in Atmosphere from %s",async(hash)=>{
 const original=window.location.href;
 const scroll=vi.fn();
 const property=Object.getOwnPropertyDescriptor(HTMLElement.prototype,"scrollIntoView");
 Object.defineProperty(HTMLElement.prototype,"scrollIntoView",{value:scroll,configurable:true});
 window.history.replaceState(null,"",`/settings/plugins/tavern${hash}`);
 try{
  const s=await section("atmosphere");
  await waitFor(()=>expect(scroll.mock.contexts).toContain(s.container.querySelector("#tavern-settings-atmosphere")));
 }finally{
  window.history.replaceState(null,"",original);
  if(property) Object.defineProperty(HTMLElement.prototype,"scrollIntoView",property);
  else Reflect.deleteProperty(HTMLElement.prototype,"scrollIntoView");
 }
});
it.each([
 ["Show characters","characters"],["Levels and crest notches","levels"],
 ["Lantern light","lanternLight"],["Light bb's surfaces","lanternLightBb"],
] as const)("saves %s on its existing key",async(name,key)=>{
 const update=vi.fn(()=>({code:"ok",revision:settingsView.revision+1,settings:settingsView,problems:[]}));
 const s=await section("atmosphere",structuredClone(settingsView),{settingsUpdate:update});
 fireEvent.click(await s.findByRole("switch",{name}));
 await waitFor(()=>expect(update).toHaveBeenCalledWith(expect.objectContaining({patch:{tavern:{[key]:false}}})));
});
it("saves the lantern's strength separately",async()=>{
 const update=vi.fn(()=>({code:"ok",revision:settingsView.revision+1,settings:settingsView,problems:[]}));
 const s=await section("atmosphere",structuredClone(settingsView),{settingsUpdate:update});
 const strength=await s.findByRole("combobox",{name:"Strength"});
 expect((strength as HTMLSelectElement).value).toBe("medium");
 fireEvent.change(strength,{target:{value:"high"}});
 await waitFor(()=>expect(update).toHaveBeenCalledWith(expect.objectContaining({patch:{tavern:{lanternStrength:"high"}}})));
});
it("shows the active character Quiet end time, lets you edit it, and ends it early", async () => {
 const view = structuredClone(settingsView);
 const local = (hours: number, minutes: number) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(hours, minutes, 0, 0); return d; };
 const until = local(20, 45);
 Object.assign(view.effective.tavern, { characterQuietUntil: +until });
 const update = vi.fn(() => ({ code: "ok", revision: view.revision + 1, settings: view, problems: [] }));
 const s = await section("atmosphere", view, { settingsUpdate: update });
 const input = await s.findByLabelText("Quiet until");
 expect(s.getByText("Quiet until", { selector: "label" })).toBeTruthy();
 expect(s.queryByText(/Quiet until .*20:45/)).toBeNull();
 const edited = local(21, 15);
 const date = new Date(+edited - edited.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
 fireEvent.change(input, { target: { value: date } });
 fireEvent.blur(input);
 await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ patch: { tavern: { characterQuietUntil: +edited } } })));
 fireEvent.click(s.getByRole("button", { name: "End now" }));
 await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ patch: { tavern: { characterQuietUntil: 0 } } })));
});
it("saves Repeat every in seconds on its existing key",async()=>{
 const update=vi.fn(()=>({code:"ok",revision:settingsView.revision+1,settings:settingsView,problems:[]}));
 const s=await section("atmosphere",structuredClone(settingsView),{settingsUpdate:update});
 const input=await s.findByRole("spinbutton",{name:"Repeat every"});
 fireEvent.change(input,{target:{value:"27"}});
 fireEvent.keyDown(input,{key:"Enter"});
 await waitFor(()=>expect(update).toHaveBeenCalledWith(expect.objectContaining({patch:{tavern:{repeatSeconds:27}}})));
});
it.runIf(process.env.TAVERN_ATMOSPHERE_HARNESS==="1")("renders Atmosphere for the browser fixture",async()=>{
 const app=await loadPluginApp(async()=>({default:definePluginApp(registerPageSurfaces)}));
 const markup: Record<string,string>={};
 for(const voice of ["full","light","off"] as const){
  const view=structuredClone(settingsView);view.effective.tavern.voice=voice;
  const s=await section("atmosphere",view);
  const group=within(await within(s.container).findByRole("group",{name:"Speech bubbles"}));
  expect(group.getByRole("button",{name:new RegExp(`^${voice}$`,"i"),pressed:true})).toBeTruthy();
  markup[voice]=s.container.innerHTML;
 }
 const sections=app.settingsSections.map(({id,title})=>({id,title}));
 process.stdout.write("ATMOSPHERE_HARNESS="+JSON.stringify({sections,markup})+"\n");
});
it.runIf(process.env.TAVERN_KNOBS_HARNESS==="1")("renders the knob surfaces for the browser fixture",async()=>{
 const app=await loadPluginApp(async()=>({default:definePluginApp(registerPageSurfaces)}));
 const view=structuredClone(settingsView);
 view.liveOverrides=[{questId:"vault",questTitle:"Review infrastructure changes in the vault",keeperName:"Wren",keeperThreadId:"keeper-1",key:"staleMinutes",value:42,applied:true}];
 view.effective.keepers.tickFactChars=15900;
 view.lastChangers={"keepers.tickFactChars":{by:"user",threadId:null,at:Date.now()-90000}};
 const output:Record<string,{title:string;markup:string}>={};
 for(const entry of app.settingsSections){
  const s=await section(entry.id,view);
  const marker=["classes","settings-history"].includes(entry.id)?".tv-settings-card":"[data-setting-keys]";
  await waitFor(()=>expect(s.container.querySelector(marker)).not.toBeNull());
  if(entry.id==="data") await within(s.container).findByLabelText("Keep the newest");
  output[entry.id]={title:entry.title!,markup:s.container.innerHTML};s.lifecycle.unmount();
 }
 const away=()=>({revision:0,window:null,status:{closed:false,until:null,dueBack:false,windowId:null},watchedCount:0,heldCount:0,pendingStops:[],resumeRequired:[]});
 const options={pluginId:"tavern",experimental_rpcContract:{...rpcContract,...settingsContract},rpc:{settings:()=>view,registry:()=>registry,room:()=>richRoom,away}};
 const page=renderSlot(app.navPanels[0]!,{subPath:"closing"},options);
 await within(page.container).findByRole("group",{name:"Never while closed"});
 output["closing-page"]={title:"Closing time page",markup:page.container.innerHTML};page.lifecycle.unmount();
 const sheet=renderSlot(app.tabs.find(t=>t.id==="closing-time")! as never,{params:null} as never,options);
 await within(sheet.container).findByRole("group",{name:"Never while closed"});
 const review=within(sheet.container).getByRole("button",{name:"Review before closing"});
 await waitFor(()=>expect((review as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(review);
 await within(sheet.container).findByRole("region",{name:/Before you close/});
 output["closing-sheet"]={title:"Closing time sheet",markup:sheet.container.innerHTML};sheet.lifecycle.unmount();
 process.stdout.write("KNOBS_HARNESS="+JSON.stringify(output)+"\n");
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
 const tuning=await section("tuning");await tuning.findByRole("heading",{name:"Tuned by Tavern"});
 const data=await section("data");await data.findByRole("heading",{name:"Import and export"});
 for(const [slot,title] of [[keepers,"Check-ins and memory"],[tuning,"Tuned by Tavern"],[data,"Import and export"]] as const){
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
it("names Atmosphere in history for all six keys, including legacy TOML spellings",async()=>{
 const changes=[
  {key:"tavern.characters",from:true,to:false},
  {key:"tavern.voice",from:"full",to:"light"},
  {key:"tavern.levels",from:true,to:false},
  {key:"tavern.ambient_motion",from:"calm",to:"lively"},
  {key:"tavern.hearth_flicker",from:true,to:false},
  {key:"tavern.repeat_seconds",from:5,to:3},
 ];
 const view=structuredClone(settingsView);view.history=changes.map((change,i)=>({...view.history[0]!,id:`atmosphere-${i}`,at:10-i,changes:[{...change,kind:"set"}]}));
 const s=await section("settings-history",view);fireEvent.click(await s.findByRole("button",{name:"6 changes"}));
 expect([...s.container.querySelectorAll(".tv-settings-keys li")].map(li=>li.textContent?.split(":")[0])).toEqual([
  "Atmosphere · Show characters","Atmosphere · Speech bubbles","Atmosphere · Levels and crest notches",
  "Atmosphere · Ambient motion","Atmosphere · Hearth flicker while work runs","Atmosphere · Repeat every",
 ]);
});
it("describes one key, several keys, an import and a tuner change without a stray loading line",async()=>{
 const view=structuredClone(settingsView);view.history=[
 {...view.history[0]!,id:"motion",at:4,changes:[{key:"tavern.repeatSeconds",from:5,to:3,kind:"set"}]},
 {...view.history[0]!,id:"multiple",at:3,changes:[{key:"tavern.voice",from:"full",to:"off",kind:"set"},{key:"attention.notify",from:"all",to:"none",kind:"set"}]},
 {...view.history[0]!,id:"import",at:2,reason:"Imported TOML on the settings page",changes:[{key:"data.historyDays",from:30,to:60,kind:"set"}]},view.history[0]!];
 const s=await section("settings-history",view);fireEvent.click(await s.findByRole("button",{name:"4 changes"}));
 expect(s.container.textContent).toContain("Atmosphere · Repeat every: 5 s to 3 s");expect(s.container.textContent).toContain("Atmosphere · Speech bubbles: Full to Off");expect(s.container.textContent).toContain("Your attention · Push to your devices: All to None");expect(s.container.textContent).toContain("Data and backups · Keep history: 30 days to 60 days");expect(s.container.textContent).toContain("Imported TOML on the settings page");expect(s.container.textContent).toContain("Tuning · Keeper tick interval: 60 s to 90 s");expect(s.container.textContent).not.toContain("Loading Tavern");
});
