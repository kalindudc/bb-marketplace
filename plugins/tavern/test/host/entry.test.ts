// @vitest-environment node
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import rootEntry, { tavernGuard } from "../../host";
import { createTavernHostEntry } from "../../src/host/entry";
import { createHostPort } from "../../src/host/client";
import { hostContract, type HostMethod } from "../../src/host-contract";
import * as gitHost from "../../src/host/git";
import { runProcess } from "../../src/host/process";
import { scopeForClass } from "../../src/scope/presets";
import { countGitLaunches, settleGitConfigClock } from "../git-launch-count";

const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const root of roots.splice(0)){await killFixtureChildren(root);rmSync(root,{recursive:true,force:true});}});
function fixture() {
  const root=realpathSync(mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES??tmpdir(),"tavern-native-entry-")));roots.push(root);
  const data=join(root,"data"),repo=join(root,"repo"),home=join(root,"home"),scratch=join(root,"scratch"),agent=join(home,"pi"),artifactPath=join(root,"host.js");
  for(const file of [data,repo,home,scratch])mkdirSync(file);writeFileSync(artifactPath,"export function tavernGuard() {}\n");
  const git=(...args:string[])=>execFileSync("git",["-C",repo,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  git("init","-q","-b","tavern/member");git("config","user.name","Fixture");git("config","user.email","fixture@example.invalid");writeFileSync(join(repo,"tracked"),"initial");git("add","tracked");git("commit","-qm","initial");
  const entry=createTavernHostEntry({artifactPath,paths:{home,tmp:[scratch],piAgentDir:agent}}), harness=experimental_createHostEntryHarness(entry,{experimental_paths:{dataDir:data,tempDir:scratch}});
  const authority={placementId:"placement",generation:1,endpointId:"member",operationId:"call"};
  const endpoint={placementId:"placement",generation:1,endpointId:"member",endpoint:{hostId:"guest",environmentId:"env",root:repo},ownerThreadId:"thread",git:"full" as const,access:"member-write" as const,workspaceKind:"dedicated-machine" as const,objectFormat:"sha1" as const,allowedRefs:["refs/heads/tavern/member"]};
  const register=()=>harness.experimental_call("registerEndpoint",endpoint);
  const input=()=>{const template={...scopeForClass("smith"),threadId:"thread",issuedAt:1234};template.env.variables={HOME:"/controller/home",TMPDIR:"/controller/tmp"};const scopeFileJson=JSON.stringify({...template,bindingTemplate:template,workspaceBinding:{kind:"dedicated-machine",hostId:"guest",environmentId:"env",root:repo,placementId:"placement",generation:1,snapshotId:"snapshot",expectedTree:git("rev-parse","HEAD^{tree}")}})+"\n";return{...authority,revision:1,scopeDigest:createHash("sha256").update(scopeFileJson).digest("hex"),scopeFileJson};};
  return{root,data,repo,home,scratch,agent,artifactPath,entry,harness,authority,endpoint,register,input,git};
}
it("exports a complete inert SDK host entry, its guard and the actual manifest field",()=>{
  expect(rootEntry.experimental_apiVersion).toBe(1);expect(Object.keys(rootEntry.handlers).sort()).toEqual(Object.keys(hostContract).sort());expect(typeof tavernGuard).toBe("function");
  expect(JSON.parse(readFileSync(resolve("package.json"),"utf8")).bb.host).toBe("./host.ts");
});
it("creates no native authority files until the first authenticated handler context",async()=>{
  const f=fixture();expect(existsSync(join(f.data,"authority"))).toBe(false);expect(existsSync(f.agent)).toBe(false);await f.harness.experimental_dispose();expect(existsSync(join(f.data,"authority"))).toBe(false);
});
it("routes real native register/inspect/state through the official SDK harness",async()=>{
  const f=fixture();try{await f.register();const inspected=await f.harness.experimental_call("inspect",f.authority);expect(inspected).toMatchObject({root:f.repo,branch:"tavern/member",objectFormat:"sha1"});expect(await f.harness.experimental_call("worktreeState",{...f.authority,base:"HEAD"})).toMatchObject({head:f.git("rev-parse","HEAD"),dirty:false});expect(existsSync(f.agent)).toBe(false);}finally{await f.harness.experimental_dispose();}
});
it("bounds Git launches for inspect, prepareCall and a dirty snapshot", async () => {
  const f = fixture();
  settleGitConfigClock();
  try {
    await f.register();
    const count = countGitLaunches();
    await f.harness.experimental_call("inspect", f.authority);
    count("inspect", 24);
    await f.harness.experimental_call("bindScope", f.input());
    count("bindScope", 4);
    const prepare = () => f.harness.experimental_call("prepareCall", { ...f.authority, scopeRevision: 1, call: { kind: "bash", toolName: "bash", input: { command: "pwd" }, cwd: f.repo } });
    await prepare();
    count("prepareCall", 2);
    writeFileSync(join(f.repo, "dirty"), "untracked");
    const snapshot = await f.harness.experimental_call("snapshotWorktree", { ...f.authority, base: f.git("rev-parse", "HEAD") });
    expect(snapshot).toMatchObject({ includesUncommitted: true, untrackedPaths: 1 });
    count("dirty snapshot", 30);
    f.git("checkout", "-qb", "other");
    await expect(prepare()).rejects.toThrow(/branch-mismatch/);
    f.git("checkout", "-q", "tavern/member");
    const replacement = join(f.root, "replacement-git");
    renameSync(join(f.repo, ".git"), replacement);
    writeFileSync(join(f.repo, ".git"), `gitdir: ${replacement}\n`);
    await expect(prepare()).rejects.toThrow(/repository-replaced/);
  } finally { await f.harness.experimental_dispose(); }
}, 900_000);
it("routes atomic batch waiting and terminal endpoint release through the SDK harness",async()=>{
  const f=fixture(),read=(endpointId:string)=>({...f.endpoint,endpointId,git:"full" as const,access:"source-read" as const,allowedRefs:[],ownerThreadId:null,workspaceKind:null}),batch=(ids:string[])=>({placementId:"placement",generation:1,operationId:"batch",endpoints:ids.map(read)});
  try{expect(await f.harness.experimental_call("registerEndpoints",batch(Array.from({length:31},(_,i)=>String(i))))).toMatchObject({outcome:"registered"});expect(await f.harness.experimental_call("registerEndpoints",batch(["0","new-a","new-b"]))).toEqual({outcome:"waiting",generation:1,active:31,required:2,limit:32});
    expect(await f.harness.experimental_call("releaseEndpoint",{...f.authority,endpointId:"1"})).toEqual({released:true});expect(await f.harness.experimental_call("releaseEndpoint",{...f.authority,endpointId:"1"})).toEqual({released:true});expect(await f.harness.experimental_call("registerEndpoints",batch(["new-a","new-b"]))).toMatchObject({outcome:"registered",endpointIds:["new-a","new-b"]});await expect(f.harness.experimental_call("registerEndpoints",batch(["1"]))).rejects.toThrow(/endpoint-released/);
  }finally{await f.harness.experimental_dispose();}
});
it("round-trips completed-import CAS cleanup and grant release through the real client and SDK entry",async()=>{
  const f=fixture(),server=createFakePluginHost({pluginId:"tavern",experimental_hostEntry:true,experimental_callHostRpc:async({method,input,signal})=>f.harness.experimental_call(method as HostMethod,input as never,{signal})}),port=createHostPort(server.bb),token={...f.authority,endpointId:"home",transferId:"transfer"},ref="refs/tavern/snapshot";
  const home={...f.endpoint,endpointId:"home",git:"full" as const,access:"home-import" as const,ownerThreadId:null,workspaceKind:null,allowedRefs:[ref]},source={...home,endpointId:"source",git:"full" as const,access:"source-read" as const,allowedRefs:[]};
  try{await port.call("guest","registerEndpoints",{placementId:"placement",generation:1,operationId:"batch",endpoints:[source,home]});await port.call("guest","inspect",{...f.authority,endpointId:"home"});const base=f.git("rev-parse","HEAD"),tree=f.git("rev-parse","HEAD^{tree}");await port.call("guest","registerTransfer",{...token,snapshotId:"snapshot",direction:"bring-home",objectFormat:"sha1",base,head:base,tree,fromEndpointId:"source",toEndpointId:"home",allowedRefs:[ref],uploads:[],artifacts:[]});await port.call("guest","importCommit",{...token,remote:"origin",baseBranch:"tavern/member",networkTimeoutMs:3000,refs:[ref],entries:[],author:{name:"Fixture",email:"fixture@example.invalid",date:"1700000000 +0000"},message:"snapshot"});
    expect(await port.call("guest","releaseSnapshotRef",token)).toEqual({released:true});expect(f.git("for-each-ref","--format=%(refname)",ref)).toBe("");for(const endpointId of ["home","source"])expect(await port.call("guest","releaseEndpoint",{...f.authority,endpointId})).toEqual({released:true});expect(await port.call("guest","releaseSnapshotRef",token)).toEqual({released:true});
  }finally{await server.harness.lifecycle.dispose();await f.harness.experimental_dispose();}
});
it("round-trips the server client to the real native entry with exact delivery bytes",async()=>{
  const f=fixture();const server=createFakePluginHost({pluginId:"tavern",experimental_hostEntry:true,experimental_callHostRpc:async({hostId,method,input,signal})=>{expect(hostId).toBe("guest");return f.harness.experimental_call(method as HostMethod,input as never,{signal});}});
  try{const port=createHostPort(server.bb);await port.call("guest","registerEndpoint",f.endpoint);await port.call("guest","inspect",f.authority);const input=f.input(),ack=await port.call("guest","bindScope",input);expect(ack.variables).toMatchObject({HOME:f.home,TMPDIR:f.scratch});expect(ack.scopeFile.startsWith(f.data+"/")).toBe(true);expect(input.scopeFileJson.endsWith("\n")).toBe(true);expect(await port.call("guest","prepareCall",{...f.authority,scopeRevision:1,call:{kind:"bash",toolName:"bash",input:{command:"git push origin main"},cwd:f.repo}})).toMatchObject({scopeDigest:input.scopeDigest,decision:{allow:false}});expect(await port.call("guest","sessionStatus",{...f.authority,revision:1,scopeDigest:input.scopeDigest})).toMatchObject({state:"not-observed"});expect(server.harness.experimental_hostRpcCalls.find(call=>call.method==="bindScope")?.input).toMatchObject({scopeFileJson:input.scopeFileJson});}finally{await server.harness.lifecycle.dispose();await f.harness.experimental_dispose();}
});
it("forwards scope release after revoke without treating it as member process-stop proof",async()=>{
  const f=fixture();try{await f.register();await f.harness.experimental_call("inspect",f.authority);const ack=await f.harness.experimental_call("bindScope",f.input());expect(await f.harness.experimental_call("revokePlacement",{placementId:"placement",generation:1,reason:"cancelled"})).toEqual({revoked:true,generation:1});expect(await f.harness.experimental_call("releaseScope",f.authority)).toEqual({released:true});expect(existsSync(ack.scopeFile)).toBe(false);await expect(f.harness.experimental_call("prepareCall",{...f.authority,scopeRevision:1,call:{kind:"bash",toolName:"bash",input:{command:"pwd"},cwd:f.repo}})).rejects.toThrow(/revoked/);}finally{await f.harness.experimental_dispose();}
});
it("keeps prepareGuard a consented preparation observation, never session arming",async()=>{
  const f=fixture();try{await f.register();expect(await f.harness.experimental_call("prepareGuard",{...f.authority,ruleId:"rule",allowMarkedInstall:false})).toMatchObject({state:"unavailable"});expect(existsSync(f.agent)).toBe(false);const prepared=await f.harness.experimental_call("prepareGuard",{...f.authority,ruleId:"rule",allowMarkedInstall:true});expect(prepared).toMatchObject({state:"prepared",artifactDigest:expect.any(String)});expect(existsSync(join(prepared.scopeDirectory,"scope.armed"))).toBe(false);}finally{await f.harness.experimental_dispose();}
});
it("blocks guard preparation for a source-read grant rather than downgrading wrong ownership to a warning",async()=>{
  const f=fixture();try{await f.harness.experimental_call("registerEndpoint",{...f.endpoint,git:"full" as const,access:"source-read",allowedRefs:[],ownerThreadId:null,workspaceKind:null});await expect(f.harness.experimental_call("prepareGuard",{...f.authority,ruleId:"rule",allowMarkedInstall:true})).rejects.toThrow(/endpoint-access/);expect(existsSync(f.agent)).toBe(false);}finally{await f.harness.experimental_dispose();}
});
it("rejects invalid DTOs before creating native authority or probing files",async()=>{
  const f=fixture();try{await expect(f.harness.experimental_call("registerEndpoint",{...f.endpoint,extra:true} as never)).rejects.toThrow();expect(existsSync(join(f.data,"authority"))).toBe(false);}finally{await f.harness.experimental_dispose();}
});
it("refuses a second host data directory on one worker instead of probing the other host's paths",async()=>{
  const f=fixture(),other=join(f.root,"other-data");mkdirSync(other);const second=experimental_createHostEntryHarness(f.entry,{experimental_paths:{dataDir:other,tempDir:f.scratch}});
  try{await f.register();await expect(second.experimental_call("registerEndpoint",f.endpoint)).rejects.toThrow(/host-paths|data directory/i);expect(existsSync(join(other,"authority"))).toBe(false);}finally{await second.experimental_dispose();await f.harness.experimental_dispose();}
});
it("rejects new calls on an already disposed entry even through a new fake worker",async()=>{
  const f=fixture();await f.register();await f.harness.experimental_dispose();const second=experimental_createHostEntryHarness(f.entry,{experimental_paths:{dataDir:f.data,tempDir:f.scratch}});try{await expect(second.experimental_call("inspect",f.authority)).rejects.toThrow(/disposed|closed|aborted/i);}finally{await second.experimental_dispose();}
});
function fixtureChildSource(directory:string) {
  return `process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(require("node:path").join(${JSON.stringify(directory)},process.pid+".pid"),String(process.pid));setInterval(()=>{},100);`;
}
async function killFixtureChildren(root:string) {
  const directory=join(root,"fixture-children");if(!existsSync(directory))return;
  const killed:number[]=[];
  for(const file of readdirSync(directory)){
    if(!/^\\d+\\.pid$/.test(file))continue;const pid=Number(readFileSync(join(directory,file),"utf8"));if(!Number.isSafeInteger(pid)||pid<=1)throw new Error("Invalid fixture child PID");
    let command:string;try{command=execFileSync("ps",["-ww","-p",String(pid),"-o","command="],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});}catch(error){try{process.kill(pid,0);}catch(gone){if((gone as NodeJS.ErrnoException).code==="ESRCH")continue;throw gone;}throw error;}
    if(!command.includes(directory))continue;
    try{process.kill(process.platform==="win32"?pid:-pid,"SIGKILL");killed.push(pid);}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}
  }
  await vi.waitFor(()=>{for(const pid of killed){try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")continue;throw error;}throw new Error(`Fixture child ${pid} is still alive after SIGKILL`);}},{timeout:5000,interval:20});
}
it("the afterEach reaper SIGKILLs every fixture sibling on an assertion-failure path",async()=>{
  const f=fixture(),directory=join(f.root,"fixture-children");mkdirSync(directory);
  const children=[1,2].map(()=>runProcess(process.execPath,["-e",fixtureChildSource(directory)],{timeoutMs:15_000}));
  await vi.waitFor(()=>expect(readdirSync(directory)).toHaveLength(2),{timeout:5000,interval:20});
  await expect((async()=>{try{throw new Error("simulated assertion failure");}finally{await killFixtureChildren(f.root);}})()).rejects.toThrow("simulated assertion failure");
  expect((await Promise.all(children)).map(child=>child.code)).toEqual([null,null]);await f.harness.experimental_dispose();
});
async function heldChild(f:ReturnType<typeof fixture>) {
  const directory=join(f.root,"fixture-children");mkdirSync(directory);
  vi.spyOn(gitHost,"runGit").mockImplementation(async(_root,_args,options)=>{const result=await runProcess(process.execPath,["-e",fixtureChildSource(directory)],{signal:options.signal,timeoutMs:15_000});if(result.code===null)throw new Error("Fixture child had no exit code");return{code:result.code,stdout:result.stdout,stderr:result.stderr};});
  const pending=f.harness.experimental_call("inspect",f.authority).catch(error=>error);
  await vi.waitFor(()=>expect(readdirSync(directory).length).toBeGreaterThan(0),{timeout:5000,interval:20});return{pending,pid:Number(readFileSync(join(directory,readdirSync(directory)[0]!),"utf8"))};
}
it("aborts and DRAINS a SIGTERM-ignoring native child within the worker's five-second dispose budget",async()=>{
  const f=fixture();await f.register();let child:Awaited<ReturnType<typeof heldChild>>|undefined;try{child=await heldChild(f);const start=Date.now();await f.harness.experimental_dispose();expect(Date.now()-start).toBeLessThan(4000);expect(()=>process.kill(child!.pid,0)).toThrow();expect(await child.pending).toBeInstanceOf(Error);}finally{await f.harness.experimental_dispose();if(child){try{process.kill(-child.pid,"SIGKILL");}catch{}}}
},20_000);
it("revokes and drains only the registered generation's native operations before replying",async()=>{
  const f=fixture();await f.register();let child:Awaited<ReturnType<typeof heldChild>>|undefined;try{child=await heldChild(f);expect(await f.harness.experimental_call("revokePlacement",{placementId:"placement",generation:1,reason:"cancelled"})).toEqual({revoked:true,generation:1});expect(()=>process.kill(child!.pid,0)).toThrow();expect(await child.pending).toBeInstanceOf(Error);}finally{await f.harness.experimental_dispose();if(child){try{process.kill(-child.pid,"SIGKILL");}catch{}}}
},20_000);
