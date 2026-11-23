// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MemberIdentity, memberIdentityWords } from "../../../src/ui/kit/member-identity";
import { fixtureMember, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { bindPaths } from "../../../src/scope/paths";
import { scopeForClass } from "../../../src/scope/presets";
import type { ThreadDecor } from "../../../src/shared/contract";

afterEach(cleanup);
function fixture(classId: string, label: string) {
 const member={...fixtureMember,role:"member" as const,classId,displayName:"Pip II"};
 const plain = classId === "smith" ? "builder" : classId === "ranger" ? "scout" : "general";
 const registry={...fixtureRegistry,classes:[{...fixtureRegistry.classes[0]!,id:classId,label,plain,description:"Keeps the work moving."}]};
 const scope: NonNullable<ThreadDecor["scope"]>={threadId:member.threadId,scope:scopeForClass(classId),armed:true,error:null,pendingAskId:null,mode:"enforce"};
 return {member,registry,scope};
}
it.each([["keeper","Keeper","open","anywhere"],["wanderer","Wanderer","open","anywhere"],["smith","Smith","worktree","its worktree, temp and its own storage"],["ranger","Ranger","readonly","temp and its own storage"]])("shows %s class, role and scope words",(id,label,preset,writes)=>{
 const f=fixture(id!,label!); const v=render(<MemberIdentity {...f} />);
 expect(v.container.textContent).toContain("Pip II"); expect(v.container.textContent).toContain(label);
 expect(v.container.textContent).toContain("Keeps the work moving."); expect(v.container.textContent).toContain(`scope: ${preset}`);
 expect(v.container.textContent).toContain(`writes: ${writes}`); expect(v.container.textContent).toContain("network: allowed");
 expect(v.container.textContent).toContain("GitHub:"); expect(v.container.textContent).toContain(preset === "open" ? "only protected files guarded" : "enforced");
 expect(v.container.querySelector("svg")?.getAttribute("width")).toBe("32");
 expect(memberIdentityWords(f.member,f.registry,f.scope)).toBe(`Pip II, ${label} (${f.registry.classes[0]!.plain}) · scope: ${preset} · ${preset === "open" ? "only protected files guarded" : "enforced"}`);
});
it("does not claim enforcement for missing, unarmed, watch, off or detection-only guards",()=>{
 const f=fixture("smith","Smith");
 for(const [scope,word] of [[undefined,"arm receipt not recorded"],[{...f.scope,armed:false},"arm receipt not recorded"],[{...f.scope,armed:false,guardCheckFailed:true},"not armed yet"],[{...f.scope,mode:"watch"},"watch only"],[{...f.scope,mode:"off"},"off"],[{...f.scope,guardPosture:{providerId:"pi",mode:"detection-only",label:"watched",approvalAskId:null}},"watch only"]] as const){
 const v=render(<MemberIdentity {...f} scope={scope} />); expect(v.container.textContent).toContain(word); v.unmount();
 }
});
it("names unscoped solo threads without promising a future guard",()=>{
 const f=fixture("wanderer","Wanderer"); const v=render(<MemberIdentity {...f} member={{...f.member,role:"solo"}} scope={null} />);
 expect(v.container.textContent).toContain("no Tavern guard (started by you)");
 expect(v.container.textContent).not.toContain("not armed yet");
});
it.each(["ranger","warden"])("recognizes bound %s temp aliases and storage without counting raw entries",classId=>{
 const f=fixture(classId,classId);
 const bound=bindPaths(f.scope.scope!,{home:"/identity-fixture/home",tmp:["/tmp","/private/tmp","/custom/temp"],threadStorage:"/storage/own",scopesDir:"/identity-fixture/scopes"},p=>p);
 const v=render(<MemberIdentity {...f} scope={{...f.scope,scope:bound}} />);
 expect(v.container.textContent).toContain("writes: temp and its own storage");
});
it.each(["enforce","watch","off"] as const)("does not infer a finished run's protection from current %s scope",mode=>{
 const f=fixture("smith","Smith"); const v=render(<MemberIdentity {...f} scope={{...f.scope,mode,guardPosture:{providerId:"pi",mode:"pre-exec",label:"enforced",approvalAskId:null}}} compact finished />);
 expect(v.container.textContent).toContain("guard state not recorded");
 expect(v.container.textContent).not.toContain("enforced during the run");
});
it("does not call another thread\'s storage its own when storage is bound",()=>{
 const f=fixture("ranger","Ranger");
 const bound=bindPaths(f.scope.scope!,{home:"/identity-fixture/home",tmp:["/tmp"],threadStorage:"/thread-storage/own",scopesDir:"/identity-fixture/scopes"},p=>p);
 const scope={...bound,writes:{...bound.writes,allow:["/tmp","/thread-storage/other"]}};
 const v=render(<MemberIdentity {...f} scope={{...f.scope,scope}} />);
 expect(v.container.textContent).toContain("writes: listed paths");
 expect(v.container.textContent).not.toContain("temp and its own storage");
});
it("keeps narrowed permissions and guard errors truthful",()=>{
 const f=fixture("ranger","Ranger");
 const sc={...f.scope,scope:{...f.scope.scope!,writes:{mode:"paths" as const,allow:["/tmp/one-file"],deny:[]},network:"none" as const,github:"none" as const},armed:false,error:"Scope delivery failed"};
 const v=render(<MemberIdentity {...f} scope={sc} />);
 expect(v.container.textContent).toContain("writes: listed paths");
 expect(v.container.textContent).not.toContain("temp and its own storage");
 expect(v.container.textContent).toContain("network: none · GitHub: none");
 expect(v.container.textContent).toContain("guard unavailable");
 expect(v.container.textContent).toContain("1 scope alert: Scope delivery failed");
});
it("uses historical words in compact finished records, never not armed yet",()=>{
 const f=fixture("smith","Smith"); const v=render(<MemberIdentity {...f} scope={undefined} compact finished />);
 expect(v.container.textContent).toContain("Smith (builder)");
 expect(v.container.textContent).toContain("guard state not recorded"); expect(v.container.textContent).not.toContain("not armed yet");
 v.rerender(<MemberIdentity {...f} member={{...f.member,guardPosture:{providerId:"pi",mode:"detection-only",label:"watched",approvalAskId:null}}} compact finished />);
 expect(v.container.textContent).toContain("watched during the run");
 v.rerender(<MemberIdentity {...f} scope={{...f.scope,mode:"off"}} member={{...f.member,guardPosture:{providerId:"pi",mode:"pre-exec",label:"enforced",approvalAskId:null}}} compact finished />);
 expect(v.container.textContent).toContain("enforced during the run");
});
