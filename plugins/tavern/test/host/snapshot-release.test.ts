// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { EndpointRegistration, TransferRegistration } from "../../src/host-contract";
import * as gitHost from "../../src/host/git";
import { inspectHost } from "../../src/host/inspect";
import { onCheckout } from "../../src/host/context";
import { HostRegistry } from "../../src/host/registry";
import { createTransport } from "../../src/host/transport";
const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const git=(root:string,...args:string[])=>execFileSync("git",["-C",root,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
async function fixture(format:"sha1"|"sha256"="sha1"){
  const root=realpathSync(mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES??tmpdir(),"snapshot-release-")));roots.push(root);const repo=join(root,"repo"),data=join(root,"data");mkdirSync(repo);mkdirSync(data);git(repo,"init","-q","-b","main","--object-format="+format);git(repo,"config","user.name","Fixture");git(repo,"config","user.email","fixture@example.invalid");writeFileSync(join(repo,"tracked"),"tracked source\n");git(repo,"add","tracked");git(repo,"commit","-qm","base");writeFileSync(join(repo,"untracked"),"not an artifact\n");
  const base=git(repo,"rev-parse","HEAD"),tree=git(repo,"rev-parse","HEAD^{tree}"),ref="refs/tavern/snapshot",neighbor="refs/tavern/untouched";git(repo,"update-ref",neighbor,base);
  const registry=new HostRegistry(data),port=createTransport(registry),authority={placementId:"snapshot-owner",generation:1,endpointId:"home",operationId:"op"};
  const registration:EndpointRegistration={...authority,endpoint:{hostId:"host",environmentId:null,root:repo},ownerThreadId:null,git:"full" as const,access:"home-import",workspaceKind:null,objectFormat:format,allowedRefs:[ref]};delete (registration as Partial<typeof authority>).operationId;registry.registerEndpoint(registration);await inspectHost(registry,authority);
  const transfer:TransferRegistration={...authority,transferId:"transfer",snapshotId:"snapshot",direction:"bring-home",objectFormat:format,base,head:base,tree,fromEndpointId:"source",toEndpointId:"home",allowedRefs:[ref],uploads:[],artifacts:[]};registry.registerTransfer(transfer);
  const input={...authority,transferId:"transfer",author:{name:"Fixture",email:"fixture@example.invalid",date:"1700000000 +0000"},message:"captured immutable snapshot",refs:[ref],entries:[],remote:"origin",baseBranch:"main",networkTimeoutMs:3000};
  const capture=async(extra:Record<string,unknown>={})=>{const result=await port.importCommit({...input,...extra});if(result.outcome!=="ok")throw new Error("Fixture import failed");return result.sha;};
  const token={...authority,transferId:"transfer"},receipt=registry.transferPath(token,"import.json"),tip=()=>git(repo,"for-each-ref","--format=%(objectname)",ref);
  return{root,repo,data,base,tree,ref,neighbor,registry,port,authority,registration,transfer,input:token,captureInput:input,capture,receipt,tip};
}
it.each(["sha1","sha256"] as const)("CAS-deletes only the native completed import's single private ref (%s)",async format=>{
  const f=await fixture(format),index=readFileSync(join(f.repo,".git/index")),sha=await f.capture();expect(f.tip()).toBe(sha);expect(JSON.parse(readFileSync(f.receipt,"utf8")).refs).toEqual([f.ref]);
  expect(await f.port.releaseSnapshotRef(f.input)).toEqual({released:true});expect(f.tip()).toBe("");expect(git(f.repo,"rev-parse","HEAD")).toBe(f.base);expect(git(f.repo,"rev-parse",f.neighbor)).toBe(f.base);expect(readFileSync(join(f.repo,".git/index"))).toEqual(index);expect(readFileSync(join(f.repo,"tracked"),"utf8")).toBe("tracked source\n");expect(readFileSync(join(f.repo,"untracked"),"utf8")).toBe("not an artifact\n");
  expect(()=>f.registry.endpoint(f.authority)).toThrow(/snapshot-ref-released/);expect(()=>f.registry.registerTransfer({...f.transfer,transferId:"late"})).toThrow(/snapshot-ref-released/);await expect(f.port.importCommit(f.captureInput)).rejects.toThrow(/snapshot-ref-released/);
});
it("idempotently acknowledges a completed release after endpoint close, revocation, restart and root loss",async()=>{
  const f=await fixture();await f.capture();await f.port.releaseSnapshotRef(f.input);f.registry.releaseEndpoint(f.authority);f.registry.revokePlacement({placementId:f.authority.placementId,generation:1,reason:"terminal"});rmSync(f.repo,{recursive:true});expect(await createTransport(new HostRegistry(f.data)).releaseSnapshotRef(f.input)).toEqual({released:true});
});
it("never infers a cleanup ref or SHA from caller fields, a grant without an import, or an empty-ref import",async()=>{
  const f=await fixture();git(f.repo,"update-ref",f.ref,f.base);await expect(f.port.releaseSnapshotRef(f.input)).rejects.toThrow(/snapshot-release-proof/);expect(f.tip()).toBe(f.base);
  await f.capture({refs:[]});await expect(f.port.releaseSnapshotRef(f.input)).rejects.toThrow(/snapshot-release-proof/);expect(f.tip()).toBe(f.base);expect(f.registry.endpoint(f.authority)).toBeDefined();
});
it.each(["legacy","wrong-sha","wrong-tree","wrong-ref"])("holds %s completed-import proof without closing its grant or deleting a ref",async kind=>{
  const f=await fixture(),sha=await f.capture(),proof=JSON.parse(readFileSync(f.receipt,"utf8"));if(kind==="legacy")delete proof.refs;else if(kind==="wrong-sha")proof.sha="a".repeat(64);else if(kind==="wrong-tree")proof.tree="b".repeat(40);else proof.refs=[f.neighbor];writeFileSync(f.receipt,JSON.stringify(proof));await expect(f.port.releaseSnapshotRef(f.input)).rejects.toThrow(/snapshot-release-proof/);expect(f.tip()).toBe(sha);expect(f.registry.endpoint(f.authority)).toBeDefined();
});
it("requires a single-ref home-import/to-endpoint authority, not a source read grant or someone else's transfer",async()=>{
  const f=await fixture(),sha=await f.capture();f.registry.registerEndpoint({...f.registration,endpointId:"read",git:"full" as const,access:"source-read",allowedRefs:[]});await inspectHost(f.registry,{...f.authority,endpointId:"read"});f.registry.registerTransfer({...f.transfer,endpointId:"read",fromEndpointId:"read",allowedRefs:[]});await expect(f.port.releaseSnapshotRef({...f.input,endpointId:"read"})).rejects.toThrow(/endpoint-access|snapshot-release-authority/);await expect(f.port.releaseSnapshotRef({...f.input,transferId:"foreign"})).rejects.toThrow(/transfer-missing/);expect(f.tip()).toBe(sha);
});
it("holds a changed ref, closes ordinary admission, and resumes only the exact pinned CAS after reconciliation",async()=>{
  const f=await fixture(),sha=await f.capture();git(f.repo,"update-ref",f.ref,f.base);await expect(f.port.releaseSnapshotRef(f.input)).rejects.toThrow(/ref-changed/);expect(f.tip()).toBe(f.base);expect(()=>f.registry.endpoint(f.authority)).toThrow(/snapshot-ref-released/);expect(()=>f.registry.releaseEndpoint(f.authority)).toThrow(/endpoint-busy/);git(f.repo,"update-ref",f.ref,sha);expect(await f.port.releaseSnapshotRef(f.input)).toEqual({released:true});
});
it("uses Git's expected old SHA for the deletion even when the ref changes after its read",async()=>{
  const f=await fixture();await f.capture();const original=gitHost.runGit;let raced=false;vi.spyOn(gitHost,"runGit").mockImplementation((root,args,options)=>{if(args[0]==="update-ref"&&args.includes("-d")){raced=true;git(f.repo,"update-ref",f.ref,f.base);}return original(root,args,options);});await expect(f.port.releaseSnapshotRef(f.input)).rejects.toThrow(/snapshot-ref-cas/);expect(raced).toBe(true);expect(f.tip()).toBe(f.base);
});
it("does not follow an unexpected symbolic private ref into an ordinary branch",async()=>{
  const f=await fixture(),sha=await f.capture();git(f.repo,"update-ref","refs/heads/other",sha);git(f.repo,"symbolic-ref",f.ref,"refs/heads/other");await expect(f.port.releaseSnapshotRef(f.input)).rejects.toThrow(/ref-changed/);expect(git(f.repo,"rev-parse","refs/heads/other")).toBe(sha);expect(git(f.repo,"symbolic-ref",f.ref)).toBe("refs/heads/other");
});
it("uses no-deref at the actual CAS even if a symbolic private ref races its type check",async()=>{
  const f=await fixture(),sha=await f.capture(),original=gitHost.runGit;git(f.repo,"update-ref","refs/heads/other",sha);vi.spyOn(gitHost,"runGit").mockImplementation((root,args,options)=>{if(args[0]==="update-ref"&&args.includes("-d")){expect(args).toContain("--no-deref");git(f.repo,"symbolic-ref",f.ref,"refs/heads/other");}return original(root,args,options);});
  await f.port.releaseSnapshotRef(f.input).catch(error=>{expect(String(error)).toMatch(/snapshot-ref-cas/);});expect(git(f.repo,"rev-parse","refs/heads/other")).toBe(sha);expect(git(f.repo,"rev-parse","HEAD")).toBe(f.base);
});
it("retries claim cleanup from durable completion without another CAS even after root loss",async()=>{
  const f=await fixture();await f.capture();const writer=f.registry as unknown as {write(file:string,value:unknown,check?:()=>void):void},original=writer.write.bind(writer),spy=vi.spyOn(writer,"write").mockImplementation((file,value,check)=>{if(file.endsWith("refs.json"))throw new Error("fixture ref-claim disk error");return original(file,value,check);});
  await expect(f.port.releaseSnapshotRef(f.input)).rejects.toThrow("fixture ref-claim disk error");expect(f.tip()).toBe("");spy.mockRestore();rmSync(f.repo,{recursive:true});expect(await createTransport(new HostRegistry(f.data)).releaseSnapshotRef(f.input)).toEqual({released:true});expect(JSON.parse(readFileSync(join(f.data,"authority/refs.json"),"utf8"))).toEqual([]);
});
it("does not publish a release on abort after Git applied the CAS; retry reconciles the absent ref",async()=>{
  const f=await fixture();await f.capture();const original=gitHost.runGit,controller=new AbortController();const spy=vi.spyOn(gitHost,"runGit").mockImplementation(async(root,args,options)=>{const result=await original(root,args,options);if(args[0]==="update-ref"&&args.includes("-d"))controller.abort();return result;});await expect(f.port.releaseSnapshotRef(f.input,controller.signal)).rejects.toThrow(/aborted/);expect(f.tip()).toBe("");expect(()=>f.registry.releaseEndpoint(f.authority)).toThrow(/endpoint-busy/);spy.mockRestore();expect(await createTransport(new HostRegistry(f.data)).releaseSnapshotRef(f.input)).toEqual({released:true});
});
it("fences a newer generation arriving during a read and never deletes its ref",async()=>{
  const f=await fixture(),sha=await f.capture(),original=gitHost.runGit;let changed=false;vi.spyOn(gitHost,"runGit").mockImplementation(async(root,args,options)=>{const result=await original(root,args,options);if(!changed&&args[0]==="show-ref"){changed=true;f.registry.registerEndpoint({...f.registration,generation:2,endpointId:"new"});}return result;});await expect(f.port.releaseSnapshotRef(f.input)).rejects.toThrow(/stale-generation/);expect(changed).toBe(true);expect(f.tip()).toBe(sha);await expect(f.port.releaseSnapshotRef(f.input)).rejects.toThrow(/stale-generation/);
});
it("allows known current cleanup after revocation without reopening general native access",async()=>{
  const f=await fixture();await f.capture();f.registry.revokePlacement({placementId:f.authority.placementId,generation:1,reason:"terminal"});expect(()=>f.registry.endpoint(f.authority)).toThrow(/placement-revoked/);expect(await f.port.releaseSnapshotRef(f.input)).toEqual({released:true});expect(f.tip()).toBe("");expect(()=>f.registry.endpoint(f.authority)).toThrow(/placement-revoked/);
});
it("closes ordinary admission before waiting behind another checkout operation",async()=>{
  const f=await fixture();await f.capture();let drain!:()=>void;const block=onCheckout(f.registry.endpoint(f.authority).inspection!.commonDir,new AbortController().signal,()=>new Promise<void>(resolve=>{drain=resolve;}));await vi.waitFor(()=>expect(drain).toBeTypeOf("function"));
  const pending=f.port.releaseSnapshotRef(f.input);try{expect(()=>f.registry.endpoint(f.authority)).toThrow(/snapshot-ref-released/);}finally{drain();await block;await pending;}
});
it("refuses cleanup while a native endpoint operation is still active, then succeeds after it drains",async()=>{
  const f=await fixture();await f.capture();let done!:()=>void;const pending=f.registry.operation(f.authority,undefined,()=>new Promise<void>(resolve=>{done=resolve;}));try{await expect(f.port.releaseSnapshotRef(f.input)).rejects.toThrow(/endpoint-busy/);expect(f.registry.endpoint(f.authority)).toBeDefined();}finally{done();await pending;}expect(await f.port.releaseSnapshotRef(f.input)).toEqual({released:true});
});
it("does not delete another active native grant's alias of the same private ref",async()=>{
  const f=await fixture(),sha=await f.capture();f.registry.registerEndpoint({...f.registration,endpointId:"alias"});await expect(f.port.releaseSnapshotRef(f.input)).rejects.toThrow(/ref-ownership|endpoint-busy/);expect(f.tip()).toBe(sha);f.registry.releaseEndpoint({...f.authority,endpointId:"alias"});expect(await f.port.releaseSnapshotRef(f.input)).toEqual({released:true});expect(()=>f.registry.registerEndpoint({...f.registration,endpointId:"resurrect"})).toThrow(/snapshot-ref-released/);
});
it("frees only its own ref claims and never touches a later owner's ref on an idempotent retry",async()=>{
  const f=await fixture(),sha=await f.capture();await f.port.releaseSnapshotRef(f.input);f.registry.registerEndpoint({...f.registration,placementId:"another-owner",endpointId:"new"});git(f.repo,"update-ref",f.ref,sha);expect(await f.port.releaseSnapshotRef(f.input)).toEqual({released:true});expect(f.tip()).toBe(sha);const claims=JSON.parse(readFileSync(join(f.data,"authority/refs.json"),"utf8"));expect(claims.some((claim:{placementId:string})=>claim.placementId==="another-owner")).toBe(true);
});
it("honors a pre-aborted cleanup without closing its ordinary grant or touching Git",async()=>{
  const f=await fixture(),sha=await f.capture();await expect(f.port.releaseSnapshotRef(f.input,AbortSignal.abort())).rejects.toThrow(/aborted/);expect(f.registry.endpoint(f.authority)).toBeDefined();expect(f.tip()).toBe(sha);
});
