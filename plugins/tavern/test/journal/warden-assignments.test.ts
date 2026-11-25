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
  const role={classId:"warden",role:"member" as const,boardQuestId:"board",waypointId,checkerEntryReview:()=>({}),...(checkerWaypointIds===undefined?{}:{checkerWaypointIds})};
  const deps:JournalDeps={roleOf:id=>id==="w"?role:null,invalidate:()=>{}};
  const store=createJournalStore(h.bb,h.db,deps);await store.prepare("s");
  for(const waypointId of ["first","second"])store.linkWaypoint("s",{boardQuestId:"board",waypointId},waypointId,"owner",{kind:"tavern"});
  await store.runTool("s",{action:"done",ids:["00","01"],evidence:proof});
  return {...h,store};
}
describe("Warden journal access",()=>{
  it.each([{ checkerWaypointIds: ["second"] }, { checkerWaypointIds: [] }, { checkerWaypointIds: undefined }])("allows same-quest reads and verdicts with checker slots $checkerWaypointIds",async ({ checkerWaypointIds })=>{
    const f=await fixture(checkerWaypointIds);
    const listed=await f.store.runTool("w",{action:"list",threadId:"s"});
    expect(listed.isError).toBe(false);expect(listed.text).toContain("first");expect(listed.text).toContain("second");
    expect((await f.store.runTool("w",{action:"get",id:"01",threadId:"s"})).isError).toBe(false);
    expect((await f.store.runTool("w",{action:"verify",id:"00",threadId:"s",evidence:proof})).isError).toBe(false);
    expect((await f.store.runTool("w",{action:"reject",id:"01",threadId:"s",reason:"Missing a case"})).isError).toBe(false);
  });
  it("validates every explicitly targeted id before cross-thread reopening",async()=>{
    const f=await fixture(["second"]);const result=await f.store.runTool("w",{action:"reopen",threadId:"s",ids:["00","01"]});
    expect(result.isError).toBe(true);expect(f.store.get("s").entries.every(e=>e.status==="done")).toBe(true);
  });
});
