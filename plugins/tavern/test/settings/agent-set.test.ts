import Sqlite from "better-sqlite3";
import { expect, it } from "vitest";
import { defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { settingsCommands } from "../../src/server/settings/cli";
import { SettingsStore } from "../../src/server/settings/store";
import { MIGRATIONS } from "../../src/server/migrations";
import type { Database } from "../../src/server/ports";
it.each([["keepers.alwaysAsk", "[keepers]\\nalways_ask = []"], ["away.neverWhileClosed", "[away]\\nnever_while_closed = []"]])("reserves %s for the user anywhere settings can be applied", async (key, toml) => {
 const db = new Sqlite(":memory:"); db.exec(MIGRATIONS.join(";\n"));
 try {
  const store = new SettingsStore(db as unknown as Database);
  const cli = defineCli({name:"tavern",summary:"Test",commands:settingsCommands({} as BbPluginApi,store)});
  const set = ["settings","set",`${key}=[]`], agent = {threadId:"plain-agent"};
  expect((await cli.run(set, agent)).exitCode).toBe(0);
  for(const cmd of [set, ["settings","import","--toml",toml.replace(/\\n/g,"\n")]]) {
   const refused = await cli.run([...cmd,"--apply"],agent);
   expect(refused.exitCode).toBe(1);
   expect(refused.stderr).toContain(key);
   expect(store.snapshot().revision).toBe(0);
  }
  expect((await cli.run([...set,"--apply"],{})).exitCode).toBe(0);
  const importingOtherKeys = await cli.run(["settings","import","--toml","[tavern]\nrepeat_seconds = 23","--apply"],agent);
  expect(importingOtherKeys.exitCode).toBe(1);
  expect(importingOtherKeys.stderr).toContain(key);
  expect(store.snapshot().revision).toBe(1);
 } finally {db.close();}
});
it("previews multiple keys, audits an agent apply and allows undo", async () => {
 const db = new Sqlite(":memory:"); db.exec(MIGRATIONS.join(";\n"));
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
 expect((await cli.run(["settings","set","tavern.contextualSpeech=true","tavern.speechGapMinutes=60","tavern.speechModel=vendor/model","--apply"], { threadId:"agent" })).exitCode).toBe(0);
 expect(store.read().tavern).toMatchObject({ contextualSpeech: true, speechGapMinutes: 60, speechModel: "vendor/model" });
 expect((await cli.run(["settings","set","tavern.speechInstallLimit=60","--apply"], {threadId:"agent"})).exitCode).not.toBe(0);
 store.update({revision:store.snapshot().revision,patch:{tavern:{agentsMayChangeSettings:false}},why:"Lock"});
 expect((await cli.run([...args,"--apply"],{threadId:"agent"})).exitCode).toBe(1);
 expect((await cli.run(["settings","import","--toml","[tavern]\npaused=true"],{threadId:"agent"})).exitCode).toBe(0);
 } finally {db.close();}
});
