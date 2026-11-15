// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { makeHost } from "./host";
import { MIGRATIONS } from "../../src/server/migrations";
import { QUESTLOG_MIGRATIONS as JOURNAL_MIGRATIONS } from "../../src/server/journal/migrations";
import { createJournalStore } from "../../src/server/journal/store";
import { dispatchCheck, isJournalTool, watchRequests } from "../../src/server/journal/requests";
import { planLine } from "../../src/server/journal/engine";
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.useRealTimers(); await Promise.all(cleanup.splice(0).map(f=>f()));});
function fixture(metadata:Record<string,unknown>={}) {
  const h=makeHost(metadata); cleanup.push(h.dispose); h.bb.storage.migrate(h.db,MIGRATIONS);
  const store=createJournalStore(h.bb,h.db,{roleOf:()=>null,invalidate:()=>{}}); return {...h,store};
}
it("keeps the installed checklist migration unchanged and upgrades old counter/reservations in place", async()=>{
  expect(createHash("sha256").update(JOURNAL_MIGRATIONS[0]!).digest("hex")).toMatch(/^2a99d6/);
  const h=makeHost(); cleanup.push(h.dispose); h.bb.storage.migrate(h.db,JOURNAL_MIGRATIONS);
  h.db.prepare("INSERT INTO questlog_logs(thread_id,next_id,hydrated) VALUES('t',579,1)").run();
  h.db.prepare("INSERT INTO questlog_reserved(thread_id,id) VALUES('t','g0')").run();
  h.bb.storage.migrate(h.db,MIGRATIONS.slice(JOURNAL_MIGRATIONS.length));
  const store=createJournalStore(h.bb,h.db,{roleOf:()=>null,invalidate:()=>{}}); await store.ready("t");
  await store.runTool("t",{action:"add",descriptions:["next"]});
  expect(store.get("t").entries[0]?.id).toBe("03");
  expect(h.db.prepare("SELECT id FROM questlog_reserved WHERE id='g0'").get()).toEqual({id:"g0"});
});
it("does not mistake requests or board-quest tools for the checklist tool",()=>{
  for(const name of ["quest","tavern.quest","mcp__tavern__quest"]) expect(isJournalTool(name)).toBe(true);
  for(const name of ["tavern_quest","pull_request","http_request","questing"]) expect(isJournalTool(name)).toBe(false);
});
it("checks every queued row's origin and content before rejecting a start-turn group",()=>{
  const note={type:"text",text:"[Journal] snapshot",visibility:"agent-only"};
  const row={originPluginId:"tavern",content:[note]};
  const ctx={attempt:"start-turn",originPluginId:"mixed",input:{blocks:[note]},queuedMessages:[row,row]};
  expect(dispatchCheck(ctx as unknown as MessageDispatchHookContext)).not.toBeNull();
  expect(dispatchCheck({...ctx,queuedMessages:[row,{...row,originPluginId:null}]} as unknown as MessageDispatchHookContext)).toBeNull();
  expect(dispatchCheck({...ctx,input:{blocks:[note,{type:"image",url:"user-image"}]}} as unknown as MessageDispatchHookContext)).toBeNull();
  expect(dispatchCheck({...ctx,attempt:"join-turn"} as unknown as MessageDispatchHookContext)).toBeNull();
});
it("contains corrupt work-tracking rows inside the event handler",async()=>{
  const f=fixture(); await f.store.ready("t"); await f.store.runTool("t",{action:"add",descriptions:["work"]});
  watchRequests(f.bb,f.store); f.db.prepare("UPDATE questlog_entries SET data='{}'").run();
  await expect(f.emit("experimental_thread.events",{thread:{id:"t"}})).resolves.toBeUndefined();
  expect(f.warnings.some(w=>w.includes("Journal note for t failed"))).toBe(true);
});
it("deletes a thread's contributions even when its metadata read is still in flight",async()=>{
  const f=fixture(); let release!:()=>void; const waiting=new Promise<void>(r=>{release=r;});
  f.bb.sdk.threads.getPluginMetadata=async()=>{await waiting;return {};};
  const read=f.store.ready("t"); f.store.deleteThread("t"); release(); await read;
  expect(f.db.prepare("SELECT count(*) AS n FROM questlog_logs").get()).toEqual({n:0});
  expect(f.store.get("t").entries).toEqual([]);
});
it("mirrors empty progress only when the namespace already advertised progress",async()=>{
  const f=fixture({progress:{done:0,total:0,current:null}}); await f.store.ready("t"); await f.store.flush("t");
  expect(f.mirrors).toEqual([{threadId:"t",pluginId:"quests",set:{progress:{done:0,total:0,current:null}}}]);
});
it("clips long plan descriptions and retains the parent hint for a step",async()=>{
  const f=fixture(); await f.store.ready("t"); await f.store.runTool("t",{action:"add",descriptions:["parent"]});
  await f.store.runTool("t",{action:"split",id:"00",descriptions:["x".repeat(500)]});
  const line=planLine(f.store.get("t").entries); expect(line).toContain("a step of [00]"); expect(line.length).toBeLessThan(180);
});
it("retries failed background imports after backoff without failing public reads",async()=>{
  vi.useFakeTimers(); vi.setSystemTime(100_000); const f=fixture(); let offline=true;
  const read=vi.fn(async()=>{if(offline)throw new Error("temporary network failure");return {};}); f.bb.sdk.threads.getPluginMetadata=read;
  f.store.get("t"); await expect(f.store.ready("t")).rejects.toThrow("temporary network failure");
  const calls=read.mock.calls.length;
  for(let i=0;i<5;i++) {expect(()=>f.store.get("t")).not.toThrow();expect(()=>f.store.progress("t")).not.toThrow();}
  expect(read).toHaveBeenCalledTimes(calls); offline=false; vi.advanceTimersByTime(5001);
  f.store.get("t"); await f.store.ready("t"); expect(f.store.get("t").problem).toBeUndefined();
});
