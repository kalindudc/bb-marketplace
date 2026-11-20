// @vitest-environment node
import { expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { builtin, fixture, override } from "./helpers";
it("saves a private managed folder with hashes and a manifest, and lists it newest first", async () => {
  const f = fixture(), custom = override(f);
  const saved = await f.backup.save({ withData: false });
  expect(saved.code).toBe("ok"); expect(saved.backup?.withData).toBe(false);
  const shown = f.backup.show(saved.backup!.name);
  expect(shown.manifest.data).toEqual({ included: false, bytes: 0 });
  expect(readFileSync(join(shown.path, "classes/custom-name.md"), "utf8")).toBe(custom.raw);
  expect(f.backup.list().backups.map(b => b.name)).toEqual([saved.backup!.name]);
});
it("round trips settings, verbatim overrides, scope policy and data into a fresh database", async () => {
  const source = fixture(), custom = override(source);
  source.settings.update({ revision: 0, patch: { tavern: { voice: "off" } }, why: "A user setting" });
  writeFileSync(join(source.home, "scopes.yml"), "v: 1\nrules: []\n");
  source.db.prepare("INSERT INTO tavern_events(at,keeper_thread_id,board_quest_id,actor,type,text,data) VALUES(1,NULL,NULL,?,?,?,?)").run('{"kind":"user"}', "backup.fixture", "Private notes stay private", '{}');
  const exported = await source.backup.export({ withData: true }); expect(exported.code).toBe("ok");
  const target = fixture(), from = { bundle: exported.json! };
  const preview = await target.backup.restore({ from, apply: false });
  expect(preview.code).toBe("preview"); expect(preview.records.action).toBe("restore");
  expect(target.backup.records.empty()).toBe(true); expect(existsSync(join(target.home, "classes/custom-name.md"))).toBe(false);
  const applied = await target.backup.restore({ from, apply: true, previewHash: preview.previewHash });
  expect(applied.code).toBe("applied"); expect(target.settings.read().tavern.voice).toBe("off");
  expect(readFileSync(join(target.home, "classes/custom-name.md"), "utf8")).toBe(custom.raw);
  expect(readFileSync(join(target.home, "scopes.yml"), "utf8")).toBe("v: 1\nrules: []\n");
  expect(target.db.prepare("SELECT text FROM tavern_events").get()).toMatchObject({ text: "Private notes stay private" });
  expect(target.changed).toHaveBeenCalledOnce();
});
it("normalises journal change texts from a pre-migration backup on restore", async () => {
  const source = fixture();
  source.db.exec("INSERT INTO questlog_logs (thread_id) VALUES ('thr_thread')");
  const insert = source.db.prepare("INSERT INTO questlog_changes (thread_id, at, actor, action, entry_ids, text, seen) VALUES ('thr_thread', 1, ?, ?, '[\"ab\"]', ?, 0)");
  insert.run('{"kind":"agent","threadId":"thr_warden"}', "verify", 'Agent thr_warden verified [ab] "Ship it".');
  insert.run('{"kind":"user"}', "link", 'Tavern assigned [ab] "Ship it" to waypoint w1.');
  insert.run('{"kind":"tavern"}', "board-phase", "Board quest phases refreshed: [ab].");
  insert.run('{"kind":"import","from":"pi-quests"}', "note", "You noted this in a legacy journal.");
  const exported = await source.backup.export({ withData: true });
  const old = JSON.parse(exported.json!);
  old.manifest.migrations.pop();
  old.manifest.schemaVersion--;
  const target = fixture(), from = { bundle: JSON.stringify(old) };
  const preview = await target.backup.restore({ from, apply: false });
  expect(preview.records.action).toBe("restore");
  expect(target.db.prepare("SELECT text FROM questlog_changes").all()).toEqual([]);
  expect((await target.backup.restore({ from, apply: true, previewHash: preview.previewHash })).code).toBe("applied");
  expect(target.db.prepare("SELECT text FROM questlog_changes ORDER BY id").pluck().all()).toEqual([
    'verified [ab] "Ship it".', 'assigned [ab] "Ship it" to waypoint w1.', "refreshed board quest phases: [ab].", "You noted this in a legacy journal.",
  ]);
});
it("refuses data in a non-empty database while still restoring configuration", async () => {
  const source = fixture(); override(source);
  const exported = await source.backup.export({ withData: true }), target = fixture();
  target.db.prepare("INSERT INTO questlog_logs(thread_id,next_id,hydrated) VALUES('existing',42,1)").run();
  const from = { bundle: exported.json! }, preview = await target.backup.restore({ from, apply: false });
  expect(preview.records.action).toBe("refused"); expect(preview.records.reason).toContain("empty");
  expect((await target.backup.restore({ from, apply: true, previewHash: preview.previewHash })).code).toBe("applied");
  expect(target.db.prepare("SELECT next_id FROM questlog_logs").get()).toMatchObject({ next_id: 42 });
  expect(existsSync(join(target.home, "classes/custom-name.md"))).toBe(true);
});
it("requires the preview token and refuses settings or file changes after preview", async () => {
  const source = fixture(); override(source);
  const exported = await source.backup.export({}), target = fixture(), from = { bundle: exported.json! };
  expect((await target.backup.restore({ from, apply: true })).code).toBe("invalid");
  const preview = await target.backup.restore({ from, apply: false });
  target.settings.update({ revision: 0, patch: { data: { backupKeep: 3 } }, why: "Changed after preview" });
  expect((await target.backup.restore({ from, apply: true, previewHash: preview.previewHash })).code).toBe("stale");
  const next = await target.backup.restore({ from, apply: false });
  override(target);
  expect((await target.backup.restore({ from, apply: true, previewHash: next.previewHash })).code).toBe("stale");
});
it("restores project files only through current native roots, never the manifest's path", async () => {
  const source = fixture(), custom = override(source, true), exported = await source.backup.export({ projects: true });
  const target = fixture(), from = { bundle: exported.json! }, preview = await target.backup.restore({ from, apply: false });
  expect(preview.files.some(file => file.path.startsWith(realpathSync(target.project)))).toBe(true);
  expect((await target.backup.restore({ from, apply: true, previewHash: preview.previewHash })).code).toBe("applied");
  expect(readFileSync(join(target.project, ".agents/tavern/classes/custom-name.md"), "utf8")).toBe(custom.raw);
});
it("never deletes unrelated files or restores shipped effective copies as overrides", async () => {
  const source = fixture(), exported = await source.backup.export({}), target = fixture();
  mkdirSync(join(target.home, "classes")); writeFileSync(join(target.home, "classes/unrelated.md"), "Keep me");
  const from = { bundle: exported.json! }, preview = await target.backup.restore({ from, apply: false });
  expect(preview.files).toEqual([]);
  expect((await target.backup.restore({ from, apply: true, previewHash: preview.previewHash })).code).toBe("applied");
  expect(readdirSync(join(target.home, "classes"))).toEqual(["unrelated.md"]);
});
it("prunes only managed backups, honours zero retention, and does not follow saved symlinks", async () => {
  const f = fixture(); f.settings.update({ revision: 0, patch: { data: { backupKeep: 1 } }, why: "Keep one" });
  const first = await f.backup.save({}), second = await f.backup.save({});
  expect(second.pruned).toEqual([first.backup!.name]); expect(f.backup.list().backups).toHaveLength(1);
  mkdirSync(join(f.backup.dir, "my-unmanaged-folder"));
  f.settings.update({ revision: f.settings.snapshot().revision, patch: { data: { backupKeep: 0 } }, why: "Keep all" });
  const third = await f.backup.save({}); expect(third.pruned).toEqual([]);
  expect(existsSync(join(f.backup.dir, "my-unmanaged-folder"))).toBe(true);
  symlinkSync(f.root, join(f.backup.dir, "2026-01-01-0000"), "dir");
  expect(() => f.backup.show("2026-01-01-0000")).toThrow("symbolic");
});
it("reports typed export size refusal and exports selected registry files verbatim to a folder", async () => {
  const f = fixture(), custom = override(f);
  const tooLarge = await f.backup.export({ withData: true }, 10);
  expect(tooLarge).toMatchObject({ code: "too-large", json: null, filename: null, limit: 10 });
  expect(f.backup.list()).toMatchObject({ exportLimitBytes: 8 * 1024 * 1024 });
  const folder = f.backup.registryExportFolder("class", ["smith"]);
  expect(folder.files).toEqual(["smith.md"]);
  expect(readFileSync(join(folder.path, "smith.md"), "utf8")).toBe(custom.raw);
});
it("rolls files and records back if settings validation rejects the final configuration", async () => {
  const source = fixture(); override(source);
  source.settings.update({ revision: 0, patch: { tavern: { voice: "off" } }, why: "Source setting" });
  const exported = await source.backup.export({ withData: true }), target = fixture(), from = { bundle: exported.json! };
  const preview = await target.backup.restore({ from, apply: false });
  target.settings.setValidator(() => { throw new Error("Injected settings rejection"); });
  const applied = await target.backup.restore({ from, apply: true, previewHash: preview.previewHash });
  expect(applied.code).toBe("invalid"); expect(applied.problems.join(" ")).toContain("Injected settings rejection");
  expect(target.backup.records.empty()).toBe(true); expect(target.settings.read().tavern.voice).toBe("full");
  expect(existsSync(join(target.home, "classes/custom-name.md"))).toBe(false); expect(target.changed).not.toHaveBeenCalled();
});
it("does not roll back committed files when a post-commit settings notification fails", async () => {
  const source = fixture(), custom = override(source);
  source.settings.update({ revision: 0, patch: { tavern: { voice: "off" } }, why: "Source setting" });
  const exported = await source.backup.export({ withData: true }), target = fixture(), from = { bundle: exported.json! };
  const preview = await target.backup.restore({ from, apply: false });
  target.changed.mockImplementation(() => { throw new Error("Injected refresh failure"); });
  const applied = await target.backup.restore({ from, apply: true, previewHash: preview.previewHash });
  expect(applied.code).toBe("applied"); expect(target.settings.read().tavern.voice).toBe("off");
  expect(readFileSync(join(target.home, "classes/custom-name.md"), "utf8")).toBe(custom.raw);
  expect(target.warning).toHaveBeenCalledWith(expect.stringContaining("committed"));
});
it("refuses apply if records appear after the empty-database preview", async () => {
  const source = fixture(); override(source);
  const exported = await source.backup.export({ withData: true }), target = fixture(), from = { bundle: exported.json! };
  const preview = await target.backup.restore({ from, apply: false });
  target.db.prepare("INSERT INTO questlog_logs(thread_id,next_id,hydrated) VALUES('new-data',7,1)").run();
  expect((await target.backup.restore({ from, apply: true, previewHash: preview.previewHash })).code).toBe("stale");
  expect(existsSync(join(target.home, "classes/custom-name.md"))).toBe(false);
  expect(target.db.prepare("SELECT next_id FROM questlog_logs").get()).toMatchObject({ next_id: 7 });
});
it("preserves a dotfiles symbolic link and previews its actual write target", async () => {
  const source = fixture(), custom = override(source), exported = await source.backup.export({}), target = fixture();
  const actual = join(target.root, "dotfiles", "class.md"); mkdirSync(join(actual, ".."), { recursive: true });
  writeFileSync(actual, readFileSync(join(builtin, "classes/smith.md"), "utf8")); mkdirSync(join(target.home, "classes"));
  const link = join(target.home, "classes/custom-name.md"); symlinkSync(actual, link);
  const from = { bundle: exported.json! }, preview = await target.backup.restore({ from, apply: false });
  expect(preview.files).toContainEqual({ path: realpathSync(actual), kind: "class", action: "change" });
  expect((await target.backup.restore({ from, apply: true, previewHash: preview.previewHash })).code).toBe("applied");
  expect(readFileSync(actual, "utf8")).toBe(custom.raw); expect(realpathSync(link)).toBe(realpathSync(actual));
});
it("binds the preview token to the bundle, not only the destination state", async () => {
  const source = fixture(); override(source);
  const exported = await source.backup.export({}), target = fixture(), from = { bundle: exported.json! };
  const preview = await target.backup.restore({ from, apply: false });
  const changed = JSON.parse(exported.json!); changed.manifest.createdAt++;
  expect((await target.backup.restore({ from: { bundle: JSON.stringify(changed) }, apply: true, previewHash: preview.previewHash })).code).toBe("stale");
  expect(existsSync(join(target.home, "classes/custom-name.md"))).toBe(false);
});
