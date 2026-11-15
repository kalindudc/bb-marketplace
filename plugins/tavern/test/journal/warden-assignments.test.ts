// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { makeHost } from "./host";
import { MIGRATIONS } from "../../src/server/migrations";
import { createJournalStore } from "../../src/server/journal/store";
import type { JournalDeps } from "../../src/server/ports";
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{await Promise.all(cleanup.splice(0).map(f=>f()));});
const proof=[{kind:"command" as const,ref:"tests",detail:"pass",exitCode:0}];
async function fixture(checkerWaypointIds?:string[],waypointId:string|null="first"){
  const h=makeHost();cleanup.push(h.dispose);h.bb.storage.migrate(h.db,MIGRATIONS);
  const role={classId:"warden",role:"member" as const,boardQuestId:"board",waypointId,...(checkerWaypointIds===undefined?{}:{checkerWaypointIds})};
  const deps:JournalDeps={roleOf:id=>id==="w"?role:null,invalidate:()=>{}};
  const store=createJournalStore(h.bb,h.db,deps);await store.prepare("s");
  for(const waypointId of ["first","second"])store.linkWaypoint("s",{boardQuestId:"board",waypointId},waypointId,"owner",{kind:"tavern"});
  await store.runTool("s",{action:"done",ids:["00","01"],evidence:proof});
  return {...h,store};
}
describe("current-plan Warden assignments",()=>{
  it("allows current assignments outside the hire-time waypoint and hides unassigned work",async()=>{
    const f=await fixture(["second"]);const listed=await f.store.runTool("w",{action:"list",threadId:"s"});
    expect(listed.isError).toBe(false);expect(listed.text).toContain("second");expect(listed.text).not.toContain("first");
    expect((await f.store.runTool("w",{action:"get",id:"01",threadId:"s"})).isError).toBe(false);
    expect((await f.store.runTool("w",{action:"verify",id:"01",threadId:"s",evidence:proof})).isError).toBe(false);
    expect((await f.store.runTool("w",{action:"verify",id:"00",threadId:"s",evidence:proof})).isError).toBe(true);
  });
  it.each([null,"first"])("treats a new empty assignment list as no permission, even with legacy waypoint %s",async waypointId=>{
    const f=await fixture([],waypointId);
    expect((await f.store.runTool("w",{action:"verify",id:"00",threadId:"s",evidence:proof})).isError).toBe(true);
    expect((await f.store.runTool("w",{action:"reject",id:"01",threadId:"s",reason:"no"})).isError).toBe(true);
    expect((await f.store.runTool("w",{action:"list",threadId:"s"})).isError).toBe(true);
  });
  it("keeps the legacy single-waypoint fallback only when the array is absent",async()=>{
    const f=await fixture();expect((await f.store.runTool("w",{action:"verify",id:"00",threadId:"s",evidence:proof})).isError).toBe(false);
    expect((await f.store.runTool("w",{action:"verify",id:"01",threadId:"s",evidence:proof})).isError).toBe(true);
  });
  it("validates every explicitly targeted id before cross-thread reopening",async()=>{
    const f=await fixture(["second"]);const result=await f.store.runTool("w",{action:"reopen",threadId:"s",ids:["00","01"]});
    expect(result.isError).toBe(true);expect(f.store.get("s").entries.every(e=>e.status==="done")).toBe(true);
  });
});
