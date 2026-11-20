import Sqlite from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { settingsCommands } from "../../src/server/settings/cli";
import { SettingsStore } from "../../src/server/settings/store";
import { MIGRATIONS } from "../../src/server/migrations";
import type { Database } from "../../src/server/ports";
const databases: Sqlite.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function fixture() {
  const db = new Sqlite(":memory:"); databases.push(db); db.exec(MIGRATIONS.join(";\n"));
  const store = new SettingsStore(db as unknown as Database);
  const read = vi.fn(async () => ({ content: "[tavern]\npaused = true", contentEncoding: "utf8", sizeBytes: 23 }));
  const write = vi.fn(async () => ({}));
  const bb = { sdk: { files: { read, write } } } as unknown as BbPluginApi;
  const cli = defineCli({ name: "tavern", summary: "Tavern", commands: settingsCommands(bb, store) });
  return { store, read, write, run: (argv: string[], ctx = {}) => cli.run(argv, ctx) };
}
it("exports TOML and imports with a dry-run preview before explicit apply", async () => {
  const { store, read, run } = fixture();
  expect((await run(["settings", "export"])).stdout).toContain("Tavern settings");
  expect((await run(["settings", "import", "/home/me/settings.toml", "--host", "host-1"])).exitCode).toBe(0);
  expect(store.read().tavern.paused).toBe(false);
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ hostId: "host-1", path: "/home/me/settings.toml" }));
  await run(["settings", "import", "/home/me/settings.toml", "--host", "host-1", "--apply"]);
  expect(store.read().tavern.paused).toBe(true);
});
it("leads the preview with reset counts and keeps replacement semantics on apply", async () => {
  const { store, run } = fixture();
  store.update({ revision: 0, patch: { tavern: { paused: true }, knobs: { tickSeconds: 90 }, attention: { reviewBudget: 4 } }, why: "Existing user settings" });
  const args = ["settings", "import", "--toml", "[attention]\nreview_budget = 5"];
  const preview = await run(args);
  expect(preview.stdout?.split("\n")[0]).toBe("Replaces all settings. 2 settings return to defaults. 1 other changes.");
  expect(store.read().tavern.paused).toBe(true);
  const applied = await run([...args, "--apply"]);
  expect(applied.stdout?.split("\n")[0]).toBe("Replaced all settings. 2 settings returned to defaults. 1 other changed.");
  expect(store.read().tavern.paused).toBe(false); expect(store.read().knobs.tickSeconds).toBe(60); expect(store.read().attention.reviewBudget).toBe(5);
});
it("keeps --json as one document and labels file loads", async () => {
  const { run } = fixture();
  const result = await run(["settings", "import", "--toml", "[tavern]\npaused = true", "--json"]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout!)).toMatchObject({ code: "preview", summary: "Replaces all settings. No settings return to defaults. 1 other changes." });
  const file = await run(["settings", "import", "/settings.toml", "--host", "host-1"]);
  expect(file.stdout?.split("\n")[0]).toBe("Replaces all settings. No settings return to defaults. 1 other changes.");
});
it("does not describe invalid input as a successful no-change preview", async () => {
  const { run } = fixture();
  const result = await run(["settings", "import", "--toml", "[tavern]\nunknown = true"]);
  expect(result.exitCode).toBe(1); expect(result.stdout?.split("\n")[0]).toBe("Import was not applied: fix the reported problems.");
});
it("refuses locked agent mutations and ambiguous CLI file hosts", async () => {
  const { store, run, write } = fixture();
  store.update({ revision: 0, patch: { tavern: { agentsMayChangeSettings: false } }, why: "Lock agent changes" });
  expect((await run(["settings", "import", "/settings.toml", "--apply", "--host", "host-1"], { threadId: "agent" })).exitCode).not.toBe(0);
  expect((await run(["settings", "export", "--file", "/settings.toml"])).exitCode).not.toBe(0);
  expect(write).not.toHaveBeenCalled();
  expect(store.read().tavern.paused).toBe(false);
});
it("imports multiline TOML content without a host, using the same preview and apply", async () => {
  const { store, read, run } = fixture();
  const toml = "[tavern]\npaused = true\n[attention]\nreview_budget = 4";
  expect((await run(["settings", "import", "--toml", toml])).exitCode).toBe(0);
  expect(store.read().tavern.paused).toBe(false);
  expect((await run(["settings", "import", "--toml", toml, "--apply"])).exitCode).toBe(0);
  expect(store.read().attention.reviewBudget).toBe(4);
  expect(read).not.toHaveBeenCalled();
  expect((await run(["settings", "import", "--toml", toml, "--apply"], { threadId: "agent" })).exitCode).toBe(0);
});
it("explains unsupported raw stdin instead of guessing a host or applying empty input", async () => {
  const { store, read, run } = fixture();
  const result = await run(["settings", "import", "-", "--apply"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("does not forward raw stdin");
  expect(store.snapshot().revision).toBe(0);
  expect(read).not.toHaveBeenCalled();
});
it("refuses reserved provider keys in CLI previews and applies with a plain key and path", async () => {
  const { store, run } = fixture();
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const inputs = JSON.stringify({ nested: [Object.fromEntries([[key, true]])] });
    const toml = `[[machines.rules]]
id="bad"
label="Bad"
enabled=false
match={}
[machines.rules.target]
kind="provider"
environment_provider_id="env"
workspace="linked-worktree"
inputs_json='${inputs}'
[machines.rules.target.machine]
type="keeper"`;
    for (const apply of [false, true]) {
      const result = await run(["settings", "import", "--toml", toml, "--json", ...(apply ? ["--apply"] : [])]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout!).problems).toEqual([expect.objectContaining({
        message: `Provider inputs can't use the key ${key} (rules[0].target.inputs.nested[0]): bb's RPC can't carry it`,
      })]);
    }
  }
  expect(store.snapshot().revision).toBe(0);
});
it("writes through the selected host SDK and refuses an accidental overwrite", async () => {
  const { run, write } = fixture();
  await run(["settings", "export", "--file", "/settings.toml", "--host", "host-1"]);
  expect(write).toHaveBeenCalledWith(expect.objectContaining({ hostId: "host-1", path: "/settings.toml", expectedSha256: null, createParents: true }));
});
