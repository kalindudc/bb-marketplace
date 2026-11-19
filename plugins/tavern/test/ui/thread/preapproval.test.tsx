// @vitest-environment jsdom
import { expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { QuestAuthority } from "../../../src/ui/kit/quest-authority";
import { rpcContract } from "../../../src/shared/contract";
import { AskCard } from "../../../src/ui/kit";
import { fixtureAsk } from "../../../src/ui/thread/fixtures";
import { preapprovalWords } from "../../../src/shared/quest-authority";
it("explains the declared-act gate and the separate merge ask", async () => {
 const app=await loadPluginApp(definePluginApp(a=>a.slots.homepageSection({id:"authority-copy",title:"Authority",component:()=> <QuestAuthority questId="quest"/>})));
 const slot=renderSlot(app.homepageSections[0]!,{projectId:null},{experimental_rpcContract:rpcContract,rpc:{questAuthority:()=>({keeperName:"Wren",rows:[],delegations:[],preapprovals:[],review:{used:0,total:5},spendBudget:null})} as never});
 expect(await slot.findByText("The plan’s declared acts are the pre-approval gate; a push still needs its merge ask.")).toBeTruthy();slot.lifecycle.unmount();
});
it.each(["banner", "page", "phone", "chat"] as const)("shows exact pre-approval attribution on %s, never user-answer attribution", async via => {
  const provenance = { id: "standing", at: 1700000000000, surface: "client (unattested)" };
  const ask = { ...fixtureAsk, state: "answered" as const, answer: { optionId: fixtureAsk.options[0]!.id, note: null, by: "preapproval" as const, via: "timer" as const, at: 1700000000001, surface: "client (unattested)", preapproval: provenance } };
  const app = await loadPluginApp(definePluginApp(a => a.slots.homepageSection({ id: "receipt", title: "Receipt", component: () => <AskCard ask={ask} via={via} /> })));
  const slot = renderSlot(app.homepageSections[0]!, { projectId: null });
  expect(slot.getByText(preapprovalWords(provenance))).toBeTruthy();
  expect(slot.queryByText("answered from a client Tavern could not attribute")).toBeNull();
  expect(slot.container.textContent).not.toContain("answered by you");
  slot.lifecycle.unmount();
});
