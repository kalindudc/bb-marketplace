// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { NativeGuard } from "../../src/host/guard";
import { HostRegistry } from "../../src/host/registry";
import { guardLoaderSource } from "../../src/scope/install";

const roots: string[] = [];
afterEach(() => { delete (globalThis as Record<string, unknown>).__tavernGuardLoad; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(source = "export function tavernGuard(pi) { pi.on('tool_call', () => ({ block:true, reason:'fixture guard' })); }\n") {
  const root = mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES ?? tmpdir(), "tavern-native-guard-")); roots.push(root);
  const data = join(root, "data"), repo = join(root, "repo"), agentDir = join(root, "pi-agent"), artifactPath = join(root, "host.js");
  mkdirSync(data); mkdirSync(repo); writeFileSync(artifactPath, source);
  const registry = new HostRegistry(data), authority = { placementId:"placement", generation:1, endpointId:"member", operationId:"prepare" };
  registry.registerEndpoint({ placementId:authority.placementId,generation:authority.generation,endpointId:authority.endpointId, endpoint:{hostId:"native", environmentId:"env", root:repo}, ownerThreadId:"thread", git:"full" as const,access:"member-write", workspaceKind:"dedicated-machine", objectFormat:null, allowedRefs:["refs/heads/worker"] });
  const guard = new NativeGuard(registry, { artifactPath, agentDir }), input = { ...authority, ruleId:"rule", allowMarkedInstall:true };
  return { root, data, repo, registry, authority, artifactPath, agentDir, guard, input, shim:join(agentDir,"extensions/tavern-guard/index.ts"), source };
}
async function loadShim(file: string, scopeFile?: string) {
  const previous = process.env.TAVERN_SCOPE_FILE; scopeFile ? process.env.TAVERN_SCOPE_FILE = scopeFile : delete process.env.TAVERN_SCOPE_FILE;
  try {
    const source = readFileSync(file,"utf8"), module = await import("data:text/javascript;base64,"+Buffer.from(source).toString("base64"));
    const hooks = new Map<string, (...args: any[])=>any>();
    await module.default({ on:(name:string,fn:(...args:any[])=>any)=>hooks.set(name,fn),getActiveTools:()=>["bash","tavern_ready","journal"],setActiveTools:()=>{} });
    return hooks;
  } finally { previous === undefined ? delete process.env.TAVERN_SCOPE_FILE : process.env.TAVERN_SCOPE_FILE=previous; }
}
it("does not install or copy without this rule's opt-in", async()=>{
  const f=fixture(); expect(await f.guard.prepareGuard({...f.input,allowMarkedInstall:false})).toMatchObject({state:"unavailable",artifactDigest:null,warning:expect.stringMatching(/consent|authoriz|opt.in/i)});
  expect(existsSync(f.agentDir)).toBe(false); expect(existsSync(join(f.data,"guard-artifacts"))).toBe(false);
});
it("copies only the native host artifact and installs a marked loader, never an armed receipt",async()=>{
  const f=fixture(), result=await f.guard.prepareGuard(f.input), hash=createHash("sha256").update(f.source).digest("hex");
  expect(result).toMatchObject({state:"prepared",artifactDigest:hash,warning:null});
  expect(readFileSync(join(f.data,"guard-artifacts",hash+".mjs"),"utf8")).toBe(f.source);
  expect(readFileSync(f.shim,"utf8")).toContain(hash); expect(readFileSync(f.shim,"utf8")).toContain("tavernGuard");
  expect(readFileSync(f.shim,"utf8")).not.toContain(f.artifactPath); expect(existsSync(join(result.scopeDirectory,"scope.armed"))).toBe(false);
  expect(statSync(f.shim).mode&0o777).toBe(0o600);
});
it("is idempotent and can inspect an already current installation without new consent",async()=>{
  const f=fixture(), first=await f.guard.prepareGuard(f.input), before=statSync(f.shim).mtimeMs;
  expect(await f.guard.prepareGuard({...f.input,allowMarkedInstall:false})).toEqual(first); expect(statSync(f.shim).mtimeMs).toBe(before);
});
it("updates a marked loader on an authorized artifact revision and retains old bytes for live sessions",async()=>{
  const f=fixture(), first=await f.guard.prepareGuard(f.input); writeFileSync(f.artifactPath,f.source+"\n// new artifact\n");
  const second=await f.guard.prepareGuard(f.input); expect(second.state).toBe("prepared");expect(second.artifactDigest).not.toBe(first.artifactDigest);
  expect(existsSync(join(f.data,"guard-artifacts",first.artifactDigest+".mjs"))).toBe(true);
  expect(readFileSync(f.shim,"utf8")).toContain(second.artifactDigest!);
});
it("never overwrites an unmarked shim or copies an artifact for it",async()=>{
  const f=fixture();mkdirSync(dirname(f.shim),{recursive:true});writeFileSync(f.shim,"user extension\n");
  expect(await f.guard.prepareGuard(f.input)).toMatchObject({state:"unmarked"});expect(readFileSync(f.shim,"utf8")).toBe("user extension\n");expect(existsSync(join(f.data,"guard-artifacts"))).toBe(false);
});
it.each(["file","directory","extensions"])("refuses a symlinked %s installation without touching its foreign target",async kind=>{
  const f=fixture(), foreign=join(f.root,"foreign");mkdirSync(foreign); const sentinel=join(foreign,"index.ts");writeFileSync(sentinel,guardLoaderSource(f.artifactPath));
  if(kind==="extensions"){mkdirSync(f.agentDir);symlinkSync(foreign,join(f.agentDir,"extensions"));}
  else {mkdirSync(join(f.agentDir,"extensions"),{recursive:true});if(kind==="directory")symlinkSync(foreign,dirname(f.shim));else{mkdirSync(dirname(f.shim));symlinkSync(sentinel,f.shim);}}
  const before=readFileSync(sentinel,"utf8");expect(await f.guard.prepareGuard(f.input)).toMatchObject({state:"unmarked"});expect(readFileSync(sentinel,"utf8")).toBe(before);expect(readdirSync(foreign)).toEqual(["index.ts"]);
});
it("does not pretend a source TypeScript entry is a portable built host artifact",async()=>{
  const f=fixture(), artifactPath=join(f.root,"host.ts");writeFileSync(artifactPath,f.source);
  expect(await new NativeGuard(f.registry,{artifactPath,agentDir:f.agentDir}).prepareGuard(f.input)).toMatchObject({state:"unavailable",warning:expect.stringMatching(/built|artifact/i)});expect(existsSync(f.agentDir)).toBe(false);
});
it("proves the copied artifact can load its named guard without the source artifact",async()=>{
  const f=fixture();await f.guard.prepareGuard(f.input);rmSync(f.artifactPath);
  expect((await loadShim(f.shim)).size).toBe(0);
  const hooks=await loadShim(f.shim,join(f.root,"scope.json"));expect(hooks.get("tool_call")?.({toolName:"bash"})).toEqual({block:true,reason:"fixture guard"});
});
it("fails closed when immutable copied bytes are tampered, retaining emergency bootstrap tools",async()=>{
  const f=fixture(), prepared=await f.guard.prepareGuard(f.input), copy=join(f.data,"guard-artifacts",prepared.artifactDigest+".mjs");writeFileSync(copy,"export const tavernGuard=()=>{};\n");
  const hooks=await loadShim(f.shim,join(f.root,"missing.json"));expect(hooks.get("tool_call")?.({toolName:"bash"})).toMatchObject({block:true});expect(hooks.get("tool_call")?.({toolName:"tavern_ready"})).toBeUndefined();
  expect(await f.guard.prepareGuard(f.input)).toMatchObject({state:"failed"});expect(readFileSync(copy,"utf8")).toBe("export const tavernGuard=()=>{};\n");
});
it("does not publish prepared or write a shim after revocation during artifact module loading",async()=>{
  const f=fixture("globalThis.__tavernGuardLoad?.(); export function tavernGuard() {}\n");(globalThis as Record<string,unknown>).__tavernGuardLoad=()=>f.registry.revokePlacement({placementId:f.authority.placementId,generation:f.authority.generation,reason:"cancelled"});
  await expect(f.guard.prepareGuard(f.input)).rejects.toThrow(/revoked|aborted/i);expect(existsSync(f.shim)).toBe(false);
});
it("returns a visible failure for an artifact missing its named guard export",async()=>{
  const f=fixture("export default {};\n");expect(await f.guard.prepareGuard(f.input)).toMatchObject({state:"failed",warning:expect.stringContaining("tavernGuard")});expect(existsSync(f.shim)).toBe(false);
});
it("does not overwrite a user shim introduced while the artifact import awaits",async()=>{
  let loaded=false; const f=fixture("globalThis.__tavernGuardLoad?.(); export function tavernGuard() {}");
  (globalThis as Record<string,unknown>).__tavernGuardLoad=()=>{loaded=true;mkdirSync(dirname(f.shim),{recursive:true});writeFileSync(f.shim,"user arrived");};
  const result=await f.guard.prepareGuard(f.input);expect(loaded).toBe(true);expect(result).toMatchObject({state:"unmarked"});expect(readFileSync(f.shim,"utf8")).toBe("user arrived");
});
it("does not prepare bytes changed during the artifact import",async()=>{
  let loaded=false; const f=fixture("globalThis.__tavernGuardLoad?.(); export function tavernGuard() {}");
  (globalThis as Record<string,unknown>).__tavernGuardLoad=()=>{loaded=true;writeFileSync(join(f.data,"guard-artifacts",createHash("sha256").update(f.source).digest("hex")+".mjs"),"changed");};
  const result=await f.guard.prepareGuard(f.input);expect(loaded).toBe(true);expect(result).toMatchObject({state:"failed"});expect(existsSync(f.shim)).toBe(false);
});
it("does not return prepared after a late user shim replacement at the promise boundary",async()=>{
  const f=fixture(), original=f.registry.operation.bind(f.registry);
  f.registry.operation=async <T>(authority:Parameters<HostRegistry["operation"]>[0],signal:AbortSignal|undefined,work:(signal:AbortSignal)=>Promise<T>)=>{const result=await original(authority,signal,work);writeFileSync(f.shim,"late user file");return result;};
  expect(await f.guard.prepareGuard(f.input)).toMatchObject({state:"unmarked"});expect(readFileSync(f.shim,"utf8")).toBe("late user file");
});
it("honors pre-aborted requests without modifying the Pi directory",async()=>{
  const f=fixture();await expect(f.guard.prepareGuard(f.input,AbortSignal.abort())).rejects.toMatchObject({name:"AbortError"});expect(existsSync(f.agentDir)).toBe(false);
});
