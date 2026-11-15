// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS } from "../../src/server/migrations";
import { createJournalStore } from "../../src/server/journal/store";
import { watchRequests } from "../../src/server/journal/requests";
import { PHASES, type BoardQuest } from "../../src/shared/schema";
import { makeHost } from "./host";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(f => f())); });
async function fixture() {
  const h = makeHost(); cleanup.push(h.dispose); h.bb.storage.migrate(h.db, MIGRATIONS);
  const quests: Pick<BoardQuest, "id" | "title" | "phase" | "updatedAt" | "endedAt">[] = [{id:"board",title:"Deliver",phase:"scout",updatedAt:100,endedAt:null}];
  const deps = { roleOf: (id: string) => id === "k" ? { classId:"keeper",role:"keeper" as const,boardQuestId:null,waypointId:null } : null, boardQuestsOf: (id: string) => id === "k" ? quests : [], invalidate:vi.fn() };
  const store = createJournalStore(h.bb,h.db,deps); await store.prepare("k");
  store.edit("k", {op:"add",descriptions:["Board quest: Deliver (board)"],parentId:null}, {kind:"agent",threadId:"k"});
  watchRequests(h.bb,store);
  return {...h,store,quests,deps};
}
const user = (seq: number, at: number) => ({ seq,createdAt:at,type:"client/turn/requested",data:{initiator:"user",input:[{type:"text",text:"what command lists plugins?"}]} });
const work = {seq:3,createdAt:1000,type:"item/started",data:{item:{id:"work",type:"toolCall",tool:"bash"}}};
describe("Keeper board mirrors",()=>{
  it("does not steer a stale journal nudge into a Keeper user turn",async()=>{
    const f=await fixture();f.db.prepare("UPDATE questlog_logs SET agent_changed_at=100,noted_at=NULL").run();
    f.setEvents([user(1,200),user(2,300),work]);await f.emit("thread.active",{thread:{id:"k",providerId:"pi"}});
    await f.emit("experimental_thread.events",{thread:{id:"k",providerId:"pi"}});expect(f.sent).toEqual([]);
    const send=vi.fn(async()=>{});expect(await f.store.deliverNote("k",200,send)).toBe(false);expect(send).not.toHaveBeenCalled();
  });
  it("keeps pending human edits for the next Keeper journal result rather than steering",async()=>{
    const f=await fixture();await f.store.runTool("k",{action:"add",descriptions:["ordinary chore"]});
    f.store.edit("k",{op:"note",entryId:"01",note:"user steer"},{kind:"user"});
    f.setEvents([user(1,200),user(2,300),work]);await f.emit("thread.active",{thread:{id:"k",providerId:"pi"}});
    expect(f.sent).toEqual([]);expect(f.store.pending("k")).toHaveLength(1);
    expect((await f.store.runTool("k",{action:"list"})).text).toContain("user steer");expect(f.store.pending("k")).toEqual([]);
  });
  it.each(PHASES)("reflects board phase %s rather than an old manual tick",async phase=>{
    const f=await fixture();const e=f.store.get("k").entries[0]!;
    f.db.prepare("UPDATE questlog_entries SET data=? WHERE thread_id='k'").run(JSON.stringify({...e,status:"done"}));
    f.quests[0]!.phase=phase;f.quests[0]!.updatedAt=200;f.quests[0]!.endedAt=["done","stopped"].includes(phase)?200:null;
    f.store.syncBoardQuests("k");const log=f.store.get("k");
    expect(log.entries[0]).toMatchObject({boardQuestId:"board",status:phase==="done"?"done":["stopping","stopped"].includes(phase)?"blocked":"todo",note:expect.stringContaining(phase)});
    expect(log.progress.done).toBe(phase==="done"?1:0);
    await f.store.flush("k");expect(f.mirrors.at(-1)).toMatchObject({set:{progress:{done:log.progress.done,total:1}}});
  });
  it.each(["done","toggle","start","reopen","update","delete","split"] as const)("refuses agent %s with the board lifecycle tool",async action=>{
    const f=await fixture();const r=await f.store.runTool("k",{action,id:"00",description:"ordinary chore",descriptions:["step"]});
    expect(r.isError).toBe(true);expect(r.text).toContain("tavern_wrap");expect(f.store.get("k").entries[0]?.status).toBe("todo");
  });
  it("also refuses UI ticking, clear skips mirrors, and undo cannot remove them",async()=>{
    const f=await fixture();expect(()=>f.store.edit("k",{op:"status",entryIds:["00"],status:"done"},{kind:"user"})).toThrow(/tavern_wrap/);
    expect((await f.store.runTool("k",{action:"undo"})).text).toContain("tavern_wrap");
    await f.store.runTool("k",{action:"add",descriptions:["ordinary chore"]});await f.store.runTool("k",{action:"clear",all:true});
    expect(f.store.get("k").entries.map(e=>e.id)).toEqual(["00"]);
  });
  it("rebases old history so undo of ordinary work cannot reopen a wrapped board",async()=>{
    const f=await fixture();await f.store.runTool("k",{action:"add",descriptions:["ordinary chore"]});
    f.quests[0]!.phase="done";f.quests[0]!.endedAt=300;f.quests[0]!.updatedAt=300;f.store.syncBoardQuests("k");
    expect((await f.store.runTool("k",{action:"undo"})).isError).toBe(false);
    expect(f.store.get("k").entries).toHaveLength(1);expect(f.store.get("k").entries[0]?.status).toBe("done");
    expect((await f.store.runTool("k",{action:"undo"})).text).toContain("tavern_wrap");
  });
  it("does not steer a note when a watched thread becomes a Keeper during delivery",async()=>{
    const f=await fixture();let keeper=false;
    f.deps.roleOf=(id:string)=>id==="k"&&keeper?{classId:"keeper",role:"keeper",boardQuestId:null,waypointId:null}:null;
    const get=f.bb.sdk.threads.get;f.bb.sdk.threads.get=async args=>{keeper=true;return get(args);};
    f.db.prepare("UPDATE questlog_logs SET agent_changed_at=100,noted_at=NULL").run();f.setEvents([user(1,200),user(2,300),work]);
    await f.emit("thread.active",{thread:{id:"k",providerId:"pi"}});expect(f.sent).toEqual([]);
  });
  it("adopts old unmarked board entries by board identity, even after a title change",async()=>{
    const f=await fixture();const row=f.db.prepare("SELECT data FROM questlog_entries WHERE thread_id=\'k\' AND id=\'00\'").get() as {data:string};
    f.db.prepare("UPDATE questlog_entries SET data=? WHERE thread_id=\'k\'").run(JSON.stringify({...JSON.parse(row.data),boardQuestId:null,status:"done"}));
    f.quests[0]!.title="Renamed";expect(f.store.get("k").entries[0]).toMatchObject({boardQuestId:"board",description:"Quest: Renamed",status:"todo"});
  });
  it("heals old manual ticks on reads and does not keep recording unchanged mirror phases",async()=>{
    const f=await fixture();const e=f.store.get("k").entries[0]!;
    f.db.prepare("UPDATE questlog_entries SET data=? WHERE thread_id='k'").run(JSON.stringify({...e,status:"done"}));
    expect(f.store.get("k").entries[0]?.status).toBe("todo");
    f.quests[0]!.phase="stopped";f.quests[0]!.endedAt=500;f.quests[0]!.updatedAt=500;expect(f.store.progress("k").done).toBe(0);
    const count=()=>f.db.prepare("SELECT count(*) AS n FROM questlog_changes").get();const before=count();
    f.store.get("k");f.store.progress("k");f.store.syncBoardQuests("k");expect(count()).toEqual(before);
  });
  it("allows ordinary reordering and its undo without changing the board phase",async()=>{
    const f=await fixture();await f.store.runTool("k",{action:"add",descriptions:["ordinary chore"]});
    expect((await f.store.runTool("k",{action:"reorder",id:"01",targetId:"00"})).isError).toBe(false);
    expect((await f.store.runTool("k",{action:"undo"})).isError).toBe(false);
    expect(f.store.get("k").entries.map(e=>e.id)).toEqual(["00","01"]);
  });
  it("promotes old board-entry steps and refuses adding new steps to mirrors",async()=>{
    const f=await fixture();await f.store.runTool("k",{action:"add",descriptions:["old step"]});
    const e=f.store.get("k").entries.find(e=>e.id==="01")!;
    f.db.prepare("UPDATE questlog_entries SET data=? WHERE thread_id='k' AND id='01'").run(JSON.stringify({...e,parentId:"00"}));
    f.quests[0]!.phase="done";f.quests[0]!.endedAt=500;f.quests[0]!.updatedAt=500;
    expect(f.store.get("k").entries.find(e=>e.id==="01")?.parentId).toBeNull();
    expect((await f.store.runTool("k",{action:"reparent",id:"01",parentId:"00"})).isError).toBe(true);
  });
  it.each(["done","stopped"] as const)("allows clear and undo/redo for a %s mirror without changing the board",async phase=>{
    const f=await fixture();f.quests[0]!.phase=phase;f.quests[0]!.endedAt=500;f.quests[0]!.updatedAt=500;f.store.syncBoardQuests("k");
    expect((await f.store.runTool("k",{action:"done",id:"00"})).isError).toBe(true);
    expect((await f.store.runTool("k",{action:"clear"})).isError).toBe(false);expect(f.store.get("k").entries).toEqual([]);
    expect((await f.store.runTool("k",{action:"undo"})).isError).toBe(false);expect(f.store.get("k").entries[0]?.status).toBe(phase==="done"?"done":"blocked");
    expect((await f.store.runTool("k",{action:"redo"})).isError).toBe(false);expect(f.store.get("k").entries).toEqual([]);expect(f.quests[0]!.phase).toBe(phase);
  });
  it("cannot replay terminal cleanup after the source board becomes active",async()=>{
    const f=await fixture();f.quests[0]!.phase="done";f.quests[0]!.endedAt=500;f.store.syncBoardQuests("k");
    expect((await f.store.runTool("k",{action:"clear"})).isError).toBe(false);expect(f.store.get("k").entries).toEqual([]);
    expect((await f.store.runTool("k",{action:"undo"})).isError).toBe(false);expect(f.store.get("k").entries[0]?.status).toBe("done");f.quests[0]!.phase="scout";f.quests[0]!.endedAt=null;
    expect((await f.store.runTool("k",{action:"redo"})).isError).toBe(true);expect(f.store.get("k").entries[0]?.status).toBe("todo");
  });
  it("mirrors two active boards without manufacturing two doing entries",async()=>{
    const f=await fixture();f.quests[0]!.phase="build";f.quests.push({id:"other",title:"Other",phase:"check",updatedAt:200,endedAt:null});
    await f.store.runTool("k",{action:"add",descriptions:["Board quest: Other (other)"]});
    expect(f.store.get("k").entries.map(e=>e.status)).toEqual(["todo","todo"]);
    expect((await f.store.runTool("k",{action:"done",ids:["00","01"]})).isError).toBe(true);expect(f.store.progress("k").done).toBe(0);
  });
  it("keeps ordinary chores editable and detaches mirror identity when forking",async()=>{
    const f=await fixture();await f.store.runTool("k",{action:"add",descriptions:["Board quest: not a real board","ordinary chore"]});
    expect((await f.store.runTool("k",{action:"done",ids:["01","02"]})).isError).toBe(false);
    f.threads.set("fork",{originKind:"fork",originPluginId:null,sourceThreadId:"k"});await f.store.prepare("fork");
    expect(f.store.get("fork").entries.every(e=>e.boardQuestId===null)).toBe(true);
    expect((await f.store.runTool("fork",{action:"done",id:"00"})).isError).toBe(false);
  });
});
