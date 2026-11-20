import Sqlite from "better-sqlite3";
import { expect, it } from "vitest";
import { defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { settingsCommands } from "../../src/server/settings/cli";
import { SettingsStore } from "../../src/server/settings/store";
import { KeeperStore } from "../../src/server/keeper/store";
import { fixtureMember } from "../../src/ui/thread/fixtures";
import { MIGRATIONS } from "../../src/server/migrations";
import { exportToml, previewToml } from "../../src/server/settings/toml";
it.each([false, true])("reports the original TOML syntax error line (apply: %s)", async apply => {
  const db = new Sqlite(":memory:"); db.exec(MIGRATIONS.join(";\n"));
  try {
    const store = new SettingsStore(db as never);
    const cli = defineCli({ name: "tavern", summary: "Tavern", commands: settingsCommands({} as BbPluginApi, store) });
    const source = '[tavern]\nrepeat_seconds=7\nvoice="';
    const result = await cli.run(["settings", "import", "--toml", source, "--json", ...(apply ? ["--apply"] : [])], {});
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBeTruthy();
    expect(JSON.parse(result.stdout!)).toMatchObject({ code: "invalid", problems: [expect.objectContaining({ line: 3 })] });
    expect(store.snapshot().revision).toBe(0);
  } finally { db.close(); }
});
const message = "Forge profiles run commands on this machine, so they change only on Tavern's Settings page, Where work runs.";
it.each([{}, { threadId: "agent" }])("only permits the Settings page to write forge commands: %j", async ctx => {
  const db = new Sqlite(":memory:"); db.exec(MIGRATIONS.join(";\n"));
  try {
    const store = new SettingsStore(db as never);
    if (ctx.threadId) new KeeperStore(db as never).put("members", ctx.threadId, { ...fixtureMember, threadId: ctx.threadId, classId: "smith" });
    store.update({ revision: 0, patch: { machines: { forges: [{ id: "kept", name: "Kept", enabled: true, kind: "command", open: "original" }] } }, why: "User page" });
    const cli = defineCli({ name: "tavern", summary: "Tavern", commands: settingsCommands({} as BbPluginApi, store) });
    const result = await cli.run(["settings", "set", 'machines.forges=[{"id":"injected","name":"Injected","kind":"command","open":"injected"}]', "--apply"], ctx);
    expect(result.exitCode).toBe(1); expect(result.stderr).toContain(message);
    const imported = await cli.run(["settings", "import", "--toml", '[[machines.forges]]\nid="injected"\nname="Injected"\nkind="command"\nopen="injected"\n[tavern]\nrepeat_seconds=7', "--apply"], ctx);
    expect(imported.exitCode).toBe(0); expect(imported.stdout).toContain("Skipped forge profiles: injected."); expect(imported.stdout).toContain("Kept forge profiles: kept."); expect(imported.stdout).toContain(message);
    expect(store.read().machines.forges.map(profile => profile.id)).toEqual(["kept"]); expect(store.read().tavern.repeatSeconds).toBe(7);
    const roundTrip = previewToml(exportToml(store.snapshot()), store.snapshot()); expect(roundTrip.problems).toEqual([]); expect(roundTrip.user.machines?.forges).toEqual(store.read().machines.forges);
  } finally { db.close(); }
});
