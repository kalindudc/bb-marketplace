// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHost } from "./host";
import { MIGRATIONS } from "../../src/server/migrations";
import { createJournalStore } from "../../src/server/journal/store";
import { watchRequests } from "../../src/server/journal/requests";
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.useRealTimers();await Promise.all(cleanup.splice(0).map(f=>f()));});
const roles=(id:string)=>id==="k"?{classId:"keeper",role:"keeper" as const,boardQuestId:null,waypointId:null}:id==="w"?{classId:"warden",role:"member" as const,boardQuestId:"b",waypointId:"wp",checkerEntryReview:()=>({})}:null;
const proof=[{kind:"command" as const,ref:"tests",detail:"pass",exitCode:0}];
function fixture(metadata:Record<string,unknown>={}){
  const h=makeHost(metadata);cleanup.push(h.dispose);h.bb.storage.migrate(h.db,MIGRATIONS);
  return {...h,store:createJournalStore(h.bb,h.db,{roleOf:roles,invalidate:()=>{}})};
}
async function linked(){const f=fixture();await f.store.ready("s");const id=f.store.linkWaypoint("s",{boardQuestId:"b",waypointId:"wp"},"deliver","Juno",{kind:"agent",threadId:"k"});return {...f,id};}
async function verified(){const f=await linked();await f.store.runTool("s",{action:"done",id:f.id,evidence:proof});await f.store.runTool("w",{action:"verify",threadId:"s",id:f.id,evidence:proof});return f;}
describe("round two",()=>{
  it("reserves all legacy ids before a cold trusted write and prepares cheaply",async()=>{
    const metadata={log:{version:1,quests:[{id:"00",description:"legacy zero",done:false,createdAt:1}],steps:[],usedIds:["00","01"]}};
    const f=fixture(metadata);let release!:()=>void;const waiting=new Promise<void>(r=>{release=r;});
    const read=vi.fn(async()=>{await waiting;return metadata;});f.bb.sdk.threads.getPluginMetadata=read;
    const preparing=f.store.prepare("cold");
    try{
      expect(()=>f.store.edit("cold",{op:"add",descriptions:["goal"],parentId:null},{kind:"agent",threadId:"k"})).toThrow(/prepare/);
      expect(()=>f.store.linkWaypoint("cold",{boardQuestId:"b",waypointId:"wp"},"deliver","Juno",{kind:"tavern"})).toThrow(/prepare/);
    }finally{release();}
    await preparing;
    const id=f.store.linkWaypoint("cold",{boardQuestId:"b",waypointId:"wp"},"deliver","Juno",{kind:"tavern"});
    expect(id).toBe("02");expect(f.store.get("cold").entries.map(e=>e.description)).toEqual(["legacy zero","deliver"]);
    expect(f.db.prepare("SELECT count(*) AS n FROM questlog_archive").get()).toEqual({n:0});
    await f.store.prepare("cold");expect(read).toHaveBeenCalledTimes(1);
  });
  it("reserves ids even while pi-quests owns the tool, then imports them after ownership moves",async()=>{
    const metadata={log:{version:1,quests:[{id:"00",description:"legacy",done:false,createdAt:1}],steps:[],usedIds:["00","01"]}};
    const f=fixture(metadata);let enabled=true;f.bb.sdk.plugins.list=async()=>({plugins:[{id:"pi-quests",enabled}]}) as never;
    await f.store.prepare("s");const id=f.store.linkWaypoint("s",{boardQuestId:"b",waypointId:"wp"},"deliver","Juno",{kind:"tavern"});expect(id).toBe("02");
    enabled=false;await f.store.ready("s");expect(f.store.get("s").entries.map(e=>e.id)).toEqual(["00","02"]);
    expect(f.db.prepare("SELECT count(*) AS n FROM questlog_archive").get()).toEqual({n:0});
  });
  it("isolates imported entry objects across rewritten history snapshots and the baseline",async()=>{
    const metadata={log:{version:1,quests:[{id:"00",description:"parent",done:false,createdAt:1}],steps:[],usedIds:["00"]}};
    const f=fixture(metadata);await f.store.prepare("t");await f.store.runTool("t",{action:"split",id:"00",descriptions:["child"]});
    await f.store.runTool("t",{action:"done",ids:["00","01"]});metadata.log.quests[0]!.done=true;await f.store.ready("t");
    const baseline=f.db.prepare("SELECT snapshot FROM questlog_imports WHERE thread_id='t'").get() as {snapshot:string};
    expect(JSON.parse(baseline.snapshot)[0].status).toBe("done");
    const history=f.db.prepare("SELECT before_data,after_data FROM questlog_history WHERE action='split'").get() as {before_data:string;after_data:string};
    expect(JSON.parse(history.before_data)[0].status).toBe("done");expect(JSON.parse(history.after_data)[0].status).toBe("todo");
  });
  it("cannot undo rejection into reported done using the rejected evidence",async()=>{
    const f=await linked();await f.store.runTool("s",{action:"done",id:f.id,evidence:proof});
    await f.store.runTool("w",{action:"reject",threadId:"s",id:f.id,reason:"missing regression"});
    expect((await f.store.runTool("s",{action:"undo"})).isError).toBe(true);expect(f.store.get("s").entries[0]?.status).toBe("rejected");
  });
  it.each(["reopen","toggle","start","block","update"] as const)("R3 blocks a member demoting verified work through %s",async action=>{
    const f=await verified();const result=await f.store.runTool("s",{action,id:f.id,reason:"blocked",description:"changed"});
    expect(result.isError).toBe(true);expect(f.store.linkedEntries("b")[0]?.status).toBe("verified");
  });
  it.each(["member","user"])("R3 protects open links from %s deletion, clear and unlink",async actorKind=>{
    const f=await linked();
    if(actorKind==="member"){
      expect((await f.store.runTool("s",{action:"delete",id:f.id})).isError).toBe(true);
      await f.store.runTool("s",{action:"clear",all:true});
      expect((await f.store.runTool("s",{action:"link",id:f.id,link:null})).isError).toBe(true);
      expect((await f.store.runTool("s",{action:"undo"})).isError).toBe(true);
    }else{
      expect(()=>f.store.edit("s",{op:"delete",entryIds:[f.id]},{kind:"user"})).toThrow(/Keeper/);
      f.store.edit("s",{op:"clear",all:true},{kind:"user"});
      expect(()=>f.store.edit("s",{op:"undo"},{kind:"user"})).toThrow(/Keeper/);
    }
    expect(f.store.linkedEntries("b")).toHaveLength(1);
  });
  it("R3 allows the Keeper and the assigned Warden to reopen verified work",async()=>{
    const f=await verified();f.store.edit("s",{op:"status",entryIds:[f.id],status:"todo"},{kind:"agent",threadId:"k"});
    expect(f.store.get("s").entries[0]?.status).toBe("todo");
    await f.store.runTool("s",{action:"done",id:f.id,evidence:proof});await f.store.runTool("w",{action:"verify",threadId:"s",id:f.id,evidence:proof});
    expect((await f.store.runTool("w",{action:"reopen",threadId:"s",id:f.id})).isError).toBe(false);
    f.store.edit("s",{op:"delete",entryIds:[f.id]},{kind:"agent",threadId:"k"});expect(f.store.linkedEntries("b")).toEqual([]);
  });
  it("R3 guards verified parents when a child is reopened",async()=>{
    const f=await linked();await f.store.runTool("s",{action:"split",id:f.id,descriptions:["child"]});
    await f.store.runTool("s",{action:"done",ids:[f.id,"01"],evidence:proof});await f.store.runTool("w",{action:"verify",threadId:"s",id:f.id,evidence:proof});
    expect((await f.store.runTool("s",{action:"reopen",id:"01"})).isError).toBe(true);
  });
  it("N1 returns all ids for add, split and add_step above the description cap",async()=>{
    const f=fixture();await f.store.ready("t");
    const add=await f.store.runTool("t",{action:"add",descriptions:Array.from({length:14},(_,i)=>`task ${i}`)});
    const line=add.text.split("\n").find(t=>t.startsWith("New ids:"))!;
    expect(line).toBe("New ids: 00, 01, 02, 03, 04, 05, 06, 07, 08, 09, 0a, 0b, 0c, 0d");
    for(const action of ["split","add_step"] as const){
      const before=new Set(f.store.get("t").entries.map(e=>e.id));
      const r=await f.store.runTool("t",{action,id:"03",descriptions:Array(12).fill("step")});
      const ids=f.store.get("t").entries.filter(e=>!before.has(e.id)).map(e=>e.id);
      expect(r.text.split("\n")).toContain(`New ids: ${ids.join(", ")}`);expect(ids).toHaveLength(12);
    }
  });
  it("an unparsable legacy namespace cannot block an established Tavern log",async()=>{
    vi.useFakeTimers();const metadata:Record<string,unknown>={};const f=fixture(metadata);await f.store.ready("t");
    await f.store.runTool("t",{action:"add",descriptions:["mine"]});metadata.log={version:2};vi.advanceTimersByTime(31_000);
    expect((await f.store.runTool("t",{action:"list"})).isError).toBe(false);
    expect((await f.store.runTool("t",{action:"done",id:"00"})).isError).toBe(false);
    expect(f.store.get("t").entries).toHaveLength(1);expect(f.store.get("t").problem).toBeTruthy();
  });
  it("requires proof submitted after rejection, including after start and reopen",async()=>{
    const f=await linked();await f.store.runTool("s",{action:"done",id:f.id,evidence:proof});
    await f.store.runTool("w",{action:"reject",threadId:"s",id:f.id,reason:"no retry test"});
    expect((await f.store.runTool("s",{action:"done",id:f.id})).isError).toBe(true);
    await f.store.runTool("s",{action:"start",id:f.id});await f.store.runTool("s",{action:"reopen",id:f.id});
    expect((await f.store.runTool("s",{action:"toggle",id:f.id})).isError).toBe(true);
    expect((await f.store.runTool("s",{action:"done",id:f.id,evidence:proof})).isError).toBe(false);
    expect((await f.store.runTool("s",{action:"done",id:f.id})).isError).toBe(false);
  });
  it("uses cached ownership at turn starts",async()=>{
    const f=fixture();await f.store.ready("t");const list=vi.fn(f.bb.sdk.plugins.list);f.bb.sdk.plugins.list=list;
    watchRequests(f.bb,f.store);await f.emit("thread.active",{thread:{id:"t",providerId:"pi"}});await f.emit("thread.active",{thread:{id:"t",providerId:"pi"}});
    expect(list).not.toHaveBeenCalled();
  });
  it("honours explicit waypoint owners while mine still includes the assigned log entry",async()=>{
    const f=await linked();expect(f.store.get("s").entries[0]?.owner).toBe("Juno");
    expect((await f.store.runTool("s",{action:"list",filter:"mine"})).text).toContain("deliver");
    f.store.linkWaypoint("s",{boardQuestId:"b",waypointId:"wp"},"deliver","New owner",{kind:"agent",threadId:"k"});
    expect(f.store.get("s").entries[0]?.owner).toBe("New owner");
  });
  it("does not replay legacy pending notes during a baseline-only upgrade",async()=>{
    const metadata={log:{version:1,quests:[{id:"a1",description:"legacy",done:false,createdAt:1}],steps:[],usedIds:["a1"]},pendingUserChanges:["old edit"]};
    const f=fixture(metadata);await f.store.ready("t");await f.store.runTool("t",{action:"list"});f.db.prepare("DELETE FROM questlog_imports").run();
    await f.store.ready("t");expect(f.store.pending("t")).toEqual([]);
  });
  it("deletes corrupt thread rows rather than leaving them in the roll-up",async()=>{
    const f=await linked();f.db.prepare("UPDATE questlog_entries SET data='{}'").run();
    expect(()=>f.store.deleteThread("s")).not.toThrow();expect(f.store.linkedEntries("b")).toEqual([]);
  });
});
