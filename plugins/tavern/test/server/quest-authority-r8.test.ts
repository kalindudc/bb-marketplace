// @vitest-environment node
import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanRebaseMatches } from "../../src/server/act-patch";
import { setup } from "./runtime-fixture";
import { seedQuest, planInput } from "./support";
import { requireUserAct, terminalUserAct } from "../../src/server/authority";
import { readStatus } from "../../src/server/status";
import { describeEvent, eventLines } from "../../src/ui/page/model";
import { preapprovalWords } from "../../src/shared/quest-authority";
const receipt = (act: "delegateQuest" | "preapproveQuest") => requireUserAct({ experimental_caller: { kind: "client" } } as never, act);
const request = (q: string) => ({ boardQuestId: q, kind: "credential" as const, effect: { type: "decision" } as const, question: "Use the credential?", why: "Delegated", options: [{ id: "approve", label: "Approve", detail: "", recommended: false }, { id: "deny", label: "Deny", detail: "", recommended: false }], meanwhile: "Other work", holds: [] });
const safe = (q: string) => ({ ...planInput(q), reversible: true, waypoints: planInput(q).waypoints.map(w => ({ ...w, acts: [{ kind: "workspace-write", path: "result.md" }] })) });
it("R5 destructive probe: changed work below an unchanged tip never matches; ordered clean replay does", () => {
 const root = mkdtempSync(join(tmpdir(), "r8-range-"));
 const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
 try {
  git("init", "-q"); git("config", "user.name", "T"); git("config", "user.email", "t@e.t");
  writeFileSync(join(root,"base"),"base\n");git("add",".");git("commit","-qm","base");const base=git("rev-parse","HEAD");
  writeFileSync(join(root,"config"),"safe\n");git("add",".");git("commit","-qm","A config");const first=git("rev-parse","HEAD");
  writeFileSync(join(root,"feature"),"feature\n");git("add",".");git("commit","-qm","V feature");const verified=git("rev-parse","HEAD");
  git("checkout","-q","--detach",base);writeFileSync(join(root,"other"),"upstream\n");git("add",".");git("commit","-qm","new base");const upstream=git("rev-parse","HEAD");
  git("update-ref","refs/remotes/origin/main",upstream);git("symbolic-ref","refs/remotes/origin/HEAD","refs/remotes/origin/main");
  writeFileSync(join(root,"config"),"rm -rf / # unreviewed\n");git("add",".");git("commit","-qm","A* changed");git("cherry-pick",verified);
  expect(cleanRebaseMatches(join(root,".git"),verified,git("rev-parse","HEAD"),upstream)).toBe(false);
  git("checkout","-q","--detach",upstream);git("cherry-pick",first,verified);
  expect(cleanRebaseMatches(join(root,".git"),verified,git("rev-parse","HEAD"),upstream)).toBe(true);
  git("checkout","-q","--detach",upstream);git("cherry-pick",verified,first);
  expect(cleanRebaseMatches(join(root,".git"),verified,git("rev-parse","HEAD"),upstream)).toBe(false);
  git("checkout","-q","--detach",upstream);writeFileSync(join(root,"config"),"safe  \n");git("add",".");git("commit","-qm","same patch-id, different tree");git("cherry-pick",verified);
  expect(cleanRebaseMatches(join(root,".git"),verified,git("rev-parse","HEAD"),upstream)).toBe(false);
  expect(cleanRebaseMatches(join(root,".git"),verified,git("rev-parse","HEAD"))).toBe(false);
 } finally {rmSync(root,{recursive:true,force:true});}
});
it("keeps delegated asks in Keeper restatement/status and the move, never need-you", async () => {
 const f=setup(),q=await seedQuest(f.k,"lead","Quest","Quest"); f.k.plan("lead",planInput(q.id));f.k.answerAsk(f.k.store.openAsks("lead")[0]!.id,"approve",null,"page","user");
 f.k.authority.delegate(q.id,"credential",receipt("delegateQuest")); const ask=f.k.ask("lead",request(q.id));
 expect(f.k.restatement("lead")).toContain(ask.id);expect(f.k.restatement("lead")).toContain("Yours to decide (delegated)");
 expect(JSON.stringify(readStatus(f.runtime,"lead",{limit:5,offset:0} as never))).toContain(ask.id);
 expect(f.k.summary(q.id).move).toMatchObject({who:"keeper",text:expect.stringMatching(/waiting on/i)});
 expect(f.k.summary(q.id).openAsks).toBe(0);expect(f.k.store.openAsks("lead",q.id,true)).toHaveLength(0);
});
it("feed and story models read real pre-approved and delegated receipts", async () => {
 const f=setup(),q=await seedQuest(f.k,"lead","Quest","Quest");f.k.authority.preapprove(q.id,{greenlight:{maxMembers:1,classes:["smith"]},placement:false,conclude:false,endsAt:null},receipt("preapproveQuest"));
 f.k.plan("lead",safe(q.id) as never);f.k.authority.delegate(q.id,"credential",receipt("delegateQuest"));const ask=f.k.ask("lead",request(q.id));
 f.k.decide("lead",{boardQuestId:q.id,askId:ask.id,optionId:"approve",source:"keeper",text:"Grant",why:"Covered",reversible:true});
 const events=f.k.store.events().filter(e=>["ask.answered","decision.made"].includes(e.type));
 const ctx={members:new Map([["lead",f.k.member("lead")!]]),characterName:()=>null,memberName:()=>"Wren",questShort:()=>"Quest",decisions:new Map<string,string>()};
 const lines=eventLines(events,ctx as never);expect(lines.some(l=>l.head.includes("Pre-approved by you at"))).toBe(true);
 for(const event of events){const line=describeEvent(event,ctx as never)!;expect(line.actor.kind).not.toBe("you");expect(line.head).not.toBe("formed the party");expect(line.head).not.toBe("answered");}
 expect(lines.filter(l=>l.filter==="decided" || l.detail?.includes("Use the credential")).every(l=>l.head.includes("delegated by you"))).toBe(true);
 expect(preapprovalWords({at:1700000000000,surface:"client (unattested)"})).not.toMatch(/T\d\d:|\(client \(unattested\)\)/);
});
it("does not infer plan safety from omitted declarations or accept pre-approved consent", async () => {
 const f=setup(),q=await seedQuest(f.k,"lead","Quest","Quest");f.k.authority.preapprove(q.id,{greenlight:{maxMembers:1,classes:["smith"]},placement:false,conclude:false,endsAt:null},receipt("preapproveQuest"));
 f.k.plan("lead",{...planInput(q.id),reversible:true});expect(f.k.quest(q.id).greenlitVersion).toBeNull();
 f.k.plan("lead",{...safe(q.id),waypoints:safe(q.id).waypoints.map(w=>({...w,acts:[{kind:"check",command:"kubectl delete namespace prod"}]}))} as never);expect(f.k.quest(q.id).greenlitVersion).toBeNull();
 f.k.plan("lead",safe(q.id) as never);const ask=f.k.store.query("asks","boardQuestId",q.id).find(a=>a.answer?.by==="preapproval")!;
 expect(ask).toBeTruthy();expect(()=>f.k.decide("lead",{boardQuestId:q.id,source:"ask",sourceRef:ask.id,text:"User agreed",why:"Consent",reversible:true})).toThrow(/user/);
});
it("uses Tavern’s typed option outcomes, never a caller’s misleading decline label", async () => {
 const f=setup(),q=await seedQuest(f.k,"lead","Quest","Quest");f.k.authority.delegate(q.id,"merge",receipt("delegateQuest"));
 expect(()=>f.k.ask("lead",{...request(q.id),kind:"merge",options:[{id:"delegate",label:"Fake delegation",detail:"",recommended:false}]})).toThrow(/reserved/);
 const ask=f.k.ask("lead",{...request(q.id),kind:"merge",target:{commit:"a".repeat(40)},options:[{id:"deny",label:"Merge it now",detail:"",recommended:true}]});
 expect(ask.options.find(o=>o.id==="deny")?.label).toBe("Decline the act");expect(ask.effect).toMatchObject({type:"decision",outcomes:[{optionId:"approve",outcome:"approve"},{optionId:"deny",outcome:"decline"}]});
 f.k.store.put("asks",ask.id,{...ask,effect:{type:"decision"}});
 expect(()=>f.k.decide("lead",{boardQuestId:q.id,askId:ask.id,optionId:"deny",source:"keeper",text:"Merge",why:"Misleading id",reversible:true})).toThrow(/Warden/);
});
it("allows terminal delegation with a terminal receipt and rejects a managed terminal", async()=>{
 const f=setup(),q=await seedQuest(f.k,"lead","Quest","Quest");const ask=f.k.ask("lead",request(q.id));
 await terminalUserAct({},"answerAsk",f.k.store,f.k.now,r=>f.runtime.answerAsk(ask.id,"delegate",null,"cli",true,"terminal",r));
 expect(f.k.quest(q.id).delegations?.[0]?.surface).toBe("terminal");
 expect(()=>terminalUserAct({threadId:"lead"},"delegateQuest",f.k.store,f.k.now,()=>{})).toThrow(/ordinary terminal/);
});
