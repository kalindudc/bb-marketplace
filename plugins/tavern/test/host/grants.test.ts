// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hostContract, type EndpointRegistration } from "../../src/host-contract";
import { HostRegistry } from "../../src/host/registry";

const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
  const root=realpathSync(mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES??tmpdir(),"tavern-grants-")));roots.push(root);const data=join(root,"data"),repo=join(root,"repo");mkdirSync(data);mkdirSync(repo);
  const registry=new HostRegistry(data),authority=(endpointId="source",generation=1)=>({placementId:"placement",generation,endpointId,operationId:"op"});
  const endpoint=(endpointId="source",generation=1):EndpointRegistration=>({placementId:"placement",generation,endpointId,endpoint:{hostId:"host",environmentId:null,root:repo},ownerThreadId:null,access:"source-read",workspaceKind:null,objectFormat:null,allowedRefs:[]});
  const batch=(endpoints:EndpointRegistration[],generation=1)=>({placementId:"placement",generation,operationId:"batch",endpoints});
  const bytes=()=>readdirSync(join(data,"authority")).sort().map(file=>[file,readFileSync(join(data,"authority",file),"utf8")]);
  return{root,data,repo,registry,authority,endpoint,batch,bytes};
}
it("declares strict bounded same-generation batches and authority-only releases",()=>{
  const f=fixture();expect(hostContract.registerEndpoints.input.parse(f.batch([f.endpoint()]))).toEqual(f.batch([f.endpoint()]));
  for(const endpoints of [[],Array.from({length:33},(_,i)=>f.endpoint(String(i))),[f.endpoint(),f.endpoint()],[f.endpoint(),f.endpoint("other",2)],[{...f.endpoint(),placementId:"other"}]])expect(hostContract.registerEndpoints.input.safeParse(f.batch(endpoints)).success).toBe(false);
  expect(hostContract.releaseEndpoint.input.safeParse({...f.authority(),root:f.repo}).success).toBe(false);expect(hostContract.releaseSnapshotRef.input.safeParse({...f.authority(),transferId:"x",ref:"refs/tavern/x"}).success).toBe(false);
});
it("publishes a complete batch once and accepts reordered immutable retries without consuming more slots",()=>{
  const f=fixture(),endpoints=[f.endpoint("a"),f.endpoint("b")];expect(f.registry.registerEndpoints(f.batch(endpoints))).toEqual({outcome:"registered",generation:1,endpointIds:["a","b"]});const before=f.bytes();
  expect(f.registry.registerEndpoints({...f.batch([...endpoints].reverse()),operationId:"retry"})).toEqual({outcome:"registered",generation:1,endpointIds:["b","a"]});expect(f.bytes()).toEqual(before);
  expect(new HostRegistry(f.data).endpoint(f.authority("a"))).toMatchObject({registration:endpoints[0]});
});
it("returns all-or-wait with NEW required slots and no partial grant or changed record",()=>{
  const f=fixture();for(let i=0;i<31;i++)f.registry.registerEndpoint(f.endpoint(String(i)));const before=f.bytes();
  expect(f.registry.registerEndpoints(f.batch([f.endpoint("0"),f.endpoint("new-a"),f.endpoint("new-b")]))).toEqual({outcome:"waiting",generation:1,active:31,required:2,limit:32});expect(f.bytes()).toEqual(before);
  for(const id of ["new-a","new-b"])expect(()=>f.registry.endpoint(f.authority(id))).toThrow(/endpoint-missing/);
  f.registry.releaseEndpoint(f.authority("1"));expect(f.registry.registerEndpoints(f.batch([f.endpoint("0"),f.endpoint("new-a"),f.endpoint("new-b")]))).toMatchObject({outcome:"registered"});
});
it("retains the legacy single-endpoint cap error and permits an existing retry at capacity",()=>{
  const f=fixture();for(let i=0;i<32;i++)f.registry.registerEndpoint(f.endpoint(String(i)));expect(f.registry.registerEndpoint(f.endpoint("0"))).toEqual({registered:true,generation:1});expect(()=>f.registry.registerEndpoint(f.endpoint("new"))).toThrow(/endpoint-limit/);
});
it("preflights every root and ownership claim before publishing any new endpoint",()=>{
  const f=fixture();expect(()=>f.registry.registerEndpoints(f.batch([f.endpoint("a"),{...f.endpoint("bad"),endpoint:{...f.endpoint().endpoint,root:join(f.root,"missing")}}]))).toThrow();expect(()=>f.registry.endpoint(f.authority("a"))).toThrow(/placement-missing|endpoint-missing/);
  const member=(id:string)=>({...f.endpoint(id),access:"member-write" as const,ownerThreadId:"thread",workspaceKind:"dedicated-machine" as const,endpoint:{...f.endpoint().endpoint,environmentId:"env"},allowedRefs:["refs/heads/worker"]});
  expect(()=>f.registry.registerEndpoints(f.batch([member("m1"),member("m2")]))).toThrow(/workspace-ownership/);expect(()=>f.registry.endpoint(f.authority("m1"))).toThrow(/placement-missing|endpoint-missing/);
});
it("does not admit identity changes or revive a tombstone even when the batch would otherwise wait",()=>{
  const f=fixture();for(let i=0;i<32;i++)f.registry.registerEndpoint(f.endpoint(String(i)));f.registry.releaseEndpoint(f.authority("0"));const before=f.bytes();
  expect(()=>f.registry.registerEndpoints(f.batch([f.endpoint("0"),f.endpoint("new-a"),f.endpoint("new-b")]))).toThrow(/endpoint-released/);
  expect(()=>f.registry.registerEndpoints(f.batch([{...f.endpoint("1"),ownerThreadId:"changed"},f.endpoint("new-a"),f.endpoint("new-b")]))).toThrow(/endpoint-conflict/);expect(f.bytes()).toEqual(before);
});
it("releases a known endpoint idempotently across restart, fences use and never deletes its source files",()=>{
  const f=fixture();writeFileSync(join(f.repo,"kept"),"user work");f.registry.registerEndpoint(f.endpoint());expect(f.registry.releaseEndpoint(f.authority())).toEqual({released:true});const restarted=new HostRegistry(f.data);expect(restarted.releaseEndpoint(f.authority())).toEqual({released:true});expect(()=>restarted.endpoint(f.authority())).toThrow(/endpoint-released/);expect(()=>restarted.registerEndpoint(f.endpoint())).toThrow(/endpoint-released/);expect(readFileSync(join(f.repo,"kept"),"utf8")).toBe("user work");
});
it("allows more than32 terminal historical IDs while keeping no more than32 active grants",()=>{
  const f=fixture();for(let i=0;i<40;i++){f.registry.registerEndpoint(f.endpoint(String(i)));f.registry.releaseEndpoint(f.authority(String(i)));}expect(f.registry.registerEndpoint(f.endpoint("current"))).toMatchObject({registered:true});expect(()=>new HostRegistry(f.data).registerEndpoint(f.endpoint("0"))).toThrow(/endpoint-released/);
});
it("refuses stale and unknown release authority rather than silently calling it released",()=>{
  const f=fixture();expect(()=>f.registry.releaseEndpoint(f.authority())).toThrow(/placement-missing/);f.registry.registerEndpoint(f.endpoint());expect(()=>f.registry.releaseEndpoint(f.authority("missing"))).toThrow(/endpoint-missing/);f.registry.registerEndpoint(f.endpoint("next",2));const before=f.bytes();expect(()=>f.registry.releaseEndpoint(f.authority())).toThrow(/stale-generation/);expect(f.bytes()).toEqual(before);
});
it("can close a current revoked grant after root loss without probing or freeing a newer generation",()=>{
  const f=fixture();f.registry.registerEndpoint(f.endpoint());f.registry.revokePlacement({placementId:"placement",generation:1,reason:"cancelled"});rmSync(f.repo,{recursive:true});expect(f.registry.releaseEndpoint(f.authority())).toEqual({released:true});expect(new HostRegistry(f.data).releaseEndpoint(f.authority())).toEqual({released:true});
});
it("does not close an endpoint with an active carry or silently discard its lease",()=>{
  const f=fixture();f.registry.registerEndpoint(f.endpoint());const file=readdirSync(join(f.data,"authority")).find(file=>file.endsWith(".json"))!,path=join(f.data,"authority",file),state=JSON.parse(readFileSync(path,"utf8"));state.endpoints[0].activeTransfer="carry";writeFileSync(path,JSON.stringify(state));expect(()=>f.registry.releaseEndpoint(f.authority())).toThrow(/endpoint-busy/);expect(JSON.parse(readFileSync(path,"utf8")).endpoints[0].activeTransfer).toBe("carry");
});
it("keeps per-endpoint admission busy until its operation drains but permits another endpoint to close",async()=>{
  const f=fixture();f.registry.registerEndpoints(f.batch([f.endpoint("a"),f.endpoint("b")]));let done!:()=>void;const pending=f.registry.operation(f.authority("a"),undefined,()=>new Promise<void>(resolve=>{done=resolve;}));
  try{expect(()=>f.registry.releaseEndpoint(f.authority("a"))).toThrow(/endpoint-busy/);expect(f.registry.releaseEndpoint(f.authority("b"))).toEqual({released:true});}finally{done();await pending;}
  expect(f.registry.releaseEndpoint(f.authority("a"))).toEqual({released:true});await expect(f.registry.operation(f.authority("a"),undefined,async()=>true)).rejects.toThrow(/endpoint-released/);
});
it("does not release files or claims when the caller cancelled the request",()=>{
  const f=fixture();f.registry.registerEndpoint(f.endpoint());const before=f.bytes();expect(()=>f.registry.releaseEndpoint(f.authority(),AbortSignal.abort())).toThrow(/aborted/);expect(()=>f.registry.registerEndpoints(f.batch([f.endpoint("new")]),AbortSignal.abort())).toThrow(/aborted/);expect(f.bytes()).toEqual(before);
});
it("does not publish partial grants if private claim preparation succeeds but the final state write fails",()=>{
  const f=fixture(),writer=f.registry as unknown as {write(file:string,value:unknown,check?:()=>void):void},original=writer.write.bind(writer);
  const member={...f.endpoint("member"),access:"member-write" as const,ownerThreadId:"thread",workspaceKind:"dedicated-machine" as const,endpoint:{...f.endpoint().endpoint,environmentId:"env"},allowedRefs:["refs/heads/worker"]};
  const home={...f.endpoint("home"),access:"home-import" as const,allowedRefs:["refs/tavern/snapshot"]},endpoints=[member,home];
  const spy=vi.spyOn(writer,"write").mockImplementation((file,value,check)=>{if(!file.endsWith("workspaces.json")&&!file.endsWith("refs.json"))throw new Error("fixture disk failure");return original(file,value,check);});
  expect(()=>f.registry.registerEndpoints(f.batch(endpoints))).toThrow("fixture disk failure");for(const endpoint of endpoints)expect(()=>f.registry.endpoint(f.authority(endpoint.endpointId))).toThrow(/placement-missing|endpoint-missing/);
  spy.mockRestore();expect(f.registry.registerEndpoints(f.batch(endpoints))).toMatchObject({outcome:"registered",endpointIds:["member","home"]});
});
it("fences cancellation immediately before the atomic batch publication rename",()=>{
  const f=fixture(),controller=new AbortController(),writer=f.registry as unknown as {write(file:string,value:unknown,check?:()=>void):void},original=writer.write.bind(writer);
  vi.spyOn(writer,"write").mockImplementation((file,value,check)=>{let count=0;return original(file,value,()=>{check?.();if(++count===2)controller.abort();check?.();});});
  expect(()=>f.registry.registerEndpoints(f.batch([f.endpoint("a"),f.endpoint("b")]),controller.signal)).toThrow(/aborted/);expect(()=>f.registry.endpoint(f.authority("a"))).toThrow(/placement-missing|endpoint-missing/);expect(readdirSync(join(f.data,"authority"))).toEqual([]);
});
it("endpoint release leaves its explicit scope files and workspace claim intact",()=>{
  const f=fixture(),member={...f.endpoint(),access:"member-write" as const,ownerThreadId:"thread",workspaceKind:"dedicated-machine" as const,endpoint:{...f.endpoint().endpoint,environmentId:"env"},allowedRefs:["refs/heads/worker"]};f.registry.registerEndpoint(member);
  const file=f.registry.scopeStatePath(f.authority(),"scope.json");writeFileSync(file,"owned policy");const claim=readFileSync(join(f.data,"authority/workspaces.json"),"utf8");f.registry.releaseEndpoint(f.authority());expect(readFileSync(file,"utf8")).toBe("owned policy");expect(f.registry.scopeStatePath(f.authority(),"scope.json")).toBe(file);expect(readFileSync(join(f.data,"authority/workspaces.json"),"utf8")).toBe(claim);
});
it("keeps old generation grants intact when a newer batch cannot fit or is invalid",()=>{
  const f=fixture();f.registry.registerEndpoint(f.endpoint());const before=f.bytes();expect(()=>f.registry.registerEndpoints(f.batch([{...f.endpoint("bad",2),endpoint:{...f.endpoint().endpoint,root:"relative"}}],2))).toThrow(/unsafe-root/);expect(f.bytes()).toEqual(before);expect(f.registry.endpoint(f.authority())).toBeDefined();
});
