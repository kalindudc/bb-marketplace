import Sqlite from "better-sqlite3";
import { expect, it } from "vitest";
import { defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { settingsCommands } from "../../src/server/settings/cli";
import { SettingsStore } from "../../src/server/settings/store";
import { MIGRATIONS } from "../../src/server/migrations";
import type { Database } from "../../src/server/ports";
it("previews multiple keys, audits an agent apply and allows undo", async () => {
 const db = new Sqlite(":memory:"); db.exec(MIGRATIONS.join("\n"));
 try {
 const store = new SettingsStore(db as unknown as Database);
 const cli = defineCli({ name: "tavern", summary: "Tavern", commands: settingsCommands({} as BbPluginApi, store) });
 const args = ["settings", "set", "tavern.ambientMotion=lively", "tavern.repeatSeconds=3"];
 store.update({revision:0,patch:{classes:{smith:{provider:"pi",model:"old",reasoning:"high"}}},why:"Existing class"});
 expect((await cli.run(["settings","set","classes.smith.model=new","--apply"],{threadId:"agent"})).exitCode).toBe(0);
 expect(store.read().classes.smith).toEqual({provider:"pi",model:"new",reasoning:"high"});
 expect((await cli.run(args, {threadId:"agent"})).exitCode).toBe(0);
 expect(store.read().tavern.ambientMotion).toBe("calm");
 store.update({revision:store.snapshot().revision,patch:{tavern:{hearthFlicker:false}},why:"Legacy off"});
 expect((await cli.run([...args,"--apply"], {threadId:"agent"})).exitCode).toBe(0);
 expect(store.read().tavern.hearthFlicker).toBe(true);
 expect(store.read().tavern.repeatSeconds).toBe(3);
 const change=store.snapshot().history[0]!;
 expect(change).toMatchObject({threadId:"agent",undoable:true});
 store.undo(change.id,"Undo agent change");
 expect(store.read().tavern.ambientMotion).toBe("calm");
 expect((await cli.run(["settings","get","tavern.repeatSeconds"], {})).stdout).toContain("20");
 expect((await cli.run(["settings","set","tavern.repeatSeconds=2","--apply"], {})).exitCode).not.toBe(0);
 store.update({revision:store.snapshot().revision,patch:{tavern:{agentsMayChangeSettings:false}},why:"Lock"});
 expect((await cli.run([...args,"--apply"],{threadId:"agent"})).exitCode).toBe(1);
 expect((await cli.run(["settings","import","--toml","[tavern]\npaused=true"],{threadId:"agent"})).exitCode).toBe(0);
 } finally {db.close();}
});
