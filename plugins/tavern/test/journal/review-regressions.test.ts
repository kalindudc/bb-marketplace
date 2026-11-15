// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHost } from "./host";
import { MIGRATIONS } from "../../src/server/migrations";
import { createJournalStore } from "../../src/server/journal/store";
import { registerJournal } from "../../src/server/journal";
import { dispatchCheck, isUserRequest } from "../../src/server/journal/requests";
import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(cleanup.splice(0).map(f => f())); });
const roles = (t: string) => t === "w" ? { classId: "warden", role: "member" as const, boardQuestId: "b", waypointId: "w1" } : t === "k" ? { classId: "keeper", role: "keeper" as const, boardQuestId: null, waypointId: null } : null;
const proof = [{ kind: "command" as const, ref: "test", detail: "pass", exitCode: 0 }];
const old = (count = 1) => ({ version: 1, quests: Array.from({ length: count }, (_, i) => ({ id: i.toString(16).padStart(2, "0"), description: `old ${i}`, done: false, createdAt: i })), steps: [] as {id: string;parentId: string;description: string;done: boolean;createdAt: number}[], usedIds: [] });
function fixture(metadata: Record<string, unknown> = {}, enabled = false) {
  const host = makeHost(metadata, enabled); cleanup.push(host.dispose); host.bb.storage.migrate(host.db, MIGRATIONS);
  const deps = { roleOf: roles, invalidate: vi.fn() }, store = createJournalStore(host.bb, host.db, deps);
  return { ...host, store, deps };
}
describe("review regressions", () => {
  it("H2 normalizes reopened steps, long descriptions and oldest completed overflow", async () => {
    const log = old(202); log.quests[0]!.done = true; log.quests[1]!.done = true;
    log.quests[2]!.done = true; log.quests[3]!.description = "x".repeat(3000);
    log.steps.push({ id: "ff", parentId: "02", description: "open step", done: false, createdAt: 300 });
    const f = fixture({ log }); await f.store.ready("t");
    const entries = f.store.get("t").entries;
    expect(entries).toHaveLength(200); expect(entries.find(e => e.id === "02")?.status).toBe("todo");
    expect(entries.find(e => e.id === "03")?.description).toHaveLength(500);
    expect(entries.find(e => e.id === "03")?.note).toContain("shortened");
    expect(f.db.prepare("SELECT count(*) AS n FROM questlog_archive").get()).toEqual({ n: 4 });
  });
  it("H2 public reads never throw and transient metadata errors retry", async () => {
    const f = fixture(); let fail = true;
    f.bb.sdk.threads.getPluginMetadata = async () => { if (fail) throw new Error("offline"); return { log: old() }; };
    const port = registerJournal(f.bb, f.db, f.deps);
    expect(() => port.instructions("t")).not.toThrow();
    await expect(f.store.ready("t")).rejects.toThrow("offline");
    expect(() => port.get("t")).not.toThrow(); expect(() => port.progress("t")).not.toThrow();
    fail = false; await f.store.ready("t"); expect(f.store.get("t").entries).toHaveLength(1);
    f.db.prepare("UPDATE questlog_entries SET data = '{}'").run();
    expect(() => port.instructions("t")).not.toThrow(); expect(() => port.get("t")).not.toThrow();
  });
  it("H1 defers import while pi-quests owns the tool then imports its latest state", async () => {
    const metadata = { log: old() }; const f = fixture(metadata, true); let enabled = true;
    f.bb.sdk.plugins.list = async () => ({ plugins: [{ id: "pi-quests", enabled }] }) as never;
    await f.store.ready("t");
    expect(f.db.prepare("SELECT hydrated FROM questlog_logs").get()).toEqual({ hydrated: 0 });
    metadata.log = old(2); metadata.log.quests[0]!.done = true; enabled = false;
    vi.useFakeTimers(); vi.advanceTimersByTime(31_000);
    await f.store.ready("t"); expect(f.store.get("t").entries.map(e => e.status)).toEqual(["done", "todo"]);
  });
  it("H1 reimports changed legacy entries without replacing Tavern edits or resurrecting deletes", async () => {
    const metadata = { log: old(3) }; const f = fixture(metadata); await f.store.ready("t");
    await f.store.runTool("t", { action: "update", id: "00", description: "Tavern edit" });
    await f.store.runTool("t", { action: "delete", id: "02" });
    metadata.log.quests[0]!.done = true; metadata.log.quests[1]!.done = true;
    await f.store.ready("t");
    expect(f.store.get("t").entries.map(e => [e.id, e.description, e.status])).toEqual([["00", "Tavern edit", "todo"], ["01", "old 1", "done"]]);
  });
  it("H3 bounds undo names, stored rows and notes while keeping the newest unseen change", async () => {
    const f = fixture(); await f.store.ready("t");
    await f.store.runTool("t", { action: "add", descriptions: Array.from({length: 150}, (_, i) => `${i} ${"x".repeat(450)}`) });
    await f.store.runTool("t", { action: "add", descriptions: ["only changed"] });
    f.store.edit("t", { op: "undo" }, { kind: "user" });
    const undo = f.store.pending("t").at(-1)!;
    expect(undo.entryIds).toHaveLength(1); expect(undo.text.length).toBeLessThanOrEqual(1000); expect(undo.text).not.toContain("[00]");
    const seed = f.db.prepare("INSERT INTO questlog_changes(thread_id,at,actor,action,entry_ids,text,seen) VALUES(?,?,?,?,?,?,1)");
    f.db.transaction(() => { for (let i = 0; i < 510; i++) seed.run("t", i, JSON.stringify({kind:"agent",threadId:"t"}), "note", "[]", `edit ${i}`); })();
    await f.store.runTool("t", { action: "note", id: "00", note: "prune old changes" });
    expect((f.db.prepare("SELECT count(*) AS n FROM questlog_changes").get() as {n:number}).n).toBeLessThanOrEqual(501);
    for (let i = 0; i < 10; i++) f.store.edit("t", { op: "note", entryId: "00", note: `${i} ${"y".repeat(1500)}` }, {kind:"user"});
    let text = ""; await f.store.deliverNote("t", null, async t => { text = t; });
    expect(text.length).toBeLessThanOrEqual(4096); expect(text).toContain("9 yyy"); expect(text).toContain("The user");
  });
  it("M1 ignores bb-authored plugin sends, agent messages, retries and agent-only requests", () => {
    const human = { seq: 1, createdAt: 1, data: { initiator: "user", originPluginId: null, senderThreadId: null, input: [{type:"text",text:"hello"}] } };
    expect(isUserRequest(human)).toBe(true);
    for (const patch of [{originPluginId:"shuttle"}, {senderThreadId:"agent"}, {retryOfRequestId:"retry"}, {input:[{type:"text",text:"tick",visibility:"agent-only"}]}]) expect(isUserRequest({...human,data:{...human.data,...patch}})).toBe(false);
  });
  it("M2 rejects only exclusively Tavern-owned note groups", () => {
    const note = {type:"text",text:"[Journal] update",visibility:"agent-only"};
    const ctx = {attempt:"start-turn",originPluginId:"tavern",queuedMessages:[],input:{blocks:[note]}};
    expect(dispatchCheck(ctx as unknown as MessageDispatchHookContext)).not.toBeNull();
    expect(dispatchCheck({...ctx, originPluginId:"elsewhere"} as unknown as MessageDispatchHookContext)).toBeNull();
    expect(dispatchCheck({...ctx,input:{blocks:[note,{type:"text",text:"user draft"}]}} as unknown as MessageDispatchHookContext)).toBeNull();
  });
  it("M3/M4 preserves rejected work and protects linked completion and verification history", async () => {
    const f = fixture(); await f.store.ready("s"); const id = f.store.linkWaypoint("s",{boardQuestId:"b",waypointId:"w1"},"deliver","Juno",{kind:"tavern"});
    await f.store.runTool("s", {action:"done",id,evidence:proof}); await f.store.runTool("w",{action:"verify",threadId:"s",id,evidence:proof});
    expect((await f.store.runTool("s",{action:"undo"})).isError).toBe(true);
    await f.store.runTool("s",{action:"clear",all:true}); expect(f.store.linkedEntries("b")).toHaveLength(1);
    expect((await f.store.runTool("s",{action:"delete",id})).isError).toBe(true);
    await f.store.runTool("w",{action:"reject",threadId:"s",id,reason:"missing branch"});
    expect(f.store.linkedEntries("b")[0]).toMatchObject({status:"rejected",note:expect.stringContaining("missing branch")});
    expect(f.store.progress("s").done).toBe(0); expect(f.store.pending("s").at(-1)?.action).toBe("reject");
    await f.store.runTool("s",{action:"start",id}); expect(f.store.get("s").entries[0]?.status).toBe("doing");
  });
  it("M5 removes fork links and deleted-thread contributions", async () => {
    const f = fixture(); await f.store.ready("s"); const id=f.store.linkWaypoint("s",{boardQuestId:"b",waypointId:"w1"},"deliver","s",{kind:"tavern"});
    await f.store.runTool("s",{action:"done",id,evidence:proof}); await f.store.runTool("w",{action:"verify",threadId:"s",id,evidence:proof});
    f.threads.set("fork",{originKind:"fork",originPluginId:null,sourceThreadId:"s"}); await f.store.ready("fork");
    expect(f.store.get("fork").entries[0]).toMatchObject({link:null,status:"done"}); expect(f.store.linkedEntries("b")).toHaveLength(1);
    f.store.deleteThread("s"); expect(f.store.linkedEntries("b")).toEqual([]);
  });
  it("M6 and low 3 prepare cold trusted assignments and preserve explicit owners", async () => {
    const f=fixture(); await f.store.prepare("cold");
    const id=f.store.linkWaypoint("cold",{boardQuestId:"b",waypointId:"w1"},"deliver","Juno",{kind:"agent",threadId:"k"});
    expect(f.store.get("cold").entries[0]?.owner).toBe("Juno");
    expect((await f.store.runTool("cold",{action:"list",filter:"mine"})).text).toContain(`[${id}]`);
  });
  it("low 1/2 advertise optional evidence fields and do not mirror never-used empty logs", async () => {
    const f=fixture(); registerJournal(f.bb,f.db,f.deps);
    const params=f.tools.get("quest").parameters;
    expect(params.properties.evidence.items.required).toEqual(["kind","ref"]);
    await f.store.ready("empty"); await f.store.flush("empty"); expect(f.mirrors).toEqual([]);
  });
  it("low 10 keeps Warden evidence distinct even when all member evidence slots are full", async () => {
    const f=fixture(); await f.store.ready("s"); const id=f.store.linkWaypoint("s",{boardQuestId:"b",waypointId:"w1"},"deliver","s",{kind:"tavern"});
    await f.store.runTool("s",{action:"done",id,evidence:Array.from({length:30},(_,i)=>({...proof[0]!,ref:`member ${i}`}))});
    expect((await f.store.runTool("w",{action:"verify",threadId:"s",id,evidence:proof})).isError).toBe(false);
    expect(f.store.get("s").entries[0]).toMatchObject({review:{actor:{kind:"agent",threadId:"w"},evidence:proof}});
  });
  it("accepts twenty allocated ids in both the legacy pattern and the registered tool schema", async () => {
    const f=fixture(); const port=registerJournal(f.bb,f.db,f.deps); const tool=f.tools.get("quest");
    await tool.execute({action:"add",descriptions:Array.from({length:20},(_,i)=>`work ${i}`)},{threadId:"t"});
    const ids=port.get("t").entries.map(e=>e.id);
    expect(ids).toHaveLength(20); expect(ids[0]).toBe("00"); expect(ids.at(-1)).toBe("13");
    for(const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{2}$/);
      expect(id).toMatch(new RegExp(tool.parameters.properties.id.pattern));
      expect(id).toMatch(new RegExp(tool.parameters.properties.ids.items.pattern));
      expect(typeof await tool.execute({action:"toggle",id},{threadId:"t"})).toBe("string");
    }
    expect(port.progress("t").done).toBe(20);
    await tool.execute({action:"toggle",ids},{threadId:"t"}); expect(port.progress("t").done).toBe(0);
    expect("g0").toMatch(new RegExp(tool.parameters.properties.id.pattern));
  });
  it("never reuses ids through ff and grows only after the first 256 counter positions", async () => {
    const f=fixture(); await f.store.ready("t");
    await f.store.runTool("t",{action:"add",descriptions:Array(200).fill("batch")});
    expect(f.store.get("t").entries.at(-1)?.id).toBe("c7");
    await f.store.runTool("t",{action:"clear",all:true});
    await f.store.runTool("t",{action:"add",descriptions:Array(56).fill("batch")});
    expect(f.store.get("t").entries[0]?.id).toBe("c8"); expect(f.store.get("t").entries.at(-1)?.id).toBe("ff");
    await f.store.runTool("t",{action:"clear",all:true}); await f.store.runTool("t",{action:"add",descriptions:["next"]});
    expect(f.store.get("t").entries[0]?.id).toBe("100");
  });
  it("skips reserved imported ids and retains previously issued base36 ids", async () => {
    const f=fixture({log:old(2)}); await f.store.ready("t");
    await f.store.runTool("t",{action:"add",descriptions:["new"]}); expect(f.store.get("t").entries.at(-1)?.id).toBe("02");
    const entry={...f.store.get("t").entries[0]!,id:"g0"};
    f.db.prepare("INSERT INTO questlog_entries(thread_id,id,data) VALUES(?,?,?)").run("t","g0",JSON.stringify(entry));
    expect((await f.store.runTool("t",{action:"toggle",id:"g0"})).isError).toBe(false);
  });
  it("accepts explicit UI reasons and proof but never UI review verdicts", async () => {
    const f=fixture(); await f.store.ready("s"); const id=f.store.linkWaypoint("s",{boardQuestId:"b",waypointId:"w1"},"deliver","s",{kind:"tavern"});
    f.store.edit("s",{op:"status",entryIds:[id],status:"blocked",reason:"owner needed"},{kind:"user"});
    expect(f.store.get("s").entries[0]?.note).toBe("owner needed");
    expect(()=>f.store.edit("s",{op:"status",entryIds:[id],status:"done"},{kind:"user"})).toThrow(/evidence/);
    f.store.edit("s",{op:"status",entryIds:[id],status:"done",evidence:proof},{kind:"user"});
    for(const status of ["verified","rejected"] as const) expect(()=>f.store.edit("s",{op:"status",entryIds:[id],status},{kind:"agent",threadId:"w"})).toThrow(/Warden/);
  });
  it("keeps an existing member note when the Warden rejects", async () => {
    const f=fixture(); await f.store.ready("s"); const id=f.store.linkWaypoint("s",{boardQuestId:"b",waypointId:"w1"},"deliver","s",{kind:"tavern"});
    await f.store.runTool("s",{action:"note",id,note:"keep this decision"});
    await f.store.runTool("s",{action:"done",id,evidence:proof});
    await f.store.runTool("w",{action:"reject",threadId:"s",id,reason:"missing test"});
    expect(f.store.get("s").entries[0]?.note).toContain("keep this decision"); expect(f.store.get("s").entries[0]?.note).toContain("missing test");
    expect(f.store.get("s").entries[0]?.review?.previousNote).toMatch(/^\d\d:\d\d keep this decision$/);
  });
  it("starts cold Keeper checklist edits after preparing legacy ids", async () => {
    const f=fixture(); await f.store.prepare("cold");
    f.store.edit("cold",{op:"add",descriptions:["goal"],parentId:null},{kind:"agent",threadId:"k"});
    await f.store.ready("cold"); expect(f.store.get("cold").entries[0]?.description).toBe("goal");
  });
  it("caches ownership checks and keeps progress independent of corrupt change history", async () => {
    const f=fixture(); await f.store.ready("t"); const list=vi.fn(f.bb.sdk.plugins.list); f.bb.sdk.plugins.list=list;
    for(let i=0;i<5;i++) await f.store.runTool("t",{action:"add",descriptions:[`entry ${i}`]});
    expect(list).not.toHaveBeenCalled();
    f.db.prepare("UPDATE questlog_changes SET actor='bad-json'").run();
    expect(f.store.progress("t").total).toBe(5); expect(()=>f.store.get("t")).not.toThrow();
  });
});
