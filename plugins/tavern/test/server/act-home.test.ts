// @vitest-environment node
import { expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeRebaseMatches } from "../../src/server/act-patch";
import * as patches from "../../src/server/act-patch";
import { setup } from "./runtime-fixture";
import { seedQuest } from "./support";
import { makeThreadResponse } from "./host";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

it.each([false,true])("prepares a one-use proof using SDK home identity, not maker remotes (cross-repo %s)", async crossRepo => {
 const storage=createFakePluginHost({pluginId:"tavern"});
 const replay=vi.spyOn(patches,"homeRebaseMatches").mockReturnValue(true),makerProject=crossRepo?"other":"project";
 const f=setup({threads:{get:async ({threadId}:{threadId:string})=>makeThreadResponse({id:threadId,projectId:threadId==="maker"?makerProject:"project",environmentId:"env"})},environments:{get:async()=>({id:"env",hostId:"host",isWorktree:true,path:"/maker"})},projects:{get:async()=>({gitRemoteUrl:"https://example.com/trusted.git",sources:[{hostId:"host",path:"/user-home",isDefault:true}]})}});
 Object.assign(f.bb,{storage:storage.bb.storage});
 try {
  const q=await seedQuest(f.k,"lead","Quest","Quest");f.k.bind("checker","warden","vex","project");const w=f.k.member("checker")!;f.k.store.put("members",w.threadId,{...w,role:"member",keeperThreadId:"lead",boardQuestId:q.id,checkerMakerThreadId:"maker"});
  const ask=f.k.ask("lead",{boardQuestId:q.id,kind:"merge",effect:{type:"decision"},question:"Merge?",why:"Ready",options:[{id:"approve",label:"Approve",detail:"",recommended:false}],meanwhile:"Wait",holds:[],target:{commit:"b".repeat(40)}});
  f.k.store.put("actVerdicts",ask.id,{wardenThreadId:"checker",entryId:"entry",at:f.k.now(),target:{commit:"a".repeat(40)}});
  await f.runtime.prepareActDecision(ask.id);
  expect(replay).toHaveBeenCalledWith("/maker",{root:crossRepo?null:"/user-home",remoteUrl:"https://example.com/trusted.git",dataDir:expect.stringMatching(/merge-proofs$/)},"a".repeat(40),"b".repeat(40));
  expect(f.k.authority.rebaseMatches.get(ask.id)).toEqual({verifiedCommit:"a".repeat(40),commit:"b".repeat(40)});
  expect(()=>f.k.authority.assertVerdict(ask)).toThrow(/Warden/);expect(f.k.authority.rebaseMatches.has(ask.id)).toBe(false);
 }finally{replay.mockRestore();await storage.harness.lifecycle.dispose();}
});
it.each([false, true])("resolves the real home-side destination, refusing R5's forged maker ref (%s)", forged => {
 const dir=mkdtempSync(join(tmpdir(),"tavern-home-probe-")), maker=join(dir,"maker"), home=join(dir,"home"), remote=join(dir,"remote.git"), data=join(dir,"private");mkdirSync(maker);
 const git=(root:string,...args:string[])=>execFileSync("git",["-C",root,...args],{encoding:"utf8",stdio:["pipe","pipe","pipe"]}).trim();
 const commit=(file:string,body:string)=>{writeFileSync(join(maker,file),body);git(maker,"add",".");git(maker,"commit","-qm",file);return git(maker,"rev-parse","HEAD");};
 try {
  git(maker,"init","-q","-b","main");git(maker,"config","user.name","T");git(maker,"config","user.email","t@e.t");const base=commit("base","base\n");
  git(dir,"init","-q","--bare",remote);git(remote,"symbolic-ref","HEAD","refs/heads/main");git(maker,"push",remote,"HEAD:refs/heads/main");git(dir,"clone","-q",remote,home);
  const a=commit("config","safe\n"),verified=commit("feature","feature\n");git(maker,"checkout","-q","--detach",base);const upstream=commit("other","upstream\n");git(maker,"push",remote,"HEAD:refs/heads/main");
  const fake=forged?commit("backdoor","unreviewed destructive line\n"):upstream;git(maker,"update-ref","refs/remotes/origin/HEAD",fake);git(maker,"cherry-pick",a,verified);const tip=git(maker,"rev-parse","HEAD");
  const refs=git(home,"show-ref"), index=readFileSync(join(home,".git","index")), head=readFileSync(join(home,".git","HEAD"));
  expect(homeRebaseMatches(maker,{root:home,remoteUrl:remote,dataDir:data},verified,tip)).toBe(!forged);
  expect(git(home,"show-ref")).toBe(refs);expect(readFileSync(join(home,".git","index"))).toEqual(index);expect(readFileSync(join(home,".git","HEAD"))).toEqual(head);expect(()=>git(home,"cat-file","-e",`${upstream}^{commit}`)).toThrow();expect(readdirSync(data)).toEqual([]);
  writeFileSync(join(maker,"dirty"),"uncommitted");expect(homeRebaseMatches(maker,{root:home,remoteUrl:remote,dataDir:data},verified,tip)).toBe(false);rmSync(join(maker,"dirty"));
  git(maker,"update-ref","-d","refs/remotes/origin/HEAD");
  expect(homeRebaseMatches(maker,{root:home,remoteUrl:remote,dataDir:data},verified,tip)).toBe(!forged);
  expect(homeRebaseMatches(maker,{root:null,remoteUrl:remote,dataDir:data},verified,tip)).toBe(!forged);
  git(remote,"symbolic-ref","HEAD","refs/heads/missing");expect(homeRebaseMatches(maker,{root:home,remoteUrl:remote,dataDir:data},verified,tip)).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
