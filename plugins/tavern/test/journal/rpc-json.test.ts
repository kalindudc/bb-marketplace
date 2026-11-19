// @vitest-environment node
import type { ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { makeHost } from "./host";
import { MIGRATIONS } from "../../src/server/migrations";
import { registerJournal } from "../../src/server/journal";
import { Keeper } from "../../src/server/keeper/service";
import { KeeperStore } from "../../src/server/keeper/store";
import { rpcHandlers } from "../../src/server/rpc";
import type { TavernRuntime } from "../../src/server/runtime";
import { rpcContract } from "../../src/shared/contract";
import { DEFAULT_SETTINGS } from "../../src/shared/settings";
const cleanup: (()=>Promise<void>)[]=[];
afterEach(async()=>{await Promise.all(cleanup.splice(0).map(f=>f()));});
function wire(value:unknown){return JSON.parse(JSON.stringify(value,(_key,value)=>{if(value===undefined)throw new Error("RPC output contains undefined");return value;}));}
async function fixture(){
  const h=makeHost();cleanup.push(h.dispose);h.bb.storage.migrate(h.db,MIGRATIONS);const data=new KeeperStore(h.db);
  const journal=registerJournal(h.bb,h.db,{roleOf:id=>data.get("members",id),invalidate:()=>{}});
  const keeper=new Keeper(data,journal);const handlers=rpcHandlers({keeper,restNote:()=>null,held:(_threadId:string):boolean=>false,config:()=>DEFAULT_SETTINGS,pendingNews:()=>0,wakeBatching:()=>false} as unknown as TavernRuntime);await journal.prepare("t");
  return {...h,journal,keeper,handlers};
}
describe("quest RPC JSON values",()=>{
  it("round-trips healthy journal and decor outputs through their public schemas",async()=>{
    const f=await fixture();f.keeper.bind("t","keeper","wren","project");
    f.journal.edit("t",{op:"add",descriptions:["ordinary chore"],parentId:null},{kind:"agent",threadId:"t"});
    const log=await f.handlers.journal({threadId:"t"});expect(log).not.toHaveProperty("problem");
    expect(rpcContract.journal.output.parse(wire(log))).toStrictEqual(log);
    const edit=await f.handlers.journalEdit({threadId:"t",edit:{op:"status",entryIds:["00"],status:"done"}}, {experimental_caller:{kind:"client"}} as ExperimentalPluginRpcHandlerContext);
    expect(rpcContract.journalEdit.output.parse(wire(edit))).toStrictEqual(edit);
    const decor=await f.handlers.decor({threadId:"t"});expect(rpcContract.decor.output.parse(wire(decor))).toStrictEqual(decor);
  });
  it("round-trips degraded reads with a present string problem",async()=>{
    const f=await fixture();f.journal.edit("t",{op:"add",descriptions:["ordinary chore"],parentId:null},{kind:"user"});
    f.db.prepare("UPDATE questlog_entries SET data='{}'").run();
    const log=await f.handlers.journal({threadId:"t"});expect(log).toHaveProperty("problem",expect.any(String));
    expect(()=>rpcContract.journal.output.parse(wire(log))).not.toThrow();
    const decor=await f.handlers.decor({threadId:"t"});expect(()=>rpcContract.decor.output.parse(wire(decor))).not.toThrow();
  });
});
