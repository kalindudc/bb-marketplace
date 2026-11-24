import { putMemberFixture } from "../server/member-fixture";
import Sqlite from "better-sqlite3";
import { expect, it } from "vitest";
import { defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { settingsCommands } from "../../src/server/settings/cli";
import { previewToml } from "../../src/server/settings/toml";
import { SettingsStore } from "../../src/server/settings/store";
import { KeeperStore } from "../../src/server/keeper/store";
import { MIGRATIONS } from "../../src/server/migrations";
import type { Database } from "../../src/server/ports";
import { fixtureMember } from "../../src/ui/thread/fixtures";

it.each([["gitProgram", "git"], ["piProgram", "pi"]])("requires a user terminal or Settings to change tavern.%s", async (key, file) => {
 const db = new Sqlite(":memory:"); db.exec(MIGRATIONS.join(";\n"));
 try {
  const store = new SettingsStore(db as unknown as Database);
  const cli = defineCli({name:"tavern",summary:"Tavern",commands:settingsCommands({} as BbPluginApi,store)});
  const path = `/fixture/bin/${file}`, setting = `tavern.${key}`;
  const args=["settings","set",`${setting}=${path}`,"--apply"];
  const agent=await cli.run(args,{threadId:"plain"});
  expect(agent.exitCode).toBe(1);
  expect(agent.stderr).toContain(`Only you can change ${setting}`);
  expect(store.read().tavern).toMatchObject({[key]: ""});
  expect((await cli.run(args, {})).exitCode).toBe(0);
  expect(store.read().tavern).toMatchObject({[key]: path});
  expect(store.snapshot().history[0]).toMatchObject({by:"user",changes:[{key:setting}]});
 } finally { db.close(); }
});

it("lets only the user set speech launch options and preserves them across TOML imports", async () => {
  const db = new Sqlite(":memory:"); db.exec(MIGRATIONS.join(";\n"));
  try {
    const store = new SettingsStore(db as unknown as Database);
    const cli = defineCli({ name: "tavern", summary: "Tavern", commands: settingsCommands({} as BbPluginApi, store) });
    const options = { speechExtensions: ["/fixture/pi/sign-in.ts"], speechInstructions: "Short and calm." };
    for (const [key, value] of Object.entries(options)) {
      const args = ["settings", "set", `tavern.${key}=${JSON.stringify(value)}`, "--apply"];
      expect((await cli.run(args, { threadId: "plain" })).exitCode).toBe(1);
      expect((await cli.run(args, {})).exitCode).toBe(0);
    }
    const toml = '[tavern]\nspeech_extensions=["/fixture/different.ts"]\nspeech_instructions="Different"';
    for (const context of [{ threadId: "plain" }, {}])
      expect((await cli.run(["settings", "import", "--toml", toml, "--apply"], context)).exitCode).toBe(1);
    expect(previewToml(toml, store.snapshot(), "patch").problems.map(p => p.key)).toEqual(["tavern.speech_extensions", "tavern.speech_instructions"]);
    expect((await cli.run(["settings", "import", "--toml", "[tavern]\nvoice='light'", "--apply"], {})).exitCode).toBe(0);
    expect(store.read().tavern).toMatchObject({ ...options, voice: "light" });
  } finally { db.close(); }
});

it.each(["member", "keeper"] as const)("blocks guardrail applies from a persisted %s, including archived callers", async role => {
 const db = new Sqlite(":memory:"); db.exec(MIGRATIONS.join(";\n"));
 try {
 const store = new SettingsStore(db as unknown as Database);
 const members = new KeeperStore(db as unknown as Database);
 putMemberFixture(members, "smith", {...fixtureMember,threadId:"smith",classId:"smith",role});
 members.patch("smith",{archivedAt:123});
 const cli = defineCli({name:"tavern",summary:"Tavern",commands:settingsCommands({} as BbPluginApi,store)});
 const scoped = {threadId:"smith"};
 const args=["settings","set","scopes.mode=off"];
 expect((await cli.run(args,scoped)).exitCode).toBe(0);
 const denied=await cli.run([...args,"--apply"],scoped);
 expect(denied.exitCode).toBe(1);
 expect(denied.stderr).toContain("scopes.mode");
 expect(denied.stderr).toContain("Change these on Tavern's Settings page, or ask from a plain thread.");
 expect(store.snapshot().revision).toBe(0);
 for (const key of ["attention.notify=none", "attention.quietHours=null", 'attention.quietHours={"start":"00:00","end":"23:59","timeZone":"UTC"}', "tuning.mode=apply","keepers.greenlight=by-size","keepers.partyMax=8","keepers.decisionTimerMax=10","machines.maxMakers=3","machines.rules=[]", 'machines.rules=[{"id":"local","label":"Local","enabled":true,"match":{},"target":{"kind":"current"},"classModels":{"smith":{"model":"vendor/model"}}}]', 'machines.forges=[{"id":"forge","name":"Forge","kind":"command","open":"forge open"}]',"tavern.agentsMayChangeSettings=false","tavern.paused=true","attention.reviewBudget=4","knobs.typingHoldSeconds=15","knobs.afterMessageHoldSeconds=15","knobs.rangerTimeboxMaxMinutes=30"]) {
   const result=await cli.run(["settings","set",key,"--apply"],scoped);
   expect(result.exitCode, key).toBe(1);
   expect(result.stderr, key).toContain(key.startsWith("machines.forges=") ? "Forge profiles run commands on this machine" : key.split("=")[0]);
 }
 for (const toml of ["[attention]\nnotify='none'", "[attention.quiet_hours]\nstart='00:00'\nend='23:59'\ntime_zone='UTC'"]) {
   const result=await cli.run(["settings","import","--toml",toml,"--apply"],scoped);
   expect(result.exitCode).toBe(1); expect(result.stderr).toContain("attention.");
 }
 for (const section of ["tuning.pinned", "tuned"]) {
   const result=await cli.run(["settings","import","--toml",`[${section}]\ntyping_hold_seconds=15`,"--apply"],scoped);
   expect(result.exitCode).toBe(1); expect(result.stderr).toContain("typingHoldSeconds");
 }
 expect(store.snapshot().revision).toBe(0);
 expect((await cli.run(["settings","set","classes.smith.model=new","--apply"],scoped)).exitCode).toBe(0);
 expect(store.read().classes.smith?.model).toBe("new");
 const imported=await cli.run(["settings","import","--toml","[scopes]\nmode='off'","--apply"],scoped);
 expect(imported.exitCode).toBe(1); expect(store.read().scopes.mode).toBe("enforce");
 expect((await cli.run([...args,"--apply"],{threadId:"plain"})).exitCode).toBe(0);
 const change=store.snapshot().history[0]!;
 expect(change).toMatchObject({threadId:"plain",undoable:true});
 // Replacement imports cannot reset a saved guardrail by omitting it.
 expect((await cli.run(["settings","import","--toml","[tavern]\nvoice='light'","--apply"],scoped)).exitCode).toBe(1);
 store.undo(change.id,"Undo plain thread guardrail");
 expect(store.read().scopes.mode).toBe("enforce");
 } finally {db.close();}
});
